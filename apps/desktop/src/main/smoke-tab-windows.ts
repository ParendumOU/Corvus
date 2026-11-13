import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface TabWindowsSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(50);
  }
  return cond();
}

/**
 * Tabs moving between windows (CORVUS_SMOKE_ONLY=tabwindows; also in the full run): a tab torn off
 * into a new window keeps its page (no reload) and its events reach the new window; MCP tools list
 * and read it there; a group moved whole keeps its id; the saved session has both windows; tabs
 * selected together and dropped on another window's strip all move; a window emptied by a move closes.
 */
export async function runTabWindowsSmoke(ctx: AppContext, h: TabWindowsSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const c = ctx.controller;
  const windows: BrowserWindowCtl[] = [];
  const page = win.createTab(`${h.url}ux-plain?keep=1`, { activate: true });
  const other = win.createTab(`${h.url}ux-plain?keep=2`, { activate: false });
  const g1 = win.createTab(`${h.url}ux-plain?group=1`, { activate: false });
  const g2 = win.createTab(`${h.url}ux-plain?group=2`, { activate: false });
  const tabs = [page, other, g1, g2];
  try {
    await until(() => tabs.every((t) => t.title === "No background"));
    const wc = page.view.webContents;
    const wcId = wc.id;
    const marker = (await wc.executeJavaScript("window.__kept = `kept-${Math.random()}`; window.__kept")) as string;

    const torn = ctx.windows.tearOff(win, [page.id]);
    if (torn) windows.push(torn);
    const kept = torn ? ((await page.view.webContents.executeJavaScript("window.__kept").catch(() => null)) as string | null) : null;
    check(
      "tab windows: a tab moved to a new window keeps its page, without reloading",
      Boolean(torn) && torn !== win && torn!.hasTab(page.id) && !win.hasTab(page.id) && page.view.webContents.id === wcId && kept === marker && torn!.activeTab()?.id === page.id,
      { torn: Boolean(torn), kept: kept === marker, wc: page.view.webContents.id === wcId },
    );
    if (!torn) return;
    const shown = await until(async () => (await torn.chrome.webContents.executeJavaScript(`Boolean(document.querySelector('.tab-strip .tab.active[data-tab-id="${page.id}"]'))`).catch(() => false)) === true);
    check("tab windows: the new window's strip shows the tab, active", shown && page.view.getVisible());
    await capture("tab-windows-torn-off", torn.chrome.webContents);

    await page.view.webContents.executeJavaScript("document.title = 'Moved page'; true");
    const titled = await until(() => torn.listTabs().find((t) => t.id === page.id)?.title === "Moved page");
    check("tab windows: the moved page's events reach its new window (title)", titled, torn.listTabs().find((t) => t.id === page.id)?.title);

    const listed = (await c.listTabs()).find((t) => t.id === page.id);
    const read = await c.getText(page.id, { maxChars: 200 }).catch((err: unknown) => ({ text: `error: ${String(err)}` }));
    check("tab windows: MCP tools list the tab in its new window and read it", listed?.windowId === torn.id && !read.text.startsWith("error") && read.text.length > 0, { listed: listed?.windowId, torn: torn.id, read: read.text.slice(0, 80) });

    const group = win.createGroup([g1.id, g2.id], { title: "Moving", color: "red" });
    const movedGroup = group ? ctx.windows.moveTabs(win, [g1.id, g2.id], torn, { index: 0 }) : false;
    const groups = await c.listGroups();
    check(
      "tab windows: a group moved whole keeps its id, title and colour, in one window only",
      movedGroup && Boolean(group) && torn.hasGroup(group!.id) && !win.hasGroup(group!.id) && groups.filter((g) => g.id === group!.id).length === 1 && torn.listGroups().some((g) => g.id === group!.id && g.title === "Moving" && g.color === "red"),
      { groups: groups.map((g) => g.id), torn: torn.listGroups() },
    );

    const snapshot = ctx.sessionRestore.capture();
    const savedTorn = snapshot.windows.find((w) => w.tabs.some((t) => t.url.includes("keep=1")));
    const savedMain = snapshot.windows.find((w) => w.tabs.some((t) => t.url.includes("keep=2")));
    check(
      "tab windows: the saved session has both windows, each with its tabs and groups",
      Boolean(savedTorn && savedMain) && savedTorn !== savedMain && savedTorn!.tabs.some((t) => t.url.includes("group=1")) && savedTorn!.groups.some((g) => g.title === "Moving"),
      { windows: snapshot.windows.length },
    );

    // Tabs selected together, one of them dropped on another window's strip: they all move there.
    torn.selectTab(g1.id, {});
    torn.selectTab(g2.id, { toggle: true });
    const selectedBefore = torn.selectedTabIds();
    const dropped = ctx.windows.dropTab(win, g2.id, 0, null);
    const names = new Map(tabs.map((t, i) => [t.id, ["page", "other", "g1", "g2"][i]!]));
    const named = (ids: string[]): string[] => ids.map((id) => names.get(id) ?? id);
    const at = win.tabIds().indexOf(g1.id);
    check(
      "tab windows: tabs selected together and dropped on another window's strip all move there, in order",
      dropped && at !== -1 && win.tabIds()[at + 1] === g2.id && win.activeTab()?.id === g2.id && torn.hasTab(page.id) && !torn.hasTab(g1.id),
      { win: named(win.tabIds()), torn: named(torn.tabIds()), active: named([win.activeTab()?.id ?? ""]), selectedBefore: named(selectedBefore) },
    );

    // Its last tab moved back: the emptied window closes, the page keeps running.
    ctx.windows.moveTabs(torn, torn.tabIds(), win);
    const closed = await until(() => torn.isDisposed());
    const still = (await page.view.webContents.executeJavaScript("window.__kept").catch(() => null)) as string | null;
    check(
      "tab windows: a window whose last tab moves away closes; the tab's page keeps running in the other",
      closed && win.hasTab(page.id) && still === marker && page.view.webContents.id === wcId,
      { closed, back: win.hasTab(page.id), kept: still === marker },
    );
  } catch (err) {
    check("tab windows smoke", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  } finally {
    for (const w of windows) if (!w.isDisposed()) w.close();
    for (const t of tabs) if (win.hasTab(t.id)) win.closeTab(t.id);
    await sleep(300);
  }
}
