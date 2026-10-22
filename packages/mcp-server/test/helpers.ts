import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerHandle } from "@corvus/shared";
import { startMcpServer, type StartMcpServerOptions } from "../src/index.js";
import { MockBrowserController } from "../src/testing/index.js";

export const TOKEN = "test-token-0123456789abcdef";

let clientSeq = 0;
export function uniqueClientName(prefix = "test-client"): string {
  clientSeq += 1;
  return `${prefix}-${process.pid}-${clientSeq}`;
}

export interface Harness {
  handle: McpServerHandle;
  controller: MockBrowserController;
  connect(opts?: { name?: string; token?: string }): Promise<Client>;
  close(): Promise<void>;
}

export async function startHarness(
  overrides: Partial<StartMcpServerOptions> = {},
  controller = new MockBrowserController({ initialTabs: ["https://example.com/"] }),
): Promise<Harness> {
  const handle = await startMcpServer({ controller, token: TOKEN, ...overrides });
  const clients: Client[] = [];
  return {
    handle,
    controller,
    async connect(opts = {}) {
      const client = new Client({ name: opts.name ?? uniqueClientName(), version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
        requestInit: { headers: { Authorization: `Bearer ${opts.token ?? TOKEN}` } },
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.allSettled(clients.map((c) => c.close()));
      await handle.close();
    },
  };
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Extracts the JSON payload from an untrusted-wrapped text result. */
export function untrustedJson<T = unknown>(result: CallToolResult): T {
  const match = /<untrusted_page_content source="[^"]*">\n([\s\S]*)\n<\/untrusted_page_content>/.exec(textOf(result));
  if (!match?.[1]) throw new Error(`No untrusted block in: ${textOf(result)}`);
  return JSON.parse(match[1]) as T;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP request so tests can forge Host/Origin headers that fetch would not let us set. */
export function rawRequest(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "POST",
        path: opts.path ?? "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...opts.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

export function initializeBody(name = uniqueClientName("raw")): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1.0.0" } },
  });
}
