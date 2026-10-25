/**
 * Console and network logs of the tabs agents act on, for the MCP console_messages and
 * network_requests tools. Recording starts with the first agent action in a tab and lasts until the
 * tab closes; navigations keep the log (agents pass clear to reset it).
 *
 * Network events come from the tab's CDP Network domain on wc.debugger, which WebScope also uses:
 * both enable Network with the same parameters (no body buffering) and neither disables it. When
 * WebScope detaches the debugger, recording resumes on the next agent action. session.webRequest is
 * not an option: any listener there turns off Chromium's extension request proxy (see adblock.ts).
 *
 * Only pages agents may read are recorded, and anything carrying a saved secret Corvus just filled is
 * redacted before it is stored (see secret-fill-guard.ts).
 */
import type { ConsoleEntry, NetworkEntry } from "@corvus/shared";
import type { WebContents } from "electron";
import { isAgentAllowedUrl } from "../shared/internal-urls";
import type { RequestLike } from "./secret-fill-guard";

const MAX_CONSOLE = 300;
const MAX_NETWORK = 500;
const MAX_TEXT = 4_000;
const MAX_URL = 2_048;
const LEVELS = ["debug", "info", "warning", "error"];
const HIDDEN_TEXT = "[hidden: contains a value Corvus filled]";
/** Same parameters as WebScope's capture engine, so whichever enables Network last changes nothing. */
const NETWORK_ENABLE = { maxResourceBufferSize: 0, maxTotalBufferSize: 0 };

export interface TabLogGuard {
  /** Hide this request's URL details from AI (sent from a locked tab, or carrying a filled value)? */
  sensitiveRequest(wc: WebContents, request: RequestLike): boolean;
  /** Does this text carry a value Corvus filled recently? */
  sensitiveText(text: string): boolean;
}

interface CdpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  postData?: string;
}

interface Inflight {
  entry: NetworkEntry;
  /** CDP monotonic timestamp (seconds) the request started at. */
  start: number;
}

interface TabLog {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  inflight: Map<string, Inflight>;
  /** Network events are flowing; false until attached and after the debugger detaches. */
  cdp: boolean;
}

function push<T>(list: T[], item: T, max: number): void {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

function elapsedMs(from: number, to: number | undefined): number | undefined {
  return typeof to === "number" && to >= from ? Math.round((to - from) * 1000) : undefined;
}

export class TabLogs {
  private readonly logs = new Map<WebContents, TabLog>();

  constructor(private readonly guard: TabLogGuard) {}

  /** Starts recording the tab, or resumes network capture after the debugger was detached. */
  watch(wc: WebContents): void {
    if (wc.isDestroyed()) return;
    let log = this.logs.get(wc);
    if (!log) {
      const created: TabLog = { console: [], network: [], inflight: new Map(), cdp: false };
      log = created;
      this.logs.set(wc, created);
      wc.on("console-message", (event) => {
        if (!isAgentAllowedUrl(wc.getURL())) return;
        const text = event.message.length > MAX_TEXT ? `${event.message.slice(0, MAX_TEXT)}…` : event.message;
        const entry: ConsoleEntry = { level: event.level, text: this.guard.sensitiveText(event.message) ? HIDDEN_TEXT : text, at: Date.now() };
        if (event.sourceId) entry.source = `${event.sourceId.slice(0, MAX_URL)}:${event.lineNumber}`;
        push(created.console, entry, MAX_CONSOLE);
      });
      wc.debugger.on("message", (_event, method, params) => this.onCdp(wc, created, method, params as Record<string, unknown>));
      wc.debugger.on("detach", () => {
        created.cdp = false;
        created.inflight.clear();
      });
      wc.once("destroyed", () => this.logs.delete(wc));
    }
    if (!log.cdp) this.attach(wc, log);
  }

  private attach(wc: WebContents, log: TabLog): void {
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach("1.3");
    } catch {
      return; // Console messages still record; network resumes on a later attempt.
    }
    log.cdp = true;
    dbg.sendCommand("Network.enable", NETWORK_ENABLE).catch(() => {
      log.cdp = false;
    });
  }

  /** Requests the tab has in flight (wait_for networkIdle), or null while network events are not recorded. */
  inFlight(wc: WebContents): number | null {
    const log = this.logs.get(wc);
    return log?.cdp ? log.inflight.size : null;
  }

  consoleMessages(wc: WebContents, opts: { level?: string; limit?: number; clear?: boolean } = {}): ConsoleEntry[] {
    const log = this.logs.get(wc);
    if (!log) return [];
    const min = Math.max(0, opts.level ? LEVELS.indexOf(opts.level) : 0);
    const rows = log.console.filter((m) => LEVELS.indexOf(m.level) >= min).slice(-(opts.limit ?? 50));
    if (opts.clear) log.console = [];
    return rows.map((m) => ({ ...m }));
  }

  networkRequests(wc: WebContents, opts: { filter?: string; failedOnly?: boolean; limit?: number; clear?: boolean } = {}): NetworkEntry[] {
    const log = this.logs.get(wc);
    if (!log) return [];
    const rows = log.network
      .filter((r) => !opts.filter || r.url.includes(opts.filter))
      .filter((r) => !opts.failedOnly || r.failed !== undefined || (r.status ?? 0) >= 400)
      .slice(-(opts.limit ?? 50));
    if (opts.clear) {
      log.network = [];
      log.inflight.clear();
    }
    return rows.map((r) => ({ ...r }));
  }

  private onCdp(wc: WebContents, log: TabLog, method: string, params: Record<string, unknown>): void {
    const found = typeof params.requestId === "string" ? log.inflight.get(params.requestId) : undefined;
    switch (method) {
      case "Network.requestWillBeSent": {
        const p = params as { requestId: string; request: CdpRequest; documentURL?: string; type?: string; timestamp: number; wallTime?: number; redirectResponse?: { status: number } };
        if (found && p.redirectResponse) {
          found.entry.status = p.redirectResponse.status;
          const ms = elapsedMs(found.start, p.timestamp);
          if (ms !== undefined) found.entry.durationMs = ms;
        }
        if (!isAgentAllowedUrl(p.documentURL ?? wc.getURL())) return;
        const entry: NetworkEntry = { method: p.request.method, url: this.visibleUrl(wc, p.request), at: p.wallTime ? Math.round(p.wallTime * 1000) : Date.now() };
        if (p.type) entry.type = p.type.toLowerCase();
        log.inflight.delete(p.requestId);
        log.inflight.set(p.requestId, { entry, start: p.timestamp });
        if (log.inflight.size > MAX_NETWORK) {
          const oldest = log.inflight.keys().next().value;
          if (oldest !== undefined) log.inflight.delete(oldest);
        }
        push(log.network, entry, MAX_NETWORK);
        return;
      }
      case "Network.responseReceived": {
        if (!found) return;
        const p = params as { type?: string; response: { status: number; mimeType?: string } };
        found.entry.status = p.response.status;
        if (p.response.mimeType) found.entry.mimeType = p.response.mimeType;
        if (p.type) found.entry.type = p.type.toLowerCase();
        return;
      }
      case "Network.loadingFinished": {
        if (!found) return;
        const p = params as { requestId: string; timestamp: number; encodedDataLength?: number };
        if (typeof p.encodedDataLength === "number") found.entry.bytes = Math.round(p.encodedDataLength);
        const ms = elapsedMs(found.start, p.timestamp);
        if (ms !== undefined) found.entry.durationMs = ms;
        log.inflight.delete(p.requestId);
        return;
      }
      case "Network.loadingFailed": {
        if (!found) return;
        const p = params as { requestId: string; timestamp: number; errorText?: string; canceled?: boolean; blockedReason?: string };
        found.entry.failed = p.blockedReason ? `blocked:${p.blockedReason}` : p.canceled ? "canceled" : p.errorText || "failed";
        const ms = elapsedMs(found.start, p.timestamp);
        if (ms !== undefined) found.entry.durationMs = ms;
        log.inflight.delete(p.requestId);
        return;
      }
    }
  }

  /** The request URL, or only where it went when it was sent with (or right after) a filled secret. */
  private visibleUrl(wc: WebContents, request: CdpRequest): string {
    const headers = Object.entries(request.headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
    const like: RequestLike = { url: request.url, headers, ...(request.postData !== undefined ? { body: request.postData } : {}) };
    if (!this.guard.sensitiveRequest(wc, like)) return request.url.slice(0, MAX_URL);
    try {
      const url = new URL(request.url);
      const path = this.guard.sensitiveText(url.pathname) ? "/[hidden]" : url.pathname.slice(0, MAX_URL);
      return `${url.origin}${path}${url.search ? "?[hidden]" : ""}`;
    } catch {
      return "[hidden]";
    }
  }
}
