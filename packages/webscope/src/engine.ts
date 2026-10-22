import { AuditLog } from "./audit.js";
import { CaptureEngine } from "./capture.js";
import { buildSitemap, scanFindings, type Finding, type SitemapNode } from "./findings.js";
import { InterceptEngine } from "./intercept.js";
import { compareResponses } from "./compare.js";
import { FuzzLimitError, FuzzScopeError, runFuzz } from "./fuzzer.js";
import { exportHar, importHar } from "./har.js";
import { HistoryBuffer, summarize } from "./history.js";
import { sendRequest, type SendResult } from "./http-client.js";
import { applyRequestRules, emptyRuleSet } from "./rules.js";
import { emptyScope, isInScope, scopeRejectionReason } from "./scope.js";
import type {
  AuditEntry,
  CdpClient,
  FuzzResultRow,
  FuzzSummary,
  FuzzerConfig,
  HistoryEntry,
  HistoryFilter,
  HistorySummary,
  InterceptConfig,
  InterceptEdit,
  InterceptItem,
  OutboundRequest,
  ResponseComparison,
  RuleSet,
  Scope,
} from "./types.js";

export class ScopeError extends Error {}
export class BlockedError extends Error {}

export interface WebScopeEngineOptions {
  profileId?: string;
  scope?: Scope;
  rules?: RuleSet;
  historyCapacity?: number;
  maxBodyBytes?: number;
  /** Supplies the profile's Cookie header for a URL; only called for in-scope hosts. */
  cookieProvider?: (url: string) => Promise<string | undefined>;
  /** Injectable HTTP sender (tests pass a fake; defaults to the Node client). */
  send?: typeof sendRequest;
  now?: () => number;
}

function bodyLength(result: SendResult): number {
  return result.response.size ?? (result.response.body ? Buffer.byteLength(result.response.body) : 0);
}

/**
 * The WebScope engine: owns scope, rules, HTTP history, audit log, and drives capture, repeater and
 * the fuzzer. Scope is enforced on every outbound action here, independent of any UI or MCP gate.
 */
export class WebScopeEngine {
  readonly history: HistoryBuffer;
  readonly audit = new AuditLog();
  private scope: Scope;
  private rules: RuleSet;
  private readonly profileId: string;
  private readonly maxBodyBytes: number;
  private readonly send: typeof sendRequest;
  private readonly cookieProvider: ((url: string) => Promise<string | undefined>) | undefined;
  private capture: CaptureEngine | null = null;
  private readonly captures = new Set<CaptureEngine>();
  private counter = 0;

  constructor(private readonly opts: WebScopeEngineOptions = {}) {
    this.history = new HistoryBuffer(opts.historyCapacity);
    this.scope = opts.scope ?? emptyScope();
    this.rules = opts.rules ?? emptyRuleSet();
    this.profileId = opts.profileId ?? "default";
    this.maxBodyBytes = opts.maxBodyBytes ?? 5 * 1024 * 1024;
    this.send = opts.send ?? sendRequest;
    this.cookieProvider = opts.cookieProvider;
  }

  // ---- scope & rules

  getScope(): Scope {
    return structuredClone(this.scope);
  }

  setScope(scope: Scope): void {
    this.scope = scope;
    this.audit.record("scope-change", `scope ${scope.enabled ? "enabled" : "disabled"}, ${scope.include.length} include / ${scope.exclude.length} exclude`);
  }

  isInScope(url: string): boolean {
    return isInScope(this.scope, url);
  }

  requireInScope(url: string): void {
    if (!isInScope(this.scope, url)) throw new ScopeError(scopeRejectionReason(this.scope, url) ?? "out of scope");
  }

  /** Human-readable reason a URL is out of scope, or null when it is in scope. */
  rejectionReason(url: string): string | null {
    return scopeRejectionReason(this.scope, url);
  }

  getRules(): RuleSet {
    return structuredClone(this.rules);
  }

  setRules(rules: RuleSet): void {
    this.rules = rules;
    this.audit.record("rules-change", `${rules.matchReplace.length} match/replace, ${rules.block.length} block, ${rules.hostOverride.length} host override`);
  }

  // ---- history

  queryHistory(filter: HistoryFilter = {}, limit = 200): HistorySummary[] {
    return this.history.query(filter, limit);
  }

  getEntry(id: string): HistoryEntry | undefined {
    return this.history.get(id);
  }

  /** Passive, read-only findings over captured traffic (no requests sent). */
  findings(): Finding[] {
    return scanFindings(this.history.all());
  }

  /** Host -> path target tree built from captured traffic. */
  sitemap(): SitemapNode[] {
    return buildSitemap(this.history.all());
  }

  clearHistory(): void {
    this.history.clear();
  }

  exportHar(ids?: string[]): ReturnType<typeof exportHar> {
    const entries = ids ? ids.map((id) => this.history.get(id)).filter((e): e is HistoryEntry => !!e) : this.history.all();
    return exportHar(entries);
  }

  importHar(json: unknown): number {
    const entries = importHar(json, { profileId: this.profileId, inScope: (url) => isInScope(this.scope, url), nextId: () => this.newId("har") });
    for (const entry of entries) this.history.add(entry);
    return entries.length;
  }

  // ---- capture

  attachCapture(client: CdpClient): CaptureEngine {
    this.detachCapture();
    this.capture = new CaptureEngine({
      client,
      profileId: this.profileId,
      history: this.history,
      scope: () => this.scope,
      maxBodyBytes: this.maxBodyBytes,
      nextId: () => this.newId("cap"),
    });
    void this.capture.start();
    return this.capture;
  }

  detachCapture(): void {
    this.capture?.stop();
    this.capture = null;
  }

  /**
   * Start capturing from one CDP client (e.g. one browser tab), sharing this engine's history and
   * scope. Returns a detach function. Multiple sources can capture at once.
   */
  captureFrom(client: CdpClient): () => void {
    const capture = new CaptureEngine({
      client,
      profileId: this.profileId,
      history: this.history,
      scope: () => this.scope,
      maxBodyBytes: this.maxBodyBytes,
      nextId: () => this.newId("cap"),
    });
    this.captures.add(capture);
    void capture.start();
    return () => {
      capture.stop();
      this.captures.delete(capture);
    };
  }

  detachAll(): void {
    this.detachCapture();
    for (const capture of this.captures) capture.stop();
    this.captures.clear();
    for (const intercept of this.intercepts) void intercept.disable().catch(() => undefined);
    this.intercepts.clear();
  }

  // ---- interactive intercept

  private readonly intercepts = new Set<InterceptEngine>();
  private interceptConfig: InterceptConfig = { enabled: false, interceptRequests: true, interceptResponses: false };
  private interceptListeners = new Set<() => void>();

  getInterceptConfig(): InterceptConfig {
    return structuredClone(this.interceptConfig);
  }

  /** Update intercept config and reconcile every attached intercept source. */
  async setInterceptConfig(config: InterceptConfig): Promise<void> {
    this.interceptConfig = config;
    this.audit.record("rules-change", `intercept ${config.enabled ? "on" : "off"}${config.interceptResponses ? " +responses" : ""}`);
    await Promise.all([...this.intercepts].map((i) => i.sync()));
    this.emitIntercept();
  }

  onInterceptChange(listener: () => void): () => void {
    this.interceptListeners.add(listener);
    return () => this.interceptListeners.delete(listener);
  }

  private emitIntercept(): void {
    for (const l of this.interceptListeners) l();
  }

  /** Aggregate held queue across all attached tabs, oldest first. */
  interceptQueue(): InterceptItem[] {
    return [...this.intercepts].flatMap((i) => i.queue()).sort((a, b) => a.createdAt - b.createdAt);
  }

  async interceptForward(id: string, edit?: InterceptEdit): Promise<void> {
    for (const i of this.intercepts) {
      if (i.queue().some((q) => q.id === id)) return i.forward(id, edit);
    }
  }

  async interceptDrop(id: string): Promise<void> {
    for (const i of this.intercepts) {
      if (i.queue().some((q) => q.id === id)) return i.drop(id);
    }
  }

  /** Attach interactive interception to one CDP client (one tab). Returns a detach function. */
  interceptFrom(client: CdpClient): () => void {
    const engine = new InterceptEngine({
      client,
      scope: () => this.scope,
      config: () => this.interceptConfig,
      rules: () => this.rules,
      onChange: () => this.emitIntercept(),
      onAction: (action, detail) => this.audit.record(action, detail),
      nextId: () => this.newId("int"),
    });
    this.intercepts.add(engine);
    void engine.sync();
    return () => {
      void engine.disable().catch(() => undefined);
      this.intercepts.delete(engine);
    };
  }

  // ---- repeater

  private async cookieFor(req: OutboundRequest): Promise<string | undefined> {
    if (!req.useProfileCookies || !this.cookieProvider) return undefined;
    if (!isInScope(this.scope, req.url)) return undefined;
    return this.cookieProvider(req.url);
  }

  /** Issue a request from Node. Enforces scope, applies rules, reuses cookies only for in-scope hosts. */
  async repeaterSend(req: OutboundRequest): Promise<HistoryEntry> {
    this.requireInScope(req.url);
    const applied = applyRequestRules(req, this.rules);
    if (applied.blockedBy) throw new BlockedError(`Request blocked by rule "${applied.blockedBy}"`);
    this.requireInScope(applied.request.url);
    const cookieHeader = await this.cookieFor({ ...applied.request, useProfileCookies: req.useProfileCookies });
    const started = Date.now();
    this.audit.record("repeater-send", `${applied.request.method} ${applied.request.url}`);
    try {
      const result = await this.send(applied.request, {
        ...(applied.override ? { override: applied.override } : {}),
        ...(cookieHeader ? { cookieHeader } : {}),
        maxBodyBytes: this.maxBodyBytes,
      });
      return this.record(applied.request, started, result);
    } catch (err) {
      const entry = this.failedEntry(applied.request, started, (err as Error).message);
      this.history.add(entry);
      throw err;
    }
  }

  compare(idA: string, idB: string): ResponseComparison {
    const a = this.history.get(idA);
    const b = this.history.get(idB);
    if (!a || !b) throw new Error("Both entries must exist in history to compare them");
    return compareResponses(a, b);
  }

  // ---- fuzzer

  async fuzz(config: FuzzerConfig, hooks: { onRow?: (row: FuzzResultRow) => void; signal?: AbortSignal } = {}): Promise<{ rows: FuzzResultRow[]; summary: FuzzSummary }> {
    this.requireInScope(config.template.url);
    this.audit.record("fuzz-start", `${config.attack} on ${config.template.url} (${config.payloadSets.length} set(s))`);
    try {
      const result = await runFuzz(config, {
        inScope: (url) => isInScope(this.scope, url),
        send: async (req) => {
          const applied = applyRequestRules(req, this.rules);
          if (applied.blockedBy) throw new BlockedError(`blocked by rule "${applied.blockedBy}"`);
          const cookieHeader = await this.cookieFor({ ...applied.request, useProfileCookies: config.useProfileCookies });
          const res = await this.send(applied.request, {
            ...(applied.override ? { override: applied.override } : {}),
            ...(cookieHeader ? { cookieHeader } : {}),
            maxBodyBytes: this.maxBodyBytes,
          });
          return {
            status: res.response.status,
            length: bodyLength(res),
            durationMs: res.durationMs,
            ...(res.response.body && !res.response.bodyBase64 ? { body: res.response.body } : {}),
          };
        },
        ...(hooks.onRow ? { onRow: hooks.onRow } : {}),
        ...(hooks.signal ? { signal: hooks.signal } : {}),
      });
      this.audit.record("fuzz-finish", `${result.summary.completed}/${result.summary.total} requests`);
      return result;
    } catch (err) {
      if (err instanceof FuzzScopeError || err instanceof FuzzLimitError) this.audit.record("fuzz-finish", `refused: ${err.message}`);
      throw err;
    }
  }

  // ---- audit

  auditLog(limit = 200): AuditEntry[] {
    return this.audit.list(limit);
  }

  // ---- internals

  private newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
  }

  private record(req: OutboundRequest, started: number, result: SendResult): HistoryEntry {
    const entry: HistoryEntry = {
      id: this.newId("rep"),
      profileId: this.profileId,
      startedAt: started,
      durationMs: result.durationMs,
      host: new URL(req.url).hostname.toLowerCase(),
      path: new URL(req.url).pathname + new URL(req.url).search,
      type: "other",
      inScope: true,
      source: "repeater",
      request: { method: req.method, url: req.url, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}), ...(req.bodyBase64 ? { bodyBase64: true } : {}) },
      response: result.response,
    };
    this.history.add(entry);
    return entry;
  }

  private failedEntry(req: OutboundRequest, started: number, error: string): HistoryEntry {
    return {
      id: this.newId("rep"),
      profileId: this.profileId,
      startedAt: started,
      durationMs: Date.now() - started,
      host: new URL(req.url).hostname.toLowerCase(),
      path: new URL(req.url).pathname + new URL(req.url).search,
      type: "other",
      inScope: true,
      source: "repeater",
      request: { method: req.method, url: req.url, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) },
      error,
    };
  }

  summary(entry: HistoryEntry): HistorySummary {
    return summarize(entry);
  }
}
