import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Recorded-flows smoke: records a flow via the service (feeding it the same interactions the tab
 * preload would), saves it, then replays it from the real corvus://flows page over its IPC and proves
 * the approval gate — the replay reaches a risky "Buy now" click, PAUSES with an approval banner
 * instead of clicking, and stops cleanly from the page. No AI provider involved.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Corvus Flow Shop</title></head>
<body><main><h1>Corvus Flow Shop</h1>
<p>The Raven travel umbrella is matte-black and costs 42 dollars.</p>
<form onsubmit="return false"><input id="q" name="q" placeholder="Search products"><button id="buy" type="button" onclick="document.getElementById('out').textContent='bought'">Buy now</button></form>
<div id="out">idle</div></main></body></html>`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 12000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

export async function runFlowsSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const profileId = win.profile.profile.id;

  // Open the manager in the background, then a FRESH web tab that we activate LAST, so recording
  // binds to our own tab regardless of whatever a previous smoke left active in this window.
  const page = win.createTab("corvus://flows/", { activate: false });
  const wc = page.view.webContents;
  const webTab = win.createTab(url, { activate: true });
  win.activate(webTab.id);
  await sleep(800);
  let flowId = "";

  try {
    // Record: start on our web tab, feed the interactions a preload would capture, stop and save.
    const rec = ctx.flows.startRecording(win);
    check("recording started on the web tab", rec.phase === "recording", rec.phase);
    ctx.flows.onCaptured(webTab.id, profileId, { kind: "input", url, target: { role: "textbox", name: "Search products", index: 0, tag: "input", selector: "#q" }, value: "umbrella" });
    ctx.flows.onCaptured(webTab.id, profileId, { kind: "click", url, target: { role: "button", name: "Buy now", index: 0, tag: "button", selector: "#buy" } });
    const review = ctx.flows.stopRecording(win);
    const captured = review.steps.length;
    check("recording captured two steps", captured === 2, review.steps.map((s) => s.kind));
    if (captured < 1) {
      check("flow recording produced steps to save", false, "recorder captured 0 steps; aborting flows smoke");
      return;
    }
    flowId = ctx.flows.saveRecording(win.profile, "Smoke umbrella")[0]!.id;
    check("flow saved", typeof flowId === "string" && flowId.length > 0, flowId);

    const mounted = await poll(wc, "window.corvusInternal && document.querySelector('.side-nav')");
    check("flows page rendered", mounted);
    check("saved flow row rendered", await poll(wc, "document.querySelector('.flow-row')"));
    await capture("flows", wc);

    // Replay over the page IPC; it must reach the risky "Buy now" click and pause for approval.
    await wc.executeJavaScript(`window.corvusInternal.call("flow.replay", ${JSON.stringify(flowId)})`);
    const approving = await poll(wc, "document.querySelector('.flow-approval .flow-approval-actions .btn')", 20000);
    const banner = await wc.executeJavaScript("document.querySelector('.flow-approval')?.innerText || ''").catch(() => "");
    check("replay pauses for risky approval", approving && String(banner).includes("Buy now"), banner);

    const view = ctx.flows.list(win.profile).find((f) => f.id === flowId);
    check("replay held at approval (risky click not performed)", view?.replay?.approval?.kind === "risky", view?.replay?.approval);
    await capture("flows-approval", wc);

    // Stop the replay from the page's own approval UI.
    await wc.executeJavaScript(`[...document.querySelectorAll('.flow-approval-actions .btn')].find((b) => /stop/i.test(b.textContent)).click()`);
    const ended = await poll(wc, "!document.querySelector('.flow-approval')", 8000);
    const stopped = ctx.flows.list(win.profile).find((f) => f.id === flowId);
    check("replay stopped from the UI", ended && stopped?.replay === null, stopped?.replay);
  } finally {
    if (flowId) ctx.flows.remove(win.profile, flowId);
    if (!win.isDisposed()) {
      if (win.hasTab(page.id)) win.closeTab(page.id);
      if (win.hasTab(webTab.id)) win.closeTab(webTab.id);
    }
    server.close();
  }
}
