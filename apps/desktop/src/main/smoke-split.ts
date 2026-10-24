import { webContents, type WebContents } from "electron";
import type { BrowserWindowCtl } from "./window";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
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

export interface SplitSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

/** Split view: two tabs tiled live side by side, focus switching, resize, and collapse on close. */
export async function runSplitSmoke(_ctx: unknown, h: SplitSmokeHelpers): Promise<void> {
  const { url, win, check, capture } = h;
  const left = win.createTab(`${url}?split=left`);
  const right = win.createTab(`${url}?split=right`);
  await waitForLoad(left.view.webContents);
  await waitForLoad(right.view.webContents);

  win.enterSplit(left.id, right.id);
  await sleep(400);

  const split = win.state().split;
  check(
    "split enters with the two panes and the primary focused",
    split?.paneIds.join() === `${left.id},${right.id}` && split.focusedTabId === left.id && split.shown,
    split,
  );

  const lb = left.view.getBounds();
  const rb = right.view.getBounds();
  check(
    "split lays out two panes side by side without overlap",
    lb.width > 100 && rb.width > 100 && lb.x < rb.x && lb.x + lb.width <= rb.x && lb.height === rb.height,
    { lb, rb },
  );

  // Both panes are live renderers, including the one that is not focused.
  const leftTitle = await left.view.webContents.executeJavaScript("document.title");
  const rightTitle = await right.view.webContents.executeJavaScript("document.title");
  check(
    "both split panes stay live (not suspended)",
    leftTitle === "Smoke" && rightTitle === "Smoke" && !left.view.webContents.isDestroyed() && !right.view.webContents.isDestroyed(),
    { leftTitle, rightTitle },
  );
  await capture("split-view", win.chrome.webContents);

  // Clicking the non-focused pane focuses it: the real wiring runs through the pane's focus event.
  right.view.webContents.focus();
  const switched = await waitFor(() => win.state().split?.focusedTabId === right.id && win.activeTab()?.id === right.id);
  check("clicking a pane makes it the omnibox/keyboard target", switched, {
    focused: win.state().split?.focusedTabId,
    active: win.activeTab()?.id,
  });

  // Omnibox/navigation acts on the focused pane only.
  win.navigateInput(win.activeTab()?.id ?? right.id, `${url}?split=navigated`);
  await sleep(500);
  check(
    "navigation targets the focused pane, leaves the other untouched",
    right.view.webContents.getURL().includes("split=navigated") && left.view.webContents.getURL().includes("split=left"),
    { left: left.view.webContents.getURL(), right: right.view.webContents.getURL() },
  );

  // Window resize recomputes the pane bounds.
  const before = left.view.getBounds().width;
  const [w = 1280, hgt = 840] = win.win.getContentSize();
  win.win.setContentSize(w - 120, hgt);
  await sleep(300);
  const after = left.view.getBounds().width;
  check("window resize recomputes split bounds", after < before && after > 0, { before, after });
  win.win.setContentSize(w, hgt);
  await sleep(200);

  // Another tab shows on its own while the split waits; coming back to a pane brings the split back.
  const outside = win.createTab(`${url}?split=outside`);
  await waitForLoad(outside.view.webContents);
  await sleep(200);
  const waiting = win.state().split;
  const parked = { split: waiting, leftVisible: left.view.getVisible(), outsideBounds: outside.view.getBounds() };
  check(
    "split waits while another tab is shown",
    waiting?.shown === false && waiting.focusedTabId === null && waiting.paneIds.length === 2 && !left.view.getVisible() && !right.view.getVisible(),
    parked,
  );
  win.activate(left.id);
  await sleep(200);
  check(
    "showing a pane again brings the split back",
    win.state().split?.shown === true && left.view.getVisible() && right.view.getVisible() && !outside.view.getVisible(),
    win.state().split,
  );

  // Up to four panes: 1 + 2, then a 2×2 grid.
  const third = win.createTab(`${url}?split=third`, { activate: false });
  const fourth = win.createTab(`${url}?split=fourth`, { activate: false });
  await waitForLoad(third.view.webContents);
  win.addToSplit(third.id);
  await sleep(200);
  const three = [left, right, third].map((t) => t.view.getBounds());
  check(
    "a third pane stacks under the right one",
    win.state().split?.paneIds.length === 3 && three[1]!.x === three[2]!.x && three[1]!.y < three[2]!.y && three[0]!.height > three[1]!.height,
    three,
  );
  win.addToSplit(fourth.id);
  await sleep(300);
  const grid = [left, right, third, fourth].map((t) => t.view.getBounds());
  const [tl, tr, bl, br] = grid as [Electron.Rectangle, Electron.Rectangle, Electron.Rectangle, Electron.Rectangle];
  check(
    "four panes tile a 2×2 grid, all live",
    win.state().split?.paneIds.length === 4 &&
      tl.x === bl.x &&
      tr.x === br.x &&
      tl.y === tr.y &&
      bl.y === br.y &&
      tl.x < tr.x &&
      tl.y < bl.y &&
      [left, right, third, fourth].every((t) => t.view.getVisible() && !t.view.webContents.isDestroyed()),
    grid,
  );
  await capture("split-grid", win.chrome.webContents);

  // Dragging the horizontal divider moves the rows: pointer events in the divider's own view.
  const rowDivider = webContents.getAllWebContents().find((wc) => wc.getURL().endsWith("#y"));
  if (rowDivider) {
    await rowDivider.executeJavaScript("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientY: 3 })); true");
    await sleep(250);
    await rowDivider.executeJavaScript("document.body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: Math.round(innerHeight * 0.3) })); true");
    await sleep(150);
    await rowDivider.executeJavaScript("document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); true");
    await sleep(250);
  }
  const ratioY = win.state().split?.ratioY ?? 0;
  check("dragging the row divider resizes the rows", rowDivider !== undefined && Math.abs(ratioY - 0.3) < 0.05 && left.view.getBounds().height < third.view.getBounds().height, {
    ratioY,
    top: left.view.getBounds().height,
    bottom: third.view.getBounds().height,
  });
  win.removeFromSplit(fourth.id);
  await sleep(200);
  check("removing a pane keeps the others tiled", win.state().split?.paneIds.length === 3 && !fourth.view.getVisible(), win.state().split);
  win.closeTab(third.id);
  await sleep(200);
  check("closing a pane of three keeps a two-pane split", win.state().split?.paneIds.join() === `${left.id},${right.id}`, win.state().split);
  win.closeTabs([outside.id, fourth.id]);
  win.activate(right.id);
  await sleep(200);

  // Exit split returns to a single pane.
  win.exitSplit();
  await sleep(200);
  check("exit split returns to a single tab", win.state().split === null && win.activeTab()?.id === right.id);

  // Closing one pane of a split collapses to the survivor.
  win.enterSplit(left.id, right.id);
  await sleep(200);
  win.closeTab(right.id);
  await sleep(200);
  check(
    "closing a pane collapses the split to the survivor",
    win.state().split === null && win.hasTab(left.id) && !win.hasTab(right.id) && win.activeTab()?.id === left.id,
    { split: win.state().split, active: win.activeTab()?.id },
  );

  win.closeTab(left.id);
}
