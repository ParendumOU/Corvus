import { BaseWindow, View, WebContentsView, nativeTheme, screen, type Input, type WebContents } from "electron";
import type { GroupColor, GroupId, Tab, TabGroup, TabId } from "@corvus/shared";
import { hostFromUrl, isYouTubeHost } from "../shared/adblock";
import { BAR_FOLDER_ID, childrenOf } from "../shared/bookmark-tree";
import type { FindState, PermissionResponse, SiteInfo } from "../shared/browser-ipc";
import { certBlockReason, certErrorCode, certErrorKind, certHost, isCertNetError, type CertBlockReason } from "../shared/cert-errors";
import { keepsFavicon, pickFavicon } from "../shared/favicon";
import { RedirectChain, bookmarkPageKeys, isPersonInput } from "../shared/favicon-redirects";
import { EDITED_PAGE_SCRIPT, type SleepCandidate } from "../shared/tab-sleep";
import { PIP_ENTER_SCRIPT, PIP_EXIT_SCRIPT, PIP_WORLD_ID, shouldAutoPip, type PipEnterResult } from "../shared/media";
import type { PermissionDecision, PermissionKind } from "../shared/permissions";
import { serializeWindow, visibleBounds, type SessionBounds, type SessionWindow } from "../shared/session-state";
import { fallbackWindowState } from "../shared/window-state";
import { isDefaultZoom, stepZoom, zoomKey, zoomPercent } from "../shared/zoom";
import { matchesPattern, routeFor } from "../shared/connections";
import {
  CHROME_EVENT,
  INTERNAL_EVENT,
  type ChromeCommand,
  type ConnectionBadge,
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
import { siteSearchUrl } from "../shared/site-search";
import { pageBaseColor } from "../shared/page-base";
import { homePageUrl } from "../shared/settings";
import { commandForInput, type BrowserCommand } from "../shared/shortcuts";
import { ACTION_COMMANDS } from "../shared/extension-commands";
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
import type { CertProblem } from "./cert-errors";
import type { AppContext } from "./context";
import { showPageContextMenu } from "./menus";
import { paths } from "./paths";
import { attachUiContextMenu } from "./ui-context-menu";
import { SplitSession } from "./split-view";
import { pdfViewerRedirect } from "./pdf-intercept";
import type { ProfileRuntime } from "./profiles";
import { applyWindowTaskbarIdentity } from "./taskbar";
import { currentUserAgent, followSignInUserAgent, userAgentFor } from "./user-agent";

let seq = 0;
const nextId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;

export const THEME = {
  light: { strip: "#e3e7ed", symbol: "#3c4043" },
  dark: { strip: "#1c1d21", symbol: "#e8eaed" },
  /** Private windows, in either theme. */
  private: { strip: "#2a2342", symbol: "#ece8f7" },
};

/** How long a reload may take to start before the address is loaded again instead. */
const RELOAD_FALLBACK_MS = 700;

/** Height of the tab strip, also used for the native window-controls overlay. */
const TAB_STRIP_HEIGHT = 40;

/** How long a renderer may stay unresponsive before the tab shows the crash-recovery page. */
const UNRESPONSIVE_GRACE_MS = 10_000;

/** Width of an extension side panel (chrome.sidePanel) docked on the right. */
const SIDE_PANEL_WIDTH = 360;

/** A view docked on the right, which lays out its own children in the bounds it is given. */
export interface DockedPanel {
  view: View;
  layout(bounds: { x: number; y: number; width: number; height: number }): void;
}

/** Vertical tabs: collapsed sidebar width, and the top band left for the window caption buttons. */
const SIDEBAR_COLLAPSED_WIDTH = 52;
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
  /** Its page failed on the site's certificate: the certificate error page stands in for it. */
  certError?: CertProblem & { block: CertBlockReason | null };
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
  /** When the tab was created (sleeping tabs count from here when it was never shown). */
  openedAt: number;
  /** Container the tab runs in (its own cookies and site data); none = the profile's session. */
  containerId?: string;
  /** Its video was floated (picture-in-picture) when the tab was left; it returns when shown. */
  autoPip?: boolean;
  /** The pages its current navigation went through (redirects), for the icons of bookmarks that lead elsewhere. */
  redirects?: RedirectChain;
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
  /** Chromium's options for a window.open page (see setWindowOpenHandler): the tab hosts that page. */
  windowOpen?: Electron.BrowserWindowConstructorOptions;
}

export interface WindowOpenOptions {
  bounds?: SessionBounds;
  maximized?: boolean;
  /** A private window: its tabs live in the profile's in-memory session, and nothing of it is kept. */
  private?: boolean;
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

/** A view's page, or null once it is closed (Electron then drops it from the view: `webContents` is undefined). */
function pageOf(view: WebContentsView): WebContents | null {
  const wc = view.webContents as WebContents | undefined;
  return wc && !wc.isDestroyed() ? wc : null;
}

/** One browser window: a chrome UI view on top of one WebContentsView per tab. */
export class BrowserWindowCtl {
  readonly id = nextId("w");
  readonly win: BaseWindow;
  readonly chrome: WebContentsView;
  private strip: TabStripState = emptyStrip();
  private readonly tabs = new Map<TabId, TabRuntime>();
  /** Groups an agent run is working in (see setAgentGroup). */
  private readonly agentGroups = new Set<GroupId>();
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
  /** The last state the chrome UI got, and why the newest one could not be built (see sendState). */
  private lastState: WindowState | null = null;
  private stateError: string | null = null;
  private chromeReady = false;
  private disposed = false;
  private readonly startMaximized: boolean;
  private readonly cleanups: Array<() => void> = [];
  private sidePanel: DockedPanel | null = null;
  /** Where keyboard focus belongs: the chrome UI or a shown tab (restored after a stray grab). */
  private lastFocused: WebContents | null = null;
  private focusRestoreQueued = false;
  /** Memory of each renderer process by OS pid, in KB (refreshed by the tab sleeper). */
  private processMemory: ReadonlyMap<number, number> = new Map();
  /** A sleeping tab's view while the extensions layer is told about it (see sleepTab). */
  private quietExtensionTab: WebContents | null = null;

  /** A private window (see WindowOpenOptions.private). */
  readonly isPrivate: boolean;

  constructor(
    private readonly ctx: AppContext,
    readonly profile: ProfileRuntime,
    initialUrls: string[] = [NEW_TAB_URL],
    opts: WindowOpenOptions = {},
  ) {
    const dark = nativeTheme.shouldUseDarkColors;
    this.isPrivate = opts.private === true;
    const palette = this.isPrivate ? THEME.private : dark ? THEME.dark : THEME.light;
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
    applyWindowTaskbarIdentity(this.win);

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
    attachUiContextMenu(this.win, this.chrome, chromeWc);
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
    const reshape = (): void => {
      this.layout();
      this.pushState();
    };
    this.win.on("resize", relayout);
    this.win.on("maximize", reshape);
    this.win.on("unmaximize", reshape);
    this.win.on("enter-full-screen", reshape);
    this.win.on("leave-full-screen", () => {
      this.htmlFullscreen = false;
      reshape();
    });
    this.win.on("focus", () => ctx.windows.noteFocus(this));
    // Private windows are never part of the saved session.
    this.win.on("close", () => (this.isPrivate ? undefined : ctx.sessionRestore.windowClosing(this)));
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
    // A bookmark may show another icon (see faviconRevision).
    this.cleanups.push(profile.favicons.onChange(() => this.pushState()));
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
    // Vertical tabs: the toolbar keeps the top band across the window and the tabs take a sidebar
    // below it. The chrome UI then covers the whole window but sits under the page and the panels,
    // which leave it the top band and the sidebar; it comes on top only for its overlays (menus,
    // the Command Bar, dialogs).
    const vertical = !fullscreen && this.ctx.settings.get().appearance.tabLayout === "vertical";
    const left = vertical ? this.sidebarWidth() : 0;
    const top = fullscreen ? 0 : this.chromeHeight;
    this.chrome.setVisible(!fullscreen);
    if (this.overlay || vertical) this.chrome.setBounds({ x: 0, y: 0, width, height });
    else this.chrome.setBounds({ x: 0, y: 0, width, height: top });
    this.stackChrome(!vertical || this.overlay);
    // Right docks, outermost first: Corvus Assist panel, then an extension side panel inset to its left.
    const side = fullscreen ? 0 : this.ctx.assist.reservedWidth(this, width);
    const panel = this.sidePanel && !fullscreen ? Math.min(SIDE_PANEL_WIDTH, Math.floor((width - left - side) / 2)) : 0;
    this.sidePanel?.view.setVisible(panel > 0);
    if (this.sidePanel) {
      const bounds = { x: width - side - panel, y: top, width: panel, height: Math.max(0, height - top) };
      this.sidePanel.view.setBounds(bounds);
      this.sidePanel.layout(bounds);
    }
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

  /**
   * The chrome UI on top of the window's views (its usual place), or under all of them (vertical
   * tabs, where the page and the panels cover all of it but the top band and the sidebar).
   */
  private stackChrome(onTop: boolean): void {
    const parent = this.win.contentView;
    const children = parent.children;
    const index = children.indexOf(this.chrome);
    if (index < 0 || (onTop ? index === children.length - 1 : index === 0)) return;
    // Re-adding a child only reorders it (nothing is removed, so the chrome UI keeps its focus):
    // the chrome UI to the top, or every other view above it in the order they are in.
    if (onTop) parent.addChildView(this.chrome);
    else for (const child of children.filter((c) => c !== this.chrome)) parent.addChildView(child);
  }

  /** Docks an extension side panel on the right (null removes it). The caller owns its views. */
  setSidePanel(panel: DockedPanel | null): void {
    if (this.disposed || panel === this.sidePanel) return;
    if (this.sidePanel) this.win.contentView.removeChildView(this.sidePanel.view);
    this.sidePanel = panel;
    // Below the chrome UI so its popovers still cover the panel.
    if (panel) this.win.contentView.addChildView(panel.view, 0);
    this.layout();
  }

  /** The side panel docked in this window, if any. */
  dockedPanel(): DockedPanel | null {
    return this.sidePanel;
  }

  private applyTheme(): void {
    const palette = this.isPrivate ? THEME.private : nativeTheme.shouldUseDarkColors ? THEME.dark : THEME.light;
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
    const page = active ? pageOf(active.view) : null;
    const settings = this.ctx.settings.get();
    return {
      windowId: this.id,
      platform: process.platform,
      profile: this.profile.profile,
      profiles: this.ctx.profiles.list(),
      partition: this.profile.partition,
      privateWindow: this.isPrivate,
      maximized: this.win.isMaximized() || this.win.isFullScreen(),
      connection: this.connectionBadge(active),
      tabs: this.strip.tabs.map((t) => this.tabView(t.id)).filter((t): t is TabView => t !== null),
      groups: this.strip.groups,
      agentGroups: [...this.agentGroups].filter((id) => this.hasGroup(id)),
      activeTabId: this.strip.activeId,
      activeBookmarked: active ? this.profile.bookmarks.isBookmarked(active.url) : false,
      bookmarksBar: childrenOf(this.profile.bookmarks.list(), BAR_FOLDER_ID),
      faviconRevision: this.profile.favicons.revision,
      showBookmarksBar: settings.appearance.showBookmarksBar,
      showHomeButton: settings.appearance.showHomeButton,
      dark: nativeTheme.shouldUseDarkColors,
      mcpRunning: this.ctx.mcp.isRunning(),
      tabLayout: settings.appearance.tabLayout,
      sidebarWidth: settings.appearance.sidebarWidth,
      sidebarCollapsed: settings.appearance.sidebarCollapsed,
      watches: this.ctx.monitor.barState(this.profile),
      permissionPrompt: page ? this.profile.permissions.promptFor(page) : null,
      dialog: this.ctx.dialogs.current(this),
      dialogBars: this.ctx.dialogs.bars(this),
      find: active?.find ? { ...active.find } : null,
      zoomPercent: page ? zoomPercent(page.getZoomFactor()) : 100,
      downloads: this.ctx.downloads.summary(this.profile),
      copiedLinks: this.ctx.grabber.copiedLinks(),
      defaultBrowserOffer: this.ctx.defaultBrowser.offerFor(this),
      adblock: this.profile.adblock.barState(page),
      readerable: active ? this.ctx.reader.isReaderable(active) : false,
      translate: this.ctx.translate.barState(active),
      readerActive: this.ctx.reader.isActive(this),
      dictationReady: this.ctx.dictation.ready(),
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

  /** The shield's "Remove them again": YouTube leaves the skip-ads fallback, and a YouTube tab reloads. */
  endYouTubeFallback(): void {
    this.profile.adblock.setYouTubeFallbackUntil(0);
    const tab = this.activeTab();
    if (tab && isYouTubeHost(hostFromUrl(tab.url) ?? "")) this.reload(tab.id);
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

  /**
   * The shield's "Allow cookie banner on this site": Corvus stops answering the active tab's site's
   * cookie banners (or answers them again), and the page reloads so that applies at once.
   */
  allowCookieBanner(allowed: boolean): void {
    const tab = this.activeTab();
    const url = tab?.url ?? "";
    const host = hostFromUrl(url);
    if (!tab || !host) return;
    this.profile.adblock.setConsentAllowed(allowed ? this.ctx.adblock.siteOf(url) : host, allowed);
    this.reload(tab.id);
    this.pushState();
  }

  private tabView(id: TabId): TabView | null {
    const tab = this.tabs.get(id);
    const entry = this.strip.tabs.find((t) => t.id === id);
    const wc = tab && pageOf(tab.view);
    if (!tab || !entry || !wc) return null;
    const history = wc.navigationHistory;
    const pid = tab.pendingUrl ? 0 : wc.getOSProcessId();
    const memoryKB = pid ? this.processMemory.get(pid) : undefined;
    const container = tab.containerId ? this.profile.containers.get(tab.containerId) : undefined;
    const certError = this.certErrorOf(tab);
    return {
      ...this.basicTabView(tab),
      ...(container ? { container } : {}),
      ...(certError ? { certError } : {}),
      ...(this.splitSession?.has(tab.id) ? { inSplit: true } : {}),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      webContentsId: wc.id,
      ...(memoryKB ? { memoryKB } : {}),
    };
  }

  /** A tab as the strip shows it, from what the window keeps of it (nothing is asked of its page). */
  private basicTabView(tab: TabRuntime): TabView {
    return {
      ...this.toTab(tab),
      canGoBack: false,
      canGoForward: false,
      webContentsId: -1,
      crashed: tab.crashed,
      audible: tab.audible,
      ...(tab.asleep ? { sleeping: true } : {}),
    };
  }

  /** The certificate error the tab's page failed on, or was let through with in this session ("Not secure"). */
  private certErrorOf(tab: TabRuntime): string | null {
    return tab.certError?.code ?? this.ctx.certErrors.proceededWith(tab.view.webContents.session, tab.url);
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
    if (this.chromeReady && !this.chrome.webContents.isDestroyed()) {
      this.sendState();
      this.ctx.assist.refresh(this);
      this.ctx.reader.refresh(this);
    }
    // After the chrome UI: an extension listener that throws must not hold its state back.
    this.profile.extensions.windowChanged(this.win.id);
  }

  /**
   * Sends the window's state to the chrome UI. Should building or sending it throw (a tab or a
   * service in a state nobody planned for), the error is logged and the chrome UI still gets the
   * window's tabs and active tab, over the last state it got: the strip and the address bar never
   * stay frozen on an old state while the window goes on underneath.
   */
  private sendState(): void {
    const send = (state: WindowState): void => {
      const message: ChromeEventMessage = { kind: "state", state };
      this.chrome.webContents.send(CHROME_EVENT, message);
      this.lastState = state;
    };
    try {
      send(this.state());
      this.stateError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Logged once, not on every state while the failure lasts.
      if (message !== this.stateError) this.ctx.crashReporter.record("window-state-failed", { message, stack: err instanceof Error ? err.stack : undefined });
      this.stateError = message;
      if (!this.lastState) return;
      const tabs = this.strip.tabs.flatMap((entry) => {
        const tab = this.tabs.get(entry.id);
        return tab ? [this.basicTabView(tab)] : [];
      });
      send(fallbackWindowState(this.lastState, { tabs, groups: this.strip.groups, activeTabId: this.strip.activeId }));
    }
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
  /** Asks in this window with Corvus's dialog (same options as Electron's dialog.showMessageBox). */
  messageBox(options: Electron.MessageBoxOptions): Promise<{ response: number; checkboxChecked: boolean }> {
    return this.ctx.dialogs.messageBox(options, this);
  }

  /** Gives the keyboard to Corvus's UI (a dialog it shows takes Enter and Escape). */
  focusChrome(): void {
    this.focusWebContents(this.chrome.webContents);
  }

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

  /** The tab a tab was opened from (a link with target=_blank, window.open). */
  openerOf(id: TabId): TabId | undefined {
    return this.strip.tabs.find((t) => t.id === id)?.openerId;
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

  /**
   * A hidden page view for a tab, in this window, below the chrome UI (in its container's session).
   * `windowOpen` carries the page Chromium made for a window.open call, which the view then hosts.
   */
  private newTabView(url: string, containerId?: string, windowOpen?: Electron.BrowserWindowConstructorOptions): WebContentsView {
    const view = new WebContentsView({
      ...windowOpen,
      webPreferences: {
        ...windowOpen?.webPreferences,
        session: containerId ? this.profile.containerSession(containerId) : this.isPrivate ? this.profile.privateSession() : this.profile.session,
        preload: paths.internalPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Session preloads (ad blocker, cookie banners, GPC) also run in iframes; each one guards itself.
        nodeIntegrationInSubFrames: true,
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
    const opened = opts.windowOpen;
    if (!opened) url = pdfViewerRedirect(this.ctx, opts.agent === true, url) ?? url;
    // A container tab can start on the New Tab page; other corvus:// pages stay in the profile session.
    // Private windows have no containers: their tabs are all in the private session.
    const containerId = !this.isPrivate && opts.containerId && (!isInternalUrl(url) || isNewTabUrl(url)) && this.profile.containers.get(opts.containerId) ? opts.containerId : undefined;
    const view = this.newTabView(url, containerId, opened);

    const lazy = opts.lazy === true && opts.activate === false;
    const tab: TabRuntime = {
      ...(containerId ? { containerId } : {}),
      id,
      view,
      url,
      title: opts.title || initialTitle(url),
      loading: !lazy,
      agentControlled: opts.agent === true,
      openedAt: Date.now(),
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
    // A page opened by window.open loads itself (and its opener may still write to or navigate it).
    if (!lazy && !opened) {
      const start = (): void =>
        void view.webContents.loadURL(url).catch(() => {
          // Load failures surface through did-fail-load.
        });
      // Not before the session is on its proxy (right after start or a change), so nothing leaks.
      const ses = view.webContents.session;
      if (this.profile.isConnected(ses)) start();
      else void this.profile.whenConnected(ses).then(() => (view.webContents.isDestroyed() ? undefined : start()));
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
    const redirects = (tab.redirects ??= new RedirectChain());
    // A click or key press in a tab an agent works in: the person takes over (see AgentRunner).
    wc.on("input-event", (_event, input) => {
      this.ctx.agentRunner.personInput(this, tab.id, input.type);
      // Where the page goes next is the person's doing, not a redirect.
      if (isPersonInput(input.type)) redirects.interrupt();
    });
    followSignInUserAgent(wc, this.profile.userAgents);
    wc.on("did-start-loading", () => {
      tab.loading = true;
      push();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      tab.committed = true;
      redirects.loaded(Date.now());
      push();
    });
    // A web page gets its white base before it can first paint; a Corvus page paints its own
    // background, so its themed base waits for the commit and a page being left never flashes dark.
    wc.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      redirects.start(details.url, Boolean(details.initiator), Date.now());
      if (!isInternalUrl(details.url)) this.applyPageBase(tab, details.url);
    });
    wc.on("did-redirect-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) redirects.redirect(details.url);
    });
    wc.on("did-navigate", (_e, url) => {
      tab.committed = true;
      this.applyPageBase(tab, url);
      // The recovery page is loaded over a crashed tab; keep the tab's real URL and crashed flag.
      if (internalPageOf(url) === "crash") return;
      // So is the certificate error page over the page that failed.
      if (internalPageOf(url) === "cert-error") {
        this.tidyCertHistory(wc, tab.certError?.url);
        return;
      }
      delete tab.certError;
      this.tidyCertHistory(wc);
      const chain = redirects.commit(url, Date.now());
      // Bookmarks it went through on the way to another site show that site's icon from now on.
      if (!this.isPrivate) {
        let bookmarked: Set<string> | null = null;
        this.profile.favicons.navigated(chain, (key) => (bookmarked ??= bookmarkPageKeys(this.profile.bookmarks.list())).has(key));
      }
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
      if (isHistoryWorthy(url) && !this.isPrivate) this.profile.history.recordVisit(url, "");
      push();
    });
    wc.on("did-finish-load", () => {
      void this.ctx.translate.onPageLoad(this, tab);
      void this.ctx.reader.probe(this, tab);
      void this.ctx.autofill.onPageLoad(this, tab);
      if (!this.isPrivate) void this.ctx.semanticSearch.capturePage(this, tab);
      this.ctx.annotations.onPageLoad(this, tab);
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      this.ctx.autofill.onInPageNavigation(this, tab);
      if (isHistoryWorthy(url) && !this.isPrivate) this.profile.history.recordVisit(url, tab.title);
      push();
    });
    wc.on("page-title-updated", (_e, title) => {
      tab.title = title;
      if (isHistoryWorthy(tab.url) && !tab.certError) this.profile.history.update(tab.url, { title });
      push();
    });
    this.ctx.pageDialogs.watch(wc);
    wc.on("page-favicon-updated", (_e, favicons) => {
      const favicon = pickFavicon(favicons);
      if (!favicon) return;
      tab.faviconUrl = favicon;
      if (isHistoryWorthy(tab.url)) this.profile.history.update(tab.url, { faviconUrl: favicon });
      // Kept for the bookmarks bar and Corvus's pages; a private window keeps nothing.
      if (!this.isPrivate) this.profile.favicons.remember(tab.url, favicon, (url, init) => wc.session.fetch(url, init));
      push();
    });
    wc.on("did-fail-load", (_e, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      tab.url = validatedURL || tab.url;
      tab.loading = false;
      if (isCertNetError(code)) {
        const problem = this.ctx.certErrors.take(wc, tab.url) ?? { url: tab.url, host: certHost(tab.url), code: certErrorCode(description), fingerprint: "", hsts: false };
        this.showCertError(tab, problem);
      } else {
        delete tab.certError;
        tab.title = `${hostOf(tab.url)} - ${description}`;
      }
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
    // A page that closes itself (window.close()) takes its webContents along and Electron drops it
    // from the view: the tab closes too, as in Chrome, rather than staying on without a page.
    const view = tab.view;
    wc.once("destroyed", () => {
      if (!this.disposed && this.tabs.get(tab.id) === tab && tab.view === view) this.closeTab(tab.id);
    });
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
      // A new tab hosts the page Chromium creates, so window.open returns it to the opener as in any
      // browser: pages that open "" and then navigate or write into it (window.open("", "_blank"))
      // would otherwise be left with null and an empty tab. Form posts into a new tab keep their body.
      const inTab = (): Electron.WindowOpenHandlerResponse => ({
        action: "allow",
        createWindow: (options) =>
          this.createTab(url, {
            activate: disposition !== "background-tab",
            openerId: tab.id,
            ...(tab.agentControlled ? { agent: true } : {}),
            ...container,
            windowOpen: options,
          }).view.webContents,
      });
      if (tab.agentControlled) return inTab();
      if (disposition === "new-window") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            backgroundColor: pageBaseColor(url, nativeTheme.shouldUseDarkColors),
            webPreferences: { session: wc.session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, ...this.siteFeatures() },
          },
        };
      }
      return inTab();
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
        id: nextId("c"),
        closedAt: Date.now(),
        url: tab.url,
        title: tab.title,
        index: indexOfTab(this.strip, id),
        ...(entry?.groupId ? { groupId: entry.groupId } : {}),
        pinned: entry?.pinned ?? false,
        ...(tab.containerId ? { containerId: tab.containerId } : {}),
      });
    }
    this.clearUnresponsive(tab);
    const page = pageOf(tab.view);
    if (page) this.profile.adblock.forgetTab(page.id);
    this.ctx.reader.forgetTab(id);
    this.ctx.translate.forget(id);
    this.ctx.autofill.forgetTab(id);
    this.ctx.secretFills.clear(id);
    this.ctx.annotations.forgetTab(id);
    this.ctx.assist.forgetTab(id);
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
    page?.close();
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

  /** Reopens the closed tab with this id (chrome.sessions.restore). */
  restoreClosedById(id: string): TabRuntime | undefined {
    const index = this.closedTabs.findIndex((c) => c.id === id);
    return index < 0 ? undefined : this.restoreClosed(index);
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
          openedAt: tab.openedAt,
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

  /**
   * Chrome's "Your connection is not private" in place of a page that failed on its certificate.
   * The tab keeps the page's URL (the address bar says it is not secure); Reload tries it again.
   */
  private showCertError(tab: TabRuntime, problem: CertProblem): void {
    // Without the certificate there is nothing to accept: no Proceed.
    const block = certBlockReason(problem.code, problem.hsts) ?? (problem.fingerprint ? null : "fatal");
    const shown = { ...problem, block };
    tab.certError = shown;
    tab.title = problem.host;
    const query = new URLSearchParams({ url: problem.url, code: problem.code, kind: certErrorKind(problem.code, problem.validity), ...(block ? { block } : {}) });
    // Not from inside the failed navigation's own events, and not once something else was loaded meanwhile.
    setImmediate(() => {
      if (tab.certError !== shown || tab.view.webContents.isDestroyed()) return;
      tab.view.webContents.loadURL(`corvus://cert-error/?${query}`).catch(() => {
        // The page is internal; a failure here just leaves the tab blank.
      });
    });
  }

  /**
   * History keeps no trace of a certificate error: not the failed load the error page stands in for
   * (Back would fail on it again), nor error pages left behind (they would show stale errors).
   */
  private tidyCertHistory(wc: WebContents, failedUrl?: string): void {
    const history = wc.navigationHistory;
    const active = history.getActiveIndex();
    for (let i = history.length() - 1; i >= 0; i--) {
      if (i === active) continue;
      const url = history.getEntryAtIndex(i)?.url ?? "";
      if (internalPageOf(url) === "cert-error" || (i === active - 1 && url === failedUrl)) history.removeEntryAtIndex(i);
    }
  }

  /** "Proceed to <host> (unsafe)": accepts that certificate for the host in this session and loads the page. */
  proceedPastCertError(tab: TabRuntime): boolean {
    const problem = tab.certError;
    if (!problem) {
      // An error page with nothing behind it (a tab woken from sleep): try the page again.
      if (/^https?:/i.test(tab.url)) this.loadUrl(tab.id, tab.url);
      return false;
    }
    if (problem.block) return false;
    this.ctx.certErrors.exceptions.allow(tab.view.webContents.session, problem.host, problem.fingerprint, problem.code);
    this.loadUrl(tab.id, problem.url);
    return true;
  }

  /** "Back to safety": the page before, or the New Tab page when there is none. */
  leaveCertError(tab: TabRuntime): void {
    const history = tab.view.webContents.navigationHistory;
    if (history.canGoBack()) history.goBack();
    else this.loadUrl(tab.id, NEW_TAB_URL);
  }

  /** "Turn on warnings again": the site's certificate is no longer accepted in this session. */
  restoreCertWarnings(): void {
    const tab = this.activeTab();
    const session = tab?.view.webContents.session;
    if (!tab || !session || !this.ctx.certErrors.exceptions.revoke(session, certHost(tab.url))) return;
    // Connections opened with the accepted certificate would otherwise carry on serving the site.
    void session.closeAllConnections().then(() => this.reload(tab.id));
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
    delete tab.certError;
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
    // A search shortcut's keyword first ("yt cats") searches that site.
    const url = siteSearchUrl(input, this.profile.siteSearch.list()) ?? intentToUrl(classifyOmnibox(input));
    this.loadUrl(id, url);
  }

  openUrl(url: string, disposition: "current" | "new-tab" | "background-tab"): void {
    const active = this.activeTab();
    if (disposition === "current" && active) this.loadUrl(active.id, url);
    else this.createTab(url, { activate: disposition !== "background-tab", ...(active ? { openerId: active.id } : {}) });
  }

  /** The proxy a tab goes through (its profile's, its container's, or a site rule's), if any. */
  private connectionBadge(tab: TabRuntime | undefined): ConnectionBadge | null {
    const wc = tab && pageOf(tab.view);
    if (!tab || !wc) return null;
    const config = this.profile.connections.config();
    const base = this.profile.choiceFor(wc.session);
    let host = "";
    try {
      host = new URL(tab.url).hostname;
    } catch {
      // not a web page
    }
    const rule = host !== "" && config.rules.some((r) => matchesPattern(host, r.pattern));
    const route = host ? routeFor(host, base, config.rules) : base;
    if (route.mode !== "proxy") return null;
    const proxy = config.proxies.find((p) => p.id === route.proxyId);
    return { name: proxy?.name ?? "?", rule };
  }

  /** A new window of the same kind (private from a private window). */
  openInNewWindow(url: string): void {
    if (this.isPrivate) this.ctx.windows.openPrivate(this.profile.profile.id, [url]);
    else this.ctx.windows.open(this.profile.profile.id, [url]);
  }

  /** Activate an existing tab showing this internal page, or open it. */
  openSingleton(url: string): void {
    const page = internalPageOf(url);
    for (const t of this.strip.tabs) {
      const tab = this.tabs.get(t.id);
      if (tab && page && internalPageOf(tab.url) === page) {
        // The page is open: go to the section asked for (corvus://settings/#dictation) in it.
        if (url.includes("#") && !tab.view.webContents.isDestroyed() && tab.view.webContents.getURL() !== url) this.loadUrl(t.id, url);
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
    if (tab?.certError) return this.loadUrl(tab.id, tab.certError.url);
    if (tab?.pendingUrl) return this.loadPending(tab);
    const wc = tab?.view.webContents;
    if (!wc) return;
    // A page a form sent (POST, as after many "checking your browser" pages) does not reload:
    // Chromium waits for a "resubmit the form?" answer Electron never asks. When nothing starts
    // loading, the address is opened again instead, as Enter in the address bar does.
    const url = wc.getURL();
    let started = false;
    const onStart = (): void => {
      started = true;
    };
    wc.once("did-start-loading", onStart);
    if (hard) wc.reloadIgnoringCache();
    else wc.reload();
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      wc.removeListener("did-start-loading", onStart);
      if (!started && !wc.isLoading() && wc.getURL() === url && /^https?:/i.test(url)) {
        wc.loadURL(url).catch(() => {
          // Load failures surface through did-fail-load.
        });
      }
    }, RELOAD_FALLBACK_MS);
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

  /**
   * "Send to your phone…": the page as a QR code to scan, to the phones paired with this profile's
   * sync, and to Telegram when a chat is linked.
   */
  async shareToPhone(url: string, title: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    const { encodeQR } = await import("qr");
    const qrSvg = encodeQR(url, "svg", { border: 2 });
    this.sendCommand({ type: "open-share", share: { url, title, qrSvg, telegram: this.ctx.telegram.status().linked, phones: this.ctx.sync.phones(this.profile) } });
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

  /** An agent run works in this group (its chip shows it) or has finished there. */
  setAgentGroup(groupId: GroupId, working: boolean): void {
    if (working === this.agentGroups.has(groupId)) return;
    if (working) this.agentGroups.add(groupId);
    else this.agentGroups.delete(groupId);
    this.pushState();
  }

  // ---------------------------------------------------------------- commands

  private onInput(event: Electron.Event, input: Input): void {
    const command = commandForInput(input, process.platform);
    if (command) {
      event.preventDefault();
      this.runCommand(command);
      return;
    }
    // Then extension shortcuts (chrome.commands), which never take one of Corvus's own.
    const hit = this.profile.extensions.commandForInput(input);
    if (!hit) return;
    event.preventDefault();
    this.runExtensionCommand(hit.extensionId, hit.name);
  }

  /** An extension's shortcut: its toolbar button for _execute_action, else commands.onCommand. */
  private runExtensionCommand(extensionId: string, name: string): void {
    if (ACTION_COMMANDS.has(name)) {
      this.sendCommand({ type: "activate-extension", extensionId });
      return;
    }
    const active = this.activeTab();
    const tab = active
      ? {
          id: active.view.webContents.id,
          index: this.tabIds().indexOf(active.id),
          windowId: this.win.id,
          url: active.url,
          title: active.title,
          active: true,
          highlighted: true,
          pinned: this.isPinned(active.id),
          incognito: false,
        }
      : undefined;
    this.profile.extensions.sendTo(extensionId, "commands.onCommand", name, tab);
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
      case "new-private-window":
        this.ctx.windows.openPrivate(this.profile.profile.id);
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
      case "voice-command":
        if (!this.ctx.dictation.ready()) {
          this.openSingleton("corvus://settings/#dictation");
          break;
        }
        this.focusWebContents(this.chrome.webContents);
        this.sendCommand({ type: "open-command-palette", listen: true });
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
    // The certificate error page stands in for the site: its information is the site's.
    const url = tab.certError ? tab.url : tab.view.webContents.getURL() || tab.url;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const scheme = parsed.protocol === "https:" ? "https" : parsed.protocol === "http:" ? "http" : parsed.protocol === "file:" ? "file" : "other";
    const view = this.profile.permissions.siteView(tab.view.webContents, url);
    const certError = this.certErrorOf(tab);
    return {
      origin: view.origin,
      host: parsed.host || parsed.protocol.replace(/:$/, ""),
      scheme,
      secure: view.secure,
      agent: tab.agentControlled,
      permissions: view.permissions,
      zoomPercent: zoomPercent(tab.view.webContents.getZoomFactor()),
      ...(certError ? { certError, certAccepted: !tab.certError } : {}),
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
    this.ctx.dialogs.forget(this);
    if (this.disposed) return;
    this.disposed = true;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.teardownSplit();
    for (const cleanup of this.cleanups) cleanup();
    for (const tab of this.tabs.values()) {
      this.clearUnresponsive(tab);
      pageOf(tab.view)?.close();
    }
    this.tabs.clear();
    this.ctx.assist.disposeWindow(this);
    this.ctx.reader.disposeWindow(this);
    if (!this.chrome.webContents.isDestroyed()) this.chrome.webContents.close();
    this.ctx.windows.removed(this);
  }
}
