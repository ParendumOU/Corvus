import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { app, type WebContents } from "electron";
import type { TabId } from "@corvus/shared";
import type { DownloadRecord } from "../shared/downloads";
import type { AppContext } from "./context";
import { windowShot } from "./smoke-cert-errors";
import { waitForInternalPage } from "./smoke-wait";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 8000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  return null;
}

const js = <T>(wc: WebContents | undefined, expr: string): Promise<T | null> =>
  !wc || wc.isDestroyed() ? Promise.resolve(null) : (wc.executeJavaScript(expr) as Promise<T>).catch(() => null);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Downloads smoke</title>
<style>body{font:16px sans-serif;margin:24px} a,button{display:block;margin:10px 0;font-size:16px}</style></head><body>
<h1>Downloads smoke</h1>
<a id="blank-zip" href="/f/archive.zip" target="_blank">archive.zip in a new tab</a>
<a id="blank-pdf" href="/f/report" target="_blank">report.pdf (attachment) in a new tab</a>
<button id="open-zip" onclick="window.open('/f/popup.zip')">window.open popup.zip</button>
<a id="same-zip" href="/f/same.zip">same.zip in this tab</a>
<a id="middle-zip" href="/f/middle.zip">middle.zip</a>
<a id="jar" href="/f/tool.jar">tool.jar</a>
<a id="blank-jar" href="/f/pepk.jar" target="_blank">pepk.jar in a new tab</a>
<a id="exe" href="/f/setup.exe">setup.exe</a>
</body></html>`;

const body = (name: string): string => `corvus downloads smoke: ${name}\n`;

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const route = (req.url ?? "/").split("?")[0] ?? "/";
  if (route.startsWith("/f/")) {
    const name = route === "/f/report" ? "report.pdf" : decodeURIComponent(route.slice(3));
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"` });
    res.end(body(name));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
}

/** A real click of the person's (input events, so Corvus sees their hand in it), on the tab on screen. */
async function personClick(wc: WebContents, selector: string, button: "left" | "middle" = "left"): Promise<boolean> {
  const point = await js<{ x: number; y: number }>(
    wc,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) } : null; })()`,
  );
  if (!point) return false;
  wc.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button, clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button, clickCount: 1 });
  return true;
}

async function loaded(tab: TabRuntime): Promise<boolean> {
  return (await waitFor(() => js<boolean>(tab.view.webContents, "document.readyState === 'complete' && Boolean(document.querySelector('h1'))"))) === true;
}

/**
 * Downloads end to end: links to files in new tabs, window.open and middle clicks leave no tab;
 * a download in a tab with a page leaves its address bar alone; programs the person downloads wait
 * with "Always keep", which learns but never trusts by itself; Settings lists the trusted types; AI
 * agents still never get programs (CORVUS_SMOKE_ONLY=downloads).
 */
export async function runDownloadsSmoke(ctx: AppContext, { win, check, capture }: Helpers): Promise<void> {
  const server = http.createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;
  const profile = win.profile;
  const chrome = win.chrome.webContents;
  const chromeHas = (selector: string): Promise<boolean> => js<boolean>(chrome, `Boolean(document.querySelector(${JSON.stringify(selector)}))`).then((v) => v === true);
  const settingsBefore = ctx.settings.get().downloads;
  const appearanceBefore = ctx.settings.get().appearance;
  const dir = path.join(app.getPath("userData"), "smoke-downloads-tabs");
  fs.rmSync(dir, { recursive: true, force: true });
  ctx.settings.update({ downloads: { directory: dir, askWhereToSave: false } });
  const opened: TabId[] = [];
  const recordOf = (url: string, from = 0): DownloadRecord | undefined => ctx.downloads.list(profile).find((d) => d.url === url && d.startedAt >= from);
  const finished = (url: string, from = 0): Promise<DownloadRecord | null> => waitFor(() => recordOf(url, from)?.state === "completed" && recordOf(url, from));
  const waiting = (url: string, from = 0): Promise<DownloadRecord | null> => waitFor(() => recordOf(url, from)?.state === "blocked" && recordOf(url, from));
  const tempFiles = (): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^Unconfirmed \d+\.crdownload$/.test(f)) : []);
  const leftover = (url: string): boolean => win.tabRuntimes().some((t) => t.url === url);
  const content = (record: DownloadRecord | null): string | null => (record?.savePath && fs.existsSync(record.savePath) ? fs.readFileSync(record.savePath, "utf8") : null);
  const shot = async (name: string): Promise<void> => windowShot(win, name, "downloads");

  try {
    // ------------------------------------------------------------------ no tab left behind
    const pageTab = win.createTab(`${base}/page`);
    opened.push(pageTab.id);
    const wc = pageTab.view.webContents;
    check("downloads smoke: the page loads", await loaded(pageTab));
    const tabCount = win.tabIds().length;
    const backToPage = (): Promise<boolean> => waitFor(() => win.tabIds().length === tabCount && win.activeTab()?.id === pageTab.id).then(Boolean);

    for (const [selector, file, label] of [
      ["#blank-zip", "archive.zip", "a link with target=_blank to a file (Content-Disposition: attachment)"],
      ["#blank-pdf", "report", "a link with target=_blank to a PDF sent as an attachment (application/octet-stream)"],
      ["#open-zip", "popup.zip", "window.open to a file"],
    ] as const) {
      win.activate(pageTab.id);
      await sleep(200);
      const clicked = await personClick(wc, selector);
      const record = await finished(`${base}/f/${file}`);
      const tidy = await backToPage();
      check(
        `downloads: ${label} downloads in the background, leaves no tab and keeps the page in front`,
        clicked && Boolean(record) && content(record) === body(file === "report" ? "report.pdf" : file) && tidy && !leftover(`${base}/f/${file}`),
        { clicked, record, tabs: win.listTabs().map((t) => t.url), active: win.activeTab()?.url },
      );
    }
    check("downloads: a tab that only held a download is not in Recently closed", !win.recentlyClosed().some((c) => c.url.includes("/f/")), win.recentlyClosed());

    win.activate(pageTab.id);
    await sleep(200);
    const middle = await personClick(wc, "#middle-zip", "middle");
    const middleRecord = await finished(`${base}/f/middle.zip`);
    check("downloads: a middle click on a link to a file leaves no background tab", middle && Boolean(middleRecord) && (await backToPage()) && !leftover(`${base}/f/middle.zip`), {
      middle,
      middleRecord,
      tabs: win.listTabs().map((t) => t.url),
    });

    win.openUrl(`${base}/f/menu.zip`, "new-tab");
    const menuRecord = await finished(`${base}/f/menu.zip`);
    check("downloads: Open link in new tab on a file closes that tab and shows the page again", Boolean(menuRecord) && (await backToPage()) && !leftover(`${base}/f/menu.zip`), {
      tabs: win.listTabs().map((t) => t.url),
    });

    const omni = (): Promise<string | null> => js<string>(chrome, "document.querySelector('.omni-input')?.value ?? null");
    win.activate(pageTab.id);
    await sleep(200);
    await personClick(wc, "#same-zip");
    const same = await finished(`${base}/f/same.zip`);
    await sleep(400);
    const sameOmni = await omni();
    check(
      "downloads: a link to a file in the same tab downloads and the page and its address stay",
      Boolean(same) && win.hasTab(pageTab.id) && pageTab.url === `${base}/page` && wc.getURL() === `${base}/page` && sameOmni !== null && sameOmni.includes("/page") && !sameOmni.includes("same.zip"),
      { url: pageTab.url, omni: sameOmni },
    );
    win.navigateInput(pageTab.id, `${base}/f/typed.zip`);
    const typed = await finished(`${base}/f/typed.zip`);
    const typedBack = await waitFor(() => pageTab.url === `${base}/page`);
    await sleep(300);
    const typedOmni = await omni();
    check("downloads: typing a file's address in a tab with a page puts its address back once the file downloads", Boolean(typed) && Boolean(typedBack) && typedOmni?.includes("typed.zip") === false, {
      url: pageTab.url,
      omni: typedOmni,
    });

    // ------------------------------------------------------------------ programs: warn, keep, learn
    win.activate(pageTab.id);
    await sleep(200);
    let from = Date.now();
    await personClick(wc, "#jar");
    const jar = await waiting(`${base}/f/tool.jar`, from);
    await sleep(600);
    check(
      "downloads: a program the person downloads waits under a temporary name with Keep, Discard and Always keep from this site",
      jar?.warning?.ext === "jar" &&
        jar.warning.site === "127.0.0.1" &&
        !jar.warning.ticked &&
        jar.warning.scope === "site" &&
        jar.warning.canRemember &&
        !jar.agent &&
        tempFiles().length === 1 &&
        !fs.existsSync(path.join(dir, "tool.jar")) &&
        (await chromeHas('.downloads-bubble [data-download-warning="jar"] [data-download-always]')) &&
        (await js<boolean>(chrome, "document.querySelector('[data-download-always]')?.checked === false")) === true,
      { jar, temp: tempFiles() },
    );
    await shot("downloads-warning-en-light");
    ctx.settings.update({ appearance: { theme: "dark" } });
    await sleep(500);
    await shot("downloads-warning-en-dark");
    ctx.settings.update({ appearance: { language: "es", theme: "light" } });
    chrome.reload();
    await waitFor(() => chromeHas(".omni-input"));
    win.sendCommand({ type: "open-downloads" });
    const spanish = await waitFor(() => js<string>(chrome, "document.querySelector('[data-download-warning]')?.innerText ?? ''"));
    check("downloads: the warning in Spanish", spanish?.includes("Conservar siempre los archivos .jar") === true, spanish);
    await shot("downloads-warning-es-light");
    ctx.settings.update({ appearance: { theme: "dark" } });
    await sleep(500);
    await shot("downloads-warning-es-dark");
    ctx.settings.update({ appearance: { language: "en", theme: "light" } });
    chrome.reload();
    await waitFor(() => chromeHas(".omni-input"));
    win.sendCommand({ type: "open-downloads" });
    await waitFor(() => chromeHas('.downloads-bubble [data-download-warning="jar"]'));

    // The person ticks "Always keep .jar files" (from this site, the default) and keeps it.
    await js(chrome, "document.querySelector('[data-download-always]').click()");
    await sleep(150);
    const scope = await js<string>(chrome, "document.querySelector('[data-download-scope]')?.value ?? ''");
    await js(chrome, "document.querySelector('[data-download-keep]').click()");
    const kept = jar ? await waitFor(() => ctx.downloads.list(profile).find((d) => d.id === jar.id && d.state === "completed")) : null;
    check(
      "downloads: Keep with Always keep from this site gives the file its name and trusts .jar from that site",
      scope === "site" &&
        kept?.savePath === path.join(dir, "tool.jar") &&
        content(kept) === body("tool.jar") &&
        tempFiles().length === 0 &&
        ctx.downloads.trustedTypes(profile).some((t) => t.ext === "jar" && t.site === "127.0.0.1"),
      { scope, kept, trusted: ctx.downloads.trustedTypes(profile) },
    );
    win.sendCommand({ type: "close-overlays" });

    from = Date.now();
    win.activate(pageTab.id);
    await sleep(200);
    await personClick(wc, "#blank-jar");
    const trusted = await finished(`${base}/f/pepk.jar`, from);
    check(
      "downloads: the next .jar from that site downloads without asking, and its tab closes",
      Boolean(trusted) && !trusted?.warning && content(trusted) === body("pepk.jar") && (await backToPage()),
      { trusted, tabs: win.listTabs().map((t) => t.url) },
    );

    const otherTab = win.createTab(`${other}/page`);
    opened.push(otherTab.id);
    await loaded(otherTab);
    await sleep(200);
    from = Date.now();
    await personClick(otherTab.view.webContents, "#jar");
    const elsewhere = await waiting(`${other}/f/tool.jar`, from);
    check("downloads: a .jar from another site still asks", elsewhere?.warning?.site === "localhost" && !elsewhere.warning.ticked, elsewhere);
    if (elsewhere) ctx.downloads.keep(profile, elsewhere.id, null);
    const keptElsewhere = await finished(`${other}/f/tool.jar`, from);
    check("downloads: Keep without Always keep keeps that file only", Boolean(keptElsewhere) && !ctx.downloads.trustedTypes(profile).some((t) => t.ext === "jar" && t.site !== "127.0.0.1"), {
      keptElsewhere,
      trusted: ctx.downloads.trustedTypes(profile),
    });

    win.activate(otherTab.id);
    await sleep(200);
    from = Date.now();
    await personClick(otherTab.view.webContents, "#jar");
    const third = await waiting(`${other}/f/tool.jar`, from);
    await waitFor(() => chromeHas('.downloads-bubble [data-download-warning="jar"]'));
    await sleep(300);
    const ticked = await js<boolean>(chrome, "document.querySelector('[data-download-always]')?.checked === true");
    const thirdScope = await js<string>(chrome, "document.querySelector('[data-download-scope]')?.value ?? ''");
    check(
      "downloads: after two keeps of .jar the next warning comes with Always keep ticked (from any site: kept from two sites), still waiting for Keep",
      third?.warning?.ticked === true && third.warning.scope === "any" && ticked === true && thirdScope === "any" && third.state === "blocked",
      { third, ticked, thirdScope },
    );
    await shot("downloads-warning-preticked-en-light");
    await js(chrome, "document.querySelector('[data-download-discard]').click()");
    const discarded = third ? await waitFor(() => !ctx.downloads.list(profile).some((d) => d.id === third.id) && tempFiles().length === 0) : null;
    check("downloads: Discard removes the waiting program and its temporary file", Boolean(discarded), { temp: tempFiles() });
    win.sendCommand({ type: "close-overlays" });

    // ------------------------------------------------------------------ Settings > Downloads
    const settingsTab = win.createTab("corvus://settings/#downloads");
    opened.push(settingsTab.id);
    const swc = settingsTab.view.webContents;
    const listed = await waitForInternalPage(swc, '[data-trusted-type="jar|127.0.0.1"]');
    const kinds = await js<number>(swc, "document.querySelectorAll('[data-warned-types] li').length");
    check("downloads: Settings lists the trusted type and the kinds of files Corvus warns about", listed.ok && kinds === 6, { kinds, ...(listed.ok ? {} : listed.detail) });
    // After the page has scrolled to #downloads by itself.
    const showTrusted = async (): Promise<void> => {
      await sleep(800);
      await js(swc, "document.querySelector('[data-warned-types]')?.scrollIntoView({ block: 'end' })");
      await sleep(400);
    };
    await showTrusted();
    await capture("downloads/settings-trusted-types-en-light", swc);
    await js(
      swc,
      `(() => {
        const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
        const [ext, site] = document.querySelectorAll("[data-trusted-type-new] input");
        set(ext, ".EXE");
        set(site, "");
      })()`,
    );
    await sleep(150);
    await js(swc, "document.querySelector('[data-trusted-type-new] button').click()");
    const added = await waitFor(() => js<boolean>(swc, `Boolean(document.querySelector('[data-trusted-type="exe|"]'))`));
    check("downloads: Settings adds a trusted type (from any site)", added === true && ctx.downloads.trustedTypes(profile).some((t) => t.ext === "exe" && t.site === ""), ctx.downloads.trustedTypes(profile));
    for (const [language, theme] of [
      ["en", "dark"],
      ["es", "light"],
      ["es", "dark"],
    ] as const) {
      ctx.settings.update({ appearance: { language, theme } });
      swc.reload();
      await waitForInternalPage(swc, "[data-trusted-types]");
      await showTrusted();
      await capture(`downloads/settings-trusted-types-${language}-${theme}`, swc);
    }
    ctx.settings.update({ appearance: { language: "en", theme: "light" } });
    swc.reload();
    await waitForInternalPage(swc, '[data-trusted-type="jar|127.0.0.1"]');
    await js(swc, `document.querySelector('[data-trusted-type="jar|127.0.0.1"] button').click()`);
    const removed = await waitFor(() => js<boolean>(swc, `!document.querySelector('[data-trusted-type="jar|127.0.0.1"]')`));
    check("downloads: Remove takes a trusted type off the list", removed === true && !ctx.downloads.trustedTypes(profile).some((t) => t.ext === "jar"), ctx.downloads.trustedTypes(profile));
    win.closeTab(settingsTab.id);

    // ------------------------------------------------------------------ AI agents
    const c = ctx.controller;
    const agentTab = await c.openTab(`${base}/page`);
    opened.push(agentTab.id);
    const group = await c.createGroup([agentTab.id], { title: "Agent downloads", color: "blue" });
    const groupSize = (): number => win.listTabs().filter((t) => t.groupId === group.id).length;
    const refused = await c.download(agentTab.id, `${base}/f/setup.exe`).then(
      () => false,
      (e: unknown) => /executable/i.test(String(e)),
    );
    check("downloads: the agent's download tool still refuses a program even when .exe is trusted from any site", refused);

    const snap = await c.snapshot(agentTab.id, { maxChars: 4000 });
    const exeLink = snap.elements.find((e) => e.role === "link" && e.name === "setup.exe");
    from = Date.now();
    if (exeLink) await c.click(agentTab.id, exeLink.ref);
    const held = await waiting(`${base}/f/setup.exe`, from);
    check(
      "downloads: a program the agent's own click downloads is held for the person, whatever types they trust",
      Boolean(exeLink) && held?.agent === true && !held.warning && !fs.existsSync(path.join(dir, "setup.exe")) && tempFiles().length === 0,
      { held, exeLink: Boolean(exeLink) },
    );
    if (held) ctx.downloads.act(profile, held.id, "discard");

    const agentRuntime = win.getTab(agentTab.id);
    const agentWc = agentRuntime?.view.webContents;
    // The person's own click, a while after the agent's last action (its input lands right after it acts).
    await sleep(2300);
    win.activate(agentTab.id);
    await sleep(200);
    from = Date.now();
    const agentClick = agentWc ? await personClick(agentWc, "#blank-zip") : false;
    const personZip = await finished(`${base}/f/archive.zip`, from);
    await sleep(300);
    check(
      "downloads: the person's click on a file link in an AI agent's tab group downloads it as theirs and leaves no tab in the group",
      agentClick && personZip?.agent === false && groupSize() === 1 && win.activeTab()?.id === agentTab.id && !leftover(`${base}/f/archive.zip`),
      { personZip, groupSize: groupSize(), tabs: win.listTabs().map((t) => ({ url: t.url, group: t.groupId })) },
    );
    from = Date.now();
    if (agentWc) await personClick(agentWc, "#jar");
    const personJar = await waiting(`${base}/f/tool.jar`, from);
    check("downloads: a program the person clicks in an agent's tab gets the person's warning, with Always keep", personJar?.agent === false && personJar.warning?.canRemember === true, personJar);
    if (personJar) ctx.downloads.act(profile, personJar.id, "discard");

    const before = win.tabIds().length;
    const openFile = await c.openTab(`${base}/f/agent.zip`, { groupId: group.id }).then(
      () => "opened",
      (e: unknown) => String(e),
    );
    const agentZip = await finished(`${base}/f/agent.zip`);
    check(
      "downloads: an agent opening a file's address gets an error, the file downloads and the group keeps no empty tab",
      /is a file, not a page/.test(openFile) && Boolean(agentZip) && win.tabIds().length === before && groupSize() === 1,
      { openFile, agentZip, groupSize: groupSize() },
    );
    await c.ungroup([agentTab.id]);

    // ------------------------------------------------------------------ private windows learn nothing
    const pw = ctx.windows.openPrivate(profile.profile.id, [`${base}/page`]);
    try {
      const privTab = pw.activeTab();
      if (privTab) await loaded(privTab);
      from = Date.now();
      privTab?.view.webContents.downloadURL(`${base}/f/private.jar`);
      const priv = await waiting(`${base}/f/private.jar`, from);
      await sleep(500);
      const offered = await js<boolean>(pw.chrome.webContents, "Boolean(document.querySelector('[data-download-always]'))");
      if (priv) ctx.downloads.keep(profile, priv.id, "any");
      const privKept = await finished(`${base}/f/private.jar`, from);
      check(
        "downloads: in a private window the warning has no Always keep, and keeping remembers nothing",
        priv?.warning?.canRemember === false && offered === false && Boolean(privKept) && !ctx.downloads.trustedTypes(profile).some((t) => t.ext === "jar"),
        { priv, offered, trusted: ctx.downloads.trustedTypes(profile) },
      );
    } finally {
      pw.close();
    }
  } catch (err) {
    check("downloads smoke ran", false, (err as Error).stack ?? String(err));
  } finally {
    for (const t of ctx.downloads.trustedTypes(profile)) ctx.downloads.removeTrustedType(profile, t.ext, t.site);
    ctx.settings.update({ downloads: { directory: settingsBefore.directory, askWhereToSave: settingsBefore.askWhereToSave }, appearance: { language: appearanceBefore.language, theme: appearanceBefore.theme } });
    win.sendCommand({ type: "close-overlays" });
    for (const id of opened) if (win.hasTab(id)) win.closeTab(id);
    server.close();
  }
}
