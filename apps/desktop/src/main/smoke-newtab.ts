import type { WebContents, WebFrameMain } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface NewTabSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForJs(target: WebContents | WebFrameMain, expr: string, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await target.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

async function widgetFrame(wc: WebContents, id: string, timeoutMs = 8000): Promise<WebFrameMain | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const frame = wc.mainFrame.framesInSubtree.find((f) => f.url.startsWith(`corvus://newtab/widget/${id}`));
    if (frame) return frame;
    await sleep(120);
  }
  return null;
}

/**
 * The New Tab dashboard: today's page by default, customize mode, a widget an MCP agent builds
 * (sandboxed, fed only with its declared data), the private-address guard and backgrounds.
 */
export async function runNewTabSmoke(ctx: AppContext, h: NewTabSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const runtime = win.profile;
  ctx.newtab.reset(runtime);
  const tab = win.createTab("corvus://newtab/", { activate: true });
  const wc = tab.view.webContents;
  try {
    await waitForJs(wc, "document.querySelector('.nt-search')");
    const first = await wc.executeJavaScript("({ widgets: document.querySelectorAll('.nt-widget').length, hero: Boolean(document.querySelector('.nt-hero h1')), search: Boolean(document.querySelector('.nt-search input')) })");
    check("new tab: the default page is today's (greeting, search, shortcuts)", first.widgets === 3 && first.hero && first.search, first);

    // Customize mode, add a clock from the gallery; it is saved for the profile.
    await wc.executeJavaScript("document.querySelector('.nt-customize').click()");
    await waitForJs(wc, "document.querySelector('.newtab.editing')");
    await wc.executeJavaScript("[...document.querySelectorAll('.nt-dock button')].find((b) => b.textContent.trim() === 'Add widget').click()");
    await waitForJs(wc, "document.querySelector('.nt-gallery-item')");
    await wc.executeJavaScript("[...document.querySelectorAll('.nt-gallery-item')].find((b) => b.querySelector('strong').textContent.trim() === 'Clock').click()");
    const clock = await waitForJs(wc, "document.querySelector('.nt-clock .nt-clock-time')");
    await sleep(400);
    const saved = ctx.newtab.layout(runtime).widgets.some((w) => w.type === "clock");
    check("new tab: customize adds a clock and saves it", clock && saved, { clock, saved });
    await capture("newtab-editing", wc);

    // Drag the clock one column right with the mouse, then make it one column wider.
    const before = ctx.newtab.layout(runtime).widgets.find((w) => w.type === "clock")!;
    const drag = async (selector: string, dx: number): Promise<void> => {
      const at = (await wc.executeJavaScript(
        `(() => { const el = document.querySelector('[data-widget="${before.id}"] ${selector}'); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + Math.min(r.height / 2, 40)), pitch: (document.querySelector('.nt-grid').getBoundingClientRect().width + 16) / 12 }; })()`,
      )) as { x: number; y: number; pitch: number };
      wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
      wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
      for (let i = 1; i <= 4; i++) {
        wc.sendInputEvent({ type: "mouseMove", x: Math.round(at.x + (at.pitch * dx * i) / 4), y: at.y, button: "left" } as Electron.MouseInputEvent);
        await sleep(40);
      }
      wc.sendInputEvent({ type: "mouseUp", x: Math.round(at.x + at.pitch * dx), y: at.y, button: "left", clickCount: 1 });
      await sleep(500);
    };
    await drag(".nt-handle", 1);
    const moved = ctx.newtab.layout(runtime).widgets.find((w) => w.id === before.id)!;
    await drag(".nt-resize", 1);
    const resized = ctx.newtab.layout(runtime).widgets.find((w) => w.id === before.id)!;
    check(
      "new tab: widgets move and resize with the mouse, and the change is saved",
      moved.x === Math.min(before.x + 1, 12 - before.w) && resized.w === moved.w + 1,
      { before: [before.x, before.w], moved: [moved.x, moved.w], resized: [resized.x, resized.w] },
    );
    await wc.executeJavaScript("[...document.querySelectorAll('.nt-dock button')].find((b) => b.textContent.trim() === 'Done').click()");

    // An agent builds a widget over the MCP capability, fed with Corvus's own data.
    const res = JSON.parse(
      await ctx.controller.newtab!(
        {
          action: "custom",
          config: {
            title: "Smoke widget",
            html: '<div class="cw-value" id="out">waiting</div>',
            script: [
              "corvus.onData((d) => { out.textContent = 'sites:' + (Array.isArray(d.top) ? d.top.length : 'none') + ' local:' + (d.local && d.local.error ? 'blocked' : 'open'); });",
              "window.__probe = {};",
              "try { document.cookie; window.__probe.cookie = 'readable'; } catch (e) { window.__probe.cookie = 'blocked'; }",
              "try { window.__probe.top = String(top.location.href); } catch (e) { window.__probe.top = 'blocked'; }",
              "fetch('https://example.com/').then(() => { window.__probe.fetch = 'open'; }, () => { window.__probe.fetch = 'blocked'; });",
            ].join("\n"),
            sources: [
              { name: "top", kind: "corvus", url: "top-sites", everyMinutes: 5 },
              { name: "local", kind: "fetch", url: `${h.url}ux-plain`, everyMinutes: 5 },
            ],
          },
          w: 4,
          h: 3,
        },
        "corvus-smoke-agent",
      ),
    ) as { widgets: Array<{ id: string; type: string; config: { author?: string } }> };
    const made = res.widgets.find((w) => w.type === "custom");
    check("new tab: an agent's custom widget is saved with its author", made?.config.author === "corvus-smoke-agent", made);
    const frame = made ? await widgetFrame(wc, made.id) : null;
    const fed = frame ? await waitForJs(frame, "document.getElementById('out')?.textContent.startsWith('sites:')") : false;
    const shown = frame ? await frame.executeJavaScript("document.getElementById('out')?.textContent") : null;
    check("new tab: the widget gets its data, and a private address is refused", fed && typeof shown === "string" && shown.includes("local:blocked"), shown);
    await sleep(800);
    const probe = (frame ? await frame.executeJavaScript("window.__probe") : null) as { cookie?: string; top?: string; fetch?: string } | null;
    check("new tab: the widget runs sandboxed (no cookies, no parent page, no network)", probe?.cookie === "blocked" && probe?.top === "blocked" && probe?.fetch === "blocked", probe);
    await capture("newtab-widget", wc);

    // A background color applies to the page.
    ctx.newtab.save(runtime, { ...ctx.newtab.layout(runtime), background: { kind: "color", color: "#1e1b4b" } });
    const colored = await waitForJs(wc, "getComputedStyle(document.querySelector('.nt-bg-fill') || document.body).backgroundColor === 'rgb(30, 27, 75)'");
    check("new tab: a background color applies", colored);
    await capture("newtab-background", wc);
  } catch (err) {
    check("new tab smoke", false, err instanceof Error ? err.message : String(err));
  } finally {
    ctx.newtab.reset(runtime);
    win.closeTab(tab.id);
    await sleep(200);
  }
}
