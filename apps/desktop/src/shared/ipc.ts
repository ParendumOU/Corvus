/**
 * Typed IPC contracts between the main process and the two trusted renderers:
 *   - the browser chrome UI (tab strip, toolbar)   -> window.corvus
 *   - internal pages served from corvus://         -> window.corvusInternal
 * Each side uses a single RPC channel; the main process validates the sender and the method.
 * Web content never gets either API.
 */
import type { ImportKind, ImportResult, ImportScan } from "./browser-import";
import type { AccessLevel, Bookmark, DeviceInfo, GroupColor, GroupId, LocalModelApi, Profile, SearchCategory, SearchEvent, Tab, TabGroup, TabId } from "@corvus/shared";
import type { AdblockBarState, AdblockOptions, AdblockView } from "./adblock";
import type { TranslateBarState } from "./translate";
import type { Container, TabContainer } from "./containers";
import type { ConnectionChoice, ConnectionsConfig, ProxyKind, SiteRule } from "./connections";
import type { TelegramConnectResult, TelegramStatus } from "./phone-share";
import type { AnnotationLibraryRpc } from "./annotations-ipc";
import type { AgentRunsInternalEvent, AgentRunsInternalRpc } from "./agent-run-ipc";
import type { AssistChromeCommand, AssistChromeRpc, AssistWindowExtras } from "./assist-ipc";
import type { CommandBarChromeRpc, CommandBarWindowExtras } from "./command-bar-ipc";
import type { FlowChromeRpc, FlowInternalEvent, FlowInternalRpc } from "./flow-ipc";
import type { AutofillBarState, AutofillChromeRpc, CredentialsRpc } from "./credentials-ipc";
import type { KeePassRpc } from "./keepass-ipc";
import type { ExtensionSuggestion } from "./extension-suggestions";
import type { SyncConflictView } from "./sync-conflicts";
import type { BrowserChromeCommand, BrowserChromeRpc, BrowserInternalEvent, BrowserInternalRpc, BrowserWindowExtras } from "./browser-ipc";
import type { HistoryRecord } from "./history-ops";
import type { RemoteDeviceTabs } from "./open-tabs";
import type { NewTabInternalEvent, NewTabRpc } from "./newtab-ipc";
import type { ReaderChromeRpc, ReadingLibraryRpc } from "./reader-ipc";
import type { ScheduleInternalEvent, ScheduleInternalRpc } from "./schedule-ipc";
import type { SiteProfileInternalEvent, SiteProfileInternalRpc } from "./site-profile-ipc";
import type { SiteSearch } from "./site-search";
import type { SemanticSearchChromeRpc, SemanticSearchInternalRpc } from "./semantic-search-ipc";
import type { PdfRpc } from "./pdf-ipc";
import type { Suggestion } from "./suggest";
import type { SecretKey, SettingsPatch, SettingsView, TabLayout, UpdateChannel } from "./settings";
import type { SplitState } from "./split";
import type { GroupPatch } from "./tab-strip";
import type { WatchBarState, WatchChromeRpc, WatchInternalEvent, WatchInternalRpc } from "./watch-ipc";
import type { WorkspaceChromeRpc } from "./workspace-ipc";
import type { WebScopeRpc } from "./webscope-ipc";

export const CHROME_RPC = "corvus:chrome-rpc";
export const CHROME_EVENT = "corvus:chrome-event";
export const INTERNAL_RPC = "corvus:internal-rpc";
export const INTERNAL_EVENT = "corvus:internal-event";

export interface TabView extends Tab {
  canGoBack: boolean;
  canGoForward: boolean;
  webContentsId: number;
  crashed: boolean;
  audible: boolean;
  /** Asleep to save memory; it wakes up where it was when shown. */
  sleeping?: boolean;
  /** Memory of the page's renderer process, in KB (shared by the tabs of one site). */
  memoryKB?: number;
  /** One of the panes of the window's split (shown together when any of them is active). */
  inSplit?: boolean;
  /** The container it runs in (its own cookies and site data). */
  container?: TabContainer;
}

export interface WindowState extends BrowserWindowExtras, AssistWindowExtras, CommandBarWindowExtras {
  windowId: string;
  platform: string;
  profile: Profile;
  profiles: Profile[];
  partition: string;
  /** A private window: nothing of it is kept once it closes. */
  privateWindow: boolean;
  /** Maximized or full screen: the tabs reach the top edge of the screen. */
  maximized: boolean;
  /** The proxy the active tab goes through, when it goes through one. */
  connection: ConnectionBadge | null;
  tabs: TabView[];
  groups: TabGroup[];
  /** Groups an agent run is working in right now (their chip shows it). */
  agentGroups: GroupId[];
  activeTabId: TabId | null;
  activeBookmarked: boolean;
  bookmarksBar: Bookmark[];
  showBookmarksBar: boolean;
  showHomeButton: boolean;
  dark: boolean;
  mcpRunning: boolean;
  adblock: AdblockBarState;
  tabLayout: TabLayout;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  watches: WatchBarState;
  /** The active tab is an article worth a reader view. */
  readerable: boolean;
  /** Reader mode is on for the active tab. */
  readerActive: boolean;
  /** The active tab's translate button (offered, translating, translated), or null when hidden. */
  translate: TranslateBarState | null;
  /** Autofill availability and pending-save state for the active tab. */
  autofill: AutofillBarState;
  /** Two tabs tiled side by side, or null when the window shows a single tab. */
  split: SplitState | null;
}

export type ChromeCommand =
  | { type: "focus-omnibox"; selectAll: boolean }
  | { type: "close-overlays" }
  | { type: "open-command-palette" }
  | { type: "edit-group"; groupId: GroupId }
  | { type: "open-workspaces" }
  | BrowserChromeCommand
  | AssistChromeCommand
  | { type: "extensions-changed" }
  /** An extension's _execute_action shortcut: open its toolbar button (popup or onClicked). */
  | { type: "activate-extension"; extensionId: string };

export interface ChromeRpc extends BrowserChromeRpc, AssistChromeRpc, WorkspaceChromeRpc, WatchChromeRpc, ReaderChromeRpc, CommandBarChromeRpc, AutofillChromeRpc, SemanticSearchChromeRpc, FlowChromeRpc {
  "ui.setTabLayout"(layout: TabLayout): void;
  "ui.setSidebarWidth"(width: number): void;
  "ui.setSidebarCollapsed"(collapsed: boolean): void;
  "state.get"(): WindowState;
  "ui.setChromeHeight"(height: number): void;
  "ui.setOverlay"(open: boolean): void;
  "ui.appMenu"(x: number, y: number): void;
  "ui.profileMenu"(x: number, y: number): void;
  /** The connection chip's menu: how the active tab's profile or container connects. */
  "ui.connectionMenu"(x: number, y: number): void;
  "ui.tabMenu"(tabId: TabId, x: number, y: number): void;
  "ui.groupMenu"(groupId: GroupId, x: number, y: number): void;
  "ui.bookmarkFolderMenu"(folderId: string, x: number, y: number): void;
  "ui.bookmarkMenu"(bookmarkId: string, x: number, y: number): void;
  "ui.focusContent"(): void;
  "tabs.create"(opts?: { url?: string; groupId?: GroupId; background?: boolean }): TabId;
  "tabs.close"(tabId: TabId): void;
  "tabs.activate"(tabId: TabId): void;
  "tabs.move"(tabId: TabId, toIndex: number, groupId: GroupId | null): void;
  "tabs.pin"(tabId: TabId, pinned: boolean): void;
  "tabs.navigate"(tabId: TabId, input: string): void;
  "tabs.openUrl"(url: string, disposition: "current" | "new-tab" | "background-tab"): void;
  "tabs.back"(tabId: TabId): void;
  "tabs.forward"(tabId: TabId): void;
  "tabs.reload"(tabId: TabId): void;
  /** Opens the home page in the tab, or in a new tab. */
  "tabs.home"(tabId: TabId, inNewTab: boolean): void;
  "tabs.stop"(tabId: TabId): void;
  "tabs.reopenClosed"(): void;
  "groups.create"(tabIds: TabId[]): GroupId | null;
  "groups.update"(groupId: GroupId, patch: GroupPatch): void;
  "groups.ungroup"(groupId: GroupId): void;
  "groups.close"(groupId: GroupId): void;
  "groups.move"(groupId: GroupId, toIndex: number): void;
  "groups.newTab"(groupId: GroupId): void;
  "omnibox.suggest"(input: string): Suggestion[];
  "bookmarks.toggleActive"(): boolean;
  /** A page dropped on the bookmarks bar (the address bar's site chip, or a link), at `index`. */
  "bookmarks.addToBar"(url: string, title: string, index: number): boolean;
  "profiles.openWindow"(profileId: string): void;
  "extensions.toolbar"(): ToolbarExtension[];
  "extensions.setPinned"(id: string, pinned: boolean): void;
  "extensions.menu"(id: string, x: number, y: number): void;
  "adblock.setEnabled"(enabled: boolean): void;
  "adblock.pauseSite"(paused: boolean): void;
  /** The shield on YouTube while ads are being skipped: remove them again. */
  "adblock.youtubeBlockAgain"(): void;
  /** The shield's "Forget this site when I close it", for the active tab's site. */
  "adblock.forgetOnClose"(forget: boolean): void;
  /** "Hide an element" from the shield: the picker runs in the active tab's page. */
  "adblock.pickElement"(): void;
  /** The address bar's translate button: translate the page, or show its original again. */
  "translate.toggle"(): void;
  "split.with"(tabId: TabId): void;
  "split.focus"(tabId: TabId): void;
  "split.exit"(): void;
}

export interface ExtensionError {
  message: string;
  source: string;
  at: number;
}

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  source: "webstore" | "unpacked";
  path: string;
  iconUrl: string;
  enabled: boolean;
  pinned: boolean;
  hasAction: boolean;
  manifestVersion: number;
  permissions: string[];
  hostPermissions: string[];
  /** Chrome-style permission warnings. */
  warnings: string[];
  /** Declared API permissions Corvus does not implement. */
  unsupported: string[];
  optionsUrl: string | null;
  homepageUrl: string | null;
  storeUrl: string | null;
  errors: ExtensionError[];
}

/** An extension as shown in the toolbar and the extensions (puzzle) menu. */
export interface ToolbarExtension {
  id: string;
  name: string;
  iconUrl: string;
  pinned: boolean;
  hasAction: boolean;
  hasOptions: boolean;
}

export interface McpStatus {
  available: boolean;
  enabled: boolean;
  running: boolean;
  port: number | null;
  url: string | null;
  token: string;
  command: string | null;
  error: string | null;
  /** Effective access level agents run at (folds in the legacy allowEvaluate switch). */
  accessLevel: AccessLevel;
  /** Bind interface: "127.0.0.1" (loopback) or "0.0.0.0" (all interfaces / remote). */
  host: string;
  /** True when bound to all interfaces, i.e. reachable by remote MCP clients. */
  remote: boolean;
  /** First non-internal IPv4 of this machine, for the remote connect hint; null if none/loopback. */
  lanAddress: string | null;
}

export type McpActivityOutcome = "ok" | "error" | "rate-limited";

/** One MCP tool call in the activity log: never its arguments, what was typed or page content. */
export interface McpActivityEntry {
  at: number;
  client: string;
  tool: string;
  /** Host of the page the call was about ("" for calls about no page). */
  host: string;
  outcome: McpActivityOutcome;
  durationMs: number;
  /** The tool's own error message, clipped (errors and rate-limited calls). */
  error?: string;
}

export interface McpToolSummary {
  tool: string;
  calls: number;
  errors: number;
  /** Calls refused by the rate limit. */
  rateLimited: number;
  avgMs: number;
}

export interface McpActivityQuery {
  limit?: number;
  client?: string;
  /** Only calls that failed or hit the rate limit. */
  problemsOnly?: boolean;
}

export interface McpActivityView {
  /** False when Settings > AI agents > Activity log is off (nothing new is recorded). */
  enabled: boolean;
  entries: McpActivityEntry[];
  clients: string[];
  /** Per tool over the last 24 hours. */
  summary: McpToolSummary[];
}

/** Lifecycle of an electron-updater check/download. */
export type UpdatePhase = "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";

export interface UpdateStatus {
  /** electron-updater can run here (a packaged install). False when running from source. */
  supported: boolean;
  /** Why updates are unavailable, when they are. */
  reason: string | null;
  phase: UpdatePhase;
  currentVersion: string;
  channel: UpdateChannel;
  /** Effective feed URL in use (configured value or the baked default). */
  feedUrl: string;
  /** Version offered by the feed, when an update is available or downloaded. */
  newVersion: string | null;
  /** Download progress 0–100 while downloading, else null. */
  percent: number | null;
  releaseNotes: string | null;
  /** Last check time (epoch ms), null if never checked this session. */
  checkedAt: number | null;
  error: string | null;
  /** The Windows portable build: updates replace its own file. */
  portable?: boolean;
}

export interface SyncStatus {
  available: boolean;
  enabled: boolean;
  serverUrl: string;
  deviceName: string;
  chainId: string | null;
  lastSyncAt: number | null;
  error: string | null;
  /** This device's id on the chain (null until sync has started on this profile). */
  deviceId: string | null;
  syncing: boolean;
  intervalMinutes: number;
  /** Opt-in: also sync machine-specific service URLs (SearXNG). */
  syncServiceUrls: boolean;
  /** Sync saved workflows (per device, default on). */
  syncWorkflows: boolean;
  /** Sync what Corvus learned about sites (per device, default on). */
  syncSiteMemory: boolean;
  /** Sync what was run from the Command Bar (per device, default on). */
  syncCommandHistory: boolean;
  /** Sync Assist conversations (per device, default on). */
  syncAssistHistory: boolean;
  /** This device's changes a newer change from another device replaced (Settings > Sync). */
  conflicts: number;
}

export const SYNC_INTERVALS_MINUTES = [1, 5, 15, 30, 60] as const;

export interface SyncDeviceView extends DeviceInfo {
  current: boolean;
}

export interface SyncOptions {
  intervalMinutes?: number;
  syncServiceUrls?: boolean;
  syncWorkflows?: boolean;
  syncSiteMemory?: boolean;
  syncCommandHistory?: boolean;
  syncAssistHistory?: boolean;
}

export interface EngineInfo {
  available: boolean;
  provider: string;
  model: string;
  retriever: string;
  reason: string | null;
}

/** Result of probing the configured AI provider (Settings "Test connection"). */
export interface ConnectionTestResult {
  ok: boolean;
  /** Human-readable summary for the Settings UI. */
  detail: string;
  /** Local provider: models the server offers. */
  models?: string[];
  /** Local provider: whether the configured model is among them. */
  modelPresent?: boolean;
  /** Local provider: whether the model does native tool calls (agent mode). */
  supportsTools?: boolean;
}

/** A model server found running on this computer (Ollama, LM Studio, llama.cpp). */
export interface LocalServerInfo {
  name: string;
  api: LocalModelApi;
  baseUrl: string;
  models: string[];
}

/** A streamed search event, or the end-of-stream marker sent once the engine is done. */
export type SearchEventMessage = { searchId: string; event: SearchEvent } | { searchId: string; done: true };

export interface InternalRpc extends BrowserInternalRpc, WebScopeRpc, WatchInternalRpc, ScheduleInternalRpc, SiteProfileInternalRpc, AgentRunsInternalRpc, ReadingLibraryRpc, CredentialsRpc, KeePassRpc, PdfRpc, SemanticSearchInternalRpc, FlowInternalRpc, AnnotationLibraryRpc, NewTabRpc {
  "search.start"(query: string, opts: { depth?: "quick" | "deep"; category?: SearchCategory }): string;
  /** data: URLs of result-site favicons (null when unavailable), fetched cookie-less by the main process. */
  "search.favicons"(domains: string[]): Record<string, string | null>;
  "search.cancel"(searchId: string): void;
  "search.engineInfo"(): EngineInfo;
  "bookmarks.list"(): Bookmark[];
  "bookmarks.create"(node: { parentId: string; kind: Bookmark["kind"]; title: string; url?: string; index?: number }): Bookmark;
  "bookmarks.update"(id: string, patch: { title?: string; url?: string }): void;
  "bookmarks.move"(id: string, parentId: string, index?: number): void;
  "bookmarks.remove"(id: string): void;
  "history.query"(query: string, offset: number, limit: number): { entries: HistoryRecord[]; total: number };
  "history.remove"(ids: string[]): void;
  "history.clear"(): void;
  "settings.get"(): SettingsView;
  "settings.update"(patch: SettingsPatch): SettingsView;
  "settings.setSecret"(key: SecretKey, value: string): SettingsView;
  /** Probe the configured AI provider (currently the local model server). */
  "settings.testConnection"(): ConnectionTestResult;
  /** Model servers running on this computer on their default ports. */
  "settings.discoverLocal"(): LocalServerInfo[];
  /** The configured local server's models, or null when it does not answer. */
  "settings.localModels"(): string[] | null;
  "mcp.status"(): McpStatus;
  "mcp.regenerateToken"(): McpStatus;
  "mcp.activity"(query?: McpActivityQuery): McpActivityView;
  "mcp.activityClear"(): void;
  /** Saves the log as CSV where the person picks; false when cancelled. */
  "mcp.activityExport"(): boolean;
  "update.status"(): UpdateStatus;
  "update.check"(): UpdateStatus;
  "update.download"(): UpdateStatus;
  "update.install"(): void;
  "profiles.list"(): { profiles: Profile[]; current: string };
  "profiles.create"(name: string): Profile;
  "profiles.rename"(id: string, name: string): void;
  "profiles.remove"(id: string): void;
  /** Saves a profile as one password-protected file (asks where); false when cancelled. */
  "profiles.export"(id: string, password: string): boolean;
  /** Opens a profile file (asks which) with its password into a new profile; null when cancelled. */
  "profiles.import"(password: string): Profile | null;
  "profiles.openWindow"(id: string): void;
  "sync.status"(): SyncStatus;
  "sync.generatePhrase"(): string;
  "sync.enable"(opts: { serverUrl: string; phrase: string; deviceName: string }): SyncStatus;
  "sync.disable"(): SyncStatus;
  "sync.now"(): SyncStatus;
  "sync.setOptions"(opts: SyncOptions): SyncStatus;
  "sync.devices"(): SyncDeviceView[];
  "sync.removeDevice"(deviceId: string): SyncDeviceView[];
  "sync.renameDevice"(name: string): SyncDeviceView[];
  "sync.revealPhrase"(): string;
  /** "Pair a phone": the pairing code as text and QR (it holds the recovery phrase). */
  "sync.pairingCode"(): { code: string; qrSvg: string; serverUrl: string; reachableFromPhone: boolean };
  "sync.wipe"(confirmation: string): SyncStatus;
  "sync.remoteTabs"(): RemoteDeviceTabs[];
  "sync.extensionSuggestions"(): ExtensionSuggestion[];
  "sync.installExtension"(id: string): ExtensionSuggestion[];
  "sync.dismissExtension"(id: string): ExtensionSuggestion[];
  "sync.conflicts"(): SyncConflictView[];
  /** Forget this profile's Command Bar history (synced devices forget it too). */
  "commands.clear"(): void;
  /** "mine" brings this device's version back; "theirs" keeps the one in use. */
  "sync.resolveConflict"(id: string, keep: "mine" | "theirs"): SyncConflictView[];
  "extensions.list"(): ExtensionInfo[];
  "extensions.loadUnpacked"(): ExtensionInfo | null;
  "extensions.remove"(id: string): void;
  "extensions.installFromStore"(idOrUrl: string): ExtensionInfo | null;
  "extensions.setEnabled"(id: string, enabled: boolean): void;
  "extensions.setPinned"(id: string, pinned: boolean): void;
  "extensions.openOptions"(id: string): void;
  "extensions.checkUpdates"(): { checked: number; updated: string[] };
  "extensions.clearErrors"(id: string): void;
  "adblock.get"(): AdblockView;
  "adblock.setEnabled"(enabled: boolean): AdblockView;
  "adblock.removeAllowed"(host: string): AdblockView;
  "adblock.removeForgetSite"(site: string): AdblockView;
  /** "Send to your phone" through the person's own Telegram bot. */
  "phone.status"(): TelegramStatus;
  /** Saves a new bot token (when given) and links the private chat that sent /start to the bot. */
  "phone.connect"(token?: string): TelegramConnectResult;
  "phone.disconnect"(): TelegramStatus;
  /** Proxies and which one the profile, each container and each site rule use (passwords never leave main). */
  "connections.get"(): ConnectionsView;
  "connections.saveProxy"(input: ProxyInputView, id?: string): ConnectionsView;
  "connections.removeProxy"(id: string): ConnectionsView;
  "connections.setProfile"(choice: ConnectionChoice): ConnectionsView;
  "connections.setContainer"(containerId: string, choice: ConnectionChoice | null): ConnectionsView;
  "connections.setRules"(rules: SiteRule[]): ConnectionsView;
  "connections.setWebrtc"(on: boolean): ConnectionsView;
  /** The address sites see from the profile (or a container), from Cloudflare's trace page. */
  "connections.check"(containerId?: string): ConnectionCheck;
  /** Tries one proxy on its own. */
  "connections.test"(proxyId: string): ConnectionCheck;
  "containers.list"(): Container[];
  "containers.add"(name: string, color: GroupColor): Container[];
  "containers.update"(id: string, patch: { name?: string; color?: GroupColor }): Container[];
  /** Removes a container: its tabs close and its cookies and site data are deleted. */
  "containers.remove"(id: string): Container[];
  "adblock.update"(): AdblockView;
  "adblock.setOptions"(patch: Partial<AdblockOptions>): AdblockView;
  /** Replaces the profile's own filter list (one rule per line). */
  "adblock.setUserFilters"(text: string): AdblockView;
  "clipboard.write"(text: string): void;
  /** Reload the page that crashed in the calling tab (the recovery page calls this). */
  "crash.reload"(): void;
  /** Open the local crash-log folder in the OS file manager. Returns an error string or null. */
  "crashReports.openFolder"(): string | null;
  /** Opens the third-party licence notices shipped with the app; returns an error message or null. */
  "app.openThirdPartyNotices"(): string | null;
  /** Absolute path of the local crash-log folder (for display in settings). */
  "crashReports.logPath"(): string;
  /** First-run wizard: whether it has already been completed. */
  "onboarding.state"(): OnboardingState;
  /** First-run wizard: mark it finished (or skipped) so it never opens on startup again. */
  "onboarding.complete"(): OnboardingState;
  /** First-run wizard: pick a bookmarks export file (any browser's HTML, or Chrome/Edge JSON) and import it. */
  "onboarding.importBookmarks"(): BookmarkImportResult;
  /** Other browsers installed for this user, their profiles and what each holds. */
  "import.scan"(): ImportScan;
  /** Imports the chosen kinds of one browser profile into this Corvus profile. */
  "import.run"(sourceId: string, profileDir: string, kinds: ImportKind[]): ImportResult;
  /** Pick a password CSV the user exported from another browser and import the logins. */
  "import.passwordCsv"(): PasswordImportResult;
  /** Install an extension found in another browser from the Chrome Web Store (the user confirms). */
  "import.installExtension"(id: string): ExtensionInfo | null;
  /** Search shortcuts of this profile ("yt cats" in the address bar). */
  "siteSearch.list"(): SiteSearch[];
  /** Add a shortcut, or change the one with the same keyword. */
  "siteSearch.save"(shortcut: SiteSearch): SiteSearch[];
  "siteSearch.remove"(keyword: string): SiteSearch[];
}

export interface PasswordImportResult {
  imported: number;
  /** Logins already saved (same site and username). */
  duplicates: number;
  /** Rows with no usable site or password. */
  skipped: number;
  canceled: boolean;
}

export interface OnboardingState {
  completed: boolean;
}

export interface BookmarkImportResult {
  /** Bookmarks added. */
  imported: number;
  /** Folders created to hold them. */
  folders: number;
  /** User cancelled the file picker. */
  canceled: boolean;
  /** Short label of the chosen file, for the UI. */
  source: string | null;
}

export type InternalEvent =
  | { type: "search"; message: SearchEventMessage }
  | { type: "bookmarks-changed" }
  | { type: "settings-changed" }
  | { type: "update-changed"; status: UpdateStatus }
  | { type: "credentials-changed" }
  | { type: "keepass-changed" }
  | { type: "annotations-changed" }
  | BrowserInternalEvent
  | WatchInternalEvent
  | ScheduleInternalEvent
  | SiteProfileInternalEvent
  | AgentRunsInternalEvent
  | FlowInternalEvent
  | NewTabInternalEvent
  | { type: "extensions-changed" };

type Promisify<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

export type RpcClient<T> = <K extends keyof T>(method: K, ...args: Parameters<Promisify<T[K]>>) => ReturnType<Promisify<T[K]>>;

export interface ChromeBridge {
  call: RpcClient<ChromeRpc>;
  onState(listener: (state: WindowState) => void): () => void;
  onCommand(listener: (command: ChromeCommand) => void): () => void;
}

export interface InternalBridge {
  call: RpcClient<InternalRpc>;
  onEvent(listener: (event: InternalEvent) => void): () => void;
}

export type ChromeEventMessage = { kind: "state"; state: WindowState } | { kind: "command"; command: ChromeCommand };

export const GROUP_COLOR_HEX: Record<GroupColor, { light: string; dark: string }> = {
  grey: { light: "#5f6368", dark: "#dadce0" },
  blue: { light: "#1a73e8", dark: "#8ab4f8" },
  red: { light: "#d93025", dark: "#f28b82" },
  yellow: { light: "#f9ab00", dark: "#fdd663" },
  green: { light: "#188038", dark: "#81c995" },
  pink: { light: "#d01884", dark: "#ff8bcb" },
  purple: { light: "#9334e6", dark: "#c58af9" },
  cyan: { light: "#007b83", dark: "#78d9ec" },
  orange: { light: "#fa903e", dark: "#fcad70" },
};

export interface ConnectionsView {
  config: ConnectionsConfig;
  containers: Container[];
  /** Passwords are encrypted with the OS keychain (else kept until Corvus closes). */
  keychain: boolean;
}

/** A proxy as typed in Settings (password: new one, "" to forget, absent to keep). */
export interface ProxyInputView {
  name: string;
  kind: ProxyKind;
  host: string;
  port: number;
  pacUrl?: string;
  username?: string;
  password?: string;
}

export type ConnectionCheck = { ip: string; country?: string } | { error: string };

export interface ConnectionBadge {
  /** The proxy's name. */
  name: string;
  /** A site rule sends this site through it (not the profile's or container's own choice). */
  rule: boolean;
}
