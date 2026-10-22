/**
 * IPC contract for the corvus://webscope security workbench. Merged into InternalRpc in ./ipc.ts.
 * All types come from @corvus/webscope so the renderer and the engine stay in lockstep.
 */
import type {
  AuditEntry,
  EncoderOp,
  FuzzResultRow,
  FuzzSummary,
  Finding,
  FuzzerConfig,
  HashAlg,
  HistoryEntry,
  HistoryFilter,
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

export interface WebScopeState {
  enabled: boolean;
  scope: Scope;
  rules: RuleSet;
  historySize: number;
  attachedTabs: number;
}

export interface WebScopeRpc {
  "webscope.state"(): WebScopeState;
  "webscope.setEnabled"(enabled: boolean): WebScopeState;
  "webscope.history"(filter: HistoryFilter, limit: number): HistorySummary[];
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
