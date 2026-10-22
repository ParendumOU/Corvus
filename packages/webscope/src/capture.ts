import { isInScope, parseTarget } from "./scope.js";
import type { CapturedRequest, CapturedResponse, CdpClient, ContentType, HistoryEntry, HttpHeader, Scope } from "./types.js";

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

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

function toHeaders(raw: unknown): HttpHeader[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) }));
}

interface Pending {
  id: string;
  requestId: string;
  startedAt: number;
  request: CapturedRequest;
  type: ContentType;
  host: string;
  path: string;
  inScope: boolean;
  /** Responses arrive before loadingFinished, so they are stashed here until the body is fetched. */
  pendingResponse?: CapturedResponse;
}

export interface CaptureOptions {
  client: CdpClient;
  profileId: string;
  history: { add(entry: HistoryEntry): void };
  scope: () => Scope;
  /** Per-body capture cap in bytes. Larger bodies are recorded truncated with the full size kept. */
  maxBodyBytes?: number;
  /** Monotonic id source so entry ids are unique across engines. */
  nextId?: () => string;
}

/**
 * Records HTTP exchanges from a CDP Network event stream into a history buffer. Attaches to an
 * injected `CdpClient` (an Electron debugger in the app, a fake in tests) and never imports Electron.
 */
export class CaptureEngine {
  private readonly pending = new Map<string, Pending>();
  private unsubscribe: (() => void) | null = null;
  private counter = 0;
  private readonly maxBodyBytes: number;

  constructor(private readonly opts: CaptureOptions) {
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = this.opts.client.onEvent((method, params) => void this.onEvent(method, params).catch(() => undefined));
    await this.opts.client.send("Network.enable", { maxResourceBufferSize: 0, maxTotalBufferSize: 0 });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pending.clear();
  }

  private newId(): string {
    return this.opts.nextId ? this.opts.nextId() : `cap-${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
  }

  private async onEvent(method: string, params: Record<string, unknown>): Promise<void> {
    switch (method) {
      case "Network.requestWillBeSent":
        this.onRequest(params);
        return;
      case "Network.responseReceived":
        this.onResponse(params);
        return;
      case "Network.loadingFinished":
        await this.onFinished(params);
        return;
      case "Network.loadingFailed":
        this.onFailed(params);
        return;
    }
  }

  private onRequest(params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? "");
    const req = params.request as Record<string, unknown> | undefined;
    if (!requestId || !req) return;
    const url = String(req.url ?? "");
    const target = parseTarget(url);
    if (!target) return;
    const request: CapturedRequest = {
      method: String(req.method ?? "GET"),
      url,
      headers: toHeaders(req.headers),
      ...(typeof req.postData === "string" ? { body: req.postData } : {}),
    };
    this.pending.set(requestId, {
      id: this.newId(),
      requestId,
      startedAt: Date.now(),
      request,
      type: classify(params.type),
      host: target.host,
      path: target.path,
      inScope: isInScope(this.opts.scope(), url),
    });
  }

  private onResponse(params: Record<string, unknown>): void {
    const pending = this.pending.get(String(params.requestId ?? ""));
    if (!pending) return;
    const res = params.response as Record<string, unknown> | undefined;
    if (!res) return;
    pending.type = classify(params.type) === "other" ? pending.type : classify(params.type);
    pending.pendingResponse = {
      status: Number(res.status ?? 0),
      ...(res.statusText ? { statusText: String(res.statusText) } : {}),
      headers: toHeaders(res.headers),
      ...(res.mimeType ? { mimeType: String(res.mimeType) } : {}),
    };
  }

  private async onFinished(params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? "");
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    const response = pending.pendingResponse ?? { status: 0, headers: [] };
    const encodedLength = Number(params.encodedDataLength ?? 0);
    response.size = encodedLength > 0 ? encodedLength : response.size;
    await this.attachBody(requestId, response);
    this.emit(pending, response);
  }

  private onFailed(params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? "");
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    this.opts.history.add({
      ...this.baseEntry(pending),
      error: String(params.errorText ?? "request failed"),
    });
  }

  private async attachBody(requestId: string, response: CapturedResponse): Promise<void> {
    try {
      const body = (await this.opts.client.send("Network.getResponseBody", { requestId })) as
        | { body?: string; base64Encoded?: boolean }
        | undefined;
      if (!body || typeof body.body !== "string") return;
      const base64 = body.base64Encoded === true;
      const bytes = base64 ? Buffer.from(body.body, "base64") : Buffer.from(body.body, "utf8");
      response.size = bytes.length;
      if (bytes.length > this.maxBodyBytes) {
        const slice = bytes.subarray(0, this.maxBodyBytes);
        response.body = base64 ? slice.toString("base64") : slice.toString("utf8");
      } else {
        response.body = body.body;
      }
      if (base64) response.bodyBase64 = true;
    } catch {
      // Body is best-effort; some responses (redirects, 204, cached) have none.
    }
  }

  private baseEntry(pending: Pending): HistoryEntry {
    return {
      id: pending.id,
      profileId: this.opts.profileId,
      startedAt: pending.startedAt,
      durationMs: Date.now() - pending.startedAt,
      host: pending.host,
      path: pending.path,
      type: pending.type,
      inScope: pending.inScope,
      source: "capture",
      request: pending.request,
    };
  }

  private emit(pending: Pending, response: CapturedResponse): void {
    this.opts.history.add({ ...this.baseEntry(pending), response });
  }
}
