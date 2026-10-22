import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { nativeTheme, type WebContents } from "electron";
import type { AgentModelProvider, AgentTurnRequest, TurnEvent } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Site-memory smoke (fake, no-network provider; local fixture with a cookie banner):
 *  1. Run A explores the shop: navigate, read, accept cookies, read again, search, read results.
 *     Corvus learns the site (obstacle, targets, URL shape) without the typed value.
 *  2. Run B on the same site gets the learned hints, fenced, in its system prompt and goes
 *     straight to the known elements: fewer steps. Both runs record whether hints were injected,
 *     and the Learned tab compares them.
 *  3. The Learned tab (side panel) and the Learned view of corvus://flows render, light and dark;
 *     "Forget this site" clears the entry.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

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

function page(reqPath: string): string {
  if (reqPath.startsWith("/s")) {
    const q = new URLSearchParams(reqPath.split("?")[1] ?? "").get("k") ?? "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Memory Shop results</title></head><body><main><h1>Results for ${q.replace(/[<>&"]/g, "")}</h1><p>4 products.</p></main></body></html>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Memory Shop</title></head>
<body><div id="banner" role="dialog" aria-label="Cookie notice"><p>This shop uses cookies.</p>
<button type="button" onclick="document.getElementById('banner').remove()">Accept all</button></div>
<main><h1>Memory Shop</h1><input id="q" aria-label="Search products" placeholder="Search products">
<button type="button" onclick="location.href='/s?k=' + encodeURIComponent(document.getElementById('q').value)">Search</button></main></body></html>`;
}

function refFor(messages: AgentTurnRequest["messages"], name: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const block of messages[i]!.content) {
      if (block.type === "tool_result" && block.content.includes("elements:")) {
        const match = block.content.match(new RegExp(`(\\be\\d+)\\s+\\w+\\s+"${name}"`));
        if (match) return match[1]!;
      }
    }
  }
  return "e1";
}

function scripted(script: (req: AgentTurnRequest, n: number) => TurnEvent): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *streamTurn(req: AgentTurnRequest): AsyncGenerator<TurnEvent> {
      const n = req.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use")).length;
      const ev = script(req, n);
      await sleep(25);
      yield ev;
      yield { type: "usage", inputTokens: 150 + n * 40, outputTokens: 20, model: "claude-haiku-5-5" };
      yield { type: "end", stopReason: ev.type === "tool_use" ? "tool_use" : "end_turn" };
    },
  };
}

const use = (n: number, name: string, input: unknown): TurnEvent => ({ type: "tool_use", id: `m${n}`, name, input });

export async function runSiteMemorySmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const themeBefore = nativeTheme.themeSource;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page(req.url ?? "/"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const host = new URL(url).host;
  const runView = () => ctx.agentRunner.windowExtras(win).agentRun;
  const memory = ctx.flows.memory;
  const chrome = win.chrome.webContents;
  let approvals = 0;
  /** Wait for the run to finish, approving the cookie-banner click like the user would ("accept" is risky). */
  const finish = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const v = runView();
      if (v?.status === "done") return true;
      if (v?.status === "error" || v?.status === "stopped") return false;
      if (v?.status === "awaiting-approval" && v.approval) {
        approvals += 1;
        ctx.agentRunner.approve(win, "approve");
      }
      await sleep(80);
    }
    return false;
  };

  try {
    nativeTheme.themeSource = "light";
    memory.setEnabled(true);
    memory.forget(win.profile, host);
    const shopTab = win.createTab(url, { activate: true });
    win.activate(shopTab.id);
    await sleep(700);

    // ---------------------------------------------------------------- run A: explore and learn
    let promptA = "";
    ctx.agentRunner.setTestProvider(
      scripted((req, n) => {
        if (n === 0) {
          promptA = req.system;
          return use(n, "navigate", { url });
        }
        if (n === 1) return use(n, "page_snapshot", {});
        if (n === 2) return use(n, "click", { ref: refFor(req.messages, "Accept all") });
        if (n === 3) return use(n, "page_snapshot", {});
        if (n === 4) return use(n, "type", { ref: refFor(req.messages, "Search products"), text: "umbrella" });
        if (n === 5) return use(n, "click", { ref: refFor(req.messages, "Search") });
        if (n === 6) return use(n, "page_snapshot", {});
        return { type: "text", text: "Found 4 umbrellas." };
      }),
    );
    ctx.agentRunner.start(win, "Find umbrellas in the memory shop");
    const doneA = await finish(25000);
    const runA = runView();
    check("memory run A finished", doneA, runA?.steps.map((s) => `${s.kind}:${s.status}`));
    check("cookie click still went through the approval gate", approvals >= 1, { approvals });
    check("run A had no hints yet", !promptA.includes("corvus-site-memory:") && runA?.siteHints?.hints === 0, runA?.siteHints);
    const learned = memory.entry(win.profile, host);
    check(
      "memory learned the site (obstacle, targets, URL shape)",
      learned?.obstacles.some((o) => o.kind === "cookie banner" && o.how.includes("Accept all")) === true &&
        learned.targets.some((t) => t.intent === "search" && t.name === "Search products") &&
        learned.urls.some((u) => u.label === "search results" && u.pattern === "/s?k=*"),
      learned,
    );
    memory.flush();
    const file = path.join(win.profile.dataDir, "site-memory.json");
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    check("memory never stores the typed value", raw.includes(host) && !raw.includes("umbrella"), raw.slice(0, 200));

    // ---------------------------------------------------------------- run B: uses the hints
    ctx.agentRunner.clear(win);
    win.activate(shopTab.id);
    await sleep(300);
    let promptB = "";
    ctx.agentRunner.setTestProvider(
      scripted((req, n) => {
        if (n === 0) {
          promptB = req.system;
          return use(n, "navigate", { url });
        }
        if (n === 1) return use(n, "page_snapshot", {});
        // The hints say: cookie banner -> "Accept all", search box "Search products", button "Search".
        if (n === 2) return use(n, "click", { ref: refFor(req.messages, "Accept all") });
        if (n === 3) return use(n, "type", { ref: refFor(req.messages, "Search products"), text: "raincoat" });
        if (n === 4) return use(n, "click", { ref: refFor(req.messages, "Search") });
        return { type: "text", text: "Found raincoats using the learned hints." };
      }),
    );
    win.sendCommand({ type: "open-command-palette" });
    await poll(chrome, "document.querySelector('.cmdbar')");
    ctx.agentRunner.start(win, "Find raincoats in the memory shop");
    const doneB = await finish(25000);
    const runB = runView();
    const fenced = /<untrusted_page_content source="corvus-site-memory:[^"]+">\n([\s\S]*?)\n<\/untrusted_page_content>/.exec(promptB)?.[1] ?? "";
    check("run B got the hints fenced as data", doneB && fenced.includes("Accept all") && fenced.includes("Search products") && !fenced.includes("umbrella"), fenced.slice(0, 300));
    check("run B recorded the injected hints", (runB?.siteHints?.hints ?? 0) > 0 && runB?.siteHints?.host === host, runB?.siteHints);
    check("run B used fewer steps than run A", (runB?.stepCount ?? 99) < (runA?.stepCount ?? 0), { a: runA?.stepCount, b: runB?.stepCount });
    const metaShown = await poll(chrome, "document.querySelector('.cmdbar .run-meta')?.textContent?.includes('site hints')", 5000);
    await poll(chrome, "document.querySelector('.cmdbar .run-chip.done')", 5000);
    check("run panel shows the hints were used", metaShown);
    await capture("site-memory-run-light", chrome);
    win.sendCommand({ type: "close-overlays" });
    const stored = win.profile.agentRuns.views().find((r) => r.id === runB?.id);
    check("run log keeps the hint count", (stored?.siteHints?.hints ?? 0) > 0, stored?.siteHints);

    // ---------------------------------------------------------------- the Learned views
    ctx.agentRunner.clear(win);
    win.activate(shopTab.id);
    ctx.assist.open(win, "workflows");
    const panel = ctx.assist.panelWebContents(win);
    if (panel) {
      await poll(panel, "document.querySelector('.wf-subtabs')", 6000);
      await panel.executeJavaScript("[...document.querySelectorAll('.wf-subtabs button')].find((b) => /learned/i.test(b.textContent))?.click()");
      const shown = await poll(panel, "document.querySelector('.mem-site') && document.querySelector('.mem-stats')", 8000);
      check("Learned tab shows the site memory and the comparison", shown, await panel.executeJavaScript("document.querySelector('.wf-pane')?.innerText?.slice(0,300) ?? ''"));
      for (const theme of ["light", "dark"] as const) {
        nativeTheme.themeSource = theme;
        await sleep(250);
        await capture(`site-memory-panel-${theme}`, panel);
      }
      nativeTheme.themeSource = "light";
    } else check("Learned tab shows the site memory and the comparison", false, "no panel");

    const manager = win.createTab("corvus://flows/#learned");
    const mwc = manager.view.webContents;
    const listed = await poll(mwc, `[...document.querySelectorAll('.mem-host')].some((e) => e.textContent.includes(${JSON.stringify(host)}))`, 10000);
    check("corvus://flows lists learned sites", listed);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(300);
      await capture(`site-memory-manager-${theme}`, mwc);
    }
    nativeTheme.themeSource = "light";
    win.closeTab(manager.id);

    // Forget this site from the panel.
    win.activate(shopTab.id);
    if (panel) {
      // The panel follows the active tab: wait until it shows this site's entry again, then forget it.
      const ready = await poll(panel, `document.querySelector('.mem-forget') && document.querySelector('.wf-pane h3')?.textContent.includes(${JSON.stringify(host)})`, 8000);
      await panel.executeJavaScript("document.querySelector('.mem-forget')?.click()");
      const gone = await waitFor(() => memory.entry(win.profile, host) === undefined, 5000);
      const emptied = gone && (await poll(panel, "!document.querySelector('.mem-forget')", 5000));
      check("Forget this site clears the entry", ready && emptied, { ready, gone });
    }
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
