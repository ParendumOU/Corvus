import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { nativeTheme, type WebContents } from "electron";
import { toChromiumTime } from "../shared/browser-import";
import type { AppContext } from "./context";
import { LIVE_HISTORY_SETTINGS_URL } from "./live-history";
import { fillChromeHistory, openChromeWriter, writeLiveFixtures } from "./smoke-live-fixtures";
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

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(100);
  }
  return fn();
}

/** Types into the omnibox of a fresh tab and returns what its suggestions list (title and source badge). */
async function suggest(win: BrowserWindowCtl, text: string, expect: string): Promise<Array<{ title: string; source: string | null; icon: boolean; label: string | null }>> {
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
    "[...document.querySelectorAll('.omni-suggestions li')].map((li) => ({ title: li.querySelector('.sugg-title')?.textContent ?? '', source: li.querySelector('.source-badge')?.dataset.source ?? null, icon: Boolean(li.querySelector('.source-badge img')), label: li.querySelector('.source-badge')?.getAttribute('aria-label') ?? null }))",
  )) as Array<{ title: string; source: string | null; icon: boolean; label: string | null }>;
}

/** Adds a visit to a copy of a Chromium History (not the followed one), as Chrome would save it. */
function addChromeVisit(file: string, url: string, title: string, at: number): void {
  const db = new DatabaseSync(file);
  try {
    const time = toChromiumTime(at);
    const id = db.prepare("INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, 1, ?, 0)").run(url, title, time).lastInsertRowid;
    db.prepare("INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, 1)").run(id, time);
  } finally {
    db.close();
  }
}

/**
 * Live history from other browsers: on by default in a fresh profile, following the default profile
 * of a fake Chrome and a fake Firefox, with a one-time bar saying so (Settings, Turn off), never read
 * by a private window. Visits appended to their databases come in when the window gets focus (and
 * through the file watcher), also while the fake Chrome keeps its History open and writing as Chrome
 * does; a read that fails is tried again without a new change. They show in the omnibox by address
 * and title word with their browser's badge, never reach sync, and "Forget visits from" removes
 * them. An unchanged database is never copied; a 50 MB History is timed.
 */
export async function runLiveHistorySmoke(ctx: AppContext, h: LiveHistorySmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const profile = win.profile;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-live-smoke-"));
  const historyBefore = new Set(profile.history.all().map((e) => e.url));
  const fixtures = writeLiveFixtures(path.join(root, "small"));
  const tabs: string[] = [];
  const themeBefore = nativeTheme.themeSource;
  const languageBefore = ctx.settings.get().appearance.language;
  const chromeUi = win.chrome.webContents;
  const live = (): Array<{ url: string; source?: string }> => profile.history.all().filter((e) => e.source);
  const hasUrl = (url: string): boolean => profile.history.all().some((e) => e.url === url);
  const statusOf = async (key: string) => (await ctx.liveHistory.view(profile)).sources.find((s) => s.key === key)?.status;
  const focusWindow = async (target: BrowserWindowCtl = win): Promise<void> => {
    // What switching to Corvus from another app does: the window gets focus.
    target.win.emit("focus");
    await sleep(50);
  };
  const barText = (wc: WebContents): Promise<string> => wc.executeJavaScript("[...document.querySelectorAll('[data-dialog-bar]')].map((b) => b.textContent).join(' | ')").catch(() => "") as Promise<string>;
  const pressBar = (label: string): Promise<boolean> =>
    chromeUi.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll("[data-dialog-bar]")].find((x) => x.textContent.includes("Chrome")); const btn = b && [...b.querySelectorAll("button")].find((x) => x.textContent === ${JSON.stringify(label)}); btn?.click(); return Boolean(btn); })()`,
    ) as Promise<boolean>;
  try {
    // Settings already open from before any browser was found: the bar's Settings button reuses it, and it must not stay stale.
    const earlierSettings = win.createTab("corvus://settings/#appearance", { activate: false });
    tabs.push(earlierSettings.id);
    await poll(earlierSettings.view.webContents, "document.querySelector('[data-live-history]')");
    ctx.browserImport.setTestRoots(fixtures.roots);
    const now = Date.now();
    fixtures.chromeVisit("https://example.com/garden/tomatoes", "Growing tomatoes on a balcony", now - 3_600_000);
    fixtures.firefoxVisit("https://example.org/recipes/sourdough", "Sourdough bread recipe", now - 7_200_000);

    // A profile that never chose: on, following each browser's default profile, as soon as it loads.
    const fresh = profile.liveHistory.get();
    ctx.liveHistory.attach(profile, 0);
    const byDefault = await waitFor(() => hasUrl("https://example.com/garden/tomatoes") && hasUrl("https://example.org/recipes/sourdough"), 8000);
    check(
      "live history: on by default in a fresh profile, it follows each browser's default profile and brings their recent pages, marked by browser",
      fresh.enabled === null && fresh.sources === null && byDefault && profile.history.all().find((e) => e.url === "https://example.com/garden/tomatoes")?.source === "chrome",
      { fresh: { enabled: fresh.enabled, sources: fresh.sources }, live: live() },
    );

    // A private window never reads the other browsers, nor says anything about them; nor does a bar cover an AI agent's tab.
    const agentTab = win.activeTab()?.agentControlled === true;
    if (agentTab) await ctx.liveHistory.announce(win);
    const overAgent = agentTab ? await barText(chromeUi) : "";
    const pw = ctx.windows.openPrivate(profile.profile.id, []);
    await sleep(500);
    fixtures.chromeVisit("https://example.com/private/never", "Seen while a private window had focus", Date.now());
    const copiesBefore = ctx.liveHistory.copies;
    await focusWindow(pw);
    await ctx.liveHistory.announce(pw);
    await sleep(400);
    const privateBars = await barText(pw.chrome.webContents);
    check(
      "live history: a private window's focus reads nothing and shows no bar, and no bar covers an AI agent's tab",
      ctx.liveHistory.copies === copiesBefore && !hasUrl("https://example.com/private/never") && !privateBars && !overAgent && !profile.liveHistory.get().noticeShown,
      { copies: ctx.liveHistory.copies - copiesBefore, privateBars, agentTab, overAgent },
    );
    pw.close();
    await sleep(300);
    const ownTab = win.createTab("corvus://newtab/", { activate: true });
    tabs.push(ownTab.id);
    await focusWindow();
    await sleep(500);

    // The one-time bar: what Corvus turned on by itself, in plain words, with Settings and Turn off.
    const message = "Corvus now also suggests the pages you visit in Chrome and Firefox when you type in the address bar.";
    void ctx.liveHistory.announce(win);
    const shown = await poll(chromeUi, `document.querySelector('[data-dialog-bar]')?.textContent.includes(${JSON.stringify(message)})`);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(400);
      await capture(`live-history-notice-${theme}`, chromeUi);
    }
    nativeTheme.themeSource = themeBefore;
    await ctx.liveHistory.announce(win);
    const bars = ctx.dialogs.bars(win).length;
    check("live history: a bar says once that Corvus turned it on, which browsers, and that the pages stay on this computer", shown && bars === 1 && profile.liveHistory.get().noticeShown, {
      shown,
      bars,
      text: await barText(chromeUi),
    });

    // Settings opens the section, which says it is on by default.
    await pressBar("Settings");
    const settingsOpen = await waitFor(() => win.activeTab()?.url.startsWith(LIVE_HISTORY_SETTINGS_URL.split("#")[0]!) === true, 5000);
    const settings = win.activeTab()!;
    tabs.push(settings.id);
    const wc = settings.view.webContents;
    const section = await poll(wc, "document.querySelector('[data-live-default]') && document.querySelectorAll('[data-live-source] input:checked').length === 2 && document.querySelector('[data-live-history] .toggle')?.getAttribute('aria-checked') === 'true'");
    check("live history: the bar's Settings opens the section, on by default with each browser's default profile ticked", settingsOpen && section && ctx.dialogs.bars(win).length === 0, {
      url: win.activeTab()?.url,
      section,
    });
    // Each browser's own icon from this computer (the fake Chrome's menu entry names one), the letter for one without.
    const icons = (await ctx.liveHistory.view(profile)).icons;
    const settingsIcons = (await wc.executeJavaScript(
      "[...document.querySelectorAll('[data-live-source] .source-badge')].map((b) => ({ source: b.dataset.source, icon: Boolean(b.querySelector('img')), label: b.getAttribute('aria-label'), letter: b.textContent }))",
    )) as Array<{ source: string; icon: boolean; label: string; letter: string }>;
    const chromeBadge = settingsIcons.find((b) => b.source === "chrome");
    const firefoxBadge = settingsIcons.find((b) => b.source === "firefox");
    check(
      "live history: Settings shows each browser's own icon from this computer, and the letter mark for one whose icon was not found",
      Boolean(icons.chrome?.startsWith("data:image/png;base64,")) && chromeBadge?.icon === true && chromeBadge.label === "From Chrome" && firefoxBadge?.icon === Boolean(icons.firefox) && (Boolean(icons.firefox) || firefoxBadge?.letter === "F"),
      { settingsIcons, found: Object.keys(icons) },
    );
    await wc.executeJavaScript("document.getElementById('live-history')?.scrollIntoView({ block: 'start' })");
    await sleep(300);
    await capture("live-history-settings-default", wc);
    nativeTheme.themeSource = "dark";
    await sleep(300);
    await capture("live-history-settings-dark", wc);
    nativeTheme.themeSource = themeBefore;

    // In Spanish: the section, then the bar (shown again for the screenshot), whose Turn off undoes it all.
    ctx.settings.update({ appearance: { language: "es" } });
    wc.reload();
    const spanish = await poll(wc, "document.querySelector('#live-history h2')?.textContent === 'Historial en vivo de otros navegadores' && document.querySelector('[data-live-default]')?.textContent.startsWith('Activado de forma predeterminada')");
    await wc.executeJavaScript("document.getElementById('live-history')?.scrollIntoView({ block: 'start' })");
    await sleep(300);
    await capture("live-history-settings-es", wc);
    profile.liveHistory.setNoticeShown(false);
    const answered = ctx.liveHistory.announce(win);
    const spanishBar = await poll(chromeUi, "document.querySelector('[data-dialog-bar]')?.textContent.includes('Corvus ahora también sugiere las páginas que visitas en Chrome y Firefox')");
    await sleep(300);
    await capture("live-history-notice-es", chromeUi);
    await pressBar("Desactivar");
    await answered;
    const off = profile.liveHistory.get();
    check("live history: Settings and the bar in Spanish; the bar's Turn off turns it off for good and removes the pages it brought", spanish && spanishBar && off.enabled === false && live().length === 0 && ctx.dialogs.bars(win).length === 0, {
      spanish,
      spanishBar,
      enabled: off.enabled,
      live: live().length,
    });
    ctx.settings.update({ appearance: { language: languageBefore } });

    // Turned on again in Settings: each browser's default profile.
    wc.reload();
    await poll(wc, "document.querySelector('[data-live-history] .toggle')?.getAttribute('aria-checked') === 'false'");
    await wc.executeJavaScript("document.querySelector('[data-live-history] .toggle')?.click()");
    const on = await poll(wc, "document.querySelectorAll('[data-live-source] input:checked').length === 2 && !document.querySelector('[data-live-default]')");
    await wc.executeJavaScript("document.getElementById('live-history')?.scrollIntoView({ block: 'start' })");
    await capture("live-history-settings-on", wc);
    check("live history: turned on again in Settings it follows the default profiles, now by the person's choice", on && profile.liveHistory.get().enabled === true, { on });

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
    await capture("live-history-omnibox", chromeUi);
    const byWord = await suggest(win, "lisbon", "Riding the Lisbon trams");
    await capture("live-history-omnibox-word", chromeUi);
    nativeTheme.themeSource = "dark";
    await sleep(300);
    await suggest(win, "trams", "Riding the Lisbon trams");
    await capture("live-history-omnibox-dark", chromeUi);
    nativeTheme.themeSource = themeBefore;
    win.sendCommand({ type: "close-overlays" });
    // The browser UI takes its language when it loads.
    ctx.settings.update({ appearance: { language: "es" } });
    chromeUi.reload();
    await poll(chromeUi, "document.documentElement.lang === 'es' && document.querySelector('.omni-input')");
    await sleep(500);
    const inSpanish = await suggest(win, "example.com/news/live", "Live history arrives in Corvus");
    await capture("live-history-omnibox-es", chromeUi);
    win.sendCommand({ type: "close-overlays" });
    ctx.settings.update({ appearance: { language: languageBefore } });
    chromeUi.reload();
    await poll(chromeUi, "document.documentElement.lang !== 'es' && document.querySelector('.omni-input')");
    await sleep(300);
    check(
      "live history: the omnibox suggests other browsers' pages by address and title word, with the browser's own icon (or its letter), named for screen readers",
      byUrl.some((s) => s.title === "Live history arrives in Corvus" && s.source === "chrome" && s.icon && s.label === "From Chrome") &&
        byWord.some((s) => s.title === "Riding the Lisbon trams" && s.source === "firefox" && s.icon === Boolean(icons.firefox) && s.label === "From Firefox") &&
        inSpanish.some((s) => s.source === "chrome" && s.icon && s.label === "De Chrome"),
      { byUrl, byWord, inSpanish },
    );

    // Local only: sync's view of the history leaves them out.
    const synced = new Set((await historyAdapter(profile.history).list()).map((i) => i.id));
    check("live history: pages from other browsers are never synced", live().length >= 2 && live().every((e) => !synced.has(e.url)), { live: live().length });

    // Nothing changed: focus makes no copy.
    const copies = ctx.liveHistory.copies;
    await focusWindow();
    await focusWindow();
    const checkedAt = performance.now();
    await ctx.liveHistory.check(profile);
    const idleMs = Math.round((performance.now() - checkedAt) * 100) / 100;
    check("live history: an unchanged database is not copied or read", ctx.liveHistory.copies === copies, { copies: ctx.liveHistory.copies - copies, msPerCheck: idleMs });

    // The file watcher: a visit saved while Corvus is in front comes in about a second later.
    await focusWindow();
    const savedAt = performance.now();
    fixtures.chromeVisit("https://example.com/watched/page", "Seen by the watcher", Date.now());
    const watched = await waitFor(() => hasUrl("https://example.com/watched/page"), 8000);
    check("live history: a change to the database is read about a second after it", watched, { ms: Math.round(performance.now() - savedAt) });

    // Chrome keeps running: History held open (exclusive), a transaction always open, saved every few seconds.
    const chrome = openChromeWriter(fixtures.chromeHistory);
    try {
      chrome.visit("https://example.com/running/first", "Opened while Chrome runs", Date.now());
      await focusWindow();
      await sleep(1500);
      const notYet = !hasUrl("https://example.com/running/first") && !(await statusOf("chrome/Default"))?.error;
      const committedAt = performance.now();
      chrome.commit();
      const running = await waitFor(() => hasUrl("https://example.com/running/first"), 6000);
      const runningMs = Math.round(performance.now() - committedAt);
      // Typing right after Chrome saved: the address bar reads it first.
      chrome.visit("https://example.com/running/typed-at-once", "Typed right after Chrome saved it", Date.now());
      chrome.commit();
      const typedAt = performance.now();
      const typed = await suggest(win, "example.com/running/typed", "Typed right after Chrome saved it");
      const typedMs = Math.round(performance.now() - typedAt);
      win.sendCommand({ type: "close-overlays" });
      check(
        "live history: while Chrome keeps History open and writing, a visit comes in once Chrome saves it, and at once when typing in the address bar",
        notYet && running && runningMs < 4000 && typed.some((s) => s.title === "Typed right after Chrome saved it") && !(await statusOf("chrome/Default"))?.error,
        { notYet, runningMs, typedMs, typed },
      );
    } finally {
      chrome.close();
    }

    // A read that fails (the file is unreadable for a moment) is tried again a few seconds later,
    // without waiting for Chrome to write again: here the restored file even has the same size and time.
    const next = path.join(root, "next-History");
    fs.copyFileSync(fixtures.chromeHistory, next);
    addChromeVisit(next, "https://example.com/retried/page", "Read on the second try", Date.now());
    const size = fs.statSync(next).size;
    const at = Math.floor(Date.now() / 1000) - 120;
    const failedCopies = ctx.liveHistory.copies;
    await focusWindow();
    fs.writeFileSync(fixtures.chromeHistory, Buffer.alloc(size, "x"));
    fs.utimesSync(fixtures.chromeHistory, at, at);
    const failed = await waitFor(async () => Boolean((await statusOf("chrome/Default"))?.error), 6000);
    fs.copyFileSync(next, fixtures.chromeHistory);
    fs.utimesSync(fixtures.chromeHistory, at, at);
    const failedAt = performance.now();
    const retried = await waitFor(() => hasUrl("https://example.com/retried/page"), 10_000);
    const after = await statusOf("chrome/Default");
    check("live history: a read that failed is tried again a few seconds later, without a new change", failed && retried && !after?.error, {
      failed,
      retriedMs: Math.round(performance.now() - failedAt),
      copies: ctx.liveHistory.copies - failedCopies,
      status: after,
    });

    // The history page shows where a page came from.
    const historyTab = win.createTab("corvus://history", { activate: true });
    tabs.push(historyTab.id);
    const shownSources = await poll(historyTab.view.webContents, "document.querySelector('.history-source .source-badge[data-source=\"firefox\"]') && document.querySelector('.history-source .source-badge[data-source=\"chrome\"] img')");
    await capture("live-history-history-page", historyTab.view.webContents);
    check("live history: the history page marks pages from other browsers, with Chrome's own icon", shownSources);

    // "Forget visits from Chrome" removes every page known only from Chrome; Firefox's stay.
    profile.history.recordVisit("https://example.com/news/live-history-arrives", "Live history arrives in Corvus");
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
      forgot && !live().some((e) => e.source === "chrome") && live().some((e) => e.source === "firefox") && hasUrl("https://example.com/news/live-history-arrives"),
      { forgot, live: live() },
    );
    await ctx.liveHistory.set(profile, { enabled: false, sources: [] });
    await ctx.liveHistory.forget(profile, "firefox");

    // A heavy user's History (about 50 MB): one new visit, then focus.
    const big = writeLiveFixtures(path.join(root, "big"));
    big.close();
    fillChromeHistory(big.chromeHistory, 92_000, Date.now() - 8 * 86_400_000);
    const bigSize = fs.statSync(big.chromeHistory).size;
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
    check("live history: a 50 MB History is read on focus in well under a second, an unchanged one only stat'ed", bigSize > 45_000_000 && hasUrl("https://example.com/big/new-visit") && (status?.ms ?? 9999) < 1500, {
      sizeMb: Math.round(bigSize / 1e5) / 10,
      firstReadMs: firstMs,
      focusReadMs: focusMs,
      readMs: status?.ms,
      unchangedCheckMs: unchangedMs,
    });
  } catch (err) {
    check("live history: smoke ran", false, (err as Error).stack ?? String(err));
  } finally {
    nativeTheme.themeSource = themeBefore;
    ctx.settings.update({ appearance: { language: languageBefore } });
    await ctx.liveHistory.set(profile, { enabled: false, sources: [] }).catch(() => undefined);
    for (const mark of Object.keys(profile.history.liveCounts())) profile.history.forgetSource(mark);
    profile.history.remove(profile.history.all().filter((e) => !historyBefore.has(e.url)).map((e) => e.id));
    ctx.browserImport.setTestRoots(null);
    for (const id of tabs) win.closeTab(id);
    fixtures.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
