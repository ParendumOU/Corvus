/**
 * Webscope domain model: captured HTTP traffic, scope, intercept queue, repeater, fuzzer and rules.
 *
 * Bodies are carried as UTF-8 strings when the content is textual, and as base64 (`bodyBase64`)
 * when it is binary, so an entry can always round-trip through JSON / HAR without loss.
 */

export interface HttpHeader {
  name: string;
  value: string;
}

// -------------------------------------------------------------------------- decoder (pure types)

export type EncoderOp =
  | "base64-encode"
  | "base64-decode"
  | "url-encode"
  | "url-decode"
  | "html-encode"
  | "html-decode"
  | "hex-encode"
  | "hex-decode";

export type HashAlg = "md5" | "sha1" | "sha256" | "sha512";

export interface JwtParts {
  header: unknown;
  payload: unknown;
  signature: string;
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: HttpHeader[];
  body?: string;
  /** When true, `body` is base64-encoded binary rather than UTF-8 text. */
  bodyBase64?: boolean;
}

export interface CapturedResponse {
  status: number;
  statusText?: string;
  headers: HttpHeader[];
  body?: string;
  bodyBase64?: boolean;
  mimeType?: string;
  /** Total response body size in bytes (may exceed the captured `body` when truncated). */
  size?: number;
}

export type ContentType =
  | "document"
  | "stylesheet"
  | "script"
  | "image"
  | "font"
  | "xhr"
  | "fetch"
  | "websocket"
  | "media"
  | "manifest"
  | "other";

export type HistorySource = "capture" | "repeater" | "fuzzer";

export interface HistoryEntry {
  id: string;
  profileId: string;
  startedAt: number;
  durationMs?: number;
  host: string;
  path: string;
  type: ContentType;
  inScope: boolean;
  source: HistorySource;
  request: CapturedRequest;
  response?: CapturedResponse;
  /** Set when the exchange failed before a response arrived. */
  error?: string;
  /**
   * Hidden from AI: the request came from a tab the browser had just filled a saved password or 2FA
   * code into, or it carries such a value. People see it in full; AI-facing reads get a redacted
   * copy (see ai-redact.ts).
   */
  aiHidden?: boolean;
}

/** Decides at capture time whether a request carries a secret the browser filled. */
export type SensitiveRequest = (request: CapturedRequest) => boolean;

/** Compact row shown in the history table / returned to MCP clients. */
export interface HistorySummary {
  id: string;
  method: string;
  host: string;
  path: string;
  status: number | null;
  type: ContentType;
  length: number;
  durationMs: number | null;
  startedAt: number;
  inScope: boolean;
  source: HistorySource;
  mimeType?: string;
  /** Shown in full to people; redacted for AI (see HistoryEntry.aiHidden). */
  aiHidden?: boolean;
}

export interface HistoryFilter {
  host?: string;
  method?: string;
  /** 1xx..5xx; e.g. 2 matches 200-299. */
  statusClass?: 1 | 2 | 3 | 4 | 5;
  type?: ContentType;
  /** Case-insensitive substring tested against URL, headers and body. */
  search?: string;
  onlyInScope?: boolean;
  source?: HistorySource;
}

// -------------------------------------------------------------------------- scope

/**
 * One scope entry. `host` is a glob (`*` matches any run of characters, including dots); an empty
 * host means "any host". `pathPrefix` restricts to URLs whose path starts with it (glob-aware).
 * `port` restricts to a specific port. Entries are matched case-insensitively.
 */
export interface ScopeEntry {
  host: string;
  pathPrefix?: string;
  port?: number;
  enabled: boolean;
}

export interface Scope {
  /** Master switch. When false, nothing is considered in scope (observe-only everywhere). */
  enabled: boolean;
  include: ScopeEntry[];
  exclude: ScopeEntry[];
}

// -------------------------------------------------------------------------- rules

export type MatchReplaceTarget =
  | "request-header"
  | "request-body"
  | "request-url"
  | "response-header"
  | "response-body";

export interface MatchReplaceRule {
  id: string;
  name: string;
  enabled: boolean;
  target: MatchReplaceTarget;
  /** Literal string, or a regular expression source when `regex` is true. */
  match: string;
  replace: string;
  regex: boolean;
}

export interface BlockRule {
  id: string;
  name: string;
  enabled: boolean;
  /** URL glob (`*` wildcard). Matching in-scope requests are blocked. */
  pattern: string;
}

export interface HostOverride {
  id: string;
  enabled: boolean;
  host: string;
  /** IP address or hostname to resolve `host` to. */
  address: string;
}

export interface RuleSet {
  matchReplace: MatchReplaceRule[];
  block: BlockRule[];
  hostOverride: HostOverride[];
}

// -------------------------------------------------------------------------- intercept

export type InterceptPhase = "request" | "response";

export interface InterceptItem {
  id: string;
  phase: InterceptPhase;
  host: string;
  path: string;
  request: CapturedRequest;
  response?: CapturedResponse;
  createdAt: number;
  /** Shown in full to people; redacted for AI (see HistoryEntry.aiHidden). */
  aiHidden?: boolean;
}

export interface InterceptConfig {
  enabled: boolean;
  interceptRequests: boolean;
  interceptResponses: boolean;
  /** Optional filters; a paused exchange is held only when every set filter matches (case-insensitive substring / exact method). */
  match?: InterceptMatch;
}

export interface InterceptMatch {
  /** Substring the host must contain. */
  host?: string;
  /** Exact HTTP method (GET, POST, …). */
  method?: string;
  /** Substring the path+query must contain. */
  path?: string;
  /** Resource types to hold; empty/omitted = any. */
  types?: ContentType[];
}

/** Edit applied to a paused request/response before forwarding. */
export interface InterceptEdit {
  method?: string;
  url?: string;
  headers?: HttpHeader[];
  body?: string;
  bodyBase64?: boolean;
  status?: number;
}

// -------------------------------------------------------------------------- audit

export type AuditAction =
  | "scope-change"
  | "rules-change"
  | "repeater-send"
  | "fuzz-start"
  | "fuzz-finish"
  | "intercept-forward"
  | "intercept-drop"
  | "intercept-modify"
  | "intercept-toggle"
  | "session-export"
  | "session-import";

export interface AuditEntry {
  at: number;
  action: AuditAction;
  detail: string;
}

// -------------------------------------------------------------------------- repeater

/** A request to issue from Node, plus whether to reuse the profile's cookies for in-scope hosts. */
export interface OutboundRequest {
  method: string;
  url: string;
  headers: HttpHeader[];
  body?: string;
  bodyBase64?: boolean;
  /** Reuse the browser profile's cookies for the target host (ignored when out of scope). */
  useProfileCookies?: boolean;
  /** Follow 3xx redirects. Default false so security testers see the raw response. */
  followRedirects?: boolean;
}

export interface ResponseDiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Field-level comparison of two responses, used by the comparer. */
export interface ResponseComparison {
  statusChanged: boolean;
  a: { status: number | null; length: number; durationMs: number | null };
  b: { status: number | null; length: number; durationMs: number | null };
  headerDiff: ResponseDiffLine[];
  bodyDiff: ResponseDiffLine[];
}

// -------------------------------------------------------------------------- fuzzer

export type AttackType = "sniper" | "cluster-bomb" | "pitchfork";

/** Processing applied to each payload before it is inserted (applied in order). */
export interface PayloadRule {
  kind: "prefix" | "suffix" | "url-encode" | "base64" | "upper" | "lower" | "hash-md5" | "hash-sha1" | "hash-sha256";
  /** Text for prefix/suffix. */
  text?: string;
}
export type PayloadSetKind = "wordlist" | "numbers" | "charset";

/** A payload set a user supplies. No attack wordlists are bundled with Corvus. */
export interface PayloadSet {
  kind: PayloadSetKind;
  /** wordlist: explicit values. */
  values?: string[];
  /** numbers: inclusive range `from`..`to` stepping by `step` (default 1). */
  from?: number;
  to?: number;
  step?: number;
  /** charset: every single character of this string becomes a payload. */
  charset?: string;
}

export interface FuzzerConfig {
  /**
   * Request template. Payload positions are marked with `§` pairs, e.g. `id=§1§`.
   * Each marked region is replaced by payloads during the attack.
   */
  template: OutboundRequest;
  attack: AttackType;
  payloadSets: PayloadSet[];
  /** Max requests in flight at once. Clamped to a safe ceiling. */
  concurrency: number;
  /** Mandatory throttle: requests per second across the whole attack. Clamped to a safe ceiling. */
  requestsPerSecond: number;
  /** Hard cap on total requests; the attack refuses to start above the ceiling. */
  maxRequests?: number;
  useProfileCookies?: boolean;
  /** Substrings flagged in the results table when present in a response body. */
  grep?: string[];
  /** Regex patterns; the first capture group (or whole match) is extracted per response into a column. */
  extract?: string[];
  /** Processing applied to every payload before insertion. */
  payloadRules?: PayloadRule[];
}

export interface FuzzResultRow {
  index: number;
  payloads: string[];
  status: number | null;
  length: number;
  durationMs: number | null;
  error?: string;
  /** Which grep terms matched this response. */
  matched: string[];
  /** Values pulled out by the extract patterns, in order. */
  extracted?: string[];
}

export interface FuzzSummary {
  total: number;
  completed: number;
  config: { attack: AttackType; requestsPerSecond: number; concurrency: number };
}

// -------------------------------------------------------------------------- CDP

/**
 * Minimal Chrome DevTools Protocol surface the capture engine needs. The desktop app adapts an
 * Electron `webContents.debugger` to this; tests feed synthetic events through a fake, so the
 * engine never imports Electron.
 */
export interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to CDP events. Returns an unsubscribe function. */
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  detach?(): void;
}

// -------------------------------------------------------------------------- findings & sitemap

export type FindingSeverity = "info" | "low" | "medium";

export interface Finding {
  id: string;
  severity: FindingSeverity;
  /** Short machine-ish kind, e.g. "missing-security-header". */
  kind: string;
  title: string;
  /** Plain-language explanation of the observation (not an exploit). */
  detail: string;
  host: string;
  path: string;
  entryId: string;
}

export interface SitemapNode {
  segment: string;
  path: string;
  methods: string[];
  count: number;
  children: SitemapNode[];
}
