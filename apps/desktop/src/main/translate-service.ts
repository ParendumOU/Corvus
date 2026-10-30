import { app } from "electron";
import type { TabId } from "@corvus/shared";
import { resolveUiLanguage } from "../shared/settings";
import { shouldOfferTranslation, translationTarget, type TranslateBarState, type TranslateState } from "../shared/translate";
import type { AppContext } from "./context";
import { pageOf } from "./tab-page";
import type { BrowserWindowCtl, TabRuntime } from "./window";

/** Isolated world for reading a page's declared language (separate from the page's own scripts). */
const LANG_WORLD_ID = 1997;
const LANG_SCRIPT = `(() => {
  const meta = document.querySelector('meta[http-equiv="content-language" i]');
  return document.documentElement.lang || (meta && meta.content) || "";
})()`;

interface TabTranslation {
  state: TranslateState;
  pageLang: string;
  target: string;
  translated: number;
  error?: string;
  abort: AbortController | null;
}

/**
 * Page translation from the address bar: offers it when a page declares a language other than the
 * target one, translates the whole page in place through Corvus Assist's translator (batch by
 * batch, progress in the button), and shows the original again on demand. One state per tab,
 * dropped when the tab navigates to a new document.
 */
export class TranslateService {
  private readonly tabs = new Map<TabId, TabTranslation>();

  constructor(private readonly ctx: AppContext) {}

  /** The language pages are translated into right now. */
  target(): string {
    const s = this.ctx.settings.get();
    return translationTarget(s.translate.targetLanguage, resolveUiLanguage(s.appearance.language, app.getLocale()), app.getLocale());
  }

  barState(tab: TabRuntime | undefined): TranslateBarState | null {
    const entry = tab ? this.tabs.get(tab.id) : undefined;
    if (!entry) return null;
    return {
      state: entry.state,
      pageLang: entry.pageLang,
      target: entry.target,
      translated: entry.translated,
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  /** A new document in the tab: whatever was translated is gone with the old one. */
  onNavigated(tab: TabRuntime): void {
    const entry = this.tabs.get(tab.id);
    entry?.abort?.abort();
    this.tabs.delete(tab.id);
  }

  forget(tabId: TabId): void {
    this.tabs.get(tabId)?.abort?.abort();
    this.tabs.delete(tabId);
  }

  /** After a page loads: offer translation when it declares another language. */
  async onPageLoad(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
    const wc = pageOf(tab.view);
    if (!wc || !/^https?:/i.test(wc.getURL()) || this.tabs.get(tab.id)?.state === "translating") return;
    const pageLang = (await wc.executeJavaScriptInIsolatedWorld(LANG_WORLD_ID, [{ code: LANG_SCRIPT }]).catch(() => "")) as unknown;
    const lang = typeof pageLang === "string" ? pageLang.slice(0, 35) : "";
    const target = this.target();
    // Closed meanwhile: no offer is kept for it.
    if (!win.hasTab(tab.id) || this.tabs.get(tab.id)?.state === "translated") return;
    if (this.ctx.settings.get().translate.offer && shouldOfferTranslation(lang, target)) {
      this.tabs.set(tab.id, { state: "offer", pageLang: lang, target, translated: 0, abort: null });
    } else {
      this.tabs.delete(tab.id);
    }
    win.pushState();
  }

  /** Translates the tab's page into the target language (any page, also one that was not offered). */
  async translate(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
    // A page menu left open while its tab closed.
    if (!win.hasTab(tab.id)) return;
    const previous = this.tabs.get(tab.id);
    previous?.abort?.abort();
    const abort = new AbortController();
    const entry: TabTranslation = { state: "translating", pageLang: previous?.pageLang ?? "", target: this.target(), translated: 0, abort };
    this.tabs.set(tab.id, entry);
    win.pushState();
    try {
      await this.ctx.assist.translateWholePage(
        win,
        tab,
        entry.target,
        (translated) => {
          entry.translated = translated;
          win.pushState();
        },
        abort.signal,
      );
      if (abort.signal.aborted) return;
      entry.state = entry.translated > 0 ? "translated" : "error";
      if (entry.translated === 0) entry.error = "There was no text to translate on this page.";
    } catch (err) {
      if (abort.signal.aborted) return;
      entry.state = "error";
      entry.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (entry.abort === abort) entry.abort = null;
      win.pushState();
    }
  }

  /** Stops a translation in progress and puts the page's original text back. */
  async showOriginal(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
    const entry = this.tabs.get(tab.id);
    entry?.abort?.abort();
    await this.ctx.assist.restoreTranslation(tab);
    if (!win.hasTab(tab.id)) return;
    if (entry && shouldOfferTranslation(entry.pageLang, entry.target)) {
      this.tabs.set(tab.id, { state: "offer", pageLang: entry.pageLang, target: entry.target, translated: 0, abort: null });
    } else {
      this.tabs.delete(tab.id);
    }
    win.pushState();
  }

  /** The address bar button: translate, stop, or show the original, by state. */
  toggle(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    if (!tab) return;
    const state = this.tabs.get(tab.id)?.state;
    if (state === "translating" || state === "translated") void this.showOriginal(win, tab);
    else void this.translate(win, tab);
  }
}
