import http from "node:http";
import type { AddressInfo } from "node:net";
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
 * the native spend dialog (answered by the test hook).
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
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
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

    // 4. An MCP client clicking "Buy now" gets the native spend dialog (answered by the test hook).
    await mcpSpendSmoke(ctx, url, check);
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
 * Deny" dialog, at any access level. Drives the real MCP server over HTTP against the shop page.
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
  } catch (err) {
    check("MCP spend smoke", false, (err as Error).message);
  } finally {
    if (session && tabId) await session.tool("tab_close", { tabId }).catch(() => undefined);
    await session?.close();
    ctx.spendApprovals.setTestApprover(null);
    ctx.settings.update({ mcp: { enabled: before.enabled, accessLevel: before.accessLevel, allowEvaluate: before.allowEvaluate, approvedClients: before.approvedClients } });
    await ctx.mcp.apply();
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
