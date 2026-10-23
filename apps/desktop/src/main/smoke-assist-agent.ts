import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { AgentMessage, AgentModelProvider, AgentTurnRequest, TurnEvent } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Agentic Assist smoke (CORVUS_SMOKE_NO_AGENT unset): a scripted, no-network agent model drives the
 * Assist chat in one tab across navigations. Checks: a plain question answers without tools; a
 * request typed into the panel navigates and clicks a real button with the steps listed in the
 * conversation; screenshot + click_at hits a target on a canvas (at 100% and at 125% page zoom, so
 * the screenshot -> CSS px -> DIP mapping is exercised); click_at on "Buy now" in auto mode stops at
 * the spend approval inside the panel and Stop there leaves the page untouched.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const START = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Raven Umbrellas</title></head>
<body style="margin:0;font-family:sans-serif"><main><h1>Raven Umbrellas</h1>
<p>We sell matte-black travel umbrellas that fold to 24 cm and survive storms.</p>
<a href="/shop">Go to the shop</a></main></body></html>`;

const SHOP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Raven Shop</title></head>
<body style="margin:0;font-family:sans-serif"><main><h1>Raven Shop</h1>
<button id="show" type="button" onclick="document.getElementById('out').textContent = 'Price: 42 dollars'">Show price</button>
<div id="out">hidden</div></main></body></html>`;

/** Canvas at (40, 80) CSS px; the red target square is at canvas (300, 200), 40 px wide. */
const TARGET = { x: 40 + 300 + 20, y: 80 + 200 + 20 };
const CANVAS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Raven Canvas</title></head>
<body style="margin:0"><canvas id="c" width="400" height="300" style="position:absolute;left:40px;top:80px;width:400px;height:300px;background:#eef"></canvas>
<script>
const c = document.getElementById("c"), g = c.getContext("2d");
g.fillStyle = "#e33"; g.fillRect(300, 200, 40, 40);
window.__hits = [];
c.addEventListener("click", (e) => {
  const r = c.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = x >= 300 && x <= 340 && y >= 200 && y <= 240;
  window.__hits.push({ x: Math.round(x), y: Math.round(y), hit, trusted: e.isTrusted });
  g.fillStyle = hit ? "#2a2" : "#333"; g.fillRect(x - 3, y - 3, 6, 6);
});
</script></body></html>`;

/** "Buy now" at (60, 120) CSS px, 160 x 48. */
const BUY = { x: 60 + 80, y: 120 + 24 };
const BUY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Raven Checkout</title></head>
<body style="margin:0;font-family:sans-serif"><h1 style="margin:16px 60px">Raven travel umbrella, 42 dollars</h1>
<button id="buy" style="position:absolute;left:60px;top:120px;width:160px;height:48px" onclick="document.getElementById('out').textContent = 'ordered'">Buy now</button>
<div id="out" style="position:absolute;left:60px;top:200px">idle</div></body></html>`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

function requestOf(messages: AgentMessage[]): string {
  const first = messages[0]?.content.find((c) => c.type === "text");
  return first && first.type === "text" ? (/<request>([\s\S]*?)<\/request>/.exec(first.text)?.[1] ?? "") : "";
}

/** Ref of the element with this accessible name in the latest snapshot the model saw. */
function refFor(messages: AgentMessage[], name: string): string {
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

/** Screenshot pixels for a CSS point, read from the latest screenshot result ("1 px = r CSS px"). */
function shotPoint(messages: AgentMessage[], css: { x: number; y: number }): { x: number; y: number } {
  let ratio = 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const shot = messages[i]!.content.find((c) => c.type === "tool_result" && c.image);
    if (shot && shot.type === "tool_result") {
      const m = /1 px = ([\d.]+) CSS px/.exec(shot.content);
      ratio = m ? Number(m[1]) : 1;
      break;
    }
  }
  return { x: Math.round(css.x / ratio), y: Math.round(css.y / ratio) };
}

interface Seen {
  turns: number;
  toolCalls: number;
  images: number;
}

/** The scripted model: one script per request, keyed on the request text of the seeded message. */
function scriptedModel(base: string, seen: Seen): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *streamTurn(req: AgentTurnRequest): AsyncGenerator<TurnEvent> {
      seen.turns += 1;
      const done = req.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use")).length;
      seen.images += req.messages.at(-1)?.content.some((c) => c.type === "tool_result" && c.image) ? 1 : 0;
      const request = requestOf(req.messages);
      await sleep(40);
      const tool = (name: string, input: unknown): TurnEvent => ({ type: "tool_use", id: `a${seen.turns}`, name, input });
      let script: Array<() => TurnEvent>;
      if (request.startsWith("What does this page sell")) {
        script = [() => ({ type: "text", text: "It sells matte-black travel umbrellas that fold to 24 cm [1]." })];
      } else if (request.startsWith("Open the shop")) {
        script = [
          () => tool("navigate", { url: `${base}/shop` }),
          () => tool("page_snapshot", {}),
          () => tool("click", { ref: refFor(req.messages, "Show price") }),
          () => ({ type: "text", text: "The umbrella costs 42 dollars." }),
        ];
      } else if (request.startsWith("Click the red square")) {
        script = [
          ...(request.includes("canvas page") ? [() => tool("navigate", { url: `${base}/canvas` })] : []),
          () => tool("screenshot", {}),
          () => tool("click_at", shotPoint(req.messages, TARGET)),
          () => ({ type: "text", text: "Clicked the red square." }),
        ];
      } else if (request.startsWith("Buy the umbrella")) {
        script = [
          () => tool("navigate", { url: `${base}/buy` }),
          () => tool("screenshot", {}),
          () => tool("click_at", shotPoint(req.messages, BUY)),
          () => ({ type: "text", text: "Ordered." }),
        ];
      } else {
        script = [() => ({ type: "text", text: "I am not sure what to do." })];
      }
      const ev = script[Math.min(done, script.length - 1)]!();
      if (ev.type === "tool_use") seen.toolCalls += 1;
      yield ev;
      yield { type: "usage", inputTokens: 900 + done * 300, outputTokens: 40, model: "claude-haiku-5-5" };
      yield { type: "end", stopReason: ev.type === "tool_use" ? "tool_use" : "end_turn" };
    },
  };
}

export async function runAssistAgentSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const routes: Record<string, string> = { "/start": START, "/shop": SHOP, "/canvas": CANVAS, "/buy": BUY_PAGE };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(routes[(req.url ?? "/").split("?")[0]!] ?? START);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const seen: Seen = { turns: 0, toolCalls: 0, images: 0 };
  const askBefore = ctx.settings.get().agent.askBeforeRisky;
  ctx.agentRunner.setTestProvider(scriptedModel(base, seen));
  const tab = win.createTab(`${base}/start`, { activate: true });
  const page = tab.view.webContents;
  await poll(page, "document.querySelector('h1')");

  try {
    ctx.assist.open(win, "assist");
    const panel = ctx.assist.panelWebContents(win);
    check("assist agent: panel", Boolean(panel));
    if (!panel) return;
    await poll(panel, "document.querySelector('.composer textarea:not([disabled])')");
    const lastAnswer = "[...document.querySelectorAll('.msg.ask.agent')].at(-1)";

    // 1. A plain question answers right away, without a single tool call.
    const toolsBefore = seen.toolCalls;
    ctx.assist.activeAction(win, "ask", "What does this page sell?");
    const answered = await poll(panel, `${lastAnswer}?.querySelector('.rich')?.innerText.includes('travel umbrellas') && !${lastAnswer}.querySelector('.agent-steps') && ${lastAnswer}.querySelector('.usage')`);
    check("assist agent: plain question answers without tools", answered && seen.toolCalls === toolsBefore, {
      toolCalls: seen.toolCalls - toolsBefore,
      thread: answered ? undefined : await panel.executeJavaScript("document.querySelector('.thread')?.innerText?.slice(0,300)"),
    });

    // 2. Typed into the panel: navigate + snapshot + click, steps listed in the conversation.
    await panel.executeJavaScript(`(() => {
      const ta = document.querySelector('.composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Open the shop and show the price');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(100);
    await panel.executeJavaScript("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    const clicked = await poll(page, "document.getElementById('out')?.textContent === 'Price: 42 dollars'");
    const stepsShown = await poll(
      panel,
      `(() => { const t = ${lastAnswer}?.innerText || ''; return t.includes('Opened 127.0.0.1') && t.includes('Read the page') && t.includes('Clicked "Show price"') && t.includes('42 dollars'); })()`,
    );
    check("assist agent: navigates and clicks in the current tab", clicked && page.getURL().endsWith("/shop"), page.getURL());
    check("assist agent: steps render in the panel", stepsShown, stepsShown ? undefined : await panel.executeJavaScript(`${lastAnswer}?.innerText?.slice(0,400)`));
    await sleep(150);
    await capture("assist-agent-steps", panel);

    // 3. Visual: screenshot + click_at on a canvas target (100% zoom).
    ctx.assist.activeAction(win, "ask", "Click the red square on the canvas page");
    const hit1 = await poll(page, "window.__hits && window.__hits.length >= 1", 12_000);
    const hits1 = hit1 ? ((await page.executeJavaScript("window.__hits")) as Array<{ x: number; y: number; hit: boolean; trusted: boolean }>) : [];
    check("assist agent: click_at hits the canvas target", hits1[0]?.hit === true, { hits: hits1, target: TARGET });
    const thumb = await poll(panel, `${lastAnswer}?.querySelector('.astep-thumb') && ${lastAnswer}.querySelector('.rich')`);
    check("assist agent: screenshot thumbnail and image sent to the model", thumb && seen.images >= 1, { images: seen.images });
    await capture("assist-agent-canvas", panel);

    // 4. Same at 125% page zoom: screenshot px -> CSS px -> DIP must still land on the target.
    page.setZoomFactor(1.25);
    await sleep(300);
    ctx.assist.activeAction(win, "ask", "Click the red square again");
    const hit2 = await poll(page, "window.__hits && window.__hits.length >= 2", 12_000);
    const hits2 = hit2 ? ((await page.executeJavaScript("window.__hits")) as Array<{ hit: boolean }>) : [];
    check("assist agent: click_at maps through page zoom", hits2[1]?.hit === true, { hits: hits2 });
    page.setZoomFactor(1);
    await poll(panel, `${lastAnswer}?.querySelector('.rich')`);

    // 5. click_at on "Buy now" in auto mode: the spend approval shows in the panel; Stop leaves it unbought.
    ctx.settings.update({ agent: { askBeforeRisky: false } });
    ctx.assist.activeAction(win, "ask", "Buy the umbrella");
    const asking = await poll(panel, `(${lastAnswer}?.querySelector('.agent-approval')?.innerText || '').includes('Spends money')`, 12_000);
    const prompt = asking ? await panel.executeJavaScript(`${lastAnswer}.querySelector('.agent-approval').innerText`) : await panel.executeJavaScript(`${lastAnswer}?.innerText?.slice(0,400)`);
    check("assist agent: click_at on Buy now asks in auto mode (in the panel)", asking && String(prompt).includes("Approve this action?") && String(prompt).includes("Buy now"), prompt);
    await sleep(150);
    await capture("assist-agent-approval", panel);
    await panel.executeJavaScript(`[...${lastAnswer}.querySelectorAll('.agent-approval button')].find((b) => b.textContent.trim() === 'Stop')?.click()`);
    const stopped = await poll(panel, `${lastAnswer}?.innerText.includes('Stopped.') && !document.querySelector('.composer .send.stop')`);
    const untouched = (await page.executeJavaScript("document.getElementById('out')?.textContent")) === "idle";
    check("assist agent: Stop at the spend prompt leaves the page untouched", stopped && untouched, { stopped, untouched });

    // The whole exchange stayed one conversation in this tab across five navigations.
    const questions = (await panel.executeJavaScript("document.querySelectorAll('.thread .question').length")) as number;
    check("assist agent: conversation kept across navigations", questions === 5, questions);
    const runs = win.profile.agentRuns.views().filter((r) => r.source === "assist");
    check("assist agent: runs recorded in history as Assist", runs.length >= 5, runs.length);
  } catch (err) {
    check("assist agent smoke", false, (err as Error).stack ?? String(err));
  } finally {
    ctx.settings.update({ agent: { askBeforeRisky: askBefore } });
    ctx.assist.clear(win);
    ctx.agentRunner.setTestProvider(undefined);
    if (!page.isDestroyed()) page.setZoomFactor(1);
    ctx.assist.close(win);
    win.closeTab(tab.id);
    server.close();
  }
}
