import type { WebContents } from "electron";
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
    split?.leftTabId === left.id && split.rightTabId === right.id && split.focusedTabId === left.id,
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
