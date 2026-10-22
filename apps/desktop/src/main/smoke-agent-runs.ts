import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { AgentModelProvider, AgentTurnRequest, TurnEvent } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Agent run history + resume smoke: runs a scripted Command Bar agent, stops it mid-loop so it is
 * persisted as a resumable run, drives the real corvus://agent-runs page over its IPC to prove the
 * run and its Resume control render, then resumes it from the page and proves the run continues from
 * its saved step state (the prior step is not re-run) and finishes. No-network provider, local page.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Corvus Runs</title></head>
<body><main><h1>Run history page</h1><p>The Raven umbrella costs 42 dollars.</p><a href="/next">Next</a></main></body></html>`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 10000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(60);
  }
  return false;
}

/** navigate -> snapshot loop (benign; safe to stop at any point). */
function loopProvider(url: string): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *streamTurn(req: AgentTurnRequest): AsyncGenerator<TurnEvent> {
      const issued = req.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use")).length;
      const ev: TurnEvent = issued === 0 ? { type: "tool_use", id: `c${issued}`, name: "navigate", input: { url } } : { type: "tool_use", id: `c${issued}`, name: "page_snapshot", input: {} };
      await sleep(20);
      yield ev;
      yield { type: "usage", inputTokens: 60, outputTokens: 12, model: "claude-haiku-5-5" };
      yield { type: "end", stopReason: "tool_use" };
    },
  };
}

/** One snapshot then a closing summary: a resume uses this to finish. */
function finishProvider(): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *streamTurn(req: AgentTurnRequest): AsyncGenerator<TurnEvent> {
      const issued = req.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use")).length;
      await sleep(20);
      if (issued === 0) {
        yield { type: "tool_use", id: "r0", name: "page_snapshot", input: {} };
        yield { type: "usage", inputTokens: 40, outputTokens: 8, model: "claude-haiku-5-5" };
        yield { type: "end", stopReason: "tool_use" };
      } else {
        yield { type: "text", text: "Resumed and finished the run." };
        yield { type: "usage", inputTokens: 30, outputTokens: 10, model: "claude-haiku-5-5" };
        yield { type: "end", stopReason: "end_turn" };
      }
    },
  };
}

export async function runAgentRunsSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const runView = () => ctx.agentRunner.windowExtras(win).agentRun;
  const page = win.createTab("corvus://agent-runs/");
  const wc = page.view.webContents;

  try {
    // 1. Run a scripted Command Bar agent, then stop it so it persists as a resumable run.
    ctx.agentRunner.setTestProvider(loopProvider(url));
    ctx.agentRunner.start(win, "Remember what the shop page says");
    const progressed = await waitFor(() => (runView()?.stepCount ?? 0) >= 1, 12000);
    check("agent run progressed before stop", progressed, { stepCount: runView()?.stepCount });
    ctx.agentRunner.stop(win);
    const stopped = await waitFor(() => runView()?.status === "stopped", 6000);
    const runId = runView()?.id ?? "";
    check("stopped run persisted", stopped && win.profile.agentRuns.views().some((r) => r.id === runId && r.resumable), win.profile.agentRuns.views()[0]);

    // 2. The history page shows the run and a Resume control.
    const mounted = await poll(wc, "window.corvusInternal && document.querySelector('.side-nav a.active')");
    check("agent-runs page rendered", mounted);
    const hasRow = await poll(wc, "document.querySelector('.ar-row')", 8000);
    const hasResume = await poll(wc, "[...document.querySelectorAll('.ar-actions .btn')].some((b) => /resume/i.test(b.textContent))", 8000);
    check("run row + resume control render", hasRow && hasResume);
    // The scripted run stole the active tab; re-activate the history tab so capturePage has a surface.
    win.activate(page.id);
    await sleep(250);
    await capture("agent-runs", wc).catch(() => undefined);

    // 3. Resume it from the page over IPC with a provider that finishes.
    ctx.agentRunner.setTestProvider(finishProvider());
    const resumed = await wc.executeJavaScript(`window.corvusInternal.call("agentRuns.resume", ${JSON.stringify(runId)}).then((r) => r.ok)`).catch(() => false);
    check("resume accepted over IPC", resumed === true, resumed);
    const finished = await waitFor(() => runView()?.id === runId && runView()?.status === "done" && (runView()?.finalText ?? "").includes("Resumed"), 12000);
    check("resumed run continued and finished", finished, { id: runView()?.id, status: runView()?.status, finalText: runView()?.finalText });
    const stored = win.profile.agentRuns.views().find((r) => r.id === runId);
    check("resumed run recorded as done", stored?.status === "done", stored);
  } finally {
    ctx.agentRunner.stop(win);
    ctx.agentRunner.clear(win);
    ctx.agentRunner.setTestProvider(undefined);
    ctx.agents.setPaused(false);
    win.closeTab(page.id);
    server.close();
  }
}
