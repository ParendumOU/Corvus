import { app, screen, type WebContents } from "electron";
import type { GroupId, ProfileId, TabId } from "@corvus/shared";
import { NEW_TAB_URL } from "../shared/internal-urls";
import type { SessionWindow } from "../shared/session-state";
import { tearOffBounds, tearsOff, type Point } from "../shared/tab-tearoff";
import type { AppContext } from "./context";
import type { PermissionHost } from "./permissions";
import { ProfileLockedError } from "./profile-lock";
import { BrowserWindowCtl, type TabRuntime, type WindowOpenOptions } from "./window";

export class WindowManager implements PermissionHost {
  private windows: BrowserWindowCtl[] = [];
  private lastFocused: BrowserWindowCtl | null = null;
  /** The window that has the system's focus now (null while another app has it). */
  private front: BrowserWindowCtl | null = null;
  private readonly focusListeners = new Set<(win: BrowserWindowCtl) => void>();

  constructor(private readonly ctx: AppContext) {}

  open(profileId: ProfileId, urls?: string[], opts: Pick<WindowOpenOptions, "background"> = {}): BrowserWindowCtl {
    const runtime = this.ctx.profiles.get(profileId);
    this.ctx.profiles.manager.markUsed(profileId);
    const win = new BrowserWindowCtl(this.ctx, runtime, urls && urls.length > 0 ? urls : [NEW_TAB_URL], opts);
    this.windows.push(win);
    this.lastFocused = win;
    this.ctx.sessionRestore.resume();
    return win;
  }

  /** A private window of a profile (see WindowOpenOptions.private). */
  openPrivate(profileId: ProfileId, urls?: string[]): BrowserWindowCtl {
    const runtime = this.ctx.profiles.get(profileId);
    const win = new BrowserWindowCtl(this.ctx, runtime, urls && urls.length > 0 ? urls : [NEW_TAB_URL], { private: true });
    this.windows.push(win);
    this.lastFocused = win;
    return win;
  }

  /** Reopen a window from the saved session. */
  restore(saved: SessionWindow, opts: Pick<WindowOpenOptions, "background"> = {}): BrowserWindowCtl {
    const runtime = this.ctx.profiles.get(saved.profileId);
    const win = new BrowserWindowCtl(this.ctx, runtime, [], {
      ...(saved.bounds ? { bounds: saved.bounds } : {}),
      maximized: saved.maximized,
      ...opts,
    });
    this.windows.push(win);
    this.lastFocused = win;
    win.restoreTabs(saved);
    this.ctx.sessionRestore.resume();
    return win;
  }

  // ---------------------------------------------------------------- moving tabs between windows

  /**
   * Moves tabs, pages and all (nothing reloads), from one window to another of the same profile and
   * kind; `from` closes when it has none left. False when they may not move there.
   */
  moveTabs(from: BrowserWindowCtl, ids: readonly TabId[], to: BrowserWindowCtl, opts: { index?: number; groupId?: GroupId | null; activeId?: TabId } = {}): boolean {
    if (!from.canTradeTabsWith(to)) return false;
    const parcel = from.releaseTabs(ids);
    if (parcel.tabs.length === 0) return false;
    to.adoptTabs(parcel, opts);
    if (from.tabCount === 0) from.close();
    return true;
  }

  /**
   * Tabs to a new window of their own ("Move to new window", or dragged out of the strip and let go
   * at `pointer`, which then holds the new window by its first tab). All of a window's tabs: that
   * window itself goes there. Returns the window they are in.
   */
  tearOff(from: BrowserWindowCtl, ids: readonly TabId[], pointer?: Point): BrowserWindowCtl | null {
    const going = ids.filter((id) => from.hasTab(id));
    if (going.length === 0 || from.isDisposed() || from.profile.locked) return null;
    const bounds = from.win.getNormalBounds();
    const placed = pointer ? tearOffBounds(pointer, bounds) : { ...bounds, x: bounds.x + 32, y: bounds.y + 32 };
    if (going.length === from.tabCount) {
      if (pointer) {
        if (from.win.isMaximized()) from.win.unmaximize();
        from.win.setBounds(placed);
      }
      return from;
    }
    const win = new BrowserWindowCtl(this.ctx, from.profile, [], { bounds: placed, private: from.isPrivate });
    this.windows.push(win);
    this.lastFocused = win;
    if (!win.isPrivate) this.ctx.sessionRestore.resume();
    this.moveTabs(from, going, win);
    return win;
  }

  /** A tab of another window dropped on `to`'s strip: it moves there, with the tabs selected with it. */
  dropTab(to: BrowserWindowCtl, id: TabId, index: number, groupId: GroupId | null): boolean {
    const found = this.findTab(id);
    if (!found || found.window === to) return false;
    const moved = this.moveTabs(found.window, found.window.actionTabIds(id), to, { index, groupId, activeId: id });
    if (moved) to.present();
    return moved;
  }

  /** A group of another window dropped on `to`'s strip: it moves there whole, with its id. */
  dropGroup(to: BrowserWindowCtl, groupId: GroupId, index: number): boolean {
    const from = this.windows.find((w) => w !== to && w.hasGroup(groupId));
    if (!from) return false;
    const moved = this.moveTabs(from, from.groupTabIds(groupId), to, { index });
    if (moved) to.present();
    return moved;
  }

  /**
   * A drag of tabs (`ids`) out of `from`'s strip ended on no tab strip: let go away from the strip,
   * they go to a new window there; near it, the drag was given up.
   */
  dragEnded(from: BrowserWindowCtl, ids: readonly TabId[]): BrowserWindowCtl | null {
    const pointer = screen.getCursorScreenPoint();
    if (!tearsOff(pointer, from.stripOnScreen())) return null;
    return this.tearOff(from, ids, pointer);
  }

  all(): BrowserWindowCtl[] {
    return [...this.windows];
  }

  /** Windows that are not private: what sync and the saved session see. */
  regular(): BrowserWindowCtl[] {
    return this.windows.filter((w) => !w.isPrivate);
  }

  /** Windows agents and services may act in: not private, and not of a locked profile. */
  usable(): BrowserWindowCtl[] {
    return this.windows.filter((w) => !w.isPrivate && !w.profile.locked);
  }

  /** The window a service acts in when none is named: the focused one if usable, else the last usable one. */
  reachable(): BrowserWindowCtl | undefined {
    const focused = this.focused();
    if (focused && !focused.isPrivate && !focused.profile.locked) return focused;
    const usable = this.usable();
    return usable[usable.length - 1];
  }

  /** A tab's window and runtime, unless its profile is locked (its pages may ask nothing then). */
  byUnlockedTab(wc: WebContents): { window: BrowserWindowCtl; tab: TabRuntime } | undefined {
    const found = this.byTabWebContents(wc);
    return found && !found.window.profile.locked ? found : undefined;
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
    this.front = win;
    for (const listener of this.focusListeners) listener(win);
  }

  noteBlur(win: BrowserWindowCtl): void {
    if (this.front === win) this.front = null;
  }

  /** The Corvus window in front of the other apps, if one is. */
  inFront(): BrowserWindowCtl | null {
    return this.front;
  }

  /**
   * Called each time a window gets focus. Corvus's windows are BaseWindows, for which Electron
   * sends no app-level "browser-window-focus".
   */
  onFocus(listener: (win: BrowserWindowCtl) => void): () => void {
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  }

  focused(): BrowserWindowCtl | undefined {
    return this.lastFocused ?? this.windows[0];
  }

  /**
   * Window that agent and extension actions target (never a private one, nor one of a locked
   * profile: with no other, this throws ProfileLockedError), opening one if needed.
   * With no window open at all (Corvus kept running in the notification area), nobody is there to
   * see it: it opens in the background.
   */
  target(): BrowserWindowCtl {
    const reachable = this.reachable();
    if (reachable) return reachable;
    // Every open window is private or locked: a new one, unless its profile is locked too.
    const focused = this.focused();
    const profileId = focused?.profile.profile.id ?? this.ctx.profiles.manager.lastUsed;
    if (this.ctx.profileLocks.isLocked(profileId)) throw new ProfileLockedError();
    return this.open(profileId, [], { background: !focused });
  }

  removed(win: BrowserWindowCtl): void {
    this.windows = this.windows.filter((w) => w !== win);
    // The last private window of a profile: its session's cookies, storage and downloads go.
    if (win.isPrivate && !this.windows.some((w) => w.isPrivate && w.profile === win.profile)) {
      this.ctx.downloads.forgetPrivate(win.profile);
      void win.profile.endPrivateSession();
    }
    if (this.lastFocused === win) this.lastFocused = this.windows[this.windows.length - 1] ?? null;
    if (this.front === win) this.front = null;
    if (this.windows.length === 0 && process.platform !== "darwin" && !this.ctx.tray.keepsRunning()) app.quit();
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

  openExternal(wc: WebContents, url: string, requestingUrl: string): void {
    void this.ctx.externalApps.request(wc, url, requestingUrl);
  }
}
