import { applyRequestRules, isBlocked } from "./rules.js";
import { isInScope, parseTarget } from "./scope.js";
import type {
  CapturedRequest,
  CapturedResponse,
  CdpClient,
  ContentType,
  HttpHeader,
  InterceptConfig,
  InterceptEdit,
  InterceptItem,
  OutboundRequest,
  RuleSet,
  Scope,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

const RESOURCE_TYPE: Record<string, ContentType> = {
  Document: "document",
  Stylesheet: "stylesheet",
  Script: "script",
  Image: "image",
  Font: "font",
  XHR: "xhr",
  Fetch: "fetch",
  WebSocket: "websocket",
  Media: "media",
  Manifest: "manifest",
};

function classify(resourceType: unknown): ContentType {
  return (typeof resourceType === "string" && RESOURCE_TYPE[resourceType]) || "other";
}

function headerObject(headers: HttpHeader[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.name] = h.value;
  return out;
}

function headerArray(raw: unknown): HttpHeader[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) }));
}

/** CDP Fetch header list form: [{name, value}]. */
function fetchHeaders(headers: HttpHeader[]): Array<{ name: string; value: string }> {
  return headers.map((h) => ({ name: h.name, value: h.value }));
}

function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

interface Held extends InterceptItem {
  /** CDP Fetch requestId used to continue/fail this exchange. */
  cdpId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface InterceptEngineOptions {
  client: CdpClient;
  scope: () => Scope;
  config: () => InterceptConfig;
  rules?: () => RuleSet;
  /** Fires whenever the held queue changes (added, forwarded, dropped). */
  onChange?: () => void;
  /** Audit hook for forward/drop/modify actions. */
  onAction?: (action: "intercept-forward" | "intercept-drop" | "intercept-modify", detail: string) => void;
  timeoutMs?: number;
  nextId?: () => string;
  /** True when a held request carries a secret the browser filled; it is then hidden from AI. */
  sensitive?: (request: CapturedRequest) => boolean;
}

/**
 * Interactive request/response interception over the CDP Fetch domain. Paused exchanges that are
 * in scope and match the filters are held in a queue the user (or an agent) can edit, forward or
 * drop; everything else is forwarded immediately. Held items auto-forward after a timeout so the
 * browser never deadlocks. Injected `CdpClient` keeps this testable without Electron.
 */
export class InterceptEngine {
  private readonly held = new Map<string, Held>();
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private counter = 0;
  private readonly timeoutMs: number;

  constructor(private readonly opts: InterceptEngineOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Enables/updates Fetch interception to match the current config. Call on config change. */
  async sync(): Promise<void> {
    const cfg = this.opts.config();
    if (cfg.enabled && cfg.interceptRequests) {
      await this.enable(cfg.interceptResponses);
    } else {
      await this.disable();
    }
  }

  private async enable(withResponses: boolean): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = this.opts.client.onEvent((method, params) => {
        if (method === "Fetch.requestPaused") void this.onPaused(params).catch(() => undefined);
      });
    }
    const patterns: Array<Record<string, string>> = [{ urlPattern: "*", requestStage: "Request" }];
    if (withResponses) patterns.push({ urlPattern: "*", requestStage: "Response" });
    this.running = true;
    await this.opts.client.send("Fetch.enable", { patterns });
  }

  async disable(): Promise<void> {
    if (!this.running && !this.unsubscribe) return;
    this.running = false;
    // Release everything still held so the browser is never left waiting.
    for (const item of [...this.held.values()]) await this.forward(item.id).catch(() => undefined);
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      await this.opts.client.send("Fetch.disable");
    } catch {
      // ignore
    }
  }

  queue(): InterceptItem[] {
    return [...this.held.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ timer: _timer, cdpId: _cdpId, ...item }) => item);
  }

  private isSensitive(request: CapturedRequest): boolean {
    try {
      return this.opts.sensitive?.(request) === true;
    } catch {
      return true;
    }
  }

  private newId(): string {
    return this.opts.nextId ? this.opts.nextId() : `int-${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
  }

  private matches(host: string, method: string, path: string, type: ContentType): boolean {
    const m = this.opts.config().match;
    if (!m) return true;
    if (m.host && !host.toLowerCase().includes(m.host.toLowerCase())) return false;
    if (m.method && method.toUpperCase() !== m.method.toUpperCase()) return false;
    if (m.path && !path.toLowerCase().includes(m.path.toLowerCase())) return false;
    if (m.types && m.types.length > 0 && !m.types.includes(type)) return false;
    return true;
  }

  private async continueRequest(cdpId: string, edit?: InterceptEdit): Promise<void> {
    const params: Record<string, unknown> = { requestId: cdpId };
    if (edit?.url) params.url = edit.url;
    if (edit?.method) params.method = edit.method;
    if (edit?.headers) params.headers = fetchHeaders(edit.headers);
    if (edit?.body !== undefined) params.postData = edit.bodyBase64 ? edit.body : toBase64(edit.body);
    await this.opts.client.send("Fetch.continueRequest", params);
  }

  private async onPaused(params: Record<string, unknown>): Promise<void> {
    const cdpId = String(params.requestId ?? "");
    const req = params.request as Record<string, unknown> | undefined;
    if (!cdpId || !req) return;
    const url = String(req.url ?? "");
    const method = String(req.method ?? "GET");
    const target = parseTarget(url);
    const isResponse = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;
    const type = classify(params.resourceType);

    const cfg = this.opts.config();
    const scope = this.opts.scope();
    const rules = this.opts.rules?.();

    // Out of scope, blocked by config, or no longer intercepting: forward verbatim, never hold.
    if (!cfg.enabled || !target || !isInScope(scope, url) || !this.matches(target.host, method, target.path, type)) {
      await this.passthrough(cdpId, isResponse);
      return;
    }
    if (rules && isBlocked(url, rules)) {
      await this.opts.client.send("Fetch.failRequest", { requestId: cdpId, errorReason: "BlockedByClient" });
      return;
    }
    if (isResponse && !cfg.interceptResponses) {
      await this.opts.client.send("Fetch.continueResponse", { requestId: cdpId });
      return;
    }

    const request: CapturedRequest = {
      method,
      url,
      headers: headerArray(req.headers),
      ...(typeof req.postData === "string" ? { body: req.postData } : {}),
    };
    const item: Held = {
      id: this.newId(),
      phase: isResponse ? "response" : "request",
      host: target.host,
      path: target.path,
      request,
      createdAt: Date.now(),
      cdpId,
      timer: null,
      ...(this.isSensitive(request) ? { aiHidden: true } : {}),
      ...(isResponse
        ? {
            response: {
              status: Number(params.responseStatusCode ?? 0),
              headers: headerArray(params.responseHeaders ?? (params.responseHeadersText ? {} : {})),
            } as CapturedResponse,
          }
        : {}),
    };
    // Auto-forward on timeout so a forgotten item never freezes the page.
    item.timer = setTimeout(() => void this.forward(item.id, undefined, true).catch(() => undefined), this.timeoutMs);
    if (item.timer.unref) item.timer.unref();
    this.held.set(item.id, item);
    this.opts.onChange?.();
  }

  private async passthrough(cdpId: string, isResponse: boolean): Promise<void> {
    if (isResponse) await this.opts.client.send("Fetch.continueResponse", { requestId: cdpId });
    else {
      // Apply match/replace + host overrides even when not holding, so rules still take effect.
      await this.opts.client.send("Fetch.continueRequest", { requestId: cdpId });
    }
  }

  /** Forward a held exchange, optionally with edits. */
  async forward(id: string, edit?: InterceptEdit, auto = false): Promise<void> {
    const item = this.take(id);
    if (!item) return;
    const rules = this.opts.rules?.();
    if (item.phase === "response") {
      if (edit && (edit.status !== undefined || edit.headers || edit.body !== undefined)) {
        const base = item.response;
        const headers = edit.headers ?? base?.headers ?? [];
        await this.opts.client.send("Fetch.fulfillRequest", {
          requestId: item.cdpId,
          responseCode: edit.status ?? base?.status ?? 200,
          responseHeaders: fetchHeaders(headers),
          ...(edit.body !== undefined ? { body: edit.bodyBase64 ? edit.body : toBase64(edit.body) } : {}),
        });
      } else {
        await this.opts.client.send("Fetch.continueResponse", { requestId: item.cdpId });
      }
    } else {
      let finalEdit = edit;
      if (rules) {
        // Apply match/replace (and block) rules to the (possibly edited) request before forwarding.
        // Host overrides are resolved at the DNS layer, not rewritten here.
        const outbound: OutboundRequest = {
          method: edit?.method ?? item.request.method,
          url: edit?.url ?? item.request.url,
          headers: edit?.headers ?? item.request.headers,
          ...(edit?.body !== undefined ? { body: edit.body } : item.request.body !== undefined ? { body: item.request.body } : {}),
        };
        const applied = applyRequestRules(outbound, rules);
        if (applied.blockedBy) {
          await this.opts.client.send("Fetch.failRequest", { requestId: item.cdpId, errorReason: "BlockedByClient" });
          this.opts.onAction?.("intercept-drop", `blocked ${item.host}${item.path}`);
          this.opts.onChange?.();
          return;
        }
        const r = applied.request;
        finalEdit = {
          method: r.method,
          url: r.url,
          headers: r.headers,
          ...(r.body !== undefined ? { body: r.body } : {}),
        };
      }
      await this.continueRequest(item.cdpId, finalEdit);
    }
    this.opts.onAction?.(edit ? "intercept-modify" : "intercept-forward", `${item.request.method} ${item.host}${item.path}${auto ? " (auto)" : ""}`);
    this.opts.onChange?.();
  }

  /** Drop a held exchange (the page sees a failed request). */
  async drop(id: string): Promise<void> {
    const item = this.take(id);
    if (!item) return;
    await this.opts.client.send("Fetch.failRequest", { requestId: item.cdpId, errorReason: "Aborted" });
    this.opts.onAction?.("intercept-drop", `${item.request.method} ${item.host}${item.path}`);
    this.opts.onChange?.();
  }

  private take(id: string): Held | undefined {
    const item = this.held.get(id);
    if (!item) return undefined;
    if (item.timer) clearTimeout(item.timer);
    this.held.delete(id);
    return item;
  }
}
