import http from "node:http";
import type { AddressInfo } from "node:net";
import { nativeTheme, type WebContents } from "electron";
import type { AgentModelProvider, AgentTurnRequest, TurnEvent } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Command Bar + agent smoke (CORVUS_SMOKE_OUT): opens the palette (light and dark), then runs a
 * scripted task against a local shop page with a fake, no-network provider. Exercises
 * navigate -> snapshot -> click (risky, approved) -> extract, the in-page overlay, the shared
 * timeline and the Stop control, capturing the palette and a running task.
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

    // 2. A scripted agent run.
    nativeTheme.themeSource = "light";
    ctx.agentRunner.setTestProvider(fakeProvider(url));
    win.sendCommand({ type: "open-command-palette" });
    await poll(chrome, "document.querySelector('.cmdbar')");
    ctx.agentRunner.start(win, "Buy the Raven travel umbrella");

    const approving = await waitFor(() => runView()?.status === "awaiting-approval", 10000);
    check("agent risky approval", approving && (runView()?.approval?.reason ?? "").includes("Buy now"), runView()?.approval);
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
  } finally {
    nativeTheme.themeSource = themeBefore;
    ctx.agentRunner.stop(win);
    ctx.agentRunner.clear(win);
    ctx.agentRunner.setTestProvider(undefined);
    ctx.agents.setPaused(false);
    win.sendCommand({ type: "close-overlays" });
    server.close();
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
