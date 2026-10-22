import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpClientInfo, McpServerHandle, McpServerOptions } from "@corvus/shared";
import { bearerMatches, isAllowedHost, isAllowedOrigin, type RateLimitOptions } from "./security.js";
import { createMcpServer } from "./server.js";
import type { FlowProvider, WebScopeProvider } from "./tools/index.js";

export interface StartMcpServerOptions extends McpServerOptions {
  /** Per-session tool call budget. `false` disables limiting. */
  rateLimit?: RateLimitOptions | false;
  /** Resolves the WebScope engine; enables the scope-gated WebScope tools (full access level). */
  webscope?: WebScopeProvider;
  /** Resolves the recorded-flows runner; enables run_flow (full access level). */
  flows?: FlowProvider;
  /** Maximum POST body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Maximum concurrent MCP sessions. Default 32. */
  maxSessions?: number;
  /** Sessions with no request and no open stream for this long are closed. Default 30 min. */
  sessionIdleMs?: number;
}

const DEFAULT_HOST = "127.0.0.1";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "0.0.0.0"]);
const MCP_PATH = "/mcp";
const DEFAULT_MAX_BODY = 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const MIN_TOKEN_LENGTH = 16;

/** Client names the user approved, kept for the lifetime of the process. */
const approvedClients = new Set<string>();
const pendingApprovals = new Map<string, Promise<boolean>>();

/** Forgets every client approval (e.g. when the user revokes agent access). */
export function resetClientApprovals(): void {
  approvedClients.clear();
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function sendError(res: ServerResponse, err: HttpError): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: err.message }, id: null });
  res.writeHead(err.status, { "content-type": "application/json", ...err.headers });
  res.end(body);
}

function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, `Request body exceeds ${limit} bytes`, { connection: "close" });
    if (Number(req.headers["content-length"] ?? 0) > limit) {
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Parse error: body must be JSON"));
      }
    });
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
  /** Open responses (e.g. the GET event stream); a session with one is never idle. */
  openStreams: number;
  client: string;
}

/** Starts the Corvus MCP server with Streamable HTTP at /mcp, bound to 127.0.0.1 (default) or 0.0.0.0. */
export async function startMcpServer(opts: StartMcpServerOptions): Promise<McpServerHandle> {
  const bindHost = opts.host ?? DEFAULT_HOST;
  if (!ALLOWED_HOSTS.has(bindHost)) {
    throw new Error(`MCP server may only bind to ${[...ALLOWED_HOSTS].join(" or ")}`);
  }
  if (typeof opts.token !== "string" || opts.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`MCP token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const sessions = new Map<string, Session>();
  let port = 0;

  function closeSession(id: string, session: Session): void {
    sessions.delete(id);
    void session.server.close().catch(() => undefined);
  }

  const sweeper = setInterval(
    () => {
      const cutoff = Date.now() - sessionIdleMs;
      for (const [id, session] of sessions) {
        if (session.openStreams === 0 && session.lastSeen < cutoff) closeSession(id, session);
      }
    },
    Math.max(10, Math.min(sessionIdleMs / 2, 60_000)),
  );
  sweeper.unref();

  async function approve(info: McpClientInfo): Promise<boolean> {
    if (!opts.onClientConnect || approvedClients.has(info.name)) return true;
    let pending = pendingApprovals.get(info.name);
    if (!pending) {
      pending = opts.onClientConnect(info).catch(() => false);
      pendingApprovals.set(info.name, pending);
    }
    try {
      const ok = await pending;
      if (ok) approvedClients.add(info.name);
      return ok;
    } finally {
      pendingApprovals.delete(info.name);
    }
  }

  async function openSession(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    if (!isInitializeRequest(body)) throw new HttpError(400, "Bad Request: no session; send initialize first");
    if (sessions.size >= maxSessions) throw new HttpError(503, "Too many MCP sessions");
    const client = body.params.clientInfo;
    const info: McpClientInfo = {
      name: client.name,
      ...(client.version ? { version: client.version } : {}),
      remoteAddress: req.socket.remoteAddress ?? "",
    };
    if (!(await approve(info))) throw new HttpError(403, `Client "${info.name}" was not approved`);

    const server = createMcpServer({
      controller: opts.controller,
      ...(opts.search ? { search: opts.search } : {}),
      ...(opts.allowEvaluate !== undefined ? { allowEvaluate: opts.allowEvaluate } : {}),
      ...(opts.accessLevel !== undefined ? { accessLevel: opts.accessLevel } : {}),
      ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {}),
      ...(opts.onToolResult ? { onToolResult: opts.onToolResult } : {}),
      ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : {}),
      ...(opts.webscope ? { webscope: opts.webscope } : {}),
      ...(opts.flows ? { flows: opts.flows } : {}),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, lastSeen: Date.now(), openStreams: 0, client: info.name });
      },
    });
    await server.connect(transport);
    server.server.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await transport.handleRequest(req, res, body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (!isAllowedHost(header(req, "host"), port, bindHost)) throw new HttpError(403, "Forbidden: invalid Host header");
    if (!isAllowedOrigin(header(req, "origin"), bindHost)) throw new HttpError(403, "Forbidden: invalid Origin header");
    if (!bearerMatches(header(req, "authorization"), opts.token)) {
      throw new HttpError(401, "Unauthorized", { "www-authenticate": 'Bearer realm="corvus"' });
    }
    if (pathname !== MCP_PATH) throw new HttpError(404, "Not found");

    const method = req.method ?? "";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      throw new HttpError(405, "Method not allowed", { allow: "GET, POST, DELETE" });
    }
    const sessionId = header(req, "mcp-session-id");
    const body = method === "POST" ? await readJsonBody(req, maxBody) : undefined;
    if (!sessionId) {
      if (method !== "POST") throw new HttpError(400, "Bad Request: missing Mcp-Session-Id");
      await openSession(req, res, body);
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) throw new HttpError(404, "Session not found");
    session.lastSeen = Date.now();
    session.openStreams++;
    res.once("close", () => {
      session.openStreams--;
      session.lastSeen = Date.now();
    });
    await session.transport.handleRequest(req, res, body);
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const httpErr = err instanceof HttpError ? err : new HttpError(500, "Internal server error");
      sendError(res, httpErr);
      if (httpErr.status === 413) res.once("finish", () => req.destroy());
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 0, bindHost, () => {
      http.off("error", reject);
      resolve();
    });
  });
  port = (http.address() as AddressInfo).port;

  return {
    port,
    url: `http://${bindHost}:${port}${MCP_PATH}`,
    async close() {
      clearInterval(sweeper);
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map((s) => s.server.close()));
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
    revokeClient(name: string) {
      approvedClients.delete(name);
      for (const [id, session] of sessions) if (session.client === name) closeSession(id, session);
    },
  };
}
