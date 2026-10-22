import http from "node:http";
import type { AddressInfo } from "node:net";
import { nativeTheme, type WebContents } from "electron";
import { extractReadableText, type AnswerProvider, type ProviderEvent } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Smoke for vertical tabs, workspaces and page-change monitoring (CORVUS_SMOKE_OUT): toggles the
 * vertical sidebar (light + dark screenshots), saves and reopens a workspace, then watches a page on
 * the local server, forces a change and checks that a change + AI summary surface on corvus://watches.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CHANGE_SUMMARY = "The product went out of stock and the price rose from 19.99 to 24.99.";

function fakeProvider(): AnswerProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *answer(req): AsyncGenerator<ProviderEvent> {
      const reply = /monitoring/i.test(req.prompt.system) ? CHANGE_SUMMARY : "ok";
      yield { type: "delta", text: reply };
      yield { type: "usage", inputTokens: 20, outputTokens: 12, model: "claude-haiku-5-5" };
    },
  };
}

const PAGE_BEFORE = `<article><h1>Corvus Field Monitor</h1>
<p>Status: In stock. Price 19.99. Ships within two business days from our warehouse.</p>
<p>The common raven is a large all-black passerine bird found across the Northern Hemisphere.</p></article>`;
const PAGE_AFTER = `<article><h1>Corvus Field Monitor</h1>
<p>Status: Out of stock. Price 24.99. Backordered, expected to ship next month.</p>
<p>The common raven is a large all-black passerine bird found across the Northern Hemisphere.</p></article>`;

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

export async function runFeaturesSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const themeBefore = nativeTheme.themeSource;
  const chrome = win.chrome.webContents;
  const chromeHas = (sel: string): Promise<unknown> => chrome.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(sel)}))`);

  // Give the window a couple of tabs and a group for a richer sidebar.
  const t1 = win.createTab("about:blank", { activate: false });
  const t2 = win.createTab("about:blank", { activate: false });
  win.createGroup([t1.id, t2.id], { title: "Research", color: "green" });
  await sleep(200);

  // ---------------------------------------------------------------- vertical tabs
  for (const theme of ["light", "dark"] as const) {
    nativeTheme.themeSource = theme;
    ctx.settings.update({ appearance: { tabLayout: "vertical" } });
    await sleep(350);
    const ok = (await chromeHas(".chrome-root.vertical .v-tabs")) === true && (await chromeHas(".v-tabs .v-tab")) === true;
    check(`vertical tabs rendered (${theme})`, ok, ok ? undefined : await chrome.executeJavaScript("document.querySelector('.chrome-root')?.className"));
    await capture(`vertical-tabs-${theme}`, chrome);
  }
  // Collapse to icons, screenshot, then back to the default horizontal strip.
  ctx.settings.update({ appearance: { sidebarCollapsed: true } });
  await sleep(300);
  check("vertical sidebar collapses to icons", (await chromeHas(".chrome-root.sidebar-collapsed .v-tabs.collapsed")) === true);
  await capture("vertical-tabs-collapsed", chrome);
  ctx.settings.update({ appearance: { tabLayout: "horizontal", sidebarCollapsed: false } });
  nativeTheme.themeSource = "light";
  await sleep(250);

  // ---------------------------------------------------------------- workspaces
  const before = win.tabIds().length;
  win.profile.workspaces.save("Smoke workspace", win.workspaceTabs(), win.listGroups());
  const saved = win.profile.workspaces.list();
  check("workspace saved with tabs + group", saved.some((w) => w.name === "Smoke workspace" && w.tabs.length >= 2 && w.groups.length === 1), saved.map((w) => w.name));
  const ws = saved[saved.length - 1];
  if (ws) {
    win.openWorkspace(ws.id, "merge");
    await sleep(400);
    check("workspace merge restores tabs + group", win.tabIds().length > before && win.listGroups().some((g) => g.title === "Research"), { before, after: win.tabIds().length });
  }
  // Workspaces popover screenshot.
  win.sendCommand({ type: "open-workspaces" });
  await sleep(400);
  const popover = await poll(chrome, "document.querySelector('.workspaces-popover .ws-row')");
  check("workspaces popover lists saved workspaces", popover);
  await capture("workspaces-popover", chrome);
  win.sendCommand({ type: "close-overlays" });
  await sleep(150);

  // ---------------------------------------------------------------- local search ("find in my pages")
  win.profile.semanticIndex.addVisit(
    "https://smoke.example/raven",
    "Field notes journal",
    "The common raven is a large all-black passerine bird found across the Northern Hemisphere.",
    Date.now(),
  );
  const localRes = await ctx.semanticSearch.query(win.profile, "black bird northern hemisphere", 5);
  check(
    "local search ranks a page by its captured body text (keyword, no network)",
    localRes.hits.some((hit) => hit.url === "https://smoke.example/raven") && !localRes.usedEmbeddings,
    localRes.hits.map((hit) => hit.url),
  );

  const findTab = win.createTab("corvus://find/", { activate: true });
  const findWc = findTab.view.webContents;
  await poll(findWc, "document.querySelector('.input')");
  await findWc.executeJavaScript(`(() => {
    const inp = document.querySelector('.input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, 'black bird northern hemisphere');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const findShown = await poll(findWc, "[...document.querySelectorAll('.list-row .title')].some((e) => e.innerText.includes('Field notes'))", 6000);
  check("corvus://find renders local results", findShown, findShown ? undefined : await findWc.executeJavaScript("document.querySelector('.page-main')?.innerText?.slice(0,300)"));
  await capture("find", findWc);
  win.closeTab(findTab.id);

  // ---------------------------------------------------------------- page-change monitoring
  let body = PAGE_BEFORE;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>Monitor</title></head><body>${body}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const watchUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  ctx.assist.setTestProvider(fakeProvider());
  // The SSRF guard blocks loopback in production; inject a fetcher so the smoke can watch the local server.
  ctx.monitor.setTestFetcher(async (url) => extractReadableText(await (await fetch(url)).text()));

  try {
    const store = ctx.monitor.storeFor(win.profile);
    const watch = store.add({ url: watchUrl, title: "Monitor page", intervalMinutes: 30 });
    check("watch added", Boolean(watch));
    if (watch) {
      ctx.monitor.checkNow(win.profile, watch.id);
      await poll(chrome, "true", 1); // yield
      let baseline = false;
      for (let i = 0; i < 60 && !baseline; i++) {
        baseline = store.get(watch.id)?.fingerprint !== null;
        await sleep(100);
      }
      check("watch baseline captured on first check", baseline, store.get(watch.id)?.lastResult);

      body = PAGE_AFTER; // force a change
      ctx.monitor.checkNow(win.profile, watch.id);
      let changed = false;
      for (let i = 0; i < 80 && !changed; i++) {
        changed = store.get(watch.id)?.lastResult === "changed";
        await sleep(100);
      }
      const after = store.get(watch.id);
      check("change detected + AI summary produced", changed && after?.changeSummary === CHANGE_SUMMARY && after?.unseen === true, {
        result: after?.lastResult,
        summary: after?.changeSummary,
      });
    }

    const watchesTab = win.createTab("corvus://watches/", { activate: true });
    const wc = watchesTab.view.webContents;
    const shown = await poll(wc, "document.querySelector('.watch-row .watch-status.changed') && [...document.querySelectorAll('.watch-summary')].some((e) => e.innerText.includes('out of stock'))", 9000);
    check("corvus://watches shows the change + summary", shown, shown ? undefined : await wc.executeJavaScript("document.querySelector('.watch-row')?.innerText?.slice(0,300)"));
    await capture("watches", wc);
    nativeTheme.themeSource = "dark";
    ctx.windows.broadcastState();
    await poll(wc, "matchMedia('(prefers-color-scheme: dark)').matches");
    await sleep(250);
    await capture("watches-dark", wc);
    win.closeTab(watchesTab.id);
    if (watch) store.remove(watch.id);
  } finally {
    nativeTheme.themeSource = themeBefore;
    ctx.assist.setTestProvider(undefined);
    ctx.monitor.setTestFetcher(undefined);
    server.close();
  }
}
