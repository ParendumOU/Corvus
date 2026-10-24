import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface SleepSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function loaded(wc: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    wc.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Sleeping tabs: a background tab gives its page back and wakes with its history; the sleeper
 * puts old background tabs to sleep but spares one holding typed text; tabs show their memory.
 */
export async function runSleepSmoke(ctx: AppContext, h: SleepSmokeHelpers): Promise<void> {
  const { win, check } = h;
  const opened: string[] = [];
  const before = ctx.settings.get().memory;
  try {
    // A tab with two pages of history, then another tab in front of it.
    const a = win.createTab(`${h.url}ux-plain`, { activate: true });
    opened.push(a.id);
    await loaded(a.view.webContents);
    win.loadUrl(a.id, `${h.url}perm`);
    await loaded(a.view.webContents);
    const front = win.createTab(`${h.url}ux-plain`, { activate: true });
    opened.push(front.id);
    await loaded(front.view.webContents);

    const oldWc = a.view.webContents;
    const slept = win.sleepTab(a.id);
    await sleep(300);
    const view = win.state().tabs.find((t) => t.id === a.id);
    check("a background tab goes to sleep and lets its page go", slept && oldWc.isDestroyed() && view?.sleeping === true && a.view.webContents !== oldWc, {
      slept,
      released: oldWc.isDestroyed(),
      view,
    });
    check("an on-screen tab never sleeps", win.sleepTab(front.id) === false);

    win.activate(a.id);
    await loaded(a.view.webContents);
    await sleep(300);
    const woke = a.view.webContents.getURL();
    const canGoBack = a.view.webContents.navigationHistory.canGoBack();
    check("a sleeping tab wakes where it was, with its history", woke.endsWith("/perm") && canGoBack && win.state().tabs.find((t) => t.id === a.id)?.sleeping !== true, {
      woke,
      canGoBack,
    });
    a.view.webContents.navigationHistory.goBack();
    await loaded(a.view.webContents);
    check("its back button still goes to the earlier page", a.view.webContents.getURL().endsWith("/ux-plain"), a.view.webContents.getURL());

    // The sleeper: an old background tab sleeps, one with typed text stays awake.
    ctx.settings.update({ memory: { sleepTabs: true, sleepAfterMinutes: 5 } });
    const idle = win.createTab(`${h.url}ux-plain`, { activate: true });
    const typed = win.createTab(`${h.url}find`, { activate: true });
    opened.push(idle.id, typed.id);
    await loaded(typed.view.webContents);
    await typed.view.webContents.executeJavaScript(
      "(() => { const i = document.createElement('input'); document.body.append(i); i.value = 'half-written note'; return true; })()",
    );
    win.activate(front.id);
    await sleep(200);
    const count = await ctx.tabSleeper.tick(Date.now() + 10 * 60_000);
    const states = win.state().tabs;
    check(
      "the sleeper puts old background tabs to sleep but spares typed text",
      count >= 1 && states.find((t) => t.id === idle.id)?.sleeping === true && states.find((t) => t.id === typed.id)?.sleeping !== true,
      { count, idle: states.find((t) => t.id === idle.id)?.sleeping, typed: states.find((t) => t.id === typed.id)?.sleeping },
    );

    ctx.tabSleeper.refreshMemory();
    await sleep(200);
    const memory = win.state().tabs.find((t) => t.id === front.id)?.memoryKB ?? 0;
    check("tabs show the memory their page uses", memory > 1024, { memoryKB: memory });
  } catch (err) {
    check("sleeping tabs smoke", false, err instanceof Error ? err.message : String(err));
  } finally {
    ctx.settings.update({ memory: before });
    for (const id of opened) if (win.hasTab(id)) win.closeTab(id);
    await sleep(200);
  }
}
