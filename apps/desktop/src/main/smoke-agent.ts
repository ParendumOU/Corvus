import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { nativeTheme, type WebContents } from "electron";
import type { AgentModelProvider, AgentTurnRequest, TurnEvent } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import { spendDialog } from "./spend-approvals";
import type { BrowserWindowCtl } from "./window";

/**
 * Command Bar + agent smoke (CORVUS_SMOKE_OUT): opens the palette (light and dark), then runs a
 * scripted task against a local shop page with a fake, no-network provider. Exercises
 * navigate -> snapshot -> click "Buy now" (spends money, so it asks even in auto mode; approved) ->
 * extract, the in-page overlay, the shared timeline and the Stop control, capturing the palette and
 * a running task. Then an MCP client clicks the same "Buy now" through the real MCP server and hits
 * the native spend dialog (answered by the test hook), and reads a page's console and network log.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Corvus Agent Shop</title></head>
<body><main><h1>Corvus Agent Shop</h1>
<p>The Raven travel umbrella is matte-black, wind-tested and folds to 24 cm. It costs 42 dollars and ships worldwide in three days.</p>
<form onsubmit="return false"><input id="q" name="q" placeholder="Search products"><button id="buy" type="button">Buy now</button></form>
<div id="out">idle</div><a href="/next">More products</a></main></body></html>`;

/** Logs to the console and fetches one good and one missing URL shortly after it loads (reading the bodies, so both finish). */
const DEVTOOLS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Corvus Devtools Smoke</title></head>
<body><p>Console and network smoke page.</p><script>
setTimeout(() => {
  console.log("corvus-smoke-log");
  console.error("corvus-smoke-error");
  fetch("/api/ok").then((r) => r.text()).then(() => fetch("/api/missing")).then((r) => r.text());
}, 400);
</script></body></html>`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

/** Finds a button ref by accessible name in the latest snapshot handed to the model. */
function refFor(messages: AgentTurnRequest["messages"], name: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const block of messages[i]!.content) {
      if (block.type === "tool_result" && block.content.includes("elements:")) {
        const match = block.content.match(new RegExp(`(\\be\\d+)\\s+\\w+\\s+"${name}`));
        if (match) return match[1]!;
      }
    }
  }
  return "e1";
}

/** Scripts navigate -> snapshot -> click "Buy now" -> extract, then loops so Stop is needed. */
function fakeProvider(url: string): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *streamTurn(req): AsyncGenerator<TurnEvent> {
      const issued = req.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use")).length;
      const emit = (name: string, input: unknown): TurnEvent => ({ type: "tool_use", id: `c${issued}`, name, input });
      let ev: TurnEvent;
      if (issued === 0) ev = emit("navigate", { url });
      else if (issued === 1) ev = emit("page_snapshot", {});
      else if (issued === 2) ev = emit("click", { ref: refFor(req.messages, "Buy now") });
      else if (issued === 3) ev = emit("extract", {});
      else ev = emit("page_snapshot", {});
      await sleep(30);
      yield ev;
      yield { type: "usage", inputTokens: 180 + issued * 40, outputTokens: 24, model: "claude-haiku-5-5" };
      yield { type: "end", stopReason: "tool_use" };
    },
  };
}

export async function runAgentSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const themeBefore = nativeTheme.themeSource;
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/api/missing" ? 404 : 200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.url === "/devtools" ? DEVTOOLS_PAGE : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const chrome = win.chrome.webContents;
  const runView = () => ctx.agentRunner.windowExtras(win).agentRun;
  const askBefore = ctx.settings.get().agent.askBeforeRisky;

  try {
    // 1. Command palette, light and dark.
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(150);
      win.sendCommand({ type: "open-command-palette" });
      const shown = await poll(chrome, "document.querySelector('.cmdbar .cmd-input') && document.querySelectorAll('.cmdbar .cmd-row').length >= 2");
      check(`command palette (${theme})`, shown, shown ? undefined : await chrome.executeJavaScript("document.querySelector('.cmdbar')?.innerText?.slice(0,200) ?? 'no cmdbar'"));
      await chrome.executeJavaScript("document.querySelector('.cmd-input').value = 'set'; document.querySelector('.cmd-input').dispatchEvent(new Event('input', { bubbles: true }))").catch(() => 0);
      await sleep(150);
      await capture(`command-palette-${theme}`, chrome);
      await chrome.executeJavaScript("document.querySelector('.cmd-input').value = ''; document.querySelector('.cmd-input').dispatchEvent(new Event('input', { bubbles: true }))").catch(() => 0);
    }

    // 2. A scripted agent run in auto mode ("Ask before risky actions" off): "Buy now" spends money,
    //    so the run panel still asks.
    nativeTheme.themeSource = "light";
    ctx.settings.update({ agent: { askBeforeRisky: false } });
    ctx.agentRunner.setTestProvider(fakeProvider(url));
    win.sendCommand({ type: "open-command-palette" });
    await poll(chrome, "document.querySelector('.cmdbar')");
    ctx.agentRunner.start(win, "Buy the Raven travel umbrella");

    const approving = await waitFor(() => runView()?.status === "awaiting-approval", 10000);
    const reason = runView()?.approval?.reason ?? "";
    check("agent spend approval in auto mode", approving && reason.includes("Buy now") && reason.startsWith("Spends money"), runView()?.approval);
    const askedInPanel = await poll(chrome, "(document.querySelector('.cmdbar .run-panel .run-approval')?.innerText || '').includes('Approve this action?')");
    check(
      "run panel shows Approve this action? in auto mode",
      askedInPanel,
      askedInPanel ? undefined : await chrome.executeJavaScript("document.querySelector('.cmdbar .run-panel')?.innerText?.slice(0,200) ?? 'no run panel'"),
    );
    // Assert the RunPanel actually rendered in the renderer. The approval/stepCount checks above read
    // main-process state, which stays healthy even if RunPanel's render throws; on a render crash the
    // DebugBoundary renders null and the whole .cmdbar subtree vanishes. This guards the minifier
    // regression that mangled a RunPanel local to undefined ("c is not a function").
    const approvalRendered = await poll(chrome, "document.querySelector('.cmdbar .run-panel .run-approval .appr-actions .btn')");
    check("RunPanel rendered (approval)", approvalRendered, approvalRendered ? undefined : await chrome.executeJavaScript("document.querySelector('.cmdbar')?.innerText?.slice(0,160) ?? 'cmdbar gone (DebugBoundary rendered null)'"));
    await sleep(150);
    await capture("command-agent-approval", chrome);

    const stepsBefore = runView()?.stepCount ?? 0;
    ctx.agentRunner.approve(win, "approve");
    const progressed = await waitFor(() => (runView()?.stepCount ?? 0) >= stepsBefore + 2, 10000);
    check("agent continues after approval", progressed, { stepCount: runView()?.stepCount });

    // Overlay over the agent tab (cursor/caption) while it works.
    const overlay = ctx.agents.overlayFor(win);
    const owc = overlay.webContents;
    const overlayShown = owc ? await poll(owc, "document.querySelector('.caption.show') || document.querySelector('.cursor.show')", 4000) : false;
    check("agent overlay drawn", overlayShown || (runView()?.stepCount ?? 0) >= 2);
    const stepsRendered = await poll(chrome, "document.querySelector('.cmdbar .run-panel .run-steps .step')");
    check("RunPanel rendered (steps)", stepsRendered, stepsRendered ? undefined : await chrome.executeJavaScript("document.querySelector('.cmdbar')?.innerText?.slice(0,160) ?? 'cmdbar gone (DebugBoundary rendered null)'"));
    await sleep(150);
    await capture("command-agent-run", chrome);
    if (owc && overlayShown) await capture("command-agent-overlay", owc);

    // Shared timeline recorded the run under the "Corvus" client.
    const timeline = ctx.agents.view();
    check("agent timeline recorded", timeline.clients.some((cl) => cl.name === "Corvus") && timeline.calls.length > 0, timeline.clients.map((cl) => cl.name));

    // 3. Stop.
    ctx.agentRunner.stop(win);
    const stopped = await waitFor(() => runView()?.status === "stopped", 5000);
    check("agent stop control", stopped, runView()?.status);

    // 4. An MCP client clicking "Buy now" gets the native spend dialog (answered by the test hook), then
    //    reads a page's console and network log and is offered no tool this build lacks.
    await mcpSpendSmoke(ctx, url, check);
    await mcpBridgeSmoke(ctx, check);
  } finally {
    ctx.settings.update({ agent: { askBeforeRisky: askBefore } });
    nativeTheme.themeSource = themeBefore;
    ctx.agentRunner.stop(win);
    ctx.agentRunner.clear(win);
    ctx.agentRunner.setTestProvider(undefined);
    ctx.agents.setPaused(false);
    win.sendCommand({ type: "close-overlays" });
    server.close();
  }
}

interface McpSession {
  tools(): Promise<string[]>;
  tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
  close(): Promise<void>;
}

/** A bare Streamable HTTP MCP client (fetch + SSE parsing), enough for a few tool calls. */
async function openMcpSession(endpoint: string, token: string, clientName: string): Promise<McpSession> {
  let session = "";
  let protocol = "";
  let seq = 0;
  const headers = (): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(session ? { "mcp-session-id": session } : {}),
    ...(protocol ? { "mcp-protocol-version": protocol } : {}),
  });
  const post = async (body: { id?: number } & Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const res = await fetch(endpoint, { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
    session ||= res.headers.get("mcp-session-id") ?? "";
    const raw = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${raw.slice(0, 200)}`);
    if (body.id === undefined) return null;
    const messages = raw.trim().startsWith("{") ? [raw] : raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    for (const m of messages) {
      const parsed = JSON.parse(m) as Record<string, unknown>;
      if (parsed.id === body.id) return parsed;
    }
    throw new Error(`MCP: no response to request ${body.id}`);
  };
  const init = await post({ id: ++seq, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } } });
  protocol = String((init?.result as { protocolVersion?: string } | undefined)?.protocolVersion ?? "");
  await post({ method: "notifications/initialized" });
  return {
    async tools() {
      const res = await post({ id: ++seq, method: "tools/list", params: {} });
      return ((res?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((t) => t.name);
    },
    async tool(name, args) {
      const res = await post({ id: ++seq, method: "tools/call", params: { name, arguments: args } });
      const error = res?.error as { message?: string } | undefined;
      if (error) throw new Error(error.message ?? "MCP error");
      const result = res?.result as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined;
      return { isError: result?.isError === true, text: (result?.content ?? []).map((c) => c.text ?? "").join("\n") };
    },
    async close() {
      if (session) await fetch(endpoint, { method: "DELETE", headers: headers() }).catch(() => undefined);
    },
  };
}

/**
 * MCP clients have no run panel: a click that spends money gets the browser's native "Allow once /
 * Deny" dialog, at any access level. Drives the real MCP server over HTTP against the shop page, then
 * runs the console/network checks on the same session (restarting the server between the two would
 * leave fetch holding keep-alive sockets to the old one).
 */
async function mcpSpendSmoke(ctx: AppContext, shopUrl: string, check: Helpers["check"]): Promise<void> {
  const clientName = "corvus-smoke-spend";
  const before = ctx.settings.get().mcp;
  const prompts: string[] = [];
  let allow = true;
  ctx.spendApprovals.setTestApprover((p) => {
    prompts.push(spendDialog(p).message);
    return allow;
  });
  let session: McpSession | null = null;
  let tabId = "";
  try {
    ctx.settings.update({ mcp: { enabled: true, accessLevel: "standard", allowEvaluate: false, approvedClients: [...before.approvedClients.filter((c) => c !== clientName), clientName] } });
    await ctx.mcp.apply();
    const status = ctx.mcp.status();
    if (!status.running || !status.port || !status.token) {
      check("MCP spend: server running", false, { running: status.running, port: status.port, error: status.error });
      return;
    }
    session = await openMcpSession(`http://127.0.0.1:${status.port}/mcp`, status.token, clientName);
    const opened = await session.tool("tab_open", { url: shopUrl });
    tabId = /"id":"([^"]+)"/.exec(opened.text)?.[1] ?? "";
    const snapshot = await session.tool("page_snapshot", { tabId });
    const buyRef = /\b(e\d+) button "Buy now"/.exec(snapshot.text)?.[1] ?? "";
    const linkRef = /\b(e\d+) link "More products"/.exec(snapshot.text)?.[1] ?? "";
    check("MCP spend: snapshot lists Buy now", Boolean(tabId && buyRef && linkRef), { tabId, buyRef, linkRef });

    const host = new URL(shopUrl).host;
    const allowed = await session.tool("click", { ref: buyRef, tabId });
    check(
      "MCP click on Buy now hits the spend dialog (allowed once)",
      prompts.length === 1 && prompts[0] === `An AI client wants to spend money: Click "Buy now" on ${host}.` && !allowed.isError && allowed.text === "ok",
      { prompts, allowed },
    );
    allow = false;
    const denied = await session.tool("click", { ref: buyRef, tabId });
    check("MCP spend: Deny returns a tool error", prompts.length === 2 && denied.isError && denied.text.includes("The user declined"), { prompts, denied });
    const plain = await session.tool("click", { ref: linkRef, tabId });
    check("MCP spend: a plain link click does not ask", prompts.length === 2 && !plain.isError, { prompts, plain });

    await mcpDevtoolsChecks(session, shopUrl, check);
  } catch (err) {
    check("MCP spend smoke", false, errorDetail(err));
  } finally {
    if (session && tabId) await session.tool("tab_close", { tabId }).catch(() => undefined);
    await session?.close();
    ctx.spendApprovals.setTestApprover(null);
    ctx.settings.update({ mcp: { enabled: before.enabled, accessLevel: before.accessLevel, allowEvaluate: before.allowEvaluate, approvedClients: before.approvedClients } });
    await ctx.mcp.apply();
  }
}

/**
 * The stdio bridge agents use: --enable-mcp turns the server on, the bridge finds it through the
 * discovery file, and when the server restarts (sessions gone) it opens a new session by itself.
 */
async function mcpBridgeSmoke(ctx: AppContext, check: Helpers["check"]): Promise<void> {
  const clientName = "corvus-smoke-bridge";
  const before = ctx.settings.get().mcp;
  const bin = path.resolve(process.cwd(), "../../packages/mcp-server/dist/bin/stdio-bridge.js");
  const home = process.env.CORVUS_HOME || path.join(os.homedir(), ".corvus");
  const accountDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-account-"));
  let child: ReturnType<typeof spawn> | null = null;
  try {
    ctx.settings.update({ mcp: { enabled: false, accessLevel: "standard", approvedClients: [...before.approvedClients.filter((c) => c !== clientName), clientName] } });
    await ctx.mcp.apply();
    ctx.mcp.enableFromArgv(["corvus", "--ignored"]);
    await ctx.mcp.apply();
    check("MCP bridge: other switches leave the server off", !ctx.mcp.isRunning());
    ctx.mcp.enableFromArgv(["corvus", "--enable-mcp"]);
    await ctx.mcp.apply();
    const discovery = JSON.parse(fs.readFileSync(path.join(home, "mcp.json"), "utf8")) as { url?: string; pid?: number };
    check("MCP bridge: --enable-mcp starts the server and writes discovery", ctx.mcp.isRunning() && ctx.settings.get().mcp.enabled && discovery.pid === process.pid, {
      running: ctx.mcp.isRunning(),
      url: discovery.url,
    });

    // Electron runs the built bridge as plain Node; CORVUS_MCP_NO_LAUNCH keeps it from starting Corvus.
    child = spawn(process.execPath, [bin], {
      // As inside Claude Code started for another account (the way account switchers do it).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CORVUS_HOME: home, CORVUS_MCP_NO_LAUNCH: "1", CLAUDECODE: "1", CLAUDE_CONFIG_DIR: accountDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: unknown[] = [];
    const waiters: Array<() => void> = [];
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
        waiters.splice(0).forEach((w) => w());
      }
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const send = (m: unknown) => child?.stdin?.write(`${JSON.stringify(m)}\n`);
    const reply = async (id: number): Promise<{ result?: { content?: Array<{ text?: string }> }; error?: { message: string } }> => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const found = lines.find((l) => (l as { id?: number }).id === id);
        if (found) return found as { result?: { content?: Array<{ text?: string }> }; error?: { message: string } };
        if (Date.now() > deadline) throw new Error(`no answer to ${id}; stderr: ${stderr.slice(-400)}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 250);
        });
      }
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } } });
    const init = await reply(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tabs_list", arguments: {} } });
    const first = await reply(2);
    check("MCP bridge: connects through the discovery file", !init.error && !first.error && Boolean(first.result?.content?.[0]?.text), { init: init.error, first: first.error ?? first.result?.content?.[0]?.text?.slice(0, 80) });
    const followed = ctx.settings.get().ai;
    check(
      "MCP bridge: Corvus learns the Claude Code account folder of the session",
      followed.mcpClaudeConfigDir === accountDir && followed.mcpClaudeClient === clientName && followed.mcpClaudeAt > 0,
      { dir: followed.mcpClaudeConfigDir, client: followed.mcpClaudeClient },
    );

    // A restart of the server drops every session, as a browser restart does.
    ctx.settings.update({ mcp: { enabled: false } });
    await ctx.mcp.apply();
    ctx.settings.update({ mcp: { enabled: true } });
    await ctx.mcp.apply();
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tabs_list", arguments: {} } });
    const after = await reply(3);
    const relisted = lines.some((l) => (l as { method?: string }).method === "notifications/tools/list_changed");
    check("MCP bridge: reconnects by itself after the server restarts", !after.error && Boolean(after.result?.content?.[0]?.text) && relisted, {
      error: after.error,
      relisted,
      stderr: stderr.slice(-300),
    });
  } catch (err) {
    check("MCP bridge smoke", false, errorDetail(err));
  } finally {
    child?.stdin?.end();
    child?.kill();
    ctx.settings.update({ mcp: { enabled: before.enabled, accessLevel: before.accessLevel, approvedClients: before.approvedClients } });
    await ctx.mcp.apply();
  }
}

function errorDetail(err: unknown): string {
  const e = err as Error & { cause?: unknown };
  const cause = e.cause instanceof Error ? e.cause.message : e.cause !== undefined ? String(e.cause) : "";
  return cause ? `${e.message}: ${cause}` : String(e.message ?? err);
}

/**
 * console_messages and network_requests run on the desktop controller's per-tab logs (recording
 * starts when the agent opens the tab), and tools whose capability this build lacks are not offered.
 */
async function mcpDevtoolsChecks(session: McpSession, baseUrl: string, check: Helpers["check"]): Promise<void> {
  let tabId = "";
  try {
    const names = await session.tools();
    check("MCP offers console_messages and network_requests", names.includes("console_messages") && names.includes("network_requests"), names);
    const unsupported = ["find", "wait_for", "get_text", "click_at", "handle_dialog"].filter((n) => names.includes(n));
    check("MCP does not offer tools this build cannot run", unsupported.length === 0, unsupported);

    const opened = await session.tool("tab_open", { url: `${baseUrl}devtools` });
    tabId = /"id":"([^"]+)"/.exec(opened.text)?.[1] ?? "";
    let network = { isError: true, text: "" };
    for (const until = Date.now() + 8000; Date.now() < until; await sleep(200)) {
      network = await session.tool("network_requests", { tabId });
      if (network.isError || /404 fetch \S+ \d+ms \S*\/api\/missing/.test(network.text)) break;
    }
    check(
      "MCP network_requests lists the page's fetches with status, size and time",
      !network.isError && /GET 200 fetch \d[\d.]*k?B \d+ms \S*\/api\/ok/.test(network.text) && /GET 404 fetch \d[\d.]*k?B \d+ms \S*\/api\/missing/.test(network.text),
      network.text.slice(-600),
    );
    const failed = await session.tool("network_requests", { tabId, failedOnly: true });
    check("MCP network_requests failedOnly", !failed.isError && failed.text.includes("/api/missing") && !failed.text.includes("/api/ok"), failed.text.slice(-400));

    const logs = await session.tool("console_messages", { tabId });
    check("MCP console_messages lists the page's logs", !logs.isError && logs.text.includes("[info] corvus-smoke-log") && logs.text.includes("[error] corvus-smoke-error"), logs.text.slice(-600));
    const errors = await session.tool("console_messages", { tabId, level: "error", clear: true });
    const cleared = await session.tool("console_messages", { tabId });
    check(
      "MCP console_messages level filter and clear",
      errors.text.includes("corvus-smoke-error") && !errors.text.includes("corvus-smoke-log") && cleared.text.includes("no messages"),
      { errors: errors.text.slice(-300), cleared: cleared.text.slice(-200) },
    );
  } catch (err) {
    check("MCP devtools smoke", false, errorDetail(err));
  } finally {
    if (tabId) await session.tool("tab_close", { tabId }).catch(() => undefined);
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(60);
  }
  return false;
}
