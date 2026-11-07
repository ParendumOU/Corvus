import fs from "node:fs";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * CORVUS_SMOKE_ONLY=searchperf: times real searches on corvus://search with the configured engine
 * (real retriever, real AI provider: run it with a profile whose settings point at them). For each
 * query it records, from the start of the page load, when the first result, the snippets, the first
 * sentence of the answer, the whole answer part, the ratings and the end of the AI reply first
 * showed, the layout shift and the token usage,
 * one JSON line each in CORVUS_SEARCHPERF_OUT. Queries: CORVUS_SEARCHPERF_QUERIES, "|"-separated; a
 * "news:", "images:" or "videos:" prefix opens that tab.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const DEFAULT_QUERIES = ["perro", "how does tls 1.3 work", "receta de tortilla de patatas", "mejor portatil para programar"];

/** In the page: when each part first showed, in ms since the page started loading. */
const SAMPLER = `(() => {
  const t = { cls: 0 };
  window.__perf = t;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) t.cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
  const mark = (key, seen) => { if (seen && t[key] === undefined) t[key] = Math.round(performance.now()); };
  const tick = () => {
    const titles = document.querySelectorAll(".sources .source-title, .news-item, .image-tile > img, .video-card").length;
    mark("firstResult", titles > 0);
    mark("snippets", titles > 0 && [...document.querySelectorAll(".sources .source-snippet")].some((e) => e.textContent.trim()));
    mark("firstText", (document.querySelector(".turn .answer-text")?.textContent ?? "").trim());
    mark("answer", document.querySelector(".turn.read"));
    mark("ratings", document.querySelector(".source-rail[data-score]"));
    mark("done", document.querySelector(".turn.settled, .search-footer, .search-error:not(.soft)"));
    if (t.done === undefined) requestAnimationFrame(tick);
    else clearInterval(timer);
  };
  // Frames stop in a window that is not on screen; the timer keeps sampling (the tab is not throttled).
  const timer = setInterval(tick, 20);
  tick();
  return true;
})()`;

const RESULT = `(() => {
  const usage = [...document.querySelectorAll(".turn-usage span")].map((s) => s.textContent);
  return { ...window.__perf, cls: +window.__perf.cls.toFixed(4), results: document.querySelectorAll(".sources .source, .news-item, .image-tile, .video-card").length, model: usage[0], tokens: usage[1], errors: [...document.querySelectorAll(".search-error")].map((e) => e.textContent.trim().slice(0, 200)) };
})()`;

export async function runSearchPerfSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const queries = (process.env.CORVUS_SEARCHPERF_QUERIES ?? "").split("|").map((q) => q.trim()).filter(Boolean);
  const out = process.env.CORVUS_SEARCHPERF_OUT;
  const info = await ctx.search.engineInfo();
  const tab = win.createTab("corvus://newtab/");
  const wc = tab.view.webContents;
  // Launched like an agent (--enable-mcp: minimized, no focus), the window shows without taking the
  // keyboard, and the tab runs as if on screen even when other windows cover it.
  if (win.win.isMinimized()) win.win.showInactive();
  win.setPaintHold(tab.id, "capture", true);
  for (const [i, query] of (queries.length ? queries : DEFAULT_QUERIES).entries()) {
    const loaded = new Promise<void>((resolve) => wc.once("dom-ready", () => resolve()));
    const [, cat, words] = /^(?:(news|images|videos):)?(.*)$/s.exec(query)!;
    win.loadUrl(tab.id, `corvus://search/?q=${encodeURIComponent(words!.trim())}${cat ? `&cat=${cat}` : ""}`);
    await loaded;
    await wc.executeJavaScript(SAMPLER);
    let row: Record<string, unknown> = {};
    const until = Date.now() + 90_000;
    let shot = false;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      row = (await wc.executeJavaScript(RESULT).catch(() => ({}))) as Record<string, unknown>;
      if (!shot && typeof row.firstResult === "number") {
        shot = true;
        await capture(`perf-${i}-first`, wc);
      }
      if (row.done !== undefined) break;
    }
    await new Promise((r) => setTimeout(r, 300));
    await capture(`perf-${i}-done`, wc);
    const line = { query, provider: info.provider, model: info.model, retriever: info.retriever, ...row };
    if (out) fs.appendFileSync(out, `${JSON.stringify(line)}\n`);
    check(`searchperf: ${query}`, row.done !== undefined, line);
  }
}
