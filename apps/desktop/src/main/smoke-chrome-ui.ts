import type { WebContents } from "electron";
import { BAR_FOLDER_ID } from "../shared/bookmark-tree";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface ChromeUiSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForJs(wc: WebContents, expr: string, timeoutMs = 6000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(100);
  }
  return false;
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 6000): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = fn();
    if (value !== undefined) return value;
    await sleep(100);
  }
  return undefined;
}

/**
 * Chrome UI details: a new group asks for its name, a click anywhere outside a popover closes it,
 * and the address bar's site chip dropped on the bookmarks bar bookmarks the page with its title.
 */
export async function runChromeUiSmoke(ctx: AppContext, h: ChromeUiSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const chrome = win.chrome.webContents;
  const barShown = ctx.settings.get().appearance.showBookmarksBar;
  ctx.settings.update({ appearance: { showBookmarksBar: true } });
  const tab = win.createTab(`${h.url}ux-plain`, { activate: true });
  try {
    await waitFor(() => (tab.title === "No background" ? true : undefined), 8000);

    // "Add tab to new group": the group's name editor opens at once, caret in it.
    const group = win.createGroup([tab.id]);
    if (group) win.editGroup(group.id);
    const editing = await waitForJs(chrome, "document.activeElement?.tagName === 'INPUT' && document.activeElement.closest('.group-editor')");
    check("a new group opens its name editor with the caret in it", editing);
    await capture("group-editor-new", chrome);
    chrome.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitForJs(chrome, "!document.querySelector('.group-editor')");
    win.ungroupTabs([tab.id]);

    // A popover closes on a click on the toolbar or tab strip too, not only over the page.
    await chrome.executeJavaScript("document.querySelector('.shield-btn')?.click()");
    await waitForJs(chrome, "document.querySelector('.shield-popover')");
    const hits = (await chrome.executeJavaScript(`(() => {
      const at = (el, dx) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + dx, r.top + r.height / 2)?.className ?? null; };
      return [at(document.querySelector('.omni-input'), 40), at(document.querySelector('.tab'), 20)];
    })()`)) as Array<string | null>;
    const omni = (await chrome.executeJavaScript("(() => { const r = document.querySelector('.omni-input').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()")) as { x: number; y: number };
    chrome.sendInputEvent({ type: "mouseDown", x: omni.x, y: omni.y, button: "left", clickCount: 1 });
    chrome.sendInputEvent({ type: "mouseUp", x: omni.x, y: omni.y, button: "left", clickCount: 1 });
    const closed = await waitForJs(chrome, "!document.querySelector('.shield-popover')");
    check("a click on the toolbar or tab strip closes an open popover", hits.every((c) => typeof c === "string" && c.includes("overlay-backdrop")) && closed, { hits, closed });

    // Drag the site chip onto the bookmarks bar: the page is bookmarked there with the tab's title.
    await waitForJs(chrome, "document.querySelector('.site-chip') && document.querySelector('.bookmarks-bar')");
    const dropped = (await chrome.executeJavaScript(`(async () => {
      const data = new DataTransfer();
      document.querySelector('.site-chip').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      const bar = document.querySelector('.bookmarks-bar');
      const r = bar.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, dataTransfer: data, clientX: r.left + 10, clientY: r.top + r.height / 2 };
      bar.dispatchEvent(new DragEvent('dragover', opts));
      await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50)));
      const marked = document.querySelector('.bookmarks-bar').classList.contains('dropping');
      bar.dispatchEvent(new DragEvent('drop', opts));
      return { payload: data.getData('application/x-corvus-page'), marked };
    })()`)) as { payload: string; marked: boolean };
    const pageUrl = tab.view.webContents.getURL();
    const saved = await waitFor(() => win.profile.bookmarks.list().find((b) => b.parentId === BAR_FOLDER_ID && b.url === pageUrl));
    check(
      "dropping the site chip on the bookmarks bar bookmarks the page with the tab's title",
      saved?.title === "No background" && dropped.marked,
      { saved, dropped },
    );
    await capture("bookmarks-bar-drop", chrome);
    if (saved) win.profile.bookmarks.remove(saved.id);
  } catch (err) {
    check("chrome UI smoke", false, err instanceof Error ? err.message : String(err));
  } finally {
    ctx.settings.update({ appearance: { showBookmarksBar: barShown } });
    win.closeTab(tab.id);
    await sleep(200);
  }
}
