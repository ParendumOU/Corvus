#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { startMcpServer } from "../http.js";
import { MockBrowserController, MockSearchEngine } from "../testing/index.js";

const token = process.env.CORVUS_MCP_TOKEN || randomBytes(24).toString("base64url");
const port = Number(process.env.CORVUS_MCP_PORT ?? 0);
const allowEvaluate = process.env.CORVUS_MCP_ALLOW_EVALUATE === "1";

const controller = new MockBrowserController({
  initialTabs: ["https://example.com/", "https://news.ycombinator.com/"],
  bookmarks: [{ title: "Example", url: "https://example.com/", parentId: null }],
  ...(allowEvaluate ? { evaluate: (_id: string, expression: string) => ({ echo: expression }) } : {}),
});

const handle = await startMcpServer({
  controller,
  search: new MockSearchEngine(),
  token,
  port,
  allowEvaluate,
  onClientConnect: async (info) => {
    process.stderr.write(`client connected: ${info.name}${info.version ? ` ${info.version}` : ""} from ${info.remoteAddress}\n`);
    return true;
  },
  onToolCall: (e) => process.stderr.write(`${new Date(e.at).toISOString()} ${e.client} -> ${e.tool} ${JSON.stringify(e.args)}\n`),
});

process.stderr.write(
  [
    `Corvus MCP dev server (mock browser) listening on ${handle.url}`,
    `Token: ${token}`,
    `Claude Code: claude mcp add --transport http corvus ${handle.url} --header "Authorization: Bearer ${token}"`,
    "",
  ].join("\n"),
);

const shutdown = () => void handle.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
