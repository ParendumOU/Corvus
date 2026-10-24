import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, type WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface DefaultBrowserSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 8000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = fn();
    if (value) return value;
    await sleep(150);
  }
  return undefined;
}

/**
 * Corvus as the default browser: web files and links handed over by the system (a second launch
 * with them on its command line) open in tabs, PDFs in Corvus's viewer, and nothing after "--" is
 * taken for a switch; the once-per-launch "not your default browser" bar and its buttons; and the
 * Settings section. The system side (registry, xdg-settings) is answered by a test hook.
 */
export async function runDefaultBrowserSmoke(ctx: AppContext, h: DefaultBrowserSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-open-"));
  const askBefore = ctx.settings.get().startup.askDefaultBrowser;
  const opened: string[] = [];
  try {
    // ------------------------------------------------------------------ files from the system
    fs.writeFileSync(path.join(dir, "page.html"), "<!doctype html><title>Opened file</title><h1>Opened from the file manager</h1>");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a web file");
    fs.writeFileSync(path.join(dir, "archive.rar"), "Rar!");
    const pdf = path.join(dir, "doc.pdf");
    fs.writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");
    const tabsBefore = new Set(ctx.windows.all().flatMap((w) => w.listTabs().map((t) => t.id)));
    app.emit("second-instance", {}, [process.execPath, "--", "page.html", "notes.txt", "archive.rar", pdf, "--gpu-launcher=calc"], dir);
    const fresh = await waitFor(() => {
      const tabs = ctx.windows.all().flatMap((w) => w.listTabs()).filter((t) => !tabsBefore.has(t.id));
      return tabs.length >= 2 ? tabs : undefined;
    });
    await sleep(600);
    const urls = ctx.windows
      .all()
      .flatMap((w) => w.listTabs())
      .filter((t) => !tabsBefore.has(t.id))
      .map((t) => t.url);
    opened.push(...ctx.windows.all().flatMap((w) => w.listTabs()).filter((t) => !tabsBefore.has(t.id)).map((t) => t.id));
    check(
      "default browser: web files from a second launch open in tabs, PDFs in the viewer, other files and switches are ignored",
      fresh !== undefined &&
        urls.length === 2 &&
        urls.includes(pathToFileURL(path.join(dir, "page.html")).href) &&
        urls.some((u) => u.startsWith("corvus://pdf/") && decodeURIComponent(u).includes(pathToFileURL(pdf).href)),
      urls,
    );

    // ------------------------------------------------------------------ the once-per-launch bar
    const chrome = win.chrome.webContents;
    let makes = 0;
    ctx.settings.update({ startup: { askDefaultBrowser: true } });
    ctx.defaultBrowser.setTest({ supported: true, isDefault: false, platform: process.platform }, () => {
      makes++;
      return "default";
    });
    await ctx.defaultBrowser.startup(win);
    const shown = await poll(chrome, "document.querySelector('[data-default-browser-bar]') !== null");
    await capture("default-browser-bar", chrome);
    await chrome.executeJavaScript("document.querySelector('[data-default-browser=\"make\"]')?.click()");
    const gone = await poll(chrome, "document.querySelector('[data-default-browser-bar]') === null");
    await ctx.defaultBrowser.startup(win);
    await sleep(300);
    const onceOnly = !ctx.defaultBrowser.offerFor(win);
    check("default browser: the bar shows once per launch and Make default asks the system", shown && gone && makes === 1 && onceOnly, { shown, gone, makes, onceOnly });

    ctx.defaultBrowser.setTest({ supported: true, isDefault: false, platform: process.platform }, () => "default");
    await ctx.defaultBrowser.startup(win);
    await poll(chrome, "document.querySelector('[data-default-browser-bar]') !== null");
    await chrome.executeJavaScript("document.querySelector('[data-default-browser=\"never\"]')?.click()");
    const stopped = await waitFor(() => ctx.settings.get().startup.askDefaultBrowser === false);
    ctx.defaultBrowser.setTest({ supported: true, isDefault: false, platform: process.platform }, () => "default");
    await ctx.defaultBrowser.startup(win);
    check("default browser: Don't ask again turns the question off", stopped === true && !ctx.defaultBrowser.offerFor(win));

    ctx.settings.update({ startup: { askDefaultBrowser: true } });
    ctx.defaultBrowser.setTest({ supported: true, isDefault: true, platform: process.platform });
    await ctx.defaultBrowser.startup(win);
    check("default browser: nothing is asked once Corvus is the default", !ctx.defaultBrowser.offerFor(win));

    // ------------------------------------------------------------------ Settings
    ctx.defaultBrowser.setTest({ supported: true, isDefault: false, platform: process.platform }, () => "default");
    const settings = win.createTab("corvus://settings/#default-browser");
    opened.push(settings.id);
    const swc = settings.view.webContents;
    const listed = await poll(swc, "(document.querySelector('#default-browser')?.innerText ?? '').includes('Corvus is not your default browser.') && document.querySelector('[data-make-default]') !== null");
    await swc.executeJavaScript("document.querySelector('[data-make-default]')?.click()");
    const told = await poll(swc, "(document.querySelector('#default-browser')?.innerText ?? '').includes('Corvus is now your default browser.')");
    await capture("default-browser-settings", swc);
    check("default browser: Settings shows the status and Make default", listed && told, { listed, told });
  } finally {
    ctx.defaultBrowser.setTest(null);
    ctx.settings.update({ startup: { askDefaultBrowser: askBefore } });
    for (const id of opened) for (const w of ctx.windows.all()) if (w.getTab(id)) w.closeTab(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
