import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { AgentModelProvider, AgentTurnRequest, TurnEvent } from "@corvus/ai-engine";
import { NEW_TAB_URL, isNewTabUrl } from "../shared/internal-urls";
import type { WindowState } from "../shared/ipc";
import { displayUrl, searchQueryOf } from "../shared/omnibox";
import type { AppContext } from "./context";
import { selfSignedCert } from "./smoke-assist";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(80);
  }
  return false;
}

const js = <T>(wc: WebContents | undefined, expr: string, gesture = false): Promise<T | null> =>
  !wc || wc.isDestroyed() ? Promise.resolve(null) : (wc.executeJavaScript(expr, gesture) as Promise<T>).catch(() => null);

const page = (title: string, body = ""): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

/** Records in the chrome UI the last state it was sent (tab ids and active tab), next to what it shows. */
const PROBE = `(() => {
  if (!window.__tabCloseProbe) {
    window.__tabCloseProbe = { ids: null, active: null };
    window.corvus.onState((s) => { window.__tabCloseProbe = { ids: s.tabs.map((t) => t.id), active: s.activeTabId }; });
  }
  const input = document.querySelector('.omni-input');
  return {
    tabs: [...document.querySelectorAll('.tab-strip .tab')].map((t) => ({ title: t.querySelector('.tab-title')?.textContent ?? null, active: t.classList.contains('active') })),
    omni: input ? input.value : null,
    received: window.__tabCloseProbe,
  };
})()`;

interface ChromeView {
  tabs: Array<{ title: string | null; active: boolean }>;
  omni: string | null;
  received: { ids: string[] | null; active: string | null };
}

/** What the strip shows for a state: collapsed groups keep only their active tab; pinned tabs have no title. */
function expectedView(state: WindowState): { ids: string[]; titles: Array<string | null>; active: number; omni: string[] } {
  const collapsed = new Set(state.groups.filter((g) => g.collapsed).map((g) => g.id));
  const shown = state.tabs.filter((t) => !(t.groupId && collapsed.has(t.groupId) && !t.active));
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  const url = active?.url ?? "";
  const edit = isNewTabUrl(url) || url === "about:blank" ? "" : (searchQueryOf(url) ?? url);
  return {
    ids: state.tabs.map((t) => t.id),
    titles: shown.map((t) => (t.pinned ? null : t.title || t.url)),
    active: shown.findIndex((t) => t.active),
    omni: [displayUrl(url), edit],
  };
}

/** Benign agent loop: open the page, then read it, until stopped. */
function loopProvider(url: string): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *streamTurn(req: AgentTurnRequest): AsyncGenerator<TurnEvent> {
      const issued = req.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use")).length;
      await sleep(40);
      yield issued === 0 ? { type: "tool_use", id: `c${issued}`, name: "navigate", input: { url } } : { type: "tool_use", id: `c${issued}`, name: "page_snapshot", input: {} };
      yield { type: "usage", inputTokens: 60, outputTokens: 12, model: "claude-haiku-5-5" };
      yield { type: "end", stopReason: "tool_use" };
    },
  };
}

/**
 * Closing tabs never leaves the chrome UI behind (tabs that stay on the strip after they closed, an
 * address bar stuck on an old page): tabs in every state (internal pages, certificate errors, crashed,
 * asleep, not loaded yet, a page dialog or permission prompt open, split, agent run, pinned, grouped,
 * private window, container, pages that close themselves or their popups) are closed every way the
 * person can (active and background, close others and to the right, the strip's close and middle
 * click, Ctrl+W, the page's window.close()). After each step the window's state builds and can be sent,
 * no error was thrown in the main process, and the strip and the address bar show the window's tabs.
 */
export async function runTabCloseSmoke(ctx: AppContext, { win, check, capture }: Helpers): Promise<void> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const name = decodeURIComponent((req.url ?? "").split("?")[1] ?? "") || path.slice(1) || "home";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page(`Close ${name}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const at = (name: string): string => `${base}p?${encodeURIComponent(name)}`;
  const tls = selfSignedCert("corvus-smoke.test");
  const router = tls ? https.createServer(tls, (_req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Router admin"))) : null;
  if (router) await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
  const routerUrl = router ? `https://corvus-smoke.test:${(router.address() as AddressInfo).port}/` : "";

  // Every error the main process swallows (uncaught exceptions, unhandled rejections) while this runs.
  const errors: Array<{ kind: string; message: unknown; stack?: unknown }> = [];
  let stateFailures = 0;
  const record = ctx.crashReporter.record.bind(ctx.crashReporter);
  ctx.crashReporter.record = (kind, data = {}) => {
    if (kind === "uncaught-exception" || kind === "unhandled-rejection") errors.push({ kind, message: data.message, stack: data.stack });
    if (kind === "window-state-failed") stateFailures++;
    record(kind, data);
  };
  const appearance = ctx.settings.get().appearance;
  ctx.settings.update({ appearance: { tabLayout: "horizontal" } });
  const profileId = win.profile.profile.id;
  const w = ctx.windows.open(profileId, [NEW_TAB_URL]);
  const windows: BrowserWindowCtl[] = [w];
  let containerId: string | null = null;
  let seen = 0;

  /** The window's state builds and goes out, nothing threw, and the chrome UI shows what it holds. */
  const verify = async (step: string, target: BrowserWindowCtl = w): Promise<void> => {
    if (target.isDisposed()) {
      check(`tab close: ${step}: window state reaches the chrome UI`, errors.length === seen, { disposed: true, errors: errors.slice(seen) });
      seen = errors.length;
      return;
    }
    let last: unknown = null;
    const shows = await until(async () => {
      let state: WindowState;
      try {
        state = target.state();
        structuredClone(state);
      } catch (err) {
        last = { stateError: err instanceof Error ? err.stack : String(err) };
        return false;
      }
      const want = expectedView(state);
      const view = await js<ChromeView>(target.chrome.webContents, PROBE);
      const strip = target.tabIds();
      last = { want, view, strip };
      if (!view) return false;
      // The probe was just put in (a new chrome UI): it learns of the state from the next one sent.
      if (view.received.ids === null) target.pushState();
      return (
        strip.every((id) => want.ids.includes(id)) &&
        JSON.stringify(view.received.ids) === JSON.stringify(want.ids) &&
        view.received.active === state.activeTabId &&
        JSON.stringify(view.tabs.map((t) => t.title)) === JSON.stringify(want.titles) &&
        view.tabs.findIndex((t) => t.active) === want.active &&
        view.omni !== null &&
        want.omni.includes(view.omni)
      );
    }, 5000);
    const fresh = errors.slice(seen);
    seen = errors.length;
    check(`tab close: ${step}: window state reaches the chrome UI`, shows && fresh.length === 0, { ...(last as object), errors: fresh });
  };

  const loaded = (tab: TabRuntime): Promise<boolean> => until(() => !tab.loading && !tab.view.webContents.isDestroyed() && tab.view.webContents.getURL() !== "", 10_000);
  const open = async (url: string, opts: Parameters<BrowserWindowCtl["createTab"]>[1] = {}, target: BrowserWindowCtl = w): Promise<TabRuntime> => {
    const tab = target.createTab(url, opts);
    if (!(opts.lazy && opts.activate === false)) await loaded(tab);
    return tab;
  };
  const gone = (id: string, target: BrowserWindowCtl = w): Promise<boolean> => until(() => !target.hasTab(id), 4000);

  try {
    await until(async () => (await js<boolean>(w.chrome.webContents, "Boolean(document.querySelector('.omni-input'))")) === true, 10_000);
    const first = w.activeTab();

    // Internal pages and web pages, closed in the background, while shown, from the strip, by Ctrl+W.
    const settings = await open("corvus://settings/");
    const webscope = await open("corvus://webscope/");
    const history = await open("corvus://history/");
    const a = await open(at("a"));
    const b = await open(at("b"));
    await verify("tabs opened");
    w.closeTab(settings.id);
    await verify("a background internal page closed");
    w.activate(history.id);
    await sleep(200);
    w.closeTab(history.id);
    await verify("the shown internal page closed");
    await js(w.chrome.webContents, `window.corvus.call('tabs.close', ${JSON.stringify(webscope.id)})`);
    await gone(webscope.id);
    await verify("closed from the strip (tabs.close)");
    const index = (await js<number>(w.chrome.webContents, `[...document.querySelectorAll('.tab-strip .tab')].findIndex((t) => t.querySelector('.tab-title')?.textContent === 'Close a')`)) ?? -1;
    await js(w.chrome.webContents, `document.querySelectorAll('.tab-strip .tab')[${index}]?.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))`);
    check("tab close: a middle click on the strip closes the tab", await gone(a.id), { index });
    await verify("closed with a middle click");
    w.activate(b.id);
    await sleep(200);
    b.view.webContents.focus();
    b.view.webContents.sendInputEvent({ type: "keyDown", keyCode: "W", modifiers: ["control"] });
    b.view.webContents.sendInputEvent({ type: "keyUp", keyCode: "W", modifiers: ["control"] });
    check("tab close: Ctrl+W closes the shown tab", await gone(b.id));
    await verify("closed with Ctrl+W");

    // Certificate errors: the error page, and a site let through with Proceed.
    if (router) {
      const certTab = await open(routerUrl);
      await until(() => certTab.view.webContents.getURL().startsWith("corvus://cert-error/"));
      await verify("certificate error page shown");
      w.closeTab(certTab.id);
      await verify("certificate error page closed while shown");
      const background = w.createTab(routerUrl, { activate: false });
      await until(() => background.view.webContents.getURL().startsWith("corvus://cert-error/"));
      w.closeTab(background.id);
      await verify("certificate error page closed in the background");
      const racing = w.createTab(routerUrl);
      await until(() => Boolean(racing.certError), 5000);
      w.closeTab(racing.id);
      await verify("certificate error tab closed before its page loaded");
      const proceeded = await open(routerUrl);
      await until(() => proceeded.view.webContents.getURL().startsWith("corvus://cert-error/"));
      w.proceedPastCertError(proceeded);
      await until(() => proceeded.view.webContents.getURL() === routerUrl && !proceeded.loading);
      const other = await open(routerUrl);
      await verify("tabs on a site let through with Proceed");
      w.closeTab(proceeded.id);
      await verify("a Proceed tab closed in the background");
      w.closeTab(other.id);
      await verify("a Proceed tab closed while shown");
    } else {
      check("tab close: self-signed test server (openssl)", false);
    }

    // A crashed tab, in the background and shown.
    const crashed = await open(at("crashed"));
    const crashedBack = await open(at("crashed-back"));
    for (const t of [crashed, crashedBack]) t.view.webContents.forcefullyCrashRenderer();
    await until(() => crashed.crashed && crashedBack.crashed && crashedBack.view.webContents.getURL().startsWith("corvus://crash/"));
    await verify("crashed tabs");
    w.activate(crashed.id);
    await sleep(300);
    w.closeTab(crashedBack.id);
    await verify("a crashed tab closed in the background");
    w.closeTab(crashed.id);
    await verify("a crashed tab closed while shown");

    // Sleeping tabs and tabs restored without loading.
    const sleepy = await open(at("asleep"), { activate: false });
    const waking = await open(at("waking"), { activate: false });
    check("tab close: background tabs go to sleep", w.sleepTab(sleepy.id) && w.sleepTab(waking.id));
    const lazy = await open(at("lazy"), { activate: false, lazy: true, title: "Close lazy" });
    const lazyShown = await open(at("lazy-shown"), { activate: false, lazy: true, title: "Close lazy-shown" });
    await verify("sleeping and not yet loaded tabs");
    check("tab close: a sleeping tab stays open when its page is let go", w.hasTab(sleepy.id) && w.hasTab(waking.id));
    w.closeTab(sleepy.id);
    w.closeTab(lazy.id);
    await verify("sleeping and not yet loaded tabs closed in the background");
    w.activate(waking.id);
    w.closeTab(waking.id);
    await verify("a sleeping tab closed as it wakes");
    w.activate(lazyShown.id);
    w.closeTab(lazyShown.id);
    await verify("a restored tab closed as it starts loading");

    // A page dialog and a permission prompt open.
    const dialogTab = await open(at("dialog"));
    await js(dialogTab.view.webContents, "setTimeout(() => alert('Closing with a dialog open'), 0); true");
    await until(() => w.state().dialog !== null, 4000);
    await verify("a page dialog open");
    w.closeTab(dialogTab.id);
    await verify("a tab closed with its dialog open");
    check("tab close: the dialog of a closed tab goes with it", await until(() => w.state().dialog === null, 4000), w.state().dialog);
    const promptTab = await open(at("prompt"));
    void js(promptTab.view.webContents, "Notification.requestPermission()", true);
    await until(() => w.state().permissionPrompt !== null, 4000);
    await verify("a permission prompt open");
    w.closeTab(promptTab.id);
    await verify("a tab closed with its permission prompt open");
    check("tab close: the permission prompt of a closed tab goes with it", w.state().permissionPrompt === null, w.state().permissionPrompt);

    // Split view: a shown pane, a pane in the background, a tab outside the split.
    const left = await open(at("left"));
    const right = await open(at("right"));
    w.enterSplit(left.id, right.id);
    await verify("a split");
    w.closeTab(left.id);
    await verify("the focused pane of a two-pane split closed");
    const p1 = await open(at("pane-1"));
    const p2 = await open(at("pane-2"));
    const p3 = await open(at("pane-3"));
    const outside = await open(at("outside"), { activate: false });
    w.enterSplit(p1.id, p2.id);
    w.addToSplit(p3.id);
    await verify("a three-pane split");
    w.closeTab(p2.id);
    await verify("a background pane of a three-pane split closed");
    w.closeTab(outside.id);
    await verify("a tab outside the split closed");
    w.activate(right.id);
    w.closeTab(p3.id);
    w.closeTab(p1.id);
    await verify("the rest of the split closed while another tab is shown");

    // Pinned and grouped tabs, a collapsed group closed whole.
    const pinned = await open(at("pinned"));
    w.pin(pinned.id, true);
    const g1 = await open(at("group-1"));
    const g2 = await open(at("group-2"));
    const g3 = await open(at("group-3"));
    const group = w.createGroup([g1.id, g2.id, g3.id], { title: "Closing" });
    await verify("pinned and grouped tabs");
    w.closeTab(pinned.id);
    await verify("a pinned tab closed");
    w.closeTab(g3.id);
    await verify("a grouped tab closed while shown");
    const after = await open(at("after-group"));
    if (group) w.updateGroup(group.id, { collapsed: true });
    await verify("a collapsed group");
    if (group) w.closeGroup(group.id);
    await verify("a collapsed group closed");
    check("tab close: closing a group closes its tabs", !w.hasTab(g1.id) && !w.hasTab(g2.id) && w.hasTab(after.id));

    // A container tab.
    const container = w.profile.containers.add("Tab close smoke", "blue");
    containerId = container.id;
    const boxed = await open(at("container"), { containerId: container.id });
    await verify("a container tab");
    w.closeTab(boxed.id);
    await verify("a container tab closed");

    // An agent run working in a tab that is closed under it.
    ctx.agentRunner.setTestProvider(loopProvider(at("agent")));
    ctx.agentRunner.start(w, "Read the page again and again");
    await until(() => (ctx.agentRunner.windowExtras(w).agentRun?.stepCount ?? 0) >= 2, 12_000);
    const runTab = ctx.agentRunner.windowExtras(w).agentRun?.tabId ?? null;
    check("tab close: an agent run works in a tab of the window", runTab !== null && w.hasTab(runTab), ctx.agentRunner.windowExtras(w).agentRun);
    await verify("an agent run at work");
    if (runTab) w.closeTab(runTab);
    await sleep(800);
    await verify("the agent run's tab closed");
    ctx.agentRunner.stop(w);
    await until(() => ctx.agentRunner.windowExtras(w).agentRun?.status !== "running", 6000);
    await verify("the agent run stopped");

    // Close other tabs and close tabs to the right, over a mix of states.
    const mix = [await open(at("mix-1")), await open("corvus://history/"), await open(at("mix-3"), { activate: false }), await open(at("mix-4"), { activate: false, lazy: true, title: "Close mix-4" })];
    w.sleepTab(mix[2]!.id);
    const keep = mix[1]!;
    const ids = w.tabIds();
    w.closeTabs(ids.slice(ids.indexOf(keep.id) + 1));
    await verify("close tabs to the right");
    w.closeTabs(w.tabIds().filter((id) => id !== keep.id));
    await verify("close other tabs");
    check("tab close: close other tabs leaves just the one", w.tabIds().join() === keep.id && w.hasTab(keep.id) && (!first || !w.hasTab(first.id)));

    // A private window: its tabs, then its last one (the window goes).
    const pw = ctx.windows.openPrivate(profileId, [at("private-1"), at("private-2")]);
    windows.push(pw);
    await until(async () => (await js<boolean>(pw.chrome.webContents, "Boolean(document.querySelector('.omni-input'))")) === true, 10_000);
    const privateTabs = pw.tabIds();
    await verify("a private window", pw);
    pw.closeTab(privateTabs[0]!);
    await verify("a private tab closed while shown", pw);
    const lastPrivate = pw.tabIds()[0];
    if (lastPrivate) pw.closeTab(lastPrivate);
    check("tab close: closing its last tab closes the private window", await until(() => pw.isDisposed(), 4000));
    await verify("the main window after the private one closed");

    // Pages that close themselves (window.close()), and popups their opener closes.
    const selfClosing = await open(at("self-closing"));
    await js(selfClosing.view.webContents, "window.close()");
    check("tab close: a page's window.close() closes its tab", await gone(selfClosing.id), { page: (selfClosing.view.webContents as WebContents | undefined)?.isDestroyed() ?? "gone" });
    await verify("a page closed itself");
    await capture("tab-close-self-closed", w.chrome.webContents);
    const opener = await open(at("opener"));
    await js(opener.view.webContents, `window.__popup = window.open(${JSON.stringify(at("popup"))}, "_blank"); true`, true);
    await until(() => w.activeTab()?.url === at("popup"), 5000);
    const popup = w.activeTab();
    if (popup && popup.id !== opener.id) {
      await loaded(popup);
      await verify("a popup opened in a tab");
      await js(popup.view.webContents, "window.close()");
      check("tab close: a popup that closes itself closes its tab", await gone(popup.id));
      await verify("a popup closed itself");
    } else {
      check("tab close: window.open opens a tab", false, { active: w.activeTab()?.url });
    }
    await js(opener.view.webContents, `window.__popup = window.open(${JSON.stringify(at("popup-2"))}, "_blank"); true`, true);
    await until(() => w.activeTab()?.url === at("popup-2"), 5000);
    const popup2 = w.activeTab();
    if (popup2 && popup2.id !== opener.id) {
      await loaded(popup2);
      w.activate(opener.id);
      await js(opener.view.webContents, "window.__popup.close(); true");
      check("tab close: a popup its opener closes closes its tab", await gone(popup2.id));
      await verify("a popup closed by its opener");
    } else {
      check("tab close: window.open opens a second tab", false, { active: w.activeTab()?.url });
    }

    // A part of the window's state that throws: it is logged, and the strip and the address bar still follow the tabs.
    const copiedLinks = ctx.grabber.copiedLinks;
    ctx.grabber.copiedLinks = () => {
      throw new Error("smoke: a broken part of the window state");
    };
    try {
      const kept = await open(at("broken-1"));
      const closed = await open(at("broken-2"));
      w.closeTab(closed.id);
      let view: ChromeView | null = null;
      const follows = await until(async () => {
        const now = await js<ChromeView>(w.chrome.webContents, PROBE);
        view = now;
        if (!now) return false;
        return JSON.stringify(now.received.ids) === JSON.stringify(w.tabIds()) && now.received.active === kept.id && now.tabs.find((t) => t.active)?.title === "Close broken-1" && [displayUrl(kept.url), kept.url].includes(now.omni ?? "");
      }, 5000);
      check("tab close: with a part of the window state broken, the strip and the address bar still follow the tabs", follows && stateFailures > 0 && errors.length === seen, { view, strip: w.tabIds(), stateFailures, errors: errors.slice(seen) });
    } finally {
      ctx.grabber.copiedLinks = copiedLinks;
    }
    await verify("the window state builds again");

    // The window closes: nothing of it is left behind for the profile's other windows.
    w.close();
    check("tab close: a closed window leaves the window list", await until(() => w.isDisposed() && !ctx.windows.all().includes(w), 4000));
    await verify("the smoke window closed", w);
    await verify("the first window after another window of its profile closed", win);
  } catch (err) {
    check("tab close smoke", false, err instanceof Error ? err.stack : String(err));
  } finally {
    ctx.agentRunner.stop(w);
    ctx.agentRunner.clear(w);
    ctx.agentRunner.setTestProvider(undefined);
    for (const win2 of windows) if (!win2.isDisposed()) win2.close();
    if (containerId) w.profile.containers.remove(containerId);
    ctx.certErrors.exceptions.revoke(win.profile.session, "corvus-smoke.test");
    ctx.settings.update({ appearance: { tabLayout: appearance.tabLayout } });
    ctx.crashReporter.record = record;
    server.close();
    router?.close();
    await sleep(300);
  }
}
