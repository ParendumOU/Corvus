import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { dialog, nativeTheme, type WebContents } from "electron";
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

/** Form controls for the MCP element tools (check, select_option, fill_form, hover, focus). */
const FORM_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Corvus Form Smoke</title></head>
<body><main><h1>Corvus Form Smoke</h1>
<label><input type="checkbox" id="news"> Send me news</label>
<label for="size">Size</label><select id="size"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>
<label for="name">Name</label><input id="name">
<label for="note">Note</label><textarea id="note"></textarea>
<button id="hov" type="button" onmouseenter="this.textContent='Hovered'">Hover me</button>
<label for="doc">Attachment</label><input type="file" id="doc" onchange="document.getElementById('files').textContent = Array.from(this.files).map((f) => f.name).join(',')">
<div id="files">no files</div>
</main></body></html>`;

/** A button inside a frame (loaded same-origin and, through "localhost", from another origin). */
const FRAME_INNER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inner</title></head>
<body><button id="inner" type="button" onclick="this.textContent = 'Clicked inside'">Inner button</button></body></html>`;

/** Buttons that open confirm() and alert() and write what the page got back. */
const DIALOG_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Corvus Dialog Smoke</title></head>
<body><main><h1>Dialogs</h1>
<button type="button" onclick="document.getElementById('out').textContent = confirm('Delete this note?') ? 'Answer: deleted' : 'Answer: kept'">Delete note</button>
<button type="button" onclick="document.getElementById('out').textContent = confirm('Buy the Raven umbrella for $42?') ? 'Answer: bought' : 'Answer: not bought'">Umbrella</button>
<button type="button" onclick="alert('Saved'); document.getElementById('out').textContent = 'Answer: after alert'">Save</button>
<p id="out">Answer: none</p>
</main></body></html>`;

/** One same-origin and one cross-origin iframe. */
function framesPage(port: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Corvus Frames Smoke</title></head>
<body><main><h1>Frames</h1>
<iframe src="/frame-inner" title="Same origin" width="320" height="90"></iframe>
<iframe src="http://localhost:${port}/frame-inner" title="Other origin" width="320" height="90"></iframe>
</main></body></html>`;
}

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
    const port = req.socket.localPort ?? 0;
    res.end(
      req.url === "/devtools"
        ? DEVTOOLS_PAGE
        : req.url === "/form"
          ? FORM_PAGE
          : req.url === "/frames"
            ? framesPage(port)
            : req.url === "/frame-inner"
              ? FRAME_INNER
              : req.url === "/dialogs"
                ? DIALOG_PAGE
                : PAGE,
    );
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

    // 1b. An address opened from the bar is remembered: it shows under "Recent" when the bar opens
    //     empty again, and its × forgets it.
    await commandBarRecentChecks(win, chrome, url, check);

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
    const stepsRendered = await poll(chrome, "[...document.querySelectorAll('.cmdbar .run-panel .run-steps .step-name')].some((n) => /^(Opened|Read the page)/.test(n.textContent))");
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

export interface McpSession {
  tools(): Promise<string[]>;
  tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
  close(): Promise<void>;
}

/** A bare Streamable HTTP MCP client (fetch + SSE parsing), enough for a few tool calls. */
export async function openMcpSession(endpoint: string, token: string, clientName: string): Promise<McpSession> {
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
  const initialize = { method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } } };
  // After a server restart on the same port, fetch may first pick a pooled socket the old server closed.
  const init = await post({ id: ++seq, ...initialize }).catch(async (err: unknown) => {
    if (!(err instanceof TypeError)) throw err;
    await sleep(200);
    return post({ id: ++seq, ...initialize });
  });
  protocol = String((init?.result as { protocolVersion?: string } | undefined)?.protocolVersion ?? "");
  await post({ method: "notifications/initialized" });
  return {
    async tools() {
      const res = await post({ id: ++seq, method: "tools/list", params: {} });
      return ((res?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((t) => t.name);
    },
    async tool(name, args) {
      for (let attempt = 0; ; attempt++) {
        const res = await post({ id: ++seq, method: "tools/call", params: { name, arguments: args } });
        const error = res?.error as { message?: string } | undefined;
        if (error) throw new Error(error.message ?? "MCP error");
        const result = res?.result as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined;
        const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
        // The server's rate limit (a burst of 30, then 5 calls a second): wait as it says, like a client would.
        const wait = result?.isError === true ? /^Rate limit exceeded; retry in (\d+)s/.exec(text) : null;
        if (wait && attempt < 3) {
          await sleep(Number(wait[1]) * 1000);
          continue;
        }
        return { isError: result?.isError === true, text };
      }
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

    // Coordinates: boxes from the snapshot, a screenshot sized in CSS px, and the same spend dialog.
    await session.tool("navigate", { url: shopUrl, tabId });
    const boxed = await session.tool("page_snapshot", { tabId, boxes: true, maxChars: 0 });
    const center = (pattern: string): { x: number; y: number } | null => {
      const m = new RegExp(`\\b(e\\d+) ${pattern}[^\\n]*@(-?\\d+),(-?\\d+),(\\d+),(\\d+)`).exec(boxed.text);
      return m ? { x: Number(m[2]) + Number(m[4]) / 2, y: Number(m[3]) + Number(m[5]) / 2 } : null;
    };
    const buy = center('button "Buy now"');
    const field = center('(?:textbox|searchbox) "Search products"');
    const shot = await session.tool("screenshot", { tabId });
    const names = await session.tools();
    check(
      "MCP offers coordinate tools with boxes and a CSS-sized screenshot",
      ["click_at", "double_click_at", "right_click_at", "hover_at", "drag", "scroll_at", "press_keys", "type_text"].every((n) => names.includes(n)) &&
        Boolean(buy && field) &&
        /"scale":1\b/.test(shot.text) &&
        /"image":"\d+x\d+"/.test(shot.text),
      { buy, field, shot: shot.text.slice(0, 300) },
    );
    allow = true;
    const coordBuy = buy ? await session.tool("click_at", { tabId, x: buy.x, y: buy.y }) : { isError: true, text: "no box" };
    check(
      "MCP click_at on Buy now hits the spend dialog too (allowed once)",
      prompts.length === 3 && prompts[2] === `An AI client wants to spend money: Click "Buy now" on ${host}.` && !coordBuy.isError,
      { prompts, coordBuy },
    );
    allow = false;
    const coordDenied = buy ? await session.tool("click_at", { tabId, x: buy.x, y: buy.y }) : { isError: false, text: "no box" };
    const right = buy ? await session.tool("right_click_at", { tabId, x: buy.x, y: buy.y }) : { isError: true, text: "no box" };
    check("MCP click_at: Deny refuses; a right click does not ask", prompts.length === 4 && coordDenied.isError && coordDenied.text.includes("The user declined") && !right.isError, {
      prompts,
      coordDenied,
      right,
    });
    if (field) await session.tool("click_at", { tabId, x: field.x, y: field.y });
    const typed = await session.tool("type_text", { tabId, text: "umbrella" });
    const pressed = await session.tool("press_keys", { tabId, keys: ["Space", "Enter"] });
    const after = await session.tool("page_snapshot", { tabId, maxChars: 0 });
    check(
      "MCP click_at + type_text + press_keys type into the field without asking",
      prompts.length === 4 && !typed.isError && !pressed.isError && /"Search products"[^\n]*="umbrella ?"/.test(after.text),
      { typed, pressed, after: after.text.slice(-400) },
    );

    await mcpReadChecks(session, tabId, check);
    await mcpFormChecks(session, shopUrl, check);
    await mcpFrameChecks(session, shopUrl, check);
    await mcpDialogChecks(session, shopUrl, check, {
      prompts,
      allow: (yes) => {
        allow = yes;
      },
    });
    allow = true;

    // request_user_action: the person is asked (answered here by the test hook), Done then Cancel.
    const handoff: string[] = [];
    ctx.userActions.setTestAnswer((p) => {
      handoff.push(`${p.client}|${p.host}|${p.message}`);
      return handoff.length === 1 ? "done" : "cancelled";
    });
    const handled = await session.tool("request_user_action", { tabId, message: "Sign in to your account", timeoutSeconds: 30 });
    const declined = await session.tool("request_user_action", { tabId, message: "Enter the code we sent you", timeoutSeconds: 30 });
    ctx.userActions.setTestAnswer(null);
    check(
      "MCP request_user_action asks the person in the tab (Done, then Cancel)",
      handled.text.startsWith("done:") && declined.text.startsWith("cancelled:") && handoff[0] === `${clientName}|${host}|Sign in to your account`,
      { handled: handled.text, declined: declined.text, handoff },
    );

    await mcpDevtoolsChecks(session, shopUrl, check);
    // The full-access checks restart the server with another level: this session ends first.
    await session.tool("tab_close", { tabId }).catch(() => undefined);
    await session.close();
    session = null;
    await mcpFullChecks(ctx, shopUrl, check);
    await mcpActivityChecks(ctx, clientName, check);
  } catch (err) {
    check("MCP spend smoke", false, errorDetail(err));
  } finally {
    if (session && tabId) await session.tool("tab_close", { tabId }).catch(() => undefined);
    await session?.close();
    ctx.spendApprovals.setTestApprover(null);
    ctx.userActions.setTestAnswer(null);
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
 * The activity log in Settings > AI agents: the spend session's calls are there with their site and
 * outcome (a declined spend as an error with its reason), and with the strict rate limit a burst of
 * calls shows up as calls over the limit.
 */
async function mcpActivityChecks(ctx: AppContext, spendClient: string, check: Helpers["check"]): Promise<void> {
  const clientName = "corvus-smoke-limit";
  const before = ctx.settings.get().mcp;
  let session: McpSession | null = null;
  try {
    const calls = ctx.mcp.audit.list({ client: spendClient, limit: 1000 });
    const click = calls.find((e) => e.tool === "click" && e.outcome === "ok");
    const declined = calls.find((e) => e.outcome === "error" && (e.error ?? "").includes("The user declined"));
    check(
      "MCP activity log keeps each call's tool, site and outcome (a declined spend with its reason), never page text",
      /^127\.0\.0\.1:\d+$/.test(click?.host ?? "") && Boolean(declined) && calls.every((e) => !(e.error ?? "").includes("untrusted_page_content")),
      { click, declined, count: calls.length },
    );

    ctx.settings.update({ mcp: { enabled: true, accessLevel: "standard", rateLimit: "strict", approvedClients: [...before.approvedClients.filter((c) => c !== clientName), clientName] } });
    await ctx.mcp.apply();
    const status = ctx.mcp.status();
    session = await openMcpSession(`http://127.0.0.1:${status.port}/mcp`, status.token ?? "", clientName);
    for (let i = 0; i < 13; i++) await session.tool("tabs_list", {});
    const view = ctx.mcp.activityView({ client: clientName, problemsOnly: true });
    const limited = view.entries.filter((e) => e.outcome === "rate-limited");
    const row = view.summary.find((s) => s.tool === "tabs_list");
    check(
      "MCP strict rate limit: a burst goes over the limit and the activity log counts it",
      limited.length >= 1 && (row?.rateLimited ?? 0) >= limited.length && /^Rate limit exceeded/.test(limited[0]?.error ?? ""),
      { limited: limited.length, row },
    );
  } catch (err) {
    check("MCP activity log smoke", false, errorDetail(err));
  } finally {
    await session?.close();
    ctx.settings.update({ mcp: { enabled: before.enabled, accessLevel: before.accessLevel, rateLimit: before.rateLimit, approvedClients: before.approvedClients } });
    await ctx.mcp.apply();
  }
}

/** Full access: upload_file onto a file input, pdf into the downloads folder, downloads_list. */
async function mcpFullChecks(ctx: AppContext, baseUrl: string, check: Helpers["check"]): Promise<void> {
  const clientName = "corvus-smoke-full";
  const before = ctx.settings.get().mcp;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-upload-"));
  const file = path.join(dir, "raven-notes.txt");
  fs.writeFileSync(file, "Ravens are clever.");
  let session: McpSession | null = null;
  let tabId = "";
  let pdfPath = "";
  try {
    ctx.settings.update({ mcp: { enabled: true, accessLevel: "full", approvedClients: [...before.approvedClients.filter((c) => c !== clientName), clientName] } });
    await ctx.mcp.apply();
    const status = ctx.mcp.status();
    session = await openMcpSession(`http://127.0.0.1:${status.port}/mcp`, status.token ?? "", clientName);
    const opened = await session.tool("tab_open", { url: `${baseUrl}form` });
    tabId = /"id":"([^"]+)"/.exec(opened.text)?.[1] ?? "";
    const snap = await session.tool("page_snapshot", { tabId, maxChars: 0 });
    const doc = /\b(e\d+) textbox "Attachment"/.exec(snap.text)?.[1] ?? "";
    const uploaded = await session.tool("upload_file", { tabId, ref: doc, paths: [file] });
    const shown = await session.tool("wait_for", { tabId, text: "raven-notes.txt", timeoutMs: 3000 });
    const program = await session.tool("upload_file", { tabId, ref: doc, paths: [path.join(dir, "setup.exe")] });
    check(
      "MCP upload_file puts a local file on a file input (full access); refuses missing files",
      Boolean(doc) && uploaded.text === "uploaded 1 file(s)" && !shown.isError && program.isError,
      { doc, uploaded: uploaded.text, shown: shown.text.slice(-120), program: program.text.slice(-160) },
    );
    const printed = await session.tool("pdf", { tabId });
    pdfPath = /"path":"((?:[^"\\]|\\.)*)"/.exec(printed.text)?.[1]?.replace(/\\\\/g, "\\") ?? "";
    const listed = await session.tool("downloads_list", { limit: 5 });
    check(
      "MCP pdf saves the page into the downloads folder; downloads_list answers",
      !printed.isError && Boolean(pdfPath) && fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 500 && !listed.isError,
      { printed: printed.text.slice(-200), listed: listed.text.slice(-200) },
    );
  } catch (err) {
    check("MCP full-access smoke", false, errorDetail(err));
  } finally {
    if (session && tabId) await session.tool("tab_close", { tabId }).catch(() => undefined);
    await session?.close();
    if (pdfPath) fs.rmSync(pdfPath, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    ctx.settings.update({ mcp: { enabled: before.enabled, accessLevel: before.accessLevel, approvedClients: before.approvedClients } });
    await ctx.mcp.apply();
  }
}

/** The Command Bar's "Recent" list: what Enter opened from the bar comes back there, and × forgets it. */
async function commandBarRecentChecks(win: BrowserWindowCtl, chrome: WebContents, url: string, check: Helpers["check"]): Promise<void> {
  const typeInBar = (text: string): string =>
    `(() => { const el = document.querySelector('.cmd-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
  try {
    win.profile.commands.clear();
    win.sendCommand({ type: "open-command-palette" });
    await poll(chrome, "document.querySelector('.cmdbar .cmd-input')");
    await chrome.executeJavaScript(typeInBar(url));
    await poll(chrome, `(document.querySelector('.cmd-row.sel .cmd-title')?.textContent || '').includes(${JSON.stringify(url)})`);
    await chrome.executeJavaScript("document.querySelector('.cmd-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    const remembered = await waitFor(() => win.profile.commands.list()[0]?.text === url, 3000);
    await poll(chrome, "!document.querySelector('.cmdbar')");
    win.sendCommand({ type: "open-command-palette" });
    const listed = await poll(
      chrome,
      `document.querySelector('.cmd-section')?.textContent === 'Recent' && document.querySelector('.cmd-row .cmd-title')?.textContent === ${JSON.stringify(url)}`,
    );
    await chrome.executeJavaScript("document.querySelector('.cmd-row .cmd-forget')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
    const forgotten = await waitFor(() => win.profile.commands.list().length === 0, 3000);
    const gone = await poll(chrome, "!document.querySelector('.cmd-section') || document.querySelector('.cmd-section').textContent !== 'Recent'");
    check("Command Bar remembers an address it opened, lists it under Recent and forgets it with ×", remembered && listed && forgotten && gone, {
      remembered,
      listed,
      forgotten,
      gone,
      recents: win.profile.commands.list().map((r) => r.text),
    });
  } catch (err) {
    check("Command Bar recent smoke", false, errorDetail(err));
  } finally {
    win.sendCommand({ type: "close-overlays" });
    win.profile.commands.clear();
  }
}

/**
 * Page dialogs over MCP: a click that opens confirm() leaves the page waiting, page_snapshot shows
 * the question, other actions are refused until handle_dialog answers it (and the native box the
 * person sees closes), and accepting a question that spends money asks the person first.
 */
async function mcpDialogChecks(
  session: McpSession,
  baseUrl: string,
  check: Helpers["check"],
  spend: { prompts: string[]; allow: (yes: boolean) => void },
): Promise<void> {
  let tabId = "";
  // Electron opens the native box through dialog.showMessageBox: watch it to see it closed.
  const boxes: Array<{ message: string; signal?: AbortSignal }> = [];
  const showMessageBox = dialog.showMessageBox;
  let spied = false;
  try {
    const spy = ((...args: unknown[]) => {
      const options = args.find((a): a is Electron.MessageBoxOptions => typeof a === "object" && a !== null && "message" in a);
      if (options) boxes.push({ message: options.message, ...(options.signal ? { signal: options.signal } : {}) });
      return (showMessageBox as (...a: unknown[]) => unknown).apply(dialog, args);
    }) as typeof dialog.showMessageBox;
    dialog.showMessageBox = spy;
    spied = dialog.showMessageBox === spy;
  } catch {
    spied = false;
  }
  try {
    const opened = await session.tool("tab_open", { url: `${baseUrl}dialogs` });
    tabId = /"id":"([^"]+)"/.exec(opened.text)?.[1] ?? "";
    const snap = await session.tool("page_snapshot", { tabId, maxChars: 0 });
    const ref = (name: string): string => new RegExp(`\\b(e\\d+) button "${name}"`).exec(snap.text)?.[1] ?? "";
    const [ask, buy, save] = [ref("Delete note"), ref("Umbrella"), ref("Save")];
    // A click whose page answer waits on a dialog: the click itself may report the dialog.
    const openWith = async (button: string): Promise<string> => {
      await session.tool("click", { tabId, ref: button });
      let text = "";
      for (const until = Date.now() + 5000; Date.now() < until; await sleep(150)) {
        text = (await session.tool("page_snapshot", { tabId, maxChars: 0 })).text;
        if (text.includes('"dialog":')) break;
      }
      return text;
    };
    const answerShown = async (answer: string): Promise<boolean> => {
      for (const until = Date.now() + 3000; Date.now() < until; await sleep(150)) {
        if ((await session.tool("page_snapshot", { tabId, maxChars: 2000 })).text.includes(`Answer: ${answer}`)) return true;
      }
      return false;
    };
    const closed = (): boolean => !spied || boxes.every((b) => b.signal?.aborted === true);

    const asked = await openWith(ask);
    const accepted = await session.tool("handle_dialog", { tabId, accept: true });
    check(
      "MCP page_snapshot shows the confirm() a click opened; handle_dialog accepts it and closes the native box",
      asked.includes('"dialog":{"type":"confirm","message":"Delete this note?"}') && !accepted.isError && (await answerShown("deleted")) && closed(),
      { asked: asked.slice(-300), accepted: accepted.text.slice(-160), spied, boxes: boxes.map((b) => [b.message, b.signal?.aborted]) },
    );

    await openWith(ask);
    const blocked = await session.tool("click", { tabId, ref: save });
    const dismissed = await session.tool("handle_dialog", { tabId, accept: false });
    check(
      "MCP refuses other actions while a dialog waits; handle_dialog dismisses it",
      blocked.isError && blocked.text.includes("dialog open") && !dismissed.isError && (await answerShown("kept")) && closed(),
      { blocked: blocked.text.slice(-200), dismissed: dismissed.text.slice(-160) },
    );

    const before = spend.prompts.length;
    spend.allow(false);
    const buying = await openWith(buy);
    const refused = await session.tool("handle_dialog", { tabId, accept: true });
    const still = (await session.tool("page_snapshot", { tabId, maxChars: 0 })).text;
    await session.tool("handle_dialog", { tabId, accept: false });
    spend.allow(true);
    const asks = spend.prompts.slice(before);
    check(
      "MCP handle_dialog asks before accepting a question that spends; Deny keeps it open",
      buying.includes("Buy the Raven umbrella for $42?") &&
        refused.isError &&
        asks.length === 1 &&
        asks[0]!.includes(`Answer OK to the page's question "Buy the Raven umbrella for $42?"`) &&
        still.includes('"dialog":') &&
        (await answerShown("not bought")),
      { refused: refused.text.slice(-200), asks },
    );

    const saving = await openWith(save);
    const ok = await session.tool("handle_dialog", { tabId, accept: true });
    check(
      "MCP handle_dialog answers alert()",
      saving.includes('"dialog":{"type":"alert","message":"Saved"}') && !ok.isError && (await answerShown("after alert")) && closed(),
      { saving: saving.slice(-200), ok: ok.text.slice(-160) },
    );
  } catch (err) {
    check("MCP dialog smoke", false, errorDetail(err));
  } finally {
    if (spied) dialog.showMessageBox = showMessageBox;
    if (tabId) {
      // Never leave a page waiting on a dialog behind.
      await session.tool("handle_dialog", { tabId, accept: false }).catch(() => undefined);
      await session.tool("tab_close", { tabId }).catch(() => undefined);
    }
  }
}

/**
 * Frames over MCP: page_snapshot lists the controls of a same-origin frame with refs a click
 * reaches (the click point includes the frame's offset), and a cross-origin frame as a "frame".
 */
async function mcpFrameChecks(session: McpSession, baseUrl: string, check: Helpers["check"]): Promise<void> {
  let tabId = "";
  try {
    const opened = await session.tool("tab_open", { url: `${baseUrl}frames` });
    tabId = /"id":"([^"]+)"/.exec(opened.text)?.[1] ?? "";
    let snap = { isError: true, text: "" };
    for (const until = Date.now() + 8000; Date.now() < until; await sleep(200)) {
      snap = await session.tool("page_snapshot", { tabId, maxChars: 0, boxes: true });
      if (snap.text.includes('button "Inner button"') && snap.text.includes('frame "Other origin"')) break;
    }
    const inner = /\b(e\d+) button "Inner button"/.exec(snap.text)?.[1] ?? "";
    const other = /\be\d+ frame "Other origin" \[cross-origin\]/.test(snap.text);
    const clicked = inner ? await session.tool("click", { tabId, ref: inner }) : { isError: true, text: "no ref" };
    let after = { isError: true, text: "" };
    for (const until = Date.now() + 3000; Date.now() < until; await sleep(150)) {
      after = await session.tool("page_snapshot", { tabId, maxChars: 0 });
      if (after.text.includes('button "Clicked inside"')) break;
    }
    check(
      "MCP page_snapshot reaches into a same-origin frame (clickable ref) and lists a cross-origin frame",
      Boolean(inner) && other && !clicked.isError && after.text.includes('button "Clicked inside"'),
      { inner, other, clicked: clicked.text, snap: snap.text.slice(-400), after: after.text.slice(-300) },
    );
  } catch (err) {
    check("MCP frame smoke", false, errorDetail(err));
  } finally {
    if (tabId) await session.tool("tab_close", { tabId }).catch(() => undefined);
  }
}

/** check, select_option, fill_form, focus and hover over MCP on a form page. */
async function mcpFormChecks(session: McpSession, baseUrl: string, check: Helpers["check"]): Promise<void> {
  let tabId = "";
  try {
    const opened = await session.tool("tab_open", { url: `${baseUrl}form` });
    tabId = /"id":"([^"]+)"/.exec(opened.text)?.[1] ?? "";
    const snap = await session.tool("page_snapshot", { tabId, maxChars: 0 });
    const ref = (pattern: string): string => new RegExp(`\\b(e\\d+) ${pattern}`).exec(snap.text)?.[1] ?? "";
    const news = ref('checkbox "Send me news"');
    const size = ref('combobox "Size"');
    const name = ref('textbox "Name"');
    const note = ref('textbox "Note"');
    const hov = ref('button "Hover me"');
    const checked = await session.tool("check", { tabId, ref: news, checked: true });
    const selected = await session.tool("select_option", { tabId, ref: size, values: ["Large"] });
    const focused = await session.tool("focus", { tabId, ref: name });
    const filled = await session.tool("fill_form", { tabId, fields: [{ ref: name, value: "Ravena" }, { ref: note, value: "Leave it at the door" }, { ref: size, value: "m" }] });
    const hovered = await session.tool("hover", { tabId, ref: hov });
    const after = await session.tool("page_snapshot", { tabId, maxChars: 0 });
    const has = (pattern: string): boolean => new RegExp(pattern).test(after.text);
    check(
      "MCP check, select_option, focus, fill_form and hover act on form controls",
      Boolean(news && size && name && note && hov) &&
        [checked, selected, focused, hovered].every((r) => !r.isError) &&
        filled.text === "filled 3/3" &&
        has('checkbox "Send me news"[^\\n]*="checked"') &&
        has('combobox "Size"[^\\n]*="m"') &&
        has('textbox "Name"[^\\n]*="Ravena"') &&
        has('textbox "Note"[^\\n]*="Leave it at the door"') &&
        has('button "Hovered"'),
      { refs: { news, size, name, note, hov }, filled: filled.text, after: after.text.slice(-500) },
    );
    const wrong = await session.tool("check", { tabId, ref: name, checked: true });
    check("MCP check refuses a control that is not a checkbox", wrong.isError && wrong.text.includes("not a checkbox"), wrong.text.slice(-200));

    const zoomed = await session.tool("zoom", { tabId, factor: 1.5 });
    const phone = await session.tool("set_viewport", { tabId, width: 390, height: 844, mobile: true });
    // 390x844 CSS px at zoom 1 (260x562 at zoom 1.5); the emulation lands on the next frame.
    const viewportOf = (t: string): string => /"viewport":"(\d+x\d+)"/.exec(t)?.[1] ?? "";
    let narrow = "";
    for (const until = Date.now() + 3000; Date.now() < until; await sleep(150)) {
      narrow = viewportOf((await session.tool("page_snapshot", { tabId, maxChars: 0 })).text);
      if (/^(390x844|260x56[23])$/.test(narrow)) break;
    }
    const reset = await session.tool("set_viewport", { tabId, reset: true });
    await session.tool("zoom", { tabId, factor: 1 });
    check(
      "MCP zoom and set_viewport (emulated phone, then reset)",
      zoomed.text === "zoom: 1.5" && !phone.isError && /^(390x844|260x56[23])$/.test(narrow) && !reset.isError,
      { zoomed: zoomed.text, phone: phone.text, narrow, reset: reset.text },
    );
  } catch (err) {
    check("MCP form smoke", false, errorDetail(err));
  } finally {
    if (tabId) await session.tool("tab_close", { tabId }).catch(() => undefined);
  }
}

/**
 * Reading and waiting over MCP on the shop page: find by text and selector, the main text, markdown,
 * links and metadata, trimmed HTML, wait_for text / element / network idle (and its timeout), and
 * tab_wait_load.
 */
async function mcpReadChecks(session: McpSession, tabId: string, check: Helpers["check"]): Promise<void> {
  try {
    const byText = await session.tool("find", { tabId, text: "Buy now" });
    const bySelector = await session.tool("find", { tabId, selector: "#out" });
    check(
      "MCP find by text and by selector returns refs with boxes",
      /\be\d+ button "Buy now" @\d+,\d+,\d+,\d+/.test(byText.text) && /\be\d+ div "idle" @/.test(bySelector.text),
      { byText: byText.text.slice(-200), bySelector: bySelector.text.slice(-200) },
    );
    const text = await session.tool("get_text", { tabId });
    const markdown = await session.tool("extract", { tabId, kind: "markdown" });
    const links = await session.tool("extract", { tabId, kind: "links" });
    const meta = await session.tool("extract", { tabId, kind: "metadata" });
    check(
      "MCP get_text and extract (markdown, links, metadata) read the page",
      text.text.includes("Raven travel umbrella") &&
        markdown.text.includes("# Corvus Agent Shop") &&
        /\[More products\]\(http:\/\/127\.0\.0\.1:\d+\/next\)/.test(markdown.text) &&
        /More products \| http:\/\/127\.0\.0\.1:\d+\/next/.test(links.text) &&
        meta.text.includes('"title":"Corvus Agent Shop"'),
      { text: text.text.slice(-200), markdown: markdown.text.slice(-300), links: links.text.slice(-200), meta: meta.text.slice(-200) },
    );
    const html = await session.tool("get_html", { tabId, selector: "form" });
    check("MCP get_html returns trimmed outerHTML", html.text.includes('<input id="q"') && html.text.includes("Buy now") && !html.text.includes("<script"), html.text.slice(-300));
    const appeared = await session.tool("wait_for", { tabId, text: "umbrella", timeoutMs: 3000 });
    const element = await session.tool("wait_for", { tabId, selector: "#out", state: "visible", timeoutMs: 3000 });
    const idle = await session.tool("wait_for", { tabId, networkIdle: true, timeoutMs: 8000 });
    const missing = await session.tool("wait_for", { tabId, text: "no-such-text-on-this-page", timeoutMs: 600 });
    const loaded = await session.tool("tab_wait_load", { tabId, timeoutMs: 3000 });
    check(
      "MCP wait_for (text, element, network idle, timeout) and tab_wait_load",
      !appeared.isError && appeared.text.includes('"matched":true') && !element.isError && !idle.isError && missing.isError && missing.text.includes("timed out") && !loaded.isError && loaded.text.includes('"title":"Corvus Agent Shop"') && !loaded.text.includes('"loading":true'),
      { appeared: appeared.text.slice(-120), element: element.text.slice(-120), idle: idle.text.slice(-160), missing: missing.text.slice(-160), loaded: loaded.text.slice(-200) },
    );
  } catch (err) {
    check("MCP read smoke", false, errorDetail(err));
  }
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
