#!/usr/bin/env node
import { startStdioBridge, type BridgeTarget } from "../bridge.js";
import { CLAUDE_CONFIG_DIR_HEADER } from "../http.js";
import { waitForCorvus } from "../launch.js";

/**
 * Connection details. Priority:
 *   1. CORVUS_MCP_URL + CORVUS_MCP_TOKEN environment variables.
 *   2. The discovery file Corvus writes while its MCP server runs: ~/.corvus/mcp.json
 *      (or $CORVUS_HOME/mcp.json). This lets the Claude Code plugin connect with no manual setup.
 * When no server is found, the bridge starts Corvus (visible, MCP server on) or turns on the running
 * one's server, and waits for it; CORVUS_MCP_NO_LAUNCH=1 only waits. When Corvus restarts or drops
 * the session, the bridge finds it again (starting it if needed) and opens a new session.
 */
const launch = process.env.CORVUS_MCP_NO_LAUNCH !== "1";

// Inside Claude Code (which sets CLAUDECODE=1 for its child processes), tell Corvus which Claude
// Code config folder this session runs under, so Corvus can use the same account if asked to.
const headers: Record<string, string> =
  process.env.CLAUDECODE === "1" ? { [CLAUDE_CONFIG_DIR_HEADER]: encodeURIComponent(process.env.CLAUDE_CONFIG_DIR ?? "") } : {};

function fromEnv(): BridgeTarget | null {
  const url = process.env.CORVUS_MCP_URL;
  const token = process.env.CORVUS_MCP_TOKEN;
  return url && token ? { url, token } : null;
}

try {
  const env = fromEnv();
  const find = async (): Promise<BridgeTarget> => env ?? (await waitForCorvus({ launch }));
  const bridge = await startStdioBridge({ ...(await find()), reconnect: find, headers });
  await bridge.closed;
  process.exit(0);
} catch (err) {
  process.stderr.write(`corvus-mcp-stdio: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
