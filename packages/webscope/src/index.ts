/**
 * @corvus/webscope — web-traffic security/diagnostics engine for authorized testing of your own or
 * explicitly permitted targets. Scope is enforced on every outbound action by the engine itself.
 */
export * from "./types.js";
export { WebScopeEngine, ScopeError, BlockedError } from "./engine.js";
export type { WebScopeEngineOptions } from "./engine.js";

export { emptyScope, isInScope, scopeRejectionReason, normalizeHost, parseTarget, scopeEntry } from "./scope.js";
export type { ParsedTarget } from "./scope.js";

export { emptyRuleSet, applyRequestRules, applyResponseRules, isBlocked, resolveOverride } from "./rules.js";
export type { AppliedRequest } from "./rules.js";

export { HistoryBuffer, summarize, matchesFilter } from "./history.js";
export { AuditLog } from "./audit.js";
export { CaptureEngine } from "./capture.js";
export { InterceptEngine } from "./intercept.js";
export { scanFindings, buildSitemap } from "./findings.js";
export type { Finding, FindingSeverity, SitemapNode } from "./findings.js";
export type { InterceptEngineOptions } from "./intercept.js";
export type { CaptureOptions } from "./capture.js";

export { sendRequest } from "./http-client.js";
export type { SendOptions, SendResult } from "./http-client.js";

export {
  runFuzz,
  planRequests,
  parseTemplate,
  expandPayloadSet,
  processPayload,
  fuzzResultsToCsv,
  clampRate,
  clampConcurrency,
  RateLimiter,
  FuzzScopeError,
  FuzzLimitError,
  SAFE_MAX_RPS,
  SAFE_MAX_CONCURRENCY,
  HARD_MAX_REQUESTS,
  DEFAULT_RPS,
} from "./fuzzer.js";
export type { PlannedRequest, RunFuzzDeps } from "./fuzzer.js";

export { compareResponses, diffLines } from "./compare.js";
export { exportHar, importHar } from "./har.js";
export type { ImportOptions } from "./har.js";

export { encode, hash, jwtDecode, htmlEncode, htmlDecode } from "./encoders.js";
