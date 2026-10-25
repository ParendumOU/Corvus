import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import { BAR_FOLDER_ID, OTHER_FOLDER_ID } from "../shared/bookmark-tree";
import { buildSuggestions } from "../shared/suggest";
import { writeBrowserFixtures } from "./smoke-import-fixtures";
import type { BrowserWindowCtl } from "./window";

interface BrowserImportSmokeHelpers {
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

/**
 * Import from other browsers in Settings: fake Chrome (two profiles) and Firefox folders are found
 * with their counts, and importing one profile brings its bookmarks (onto the bar and into Other bookmarks) and its
 * history into Corvus, through Electron's own SQLite.
 */
export async function runBrowserImportSmoke(ctx: AppContext, h: BrowserImportSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-import-smoke-"));
  const profile = win.profile;
  const bookmarksBefore = new Set(profile.bookmarks.list().map((b) => b.id));
  const historyBefore = new Set(profile.history.all().map((e) => e.url));
  const workspacesBefore = new Set(profile.workspaces.list().map((w) => w.id));
  const shortcutsBefore = new Set(profile.siteSearch.list().map((s) => s.keyword));
  let tabId: string | null = null;
  try {
    ctx.browserImport.setTestRoots(writeBrowserFixtures(root));
    const tab = win.createTab("corvus://settings/#import");
    tabId = tab.id;
    const wc = tab.view.webContents;
    const listed = await poll(
      wc,
      "document.querySelectorAll('[data-import-source=\"chrome\"] [data-import-profile]').length === 2 && (document.querySelector('[data-import-source=\"firefox\"]')?.innerText ?? '').includes('2 bookmarks')",
    );
    const chromeText = (await wc.executeJavaScript("document.querySelector('[data-import-source=\"chrome\"]')?.innerText ?? ''")) as string;
    await wc.executeJavaScript("document.querySelector('[data-import-source=\"chrome\"]')?.scrollIntoView({ block: 'center' })");
    await capture("browser-import", wc);
    check(
      "browser import: Settings finds the browsers and profiles with what each holds",
      listed && chromeText.includes("Personal") && chromeText.includes("Work") && chromeText.includes("3 bookmarks") && chromeText.includes("2 pages in history") && chromeText.includes("3 open tabs"),
      chromeText.slice(0, 300),
    );

    // Extensions: the Chrome profile's Web Store ones to add, Firefox's add-ons to look up by name.
    const extensions = (await wc.executeJavaScript(`(() => {
      for (const d of document.querySelectorAll('[data-import-extensions]')) d.open = true;
      const rows = (sel) => [...document.querySelectorAll(sel + ' [data-import-extension]')].map((li) => ({
        name: li.querySelector('.grow')?.textContent ?? '',
        button: li.querySelector('button')?.textContent ?? '',
        link: li.querySelector('a')?.getAttribute('href') ?? '',
      }));
      return { chrome: rows('[data-import-source="chrome"] [data-import-profile="Default"]'), firefox: rows('[data-import-source="firefox"]') };
    })()`)) as { chrome: Array<{ name: string; button: string; link: string }>; firefox: Array<{ name: string; button: string; link: string }> };
    await capture("browser-import-extensions", wc);
    check(
      "browser import: a profile's Web Store extensions can be added, Firefox's add-ons looked up in the Web Store",
      extensions.chrome.map((e) => `${e.name}:${e.button}`).join() === "Night Mode:Add to Corvus,uBlock Origin Lite:Add to Corvus" &&
        extensions.firefox.length === 1 &&
        extensions.firefox[0]?.link === "https://chromewebstore.google.com/search/uBlock%20Origin",
      extensions,
    );

    await wc.executeJavaScript("document.querySelector('[data-import-source=\"chrome\"] [data-import-profile=\"Default\"] [data-import-run]')?.click()");
    const done = await poll(wc, "document.querySelector('[data-import-source=\"chrome\"] [data-import-profile=\"Default\"] [data-import-result]') !== null");
    const added = profile.bookmarks.list().filter((b) => !bookmarksBefore.has(b.id));
    const visited = profile.history.all().filter((e) => !historyBefore.has(e.url));
    const workspace = profile.workspaces.list().find((w) => !workspacesBefore.has(w.id));
    check(
      "browser import: a profile's bookmarks (onto the bar and into Other bookmarks), history and open tabs (as a workspace) come into Corvus",
      done &&
        added.some((b) => b.title === "News" && b.parentId === BAR_FOLDER_ID) &&
        added.some((b) => b.title === "Docs" && b.parentId === OTHER_FOLDER_ID) &&
        added.filter((b) => b.url).length === 3 &&
        visited.map((e) => e.url).sort().join() === "https://corvus.example/,https://news.example/daily" &&
        workspace?.name === "Google Chrome (Personal)" &&
        workspace.tabs.length === 3 &&
        workspace.groups.some((g) => g.title === "Research"),
      { done, added: added.map((b) => b.title), visited: visited.map((e) => e.url), workspace },
    );

    // Search shortcuts came along, show in Settings, and the address bar uses them.
    const shortcuts = profile.siteSearch.list().filter((x) => !shortcutsBefore.has(x.keyword));
    await wc.executeJavaScript("location.hash = '#site-search'").catch(() => undefined);
    wc.reload();
    await sleep(300);
    const shown = await poll(wc, "document.querySelector('[data-site-search=\"yt\"]') !== null && document.querySelector('[data-site-search=\"wiki\"]') !== null");
    const suggestion = buildSuggestions("yt corvus", [], [], Date.now(), profile.siteSearch.list())[0];
    check(
      "browser import: search shortcuts come into Corvus, show in Settings and search from the address bar",
      shortcuts.map((x) => x.keyword).join() === "yt,g,wiki" && shown && suggestion?.url === "https://www.youtube.com/results?search_query=corvus",
      { shortcuts, shown, suggestion },
    );
  } finally {
    ctx.browserImport.setTestRoots(null);
    if (tabId) win.closeTab(tabId);
    for (const b of profile.bookmarks.list().filter((x) => !bookmarksBefore.has(x.id) && (x.parentId === BAR_FOLDER_ID || x.parentId === OTHER_FOLDER_ID))) profile.bookmarks.remove(b.id);
    profile.history.remove(profile.history.all().filter((e) => !historyBefore.has(e.url)).map((e) => e.id));
    for (const w of profile.workspaces.list().filter((x) => !workspacesBefore.has(x.id))) profile.workspaces.remove(w.id);
    for (const x of profile.siteSearch.list().filter((y) => !shortcutsBefore.has(y.keyword))) profile.siteSearch.remove(x.keyword);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
