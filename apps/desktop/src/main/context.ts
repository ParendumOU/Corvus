import type { AdblockService } from "./adblock";
import type { AgentActivityService } from "./agent-activity-service";
import type { AgentCredentialService } from "./agent-credentials";
import type { AgentRunner } from "./agent-runner";
import type { AnnotationService } from "./annotation-service";
import type { AssistService } from "./assist-service";
import type { TranslateService } from "./translate-service";
import type { TabSleeper } from "./tab-sleeper";
import type { AutofillService } from "./autofill-service";
import type { CertErrorService } from "./cert-errors";
import type { ExternalAppService } from "./external-apps";
import type { HttpAuthService } from "./http-auth";
import type { Controller } from "./controller";
import type { CrashReporter } from "./crash-log";
import type { DownloadManager } from "./downloads";
import type { BackupReminder } from "./backup-reminder";
import type { DefaultBrowser } from "./default-browser";
import type { BrowserImport } from "./browser-import";
import type { LiveHistoryService } from "./live-history";
import type { DownloadQueue } from "./download-queue";
import type { LinkGrabber } from "./link-grabber";
import type { FlowService } from "./flow-service";
import type { KeePassService } from "./keepass-service";
import type { SecretFillGuard } from "./secret-fill-guard";
import type { SpendApprovalService } from "./spend-approvals";
import type { UserActionService } from "./user-actions";
import type { McpService } from "./mcp-service";
import type { PageMonitor } from "./page-monitor";
import type { PasswordCheckupService } from "./password-checkup";
import type { TelegramLink } from "./telegram-link";
import type { ProfileRegistry } from "./profiles";
import type { ReaderService } from "./reader-service";
import type { ScheduledAgentRunner } from "./scheduled-agent-runner";
import type { SearchService } from "./search-service";
import type { SemanticSearchService } from "./semantic-search-service";
import type { SessionRestore } from "./session-restore";
import type { SettingsStore } from "./settings-store";
import type { SyncService } from "./sync-service";
import type { UpdateService } from "./update-service";
import type { WebScopeService } from "./webscope-service";
import type { WindowManager } from "./window-manager";
import type { NewTabService } from "./newtab-service";
import type { DictationService } from "./dictation-service";
import type { DialogService } from "./dialogs";
import type { PageDialogs } from "./page-dialogs";

/** Main-process services, wired together once in index.ts. */
export interface AppContext {
  settings: SettingsStore;
  profiles: ProfileRegistry;
  dictation: DictationService;
  /** Corvus's modal dialogs (main/dialogs.ts). */
  dialogs: DialogService;
  /** Pages' alert(), confirm() and prompt() in every tab (main/page-dialogs.ts). */
  pageDialogs: PageDialogs;
  windows: WindowManager;
  search: SearchService;
  semanticSearch: SemanticSearchService;
  controller: Controller;
  /** Pages whose certificate fails: the interstitial, and certificates accepted for this session. */
  certErrors: CertErrorService;
  /** Links that open another app on this computer ("Open <app>?"). */
  externalApps: ExternalAppService;
  /** Sites that ask for a username and password (HTTP sign-in dialog). */
  httpAuth: HttpAuthService;
  mcp: McpService;
  sync: SyncService;
  updater: UpdateService;
  downloads: DownloadManager;
  /** Download links collected from pages and copied text, waiting to be downloaded. */
  grabber: LinkGrabber;
  /** Corvus as the default browser: status, "Make default", and the once-per-launch offer. */
  defaultBrowser: DefaultBrowser;
  /** The once-per-launch reminder to back up the saved logins and 2FA codes. */
  backupReminder: BackupReminder;
  /** Corvus's own download queue (packages from the link grabber). */
  queue: DownloadQueue;
  /** Bookmarks and history from the other browsers installed here. */
  browserImport: BrowserImport;
  /** History read live from the other browsers a profile follows (local only). */
  liveHistory: LiveHistoryService;
  sessionRestore: SessionRestore;
  assist: AssistService;
  /** Page translation from the address bar. */
  translate: TranslateService;
  reader: ReaderService;
  agents: AgentActivityService;
  agentRunner: AgentRunner;
  /** Agent use of opted-in saved logins and 2FA codes (fill by reference, approval-gated). */
  agentCredentials: AgentCredentialService;
  /** Native "Allow once / Deny" prompt for MCP clients that want to spend money. */
  spendApprovals: SpendApprovalService;
  /** Native "Done / Cancel" request when an MCP client asks the person to do a step (request_user_action). */
  userActions: UserActionService;
  adblock: AdblockService;
  webscope: WebScopeService;
  monitor: PageMonitor;
  /** The New Tab dashboard of each profile. */
  newtab: NewTabService;
  scheduledAgents: ScheduledAgentRunner;
  flows: FlowService;
  autofill: AutofillService;
  /** Breached, reused and weak saved passwords (corvus://passwords, on request). */
  passwordCheckup: PasswordCheckupService;
  /** "Send to your phone" through the person's own Telegram bot, and links back from it. */
  telegram: TelegramLink;
  /** KeePass auto-lock and kept-unlocked restore across profiles. */
  keepass: KeePassService;
  /** Tabs where a saved secret was filled: script access is refused until they navigate. */
  secretFills: SecretFillGuard;
  annotations: AnnotationService;
  crashReporter: CrashReporter;
  /** Puts background tabs to sleep and keeps per-tab memory figures. */
  tabSleeper: TabSleeper;
}
