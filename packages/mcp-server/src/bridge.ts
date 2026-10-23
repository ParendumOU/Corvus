import type { Readable, Writable } from "node:stream";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  isInitializeRequest,
  isInitializedNotification,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type JSONRPCResultResponse,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

export interface BridgeTarget {
  /** Corvus MCP endpoint, e.g. http://127.0.0.1:39217/mcp. Must be loopback. */
  url: string;
  token: string;
}

export interface StdioBridgeOptions extends BridgeTarget {
  /**
   * Finds the browser again when it went away or forgot this session (Corvus restarted, or the
   * session expired). The bridge then opens a new session and retries the request once. Without
   * it, those requests fail.
   */
  reconnect?: () => Promise<BridgeTarget>;
  /** Extra headers on every request to Corvus. */
  headers?: Record<string, string>;
  stdin?: Readable;
  stdout?: Writable;
  log?: (message: string) => void;
}

export interface StdioBridge {
  close(): Promise<void>;
  closed: Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const REINIT_TIMEOUT_MS = 120_000;

function endpoint(target: BridgeTarget): URL {
  const url = new URL(target.url);
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
    throw new Error("CORVUS_MCP_URL must be an http://127.0.0.1 (loopback) URL");
  }
  if (!target.token) throw new Error("CORVUS_MCP_TOKEN is required");
  return url;
}

/** Corvus dropped this session (404) or nothing listens on its port any more (fetch failed). */
function isLost(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) return err.code === 404;
  return err instanceof TypeError;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Proxies an MCP stdio client to the running browser's Streamable HTTP endpoint. */
export async function startStdioBridge(opts: StdioBridgeOptions): Promise<StdioBridge> {
  endpoint(opts);
  const log = opts.log ?? ((m: string) => process.stderr.write(`[corvus-mcp-stdio] ${m}\n`));

  const stdio = new StdioServerTransport(opts.stdin, opts.stdout);
  const initIds = new Set<RequestId>();
  /** The client's initialize request, replayed to open a new session after a reconnect. */
  let initRequest: JSONRPCRequest | undefined;
  /** Answers to requests the bridge sends itself (the replayed initialize); never shown to the client. */
  const ownRequests = new Map<RequestId, (msg: JSONRPCMessage) => void>();
  let reinits = 0;

  const useVersion = (transport: StreamableHTTPClientTransport, msg: JSONRPCResultResponse): void => {
    const version = (msg.result as { protocolVersion?: unknown }).protocolVersion;
    if (typeof version === "string") transport.setProtocolVersion(version);
  };

  const connect = (target: BridgeTarget): StreamableHTTPClientTransport => {
    const transport = new StreamableHTTPClientTransport(endpoint(target), {
      requestInit: { headers: { ...opts.headers, Authorization: `Bearer ${target.token}` } },
    });
    transport.onmessage = (msg: JSONRPCMessage) => {
      if (isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) {
        const own = msg.id === undefined ? undefined : ownRequests.get(msg.id);
        if (own && msg.id !== undefined) {
          ownRequests.delete(msg.id);
          own(msg);
          return;
        }
      }
      if (isJSONRPCResultResponse(msg) && initIds.delete(msg.id)) useVersion(transport, msg);
      void stdio.send(msg);
    };
    transport.onerror = (err) => log(`upstream error: ${err.message}`);
    return transport;
  };
  let http = connect(opts);

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let closing = false;
  async function close(): Promise<void> {
    if (closing) return closed;
    closing = true;
    await Promise.allSettled([http.close(), stdio.close()]);
    resolveClosed();
  }

  /** Sends a request of the bridge's own and waits for Corvus to answer it. */
  async function ask(transport: StreamableHTTPClientTransport, request: JSONRPCRequest): Promise<JSONRPCMessage> {
    let timer: NodeJS.Timeout | undefined;
    const answer = new Promise<JSONRPCMessage>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Corvus did not answer in time")), REINIT_TIMEOUT_MS);
      ownRequests.set(request.id, resolve);
    });
    try {
      await transport.send(request);
      return await answer;
    } finally {
      clearTimeout(timer);
      ownRequests.delete(request.id);
    }
  }

  /**
   * Finds Corvus again and opens a new session there. With `replay`, it repeats the client's
   * initialize handshake so the client carries on as if nothing happened.
   */
  async function reopen(replay: boolean): Promise<void> {
    const target = await opts.reconnect!();
    const old = http;
    old.onmessage = undefined;
    old.onerror = undefined;
    void old.close().catch(() => undefined);
    http = connect(target);
    await http.start();
    if (!replay || !initRequest) return;
    reinits += 1;
    const answer = await ask(http, { ...initRequest, id: `corvus-bridge-reinit-${reinits}` });
    if (isJSONRPCErrorResponse(answer)) throw new Error(`Corvus refused the new session: ${answer.error.message}`);
    if (isJSONRPCResultResponse(answer)) useVersion(http, answer);
    await http.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // The new session can offer other tools (another access level, an updated browser).
    await stdio.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    log("reconnected to Corvus");
  }

  const fail = (msg: JSONRPCMessage, err: unknown): void => {
    const reason = reasonOf(err);
    log(`upstream error: ${reason}`);
    if (isJSONRPCRequest(msg)) {
      void stdio.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: `Corvus browser unreachable or refused the request: ${reason}` },
      });
    }
  };

  const forward = async (msg: JSONRPCMessage): Promise<void> => {
    try {
      await http.send(msg);
      return;
    } catch (err) {
      if (!opts.reconnect || closing || !isLost(err)) return fail(msg, err);
      log(`lost Corvus (${reasonOf(err)}), reconnecting`);
    }
    try {
      const replay = !isInitializeRequest(msg);
      await reopen(replay);
      // Reopening already sent `initialized` for the replayed handshake.
      if (replay && isInitializedNotification(msg)) return;
      await http.send(msg);
    } catch (err) {
      fail(msg, err);
    }
  };

  // Sends are serialized so pipelined messages never overtake initialize (which yields the session id).
  let queue: Promise<void> = Promise.resolve();
  stdio.onmessage = (msg: JSONRPCMessage) => {
    if (isInitializeRequest(msg) && isJSONRPCRequest(msg)) {
      initIds.add(msg.id);
      initRequest = msg;
    }
    queue = queue.then(() => forward(msg));
  };
  stdio.onerror = (err) => log(`stdio error: ${err.message}`);
  stdio.onclose = () => void close();
  (opts.stdin ?? process.stdin).once("end", () => void close());

  await http.start();
  await stdio.start();
  return { close, closed };
}
