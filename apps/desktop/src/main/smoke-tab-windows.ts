import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

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
  const tabs: TabRuntime[] = [page, other, g1, g2];
  try {
    await until(() => tabs.every((t) => t.title === "No background"));

    // A tab let go away from the strip: its window shows at once where it was let go, its strip
    // follows, and its page is the same one, still running (a value typed into it and a counter).
    {
      const timed = win.createTab(`${h.url}ux-plain?keep=timed`, { activate: true });
      tabs.push(timed);
      await until(() => timed.title === "No background");
      const twc = timed.view.webContents;
      const mark = (await twc.executeJavaScript(
        "(() => { const i = document.createElement('input'); i.id = 'typed'; i.value = 'typed before the move'; document.body.append(i); window.__ticks = 0; setInterval(() => window.__ticks++, 50); window.__mark = Math.random(); return window.__mark; })()",
      )) as number;
      const b = win.win.getBounds();
      const t0 = Date.now();
      const fresh = ctx.windows.tearOff(win, [timed.id], { x: b.x + 400, y: b.y + 300 });
      const builtMs = Date.now() - t0;
      if (fresh) windows.push(fresh);
      const shownMs = (await until(() => Boolean(fresh?.win.isVisible()), 3000)) ? Date.now() - t0 : -1;
      const stripMs = (await until(async () => (await fresh?.chrome.webContents.executeJavaScript(`Boolean(document.querySelector('.tab-strip .tab.active[data-tab-id="${timed.id}"]'))`).catch(() => false)) === true, 8000)) ? Date.now() - t0 : -1;
      const ticks = (await twc.executeJavaScript("window.__ticks").catch(() => -1)) as number;
      await sleep(300);
      const after = (await twc.executeJavaScript("({ mark: window.__mark, typed: document.getElementById('typed')?.value, ticks: window.__ticks })").catch(() => null)) as { mark: number; typed: string; ticks: number } | null;
      const timing = { builtMs, shownMs, stripMs, pageShown: timed.view.getVisible() };
      console.log(`[smoke] tear-off timing ${JSON.stringify(timing)}`);
      check(
        "tab windows: a tab let go away from the strip is in a new window shown within 500 ms, its strip follows, and its page kept what was typed and keeps running",
        Boolean(fresh) && fresh !== win && shownMs >= 0 && shownMs <= 500 && stripMs >= 0 && timed.view.getVisible() && twc.id === timed.view.webContents.id && after?.mark === mark && after?.typed === "typed before the move" && after.ticks > ticks,
        { timing, after, ticks },
      );

      // A window that cannot take the tabs: they go back where they were, nothing lost.
      const back = win.createTab(`${h.url}ux-plain?keep=back`, { activate: false });
      tabs.push(back);
      await until(() => back.title === "No background");
      const at = win.tabIds().indexOf(back.id);
      if (fresh) fresh.adoptTabs = () => false;
      const refused = fresh ? ctx.windows.moveTabs(win, [back.id], fresh) : true;
      check(
        "tab windows: tabs a window could not take go back where they were, page and place kept",
        !refused && win.hasTab(back.id) && win.tabIds().indexOf(back.id) === at && !fresh?.hasTab(back.id) && back.view.webContents.getURL().includes("keep=back"),
        { refused, at, now: win.tabIds().indexOf(back.id) },
      );
      if (fresh) delete (fresh as Partial<Pick<BrowserWindowCtl, "adoptTabs">>).adoptTabs;
      if (fresh && !fresh.isDisposed()) ctx.windows.moveTabs(fresh, fresh.tabIds(), win);
    }

    // Tabs dragged out of the strip: a preview of their new window follows the pointer away from the
    // strip (never near it, nor on another window's strip), takes the drop and opens the window there;
    // a drag given up (Esc) keeps the tabs. The system's drag is played by the calls the strip makes.
    {
      const dragged = win.createTab(`${h.url}ux-plain?keep=drag`, { activate: true });
      tabs.push(dragged);
      await until(() => dragged.title === "No background");
      const strip = win.stripOnScreen();
      const near = { x: strip.x + 200, y: strip.y + 10 };
      const away = { x: strip.x + 320, y: strip.y + 380 };
      const real = ctx.windows.cursor;
      const preview = () => ctx.windows.dragPreview.window();
      const under = (p: { x: number; y: number }): boolean => {
        const b = preview()?.getBounds();
        return Boolean(b) && p.x >= b!.x && p.x < b!.x + b!.width && p.y >= b!.y && p.y < b!.y + b!.height;
      };
      try {
        ctx.windows.cursor = () => near;
        ctx.windows.dragStarted(win, [dragged.id], dragged.id);
        await sleep(250);
        const hiddenNear = !preview()?.isVisible();
        ctx.windows.cursor = () => away;
        const shown = await until(() => Boolean(preview()?.isVisible()) && under(away), 3000);
        const titled = await until(async () => (await preview()?.webContents.executeJavaScript("document.querySelector('.dp-title')?.textContent").catch(() => null)) === "No background", 5000);
        check(
          "tab windows: a tab dragged away from the strip shows a preview of its new window under the pointer, with the tab's title; near the strip it stays hidden",
          hiddenNear && shown && titled,
          { hiddenNear, shown, titled, bounds: preview()?.getBounds() },
        );
        if (preview()) await capture("tab-windows-drag-preview", preview()!.webContents);

        const t0 = Date.now();
        await preview()?.webContents.executeJavaScript(
          `(() => { const dt = new DataTransfer(); dt.setData("application/x-corvus-tab", ${JSON.stringify(dragged.id)}); document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`,
        );
        const opened = await until(() => ctx.windows.all().some((w) => w !== win && w.hasTab(dragged.id) && w.win.isVisible()), 3000);
        const dropMs = Date.now() - t0;
        ctx.windows.dragEnded(win, [], true);
        const target = ctx.windows.all().find((w) => w !== win && w.hasTab(dragged.id));
        if (target) windows.push(target);
        const at = target?.win.getBounds();
        check(
          "tab windows: a drop on the preview opens the tab's window where it was let go, at once, and the preview hides",
          opened && dropMs <= 500 && !win.hasTab(dragged.id) && !preview()?.isVisible() && Math.abs((at?.x ?? 0) - (away.x - 120)) <= 2,
          { opened, dropMs, at, away },
        );

        // Over another window's strip the preview hides: a drop there moves the tabs into that window.
        if (target) {
          const otherTab = win.createTab(`${h.url}ux-plain?keep=over`, { activate: false });
          tabs.push(otherTab);
          const over = target.stripOnScreen();
          ctx.windows.cursor = () => ({ x: over.x + 300, y: over.y + 8 });
          ctx.windows.dragStarted(win, [otherTab.id], otherTab.id);
          await sleep(250);
          const hiddenOver = !preview()?.isVisible();
          const count = ctx.windows.all().length;
          ctx.windows.dragEnded(win, [otherTab.id], true);
          await sleep(200);
          check("tab windows: over another window's strip the preview stays hidden, and a drop there opens no window", hiddenOver && ctx.windows.all().length === count && win.hasTab(otherTab.id), { hiddenOver });
          ctx.windows.moveTabs(target, target.tabIds(), win);
        }

        // Given up (Esc) away from the strip: the tabs stay where they were.
        ctx.windows.cursor = () => away;
        ctx.windows.dragStarted(win, [dragged.id], dragged.id);
        await until(() => Boolean(preview()?.isVisible()), 3000);
        const before = ctx.windows.all().length;
        ctx.windows.dragEnded(win, [dragged.id], false);
        await sleep(300);
        check(
          "tab windows: a drag given up away from the strip (Esc) keeps the tab where it was and hides the preview",
          win.hasTab(dragged.id) && ctx.windows.all().length === before && !preview()?.isVisible(),
          { windows: ctx.windows.all().length, before },
        );
      } finally {
        ctx.windows.cursor = real;
      }
    }

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
