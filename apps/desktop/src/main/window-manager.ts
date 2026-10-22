import { app, type WebContents } from "electron";
import type { ProfileId, TabId } from "@corvus/shared";
import { NEW_TAB_URL } from "../shared/internal-urls";
import type { SessionWindow } from "../shared/session-state";
import type { AppContext } from "./context";
import type { PermissionHost } from "./permissions";
import { BrowserWindowCtl, type TabRuntime } from "./window";

export class WindowManager implements PermissionHost {
  private windows: BrowserWindowCtl[] = [];
  private lastFocused: BrowserWindowCtl | null = null;

  constructor(private readonly ctx: AppContext) {}

  open(profileId: ProfileId, urls?: string[]): BrowserWindowCtl {
    const runtime = this.ctx.profiles.get(profileId);
    this.ctx.profiles.manager.markUsed(profileId);
    const win = new BrowserWindowCtl(this.ctx, runtime, urls && urls.length > 0 ? urls : [NEW_TAB_URL]);
    this.windows.push(win);
    this.lastFocused = win;
    this.ctx.sessionRestore.resume();
    return win;
  }

  /** Reopen a window from the saved session. */
  restore(saved: SessionWindow): BrowserWindowCtl {
    const runtime = this.ctx.profiles.get(saved.profileId);
    const win = new BrowserWindowCtl(this.ctx, runtime, [], {
      ...(saved.bounds ? { bounds: saved.bounds } : {}),
      maximized: saved.maximized,
    });
    this.windows.push(win);
    this.lastFocused = win;
    win.restoreTabs(saved);
    this.ctx.sessionRestore.resume();
    return win;
  }

  all(): BrowserWindowCtl[] {
    return [...this.windows];
  }

  forProfile(profileId: ProfileId): BrowserWindowCtl[] {
    return this.windows.filter((w) => w.profile.profile.id === profileId);
  }

  byChromeWebContents(wc: WebContents): BrowserWindowCtl | undefined {
    return this.windows.find((w) => w.chrome.webContents === wc);
  }

  byTabWebContents(wc: WebContents): { window: BrowserWindowCtl; tab: TabRuntime } | undefined {
    for (const window of this.windows) {
      const tab = window.tabByWebContents(wc);
      if (tab) return { window, tab };
    }
    return undefined;
  }

  findTab(id: TabId): { window: BrowserWindowCtl; tab: TabRuntime } | undefined {
    for (const window of this.windows) {
      const tab = window.getTab(id);
      if (tab) return { window, tab };
    }
    return undefined;
  }

  noteFocus(win: BrowserWindowCtl): void {
    this.lastFocused = win;
  }

  focused(): BrowserWindowCtl | undefined {
    return this.lastFocused ?? this.windows[0];
  }

  /** Window that agent and extension actions target, opening one if needed. */
  target(): BrowserWindowCtl {
    return this.focused() ?? this.open(this.ctx.profiles.manager.lastUsed);
  }

  removed(win: BrowserWindowCtl): void {
    this.windows = this.windows.filter((w) => w !== win);
    if (this.lastFocused === win) this.lastFocused = this.windows[this.windows.length - 1] ?? null;
    if (this.windows.length === 0 && process.platform !== "darwin") app.quit();
  }

  broadcastState(): void {
    for (const w of this.windows) w.pushState();
  }

  relayoutAll(): void {
    for (const w of this.windows) w.relayout();
  }

  closeProfileWindows(profileId: ProfileId): void {
    for (const w of this.forProfile(profileId)) w.close();
  }

  /** A site's zoom changed in one tab: apply it to the profile's other tabs on that site. */
  applyZoom(profileId: ProfileId, key: string, factor: number): void {
    for (const w of this.forProfile(profileId)) w.applyZoom(key, factor);
  }

  // PermissionHost ------------------------------------------------------------

  tabFor(wc: WebContents): { agent: boolean } | undefined {
    const found = this.byTabWebContents(wc);
    return found ? { agent: found.tab.agentControlled } : undefined;
  }

  promptsChanged(wc: WebContents): void {
    this.byTabWebContents(wc)?.window.pushState();
  }
}
