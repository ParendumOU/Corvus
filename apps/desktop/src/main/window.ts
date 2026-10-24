import { BaseWindow, View, WebContentsView, nativeTheme, screen, type Input, type WebContents } from "electron";
import type { GroupColor, GroupId, Tab, TabGroup, TabId } from "@corvus/shared";
import { hostFromUrl } from "../shared/adblock";
import { BAR_FOLDER_ID, childrenOf } from "../shared/bookmark-tree";
import type { FindState, PermissionResponse, SiteInfo } from "../shared/browser-ipc";
import { keepsFavicon, pickFavicon } from "../shared/favicon";
import { EDITED_PAGE_SCRIPT, type SleepCandidate } from "../shared/tab-sleep";
import { PIP_ENTER_SCRIPT, PIP_EXIT_SCRIPT, PIP_WORLD_ID, shouldAutoPip, type PipEnterResult } from "../shared/media";
import type { PermissionDecision, PermissionKind } from "../shared/permissions";
import { serializeWindow, visibleBounds, type SessionBounds, type SessionWindow } from "../shared/session-state";
import { isDefaultZoom, stepZoom, zoomKey, zoomPercent } from "../shared/zoom";
import {
  CHROME_EVENT,
  INTERNAL_EVENT,
  type ChromeCommand,
  type ChromeEventMessage,
  type InternalEvent,
  type TabView,
  type WindowState,
} from "../shared/ipc";
import {
  NEW_TAB_URL,
  internalPageOf,
  isHistoryWorthy,
  isInternalUrl,
  isNewTabUrl,
  type InternalPage,
} from "../shared/internal-urls";
import { classifyOmnibox, intentToUrl } from "../shared/omnibox";
import { pageBaseColor } from "../shared/page-base";
import { homePageUrl } from "../shared/settings";
import { commandForInput, type BrowserCommand } from "../shared/shortcuts";
import { workspaceOpenPlan, type LiveTab } from "../shared/workspaces";
import type { WorkspaceView } from "../shared/workspace-ipc";
import {
  activateTab,
  activeTabHidden,
  addTabsToGroup,
  createGroup,
  cycleTab,
  emptyStrip,
  groupForWorkspace,
  indexOfTab,
  insertTab,
  insertionIndexForChild,
  linkGroupWorkspace,
  moveGroup,
  moveTab,
  nextGroupColor,
  pushClosed,
  removeGroup,
  removeTab,
  setPinned,
  tabByNumber,
  tabsInGroup,
  ungroupTabs,
  updateGroup,
  type ClosedTab,
  type GroupPatch,
  type TabStripState,
} from "../shared/tab-strip";
import type { SplitState } from "../shared/split";
import type { AppContext } from "./context";
import { showPageContextMenu } from "./menus";
import { paths } from "./paths";
import { SplitSession } from "./split-view";
import { pdfViewerRedirect } from "./pdf-intercept";
import type { ProfileRuntime } from "./profiles";
import { currentUserAgent, followSignInUserAgent, userAgentFor } from "./user-agent";

let seq = 0;
const nextId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;

export const THEME = {
  light: { strip: "#e3e7ed", symbol: "#3c4043" },
  dark: { strip: "#1c1d21", symbol: "#e8eaed" },
};

/** Height of the tab strip, also used for the native window-controls overlay. */
const TAB_STRIP_HEIGHT = 40;

/** How long a renderer may stay unresponsive before the tab shows the crash-recovery page. */
const UNRESPONSIVE_GRACE_MS = 10_000;

/** Width of an extension side panel (chrome.sidePanel) docked on the right. */
const SIDE_PANEL_WIDTH = 360;

/** Vertical tabs: collapsed sidebar width, and the top band left for the window caption buttons. */
const SIDEBAR_COLLAPSED_WIDTH = 52;
const VERTICAL_TOP_INSET = TAB_STRIP_HEIGHT;
/** Isolated world that checks whether a page has typed text before its tab sleeps. */
const SLEEP_CHECK_WORLD_ID = 1999;

export interface TabRuntime {
  id: TabId;
  view: WebContentsView;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  agentControlled: boolean;
  crashed: boolean;
  audible: boolean;
  /** Restored tab that loads when first shown. */
  pendingUrl?: string;
  /** Real page URL to reload after a crash while the recovery page is shown. */
  crashedUrl?: string;
  /** Pending grace timer started when the renderer went unresponsive. */
  unresponsiveTimer?: NodeJS.Timeout;
  /** Find bar state; null when the find bar is closed. */
  find: FindState | null;
  /** Its first page has committed (or failed); until then nothing in it can have been clicked. */
  committed: boolean;
  /** Asleep: its page was unloaded to free memory; this history comes back when it is shown. */
  asleep?: { entries: Electron.NavigationEntry[]; index: number };
  /** When it was last on screen (epoch ms). */
  lastShownAt?: number;
  /** Container the tab runs in (its own cookies and site data); none = the profile's session. */
  containerId?: string;
  /** Its video was floated (picture-in-picture) when the tab was left; it returns when shown. */
  autoPip?: boolean;
}

export interface OpenTabOptions {
  activate?: boolean;
  index?: number;
  groupId?: GroupId;
  openerId?: TabId;
  agent?: boolean;
  pinned?: boolean;
  /** Do not load until the tab is shown (session restore). */
  lazy?: boolean;
  title?: string;
  /** Icon a lazy tab shows until it loads and its page reports its own (last known site icon). */
  faviconUrl?: string;
  /** Open it in this container of the profile (ignored for corvus:// pages and unknown containers). */
  containerId?: string;
}

export interface WindowOpenOptions {
  bounds?: SessionBounds;
  maximized?: boolean;
}

function initialTitle(url: string): string {
  const page = internalPageOf(url);
  if (page === "newtab") return "New Tab";
  if (page) return page.charAt(0).toUpperCase() + page.slice(1);
  return url;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** One browser window: a chrome UI view on top of one WebContentsView per tab. */
export class BrowserWindowCtl {
  readonly id = nextId("w");
  readonly win: BaseWindow;
  readonly chrome: WebContentsView;
  private strip: TabStripState = emptyStrip();
  private readonly tabs = new Map<TabId, TabRuntime>();
  private closedTabs: ClosedTab[] = [];
  private chromeHeight = 112;
  private overlay = false;
  private htmlFullscreen = false;
  /** Tabs whose page views are currently visible (one, or the two panes of a split). */
  private shownTabIds: TabId[] = [];
  /** The tab that was active (focused) at the last sync, used to drive focus/selectTab only on change. */
  private activeShown: TabId | null = null;
  /** The active split (two tiled panes), or null in the normal single-tab mode. */
  private splitSession: SplitSession | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private chromeReady = false;
  private disposed = false;
  private readonly startMaximized: boolean;
  private readonly cleanups: Array<() => void> = [];
  private sidePanel: WebContentsView | null = null;
  /** Where keyboard focus belongs: the chrome UI or a shown tab (restored after a stray grab). */
  private lastFocused: WebContents | null = null;
  private focusRestoreQueued = false;
  /** Memory of each renderer process by OS pid, in KB (refreshed by the tab sleeper). */
  private processMemory: ReadonlyMap<number, number> = new Map();
  /** A sleeping tab's view while the extensions layer is told about it (see sleepTab). */
  private quietExtensionTab: WebContents | null = null;

  constructor(
    private readonly ctx: AppContext,
    readonly profile: ProfileRuntime,
    initialUrls: string[] = [NEW_TAB_URL],
    opts: WindowOpenOptions = {},
  ) {
    const dark = nativeTheme.shouldUseDarkColors;
    const palette = dark ? THEME.dark : THEME.light;
    const mac = process.platform === "darwin";
    const bounds = visibleBounds(opts.bounds, screen.getAllDisplays().map((d) => d.workArea));
    this.startMaximized = opts.maximized === true;
    this.win = new BaseWindow({
      width: 1280,
      height: 840,
      ...(bounds ?? {}),
      minWidth: 520,
      minHeight: 360,
      show: false,
      title: "Corvus",
      backgroundColor: palette.strip,
      titleBarStyle: "hidden",
      ...(mac
        ? { trafficLightPosition: { x: 14, y: 13 } }
        : { titleBarOverlay: { color: palette.strip, symbolColor: palette.symbol, height: TAB_STRIP_HEIGHT }, icon: paths.icon }),
    });

    this.chrome = new WebContentsView({
      webPreferences: {
        preload: paths.chromePreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.chrome.setBackgroundColor("#00000000");
    this.win.contentView.addChildView(this.chrome);
    const chromeWc = this.chrome.webContents;
    chromeWc.on("before-input-event", (event, input) => this.onInput(event, input));
    chromeWc.on("did-finish-load", () => {
      this.chromeReady = true;
      this.flushState();
      this.reveal();
    });
    chromeWc.on("focus", () => {
      this.lastFocused = chromeWc;
    });
    chromeWc.on("render-process-gone", (_e, details) => {
      this.ctx.crashReporter.record("chrome-renderer-gone", { reason: details.reason, exitCode: details.exitCode });
      this.chromeReady = false;
      if (!this.disposed) void chromeWc.loadURL("corvus://chrome/");
    });
    chromeWc.setWindowOpenHandler(() => ({ action: "deny" }));
    chromeWc.on("will-navigate", (event) => event.preventDefault());
    void chromeWc.loadURL("corvus://chrome/");
    const showFallback = setTimeout(() => this.reveal(), 4000);
    this.cleanups.push(() => clearTimeout(showFallback));

    const relayout = (): void => this.layout();
    this.win.on("resize", relayout);
    this.win.on("maximize", relayout);
    this.win.on("unmaximize", relayout);
    this.win.on("enter-full-screen", relayout);
    this.win.on("leave-full-screen", () => {
      this.htmlFullscreen = false;
      this.layout();
    });
    this.win.on("focus", () => ctx.windows.noteFocus(this));
    this.win.on("close", () => ctx.sessionRestore.windowClosing(this));
    this.win.on("closed", () => this.dispose());
    const moved = (): void => ctx.sessionRestore.markDirty();
    this.win.on("moved", moved);
    this.win.on("resized", moved);
    this.win.on("maximize", moved);
    this.win.on("unmaximize", moved);

    this.cleanups.push(
      profile.bookmarks.changes.on(() => {
        this.pushState();
        this.notifyInternalPages({ type: "bookmarks-changed" }, ["bookmarks", "newtab"]);
      }),
    );
    this.cleanups.push(profile.siteSettings.onChange(() => this.notifyInternalPages({ type: "site-permissions-changed" }, ["settings"])));
    const onTheme = (): void => this.applyTheme();
    nativeTheme.on("updated", onTheme);
    this.cleanups.push(() => nativeTheme.off("updated", onTheme));

    initialUrls.forEach((url, i) => this.createTab(url, { activate: i === 0 }));
    this.layout();
  }

  private reveal(): void {
    if (this.disposed || this.win.isVisible()) return;
    if (this.startMaximized) this.win.maximize();
    else this.win.show();
    // Focus requests made while the window was hidden (the omnibox of its first new tab) did not land.
    this.restoreFocus();
  }

  // ---------------------------------------------------------------- layout & state

  private sidebarWidth(): number {
    const a = this.ctx.settings.get().appearance;
    return a.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : a.sidebarWidth;
  }

  private layout(): void {
    if (this.disposed) return;
    const [width = 0, height = 0] = this.win.getContentSize();
    const fullscreen = this.htmlFullscreen;
    // Vertical tabs put the whole chrome UI in a full-height left sidebar; the page is inset to its
    // right and a top band is left clear for the window caption buttons.
    const vertical = !fullscreen && this.ctx.settings.get().appearance.tabLayout === "vertical";
    const left = vertical ? this.sidebarWidth() : 0;
    const top = fullscreen ? 0 : vertical ? VERTICAL_TOP_INSET : this.chromeHeight;
    this.chrome.setVisible(!fullscreen);
    if (this.overlay) this.chrome.setBounds({ x: 0, y: 0, width, height });
    else if (vertical) this.chrome.setBounds({ x: 0, y: 0, width: left, height });
    else this.chrome.setBounds({ x: 0, y: 0, width, height: top });
    // Right docks, outermost first: Corvus Assist panel, then an extension side panel inset to its left.
    const side = fullscreen ? 0 : this.ctx.assist.reservedWidth(this, width);
    const panel = this.sidePanel && !fullscreen ? Math.min(SIDE_PANEL_WIDTH, Math.floor((width - left - side) / 2)) : 0;
    this.sidePanel?.setVisible(panel > 0);
    this.sidePanel?.setBounds({ x: width - side - panel, y: top, width: panel, height: Math.max(0, height - top) });
    const content = { x: left, y: top, width: Math.max(0, width - left - side - panel), height: Math.max(0, height - top) };
    const active = this.activeTab();
    if (this.splitShown()) {
      const split = this.splitSession!;
      split.layout(
        content,
        this.strip.activeId,
        split.panes.map((id) => this.tabs.get(id)?.view),
      );
    } else {
      this.splitSession?.hide();
      active?.view.setBounds(content);
    }
    this.ctx.assist.layout(this, { x: width - side, y: top, width: side, height: content.height }, content);
    this.ctx.reader.layout(this, content);
  }

  relayout(): void {
    this.layout();
  }

  /** Docks an extension side panel on the right (null removes it). The caller owns the view. */
  setSidePanel(view: WebContentsView | null): void {
    if (this.disposed || view === this.sidePanel) return;
    if (this.sidePanel) this.win.contentView.removeChildView(this.sidePanel);
    this.sidePanel = view;
    // Below the chrome UI so its popovers still cover the panel.
    if (view) this.win.contentView.addChildView(view, 0);
    this.layout();
  }

  private applyTheme(): void {
    const palette = nativeTheme.shouldUseDarkColors ? THEME.dark : THEME.light;
    if (process.platform !== "darwin") {
      this.win.setTitleBarOverlay({ color: palette.strip, symbolColor: palette.symbol, height: TAB_STRIP_HEIGHT });
    }
    this.win.setBackgroundColor(palette.strip);
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) this.applyPageBase(tab, tab.view.webContents.getURL() || tab.url);
    }
    this.splitSession?.setTheme(this.splitAccent());
    this.pushState();
  }

  /** Base painted behind the tab's page: white for web content, the theme color for Corvus pages. */
  private applyPageBase(tab: TabRuntime, url: string): void {
    tab.view.setBackgroundColor(pageBaseColor(url, nativeTheme.shouldUseDarkColors));
  }

  setChromeHeight(height: number): void {
    const h = Math.max(0, Math.min(400, Math.round(height)));
    if (h === this.chromeHeight) return;
    this.chromeHeight = h;
    this.layout();
  }

  setOverlay(open: boolean): void {
    if (open === this.overlay) return;
    this.overlay = open;
    this.layout();
  }

  private syncActive(focusContent: boolean): void {
    const activeId = this.strip.activeId;
    // A tab outside the split shows on its own; the split waits until one of its panes is shown again.
    const visible = this.visibleTabIds();
    const now = Date.now();
    const autoPip = this.ctx.settings.get().media.autoPictureInPicture;
    for (const id of this.shownTabIds) {
      if (visible.includes(id)) continue;
      const tab = this.tabs.get(id);
      if (!tab) continue;
      tab.view.setVisible(false);
      tab.lastShownAt = now;
      if (shouldAutoPip({ audible: tab.audible, url: tab.url, enabled: autoPip })) void this.enterAutoPip(tab);
    }
    for (const id of visible) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      tab.lastShownAt = now;
      if (this.shownTabIds.includes(id)) continue;
      tab.view.setVisible(true);
      if (tab.pendingUrl) this.loadPending(tab);
      if (tab.autoPip) void this.exitAutoPip(tab);
    }
    this.shownTabIds = visible;
    if (this.activeShown !== activeId) {
      const next = activeId ? this.tabs.get(activeId) : undefined;
      if (next) {
        this.profile.extensions.selectTab(next.view.webContents);
        // A new tab page puts the caret in the omnibox, like Chrome; any other page gets the keyboard.
        if (focusContent) {
          if (isNewTabUrl(next.url)) this.focusOmnibox();
          else this.focusWebContents(next.view.webContents);
        }
      }
      this.activeShown = activeId;
    }
    this.layout();
  }

  /**
   * Leaving a tab that plays sound floats its video (picture-in-picture). The switch is the user's
   * gesture, so the request runs with one, in an isolated world the page's scripts cannot reach.
   */
  private async enterAutoPip(tab: TabRuntime): Promise<void> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const result = (await wc.executeJavaScriptInIsolatedWorld(PIP_WORLD_ID, [{ code: PIP_ENTER_SCRIPT }], true).catch(() => "failed")) as PipEnterResult;
    if (result !== "entered") return;
    tab.autoPip = true;
    // Back on the tab before the video floated: bring it straight back.
    if (this.shownTabIds.includes(tab.id)) void this.exitAutoPip(tab);
  }

  /** Back on a tab whose video Corvus floated: the video returns to the page. */
  private async exitAutoPip(tab: TabRuntime): Promise<void> {
    tab.autoPip = false;
    const wc = tab.view.webContents;
    if (!wc.isDestroyed()) await wc.executeJavaScriptInIsolatedWorld(PIP_WORLD_ID, [{ code: PIP_EXIT_SCRIPT }]).catch(() => undefined);
  }

  /** Page views that must be visible: the panes of a split one of whose tabs is active, otherwise just the active tab. */
  private visibleTabIds(): TabId[] {
    if (this.splitShown()) return [...this.splitSession!.panes];
    return this.strip.activeId ? [this.strip.activeId] : [];
  }

  state(): WindowState {
    const active = this.activeTab();
    const settings = this.ctx.settings.get();
    return {
      windowId: this.id,
      platform: process.platform,
      profile: this.profile.profile,
      profiles: this.ctx.profiles.list(),
      partition: this.profile.partition,
      tabs: this.strip.tabs.map((t) => this.tabView(t.id)).filter((t): t is TabView => t !== null),
      groups: this.strip.groups,
      activeTabId: this.strip.activeId,
      activeBookmarked: active ? this.profile.bookmarks.isBookmarked(active.url) : false,
      bookmarksBar: childrenOf(this.profile.bookmarks.list(), BAR_FOLDER_ID),
      showBookmarksBar: settings.appearance.showBookmarksBar,
      showHomeButton: settings.appearance.showHomeButton,
      dark: nativeTheme.shouldUseDarkColors,
      mcpRunning: this.ctx.mcp.isRunning(),
      tabLayout: settings.appearance.tabLayout,
      sidebarWidth: settings.appearance.sidebarWidth,
      sidebarCollapsed: settings.appearance.sidebarCollapsed,
      watches: this.ctx.monitor.barState(this.profile),
      permissionPrompt: active ? this.profile.permissions.promptFor(active.view.webContents) : null,
      find: active?.find ? { ...active.find } : null,
      zoomPercent: active && !active.view.webContents.isDestroyed() ? zoomPercent(active.view.webContents.getZoomFactor()) : 100,
      downloads: this.ctx.downloads.summary(this.profile),
      adblock: this.profile.adblock.barState(active && !active.view.webContents.isDestroyed() ? active.view.webContents : null),
      readerable: active ? this.ctx.reader.isReaderable(active) : false,
      translate: this.ctx.translate.barState(active),
      readerActive: this.ctx.reader.isActive(this),
      autofill: this.ctx.autofill.stateFor(this),
      split: this.splitState(),
      ...this.ctx.assist.windowExtras(this),
      ...this.ctx.agentRunner.windowExtras(this),
    };
  }

  setAdblockEnabled(enabled: boolean): void {
    this.profile.adblock.setEnabled(enabled);
    this.pushState();
  }

  /** Allow ("pause") or re-block ad filtering on the active tab's site. */
  pauseAdblockSite(paused: boolean): void {
    const host = hostFromUrl(this.activeTab()?.url ?? "");
    if (!host) return;
    this.profile.adblock.setSiteAllowed(host, paused);
    this.pushState();
  }

  /** The shield's "Forget this site when I close it", for the active tab's site. */
  forgetSiteOnClose(forget: boolean): void {
    const url = this.activeTab()?.url ?? "";
    const host = hostFromUrl(url);
    if (!host) return;
    this.profile.adblock.setForgetOnClose(forget ? this.ctx.adblock.siteOf(url) : host, forget);
    this.pushState();
  }

  private tabView(id: TabId): TabView | null {
    const tab = this.tabs.get(id);
    const entry = this.strip.tabs.find((t) => t.id === id);
    if (!tab || !entry || tab.view.webContents.isDestroyed()) return null;
    const history = tab.view.webContents.navigationHistory;
    const pid = tab.pendingUrl ? 0 : tab.view.webContents.getOSProcessId();
    const memoryKB = pid ? this.processMemory.get(pid) : undefined;
    const container = tab.containerId ? this.profile.containers.get(tab.containerId) : undefined;
    return {
      ...this.toTab(tab),
      ...(container ? { container } : {}),
      ...(this.splitSession?.has(tab.id) ? { inSplit: true } : {}),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      webContentsId: tab.view.webContents.id,
      crashed: tab.crashed,
      audible: tab.audible,
      ...(tab.asleep ? { sleeping: true } : {}),
      ...(memoryKB ? { memoryKB } : {}),
    };
  }

  toTab(tab: TabRuntime): Tab {
    const entry = this.strip.tabs.find((t) => t.id === tab.id);
    return {
      id: tab.id,
      windowId: this.id,
      url: tab.url,
      title: tab.title,
      ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
      ...(entry?.groupId ? { groupId: entry.groupId } : {}),
      pinned: entry?.pinned ?? false,
      active: this.strip.activeId === tab.id,
      loading: tab.loading,
      agentControlled: tab.agentControlled,
    };
  }

  listTabs(): Tab[] {
    return this.strip.tabs.map((t) => this.tabs.get(t.id)).filter((t): t is TabRuntime => t !== undefined).map((t) => this.toTab(t));
  }

  /** Live tab runtimes (for services that send to a tab's webContents, e.g. annotation re-application). */
  tabRuntimes(): TabRuntime[] {
    return [...this.tabs.values()];
  }

  listGroups(): TabGroup[] {
    return this.strip.groups.map((g) => ({ ...g }));
  }

  pushState(): void {
    if (this.stateTimer || this.disposed) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.flushState();
    }, 16);
  }

  private flushState(): void {
    if (this.disposed) return;
    this.ctx.sessionRestore.markDirty();
    this.profile.extensions.windowChanged(this.win.id);
    if (!this.chromeReady || this.chrome.webContents.isDestroyed()) return;
    const message: ChromeEventMessage = { kind: "state", state: this.state() };
    this.chrome.webContents.send(CHROME_EVENT, message);
    this.ctx.assist.refresh(this);
    this.ctx.reader.refresh(this);
  }

  sendCommand(command: ChromeCommand): void {
    if (this.disposed || this.chrome.webContents.isDestroyed()) return;
    const message: ChromeEventMessage = { kind: "command", command };
    this.chrome.webContents.send(CHROME_EVENT, message);
  }

  notifyInternalPages(event: InternalEvent, pages: InternalPage[]): void {
    for (const tab of this.tabs.values()) {
      const page = internalPageOf(tab.url);
      const wc = tab.view.webContents;
      if (page && pages.includes(page) && !wc.isDestroyed()) wc.send(INTERNAL_EVENT, event);
    }
  }

  focusOmnibox(selectAll = true): void {
    this.focusWebContents(this.chrome.webContents);
    this.sendCommand({ type: "focus-omnibox", selectAll });
  }

  focusContent(): void {
    const tab = this.activeTab();
    if (tab) this.focusWebContents(tab.view.webContents);
  }

  /** Give a webContents of this window the keyboard and remember it as where focus belongs. */
  private focusWebContents(wc: WebContents): void {
    if (wc.isDestroyed()) return;
    this.lastFocused = wc;
    wc.focus();
  }

  /**
   * Electron hands keyboard focus to a new webContents as its first page commits, even when its
   * view is hidden. Unchecked, that pulls the caret out of the omnibox of a new tab (Ctrl+T, the +
   * button, a new window) and out of the page a background tab was opened from. A hidden tab never
   * keeps focus, nor does a tab whose first page has not committed yet: focus goes back to where it
   * belongs. Deferred because a focus change made while one is being dispatched is ignored.
   */
  private onTabFocus(tab: TabRuntime): void {
    if (!tab.committed || !this.shownTabIds.includes(tab.id)) {
      if (this.focusRestoreQueued) return;
      this.focusRestoreQueued = true;
      setImmediate(() => {
        this.focusRestoreQueued = false;
        this.restoreFocus();
      });
      return;
    }
    this.lastFocused = tab.view.webContents;
    // Clicking the non-focused pane of a split makes it the active tab (omnibox/keyboard target).
    if (this.splitSession && tab.id !== this.strip.activeId) this.focusSplitPane(tab.id);
  }

  private restoreFocus(): void {
    if (this.disposed) return;
    const target = this.lastFocused;
    const shown = target && this.shownTabIds.some((id) => this.tabs.get(id)?.view.webContents === target);
    if (target && !target.isDestroyed() && (target === this.chrome.webContents || shown)) target.focus();
    else this.focusWebContents(this.chrome.webContents);
  }

  // ---------------------------------------------------------------- tabs

  activeTab(): TabRuntime | undefined {
    return this.strip.activeId ? this.tabs.get(this.strip.activeId) : undefined;
  }

  getTab(id: TabId): TabRuntime | undefined {
    return this.tabs.get(id);
  }

  hasTab(id: TabId): boolean {
    return this.tabs.has(id);
  }

  tabByWebContents(wc: WebContents): TabRuntime | undefined {
    for (const tab of this.tabs.values()) if (tab.view.webContents === wc) return tab;
    return undefined;
  }

  get tabCount(): number {
    return this.tabs.size;
  }

  /** A hidden page view for a tab, in this window, below the chrome UI (in its container's session). */
  private newTabView(url: string, containerId?: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        session: containerId ? this.profile.containerSession(containerId) : this.profile.session,
        preload: paths.internalPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        spellcheck: true,
        ...this.siteFeatures(),
      },
    });
    view.setVisible(false);
    view.setBackgroundColor(pageBaseColor(url, nativeTheme.shouldUseDarkColors));
    this.win.contentView.addChildView(view, 0);
    return view;
  }

  createTab(url: string, opts: OpenTabOptions = {}): TabRuntime {
    const id = nextId("t");
    url = pdfViewerRedirect(this.ctx, opts.agent === true, url) ?? url;
    // A container tab can start on the New Tab page; other corvus:// pages stay in the profile session.
    const containerId = opts.containerId && (!isInternalUrl(url) || isNewTabUrl(url)) && this.profile.containers.get(opts.containerId) ? opts.containerId : undefined;
    const view = this.newTabView(url, containerId);

    const lazy = opts.lazy === true && opts.activate === false;
    const tab: TabRuntime = {
      ...(containerId ? { containerId } : {}),
      id,
      view,
      url,
      title: opts.title || initialTitle(url),
      loading: !lazy,
      agentControlled: opts.agent === true,
      crashed: false,
      audible: false,
      find: null,
      committed: false,
      ...(lazy ? { pendingUrl: url } : {}),
      ...(lazy && opts.faviconUrl ? { faviconUrl: opts.faviconUrl } : {}),
    };
    this.tabs.set(id, tab);
    this.wire(tab);
    this.profile.extensions.addTab(view.webContents, this.win);

    const opener = opts.openerId ? this.strip.tabs.find((t) => t.id === opts.openerId) : undefined;
    const groupId = opts.groupId ?? opener?.groupId;
    const index = opts.index ?? (opener ? insertionIndexForChild(this.strip, opener.id) : undefined);
    const activate = opts.activate ?? true;
    this.strip = insertTab(
      this.strip,
      { id, pinned: opts.pinned === true, ...(groupId ? { groupId } : {}), ...(opener ? { openerId: opener.id } : {}) },
      { ...(index !== undefined ? { index } : {}), activate },
    );
    if (!lazy) {
      view.webContents.loadURL(url).catch(() => {
        // Load failures surface through did-fail-load.
      });
    }
    this.syncActive(true);
    this.pushState();
    return tab;
  }

  /**
   * Web platform features a site page gets. Passkeys are off unless the person turns them on: on
   * Windows every passkey request a site makes (Google tries one at each sign-in) opens the system
   * security-key dialog, where Chrome would offer it quietly.
   */
  private siteFeatures(): { disableBlinkFeatures?: string } {
    return this.ctx.settings.get().passwords.passkeys ? {} : { disableBlinkFeatures: "WebAuth" };
  }

  private wire(tab: TabRuntime): void {
    const wc = tab.view.webContents;
    const push = (): void => this.pushState();
    followSignInUserAgent(wc, this.profile.userAgents);
    wc.on("did-start-loading", () => {
      tab.loading = true;
      push();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      tab.committed = true;
      push();
    });
    // A web page gets its white base before it can first paint; a Corvus page paints its own
    // background, so its themed base waits for the commit and a page being left never flashes dark.
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument && !isInternalUrl(details.url)) this.applyPageBase(tab, details.url);
    });
    wc.on("did-navigate", (_e, url) => {
      tab.committed = true;
      this.applyPageBase(tab, url);
      // The recovery page is loaded over a crashed tab; keep the tab's real URL and crashed flag.
      if (internalPageOf(url) === "crash") return;
      const previous = tab.url;
      tab.url = url;
      tab.crashed = false;
      // Until the new page reports its icon: the site's current one, else the last one history knows.
      if (!keepsFavicon(previous, url)) tab.faviconUrl = this.profile.history.faviconsFor([url]).get(url);
      this.profile.adblock.resetTab(wc.id);
      this.ctx.translate.onNavigated(tab);
      this.ctx.reader.onNavigated(this, tab);
      this.ctx.autofill.onNavigated(this, tab);
      // A new document: any secret Corvus filled into the old one is gone, so script access returns.
      this.ctx.secretFills.clear(tab.id);
      this.applySavedZoom(tab);
      if (tab.find) tab.find = { ...tab.find, active: 0, matches: 0 };
      if (isHistoryWorthy(url)) this.profile.history.recordVisit(url, "");
      push();
    });
    wc.on("did-finish-load", () => {
      void this.ctx.translate.onPageLoad(this, tab);
      void this.ctx.reader.probe(this, tab);
      void this.ctx.autofill.onPageLoad(this, tab);
      void this.ctx.semanticSearch.capturePage(this, tab);
      this.ctx.annotations.onPageLoad(this, tab);
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      this.ctx.autofill.onInPageNavigation(this, tab);
      if (isHistoryWorthy(url)) this.profile.history.recordVisit(url, tab.title);
      push();
    });
    wc.on("page-title-updated", (_e, title) => {
      tab.title = title;
      if (isHistoryWorthy(tab.url)) this.profile.history.update(tab.url, { title });
      push();
    });
    wc.on("page-favicon-updated", (_e, favicons) => {
      const favicon = pickFavicon(favicons);
      if (!favicon) return;
      tab.faviconUrl = favicon;
      if (isHistoryWorthy(tab.url)) this.profile.history.update(tab.url, { faviconUrl: favicon });
      push();
    });
    wc.on("did-fail-load", (_e, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      tab.url = validatedURL || tab.url;
      tab.title = `${hostOf(tab.url)} — ${description}`;
      tab.loading = false;
      push();
    });
    wc.on("render-process-gone", (_e, details) => {
      // "clean-exit" is our own teardown (closeTab/dispose/sleepTab), not a crash; a page a
      // sleeping tab let go of is no longer the tab's.
      if (details.reason === "clean-exit" || this.disposed || !this.tabs.has(tab.id) || tab.view.webContents !== wc) return;
      this.clearUnresponsive(tab);
      this.ctx.crashReporter.record("tab-renderer-gone", { url: tab.url, reason: details.reason, exitCode: details.exitCode });
      this.enterCrashed(tab, details.reason);
      push();
    });
    wc.on("unresponsive", () => {
      this.ctx.crashReporter.record("tab-unresponsive", { url: tab.url });
      if (tab.unresponsiveTimer || tab.crashed || this.disposed || tab.view.webContents !== wc) return;
      tab.unresponsiveTimer = setTimeout(() => {
        tab.unresponsiveTimer = undefined;
        if (this.disposed || !this.tabs.has(tab.id) || tab.crashed) return;
        this.ctx.crashReporter.record("tab-unresponsive-timeout", { url: tab.url });
        this.enterCrashed(tab, "unresponsive");
        push();
      }, UNRESPONSIVE_GRACE_MS);
    });
    wc.on("responsive", () => this.clearUnresponsive(tab));
    wc.on("focus", () => this.onTabFocus(tab));
    wc.on("audio-state-changed", (event) => {
      tab.audible = event.audible;
      push();
    });
    wc.on("enter-html-full-screen", () => {
      this.htmlFullscreen = true;
      this.win.setFullScreen(true);
      this.layout();
    });
    wc.on("leave-html-full-screen", () => {
      this.htmlFullscreen = false;
      this.win.setFullScreen(false);
      this.layout();
    });
    wc.on("zoom-changed", (_e, direction) => this.zoomTab(tab, direction === "in" ? 1 : -1));
    wc.on("found-in-page", (_e, result) => {
      if (!tab.find) return;
      tab.find = {
        ...tab.find,
        matches: result.matches ?? tab.find.matches,
        active: result.activeMatchOrdinal ?? tab.find.active,
      };
      push();
    });
    wc.on("before-input-event", (event, input) => this.onInput(event, input));
    wc.on("context-menu", (_e, params) => showPageContextMenu(this.ctx, this, tab, params, this.chromeHeight));

    // Web content may not navigate into internal pages (like chrome:// in Chrome).
    const guard = (event: Electron.Event<Electron.WebContentsWillNavigateEventParams>): void => {
      if (isInternalUrl(event.url) && !isInternalUrl(wc.getURL())) {
        event.preventDefault();
        return;
      }
      const toViewer = pdfViewerRedirect(this.ctx, tab.agentControlled, event.url);
      if (toViewer) {
        event.preventDefault();
        setImmediate(() => this.loadUrl(tab.id, toViewer));
      }
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", (event) => {
      if (isInternalUrl(event.url)) {
        event.preventDefault();
        return;
      }
      const toViewer = pdfViewerRedirect(this.ctx, tab.agentControlled, event.url);
      if (toViewer) {
        event.preventDefault();
        setImmediate(() => this.loadUrl(tab.id, toViewer));
      }
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (isInternalUrl(url) && !isInternalUrl(wc.getURL())) return { action: "deny" };
      // Pages opened by an agent-driven tab stay agent-driven (badge, permission and download rules).
      // So do pages opened from a container tab: they share its cookies.
      const container = tab.containerId ? { containerId: tab.containerId } : {};
      if (tab.agentControlled) {
        this.createTab(url, { activate: disposition !== "background-tab", openerId: tab.id, agent: true, ...container });
        return { action: "deny" };
      }
      if (disposition === "new-window") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            backgroundColor: pageBaseColor(url, nativeTheme.shouldUseDarkColors),
            webPreferences: { session: wc.session, sandbox: true, contextIsolation: true, nodeIntegration: false, ...this.siteFeatures() },
          },
        };
      }
      this.createTab(url, { activate: disposition !== "background-tab", openerId: tab.id, ...container });
      return { action: "deny" };
    });
    // Sign-in popups ("Continue with Google") are windows of their own: same UA rule as tabs. The
    // first load started before this event, so a popup that opens on a sign-in host loads again.
    wc.on("did-create-window", (popup, details) => {
      const pw = popup.webContents;
      followSignInUserAgent(pw, this.profile.userAgents);
      const ua = userAgentFor(details.url, this.profile.userAgents);
      if (currentUserAgent(pw, this.profile.userAgents) !== ua && !details.postBody) {
        pw.loadURL(details.url, { userAgent: ua }).catch(() => undefined);
      }
    });
  }

  activate(id: TabId): void {
    if (!this.tabs.has(id)) return;
    this.strip = activateTab(this.strip, id);
    this.syncActive(true);
    this.pushState();
  }

  // ---------------------------------------------------------------- split view

  private splitAccent(): string {
    return nativeTheme.shouldUseDarkColors ? "#8ab4f8" : "#1a73e8";
  }

  isSplit(): boolean {
    return this.splitSession !== null;
  }

  /** The window has a split and one of its panes is the active tab, so the split is on screen. */
  private splitShown(): boolean {
    const active = this.strip.activeId;
    return this.splitSession !== null && active !== null && this.splitSession.has(active);
  }

  /** The tabs of this window's split, in pane order (empty without one). */
  splitPanes(): readonly TabId[] {
    return this.splitSession?.panes ?? [];
  }

  /**
   * "Split with": tiles `primaryId` (focused) with `secondaryId`. When `primaryId` is already in
   * the split, `secondaryId` joins it as another pane (up to four); otherwise a new split replaces
   * the old one.
   */
  enterSplit(primaryId: TabId, secondaryId: TabId): void {
    if (this.disposed || primaryId === secondaryId) return;
    if (!this.tabs.has(primaryId) || !this.tabs.has(secondaryId)) return;
    if (this.splitSession?.has(primaryId)) {
      this.addToSplit(secondaryId);
      return;
    }
    this.teardownSplit();
    this.strip = activateTab(this.strip, primaryId);
    this.splitSession = new SplitSession(this.win.contentView, [primaryId, secondaryId], {
      dark: nativeTheme.shouldUseDarkColors,
      accent: this.splitAccent(),
      preload: paths.splitPreload,
      onRelayout: () => this.layout(),
    });
    this.syncActive(true);
    this.pushState();
  }

  /** Adds a tab to the split as another pane (two side by side, then 1 + 2, then a 2×2 grid). */
  addToSplit(id: TabId): void {
    if (!this.splitSession || !this.tabs.has(id) || !this.splitSession.add(id)) return;
    this.strip = activateTab(this.strip, id);
    this.syncActive(true);
    this.pushState();
  }

  /** Takes a tab out of the split; with one pane left the split ends. */
  removeFromSplit(id: TabId): void {
    const split = this.splitSession;
    if (!split?.has(id)) return;
    if (split.panes.length <= 2) {
      this.exitSplit();
      return;
    }
    const wasActive = this.strip.activeId === id;
    split.remove(id);
    // The tab leaves the screen; the first pane takes over when it was the focused one.
    if (wasActive && split.panes[0]) this.strip = activateTab(this.strip, split.panes[0]);
    this.syncActive(true);
    this.pushState();
  }

  /** Move focus to a pane of the split (makes it the omnibox/keyboard target). */
  focusSplitPane(id: TabId): void {
    if (!this.splitSession?.has(id)) return;
    if (id === this.strip.activeId) return;
    this.activate(id);
  }

  exitSplit(): void {
    if (!this.splitSession) return;
    this.teardownSplit();
    this.syncActive(true);
    this.pushState();
  }

  private teardownSplit(): void {
    this.splitSession?.dispose();
    this.splitSession = null;
  }

  private splitState(): SplitState | null {
    const s = this.splitSession;
    if (!s) return null;
    const shown = this.splitShown();
    return { paneIds: [...s.panes], focusedTabId: shown ? this.strip.activeId : null, ratio: s.ratio, ratioY: s.ratioY, shown };
  }

  closeTab(id: TabId): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // Closing a pane of a split leaves the other panes tiled; with one left, the split ends and the
    // survivor stays on screen when the closed pane was.
    const split = this.splitSession;
    if (split?.has(id)) {
      split.remove(id);
      const survivor = split.panes[0];
      if (split.panes.length < 2) this.teardownSplit();
      if (this.strip.activeId === id && survivor) this.strip = activateTab(this.strip, survivor);
    }
    const entry = this.strip.tabs.find((t) => t.id === id);
    if (!isNewTabUrl(tab.url)) {
      this.closedTabs = pushClosed(this.closedTabs, {
        url: tab.url,
        title: tab.title,
        index: indexOfTab(this.strip, id),
        ...(entry?.groupId ? { groupId: entry.groupId } : {}),
        pinned: entry?.pinned ?? false,
        ...(tab.containerId ? { containerId: tab.containerId } : {}),
      });
    }
    this.clearUnresponsive(tab);
    if (!tab.view.webContents.isDestroyed()) this.profile.adblock.forgetTab(tab.view.webContents.id);
    this.ctx.reader.forgetTab(id);
    this.ctx.translate.forget(id);
    this.ctx.autofill.forgetTab(id);
    this.ctx.secretFills.clear(id);
    this.ctx.annotations.forgetTab(id);
    this.strip = removeTab(this.strip, id);
    this.tabs.delete(id);
    // A site set to be forgotten loses its cookies and data once no tab of its session shows it.
    const sameSession = (t: TabRuntime): boolean => (t.containerId ?? "") === (tab.containerId ?? "");
    const openUrls = this.ctx.windows.forProfile(this.profile.profile.id).flatMap((w) => w.tabRuntimes().filter(sameSession).map((t) => t.url));
    const tabSession = tab.containerId ? this.profile.containerSession(tab.containerId) : this.profile.session;
    void this.ctx.adblock.onTabClosed(tabSession, tab.url, openUrls);
    this.shownTabIds = this.shownTabIds.filter((t) => t !== id);
    if (this.activeShown === id) this.activeShown = null;
    this.win.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.tabs.size === 0) {
      this.win.close();
      return;
    }
    this.syncActive(true);
    this.pushState();
  }

  closeTabs(ids: TabId[]): void {
    for (const id of ids) {
      if (this.disposed) return;
      this.closeTab(id);
    }
  }

  reopenClosed(): void {
    this.restoreClosed(this.closedTabs.length - 1);
  }

  /** Recently closed tabs, oldest first. */
  recentlyClosed(): readonly ClosedTab[] {
    return this.closedTabs;
  }

  restoreClosed(index: number): TabRuntime | undefined {
    const entry = this.closedTabs[index];
    if (!entry) return undefined;
    this.closedTabs = this.closedTabs.filter((_, i) => i !== index);
    const groupId = entry.groupId && this.strip.groups.some((g) => g.id === entry.groupId) ? entry.groupId : undefined;
    return this.createTab(entry.url, {
      index: entry.index,
      pinned: entry.pinned,
      ...(groupId ? { groupId } : {}),
      ...(entry.containerId ? { containerId: entry.containerId } : {}),
    });
  }

  private loadPending(tab: TabRuntime): void {
    const url = tab.pendingUrl;
    if (!url) return;
    delete tab.pendingUrl;
    tab.loading = true;
    const asleep = tab.asleep;
    delete tab.asleep;
    // A sleeping tab wakes with its whole history, scroll position and form values.
    const load = asleep ? tab.view.webContents.navigationHistory.restore(asleep) : tab.view.webContents.loadURL(url);
    load.catch(() => {
      // Reported via did-fail-load.
    });
  }

  /**
   * Loads a background tab that is not loaded yet (restored or asleep) without showing it, for a
   * service that reads its page; resolves once it stops loading (or after a while).
   */
  async ensureLoaded(id: TabId, timeoutMs = 15_000): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab?.pendingUrl) return;
    const wc = tab.view.webContents;
    const stopped = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      wc.once("did-stop-loading", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.loadPending(tab);
    await stopped;
  }

  /** Whether the tab can go to sleep right now, by what only its page knows (typed text). */
  async pageIsEdited(id: TabId): Promise<boolean> {
    const wc = this.tabs.get(id)?.view.webContents;
    if (!wc || wc.isDestroyed()) return false;
    return (await wc.executeJavaScriptInIsolatedWorld(SLEEP_CHECK_WORLD_ID, [{ code: EDITED_PAGE_SCRIPT }]).catch(() => true)) === true;
  }

  /**
   * Puts a background tab to sleep: its history is kept, its page and renderer are released, and
   * a fresh unloaded view takes its place; showing the tab restores the history. Refuses a tab
   * that is on screen, already unloaded, or not a web page.
   */
  sleepTab(id: TabId): boolean {
    const tab = this.tabs.get(id);
    if (!tab || tab.pendingUrl || this.shownTabIds.includes(id) || !/^https?:/i.test(tab.url)) return false;
    const old = tab.view;
    const wc = old.webContents;
    if (wc.isDestroyed()) return false;
    const entries = wc.navigationHistory.getAllEntries();
    const index = wc.navigationHistory.getActiveIndex();
    if (entries.length === 0 || index < 0) return false;
    this.clearUnresponsive(tab);
    this.profile.adblock.forgetTab(wc.id);
    this.ctx.translate.forget(id);
    this.ctx.reader.forgetTab(id);
    this.win.contentView.removeChildView(old);
    wc.close();
    tab.view = this.newTabView(tab.url, tab.containerId);
    tab.asleep = { entries, index };
    tab.pendingUrl = tab.url;
    tab.loading = false;
    tab.committed = false;
    tab.find = null;
    this.wire(tab);
    // The extensions layer makes a tab it is given active when it lost track of the active one
    // (asking us to select it), which would wake this tab at once.
    this.quietExtensionTab = tab.view.webContents;
    try {
      this.profile.extensions.addTab(tab.view.webContents, this.win);
    } finally {
      this.quietExtensionTab = null;
    }
    this.pushState();
    return true;
  }

  /** The extensions layer is being told about a sleeping tab's new view: its select request is ours to ignore. */
  isQuietExtensionTab(wc: WebContents): boolean {
    return wc === this.quietExtensionTab;
  }

  /** What the tab sleeper weighs for each tab of this window. */
  sleepCandidates(): SleepCandidate[] {
    return this.strip.tabs.flatMap((entry) => {
      const tab = this.tabs.get(entry.id);
      if (!tab) return [];
      return [
        {
          id: tab.id,
          url: tab.url,
          lastShownAt: tab.lastShownAt,
          shown: this.shownTabIds.includes(tab.id),
          pinned: entry.pinned,
          audible: tab.audible,
          loading: tab.loading,
          agentControlled: tab.agentControlled,
          crashed: tab.crashed,
          unloaded: Boolean(tab.pendingUrl),
        },
      ];
    });
  }

  /** Memory of each renderer process (by OS pid, in KB), shown next to the tabs using it. */
  setProcessMemory(byPid: ReadonlyMap<number, number>): void {
    this.processMemory = byPid;
    this.pushState();
  }

  /** Show the in-tab recovery page over a crashed/hung renderer, keeping the tab's real URL. */
  private enterCrashed(tab: TabRuntime, reason: string): void {
    tab.crashed = true;
    tab.loading = false;
    tab.crashedUrl = tab.url;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const target = `corvus://crash/?reason=${encodeURIComponent(reason)}&url=${encodeURIComponent(tab.url)}`;
    wc.loadURL(target).catch(() => {
      // The recovery page is internal; a failure here just leaves the tab blank.
    });
  }

  private clearUnresponsive(tab: TabRuntime): void {
    if (tab.unresponsiveTimer) {
      clearTimeout(tab.unresponsiveTimer);
      tab.unresponsiveTimer = undefined;
    }
  }

  /** Reload the page that crashed in this tab, replacing the recovery page. */
  recoverCrashed(tab: TabRuntime): void {
    const url = tab.crashedUrl ?? tab.url;
    delete tab.crashedUrl;
    tab.crashed = false;
    tab.loading = true;
    tab.url = url;
    const wc = tab.view.webContents;
    if (!wc.isDestroyed()) {
      wc.loadURL(url).catch(() => {
        // Reported via did-fail-load.
      });
    }
    this.pushState();
  }

  loadUrl(id: TabId, url: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.clearUnresponsive(tab);
    tab.crashed = false;
    delete tab.crashedUrl;
    url = pdfViewerRedirect(this.ctx, tab.agentControlled, url) ?? url;
    delete tab.pendingUrl;
    tab.url = url;
    tab.view.webContents.loadURL(url).catch(() => {
      // Reported via did-fail-load.
    });
    if (id === this.strip.activeId) this.focusWebContents(tab.view.webContents);
    this.pushState();
  }

  navigateInput(id: TabId, input: string): void {
    const url = intentToUrl(classifyOmnibox(input));
    this.loadUrl(id, url);
  }

  openUrl(url: string, disposition: "current" | "new-tab" | "background-tab"): void {
    const active = this.activeTab();
    if (disposition === "current" && active) this.loadUrl(active.id, url);
    else this.createTab(url, { activate: disposition !== "background-tab", ...(active ? { openerId: active.id } : {}) });
  }

  openInNewWindow(url: string): void {
    this.ctx.windows.open(this.profile.profile.id, [url]);
  }

  /** Activate an existing tab showing this internal page, or open it. */
  openSingleton(url: string): void {
    const page = internalPageOf(url);
    for (const t of this.strip.tabs) {
      const tab = this.tabs.get(t.id);
      if (tab && page && internalPageOf(tab.url) === page) {
        this.activate(t.id);
        return;
      }
    }
    const active = this.activeTab();
    if (active && isNewTabUrl(active.url)) this.loadUrl(active.id, url);
    else this.createTab(url);
  }

  goBack(id: TabId): void {
    const history = this.tabs.get(id)?.view.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  }

  goForward(id: TabId): void {
    const history = this.tabs.get(id)?.view.webContents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  }

  /** The home page from Settings > Appearance, in this tab or a new one. */
  home(id: TabId, inNewTab = false): void {
    const url = homePageUrl(this.ctx.settings.get().appearance);
    if (inNewTab || !this.tabs.has(id)) this.createTab(url, { activate: true });
    else this.loadUrl(id, url);
  }

  reload(id: TabId, hard = false): void {
    const tab = this.tabs.get(id);
    if (tab?.crashedUrl) return this.recoverCrashed(tab);
    if (tab?.pendingUrl) return this.loadPending(tab);
    const wc = tab?.view.webContents;
    if (!wc) return;
    if (hard) wc.reloadIgnoringCache();
    else wc.reload();
  }

  stop(id: TabId): void {
    this.tabs.get(id)?.view.webContents.stop();
  }

  duplicate(id: TabId): void {
    const tab = this.tabs.get(id);
    if (tab) {
      this.createTab(tab.url, {
        index: indexOfTab(this.strip, id) + 1,
        ...(this.groupOf(id) ? { groupId: this.groupOf(id) } : {}),
        ...(tab.containerId ? { containerId: tab.containerId } : {}),
      });
    }
  }

  /** "Send to your phone…": the page as a QR code to scan, and to Telegram when a chat is linked. */
  async shareToPhone(url: string, title: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    const { encodeQR } = await import("qr");
    const qrSvg = encodeQR(url, "svg", { border: 2 });
    this.sendCommand({ type: "open-share", share: { url, title, qrSvg, telegram: this.ctx.telegram.status().linked } });
  }

  /** Opens `url` in a new tab in a container (null: none), next to `openerId` when given. */
  openInContainer(url: string, containerId: string | null, openerId?: TabId): TabRuntime {
    return this.createTab(url, { ...(openerId ? { openerId } : {}), ...(containerId ? { containerId } : {}) });
  }

  /** "Reopen in container": the tab's page again, in a new tab in that container, right after it. */
  reopenInContainer(id: TabId, containerId: string | null): TabRuntime | undefined {
    const tab = this.tabs.get(id);
    if (!tab || (tab.containerId ?? null) === containerId) return undefined;
    return this.createTab(tab.pendingUrl ?? tab.url, {
      index: indexOfTab(this.strip, id) + 1,
      ...(this.groupOf(id) ? { groupId: this.groupOf(id) } : {}),
      ...(containerId ? { containerId } : {}),
    });
  }

  /** Closes this window's tabs in a container (it is being removed). */
  closeContainerTabs(containerId: string): void {
    this.closeTabs([...this.tabs.values()].filter((t) => t.containerId === containerId).map((t) => t.id));
  }

  groupOf(id: TabId): GroupId | undefined {
    return this.strip.tabs.find((t) => t.id === id)?.groupId;
  }

  isPinned(id: TabId): boolean {
    return this.strip.tabs.find((t) => t.id === id)?.pinned === true;
  }

  tabIds(): TabId[] {
    return this.strip.tabs.map((t) => t.id);
  }

  markAgent(id: TabId): void {
    const tab = this.tabs.get(id);
    if (tab && !tab.agentControlled) {
      tab.agentControlled = true;
      this.pushState();
    }
  }

  /** The user's own tab is theirs again after an Assist agent run worked in it. */
  clearAgentMark(id: TabId): void {
    const tab = this.tabs.get(id);
    if (tab?.agentControlled) {
      tab.agentControlled = false;
      this.pushState();
    }
  }

  moveTab(id: TabId, toIndex: number, groupId: GroupId | null): void {
    this.strip = moveTab(this.strip, id, toIndex, groupId);
    this.pushState();
  }

  pin(id: TabId, pinned: boolean): void {
    this.strip = setPinned(this.strip, id, pinned);
    this.pushState();
  }

  // ---------------------------------------------------------------- groups

  createGroup(tabIds: TabId[], opts: { title?: string; color?: GroupColor; workspaceId?: string } = {}): TabGroup | null {
    const ids = tabIds.filter((id) => this.tabs.has(id));
    if (ids.length === 0) return null;
    const group: TabGroup = {
      id: nextId("g"),
      title: opts.title ?? "",
      color: opts.color ?? nextGroupColor(this.strip),
      collapsed: false,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    };
    this.strip = createGroup(this.strip, ids, group);
    this.pushState();
    return group;
  }

  /**
   * Opens the name and color editor of a group in the chrome UI. The state goes out first: a group
   * just created is otherwise not in the UI yet when the editor looks for it.
   */
  editGroup(groupId: GroupId): void {
    if (this.stateTimer) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    this.flushState();
    this.focusWebContents(this.chrome.webContents);
    this.sendCommand({ type: "edit-group", groupId });
  }

  addToGroup(tabIds: TabId[], groupId: GroupId): void {
    this.strip = addTabsToGroup(this.strip, tabIds, groupId);
    this.pushState();
  }

  ungroupTabs(tabIds: TabId[]): void {
    this.strip = ungroupTabs(this.strip, tabIds);
    this.pushState();
  }

  ungroup(groupId: GroupId): void {
    this.strip = removeGroup(this.strip, groupId);
    this.pushState();
  }

  updateGroup(groupId: GroupId, patch: GroupPatch): void {
    this.strip = updateGroup(this.strip, groupId, patch);
    if (activeTabHidden(this.strip)) {
      this.createTab(NEW_TAB_URL);
      return;
    }
    this.syncActive(false);
    this.pushState();
  }

  moveGroup(groupId: GroupId, toIndex: number): void {
    this.strip = moveGroup(this.strip, groupId, toIndex);
    this.pushState();
  }

  closeGroup(groupId: GroupId): void {
    this.closeTabs(tabsInGroup(this.strip, groupId).map((t) => t.id));
  }

  newTabInGroup(groupId: GroupId): void {
    if (this.strip.groups.some((g) => g.id === groupId)) this.createTab(NEW_TAB_URL, { groupId });
  }

  hasGroup(groupId: GroupId): boolean {
    return this.strip.groups.some((g) => g.id === groupId);
  }

  // ---------------------------------------------------------------- commands

  private onInput(event: Electron.Event, input: Input): void {
    const command = commandForInput(input, process.platform);
    if (!command) return;
    event.preventDefault();
    this.runCommand(command);
  }

  runCommand(command: BrowserCommand): void {
    const active = this.activeTab();
    switch (command.type) {
      case "new-tab":
        this.createTab(NEW_TAB_URL);
        break;
      case "new-window":
        this.ctx.windows.open(this.profile.profile.id);
        break;
      case "close-tab":
        if (active) this.closeTab(active.id);
        break;
      case "reopen-closed-tab":
        this.reopenClosed();
        break;
      case "focus-omnibox":
        this.focusOmnibox();
        break;
      case "next-tab":
      case "prev-tab": {
        const id = cycleTab(this.strip, command.type === "next-tab" ? 1 : -1);
        if (id) this.activate(id);
        break;
      }
      case "select-tab": {
        const id = tabByNumber(this.strip, command.n);
        if (id) this.activate(id);
        break;
      }
      case "reload":
        if (active) this.reload(active.id, command.hard);
        break;
      case "home":
        if (active) this.home(active.id);
        break;
      case "stop":
        if (active) this.stop(active.id);
        break;
      case "back":
        if (active) this.goBack(active.id);
        break;
      case "forward":
        if (active) this.goForward(active.id);
        break;
      case "bookmark-page":
        this.toggleBookmark();
        break;
      case "open-history":
        this.openSingleton("corvus://history/");
        break;
      case "open-bookmarks":
        this.openSingleton("corvus://bookmarks/");
        break;
      case "toggle-bookmarks-bar": {
        const current = this.ctx.settings.get().appearance.showBookmarksBar;
        this.ctx.settings.update({ appearance: { showBookmarksBar: !current } });
        break;
      }
      case "devtools": {
        const wc = active?.view.webContents;
        if (!wc) break;
        if (wc.isDevToolsOpened()) wc.closeDevTools();
        else wc.openDevTools({ mode: "detach" });
        break;
      }
      case "zoom":
        if (active) this.zoomTab(active, command.delta);
        break;
      case "find":
        this.openFind();
        break;
      case "find-next":
        if (active?.find?.text) this.findStep(command.forward);
        else this.openFind();
        break;
      case "open-downloads":
        this.openSingleton("corvus://downloads/");
        break;
      case "toggle-assist":
        this.ctx.assist.toggle(this);
        break;
      case "command-palette":
        this.focusWebContents(this.chrome.webContents);
        this.sendCommand({ type: "open-command-palette" });
        break;
      case "organize-tabs":
        this.focusWebContents(this.chrome.webContents);
        this.sendCommand({ type: "open-organizer" });
        break;
    }
  }

  // ---------------------------------------------------------------- zoom

  /** Zoom a tab one preset step (0 = reset) and remember the level for its site in this profile. */
  zoomTab(tab: TabRuntime, delta: 1 | -1 | 0): void {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const factor = stepZoom(wc.getZoomFactor(), delta);
    const key = zoomKey(wc.getURL() || tab.url);
    wc.setZoomFactor(factor);
    this.profile.siteSettings.setZoom(key, factor);
    if (key) this.ctx.windows.applyZoom(this.profile.profile.id, key, factor);
    this.pushState();
  }

  /** Apply a site's zoom to every tab of this window showing it. */
  applyZoom(key: string, factor: number): void {
    for (const tab of this.tabs.values()) {
      const wc = tab.view.webContents;
      if (wc.isDestroyed() || tab.pendingUrl || zoomKey(wc.getURL() || tab.url) !== key) continue;
      if (Math.abs(wc.getZoomFactor() - factor) > 0.001) wc.setZoomFactor(factor);
    }
    this.pushState();
  }

  private applySavedZoom(tab: TabRuntime): void {
    const wc = tab.view.webContents;
    const factor = this.profile.siteSettings.zoom(zoomKey(wc.getURL() || tab.url));
    if (Math.abs(wc.getZoomFactor() - factor) > 0.001 || !isDefaultZoom(factor)) wc.setZoomFactor(factor);
  }

  // ---------------------------------------------------------------- find in page

  openFind(): void {
    const tab = this.activeTab();
    if (!tab) return;
    if (!tab.find) tab.find = { text: "", active: 0, matches: 0 };
    this.focusWebContents(this.chrome.webContents);
    this.sendCommand({ type: "find-focus" });
    this.pushState();
  }

  findQuery(text: string): void {
    const tab = this.activeTab();
    if (!tab?.find) return;
    const wc = tab.view.webContents;
    tab.find = { text, active: 0, matches: 0 };
    if (text) wc.findInPage(text, { findNext: true });
    else wc.stopFindInPage("clearSelection");
    this.pushState();
  }

  findStep(forward: boolean): void {
    const tab = this.activeTab();
    if (!tab?.find?.text) return;
    tab.view.webContents.findInPage(tab.find.text, { forward, findNext: false });
  }

  closeFind(): void {
    const tab = this.activeTab();
    if (!tab?.find) return;
    tab.find = null;
    tab.view.webContents.stopFindInPage("keepSelection");
    this.focusWebContents(tab.view.webContents);
    this.pushState();
  }

  // ---------------------------------------------------------------- site permissions

  respondPermission(promptId: string, response: PermissionResponse, remember: boolean, sourceId?: string): boolean {
    return this.profile.permissions.respond(promptId, response, remember, sourceId, (wc) => this.tabByWebContents(wc) !== undefined);
  }

  siteInfo(): SiteInfo | null {
    const tab = this.activeTab();
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    const url = tab.view.webContents.getURL() || tab.url;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const scheme = parsed.protocol === "https:" ? "https" : parsed.protocol === "http:" ? "http" : parsed.protocol === "file:" ? "file" : "other";
    const view = this.profile.permissions.siteView(tab.view.webContents, url);
    return {
      origin: view.origin,
      host: parsed.host || parsed.protocol.replace(/:$/, ""),
      scheme,
      secure: view.secure,
      agent: tab.agentControlled,
      permissions: view.permissions,
      zoomPercent: zoomPercent(tab.view.webContents.getZoomFactor()),
    };
  }

  setSitePermission(kind: PermissionKind, decision: PermissionDecision | null): SiteInfo | null {
    const tab = this.activeTab();
    if (tab && !tab.view.webContents.isDestroyed()) {
      this.profile.permissions.setSitePermission(tab.view.webContents, tab.view.webContents.getURL() || tab.url, kind, decision);
    }
    return this.siteInfo();
  }

  resetSitePermissions(): SiteInfo | null {
    const tab = this.activeTab();
    if (tab && !tab.view.webContents.isDestroyed()) {
      this.profile.permissions.resetSite(tab.view.webContents, tab.view.webContents.getURL() || tab.url);
    }
    return this.siteInfo();
  }

  // ---------------------------------------------------------------- session restore

  sessionWindow(): SessionWindow | null {
    const bounds = this.win.getNormalBounds();
    return serializeWindow({
      profileId: this.profile.profile.id,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      maximized: this.win.isMaximized(),
      tabs: this.strip.tabs.flatMap((entry) => {
        const tab = this.tabs.get(entry.id);
        if (!tab) return [];
        return [
          {
            url: tab.pendingUrl ?? tab.url,
            title: tab.title,
            pinned: entry.pinned,
            ...(entry.groupId ? { groupId: entry.groupId } : {}),
            ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
            ...(tab.containerId ? { containerId: tab.containerId } : {}),
            active: entry.id === this.strip.activeId,
          },
        ];
      }),
      groups: this.strip.groups,
    });
  }

  /** Recreate a saved window's tabs and groups. Only the active tab loads right away. */
  restoreTabs(saved: SessionWindow): void {
    // The active tab goes first so the strip never auto-activates (and loads) a lazy tab.
    const ids: Array<TabId | undefined> = [];
    const activeTab = saved.tabs[saved.activeIndex];
    // Background tabs do not load until shown: give them their saved icon, or the last one history
    // knows for the page or site (sessions saved before icons were persisted), not the placeholder.
    const known = this.profile.history.faviconsFor(saved.tabs.filter((t) => !t.faviconUrl).map((t) => t.url));
    const containerOf = (t: { containerId?: string }): { containerId?: string } => (t.containerId ? { containerId: t.containerId } : {});
    if (activeTab) ids[saved.activeIndex] = this.createTab(activeTab.url, { pinned: activeTab.pinned, title: activeTab.title, ...containerOf(activeTab) }).id;
    saved.tabs.forEach((t, i) => {
      if (i === saved.activeIndex) return;
      const faviconUrl = t.faviconUrl ?? known.get(t.url);
      ids[i] = this.createTab(t.url, {
        activate: false,
        index: i,
        pinned: t.pinned,
        lazy: true,
        title: t.title,
        ...(faviconUrl ? { faviconUrl } : {}),
        ...containerOf(t),
      }).id;
    });
    const activeId = ids[saved.activeIndex];
    for (const g of saved.groups) {
      const members = saved.tabs.flatMap((t, i) => {
        const id = ids[i];
        return t.groupId === g.id && id ? [id] : [];
      });
      const group = this.createGroup(members, { title: g.title, color: g.color, ...(g.workspaceId ? { workspaceId: g.workspaceId } : {}) });
      if (group && g.collapsed && !(activeId && members.includes(activeId))) this.updateGroup(group.id, { collapsed: true });
    }
    if (this.tabs.size === 0) this.createTab(NEW_TAB_URL);
  }

  // ---------------------------------------------------------------- workspaces

  /** This window's tabs as saveable workspace entries (url/title/pinned/group). */
  workspaceTabs(): LiveTab[] {
    return this.strip.tabs.flatMap((entry) => {
      const tab = this.tabs.get(entry.id);
      if (!tab) return [];
      return [{ url: tab.pendingUrl ?? tab.url, title: tab.title, pinned: entry.pinned, ...(entry.groupId ? { groupId: entry.groupId } : {}) }];
    });
  }

  private groupLiveTabs(groupId: GroupId): LiveTab[] {
    return tabsInGroup(this.strip, groupId).flatMap((entry) => {
      const tab = this.tabs.get(entry.id);
      return tab ? [{ url: tab.pendingUrl ?? tab.url, title: tab.title, pinned: false }] : [];
    });
  }

  /** Saved workspaces, marking the ones whose group is open in this window. */
  workspaceViews(): WorkspaceView[] {
    return this.profile.workspaces.summaries().map((w) => {
      const group = groupForWorkspace(this.strip, w.id);
      return group ? { ...w, openGroupId: group.id } : w;
    });
  }

  /**
   * Open a workspace in this window as one tab group named after it, its first tab active and the
   * others loading when first shown. If its group is already open here, that group is focused.
   */
  openWorkspace(id: string): TabGroup | null {
    const ws = this.profile.workspaces.get(id);
    if (!ws) return null;
    const open = groupForWorkspace(this.strip, id);
    if (open) {
      this.focusGroup(open.id);
      return open;
    }
    const plan = workspaceOpenPlan(ws);
    if (plan.tabs.length === 0) return null;
    const known = this.profile.history.faviconsFor(plan.tabs.map((t) => t.url));
    const ids = plan.tabs.map((t, i) => {
      const faviconUrl = known.get(t.url);
      return this.createTab(t.url, { activate: i === 0, lazy: i > 0, title: t.title, ...(faviconUrl ? { faviconUrl } : {}) }).id;
    });
    return this.createGroup(ids, { title: plan.title, ...(plan.color ? { color: plan.color } : {}), workspaceId: id });
  }

  /** Expand a group and make one of its tabs the active one (unless it already is). */
  focusGroup(groupId: GroupId): void {
    const group = this.strip.groups.find((g) => g.id === groupId);
    if (!group) return;
    if (group.collapsed) this.updateGroup(groupId, { collapsed: false });
    const members = tabsInGroup(this.strip, groupId);
    if (!members.some((t) => t.id === this.strip.activeId) && members[0]) this.activate(members[0].id);
  }

  /**
   * Save a tab group as a new workspace (and link the group to it), or re-save the workspace the
   * group is already linked to. Returns the workspace id, or null when nothing was worth saving.
   */
  saveGroupAsWorkspace(groupId: GroupId): string | null {
    const group = this.strip.groups.find((g) => g.id === groupId);
    if (!group) return null;
    const tabs = this.groupLiveTabs(groupId);
    if (group.workspaceId && this.profile.workspaces.updateTabs(group.workspaceId, tabs, group.color)) return group.workspaceId;
    const ws = this.profile.workspaces.saveGroup(group.title, tabs, group.color);
    if (!ws) return null;
    this.strip = linkGroupWorkspace(this.strip, groupId, ws.id);
    if (group.title !== ws.name) this.strip = updateGroup(this.strip, groupId, { title: ws.name });
    this.pushState();
    return ws.id;
  }

  /** A workspace was renamed or deleted: its open group follows the new name, or is unlinked. */
  workspaceChanged(id: string): void {
    const group = groupForWorkspace(this.strip, id);
    if (!group) return;
    const ws = this.profile.workspaces.get(id);
    this.strip = ws ? updateGroup(this.strip, group.id, { title: ws.name }) : linkGroupWorkspace(this.strip, group.id, null);
    this.pushState();
  }

  toggleBookmark(): boolean {
    const active = this.activeTab();
    if (!active || isInternalUrl(active.url) || active.url === "about:blank") return false;
    const added = this.profile.bookmarks.toggle(active.url, active.title);
    this.pushState();
    return added;
  }

  close(): void {
    if (!this.disposed) this.win.close();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.teardownSplit();
    for (const cleanup of this.cleanups) cleanup();
    for (const tab of this.tabs.values()) {
      this.clearUnresponsive(tab);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
    this.ctx.assist.disposeWindow(this);
    this.ctx.reader.disposeWindow(this);
    if (!this.chrome.webContents.isDestroyed()) this.chrome.webContents.close();
    this.ctx.windows.removed(this);
  }
}
