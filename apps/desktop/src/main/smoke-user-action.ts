import http from "node:http";
import type { AddressInfo } from "node:net";
import { nativeTheme, type WebContents } from "electron";
import type { TabId, UserActionResult } from "@corvus/shared";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(80);
  }
  return false;
}

const page = (title: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

/** What the chrome UI shows of a tab (either layout), its group's chip and the window's bars. */
interface ChromeView {
  tab: { classes: string; title: string; animation: string; opacity: string } | null;
  chip: { classes: string; animation: string } | null;
  bars: Array<{ text: string; goto: boolean }>;
}

const probe = (tabId: TabId, groupId = ""): string => `(() => {
  const tab = document.querySelector('.tab[data-tab-id="${tabId}"], .v-tab[data-tab-id="${tabId}"]');
  const after = tab ? getComputedStyle(tab, '::after') : null;
  const chip = ${JSON.stringify(groupId)} ? document.querySelector('.group-chip[data-group-id="${groupId}"], .v-group[data-group-id="${groupId}"]') : null;
  return {
    tab: tab ? { classes: tab.className, title: tab.title, animation: after.animationName, opacity: after.opacity } : null,
    chip: chip ? { classes: chip.className, animation: [getComputedStyle(chip).animationName, getComputedStyle(chip, '::after').animationName].find((a) => a !== 'none') ?? 'none' } : null,
    bars: [...document.querySelectorAll('.dialog-bar')].map((b) => ({ text: b.textContent, goto: Boolean(b.querySelector('[data-dialog-goto]')) })),
  };
})()`;

/** Screenshots show the pulse at its brightest (the steady look): no animation while capturing. */
const FREEZE = `(() => {
  const s = document.createElement('style');
  s.id = 'smoke-freeze';
  s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
  document.head.append(s);
})()`;
const UNFREEZE = "document.getElementById('smoke-freeze')?.remove()";

/**
 * request_user_action on a background tab (CORVUS_SMOKE_ONLY=useraction; also in the full run): the
 * active tab and the windows' focus stay as they are, the bar shows in the tab's window (not the
 * focused one), and the tab pulses in the strip (both layouts, a collapsed group's chip too) until
 * Done, Cancel, the timeout, the client going away or the tab closing. "Go to tab" shows the tab
 * without answering; while it is the active tab its highlight is steady. Several requests each
 * mark their own tab. A window that is not focused flashes in the taskbar instead of coming up.
 */
export async function runUserActionSmoke(ctx: AppContext, { win, check, capture }: Helpers): Promise<void> {
  const server = http.createServer((req, res) => {
    const title = decodeURIComponent((req.url ?? "/").split("?")[1] ?? "Page");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page(title));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const at = (title: string): string => `${base}p?${encodeURIComponent(title)}`;
  const host = new URL(base).host;

  const appearance = ctx.settings.get().appearance;
  const themeBefore = nativeTheme.themeSource;
  ctx.settings.update({ appearance: { tabLayout: "horizontal", sidebarCollapsed: false } });
  nativeTheme.themeSource = "light";
  // The client's name as an MCP client gives it (the owner's agent).
  Object.defineProperty(ctx.agents, "currentClient", { value: "claude-code", configurable: true });
  const windows: BrowserWindowCtl[] = [];
  const pending: Array<AbortController> = [];
  try {
    const w = ctx.windows.open(win.profile.profile.id, [at("Inbox")]);
    windows.push(w);
    const chrome = w.chrome.webContents;
    await until(async () => (await chrome.executeJavaScript("document.querySelectorAll('.tab').length").catch(() => 0)) === 1);
    const mine = w.activeTab()!;
    const asking = w.createTab(at("Sign in - Central"), { activate: false });
    const docs = w.createTab(at("Docs"), { activate: false });
    await until(() => w.listTabs().every((t) => !t.loading));
    await sleep(300);

    const flashes: boolean[] = [];
    const flashFrame = w.win.flashFrame.bind(w.win);
    w.win.flashFrame = (flag: boolean): void => {
      flashes.push(flag);
      flashFrame(flag);
    };

    const view = async (tabId: TabId, groupId = ""): Promise<ChromeView> => (await chrome.executeJavaScript(probe(tabId, groupId))) as ChromeView;
    const flagged = (target: BrowserWindowCtl = w): TabId[] => target.state().tabs.filter((t) => t.needsYou).map((t) => t.id);
    const ask = (tabId: TabId, timeoutMs = 120_000): { result: () => UserActionResult | null; done: Promise<UserActionResult>; abort: () => void } => {
      const controller = new AbortController();
      pending.push(controller);
      let result: UserActionResult | null = null;
      const done = ctx.controller.requestUserAction(tabId, { message: "Sign in to your account, then click Done", timeoutMs }, controller.signal).then((r) => (result = r));
      return { result: () => result, done, abort: () => controller.abort() };
    };
    const shoot = async (name: string): Promise<void> => {
      await chrome.executeJavaScript(FREEZE);
      await sleep(120);
      await capture(name, chrome);
      await chrome.executeJavaScript(UNFREEZE);
    };
    const press = (selector: string): Promise<unknown> => chrome.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); b?.click(); return Boolean(b); })()`);

    // ------------------------------------------------------------ a request on a background tab
    const focusedBefore = { w: w.win.isFocused(), target: ctx.windows.focused() };
    const first = ask(asking.id);
    await until(async () => (await view(asking.id)).bars.length === 1);
    await sleep(150);
    const seen = await view(asking.id);
    check(
      "user action: asking from a background tab leaves the active tab and the windows' focus as they were",
      w.activeTab()?.id === mine.id && w.win.isFocused() === focusedBefore.w && ctx.windows.focused() === focusedBefore.target,
      { active: w.activeTab()?.id, mine: mine.id, asking: asking.id, focused: w.win.isFocused(), before: focusedBefore.w },
    );
    check(
      "user action: the bar shows in the tab's window, names the client and the site, and offers Go to tab",
      ctx.dialogs.bars(w).length === 1 && seen.bars.length === 1 && seen.bars[0]!.text.includes("claude-code") && seen.bars[0]!.text.includes(host) && seen.bars[0]!.goto,
      seen.bars,
    );
    check(
      "user action: only the asking tab needs you, and it blinks in the strip with its tooltip",
      flagged().join() === asking.id && /\bneeds-you\b/.test(seen.tab?.classes ?? "") && seen.tab?.animation === "needs-you" && (seen.tab?.title ?? "").includes("An AI agent needs you here"),
      { flagged: flagged(), tab: seen.tab },
    );
    check("user action: a window that is not focused flashes in the taskbar, a focused one does not", focusedBefore.w ? flashes.length === 0 : flashes[0] === true, { flashes, focused: focusedBefore.w });

    // Screenshots: both layouts, light and dark.
    for (const layout of ["horizontal", "vertical"] as const) {
      ctx.settings.update({ appearance: { tabLayout: layout } });
      for (const theme of ["light", "dark"] as const) {
        nativeTheme.themeSource = theme;
        await sleep(350);
        if (theme === "light") {
          const shown = await view(asking.id);
          check(`user action: the asking tab blinks in the ${layout} strip`, /\bneeds-you\b/.test(shown.tab?.classes ?? "") && shown.tab?.animation === "needs-you", shown.tab);
        }
        await shoot(`user-action-${layout}-${theme}`);
      }
    }
    nativeTheme.themeSource = "light";
    ctx.settings.update({ appearance: { tabLayout: "horizontal" } });

    // In a collapsed group the chip pulses (the tab itself is hidden).
    const group = w.createGroup([asking.id, docs.id], { title: "Bank", color: "blue" });
    if (group) w.updateGroup(group.id, { collapsed: true });
    for (const layout of ["horizontal", "vertical"] as const) {
      ctx.settings.update({ appearance: { tabLayout: layout } });
      await sleep(350);
      const shown = await view(asking.id, group?.id ?? "");
      check(
        `user action: a collapsed group's chip pulses while a tab in it needs you (${layout})`,
        shown.tab === null && /\bneeds-you\b/.test(shown.chip?.classes ?? "") && (shown.chip?.animation ?? "none") !== "none",
        shown,
      );
      await shoot(`user-action-group-${layout}-light`);
    }
    if (group) w.ungroupTabs([asking.id, docs.id]);
    ctx.settings.update({ appearance: { tabLayout: "horizontal" } });
    await sleep(300);

    // "Go to tab" shows the tab without answering; while active its highlight is steady.
    const went = await press(".dialog-bar [data-dialog-goto]");
    await until(() => w.activeTab()?.id === asking.id);
    await sleep(250);
    const there = await view(asking.id);
    check(
      "user action: Go to tab activates the asking tab and leaves the request open, with a steady highlight",
      went === true && w.activeTab()?.id === asking.id && first.result() === null && there.bars.length === 1 && !there.bars[0]!.goto && /\bneeds-you\b/.test(there.tab?.classes ?? "") && there.tab?.animation === "none",
      { went, active: w.activeTab()?.id, result: first.result(), there },
    );
    await shoot("user-action-active-light");
    nativeTheme.themeSource = "dark";
    await sleep(300);
    await shoot("user-action-active-dark");
    nativeTheme.themeSource = "light";

    await press(".dialog-bar [data-dialog-button='1']");
    const answered = await Promise.race([first.done, sleep(4000).then(() => null)]);
    await sleep(200);
    const cleared = await view(asking.id);
    check(
      "user action: Done answers done and clears the bar and the tab's mark",
      answered?.outcome === "done" && flagged().length === 0 && cleared.bars.length === 0 && !/\bneeds-you\b/.test(cleared.tab?.classes ?? ""),
      { answered, flagged: flagged(), cleared },
    );

    // ------------------------------------------------------------ the bar goes to the tab's window
    w.activate(mine.id);
    const other = ctx.windows.open(win.profile.profile.id, [at("Elsewhere")]);
    windows.push(other);
    await until(async () => (await other.chrome.webContents.executeJavaScript("document.querySelectorAll('.tab').length").catch(() => 0)) === 1);
    const focusedTarget = ctx.windows.focused();
    const second = ask(asking.id);
    await until(async () => (await view(asking.id)).bars.length === 1);
    const otherBars = (await other.chrome.webContents.executeJavaScript("document.querySelectorAll('.dialog-bar').length")) as number;
    check(
      "user action: with another window focused, the bar shows in the tab's window only and focus stays put",
      ctx.dialogs.bars(w).length === 1 && ctx.dialogs.bars(other).length === 0 && otherBars === 0 && ctx.windows.focused() === focusedTarget && w.activeTab()?.id === mine.id && flagged(other).length === 0,
      { inTabWindow: ctx.dialogs.bars(w).length, inOther: ctx.dialogs.bars(other).length, otherBars, focusedIsOther: ctx.windows.focused() === other },
    );
    await press(".dialog-bar [data-dialog-button='0']");
    const cancelled = await Promise.race([second.done, sleep(4000).then(() => null)]);
    await sleep(200);
    check("user action: Cancel answers cancelled and clears the tab's mark", cancelled?.outcome === "cancelled" && flagged().length === 0 && ctx.dialogs.bars(w).length === 0, { cancelled, flagged: flagged() });

    // ------------------------------------------------------------ timeout, client gone, tab closed
    const late = ask(asking.id, 1000);
    await until(() => flagged().length === 1, 2000);
    const timedOut = await Promise.race([late.done, sleep(5000).then(() => null)]);
    await sleep(150);
    check("user action: the timeout clears the bar and the tab's mark", timedOut?.outcome === "timeout" && flagged().length === 0 && ctx.dialogs.bars(w).length === 0, { timedOut, flagged: flagged() });

    const gone = ask(asking.id);
    await until(() => flagged().length === 1, 2000);
    gone.abort();
    await Promise.race([gone.done, sleep(4000)]);
    await sleep(150);
    check("user action: the client going away clears the bar and the tab's mark", flagged().length === 0 && ctx.dialogs.bars(w).length === 0 && (await view(asking.id)).bars.length === 0, { flagged: flagged() });

    const closing = w.createTab(at("Checkout"), { activate: false });
    const onClosing = ask(closing.id);
    await until(() => flagged().includes(closing.id), 2000);
    w.closeTab(closing.id);
    const closed = await Promise.race([onClosing.done, sleep(4000).then(() => null)]);
    await sleep(150);
    check("user action: closing the asking tab ends the request (cancelled) and its bar", closed?.outcome === "cancelled" && ctx.dialogs.bars(w).length === 0 && flagged().length === 0, { closed, flagged: flagged() });

    // ------------------------------------------------------------ two requests at once
    const one = ask(asking.id);
    const two = ask(docs.id);
    await until(async () => (await view(asking.id)).bars.length === 2);
    const both = flagged().sort().join();
    const docsBar = ctx.dialogs.bars(w).find((b) => b.tabId === docs.id)?.id ?? "";
    await press(`[data-dialog-bar="${docsBar}"] [data-dialog-button='1']`);
    await Promise.race([two.done, sleep(4000)]);
    await sleep(200);
    const left = flagged();
    const dom = await view(asking.id);
    check(
      "user action: two requests mark their own tabs, and answering one clears only its tab",
      both === [asking.id, docs.id].sort().join() && two.result()?.outcome === "done" && one.result() === null && left.join() === asking.id && dom.bars.length === 1 && /\bneeds-you\b/.test(dom.tab?.classes ?? ""),
      { both, left, two: two.result(), one: one.result(), bars: dom.bars },
    );
    one.abort();
    await Promise.race([one.done, sleep(4000)]);

    // ------------------------------------------------------------ taskbar flash
    const isFocused = w.win.isFocused.bind(w.win);
    w.win.isFocused = (): boolean => false;
    flashes.length = 0;
    const away = ask(asking.id);
    await until(() => flagged().length === 1, 2000);
    const started = [...flashes];
    w.win.emit("focus");
    const onFocus = [...flashes];
    away.abort();
    await Promise.race([away.done, sleep(4000)]);
    w.win.isFocused = isFocused;
    check(
      "user action: an unfocused window flashes in the taskbar until it gets focus, without being raised",
      started.join() === "true" && onFocus.join() === "true,false" && w.activeTab()?.id === mine.id,
      { started, onFocus, active: w.activeTab()?.id },
    );

    // ------------------------------------------------------------ reduced motion: steady highlight
    const still = ask(asking.id);
    await until(async () => (await view(asking.id)).bars.length === 1);
    const dbg = chrome.debugger;
    let reduced: ChromeView | null = null;
    try {
      dbg.attach();
      await dbg.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await sleep(250);
      reduced = await view(asking.id);
      await dbg.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    } catch (err) {
      reduced = null;
      check("user action: reduced motion emulation", false, String(err));
    } finally {
      if (dbg.isAttached()) dbg.detach();
    }
    check(
      "user action: with reduced motion the asking tab is highlighted without blinking",
      Boolean(reduced) && /\bneeds-you\b/.test(reduced?.tab?.classes ?? "") && reduced?.tab?.animation === "none" && reduced?.tab?.opacity === "1",
      reduced?.tab,
    );
    still.abort();
    await Promise.race([still.done, sleep(4000)]);
    w.win.flashFrame = flashFrame;
  } catch (err) {
    check("user action smoke", false, err instanceof Error ? err.stack : String(err));
  } finally {
    for (const controller of pending) controller.abort();
    delete (ctx.agents as unknown as Record<string, unknown>).currentClient;
    for (const w of windows) w.close();
    ctx.settings.update({ appearance: { tabLayout: appearance.tabLayout, sidebarCollapsed: appearance.sidebarCollapsed } });
    nativeTheme.themeSource = themeBefore;
    server.close();
    await sleep(300);
  }
}
