import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { TabId } from "@corvus/shared";
import { isViewSourceUrl } from "../shared/view-source";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

// Counts the key presses that reach it, and lets them all through.
const SOURCE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Source smoke</title></head><body><p id="marker">view source marker</p>
<script>window.__keys = 0; addEventListener("keydown", () => window.__keys++);</script></body></html>`;
// An editor that takes Ctrl+U itself (underline), as Gmail's or Google Docs' do.
const EDITOR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Editor smoke</title></head><body>
<div id="ed" contenteditable="true">some text</div>
<script>window.__underlined = 0;
document.getElementById("ed").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyU") { e.preventDefault(); window.__underlined++; }
});</script></body></html>`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(80);
  }
  return false;
}

/** The person's Ctrl+U (Cmd+Option+U on macOS), as real key events. */
function pressViewSource(wc: WebContents): void {
  const modifiers: Array<"control" | "meta" | "alt"> = process.platform === "darwin" ? ["meta", "alt"] : ["control"];
  wc.sendInputEvent({ type: "keyDown", keyCode: "U", modifiers });
  wc.sendInputEvent({ type: "char", keyCode: "U", modifiers });
  wc.sendInputEvent({ type: "keyUp", keyCode: "U", modifiers });
}

/** Ctrl+U opens the page's source in a new tab next to it, unless the page uses the key; never for Corvus pages or agents. */
export async function runViewSourceSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(req.url === "/editor" ? EDITOR_PAGE : SOURCE_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const opened: TabId[] = [];
  const sourceTabs = (): string[] =>
    ctx.windows
      .all()
      .flatMap((w) => w.listTabs())
      .filter((t) => isViewSourceUrl(t.url))
      .map((t) => t.id);
  const tabOf = (id: TabId): TabRuntime | undefined => ctx.windows.findTab(id)?.tab;
  const loaded = (id: TabId): Promise<boolean> => until(() => tabOf(id)?.loading === false && tabOf(id)?.committed === true);
  // Input while an agent's call is under way counts as the agent's: wait for earlier checks' calls to end.
  const quiet = await until(() => !ctx.agents.acting(), 15_000);

  try {
    // ---------------------------------------------------------------- Ctrl+U on a page
    const page = win.createTab(`${base}/`);
    opened.push(page.id);
    await loaded(page.id);
    const before = sourceTabs();
    const fetched = hits.length;
    page.view.webContents.focus();
    pressViewSource(page.view.webContents);
    const added = (): string | undefined => sourceTabs().find((id) => !before.includes(id));
    await until(() => Boolean(added()));
    const sourceId = added();
    const source = sourceId ? win.getTab(sourceId) : undefined;
    if (sourceId) opened.push(sourceId);
    if (source) await loaded(source.id);
    const ids = win.tabIds();
    check("view source: Ctrl+U on a page opens its source in a new tab", source?.url === `view-source:${base}/`, { quiet, url: source?.url, tabs: win.listTabs().map((t) => t.url) });
    check("view source: the tab opens right after the page, in front", Boolean(sourceId) && ids.indexOf(sourceId!) === ids.indexOf(page.id) + 1 && win.activeTab()?.id === sourceId, { ids, active: win.activeTab()?.id });
    const wc = source?.view.webContents;
    check("view source: the page's source is fetched and shown", hits.length > fetched && Boolean(wc && isViewSourceUrl(wc.getURL()) && wc.getTitle().startsWith("view-source:")), {
      hits: hits.slice(fetched),
      url: wc?.getURL(),
      title: wc?.getTitle(),
    });
    await sleep(300);
    const omni = await win.chrome.webContents.executeJavaScript("document.querySelector('.omni-input')?.value ?? null").catch(() => null);
    check("view source: the address bar and tab show the view-source: address", typeof omni === "string" && omni.startsWith("view-source:") && source?.title.startsWith("view-source:") === true, { omni, title: source?.title });
    if (wc) await capture("view-source", wc);
    if (wc) await capture("view-source-chrome", win.chrome.webContents);

    // ---------------------------------------------------------------- not on a source view
    if (wc) {
      const count = sourceTabs().length;
      pressViewSource(wc);
      win.runCommand({ type: "view-source" });
      await sleep(1200);
      check("view source: nothing more from a source view", sourceTabs().length === count, sourceTabs());
    }

    // ---------------------------------------------------------------- AI agents cannot read it
    if (sourceId) {
      const read = await Promise.race([ctx.controller.snapshot(sourceId).then(() => "read", (err: Error) => err.message), sleep(5000).then(() => "timeout")]);
      check("view source: agents cannot read a source view", read !== "read" && read !== "timeout", read);
    }

    // ---------------------------------------------------------------- a page that uses the key
    const editor = win.createTab(`${base}/editor`);
    opened.push(editor.id);
    await loaded(editor.id);
    const ewc = editor.view.webContents;
    await ewc.executeJavaScript("document.getElementById('ed').focus()");
    ewc.focus();
    const count = sourceTabs().length;
    pressViewSource(ewc);
    await sleep(1200);
    const underlined = await ewc.executeJavaScript("window.__underlined").catch(() => null);
    check("view source: a page's editor keeps Ctrl+U (no source tab)", underlined === 1 && sourceTabs().length === count, { underlined, tabs: sourceTabs() });

    // ---------------------------------------------------------------- from the address bar
    const fromChromeBefore = sourceTabs();
    pressViewSource(win.chrome.webContents);
    await until(() => sourceTabs().some((id) => !fromChromeBefore.includes(id)));
    const fromChrome = sourceTabs().find((id) => !fromChromeBefore.includes(id));
    if (fromChrome) opened.push(fromChrome);
    const chromeIds = win.tabIds();
    check(
      "view source: Ctrl+U in the address bar shows the active page's source",
      Boolean(fromChrome) && win.getTab(fromChrome!)?.url === `view-source:${base}/editor` && chromeIds.indexOf(fromChrome!) === chromeIds.indexOf(editor.id) + 1,
      { url: fromChrome ? win.getTab(fromChrome)?.url : null },
    );

    // ---------------------------------------------------------------- not for Corvus pages
    const internal = win.createTab("corvus://newtab/");
    opened.push(internal.id);
    await loaded(internal.id);
    const internalCount = win.tabIds().length;
    internal.view.webContents.focus();
    pressViewSource(internal.view.webContents);
    win.runCommand({ type: "view-source" });
    await sleep(1200);
    check("view source: none for Corvus pages", win.tabIds().length === internalCount, win.listTabs().map((t) => t.url));

    // ---------------------------------------------------------------- not for agents
    const agentTab = await ctx.controller.openTab(`${base}/`, { background: true });
    opened.push(agentTab.id);
    await loaded(agentTab.id);
    const agentCount = sourceTabs().length;
    await ctx.controller.input(agentTab.id, { type: "keys", keys: ["Control+U"] });
    await sleep(1200);
    const agentOpen = await ctx.controller.openTab(`view-source:${base}/`).then(
      (t) => {
        opened.push(t.id);
        return t.url;
      },
      (err: Error) => `refused: ${err.message}`,
    );
    // The key reached the page, which let it through: only its being the agent's keeps the tab from opening.
    const reached = await tabOf(agentTab.id)?.view.webContents.executeJavaScript("window.__keys").catch(() => null);
    check("view source: an agent's Ctrl+U opens nothing and agents cannot open view-source:", typeof reached === "number" && reached >= 1 && sourceTabs().length === agentCount && agentOpen.startsWith("refused"), { reached, agentOpen, tabs: sourceTabs() });
  } catch (err) {
    check("view source smoke", false, (err as Error).stack ?? String(err));
  } finally {
    for (const id of opened) ctx.windows.findTab(id)?.window.closeTab(id);
    server.close();
  }
}
