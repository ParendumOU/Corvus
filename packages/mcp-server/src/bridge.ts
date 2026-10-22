import type { Readable, Writable } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  isInitializeRequest,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

export interface StdioBridgeOptions {
  /** Corvus MCP endpoint, e.g. http://127.0.0.1:39217/mcp. Must be loopback. */
  url: string;
  token: string;
  stdin?: Readable;
  stdout?: Writable;
  log?: (message: string) => void;
}

export interface StdioBridge {
  close(): Promise<void>;
  closed: Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Proxies an MCP stdio client to the running browser's Streamable HTTP endpoint. */
export async function startStdioBridge(opts: StdioBridgeOptions): Promise<StdioBridge> {
  const url = new URL(opts.url);
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
    throw new Error("CORVUS_MCP_URL must be an http://127.0.0.1 (loopback) URL");
  }
  if (!opts.token) throw new Error("CORVUS_MCP_TOKEN is required");
  const log = opts.log ?? ((m: string) => process.stderr.write(`[corvus-mcp-stdio] ${m}\n`));

  const stdio = new StdioServerTransport(opts.stdin, opts.stdout);
  const http = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
  });
  const initIds = new Set<RequestId>();

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let closing = false;
  async function close(): Promise<void> {
    if (closing) return closed;
    closing = true;
    await Promise.allSettled([http.close(), stdio.close()]);
    resolveClosed();
  }

  // Sends are serialized so pipelined messages never overtake initialize (which yields the session id).
  let queue: Promise<void> = Promise.resolve();
  stdio.onmessage = (msg: JSONRPCMessage) => {
    if (isInitializeRequest(msg) && isJSONRPCRequest(msg)) initIds.add(msg.id);
    queue = queue.then(() => forward(msg));
  };
  const forward = (msg: JSONRPCMessage) =>
    http.send(msg).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      log(`upstream error: ${reason}`);
      if (isJSONRPCRequest(msg)) {
        void stdio.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: `Corvus browser unreachable or refused the request: ${reason}` },
        });
      }
    });
  http.onmessage = (msg: JSONRPCMessage) => {
    if (isJSONRPCResultResponse(msg) && initIds.delete(msg.id)) {
      const version = (msg.result as { protocolVersion?: unknown }).protocolVersion;
      if (typeof version === "string") http.setProtocolVersion(version);
    }
    void stdio.send(msg);
  };
  http.onerror = (err) => log(`upstream error: ${err.message}`);
  stdio.onerror = (err) => log(`stdio error: ${err.message}`);
  stdio.onclose = () => void close();
  (opts.stdin ?? process.stdin).once("end", () => void close());

  await http.start();
  await stdio.start();
  return { close, closed };
}
