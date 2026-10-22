import crypto from "node:crypto";
import { nativeTheme, type Rectangle, type WebContents } from "electron";
import {
  type AssistPage,
  type AssistTask,
  articleToMarkdown,
  extractArticle,
  parseSummary,
  type ReaderArticle,
  runAssist,
} from "@corvus/ai-engine";
import type { TabId } from "@corvus/shared";
import { commandForInput } from "../shared/shortcuts";
import {
  READER_FONT_MAX,
  READER_FONT_MIN,
  READER_WIDTH_MAX,
  READER_WIDTH_MIN,
  type ReaderDoc,
  type ReaderSettings,
  type ReaderState,
  type ReaderToolKind,
  type ReaderToolMessage,
} from "../shared/reader-ipc";
import type { ReadingItem } from "../shared/reading";
import { splitSentences } from "../shared/reading";
import type { ReaderTheme, ReaderFontFamily } from "../shared/settings";
import { GRAB_MAX_CHARS, grabPageHtmlScript, readerProbeScript, READER_WORLD_ID, type GrabbedPage, type ReaderProbe } from "./reader-scripts";
import { ReaderView } from "./reader-views";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

const MAX_MESSAGES = 30;
const SCRIPT_TIMEOUT_MS = 8000;

interface TabReader {
  article: ReaderArticle | null;
  messages: ReaderToolMessage[];
  abort: AbortController | null;
  loading: boolean;
  error: string | null;
  saved: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The page did not respond in time")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 300 ? `${message.slice(0, 297)}…` : message;
}

function isWebPage(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function toDoc(article: ReaderArticle): ReaderDoc {
  return {
    url: article.url,
    title: article.title,
    byline: article.byline,
    siteName: article.siteName,
    lang: article.lang,
    dir: article.dir,
    content: article.content,
    excerpt: article.excerpt,
    wordCount: article.wordCount,
    readingMinutes: article.readingMinutes,
    sectionHeadings: article.sections.map((s) => s.heading),
  };
}

const TOOL_LABELS: Record<ReaderToolKind, string> = {
  "key-points": "Key points",
  tldr: "TL;DR",
  simplify: "Simplify",
  eli5: "Explain like I'm 5",
  translate: "Translate",
  define: "Define",
  explain: "Explain",
};

/**
 * Reader mode: Firefox-style readerable detection, a clean reading view per window over the active
 * tab, the AI reading tools (one capped provider call each) and "save to the reading library".
 * The reader view is a trusted WebContentsView; article content it renders is sanitized in the main
 * process before it ever reaches the renderer.
 */
export class ReaderService {
  private readonly views = new WeakMap<BrowserWindowCtl, ReaderView>();
  private readonly tabs = new Map<TabId, TabReader>();
  private readonly readerable = new Map<TabId, boolean>();
  private readonly onForTab = new Set<TabId>();
  private readonly timers = new WeakMap<BrowserWindowCtl, NodeJS.Timeout>();

  constructor(private readonly ctx: AppContext) {
    ctx.settings.onChange((next, prev) => {
      if (next === prev || JSON.stringify(next.reader) !== JSON.stringify(prev.reader) || JSON.stringify(next.ai) !== JSON.stringify(prev.ai)) {
        for (const w of this.ctx.windows.all()) this.refresh(w);
      }
    });
  }

  // ------------------------------------------------------------- readerable probe

  /** Runs the readerable probe on a freshly loaded web page; updates the omnibox button. */
  async probe(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || !isWebPage(wc.getURL())) {
      if (this.readerable.get(tab.id)) {
        this.readerable.set(tab.id, false);
        win.pushState();
      }
      return;
    }
    try {
      const probe = (await withTimeout(
        wc.executeJavaScriptInIsolatedWorld(READER_WORLD_ID, [{ code: readerProbeScript() }]) as Promise<ReaderProbe>,
        SCRIPT_TIMEOUT_MS,
      )) ?? { readerable: false, title: "", lang: "" };
      const before = this.readerable.get(tab.id);
      this.readerable.set(tab.id, probe.readerable === true);
      if (before !== probe.readerable) win.pushState();
    } catch {
      this.readerable.set(tab.id, false);
    }
  }

  isReaderable(tab: TabRuntime): boolean {
    return isWebPage(tab.url) && this.readerable.get(tab.id) === true;
  }

  isActive(win: BrowserWindowCtl): boolean {
    const tab = win.activeTab();
    return tab ? this.onForTab.has(tab.id) : false;
  }

  /** A tab navigated: its probe is stale and any open reader must close (its article is gone). */
  onNavigated(win: BrowserWindowCtl, tab: TabRuntime): void {
    this.readerable.delete(tab.id);
    const entry = this.tabs.get(tab.id);
    if (entry) {
      entry.abort?.abort();
      this.tabs.delete(tab.id);
    }
    if (this.onForTab.delete(tab.id)) {
      win.relayout();
      this.refresh(win);
    }
  }

  forgetTab(id: TabId): void {
    this.tabs.get(id)?.abort?.abort();
    this.tabs.delete(id);
    this.readerable.delete(id);
    this.onForTab.delete(id);
  }

  // ------------------------------------------------------------- view + layout

  private view(win: BrowserWindowCtl): ReaderView {
    let view = this.views.get(win);
    if (!view) {
      view = new ReaderView(win.win, win.chrome, (_wc, event, input) => {
        if (input.type === "keyDown" && input.key === "Escape") {
          event.preventDefault();
          this.close(win);
          return;
        }
        const command = commandForInput(input, process.platform);
        if (!command) return;
        event.preventDefault();
        win.runCommand(command);
      });
      this.views.set(win, view);
    }
    return view;
  }

  layout(win: BrowserWindowCtl, content: Rectangle): void {
    const active = this.isActive(win);
    const existing = this.views.get(win);
    if (!active && !existing) return;
    const view = active ? this.view(win) : existing;
    view?.setOpen(active);
    view?.layout(active ? content : { x: 0, y: 0, width: 0, height: 0 });
  }

  disposeWindow(win: BrowserWindowCtl): void {
    this.views.get(win)?.dispose();
    this.views.delete(win);
    const timer = this.timers.get(win);
    if (timer) clearTimeout(timer);
  }

  // ------------------------------------------------------------- toggle + extraction

  toggle(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    if (!tab) return;
    if (this.onForTab.has(tab.id)) this.close(win);
    else void this.openFor(win, tab);
  }

  close(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    if (!tab || !this.onForTab.delete(tab.id)) return;
    this.tabs.get(tab.id)?.abort?.abort();
    win.relayout();
    win.focusContent();
    win.pushState();
    this.refresh(win);
  }

  private entry(tabId: TabId): TabReader {
    let entry = this.tabs.get(tabId);
    if (!entry) {
      entry = { article: null, messages: [], abort: null, loading: false, error: null, saved: false };
      this.tabs.set(tabId, entry);
    }
    return entry;
  }

  private async openFor(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || !isWebPage(wc.getURL())) return;
    const entry = this.entry(tab.id);
    this.onForTab.add(tab.id);
    const view = this.view(win);
    view.setOpen(true);
    win.relayout();
    view.focus();
    win.pushState();

    if (entry.article && entry.article.url === wc.getURL()) {
      entry.loading = false;
      this.refresh(win);
      return;
    }

    entry.loading = true;
    entry.error = null;
    entry.messages = [];
    this.refresh(win);
    try {
      const grabbed = (await withTimeout(
        wc.executeJavaScriptInIsolatedWorld(READER_WORLD_ID, [{ code: grabPageHtmlScript() }]) as Promise<GrabbedPage>,
        SCRIPT_TIMEOUT_MS,
      )) ?? { html: "", url: wc.getURL(), base: wc.getURL() };
      if (!this.onForTab.has(tab.id)) return; // closed while extracting
      const article = grabbed.html.length < GRAB_MAX_CHARS + 1 ? extractArticle(grabbed.html, grabbed.url, grabbed.base) : null;
      if (!article) {
        entry.error = "This page doesn't have an article Corvus can show in reader mode.";
      } else {
        entry.article = article;
        entry.saved = win.profile.reading.hasUrl(article.url);
      }
    } catch (err) {
      entry.error = errorText(err);
    } finally {
      entry.loading = false;
      this.refresh(win);
    }
  }

  // ------------------------------------------------------------- AI reading tools

  private findContext(article: ReaderArticle, term: string): string | undefined {
    const needle = term.trim().toLowerCase();
    if (!needle) return undefined;
    for (const sentence of splitSentences(article.textContent)) {
      if (sentence.toLowerCase().includes(needle)) return sentence.slice(0, 400);
    }
    return undefined;
  }

  tool(win: BrowserWindowCtl, kind: ReaderToolKind, input: string): void {
    const tab = win.activeTab();
    if (!tab) return;
    void this.runTool(win, tab, kind, input);
  }

  cancel(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    if (tab) this.tabs.get(tab.id)?.abort?.abort();
  }

  clear(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    if (!tab) return;
    const entry = this.tabs.get(tab.id);
    if (!entry) return;
    entry.abort?.abort();
    entry.messages = [];
    this.refresh(win);
  }

  private async runTool(win: BrowserWindowCtl, tab: TabRuntime, kind: ReaderToolKind, input: string): Promise<void> {
    const entry = this.tabs.get(tab.id);
    if (!entry?.article) return;
    const article = entry.article;
    entry.abort?.abort();
    const abort = new AbortController();
    entry.abort = abort;

    const selection = input.trim().slice(0, 600);
    const message: ReaderToolMessage = {
      id: crypto.randomUUID(),
      kind,
      label: TOOL_LABELS[kind],
      prompt: kind === "define" || kind === "explain" ? selection : "",
      text: "",
      status: "streaming",
      at: Date.now(),
    };
    entry.messages = [...entry.messages, message].slice(-MAX_MESSAGES);
    const update = (patch: Partial<ReaderToolMessage>): void => {
      Object.assign(message, patch);
      entry.messages = entry.messages.map((m) => (m.id === message.id ? { ...message } : m));
      this.refresh(win);
    };
    this.refresh(win);

    const info = this.ctx.assist.readerProviderInfo();
    try {
      const provider = info.provider;
      if (!provider) throw new Error("The reading tools need an AI provider. Open Settings to add one.");
      const lang = info.lang;
      const started = Date.now();
      const page: AssistPage = { url: article.url, title: article.title, sections: article.sections };
      const reader = this.ctx.settings.get().reader;
      let task: AssistTask;
      if (kind === "define") {
        if (!selection) throw new Error("Select a word or phrase to define.");
        const context = this.findContext(article, selection);
        task = { kind: "define", term: selection, lang, ...(context ? { context } : {}) };
      } else if (kind === "explain") {
        if (!selection) throw new Error("Select some text to explain.");
        task = { kind: "explain", selection, lang, page: { title: article.title, url: article.url } };
      } else if (kind === "translate") {
        task = { kind: "translate-article", page, lang: reader.translateLanguage || lang };
      } else {
        task = { kind, page, lang };
      }

      let text = "";
      for await (const ev of runAssist(provider, task, abort.signal)) {
        if (abort.signal.aborted) break;
        if (ev.type === "delta") {
          text += ev.text;
          update(kind === "key-points" ? { text, points: parseSummary(text, article.sections.length).points } : { text });
        } else {
          message.usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, model: ev.model, cached: false, ms: Date.now() - started };
        }
      }
      if (abort.signal.aborted) {
        update({ status: "cancelled" });
        return;
      }
      const final = text.trim();
      update({ text: final, status: "done", ...(kind === "key-points" ? { points: parseSummary(final, article.sections.length).points } : {}) });
    } catch (err) {
      update({ status: abort.signal.aborted ? "cancelled" : "error", error: errorText(err) });
    } finally {
      if (entry.abort === abort) entry.abort = null;
      this.refresh(win);
    }
  }

  // ------------------------------------------------------------- settings + save

  setSettings(win: BrowserWindowCtl, patch: Partial<ReaderSettings>): void {
    const next: Partial<ReaderSettings> = {};
    if (typeof patch.fontSize === "number") next.fontSize = Math.max(READER_FONT_MIN, Math.min(READER_FONT_MAX, Math.round(patch.fontSize)));
    if (typeof patch.lineWidth === "number") next.lineWidth = Math.max(READER_WIDTH_MIN, Math.min(READER_WIDTH_MAX, Math.round(patch.lineWidth)));
    if (patch.theme === "light" || patch.theme === "sepia" || patch.theme === "dark") next.theme = patch.theme as ReaderTheme;
    if (patch.font === "serif" || patch.font === "sans") next.font = patch.font as ReaderFontFamily;
    if (Object.keys(next).length > 0) this.ctx.settings.update({ reader: next });
  }

  save(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    const entry = tab ? this.tabs.get(tab.id) : undefined;
    const article = entry?.article;
    if (!entry || !article) return;
    const keyPoints = [...entry.messages]
      .reverse()
      .find((m) => m.kind === "key-points" && m.status === "done" && m.points && m.points.length > 0)
      ?.points?.map((p) => p.text) ?? [];
    const item: ReadingItem = {
      id: crypto.randomUUID(),
      url: article.url,
      title: article.title,
      siteName: article.siteName,
      byline: article.byline,
      excerpt: article.excerpt,
      markdown: articleToMarkdown(article),
      keyPoints,
      wordCount: article.wordCount,
      readingMinutes: article.readingMinutes,
      savedAt: Date.now(),
    };
    win.profile.reading.save(item);
    entry.saved = true;
    this.refresh(win);
  }

  openReadingList(win: BrowserWindowCtl): void {
    win.openSingleton("corvus://reading/");
  }

  openLink(win: BrowserWindowCtl, url: string): void {
    if (/^https?:\/\//i.test(url)) win.openUrl(url, "new-tab");
  }

  // ------------------------------------------------------------- state push

  refresh(win: BrowserWindowCtl): void {
    const view = this.views.get(win);
    if (!view?.open || this.timers.has(win)) return;
    this.timers.set(
      win,
      setTimeout(() => {
        this.timers.delete(win);
        if (!win.isDisposed() && view.open) view.send(this.state(win));
      }, 30),
    );
  }

  state(win: BrowserWindowCtl): ReaderState {
    const tab = win.activeTab();
    const entry = tab ? this.tabs.get(tab.id) : undefined;
    const info = this.ctx.assist.readerProviderInfo();
    const s = this.ctx.settings.get().reader;
    const view = this.views.get(win);
    return {
      active: this.isActive(win),
      tabId: tab?.id ?? null,
      loading: entry?.loading ?? false,
      error: entry?.error ?? null,
      dark: nativeTheme.shouldUseDarkColors,
      providerReady: info.provider !== null,
      setupReason: info.setupReason,
      lang: info.lang,
      translateLanguage: s.translateLanguage || info.lang,
      settings: { fontSize: s.fontSize, lineWidth: s.lineWidth, theme: s.theme, font: s.font },
      doc: entry?.article ? toDoc(entry.article) : null,
      messages: entry?.messages ?? [],
      busy: entry?.abort != null,
      saved: entry?.saved ?? false,
      focusToken: view?.focusToken ?? 0,
    };
  }

  /** Reader view WebContents of a window (smoke screenshots). Null until the reader has been opened. */
  readerWebContents(win: BrowserWindowCtl): WebContents | null {
    return this.views.get(win)?.webContents ?? null;
  }

  windowForView(sender: WebContents): BrowserWindowCtl | undefined {
    return this.ctx.windows.all().find((w) => this.views.get(w)?.webContents === sender);
  }
}
