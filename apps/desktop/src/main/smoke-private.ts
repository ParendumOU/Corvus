import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import { NEW_TAB_URL } from "../shared/internal-urls";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface PrivateSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(150);
  }
  return false;
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = fn();
    if (value) return value;
    await sleep(150);
  }
  return undefined;
}

/**
 * Private windows: cookies of their own (never the profile's), no history, no place in the saved
 * session or in what agents see, downloads listed but never saved, the badge and the New Tab note,
 * and everything gone once the last private window closes.
 */
export async function runPrivateSmoke(ctx: AppContext, h: PrivateSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const runtime = win.profile;
  const server = http.createServer((req, res) => {
    const route = (req.url ?? "/").split("?")[0];
    if (route === "/set") {
      res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "corvus_private=1; Path=/" }).end("<!doctype html><title>Private set</title><p id='c'></p><script>c.textContent=document.cookie</script>");
      return;
    }
    if (route === "/dl/private.dat") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="private-smoke.dat"' }).end("private download\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Cookie check</title><p id='c'></p><script>c.textContent=document.cookie || 'none'</script>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookieOf = async (wc: WebContents): Promise<string> => {
    await poll(wc, "document.getElementById('c')?.textContent");
    return String(await wc.executeJavaScript("document.getElementById('c').textContent").catch(() => ""));
  };
  let pw: BrowserWindowCtl | null = null;
  try {
    pw = ctx.windows.openPrivate(runtime.profile.id, [`${base}/set`]);
    const first = pw.activeTab()!;
    const set = await cookieOf(first.view.webContents);
    const inPrivate = pw.createTab(`${base}/private-check`);
    const privateCookie = await cookieOf(inPrivate.view.webContents);
    const normal = win.createTab(`${base}/check`, { activate: false });
    const normalCookie = await cookieOf(normal.view.webContents);
    win.closeTab(normal.id);
    check(
      "private window: its own in-memory session, cookies the profile never sees",
      pw.isPrivate &&
        first.view.webContents.session !== runtime.session &&
        runtime.isPrivateSession(first.view.webContents.session) &&
        set === "corvus_private=1" &&
        privateCookie === "corvus_private=1" &&
        normalCookie === "none",
      { set, privateCookie, normalCookie },
    );

    const tabs = await ctx.controller.listTabs();
    let reached = true;
    try {
      await ctx.controller.snapshot(inPrivate.id);
    } catch {
      reached = false;
    }
    const restored = ctx.sessionRestore.capture();
    check(
      "private window: no history, not in the saved session, out of agents' reach",
      !runtime.history.all().some((e) => e.url.startsWith(`${base}/set`) || e.url.startsWith(`${base}/private-check`)) &&
        !restored.windows.some((w) => w.tabs.some((t) => t.url.startsWith(`${base}/set`) || t.url.startsWith(`${base}/private-check`))) &&
        !tabs.some((t) => t.id === inPrivate.id || t.id === first.id) &&
        !reached,
      { history: runtime.history.all().slice(0, 3).map((e) => e.url), tabs: tabs.length, reached },
    );

    const badge = await poll(pw.chrome.webContents, "document.querySelector('.chrome-root.private-window [data-private-badge]')");
    const ntp = pw.createTab(NEW_TAB_URL);
    const note = await poll(ntp.view.webContents, "document.querySelector('[data-newtab-private]')");
    await sleep(300);
    await capture("private-window", pw.chrome.webContents);
    await capture("private-newtab", ntp.view.webContents);
    check("private window: the toolbar says Private and the New Tab page says what is kept", badge && note, { badge, note });

    // A download from a private window is listed, never written to downloads.json.
    const dir = ctx.downloads.directory();
    inPrivate.view.webContents.downloadURL(`${base}/dl/private.dat`);
    const record = await waitFor(() => ctx.downloads.list(runtime).find((d) => d.url.endsWith("/dl/private.dat") && d.state === "completed"), 10_000);
    ctx.downloads.flush();
    const saved = fs.readFileSync(path.join(runtime.dataDir, "downloads.json"), "utf8");
    check(
      "private window: its downloads are listed while it is open and never saved",
      record?.ephemeral === true && !saved.includes("/dl/private.dat") && fs.existsSync(record.savePath),
      { record, dir },
    );

    // The last private window closes: its cookies and downloads list go; a new one starts clean.
    pw.close();
    await waitFor(() => !ctx.windows.all().includes(pw!), 5000);
    await sleep(500);
    const listedAfter = ctx.downloads.list(runtime).some((d) => d.url.endsWith("/dl/private.dat"));
    pw = ctx.windows.openPrivate(runtime.profile.id, [`${base}/check`]);
    const fresh = await cookieOf(pw.activeTab()!.view.webContents);
    check("private window: closing the last one wipes its cookies and downloads list", fresh === "none" && !listedAfter, { fresh, listedAfter });
    if (record?.savePath) fs.rmSync(record.savePath, { force: true });
  } finally {
    pw?.close();
    server.close();
    win.activate(win.activeTab()?.id ?? "");
  }
}
