import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { AgentModelProvider, AgentTurnRequest, TurnEvent } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Scheduled-agents smoke: drives the real corvus://schedules page over its IPC, adds a schedule,
 * fires it, and proves the approval gate — a scheduled run reaching a risky "Buy now" click PAUSES
 * and surfaces an approval banner instead of buying, then stops cleanly from the UI. Uses a scripted,
 * no-network provider against a local shop page (the same shape the Command Bar agent smoke uses).
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Corvus Agent Shop</title></head>
<body><main><h1>Corvus Agent Shop</h1>
<p>The Raven travel umbrella is matte-black and costs 42 dollars.</p>
<form onsubmit="return false"><input id="q" name="q" placeholder="Search products"><button id="buy" type="button">Buy now</button></form>
<div id="out">idle</div></main></body></html>`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 10000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

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

/** navigate -> snapshot -> click "Buy now" (risky) -> loop, so the gate must stop it. */
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
      else ev = emit("page_snapshot", {});
      await sleep(30);
      yield ev;
      yield { type: "usage", inputTokens: 120 + issued * 30, outputTokens: 20, model: "claude-haiku-5-5" };
      yield { type: "end", stopReason: "tool_use" };
    },
  };
}

export async function runScheduledAgentSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const page = win.createTab("corvus://schedules/");
  const wc = page.view.webContents;
  let scheduleId = "";

  try {
    ctx.scheduledAgents.setTestProvider(fakeProvider(url));

    const mounted = await poll(wc, "window.corvusInternal && document.querySelector('.page-toolbar .btn.primary')");
    check("schedules page rendered", mounted);
    await capture("schedules", wc);

    scheduleId = await wc.executeJavaScript(
      `window.corvusInternal.call("schedule.add", { name: "Smoke buy", task: "Buy the Raven umbrella", kind: "interval", intervalMinutes: 60, maxSteps: 6 }).then((l) => l[0].id)`,
    );
    check("schedule added over IPC", typeof scheduleId === "string" && scheduleId.length > 0, scheduleId);
    check("schedule row rendered", await poll(wc, "document.querySelector('.sched-row')"));

    await wc.executeJavaScript(`window.corvusInternal.call("schedule.runNow", ${JSON.stringify(scheduleId)})`);

    const approving = await poll(wc, "document.querySelector('.sched-approval .sched-approval-actions .btn')", 15000);
    const banner = await wc.executeJavaScript("document.querySelector('.sched-approval')?.innerText || ''").catch(() => "");
    check("scheduled run pauses for risky approval", approving && String(banner).includes("Buy now"), banner);

    // The run must be awaiting approval in the runner, with the risky action NOT performed.
    const view = ctx.scheduledAgents.views(win.profile).find((v) => v.id === scheduleId);
    check("runner holds the run at approval (unattended action blocked)", view?.running === true && view?.approval != null, {
      running: view?.running,
      approval: view?.approval?.reason,
    });
    await capture("schedules-approval", wc);

    // Stop the run from the page's own approval UI.
    await wc.executeJavaScript(
      `[...document.querySelectorAll('.sched-approval-actions .btn')].find((b) => /stop/i.test(b.textContent)).click()`,
    );
    const ended = await poll(wc, "!document.querySelector('.sched-approval')", 8000);
    const stopped = ctx.scheduledAgents.views(win.profile).find((v) => v.id === scheduleId);
    check("scheduled run stopped from the UI", ended && stopped?.running === false && stopped?.lastRun?.status === "stopped", stopped?.lastRun);

    // It worked in a tab group named after the schedule, which stays with the page it opened.
    let left: { group: string; tabs: string[]; agent: boolean[] } | null = null;
    for (let i = 0; i < 20 && !left; i++) {
      const group = win.listGroups().find((g) => g.title === "Smoke buy");
      if (group) {
        const ids = win.tabIds().filter((id) => win.groupOf(id) === group.id);
        left = { group: group.title, tabs: ids.map((id) => win.getTab(id)?.url ?? ""), agent: ids.map((id) => win.getTab(id)?.agentControlled === true) };
      } else await sleep(100);
    }
    check("scheduled run leaves its tabs in a group named after it", Boolean(left?.tabs.some((u) => u.startsWith(url))) && left!.agent.every((a) => !a), left);
    const groupLeft = win.listGroups().find((g) => g.title === "Smoke buy");
    if (groupLeft) win.closeGroup(groupLeft.id);
  } finally {
    if (scheduleId) ctx.scheduledAgents.remove(win.profile, scheduleId);
    ctx.scheduledAgents.setTestProvider(undefined);
    win.closeTab(page.id);
    server.close();
  }
}
