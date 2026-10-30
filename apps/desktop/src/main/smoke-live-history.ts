import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { nativeTheme, type WebContents } from "electron";
import type { AppContext } from "./context";
import { fillChromeHistory, writeLiveFixtures } from "./smoke-live-fixtures";
import { historyAdapter } from "./sync-adapters";
import type { BrowserWindowCtl } from "./window";

interface LiveHistorySmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(150);
  }
  return false;
}

async function waitFor(fn: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
}

/** Types into the omnibox of a fresh tab and returns what its suggestions list (title and source badge). */
async function suggest(win: BrowserWindowCtl, text: string, expect: string): Promise<Array<{ title: string; source: string | null }>> {
  const chrome = win.chrome.webContents;
  chrome.focus();
  await chrome.executeJavaScript("(() => { const i = document.querySelector('.omni-input'); i.focus(); i.select(); })()");
  for (const ch of text) {
    chrome.sendInputEvent({ type: "keyDown", keyCode: ch });
    chrome.sendInputEvent({ type: "char", keyCode: ch });
    chrome.sendInputEvent({ type: "keyUp", keyCode: ch });
  }
  await poll(chrome, `[...document.querySelectorAll('.omni-suggestions li')].some((li) => li.textContent.includes(${JSON.stringify(expect)}))`, 5000);
  return (await chrome.executeJavaScript(
    "[...document.querySelectorAll('.omni-suggestions li')].map((li) => ({ title: li.querySelector('.sugg-title')?.textContent ?? '', source: li.querySelector('.source-badge')?.dataset.source ?? null }))",
  )) as Array<{ title: string; source: string | null }>;
}

/**
 * Live history from other browsers: off by default; turned on in Settings it follows the default
 * profile of a fake Chrome and a fake Firefox; visits appended to their databases come in when the
 * window gets focus (and through the file watcher), show in the omnibox by address and title word
 * with their browser's badge, never reach sync, and "Forget visits from" removes them. An unchanged
 * database is never copied; a 50 MB History is timed.
 */
export async function runLiveHistorySmoke(ctx: AppContext, h: LiveHistorySmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const profile = win.profile;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-live-smoke-"));
  const historyBefore = new Set(profile.history.all().map((e) => e.url));
  const fixtures = writeLiveFixtures(path.join(root, "small"));
  const tabs: string[] = [];
  const themeBefore = nativeTheme.themeSource;
  const live = (): Array<{ url: string; source?: string }> => profile.history.all().filter((e) => e.source);
  const hasUrl = (url: string): boolean => profile.history.all().some((e) => e.url === url);
  const focusWindow = async (): Promise<void> => {
    // What switching to Corvus from another app does: the window gets focus.
    win.win.emit("focus");
    await sleep(50);
  };
  try {
    ctx.browserImport.setTestRoots(fixtures.roots);
    const now = Date.now();
    fixtures.chromeVisit("https://example.com/garden/tomatoes", "Growing tomatoes on a balcony", now - 3_600_000);
    fixtures.firefoxVisit("https://example.org/recipes/sourdough", "Sourdough bread recipe", now - 7_200_000);

    const settings = win.createTab("corvus://settings/#live-history", { activate: true });
    tabs.push(settings.id);
    const wc = settings.view.webContents;
    const listed = await poll(wc, "document.querySelectorAll('[data-live-source]').length === 2");
    const offByDefault = (await wc.executeJavaScript("document.querySelector('[data-live-history] .toggle')?.getAttribute('aria-checked')")) === "false";
    await focusWindow();
    await sleep(300);
    check("live history: off by default, Settings lists the other browsers, and nothing is read", listed && offByDefault && ctx.liveHistory.copies === 0 && live().length === 0, {
      listed,
      offByDefault,
      copies: ctx.liveHistory.copies,
    });
    await wc.executeJavaScript("document.getElementById('live-history')?.scrollIntoView({ block: 'start' })");
    await capture("live-history-settings-off", wc);

    // Turned on: each browser's default profile is followed and what it saved this week comes in.
    await wc.executeJavaScript("document.querySelector('[data-live-history] .toggle')?.click()");
    const on = await poll(wc, "document.querySelectorAll('[data-live-source] input:checked').length === 2 && document.querySelectorAll('[data-live-count]').length === 2");
    check(
      "live history: turning it on follows the default profiles and brings their recent pages, marked by browser",
      on && profile.history.all().find((e) => e.url === "https://example.com/garden/tomatoes")?.source === "chrome" && profile.history.all().find((e) => e.url === "https://example.org/recipes/sourdough")?.source === "firefox",
      { on, live: live() },
    );
    await wc.executeJavaScript("document.getElementById('live-history')?.scrollIntoView({ block: 'start' })");
    await capture("live-history-settings-on", wc);
    nativeTheme.themeSource = "dark";
    await sleep(300);
    await capture("live-history-settings-dark", wc);
    nativeTheme.themeSource = themeBefore;
    const languageBefore = ctx.settings.get().appearance.language;
    ctx.settings.update({ appearance: { language: "es" } });
    wc.reload();
    const spanish = await poll(wc, "document.querySelector('#live-history h2')?.textContent === 'Historial en vivo de otros navegadores' && document.querySelectorAll('[data-live-count]').length === 2");
    await wc.executeJavaScript("document.getElementById('live-history')?.scrollIntoView({ block: 'start' })");
    await sleep(300);
    await capture("live-history-settings-es", wc);
    ctx.settings.update({ appearance: { language: languageBefore } });
    check("live history: Settings shows the section in Spanish", spanish);

    // New visits in both browsers, then the person switches to Corvus.
    fixtures.chromeVisit("https://example.com/news/live-history-arrives", "Live history arrives in Corvus", Date.now());
    fixtures.firefoxVisit("https://example.org/travel/lisbon-trams", "Riding the Lisbon trams", Date.now());
    const focusedAt = performance.now();
    await focusWindow();
    const arrived = await waitFor(() => hasUrl("https://example.com/news/live-history-arrives") && hasUrl("https://example.org/travel/lisbon-trams"), 5000);
    const view = await ctx.liveHistory.view(profile);
    check("live history: a window getting focus reads the new visits", arrived, {
      ms: Math.round(performance.now() - focusedAt),
      status: view.sources.map((s) => ({ key: s.key, status: s.status })),
    });

    // The omnibox suggests them by address and by a title word, with the browser's badge.
    const newTab = win.createTab("corvus://newtab/", { activate: true });
    tabs.push(newTab.id);
    await sleep(500);
    const byUrl = await suggest(win, "example.com/news/live", "Live history arrives in Corvus");
    await capture("live-history-omnibox", win.chrome.webContents);
    const byWord = await suggest(win, "lisbon", "Riding the Lisbon trams");
    await capture("live-history-omnibox-word", win.chrome.webContents);
    nativeTheme.themeSource = "dark";
    await sleep(300);
    await suggest(win, "trams", "Riding the Lisbon trams");
    await capture("live-history-omnibox-dark", win.chrome.webContents);
    nativeTheme.themeSource = themeBefore;
    win.sendCommand({ type: "close-overlays" });
    check(
      "live history: the omnibox suggests other browsers' pages by address and title word, with their badge",
      byUrl.some((s) => s.title === "Live history arrives in Corvus" && s.source === "chrome") && byWord.some((s) => s.title === "Riding the Lisbon trams" && s.source === "firefox"),
      { byUrl, byWord },
    );

    // Local only: sync's view of the history leaves them out.
    const synced = new Set((await historyAdapter(profile.history).list()).map((i) => i.id));
    check("live history: pages from other browsers are never synced", live().length >= 4 && live().every((e) => !synced.has(e.url)), { live: live().length });

    // Nothing changed: focus makes no copy.
    const copies = ctx.liveHistory.copies;
    await focusWindow();
    await focusWindow();
    const checkedAt = performance.now();
    await ctx.liveHistory.check(profile);
    const idleMs = Math.round((performance.now() - checkedAt) * 100) / 100;
    check("live history: an unchanged database is not copied or read", ctx.liveHistory.copies === copies, { copies: ctx.liveHistory.copies - copies, msPerCheck: idleMs });

    // The file watcher: a visit saved while Corvus has focus comes in about two seconds later.
    fixtures.chromeVisit("https://example.com/watched/page", "Seen by the watcher", Date.now());
    const watched = await waitFor(() => hasUrl("https://example.com/watched/page"), 8000);
    check("live history: a change to the database is read about two seconds after it", watched);

    // The history page shows where a page came from.
    const historyTab = win.createTab("corvus://history", { activate: true });
    tabs.push(historyTab.id);
    const shown = await poll(historyTab.view.webContents, "document.querySelector('.history-source .source-badge[data-source=\"firefox\"]') && document.querySelector('.history-source .source-badge[data-source=\"chrome\"]')");
    await capture("live-history-history-page", historyTab.view.webContents);
    check("live history: the history page marks pages from other browsers", shown);

    // "Forget visits from Chrome" removes every page known only from Chrome; Firefox's stay.
    profile.history.recordVisit("https://example.com/garden/tomatoes", "Growing tomatoes on a balcony");
    win.activate(settings.id);
    wc.reload();
    await poll(wc, "document.querySelector('[data-live-forget=\"chrome\"]')");
    await wc.executeJavaScript("document.querySelector('[data-live-forget=\"chrome\"]')?.scrollIntoView({ block: 'center' })");
    await capture("live-history-forget-before", wc);
    await wc.executeJavaScript("document.querySelector('[data-live-forget=\"chrome\"]')?.click()");
    const forgot = await poll(wc, "!document.querySelector('[data-live-forget=\"chrome\"]') && document.querySelector('[data-live-forget=\"firefox\"]')");
    await sleep(400);
    await capture("live-history-forget-after", wc);
    check(
      "live history: Forget visits from Chrome removes them, keeps Firefox's and the page Corvus visited itself",
      forgot && !live().some((e) => e.source === "chrome") && live().some((e) => e.source === "firefox") && hasUrl("https://example.com/garden/tomatoes"),
      { forgot, live: live() },
    );
    await ctx.liveHistory.set(profile, { enabled: false, sources: [] });
    await ctx.liveHistory.forget(profile, "firefox");

    // A heavy user's History (about 50 MB): one new visit, then focus.
    const big = writeLiveFixtures(path.join(root, "big"));
    big.close();
    fillChromeHistory(big.chromeHistory, 92_000, Date.now() - 8 * 86_400_000);
    const size = fs.statSync(big.chromeHistory).size;
    ctx.browserImport.setTestRoots(big.roots);
    let started = performance.now();
    await ctx.liveHistory.set(profile, { enabled: true, sources: ["chrome/Default"] });
    const firstMs = Math.round(performance.now() - started);
    big.chromeVisit("https://example.com/big/new-visit", "One new visit in a big history", Date.now());
    started = performance.now();
    await focusWindow();
    await ctx.liveHistory.check(profile);
    const focusMs = Math.round(performance.now() - started);
    const status = (await ctx.liveHistory.view(profile)).sources[0]?.status;
    started = performance.now();
    await ctx.liveHistory.check(profile);
    const unchangedMs = Math.round((performance.now() - started) * 100) / 100;
    check("live history: a 50 MB History is read on focus in well under a second, an unchanged one only stat'ed", size > 45_000_000 && hasUrl("https://example.com/big/new-visit") && (status?.ms ?? 9999) < 1500, {
      sizeMb: Math.round(size / 1e5) / 10,
      firstReadMs: firstMs,
      focusReadMs: focusMs,
      readMs: status?.ms,
      unchangedCheckMs: unchangedMs,
    });
  } catch (err) {
    check("live history: smoke ran", false, (err as Error).stack ?? String(err));
  } finally {
    nativeTheme.themeSource = themeBefore;
    await ctx.liveHistory.set(profile, { enabled: false, sources: [] }).catch(() => undefined);
    for (const mark of Object.keys(profile.history.liveCounts())) profile.history.forgetSource(mark);
    profile.history.remove(profile.history.all().filter((e) => !historyBefore.has(e.url)).map((e) => e.id));
    ctx.browserImport.setTestRoots(null);
    for (const id of tabs) win.closeTab(id);
    fixtures.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
