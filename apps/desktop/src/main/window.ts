import { BaseWindow, View, WebContentsView, nativeTheme, screen, type Input, type WebContents } from "electron";
import type { GroupColor, GroupId, Tab, TabGroup, TabId } from "@corvus/shared";
import { hostFromUrl } from "../shared/adblock";
import { BAR_FOLDER_ID, childrenOf } from "../shared/bookmark-tree";
import type { FindState, PermissionResponse, SiteInfo } from "../shared/browser-ipc";
import { pickFavicon } from "../shared/favicon";
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
import { commandForInput, type BrowserCommand } from "../shared/shortcuts";
import { materializeWorkspace, type LiveTab } from "../shared/workspaces";
import type { WorkspaceOpenMode } from "../shared/workspace-ipc";
import {
  activateTab,
  activeTabHidden,
  addTabsToGroup,
  createGroup,
  cycleTab,
  emptyStrip,
  indexOfTab,
  insertTab,
  insertionIndexForChild,
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

let seq = 0;
const nextId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;

export const THEME = {
  light: { strip: "#e3e7ed", symbol: "#3c4043", page: "#ffffff" },
  dark: { strip: "#1c1d21", symbol: "#e8eaed", page: "#202124" },
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
    if (this.splitSession) {
      this.splitSession.layout(
        content,
        this.strip.activeId,
        this.tabs.get(this.splitSession.left)?.view,
        this.tabs.get(this.splitSession.right)?.view,
      );
    } else {
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
    this.splitSession?.setTheme(this.splitAccent());
    this.pushState();
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
    // Activating a tab that is not part of the current split collapses back to a single pane.
    if (this.splitSession && activeId && activeId !== this.splitSession.left && activeId !== this.splitSession.right) {
      this.teardownSplit();
    }
    const visible = this.visibleTabIds();
    for (const id of this.shownTabIds) {
      if (!visible.includes(id)) this.tabs.get(id)?.view.setVisible(false);
    }
    for (const id of visible) {
      if (this.shownTabIds.includes(id)) continue;
      const tab = this.tabs.get(id);
      if (!tab) continue;
      tab.view.setVisible(true);
      if (tab.pendingUrl) this.loadPending(tab);
    }
    this.shownTabIds = visible;
    if (this.activeShown !== activeId) {
      const next = activeId ? this.tabs.get(activeId) : undefined;
      if (next) {
        this.profile.extensions.selectTab(next.view.webContents);
        if (focusContent && !isNewTabUrl(next.url)) next.view.webContents.focus();
      }
      this.activeShown = activeId;
    }
    this.layout();
  }

  /** Page views that must be visible: the two panes in a split, otherwise just the active tab. */
  private visibleTabIds(): TabId[] {
    if (this.splitSession) return [this.splitSession.left, this.splitSession.right];
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

  private tabView(id: TabId): TabView | null {
    const tab = this.tabs.get(id);
    const entry = this.strip.tabs.find((t) => t.id === id);
    if (!tab || !entry || tab.view.webContents.isDestroyed()) return null;
    const history = tab.view.webContents.navigationHistory;
    return {
      ...this.toTab(tab),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      webContentsId: tab.view.webContents.id,
      crashed: tab.crashed,
      audible: tab.audible,
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
    this.chrome.webContents.focus();
    this.sendCommand({ type: "focus-omnibox", selectAll });
  }

  focusContent(): void {
    this.activeTab()?.view.webContents.focus();
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

  createTab(url: string, opts: OpenTabOptions = {}): TabRuntime {
    const id = nextId("t");
    url = pdfViewerRedirect(this.ctx, opts.agent === true, url) ?? url;
    const view = new WebContentsView({
      webPreferences: {
        session: this.profile.session,
        preload: paths.internalPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        spellcheck: true,
      },
    });
    view.setVisible(false);
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? THEME.dark.page : THEME.light.page);
    this.win.contentView.addChildView(view, 0);

    const lazy = opts.lazy === true && opts.activate === false;
    const tab: TabRuntime = {
      id,
      view,
      url,
      title: opts.title || initialTitle(url),
      loading: !lazy,
      agentControlled: opts.agent === true,
      crashed: false,
      audible: false,
      find: null,
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
    if (activate && isNewTabUrl(url)) this.focusOmnibox();
    this.pushState();
    return tab;
  }

  private wire(tab: TabRuntime): void {
    const wc = tab.view.webContents;
    const push = (): void => this.pushState();
    wc.on("did-start-loading", () => {
      tab.loading = true;
      push();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      push();
    });
    wc.on("did-navigate", (_e, url) => {
      // The recovery page is loaded over a crashed tab; keep the tab's real URL and crashed flag.
      if (internalPageOf(url) === "crash") return;
      tab.url = url;
      tab.crashed = false;
      tab.faviconUrl = undefined;
      this.profile.adblock.resetTab(wc.id);
      this.ctx.reader.onNavigated(this, tab);
      this.ctx.autofill.onNavigated(this, tab);
      this.applySavedZoom(tab);
      if (tab.find) tab.find = { ...tab.find, active: 0, matches: 0 };
      if (isHistoryWorthy(url)) this.profile.history.recordVisit(url, "");
      push();
    });
    wc.on("did-finish-load", () => {
      void this.ctx.reader.probe(this, tab);
      void this.ctx.autofill.onPageLoad(this, tab);
      void this.ctx.semanticSearch.capturePage(this, tab);
      this.ctx.annotations.onPageLoad(this, tab);
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
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
      // "clean-exit" is our own teardown (closeTab/dispose), not a crash.
      if (details.reason === "clean-exit" || this.disposed || !this.tabs.has(tab.id)) return;
      this.clearUnresponsive(tab);
      this.ctx.crashReporter.record("tab-renderer-gone", { url: tab.url, reason: details.reason, exitCode: details.exitCode });
      this.enterCrashed(tab, details.reason);
      push();
    });
    wc.on("unresponsive", () => {
      this.ctx.crashReporter.record("tab-unresponsive", { url: tab.url });
      if (tab.unresponsiveTimer || tab.crashed || this.disposed) return;
      tab.unresponsiveTimer = setTimeout(() => {
        tab.unresponsiveTimer = undefined;
        if (this.disposed || !this.tabs.has(tab.id) || tab.crashed) return;
        this.ctx.crashReporter.record("tab-unresponsive-timeout", { url: tab.url });
        this.enterCrashed(tab, "unresponsive");
        push();
      }, UNRESPONSIVE_GRACE_MS);
    });
    wc.on("responsive", () => this.clearUnresponsive(tab));
    // Clicking the non-focused pane of a split makes it the active tab (omnibox/keyboard target).
    wc.on("focus", () => {
      if (this.splitSession && tab.id !== this.strip.activeId) this.focusSplitPane(tab.id);
    });
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
      if (tab.agentControlled) {
        this.createTab(url, { activate: disposition !== "background-tab", openerId: tab.id, agent: true });
        return { action: "deny" };
      }
      if (disposition === "new-window") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            backgroundColor: nativeTheme.shouldUseDarkColors ? THEME.dark.page : THEME.light.page,
            webPreferences: { session: this.profile.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        };
      }
      this.createTab(url, { activate: disposition !== "background-tab", openerId: tab.id });
      return { action: "deny" };
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

  /** Tile two tabs side by side. `primaryId` becomes the focused pane (omnibox/nav target). */
  enterSplit(primaryId: TabId, secondaryId: TabId): void {
    if (this.disposed || primaryId === secondaryId) return;
    if (!this.tabs.has(primaryId) || !this.tabs.has(secondaryId)) return;
    this.teardownSplit();
    this.strip = activateTab(this.strip, primaryId);
    this.splitSession = new SplitSession(this.win.contentView, primaryId, secondaryId, {
      dark: nativeTheme.shouldUseDarkColors,
      accent: this.splitAccent(),
      preload: paths.splitPreload,
      onRelayout: () => this.layout(),
    });
    this.syncActive(true);
    this.pushState();
  }

  /** Move focus to a pane of the active split (makes it the omnibox/keyboard target). */
  focusSplitPane(id: TabId): void {
    if (!this.splitSession) return;
    if (id !== this.splitSession.left && id !== this.splitSession.right) return;
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
    if (!s || !this.strip.activeId) return null;
    return { leftTabId: s.left, rightTabId: s.right, focusedTabId: this.strip.activeId, ratio: s.ratio };
  }

  closeTab(id: TabId): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // Closing either pane of a split collapses it to the surviving tab, kept active.
    if (this.splitSession && (id === this.splitSession.left || id === this.splitSession.right)) {
      const survivor = id === this.splitSession.left ? this.splitSession.right : this.splitSession.left;
      this.teardownSplit();
      if (this.strip.activeId === id) this.strip = activateTab(this.strip, survivor);
    }
    const entry = this.strip.tabs.find((t) => t.id === id);
    if (!isNewTabUrl(tab.url)) {
      this.closedTabs = pushClosed(this.closedTabs, {
        url: tab.url,
        title: tab.title,
        index: indexOfTab(this.strip, id),
        ...(entry?.groupId ? { groupId: entry.groupId } : {}),
        pinned: entry?.pinned ?? false,
      });
    }
    this.clearUnresponsive(tab);
    if (!tab.view.webContents.isDestroyed()) this.profile.adblock.forgetTab(tab.view.webContents.id);
    this.ctx.reader.forgetTab(id);
    this.ctx.autofill.forgetTab(id);
    this.ctx.annotations.forgetTab(id);
    this.strip = removeTab(this.strip, id);
    this.tabs.delete(id);
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
    return this.createTab(entry.url, { index: entry.index, pinned: entry.pinned, ...(groupId ? { groupId } : {}) });
  }

  private loadPending(tab: TabRuntime): void {
    const url = tab.pendingUrl;
    if (!url) return;
    delete tab.pendingUrl;
    tab.loading = true;
    tab.view.webContents.loadURL(url).catch(() => {
      // Reported via did-fail-load.
    });
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
    if (id === this.strip.activeId) tab.view.webContents.focus();
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
    if (tab) this.createTab(tab.url, { index: indexOfTab(this.strip, id) + 1, ...(this.groupOf(id) ? { groupId: this.groupOf(id) } : {}) });
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

  moveTab(id: TabId, toIndex: number, groupId: GroupId | null): void {
    this.strip = moveTab(this.strip, id, toIndex, groupId);
    this.pushState();
  }

  pin(id: TabId, pinned: boolean): void {
    this.strip = setPinned(this.strip, id, pinned);
    this.pushState();
  }

  // ---------------------------------------------------------------- groups

  createGroup(tabIds: TabId[], opts: { title?: string; color?: GroupColor } = {}): TabGroup | null {
    const ids = tabIds.filter((id) => this.tabs.has(id));
    if (ids.length === 0) return null;
    const group: TabGroup = { id: nextId("g"), title: opts.title ?? "", color: opts.color ?? nextGroupColor(this.strip), collapsed: false };
    this.strip = createGroup(this.strip, ids, group);
    this.pushState();
    return group;
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
        this.chrome.webContents.focus();
        this.sendCommand({ type: "open-command-palette" });
        break;
      case "organize-tabs":
        this.chrome.webContents.focus();
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
    this.chrome.webContents.focus();
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
    tab.view.webContents.focus();
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
    if (activeTab) ids[saved.activeIndex] = this.createTab(activeTab.url, { pinned: activeTab.pinned, title: activeTab.title }).id;
    saved.tabs.forEach((t, i) => {
      if (i === saved.activeIndex) return;
      const faviconUrl = t.faviconUrl ?? known.get(t.url);
      ids[i] = this.createTab(t.url, { activate: false, index: i, pinned: t.pinned, lazy: true, title: t.title, ...(faviconUrl ? { faviconUrl } : {}) }).id;
    });
    const activeId = ids[saved.activeIndex];
    for (const g of saved.groups) {
      const members = saved.tabs.flatMap((t, i) => {
        const id = ids[i];
        return t.groupId === g.id && id ? [id] : [];
      });
      const group = this.createGroup(members, { title: g.title, color: g.color });
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

  private applyWorkspaceAppend(mat: ReturnType<typeof materializeWorkspace>, activateFirst: boolean): void {
    const ids: Array<TabId | undefined> = [];
    const known = this.profile.history.faviconsFor(mat.tabs.map((t) => t.url));
    mat.tabs.forEach((t, i) => {
      const active = activateFirst && i === 0;
      const faviconUrl = known.get(t.url);
      ids.push(this.createTab(t.url, { activate: active, lazy: !active, pinned: t.pinned, title: t.title, ...(faviconUrl ? { faviconUrl } : {}) }).id);
    });
    for (const g of mat.groups) {
      const members = mat.tabs.flatMap((t, i) => (t.groupId === g.id && ids[i] ? [ids[i] as TabId] : []));
      const group = this.createGroup(members, { title: g.title, color: g.color });
      if (group && g.collapsed) this.updateGroup(group.id, { collapsed: true });
    }
  }

  openWorkspace(id: string, mode: WorkspaceOpenMode): void {
    const ws = this.profile.workspaces.get(id);
    if (!ws) return;
    const mat = materializeWorkspace(ws, () => nextId("g"));
    if (mat.tabs.length === 0) return;
    if (mode === "new-window") {
      this.ctx.windows.restore({
        profileId: this.profile.profile.id,
        maximized: false,
        activeIndex: 0,
        tabs: mat.tabs.map(({ url, title, pinned, groupId }) => ({ url, title, pinned, ...(groupId ? { groupId } : {}) })),
        groups: mat.groups.map(({ id: gid, title, color, collapsed }) => ({ id: gid, title, color, collapsed })),
      });
      return;
    }
    const old = mode === "replace" ? this.tabIds() : [];
    this.applyWorkspaceAppend(mat, mode === "replace");
    if (old.length > 0) this.closeTabs(old);
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
