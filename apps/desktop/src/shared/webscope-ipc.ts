/**
 * IPC contract for the corvus://webscope security workbench. Merged into InternalRpc and
 * InternalEvent in ./ipc.ts. All types come from @corvus/webscope so the renderer and the engine stay
 * in lockstep.
 */
import type {
  AuditEntry,
  EncoderOp,
  FuzzResultRow,
  FuzzSummary,
  Finding,
  FuzzerConfig,
  HashAlg,
  HistoryCursor,
  HistoryEntry,
  HistoryFilter,
  HistoryPage,
  HistorySummary,
  InterceptConfig,
  InterceptEdit,
  InterceptItem,
  JwtParts,
  OutboundRequest,
  ResponseComparison,
  SitemapNode,
  RuleSet,
  Scope,
} from "@corvus/webscope";
import type { WebScopeTopic } from "./webscope-live";

/** The figures in the command bar and the Intercept tab badge. */
export interface WebScopeCounters {
  enabled: boolean;
  historySize: number;
  attachedTabs: number;
  /** Requests and responses held by Intercept right now. */
  held: number;
}

export interface WebScopeState extends WebScopeCounters {
  scope: Scope;
  rules: RuleSet;
}

/** Pushed to open WebScope pages a few times a second at most while anything changes. */
export interface WebScopeInternalEvent {
  type: "webscope-changed";
  topics: WebScopeTopic[];
  counters: WebScopeCounters;
}

export interface WebScopeRpc {
  "webscope.state"(): WebScopeState;
  "webscope.setEnabled"(enabled: boolean): WebScopeState;
  "webscope.history"(filter: HistoryFilter, limit: number): HistorySummary[];
  "webscope.historyPage"(filter: HistoryFilter, since: HistoryCursor | null, limit: number): HistoryPage;
  "webscope.detail"(id: string): HistoryEntry | null;
  "webscope.clearHistory"(): void;
  "webscope.getScope"(): Scope;
  "webscope.setScope"(scope: Scope): Scope;
  "webscope.getRules"(): RuleSet;
  "webscope.setRules"(rules: RuleSet): RuleSet;
  "webscope.send"(request: OutboundRequest): HistoryEntry;
  "webscope.fuzz"(config: FuzzerConfig): { rows: FuzzResultRow[]; summary: FuzzSummary };
  "webscope.compare"(idA: string, idB: string): ResponseComparison;
  "webscope.exportHar"(ids: string[] | null): unknown;
  "webscope.importHar"(json: unknown): number;
  "webscope.exportSession"(includeHistory: boolean): unknown;
  "webscope.importSession"(json: unknown): { history: number };
  "webscope.audit"(limit: number): AuditEntry[];
  "webscope.encode"(op: EncoderOp, input: string): string;
  "webscope.hash"(alg: HashAlg, input: string): string;
  "webscope.jwt"(token: string): JwtParts;
  "webscope.interceptState"(): WebScopeInterceptState;
  "webscope.setInterceptConfig"(config: InterceptConfig): WebScopeInterceptState;
  "webscope.interceptForward"(id: string, edit: InterceptEdit | null): WebScopeInterceptState;
  "webscope.interceptDrop"(id: string): WebScopeInterceptState;
  "webscope.findings"(): Finding[];
  "webscope.sitemap"(): SitemapNode[];
}

export interface WebScopeInterceptState {
  config: InterceptConfig;
  queue: InterceptItem[];
}
