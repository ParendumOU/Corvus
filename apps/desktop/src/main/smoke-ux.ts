import type http from "node:http";
import { nativeTheme, type WebContents } from "electron";
import { NEW_TAB_URL, isNewTabUrl } from "../shared/internal-urls";
import { isWorkspaceTabUrl } from "../shared/workspaces";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

/** A page that sets no background at all (like boe.es): it must still render on white in dark mode. */
const PLAIN_PAGE = `<!doctype html><html><head><title>No background</title></head><body>
<h1>No background here</h1><p>Dark text that needs a light base to be readable.</p></body></html>`;

export function serveUxSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname !== "/ux-plain") return false;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PLAIN_PAGE);
  return true;
}

export interface UxSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 8000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await sleep(100);
  }
  return null;
}

async function waitForJs(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(100);
  }
  return false;
}

function waitForLoad(wc: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    wc.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface OmniboxFocus {
  ok: boolean;
  chromeFocused: boolean;
  hasFocus: boolean;
  activeElement: string;
  focusedTabs: string[];
}

async function omniboxFocus(win: BrowserWindowCtl): Promise<OmniboxFocus> {
  const chrome = win.chrome.webContents;
  const page = (await chrome.executeJavaScript(
    "({ hasFocus: document.hasFocus(), active: document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : 'none' })",
  )) as { hasFocus: boolean; active: string };
  const chromeFocused = chrome.isFocused();
  const focusedTabs = win.tabRuntimes().filter((t) => !t.view.webContents.isDestroyed() && t.view.webContents.isFocused()).map((t) => t.url);
  return {
    ok: chromeFocused && page.hasFocus && page.active.includes("omni-input") && focusedTabs.length === 0,
    chromeFocused,
    hasFocus: page.hasFocus,
    activeElement: page.active,
    focusedTabs,
  };
}

/** Wait for a freshly opened new tab page to finish loading, then give it a second to steal focus. */
async function settleNewTab(win: BrowserWindowCtl, before: Set<string>): Promise<TabRuntime | null> {
  const tab = await waitFor(() => {
    const active = win.activeTab();
    return active && !before.has(active.id) && isNewTabUrl(active.url) ? active : null;
  });
  if (!tab) return null;
  const wc = tab.view.webContents;
  if (wc.isLoading()) await waitForLoad(wc);
  await waitForJs(wc, "document.querySelector('.nt-search')");
  await sleep(1000);
  return tab;
}

/** A real mouse click on a chrome UI element, once it sits still under the pointer. */
async function clickChrome(win: BrowserWindowCtl, selector: string): Promise<boolean> {
  const chrome = win.chrome.webContents;
  for (let attempt = 0; attempt < 10; attempt++) {
    const at = (await chrome.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const r = el?.getBoundingClientRect();
        if (!el || !r || r.width === 0) return null;
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        return el.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
      })()`,
    )) as { x: number; y: number } | null;
    if (at) {
      chrome.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
      chrome.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
      return true;
    }
    await sleep(150);
  }
  return false;
}

/** Focus a web page's content like a user who clicked into it, so a new tab starts from the page. */
async function focusPage(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
  win.activate(tab.id);
  await sleep(150);
  tab.view.webContents.focus();
  await sleep(150);
}

export async function runUxSmoke(ctx: AppContext, h: UxSmokeHelpers): Promise<void> {
  await runFocusSmoke(ctx, h);
  await runPageBaseSmoke(ctx, h);
  await runWorkspaceSmoke(ctx, h);
  await runSettingsNavSmoke(h);
  await runSettingsLanguageSmoke(ctx, h);
  await runHomeButtonSmoke(ctx, h);
}

/** The home button sits next to reload and opens the home page chosen in Settings. */
async function runHomeButtonSmoke(ctx: AppContext, h: UxSmokeHelpers): Promise<void> {
  const { win, check } = h;
  const before = ctx.settings.get().appearance;
  const tab = win.createTab(`${h.url}ux-plain`, { activate: true });
  const wc = tab.view.webContents;
  const chrome = win.chrome.webContents;
  try {
    if (wc.isLoading()) await waitForLoad(wc);
    const shown = await waitForJs(chrome, "document.querySelector('button[title^=\"Home\"]')");
    check("home button: shown next to reload by default", shown);

    ctx.settings.update({ appearance: { homePage: "custom", homeUrl: `${h.url}ux-plain?home=1` } });
    await chrome.executeJavaScript("document.querySelector('button[title^=\"Home\"]')?.click()");
    const custom = await waitFor(() => wc.getURL().includes("home=1"));
    ctx.settings.update({ appearance: { homePage: "corvus" } });
    win.home(tab.id);
    const corvus = await waitFor(() => wc.getURL().startsWith("corvus://newtab"));
    check("home button: opens the chosen home page, Corvus by default", Boolean(custom) && Boolean(corvus), wc.getURL());

    ctx.settings.update({ appearance: { showHomeButton: false } });
    const hidden = await waitForJs(chrome, "!document.querySelector('button[title^=\"Home\"]')");
    check("home button: can be hidden", hidden);
  } finally {
    ctx.settings.update({ appearance: { showHomeButton: before.showHomeButton, homePage: before.homePage, homeUrl: before.homeUrl } });
    win.closeTab(tab.id);
    await sleep(200);
  }
}

/** Settings and the page menu switch to Spanish live, and load already in Spanish afterwards. */
async function runSettingsLanguageSmoke(ctx: AppContext, h: UxSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const before = ctx.settings.get().appearance.language;
  const tab = win.createTab("corvus://settings/");
  const wc = tab.view.webContents;
  const texts = `({
    lang: document.documentElement.lang,
    heading: document.querySelector('.page-header h1')?.textContent ?? '',
    section: document.querySelector('#appearance h2')?.textContent ?? '',
    menu: document.querySelector('.side-nav > a[href="corvus://history/"]')?.textContent ?? '',
    group: document.querySelector('.nav-group-head')?.textContent ?? '',
    title: document.title,
  })`;
  try {
    ctx.settings.update({ appearance: { language: "en" } });
    if (wc.isLoading()) await waitForLoad(wc);
    await waitForJs(wc, "document.querySelector('#appearance h2')");
    const english = await wc.executeJavaScript(texts);
    check("settings language: English by default here", english.heading === "Settings" && english.section === "Appearance" && english.lang === "en", english);

    // Switch from the page itself, as the person would.
    await wc.executeJavaScript(`[...document.querySelectorAll('#appearance .segmented button')].find((b) => b.textContent === 'Español')?.click()`);
    const live = await waitForJs(wc, "document.querySelector('#appearance h2')?.textContent === 'Apariencia'");
    const spanish = await wc.executeJavaScript(texts);
    check(
      "settings language: switching to Español translates the page and its menu at once",
      live && spanish.heading === "Ajustes" && spanish.menu === "Historial" && spanish.group === "Apariencia y lectura" && spanish.lang === "es",
      spanish,
    );
    await capture("ux-settings-spanish", wc);

    wc.reload();
    await waitForLoad(wc);
    const firstPaint = await wc.executeJavaScript("document.documentElement.lang");
    await waitForJs(wc, "document.querySelector('#appearance h2')");
    const reloaded = await wc.executeJavaScript(texts);
    check("settings language: the page loads in Spanish from the start", firstPaint === "es" && reloaded.section === "Apariencia" && reloaded.title === "Ajustes", { firstPaint, ...reloaded });
  } finally {
    ctx.settings.update({ appearance: { language: before } });
    win.closeTab(tab.id);
    await sleep(200);
  }
}

/**
 * In a short window the settings side nav scrolls on its own, so its last links stay reachable, without
 * squeezing its rows; jumping to a section lands it below the sticky search band.
 */
async function runSettingsNavSmoke(h: UxSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const [w = 1280, hgt = 840] = win.win.getContentSize();
  const tab = win.createTab("corvus://settings/");
  const wc = tab.view.webContents;
  try {
    win.win.setContentSize(1100, 600);
    if (wc.isLoading()) await waitForLoad(wc);
    await waitForJs(wc, "document.querySelector('.side-nav .side-extra a') && document.querySelector('.settings-search')");
    await sleep(400);
    const nav = (await wc.executeJavaScript(
      `(() => {
        const nav = document.querySelector('.side-nav');
        if (!nav) return null;
        const overflowY = getComputedStyle(nav).overflowY;
        const navBottom = nav.getBoundingClientRect().bottom;
        const innerHeight = window.innerHeight;
        const overflows = nav.scrollHeight > nav.clientHeight;
        const heights = (selector) => [...nav.querySelectorAll(selector)].map((a) => Math.round(a.getBoundingClientRect().height));
        const pageLinkHeights = heights(':scope > a');
        const sectionLinkHeights = heights('.side-extra a');
        nav.scrollTop = nav.scrollHeight;
        const links = nav.querySelectorAll('a');
        const last = links[links.length - 1];
        const lastBottom = last ? last.getBoundingClientRect().bottom : null;
        const navBottomScrolled = nav.getBoundingClientRect().bottom;
        const search = document.querySelector('.settings-search');
        const searchBg = search ? getComputedStyle(search).backgroundColor : null;
        return { overflowY, navBottom, innerHeight, overflows, pageLinkHeights, sectionLinkHeights, lastText: last?.textContent ?? null, lastBottom, navBottomScrolled, searchBg };
      })()`,
    )) as {
      overflowY: string;
      navBottom: number;
      innerHeight: number;
      overflows: boolean;
      pageLinkHeights: number[];
      sectionLinkHeights: number[];
      lastText: string | null;
      lastBottom: number | null;
      navBottomScrolled: number;
      searchBg: string | null;
    } | null;
    check("settings nav: scrolls on its own (overflow-y auto)", nav?.overflowY === "auto", nav);
    check("settings nav: fits inside the window", nav !== null && nav.navBottom <= nav.innerHeight, nav);
    check(
      "settings nav: last link reachable after scrolling the nav",
      nav !== null && nav.lastBottom !== null && nav.lastBottom <= nav.navBottomScrolled,
      nav,
    );
    check("settings nav: page links keep their height while the nav scrolls", !!nav && nav.pageLinkHeights.length > 0 && nav.pageLinkHeights.every((px) => px === 36), nav?.pageLinkHeights);
    check("settings nav: section links keep their height", !!nav && nav.sectionLinkHeights.length > 0 && nav.sectionLinkHeights.every((px) => px === 30), nav?.sectionLinkHeights);
    check("settings search: sticky band is opaque", !!nav?.searchBg && nav.searchBg !== "rgba(0, 0, 0, 0)" && nav.searchBg !== "transparent", nav?.searchBg);
    await sleep(150);
    await capture("ux-settings-nav-scrolled", wc);

    await wc.executeJavaScript(`document.querySelector('.side-extra a[data-nav-id="agents"]')?.click()`);
    await sleep(400);
    const jump = (await wc.executeJavaScript(
      `(() => {
        const card = document.getElementById('agents');
        const band = document.querySelector('.settings-search');
        if (!card || !band) return null;
        return { cardTop: Math.round(card.getBoundingClientRect().top), bandBottom: Math.round(band.getBoundingClientRect().bottom), hash: location.hash };
      })()`,
    )) as { cardTop: number; bandBottom: number; hash: string } | null;
    check(
      "settings nav: a section jump lands just below the search band",
      !!jump && jump.hash === "#agents" && jump.cardTop >= jump.bandBottom && jump.cardTop - jump.bandBottom <= 24,
      jump,
    );
    await capture("ux-settings-nav-jump", wc);
  } finally {
    win.win.setContentSize(w, hgt);
    win.closeTab(tab.id);
    await sleep(200);
  }
}

/** RGB of the pixel near the bottom-right corner of a page (away from any text). */
async function cornerPixel(wc: WebContents): Promise<[number, number, number] | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const image = await wc.capturePage();
      const { width, height } = image.getSize();
      if (width < 20 || height < 20) throw new Error("empty capture");
      const bitmap = image.toBitmap();
      const i = ((height - 12) * width + (width - 12)) * 4;
      return [bitmap[i + 2] ?? 0, bitmap[i + 1] ?? 0, bitmap[i] ?? 0];
    } catch {
      await sleep(250);
    }
  }
  return null;
}

const isWhite = (px: [number, number, number] | null): boolean => px !== null && px.every((c) => c >= 245);
const isDark = (px: [number, number, number] | null): boolean => px !== null && px.every((c) => c <= 60);

/**
 * Dark theme: a web page that sets no background (like boe.es) renders on white, as in Chrome,
 * while Corvus' own pages stay dark. Covers internal -> web navigation and a theme switch.
 */
async function runPageBaseSmoke(ctx: AppContext, h: UxSmokeHelpers): Promise<void> {
  const { url, win, check, capture } = h;
  const themeBefore = ctx.settings.get().appearance.theme;
  ctx.settings.update({ appearance: { theme: "dark" } });
  await waitFor(() => nativeTheme.shouldUseDarkColors);

  const tab = win.createTab(NEW_TAB_URL);
  const wc = tab.view.webContents;
  await waitForJs(wc, "document.querySelector('.nt-search') && matchMedia('(prefers-color-scheme: dark)').matches");
  await sleep(300);
  const ntp = await cornerPixel(wc);
  check("dark theme: corvus://newtab renders dark", isDark(ntp), ntp);

  win.loadUrl(tab.id, `${url}ux-plain`);
  await waitForLoad(wc);
  await sleep(400);
  const web = await cornerPixel(wc);
  check("dark theme: a page with no background renders on white", isWhite(web), web);
  await capture("dark-theme-plain-page", wc);

  // Switching the theme while the page is open keeps it white; back to dark keeps it white too.
  ctx.settings.update({ appearance: { theme: "light" } });
  await sleep(300);
  ctx.settings.update({ appearance: { theme: "dark" } });
  await sleep(400);
  check("dark theme: page stays white across a theme switch", isWhite(await cornerPixel(wc)));

  // Back to a Corvus page in the same tab: dark again.
  win.loadUrl(tab.id, NEW_TAB_URL);
  await waitForLoad(wc);
  await waitForJs(wc, "document.querySelector('.nt-search')");
  await sleep(300);
  const back = await cornerPixel(wc);
  check("dark theme: navigating back to corvus://newtab is dark", isDark(back), back);

  win.closeTab(tab.id);
  ctx.settings.update({ appearance: { theme: themeBefore } });
  await sleep(200);
}

/** A new tab (any way it is opened) leaves the caret in the omnibox, also once its page has loaded. */
async function runFocusSmoke(ctx: AppContext, h: UxSmokeHelpers): Promise<void> {
  const { url, check } = h;
  // A fresh window: its first tab is the "new window" case, and its strip is not crowded by the
  // tabs earlier smoke steps left open (the + button stays on screen).
  const win = ctx.windows.open(h.win.profile.profile.id);
  const firstTab = await settleNewTab(win, new Set());
  await waitForJs(win.chrome.webContents, "document.querySelector('.omni-input')");
  await sleep(300);
  const firstFocus = await omniboxFocus(win);
  check("new tab focuses the omnibox: new window", firstTab !== null && firstFocus.ok, firstFocus);

  const chrome = win.chrome.webContents;
  const web = win.createTab(`${url}ux-plain`);
  await waitForLoad(web.view.webContents);
  const opened: string[] = [];
  const scenario = async (name: string, open: () => Promise<boolean | void> | boolean | void): Promise<void> => {
    await focusPage(win, web);
    const before = new Set(win.tabIds());
    if ((await open()) === false) {
      check(`new tab focuses the omnibox: ${name}`, false, "could not trigger");
      return;
    }
    const tab = await settleNewTab(win, before);
    if (tab) opened.push(tab.id);
    const focus = await omniboxFocus(win);
    check(`new tab focuses the omnibox: ${name}`, tab !== null && focus.ok, tab ? focus : { ...focus, active: win.activeTab()?.url, tabs: win.tabIds().length - before.size });
  };

  const mod = process.platform === "darwin" ? "meta" : "control";
  await scenario("Ctrl+T in a page", () => web.view.webContents.sendInputEvent({ type: "keyDown", keyCode: "T", modifiers: [mod] }));
  await scenario("+ button (horizontal strip)", () => clickChrome(win, ".new-tab-btn"));
  ctx.settings.update({ appearance: { tabLayout: "vertical" } });
  await sleep(400);
  await scenario("+ button (vertical sidebar)", () => clickChrome(win, ".v-newtab"));
  ctx.settings.update({ appearance: { tabLayout: "horizontal" } });
  await sleep(400);
  await scenario("command bar New tab", async () => {
    // Park the pointer away from where the bar opens: hovering a row selects it.
    chrome.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
    win.runCommand({ type: "command-palette" });
    if (!(await waitForJs(chrome, "document.activeElement?.classList.contains('cmd-input')"))) return false;
    if (!(await waitForJs(chrome, "document.querySelector('.cmd-row.sel .cmd-title')?.textContent === 'New tab'"))) return false;
    chrome.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    return true;
  });
  check("command bar closes after New tab", (await chrome.executeJavaScript("Boolean(document.querySelector('.cmdbar'))")) === false);

  // Typing right away goes into the omnibox, which shows the new tab's (empty) value.
  for (const ch of "corvus") {
    chrome.sendInputEvent({ type: "keyDown", keyCode: ch });
    chrome.sendInputEvent({ type: "char", keyCode: ch });
    chrome.sendInputEvent({ type: "keyUp", keyCode: ch });
  }
  await sleep(200);
  const typed = await chrome.executeJavaScript("document.querySelector('.omni-input')?.value");
  check("typing after a new tab goes into the omnibox", typed === "corvus", typed);
  win.sendCommand({ type: "close-overlays" });
  await sleep(150);

  // The user can still click into the new tab page once it has loaded.
  const ntp = win.activeTab();
  if (ntp && isNewTabUrl(ntp.url)) {
    ntp.view.webContents.focus();
    await sleep(300);
    check("a loaded new tab page keeps focus when clicked into", ntp.view.webContents.isFocused() && !chrome.isFocused());
  }

  // A tab opened in the background does not take the keyboard away from the page it came from.
  await focusPage(win, web);
  const background = win.createTab(`${url}ux-plain?background`, { activate: false, openerId: web.id });
  await waitForLoad(background.view.webContents);
  await sleep(300);
  check("background tab leaves focus in the page", web.view.webContents.isFocused() && !background.view.webContents.isFocused());
  opened.push(background.id);

  // Ctrl+L from the page still moves the caret to the omnibox; switching tabs focuses page content.
  web.view.webContents.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: [mod] });
  await sleep(300);
  check("Ctrl+L focuses the omnibox", (await omniboxFocus(win)).ok);
  const ntpId = opened[0];
  if (ntpId) win.activate(ntpId);
  await sleep(200);
  win.activate(web.id);
  await sleep(300);
  check("switching to a web tab focuses the page", web.view.webContents.isFocused() && !chrome.isFocused());

  win.close();
  await sleep(300);
}

/**
 * Workspaces: save a tab group, open it from the popover as one group in the same window (no new
 * window), opening again only focuses it, "Update" re-saves the group's tabs, rename/delete follow
 * through, and an older multi-group workspace opens flattened into one group.
 */
async function runWorkspaceSmoke(ctx: AppContext, h: UxSmokeHelpers): Promise<void> {
  const { url, win, check, capture } = h;
  const chrome = win.chrome.webContents;
  const store = win.profile.workspaces;
  const urls = ["a", "b", "c"].map((k) => `${url}ux-plain?ws=${k}`);
  const groupTabs = (groupId: string): string[] =>
    win
      .listTabs()
      .filter((t) => t.groupId === groupId)
      .map((t) => win.getTab(t.id)?.pendingUrl ?? t.url);
  const linked = (id: string) => win.listGroups().filter((g) => g.workspaceId === id);

  // Save a group from its menu action.
  const made = urls.map((u, i) => win.createTab(u, { activate: i === 0 }));
  await waitForLoad(made[0]!.view.webContents);
  const source = win.createGroup(made.map((t) => t.id), { title: "UX research", color: "purple" });
  const wsId = source ? win.saveGroupAsWorkspace(source.id) : null;
  const saved = wsId ? store.get(wsId) : undefined;
  check(
    "workspace: save group stores its tabs under the group's name and links the group",
    saved?.name === "UX research" && JSON.stringify(saved.tabs.map((t) => t.url)) === JSON.stringify(urls) && linked(wsId ?? "").length === 1,
    saved && { name: saved.name, tabs: saved.tabs.length },
  );
  if (!source || !wsId) return;
  win.closeGroup(source.id);
  const outside = win.createTab(`${url}ux-plain?outside`);
  await sleep(200);

  // Open it from the popover: one new group, same window, first tab active.
  const windowsBefore = ctx.windows.all().length;
  const tabsBefore = win.tabIds().length;
  win.sendCommand({ type: "open-workspaces" });
  const listed = await waitForJs(chrome, "[...document.querySelectorAll('.workspaces-popover .ws-name')].some((n) => n.textContent === 'UX research')");
  await capture("workspaces-popover-saved", chrome);
  const saveable = win.listTabs().filter((t) => isWorkspaceTabUrl(t.url)).length;
  const saveLabel = await chrome.executeJavaScript("document.querySelector('.ws-save-btn')?.textContent");
  check("workspace: the save button says how many tabs it saves", saveLabel === `Save ${saveable} tab${saveable === 1 ? "" : "s"}`, { saveLabel, saveable });
  await chrome.executeJavaScript(
    "[...document.querySelectorAll('.workspaces-popover .ws-open')].find((b) => b.querySelector('.ws-name')?.textContent === 'UX research')?.click()",
  );
  const opened = await waitFor(() => linked(wsId)[0]);
  await sleep(300);
  const first = opened ? win.listTabs().find((t) => t.groupId === opened.id) : undefined;
  check(
    "workspace: opens as one group with its tabs in this window",
    listed &&
      opened?.title === "UX research" &&
      opened.color === "purple" &&
      JSON.stringify(groupTabs(opened.id)) === JSON.stringify(urls) &&
      win.tabIds().length === tabsBefore + urls.length &&
      ctx.windows.all().length === windowsBefore &&
      win.activeTab()?.id === first?.id,
    { listed, group: opened, tabs: opened ? groupTabs(opened.id) : [], windows: ctx.windows.all().length - windowsBefore },
  );
  if (!opened) return;
  await capture("workspaces-opened", chrome);

  // Opening it again does not duplicate it: it expands and focuses the existing group.
  win.updateGroup(opened.id, { collapsed: true });
  win.activate(outside.id);
  await sleep(200);
  await chrome.executeJavaScript(`window.corvus.call("workspaces.open", ${JSON.stringify(wsId)})`);
  await sleep(300);
  const again = linked(wsId);
  check(
    "workspace: opening again focuses its group instead of duplicating it",
    again.length === 1 && !again[0]?.collapsed && win.activeTab()?.id === first?.id && ctx.windows.all().length === windowsBefore,
    { groups: again.length, active: win.activeTab()?.url },
  );

  // The group's own menu offers to update the workspace it shows.
  win.sendCommand({ type: "edit-group", groupId: opened.id });
  const offersUpdate = await waitForJs(chrome, "document.querySelector('.group-editor .ws-group-save')?.textContent === 'Update workspace · 3 tabs'");
  check("workspace: the group's menu offers Update workspace", offersUpdate);
  await capture("workspace-group-menu", chrome);
  win.sendCommand({ type: "close-overlays" });
  await sleep(150);

  // Update: the group's current tabs replace the saved ones.
  win.createTab(`${url}ux-plain?ws=d`, { groupId: opened.id, activate: false });
  await chrome.executeJavaScript(`window.corvus.call("workspaces.saveGroup", ${JSON.stringify(opened.id)})`);
  check("workspace: update re-saves the group's tabs", store.get(wsId)?.tabs.length === 4 && store.list().filter((w) => w.name === "UX research").length === 1);

  // Rename follows into the open group; delete unlinks it.
  await chrome.executeJavaScript(`window.corvus.call("workspaces.rename", ${JSON.stringify(wsId)}, "UX renamed")`);
  check("workspace: rename renames its open group", win.listGroups().find((g) => g.id === opened.id)?.title === "UX renamed");

  // A workspace saved by an older version (several groups + ungrouped) opens flattened into one group.
  store.applyRemote([
    {
      id: "legacy-ws",
      workspace: {
        id: "legacy-ws",
        name: "Legacy trip",
        createdAt: 1,
        updatedAt: 1,
        tabs: [
          { url: `${url}ux-plain?old=1`, title: "1", pinned: false, groupId: "G1" },
          { url: `${url}ux-plain?old=2`, title: "2", pinned: false },
          { url: `${url}ux-plain?old=3`, title: "3", pinned: false, groupId: "G2" },
        ],
        groups: [
          { id: "G1", title: "Flights", color: "cyan", collapsed: true },
          { id: "G2", title: "Hotels", color: "red", collapsed: false },
        ],
      },
    },
  ]);
  const legacy = win.openWorkspace("legacy-ws");
  await sleep(300);
  check(
    "workspace: an older multi-group workspace opens as one group",
    legacy?.title === "Legacy trip" && groupTabs(legacy.id).length === 3 && linked("legacy-ws").length === 1,
    legacy && groupTabs(legacy.id),
  );

  await chrome.executeJavaScript(`window.corvus.call("workspaces.remove", ${JSON.stringify(wsId)})`);
  check("workspace: delete removes it and unlinks its group", !store.get(wsId) && linked(wsId).length === 0);
  win.sendCommand({ type: "close-overlays" });
  store.remove("legacy-ws");
  win.closeTabs([...win.listTabs().filter((t) => t.groupId === opened.id || t.groupId === legacy?.id).map((t) => t.id), outside.id]);
  await sleep(200);
}
