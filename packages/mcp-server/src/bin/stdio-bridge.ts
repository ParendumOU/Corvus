#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startStdioBridge } from "../bridge.js";

/**
 * Connection details. Priority:
 *   1. CORVUS_MCP_URL + CORVUS_MCP_TOKEN environment variables.
 *   2. The discovery file Corvus writes while its MCP server runs: ~/.corvus/mcp.json
 *      (or $CORVUS_HOME/mcp.json). This lets the Claude Code plugin connect with no manual setup.
 * When the file is missing (Corvus not running) the bridge waits and retries, so the plugin can be
 * installed before Corvus is launched.
 */
const discoveryPath = join(process.env.CORVUS_HOME || join(homedir(), ".corvus"), "mcp.json");

interface Discovery {
  url?: string;
  token?: string;
}

async function readDiscovery(): Promise<Discovery | null> {
  try {
    const raw = await readFile(discoveryPath, "utf8");
    const data = JSON.parse(raw) as Discovery;
    if (data.url && data.token) return data;
    return null;
  } catch {
    return null;
  }
}

async function resolve(): Promise<{ url: string; token: string }> {
  const envUrl = process.env.CORVUS_MCP_URL;
  const envToken = process.env.CORVUS_MCP_TOKEN;
  if (envUrl && envToken) return { url: envUrl, token: envToken };

  const deadline = Date.now() + 60_000;
  let warned = false;
  for (;;) {
    const found = await readDiscovery();
    if (found?.url && found.token) return { url: found.url, token: found.token };
    if (!warned) {
      process.stderr.write(`corvus-mcp-stdio: waiting for Corvus (no ${discoveryPath}; is the MCP server enabled in Corvus > Settings > AI agents?)\n`);
      warned = true;
    }
    if (Date.now() > deadline) {
      process.stderr.write("corvus-mcp-stdio: gave up after 60s. Set CORVUS_MCP_URL and CORVUS_MCP_TOKEN, or start Corvus with its MCP server enabled.\n");
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

try {
  const { url, token } = await resolve();
  const bridge = await startStdioBridge({ url, token });
  await bridge.closed;
  process.exit(0);
} catch (err) {
  process.stderr.write(`corvus-mcp-stdio: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
