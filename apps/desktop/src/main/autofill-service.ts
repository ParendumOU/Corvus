import type { TabId } from "@corvus/shared";
import type { CredentialMatch } from "../shared/credentials";
import { originKeyOf } from "../shared/credentials";
import { type AutofillBarState, type CapturedSubmit, EMPTY_AUTOFILL } from "../shared/credentials-ipc";
import { AUTOFILL_WORLD_ID, detectLoginScript, fillLoginScript, type LoginDetection } from "./credential-scripts";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

const SCRIPT_TIMEOUT_MS = 4000;

interface PendingSave {
  origin: string;
  username: string;
  password: string;
  updates: boolean;
}

function isWebPage(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
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

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/**
 * Autofill: detects login forms on web pages (isolated-world script), offers to fill a saved login
 * through the omnibox key button, and captures submitted credentials to offer saving. All page access
 * is from the main process; nothing is written to a page except on an explicit fill. Per-profile
 * secrets live in the CredentialVault (see credential-store.ts).
 */
export class AutofillService {
  private readonly detected = new Map<TabId, boolean>();
  private readonly pending = new Map<TabId, PendingSave>();

  constructor(private readonly ctx: AppContext) {}

  private async run<T>(tab: TabRuntime, code: string): Promise<T | null> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || !isWebPage(wc.getURL())) return null;
    try {
      return (await withTimeout(wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [{ code }]) as Promise<T>, SCRIPT_TIMEOUT_MS)) ?? null;
    } catch {
      return null;
    }
  }

  /** A page finished loading: probe it for a login form so the omnibox can offer autofill. */
  async onPageLoad(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
    const result = await this.run<LoginDetection>(tab, detectLoginScript());
    const has = result?.hasPassword === true;
    const before = this.detected.get(tab.id) ?? false;
    this.detected.set(tab.id, has);
    if (has !== before && win.activeTab()?.id === tab.id) win.pushState();
  }

  /**
   * The tab preload reported a submitted login (captured synchronously in-page before navigation).
   * Offer to save it unless it already matches a stored login. Validated against the sending tab.
   */
  onSubmitCaptured(win: BrowserWindowCtl, tab: TabRuntime, data: CapturedSubmit): void {
    const origin = originKeyOf(data.origin);
    if (!origin || !data.password) return;
    const existing = win.profile.credentials.findByLogin(origin, data.username);
    if (existing && existing.password === data.password) return; // already saved, unchanged
    this.pending.set(tab.id, { origin, username: data.username, password: data.password, updates: Boolean(existing) });
    if (win.activeTab()?.id === tab.id) win.pushState();
  }

  /** A tab committed a navigation: its login probe is stale (a pending save survives to the new page). */
  onNavigated(win: BrowserWindowCtl, tab: TabRuntime): void {
    if (this.detected.delete(tab.id) && win.activeTab()?.id === tab.id) win.pushState();
  }

  forgetTab(id: TabId): void {
    this.detected.delete(id);
    this.pending.delete(id);
  }

  stateFor(win: BrowserWindowCtl): AutofillBarState {
    const tab = win.activeTab();
    if (!tab) return EMPTY_AUTOFILL;
    const url = tab.view.webContents.isDestroyed() ? tab.url : tab.view.webContents.getURL();
    const matchCount = this.detected.get(tab.id) ? win.profile.credentials.matchesFor(url).length : 0;
    const save = this.pending.get(tab.id);
    return {
      available: matchCount > 0,
      matchCount,
      canSave: Boolean(save),
      saveHost: save ? hostOf(save.origin) : "",
      saveUpdates: save?.updates ?? false,
    };
  }

  suggestions(win: BrowserWindowCtl): CredentialMatch[] {
    const tab = win.activeTab();
    if (!tab) return [];
    const url = tab.view.webContents.isDestroyed() ? tab.url : tab.view.webContents.getURL();
    return win.profile.credentials.matchesFor(url);
  }

  async fill(win: BrowserWindowCtl, id: string): Promise<void> {
    const tab = win.activeTab();
    if (!tab) return;
    const cred = win.profile.credentials.get(id);
    if (!cred) return;
    await this.run<boolean>(tab, fillLoginScript(cred.username, cred.password));
  }

  acceptSave(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    const save = tab ? this.pending.get(tab.id) : undefined;
    if (!tab || !save) return;
    win.profile.credentials.saveOnSubmit(save.origin, save.username, save.password);
    this.pending.delete(tab.id);
    win.pushState();
  }

  dismissSave(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    if (tab && this.pending.delete(tab.id)) win.pushState();
  }
}
