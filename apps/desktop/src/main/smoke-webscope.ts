import { WebScopeEngine } from "@corvus/webscope";
import { nativeTheme } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

type Check = (name: string, ok: boolean, detail?: unknown) => void;
type Capture = (name: string, wc: Electron.WebContents) => Promise<void>;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * WebScope end-to-end: enable capture, scope the local smoke host, capture a real request over CDP,
 * replay it from Node, run a small in-scope fuzz, then screenshot History/Repeater/Fuzzer light+dark.
 */
export async function runWebscopeSmoke(
  ctx: AppContext,
  { url, win, check, capture }: { url: string; win: BrowserWindowCtl; check: Check; capture: Capture },
): Promise<void> {
  const host = new URL(url).hostname;
  ctx.settings.update({ webscope: { enabled: true } });
  ctx.webscope.apply();
  const engine = ctx.webscope.engineFor(win.profile);
  engine.setScope({ enabled: true, include: [{ host, enabled: true }], exclude: [] });
  check("webscope enabled + scoped", ctx.webscope.activeEngine() === engine && engine.isInScope(url), { host });

  // Capture: open a blank tab so the debugger attaches, then load the in-scope page.
  const probe = win.createTab("about:blank");
  await delay(700);
  await probe.view.webContents.loadURL(`${url}webscope-probe`).catch(() => undefined);
  await delay(1500);
  const captured = engine.queryHistory({ host }, 50);
  check("webscope captured a request over CDP", captured.length > 0 && captured.some((h) => h.inScope), captured.slice(0, 3));

  // Repeater: replay an in-scope request from Node.
  const replay = await engine.repeaterSend({ method: "GET", url: `${url}webscope-replay`, headers: [] }).then(
    (e) => e,
    () => null,
  );
  check("webscope repeater replay", replay?.response?.status === 200, { status: replay?.response?.status, source: replay?.source });

  // Repeater refuses out-of-scope targets.
  const refused = await engine.repeaterSend({ method: "GET", url: "https://out-of-scope.example/", headers: [] }).then(
    () => false,
    () => true,
  );
  check("webscope repeater refuses out-of-scope", refused);

  // Fuzzer: small in-scope sniper attack with three payloads.
  const fuzz = await engine
    .fuzz({
      template: { method: "GET", url: `${url}item/§id§`, headers: [] },
      attack: "sniper",
      payloadSets: [{ kind: "wordlist", values: ["a", "b", "c"] }],
      concurrency: 2,
      requestsPerSecond: 10,
      grep: ["smoke page"],
    })
    .then(
      (r) => r,
      () => null,
    );
  check("webscope 3-payload in-scope fuzz", fuzz?.summary.completed === 3 && fuzz.summary.total === 3, fuzz?.summary);

  // Session: save with the captured traffic and open it in a fresh engine; its scope arrives disarmed.
  const saved = JSON.parse(JSON.stringify(engine.exportSession({ includeHistory: true }))) as { history?: unknown[] };
  const copy = new WebScopeEngine();
  const opened = await copy.importSession(saved).catch(() => null);
  check(
    "webscope session save and open",
    !!opened && opened.history === saved.history?.length && opened.history > 0 && copy.getScope().include.length === 1 && !copy.getScope().enabled,
    { opened, saved: saved.history?.length },
  );
  check("webscope fuzz grep + audit", Boolean(fuzz?.rows.some((r) => r.matched.includes("smoke page"))) && engine.auditLog().some((a) => a.action === "fuzz-finish"), {
    matched: fuzz?.rows.filter((r) => r.matched.length).length,
  });

  // Interactive intercept: hold an in-scope request, then forward it edited.
  await ctx.webscope.setInterceptConfig({ enabled: true, interceptRequests: true, interceptResponses: false });
  const interceptTab = win.createTab("about:blank");
  await delay(600);
  void interceptTab.view.webContents.loadURL(`${url}intercept-me`).catch(() => undefined);
  let queue = ctx.webscope.interceptState().queue;
  for (let i = 0; i < 50 && queue.length === 0; i++) {
    await delay(100);
    queue = ctx.webscope.interceptState().queue;
  }
  check("webscope held an in-scope request", queue.length > 0, queue[0] && { host: queue[0].host, path: queue[0].path, phase: queue[0].phase });
  const first = queue[0];
  if (first) {
    await ctx.webscope.interceptForward(first.id, { headers: [...first.request.headers, { name: "X-Corvus-Intercept", value: "1" }] });
    await delay(400);
  }
  check("webscope forwarded the held request", ctx.webscope.interceptState().queue.length === 0);
  await ctx.webscope.setInterceptConfig({ enabled: false, interceptRequests: true, interceptResponses: false });

  // UI: open the workbench and screenshot the main views in both themes.
  const page = win.createTab("corvus://webscope");
  const wc = page.view.webContents;
  await delay(1500);
  const ready = await wc.executeJavaScript("Boolean(window.corvusInternal && document.querySelector('.ws-root') && document.querySelector('.ws-tabs') && document.querySelector('.ws-scopestrip'))");
  check("corvus://webscope rendered", ready === true);

  const click = async (script: string): Promise<void> => {
    await wc.executeJavaScript(script);
    await delay(500);
  };
  // Switch tools by clicking the top tab whose label matches.
  const showView = (label: string): Promise<void> =>
    click(`(()=>{const b=[...document.querySelectorAll('.ws-tab')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(b)b.click();return !!b;})()`);

  const original = nativeTheme.themeSource;
  try {
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await delay(400);
      await showView("History");
      // Prefer the probe page (an HTML body, so the Pretty view has content); else the first row.
      await click(
        "(()=>{const rows=[...document.querySelectorAll('.ws-table tbody tr:not(.ws-spacer-row)')];const r=rows.find(x=>x.textContent.includes('/webscope-probe'))||rows[0];if(r)r.click();return !!r;})()",
      );
      await capture(`webscope-history-${theme}`, wc);
      await click("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Send to Repeater'));if(b)b.click();return !!b;})()");
      await capture(`webscope-repeater-${theme}`, wc);
      await showView("Fuzzer");
      await capture(`webscope-fuzzer-${theme}`, wc);
      await showView("Target");
      await capture(`webscope-target-${theme}`, wc);
      await showView("Findings");
      await capture(`webscope-findings-${theme}`, wc);
      for (const tool of ["Scope", "Rules", "Decoder", "Comparer"]) {
        await showView(tool);
        await capture(`webscope-${tool.toLowerCase()}-${theme}`, wc);
      }
      // The session panel opens under the command bar; close it again for the next screenshots.
      const toggleSession = "(()=>{const b=document.querySelector('.ws-topbtn');if(b)b.click();return !!b;})()";
      await click(toggleSession);
      if (theme === "light") check("webscope session panel opens", (await wc.executeJavaScript("Boolean(document.querySelector('.ws-session-panel'))")) === true);
      await capture(`webscope-session-${theme}`, wc);
      await click(toggleSession);
    }
    // Intercept view: hold a request so the queue + editor render, screenshot both themes, then release.
    await ctx.webscope.setInterceptConfig({ enabled: true, interceptRequests: true, interceptResponses: false });
    const shot = win.createTab("about:blank");
    await delay(500);
    void shot.view.webContents.loadURL(`${url}intercept-shot`).catch(() => undefined);
    let held = ctx.webscope.interceptState().queue;
    for (let i = 0; i < 40 && held.length === 0; i++) {
      await delay(100);
      held = ctx.webscope.interceptState().queue;
    }
    // The held load opened a new tab; bring WebScope back to the front so it renders (a background
    // tab does not run CSS transitions, which would freeze button colours mid theme switch).
    win.activate(page.id);
    await delay(400);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await delay(400);
      await showView("Intercept");
      await capture(`webscope-intercept-${theme}`, wc);
    }
    for (const q of ctx.webscope.interceptState().queue) await ctx.webscope.interceptForward(q.id, null);
    await ctx.webscope.setInterceptConfig({ enabled: false, interceptRequests: true, interceptResponses: false });
  } finally {
    nativeTheme.themeSource = original;
  }

  ctx.settings.update({ webscope: { enabled: false } });
  ctx.webscope.apply();
}
