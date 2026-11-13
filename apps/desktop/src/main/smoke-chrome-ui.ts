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

interface TabParts {
  tab: { left: number; right: number };
  icon: { left: number; right: number; width: number } | null;
  title: { left: number; right: number; width: number } | null;
  close: { left: number; right: number; width: number } | null;
}

/** The parts of the tab strip's tab `id` that are drawn (laid out, not transparent), as screen rectangles. */
const tabPartsJs = (id: string): string => `(() => {
  const tab = document.querySelector('.tab-strip .tab[data-tab-id="${id}"]');
  if (!tab) return null;
  const part = (sel) => {
    const el = tab.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || getComputedStyle(el).opacity === '0') return null;
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  };
  const r = tab.getBoundingClientRect();
  return { tab: { left: Math.round(r.left), right: Math.round(r.right) }, icon: part('.tab-icon'), title: part('.tab-title'), close: part('.tab-close') };
})()`;

/**
 * What a tab of `width` px shows (see the narrow tab rules in chrome.css): its icon, except the
 * active tab when only its close button fits; its title unless there is no room; the close button
 * on the right, always on the active tab, on a hovered one while it is not most of the tab. Returns
 * the problems found.
 */
function narrowTabProblems(parts: TabParts | null, width: number, active: boolean): string[] {
  if (!parts) return ["tab not found"];
  const room = width - 20;
  const problems: string[] = [];
  const iconShown = !active || room >= 48;
  const titleShown = active ? room > 60 : room >= 48;
  const closeShown = active || room > 60;
  if (iconShown !== (parts.icon?.width === 16)) problems.push(iconShown ? "no icon" : "icon shown");
  if (titleShown !== Boolean(parts.title)) problems.push(titleShown ? "no title" : "title shown");
  if (closeShown !== Boolean(parts.close)) problems.push(closeShown ? "no close button" : "close button shown");
  const close = parts.close;
  if (close) {
    if (close.right > parts.tab.right || close.right < parts.tab.right - 12) problems.push("close button not at the right edge");
    if (parts.icon && close.left < parts.icon.right) problems.push("close button over the icon");
    if (parts.title && close.left < parts.title.right) problems.push("close button over the title");
  }
  for (const [name, rect] of Object.entries({ icon: parts.icon, title: parts.title })) {
    if (rect && (rect.left < parts.tab.left || rect.right > parts.tab.right)) problems.push(`${name} outside the tab`);
  }
  return problems;
}

/**
 * Tabs at every width, active and hovered: an icon and title, and the close button on the right.
 * The active tab of a ~100px strip (about ten tabs) used to show only its close button, on its left.
 */
async function checkNarrowTabs(win: BrowserWindowCtl, activeId: string, h: ChromeUiSmokeHelpers): Promise<void> {
  const chrome = win.chrome.webContents;
  const other = win.createTab(`${h.url}ux-plain`, { activate: false });
  const ids = JSON.stringify([activeId, other.id]);
  try {
    await waitFor(() => (other.title === "No background" ? true : undefined), 8000);
    win.activate(activeId);
    await waitForJs(chrome, `document.querySelector('.tab-strip .tab.active[data-tab-id="${activeId}"]')`);
    // Only the two tabs under test show, so neither is pushed off the strip by the others.
    const setWidth = (width: number): Promise<unknown> =>
      chrome.executeJavaScript(`(async () => {
        const keep = ${ids};
        for (const t of document.querySelectorAll('.tab-strip .tab')) {
          if (!keep.includes(t.dataset.tabId)) t.style.setProperty('display', 'none', 'important');
          else { t.style.setProperty('flex', '0 0 ${width}px', 'important'); t.style.setProperty('width', '${width}px', 'important'); }
        }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      })()`);
    const failures: Record<string, string[]> = {};
    for (const width of [232, 120, 108, 100, 90, 80, 72, 67, 56, 44]) {
      await setWidth(width);
      const active = (await chrome.executeJavaScript(tabPartsJs(activeId))) as TabParts | null;
      const otherRect = (await chrome.executeJavaScript(tabPartsJs(other.id))) as TabParts | null;
      if (otherRect) {
        const x = Math.round((otherRect.tab.left + otherRect.tab.right) / 2);
        chrome.sendInputEvent({ type: "mouseMove", x, y: 20 });
        await waitForJs(chrome, `document.querySelector('.tab-strip .tab[data-tab-id="${other.id}"]')?.matches(':hover')`, 2000);
      }
      const hovered = (await chrome.executeJavaScript(tabPartsJs(other.id))) as TabParts | null;
      const problems = [...narrowTabProblems(active, width, true).map((p) => `active: ${p}`), ...narrowTabProblems(hovered, width, false).map((p) => `hovered: ${p}`)];
      if (problems.length > 0) failures[`${width}px`] = problems;
      if (width === 100) await h.capture("tab-strip-100px", chrome);
    }
    h.check("tabs of every width show their icon, their title while it fits and the close button on the right (active and hovered)", Object.keys(failures).length === 0, failures);
  } finally {
    await chrome.executeJavaScript(`(() => { for (const t of document.querySelectorAll('.tab-strip .tab')) for (const p of ['display', 'flex', 'width']) t.style.removeProperty(p); })()`);
    chrome.sendInputEvent({ type: "mouseMove", x: 5, y: 300 });
    if (win.hasTab(other.id)) win.closeTab(other.id);
  }
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

    // Closing tabs with a middle click keeps the others at their width while the pointer is on the
    // strip; they spread out again once it leaves. (The smoke window may hold so many tabs that they
    // sit at their minimum width, so this checks the freeze itself rather than a visible growth.)
    const extra = Array.from({ length: 14 }, () => win.createTab("about:blank", { activate: false }));
    const countJs = "document.querySelectorAll('.tab-strip .tab').length";
    await waitForJs(chrome, `${countJs} >= ${extra.length + 1}`);
    const count = (await chrome.executeJavaScript(countJs)) as number;
    const widthsJs = "[...document.querySelectorAll('.tab-strip .tab:not(.pinned)')].map((t) => Math.round(t.getBoundingClientRect().width))";
    const before = Math.max(...((await chrome.executeJavaScript(widthsJs)) as number[]));
    // One of the extra tabs: the window's third tab may be this check's own.
    await chrome.executeJavaScript(`document.querySelector('.tab-strip .tab[data-tab-id="${extra[2]!.id}"]').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))`);
    const closedOne = await waitForJs(chrome, `${countJs} === ${count - 1}`);
    const frozen = (await chrome.executeJavaScript(`({
      frozen: document.querySelector('.tab-strip').classList.contains('frozen'),
      width: parseFloat(document.querySelector('.tab-strip').style.getPropertyValue('--frozen-tab-width')),
      widths: ${widthsJs},
    })`)) as { frozen: boolean; width: number; widths: number[] };
    await chrome.executeJavaScript("document.querySelector('.tab-strip').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))");
    const unfrozen = await waitForJs(chrome, "!document.querySelector('.tab-strip.frozen')");
    const after = Math.max(...((await chrome.executeJavaScript(widthsJs)) as number[]));
    check(
      "tabs keep their width after a middle-click close until the pointer leaves the strip",
      closedOne && frozen.frozen && Math.abs(frozen.width - before) <= 1 && frozen.widths.every((w) => Math.abs(w - before) <= 1) && unfrozen && after >= before,
      { before, frozen, after, closedOne, unfrozen },
    );
    for (const t of extra) if (win.hasTab(t.id)) win.closeTab(t.id);

    await checkNarrowTabs(win, tab.id, h);

    // Drag the site chip onto the bookmarks bar: the page is bookmarked there with the tab's title.
    // The chip shows while the address bar is not being edited.
    win.sendCommand({ type: "close-overlays" });
    win.focusContent();
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
