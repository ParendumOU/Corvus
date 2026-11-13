import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface TabSelectSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(50);
  }
  return cond();
}

/**
 * A click (press, release, click) on tab `id` of the strip, with modifier keys held. Dispatched in
 * the page: input events sent to a view in the headless smoke carry no modifier keys.
 */
async function clickTab(chrome: WebContents, id: string, modifiers: Array<"control" | "shift"> = []): Promise<boolean> {
  return (await chrome.executeJavaScript(`(() => {
    const tab = document.querySelector('.tab-strip .tab[data-tab-id="${id}"]');
    if (!tab) return false;
    const r = tab.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, button: 0, clientX: r.left + Math.min(30, r.width / 2), clientY: r.top + r.height / 2, ctrlKey: ${modifiers.includes("control")}, shiftKey: ${modifiers.includes("shift")} };
    for (const type of ['mousedown', 'mouseup', 'click']) tab.dispatchEvent(new MouseEvent(type, { ...init, buttons: type === 'mousedown' ? 1 : 0 }));
    return true;
  })()`)) === true;
}

/** The strip's tabs drawn as selected (with others), in order. */
const highlighted = (chrome: WebContents): Promise<string[]> =>
  chrome.executeJavaScript("[...document.querySelectorAll('.tab-strip .tab.selected')].map((t) => t.dataset.tabId)") as Promise<string[]>;

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Several tabs selected together (CORVUS_SMOKE_ONLY=tabselect; also in the full run): Ctrl+click
 * adds a tab, Shift+click picks a range, the strip highlights them, dragging one moves them all,
 * Ctrl+W closes them all, and a plain click picks one tab again.
 */
export async function runTabSelectSmoke(_ctx: AppContext, h: TabSelectSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const chrome = win.chrome.webContents;
  const tabs = [1, 2, 3, 4, 5].map((n) => win.createTab(`${h.url}ux-plain?select=${n}`, { activate: n === 1 }));
  const [a, b, c, d, e] = tabs.map((t) => t.id) as [string, string, string, string, string];
  try {
    await until(async () => (await chrome.executeJavaScript(`document.querySelectorAll('.tab-strip .tab[data-tab-id^="t"]').length`)) >= tabs.length);
    await sleep(300);

    await clickTab(chrome, a);
    await clickTab(chrome, c, ["control"]);
    await until(() => same(win.selectedTabIds(), [a, c]));
    await until(async () => same(await highlighted(chrome), [a, c]));
    check(
      "tab select: Ctrl+click adds a tab to the selection, makes it active, and both are highlighted",
      same(win.selectedTabIds(), [a, c]) && win.activeTab()?.id === c && same(await highlighted(chrome), [a, c]),
      { selected: win.selectedTabIds(), active: win.activeTab()?.id, highlighted: await highlighted(chrome) },
    );
    await capture("tab-select-ctrl-click", chrome);

    await clickTab(chrome, e, ["shift"]);
    await until(() => same(win.selectedTabIds(), [c, d, e]));
    check("tab select: Shift+click picks the range from the last tab clicked", same(win.selectedTabIds(), [c, d, e]) && win.activeTab()?.id === e, win.selectedTabIds());

    // Ctrl+click on a selected tab takes it out; the menu and drag act on what stays selected.
    await clickTab(chrome, d, ["control"]);
    await until(() => same(win.selectedTabIds(), [c, e]));
    check("tab select: Ctrl+click on a selected tab takes it out", same(win.selectedTabIds(), [c, e]) && same(win.actionTabIds(c), [c, e]) && same(win.actionTabIds(b), [b]), win.selectedTabIds());

    // Dragging one of them before tab a moves both, in order.
    const ids = win.tabIds();
    win.moveTab(e, ids.indexOf(a), null);
    const order = win.tabIds();
    const at = order.indexOf(c);
    check("tab select: dragging one selected tab moves all of them together", order[at + 1] === e && order[at + 2] === a && order.indexOf(b) > order.indexOf(a), order.filter((id) => tabs.some((t) => t.id === id)));

    // A plain click on one of them picks it alone; Ctrl+W then closes only it.
    await clickTab(chrome, c);
    await until(async () => same(win.selectedTabIds(), [c]) && (await highlighted(chrome)).length === 0);
    check("tab select: a plain click picks one tab again", same(win.selectedTabIds(), [c]) && (await highlighted(chrome)).length === 0, { selected: win.selectedTabIds(), highlighted: await highlighted(chrome) });

    // Ctrl+W with several selected closes all of them.
    await clickTab(chrome, d, ["control"]);
    await until(() => same(win.selectedTabIds(), [c, d]));
    win.runCommand({ type: "close-tab" });
    await until(() => !win.hasTab(c) && !win.hasTab(d));
    check("tab select: Ctrl+W closes every selected tab", !win.hasTab(c) && !win.hasTab(d) && win.hasTab(a) && win.hasTab(b) && win.hasTab(e), win.tabIds().length);
  } catch (err) {
    check("tab select smoke", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  } finally {
    for (const t of tabs) if (win.hasTab(t.id)) win.closeTab(t.id);
    await sleep(200);
  }
}
