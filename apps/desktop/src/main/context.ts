import type { BrowserController } from "@corvus/shared";
import type { AdblockService } from "./adblock";
import type { AgentActivityService } from "./agent-activity-service";
import type { AgentCredentialService } from "./agent-credentials";
import type { AgentRunner } from "./agent-runner";
import type { AnnotationService } from "./annotation-service";
import type { AssistService } from "./assist-service";
import type { TranslateService } from "./translate-service";
import type { AutofillService } from "./autofill-service";
import type { CrashReporter } from "./crash-log";
import type { DownloadManager } from "./downloads";
import type { FlowService } from "./flow-service";
import type { KeePassService } from "./keepass-service";
import type { SecretFillGuard } from "./secret-fill-guard";
import type { SpendApprovalService } from "./spend-approvals";
import type { McpService } from "./mcp-service";
import type { PageMonitor } from "./page-monitor";
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

/** Main-process services, wired together once in index.ts. */
export interface AppContext {
  settings: SettingsStore;
  profiles: ProfileRegistry;
  windows: WindowManager;
  search: SearchService;
  semanticSearch: SemanticSearchService;
  controller: BrowserController;
  mcp: McpService;
  sync: SyncService;
  updater: UpdateService;
  downloads: DownloadManager;
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
  adblock: AdblockService;
  webscope: WebScopeService;
  monitor: PageMonitor;
  /** The New Tab dashboard of each profile. */
  newtab: NewTabService;
  scheduledAgents: ScheduledAgentRunner;
  flows: FlowService;
  autofill: AutofillService;
  /** KeePass auto-lock and kept-unlocked restore across profiles. */
  keepass: KeePassService;
  /** Tabs where a saved secret was filled: script access is refused until they navigate. */
  secretFills: SecretFillGuard;
  annotations: AnnotationService;
  crashReporter: CrashReporter;
}
