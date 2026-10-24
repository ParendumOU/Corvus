import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
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
 * with their counts, and importing one profile brings its bookmarks (in their own folder) and its
 * history into Corvus, through Electron's own SQLite.
 */
export async function runBrowserImportSmoke(ctx: AppContext, h: BrowserImportSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-import-smoke-"));
  const profile = win.profile;
  const bookmarksBefore = new Set(profile.bookmarks.list().map((b) => b.id));
  const historyBefore = new Set(profile.history.all().map((e) => e.url));
  const workspacesBefore = new Set(profile.workspaces.list().map((w) => w.id));
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

    await wc.executeJavaScript("document.querySelector('[data-import-source=\"chrome\"] [data-import-profile=\"Default\"] [data-import-run]')?.click()");
    const done = await poll(wc, "document.querySelector('[data-import-source=\"chrome\"] [data-import-profile=\"Default\"] [data-import-result]') !== null");
    const added = profile.bookmarks.list().filter((b) => !bookmarksBefore.has(b.id));
    const visited = profile.history.all().filter((e) => !historyBefore.has(e.url));
    const workspace = profile.workspaces.list().find((w) => !workspacesBefore.has(w.id));
    check(
      "browser import: a profile's bookmarks (in their own folder), history and open tabs (as a workspace) come into Corvus",
      done &&
        added.some((b) => b.title === "Imported from Google Chrome (Personal)") &&
        added.filter((b) => b.url).length === 3 &&
        visited.map((e) => e.url).sort().join() === "https://corvus.example/,https://news.example/daily" &&
        workspace?.name === "Google Chrome (Personal)" &&
        workspace.tabs.length === 3 &&
        workspace.groups.some((g) => g.title === "Research"),
      { done, added: added.map((b) => b.title), visited: visited.map((e) => e.url), workspace },
    );
  } finally {
    ctx.browserImport.setTestRoots(null);
    if (tabId) win.closeTab(tabId);
    for (const b of profile.bookmarks.list().filter((x) => !bookmarksBefore.has(x.id) && x.title.startsWith("Imported from "))) profile.bookmarks.remove(b.id);
    profile.history.remove(profile.history.all().filter((e) => !historyBefore.has(e.url)).map((e) => e.id));
    for (const w of profile.workspaces.list().filter((x) => !workspacesBefore.has(x.id))) profile.workspaces.remove(w.id);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
