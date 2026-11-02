import http from "node:http";
import type { AddressInfo } from "node:net";
import { BrowserWindow, type WebContents } from "electron";
import type { AppContext } from "./context";
import { openMcpSession, type McpSession } from "./smoke-agent";
import { pageOf } from "./tab-page";
import type { BrowserWindowCtl } from "./window";

export interface AgentIsolationSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PERSON_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Person's draft</title></head>
<body><h1>My draft</h1><input id="mine" placeholder="Write here"></body></html>`;

/** Where the agent works: a search field, a button, a second field and a pad that reports drags. */
const AGENT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent work</title>
<style>body{margin:0;font:16px sans-serif}#pad{position:absolute;left:40px;top:200px;width:400px;height:120px;background:#ddd}</style></head>
<body><h1>Agent work</h1><input id="q" placeholder="Search"><button id="go" type="button" onclick="window.__clicked = event.isTrusted">Go</button>
<input id="typed" placeholder="Typed"><div id="pad"></div>
<script>
window.__clicked = false;
window.__drag = "none";
let start = null;
document.getElementById("pad").addEventListener("mousedown", (e) => { start = { x: e.clientX, trusted: e.isTrusted }; });
addEventListener("mouseup", (e) => { if (start) { window.__drag = (e.clientX - start.x) + ":" + start.trusted; start = null; } });
</script></body></html>`;

function serve(): Promise<{ base: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.url?.startsWith("/person") ? PERSON_PAGE : AGENT_PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() })));
}

async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

function loaded(wc: WebContents, ms = 15_000): Promise<void> {
  return new Promise((resolve) => {
    if (wc.getURL() && !wc.isLoading()) return resolve();
    const timer = setTimeout(resolve, ms);
    wc.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const idOf = (text: string): string => /"id":"([^"]+)"/.exec(text)?.[1] ?? "";
const refOf = (snapshot: string, element: string): string => new RegExp(`\\b(e\\d+) ${element}`).exec(snapshot)?.[1] ?? "";
const centerOf = (snapshot: string, element: string): { x: number; y: number } | null => {
  const m = new RegExp(`\\b(e\\d+) ${element}[^\\n]*@(-?\\d+),(-?\\d+),(\\d+),(\\d+)`).exec(snapshot);
  return m ? { x: Number(m[2]) + Number(m[4]) / 2, y: Number(m[3]) + Number(m[5]) / 2 } : null;
};

/** Counts calls to a window method (the ones that pull a window to the front). */
function spy(target: BrowserWindow, method: "focus" | "show" | "restore" | "moveTop" | "flashFrame"): { calls: unknown[][]; undo: () => void } {
  const original = target[method] as (...args: unknown[]) => void;
  const calls: unknown[][] = [];
  (target as unknown as Record<string, unknown>)[method] = (...args: unknown[]): void => {
    calls.push(args);
    original.apply(target, args);
  };
  return { calls, undo: () => ((target as unknown as Record<string, unknown>)[method] = original) };
}

/**
 * AI agents never take the person's tab or window (CORVUS_SMOKE_ONLY=isolation; also in the full
 * run). Over the real MCP server, an agent with no tab of its own works in one it opens in the
 * background while the person types in theirs: its typing, clicks, keys, a drag and a screenshot all
 * land in its hidden tab, and the person's tab stays in front with the keyboard. Then, while another
 * app has the focus, the agent opens and drives tabs, shows one and asks a question: Corvus never
 * takes the focus back (its taskbar button flashes for the question), and the keyboard goes to the
 * tab on screen once the person comes back.
 */
export async function runAgentIsolationSmoke(ctx: AppContext, h: AgentIsolationSmokeHelpers): Promise<void> {
  const { win, check } = h;
  const clientName = "corvus-smoke-isolation";
  const before = ctx.settings.get().mcp;
  const server = await serve();
  let session: McpSession | null = null;
  let other: BrowserWindow | null = null;
  const spies: Array<{ undo: () => void }> = [];
  const agentTabs: string[] = [];
  const personTab = win.createTab(`${server.base}person`, { activate: true });
  try {
    ctx.settings.update({ mcp: { enabled: true, accessLevel: "standard", allowEvaluate: false, approvedClients: [...before.approvedClients.filter((c) => c !== clientName), clientName] } });
    await ctx.mcp.apply();
    const status = ctx.mcp.status();
    if (!status.running || !status.port || !status.token) {
      check("isolation: MCP server running", false, { running: status.running, error: status.error });
      return;
    }
    const personWc = personTab.view.webContents;
    await loaded(personWc);
    win.win.focus();
    await until(() => win.win.isFocused());
    // The person is typing in their own tab.
    await personWc.executeJavaScript("document.getElementById('mine').focus()");
    win.focusContent();
    await sleep(200);
    await personWc.insertText("draft");
    // Every moment the person's page loses the keyboard would close a menu or list they have open.
    await personWc.executeJavaScript("window.__blurs = 0; addEventListener('blur', () => window.__blurs++); true");

    session = await openMcpSession(`http://127.0.0.1:${status.port}/mcp`, status.token, clientName);
    const opened = await session.tool("navigate", { url: `${server.base}agent` });
    const agentTab = idOf(opened.text);
    if (agentTab) agentTabs.push(agentTab);
    check("isolation: navigate without a tab of its own opens one, not the person's", !opened.isError && agentTab !== "" && agentTab !== personTab.id, opened.text.slice(0, 300));
    const snap = await session.tool("page_snapshot", { boxes: true, maxChars: 0 });
    check("isolation: calls without tabId work in the agent's tab", snap.text.includes("Agent work") && !snap.text.includes("My draft"), snap.text.slice(0, 300));
    const q = refOf(snap.text, '(?:textbox|searchbox) "Search"');
    const go = refOf(snap.text, 'button "Go"');
    const typedBox = centerOf(snap.text, 'textbox "Typed"');
    const results = {
      type: await session.tool("type", { ref: q, text: "umbrella" }),
      click: await session.tool("click", { ref: go }),
      clickAt: typedBox ? await session.tool("click_at", typedBox) : { isError: true, text: "no box for the Typed field" },
      typeText: await session.tool("type_text", { text: "hello" }),
      keys: await session.tool("press_keys", { keys: ["End"] }),
      drag: await session.tool("drag", { fromX: 60, fromY: 260, toX: 260, toY: 260, steps: 8 }),
      screenshot: await session.tool("screenshot", {}),
    };
    const failed = Object.entries(results).filter(([, r]) => r.isError);
    check("isolation: the agent's typing, clicks, keys, drag and screenshot work in its background tab", failed.length === 0, failed.map(([k, r]) => `${k}: ${r.text.slice(0, 200)}`));
    const agentWc = pageOf(win.getTab(agentTab)?.view);
    const page = agentWc
      ? ((await agentWc.executeJavaScript("({ q: document.getElementById('q').value, clicked: window.__clicked, typed: document.getElementById('typed').value, drag: window.__drag })")) as { q: string; clicked: boolean; typed: string; drag: string })
      : null;
    check("isolation: what the agent typed and clicked (real, trusted events) landed in its tab", page?.q === "umbrella" && page.clicked === true && page.typed === "hello", page);
    check("isolation: a drag in a background tab is made of real mouse events", page?.drag === "200:true", page?.drag);

    const front = win.activeTab()?.id === personTab.id;
    const mine = (await personWc.executeJavaScript("({ value: document.getElementById('mine').value, focused: document.activeElement && document.activeElement.id })")) as { value: string; focused: string };
    check("isolation: the person's tab stayed in front, with their text and caret", front && personWc.isFocused() && mine.value === "draft" && mine.focused === "mine", { front, keyboard: personWc.isFocused(), mine });
    const blurs = (await personWc.executeJavaScript("window.__blurs")) as number;
    check("isolation: the person's page never lost the keyboard while the agent's tab loaded and worked", blurs === 0, { blurs });
    await personWc.insertText(" more");
    const after = (await personWc.executeJavaScript("document.getElementById('mine').value")) as string;
    check("isolation: the person keeps typing in their tab while the agent works", after === "draft more", after);

    // Another app has the focus now: nothing the agent does brings Corvus back to the front.
    other = new BrowserWindow({ width: 320, height: 200, show: true, webPreferences: { sandbox: true } });
    await other.loadURL("about:blank");
    other.focus();
    const away = await until(() => other!.isFocused() && !win.win.isFocused(), 4000);
    check("isolation: another app took the focus", away, { other: other.isFocused(), corvus: win.win.isFocused() });
    let corvusFocused = 0;
    const onFocus = (): void => void corvusFocused++;
    win.win.on("focus", onFocus);
    const pulls = (["focus", "show", "restore", "moveTop"] as const).map((m) => ({ m, s: spy(win.win as BrowserWindow, m) }));
    const flash = spy(win.win as BrowserWindow, "flashFrame");
    spies.push(...pulls.map((p) => p.s), flash);
    const second = await session.tool("tab_open", { url: `${server.base}agent?second` });
    if (idOf(second.text)) agentTabs.push(idOf(second.text));
    const moved = await session.tool("navigate", { url: `${server.base}agent?moved` });
    const fresh = refOf((await session.tool("page_snapshot", { maxChars: 0 })).text, 'button "Go"');
    const clicked = await session.tool("click", { ref: fresh });
    const asked = ctx.dialogs.ask({ tone: "question", title: "Corvus", message: "Allow this?", buttons: ["Deny", "Allow"], defaultId: 0, cancelId: 0 }, win);
    await sleep(300);
    const flashed = flash.calls.some((c) => c[0] === true);
    const dialogId = ctx.dialogs.current(win)?.id;
    if (dialogId) ctx.dialogs.answer(win, dialogId, { button: 0 });
    await asked;
    const shown = await session.tool("tab_activate", { tabId: agentTab });
    await sleep(800);
    win.win.off("focus", onFocus);
    const pulled = pulls.filter((p) => p.s.calls.length > 0).map((p) => p.m);
    check(
      "isolation: in the background the agent opens, drives and shows tabs without bringing Corvus to the front",
      [second, moved, clicked, shown].every((r) => !r.isError) && win.activeTab()?.id === agentTab && corvusFocused === 0 && !win.win.isFocused() && other.isFocused() && pulled.length === 0,
      { errors: [second, moved, clicked, shown].filter((r) => r.isError).map((r) => r.text.slice(0, 200)), shown: win.activeTab()?.id === agentTab, corvusFocused, corvus: win.win.isFocused(), other: other.isFocused(), pulled },
    );
    check("isolation: a question asked in the background flashes the taskbar button instead", flashed && Boolean(dialogId), { flash: flash.calls, dialogId });
    for (const s of spies.splice(0)) s.undo();

    // Corvus started for an agent (the bridge's --enable-mcp): its window opens without taking the focus.
    const quiet = ctx.windows.open(win.profile.profile.id, [], { background: true });
    const quietFlash = spy(quiet.win as BrowserWindow, "flashFrame");
    const revealed = await until(() => quiet.win.isVisible() || quiet.win.isMinimized(), 6000);
    const quietAsk = ctx.dialogs.ask({ tone: "question", title: "Corvus", message: "Reopen?", buttons: ["No", "Yes"], defaultId: 0, cancelId: 0 }, quiet);
    await sleep(500);
    const quietDialog = ctx.dialogs.current(quiet)?.id;
    if (quietDialog) ctx.dialogs.answer(quiet, quietDialog, { button: 0 });
    await quietAsk;
    quietFlash.undo();
    check(
      "isolation: a window opened for an agent shows without taking the focus or flashing",
      revealed && !quiet.win.isFocused() && other.isFocused() && !quietFlash.calls.some((c) => c[0] === true),
      { revealed, minimized: quiet.win.isMinimized(), quiet: quiet.win.isFocused(), other: other.isFocused(), flash: quietFlash.calls },
    );
    quiet.close();

    // The person comes back: the keyboard goes to the tab on screen (shown while they were away).
    other.close();
    other = null;
    win.win.focus();
    await until(() => win.win.isFocused(), 4000);
    const shownWc = pageOf(win.getTab(agentTab)?.view);
    const keyboard = await until(() => shownWc?.isFocused() === true, 3000);
    check("isolation: back in Corvus, the keyboard is in the tab on screen", keyboard, { focused: win.win.isFocused(), page: shownWc?.isFocused() });
    await h.capture("agent-isolation", win.chrome.webContents);
  } catch (err) {
    check("isolation smoke", false, err instanceof Error ? err.stack : String(err));
  } finally {
    for (const s of spies) s.undo();
    if (other && !other.isDestroyed()) other.close();
    for (const id of agentTabs) if (win.hasTab(id) && win.tabIds().length > 1) win.closeTab(id);
    if (win.hasTab(personTab.id) && win.tabIds().length > 1) win.closeTab(personTab.id);
    await session?.close().catch(() => undefined);
    ctx.settings.update({ mcp: before });
    await ctx.mcp.apply();
    server.close();
  }
}
