import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import { windowShot } from "./smoke-cert-errors";
import { pageOf } from "./tab-page";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

/** The site of these checks: 127.0.0.1 on this port counts as a public address (index.ts), like a government portal. */
const PUBLIC_PORT = 47851;
const SITE = `http://127.0.0.1:${PUBLIC_PORT}`;
const SHOTS = "external-apps";
const REALM = "Smoke panel";
/** Fake credentials of the sign-in pages. */
const USER = "alice";
const PASS = "fake-pass-1";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Screenshots (the focused run, CORVUS_SMOKE_ONLY=externalapps, takes them in both languages and themes). */
let shots = false;
const shot = (win: BrowserWindowCtl, name: string): Promise<void> => (shots ? windowShot(win, name, SHOTS) : Promise.resolve());
const js = <T>(wc: WebContents, expr: string): Promise<T | null> => (wc.executeJavaScript(expr) as Promise<T>).catch(() => null);

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(100);
  }
  return false;
}

const APPS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Portal</title></head>
<body style="font-family:sans-serif;padding:24px"><h1>Sede electrónica</h1>
<p><a id="afirma" href="afirma://sign?op=sign&id=smoke">Firmar con Autofirma</a></p>
<p><a id="zoom" target="_blank" href="zoommtg://zoom.us/join?confno=1">Join the meeting</a></p>
<p><a id="unknown" href="nobody-handles-this://x">Unknown app</a></p>
<script>function launch(url) { location.href = url; }</script></body></html>`;

/** An Autofirma-like page: "Firmar" opens afirma:// with a port, then talks to the app on 127.0.0.1 over HTTP and a WebSocket. */
const AUTOFIRMA_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Firma</title></head>
<body style="font-family:sans-serif;padding:24px"><h1>Firma del documento</h1><button id="sign">Firmar</button><p id="status">idle</p>
<script>
const port = new URLSearchParams(location.search).get("port");
const status = (text) => (document.getElementById("status").textContent = text);
document.getElementById("sign").onclick = () => {
  location.href = "afirma://websocket?v=4&ports=" + port + "&idsession=smoke123";
  const started = Date.now();
  const poll = async () => {
    try {
      const reply = await (await fetch("http://127.0.0.1:" + port + "/afirma?idsession=smoke123")).text();
      const ws = new WebSocket("ws://127.0.0.1:" + port + "/");
      ws.onmessage = (e) => status("signed:" + reply + ":" + e.data);
      ws.onerror = () => status("ws-error");
    } catch {
      if (Date.now() - started < 15000) setTimeout(poll, 300);
      else status("timeout");
    }
  };
  status("waiting");
  poll();
};
</script></body></html>`;

function authorized(req: http.IncomingMessage): boolean {
  return req.headers.authorization === `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
}

function servePublic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", SITE);
  if (url.pathname.startsWith("/auth")) {
    if (!authorized(req)) {
      res.writeHead(401, { "WWW-Authenticate": `Basic realm="${REALM}"`, "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><title>401</title><p id='s'>denied</p>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Panel</title><p id='s'>signed in to ${url.pathname}</p>`);
    return;
  }
  const page = url.pathname === "/autofirma" ? AUTOFIRMA_PAGE : url.pathname === "/frame-host" ? `<!doctype html><title>Host</title><iframe id="f" src="http://localhost:${PUBLIC_PORT}/auth/frame"></iframe>` : APPS_PAGE;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
}

/** A stand-in for Autofirma's local server: an HTTP answer and a WebSocket that says OK. */
function autofirmaStub(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const id = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("idsession") ?? "";
    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" }).end(`OK-${id}`);
  });
  server.on("upgrade", (req, socket: Socket) => {
    const accept = crypto.createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, 2]), Buffer.from("WS")]));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * The system's side, as on a Linux desktop with Autofirma and Zoom installed: smoke.sh registers
 * them for afirma: and zoommtg: (test/fixtures/xdg, found through GIO), and an xdg-open first on
 * the PATH writes the links Corvus hands it to a log. Corvus's real lookups and
 * shell.openExternal run against them.
 */
function fakeXdg(): { opened: () => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-xdg-"));
  const log = path.join(dir, "opened.log");
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(dir, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  return { opened: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

const chromeJs = <T>(win: BrowserWindowCtl, expr: string): Promise<T | null> => js<T>(win.chrome.webContents, expr);
const DIALOG = `(() => { const c = document.querySelector('.dialog-card'); return c ? { title: c.querySelector('h2')?.textContent ?? '', text: c.innerText, check: Boolean(c.querySelector('.dialog-check input')), fields: c.querySelectorAll('[data-dialog-field]').length, secret: c.querySelector('[data-dialog-field="1"]')?.type ?? '', choices: c.querySelectorAll('[data-dialog-choice]').length, buttons: [...c.querySelectorAll('[data-dialog-button]')].map((b) => b.textContent) } : null; })()`;
interface DialogDom {
  title: string;
  text: string;
  check: boolean;
  fields: number;
  secret: string;
  choices: number;
  buttons: string[];
}
const dialogDom = (win: BrowserWindowCtl): Promise<DialogDom | null> => chromeJs<DialogDom>(win, DIALOG);
const pressButton = (win: BrowserWindowCtl, i: number): Promise<unknown> => chromeJs(win, `document.querySelector('.dialog-card [data-dialog-button="${i}"]')?.click(); true`);
const barText = (win: BrowserWindowCtl): Promise<string | null> => chromeJs<string>(win, "[...document.querySelectorAll('.dialog-bar')].map((b) => b.innerText).join('\\n')");

/** Types into a field of the open dialog as a person would (React sees an input event). */
function typeField(win: BrowserWindowCtl, i: number, text: string): Promise<unknown> {
  return chromeJs(
    win,
    `(() => { const el = document.querySelector('.dialog-card [data-dialog-field="${i}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
}

/** A real click (the person's gesture) in the middle of a page element. */
async function clickIn(wc: WebContents, selector: string): Promise<boolean> {
  const point = await js<{ x: number; y: number }>(wc, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
  if (!point) return false;
  wc.focus();
  wc.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  wc.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  return true;
}

async function loaded(tab: TabRuntime, selector = "body"): Promise<WebContents | null> {
  const ok = await until(async () => {
    const wc = pageOf(tab.view);
    return Boolean(wc && !wc.isLoading() && (await js<boolean>(wc, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)));
  }, 10_000);
  return ok ? pageOf(tab.view) : null;
}

async function setLook(ctx: AppContext, win: BrowserWindowCtl, language: "en" | "es", theme: "light" | "dark"): Promise<void> {
  ctx.settings.update({ appearance: { language, theme } });
  win.chrome.webContents.reload();
  await until(async () => (await chromeJs<boolean>(win, "Boolean(document.querySelector('.omni-input'))")) === true);
  await sleep(300);
}

/**
 * Links to other apps, the HTTP sign-in dialog and the local network access permission
 * (CORVUS_SMOKE_ONLY=externalapps runs only these), with an Autofirma-like flow end to end.
 */
export async function runExternalAppsSmoke(ctx: AppContext, { win, check, capture }: Helpers, looks: boolean): Promise<void> {
  shots = looks;
  const server = http.createServer(servePublic);
  await new Promise<void>((resolve) => server.listen(PUBLIC_PORT, "127.0.0.1", resolve));
  const xdg = fakeXdg();
  const { theme: themeBefore, language: languageBefore } = ctx.settings.get().appearance;
  const tabs: TabRuntime[] = [];
  const open = (url: string, activate = true): TabRuntime => {
    const tab = win.createTab(url, { activate });
    tabs.push(tab);
    return tab;
  };
  let stub: http.Server | null = null;
  try {
    await setLook(ctx, win, "en", "light");
    await externalAppChecks(ctx, win, check, capture, open, xdg, looks);
    stub = await autofirmaChecks(win, check, open, xdg);
    await signInChecks(ctx, win, check, open, looks);
    await localNetworkChecks(ctx, win, check, open, looks);
  } catch (err) {
    check("external apps: unexpected error", false, (err as Error).stack ?? String(err));
  } finally {
    for (const tab of tabs) if (win.hasTab(tab.id)) win.closeTab(tab.id);
    stub?.close();
    server.close();
    await setLook(ctx, win, languageBefore === "es" ? "es" : "en", themeBefore === "dark" ? "dark" : "light");
    ctx.settings.update({ appearance: { theme: themeBefore, language: languageBefore } });
  }
}

async function externalAppChecks(
  ctx: AppContext,
  win: BrowserWindowCtl,
  check: Helpers["check"],
  capture: Helpers["capture"],
  open: (url: string, activate?: boolean) => TabRuntime,
  xdg: { opened: () => string[] },
  looks: boolean,
): Promise<void> {
  const settings = win.profile.siteSettings;
  const app = await ctx.externalApps.system.appFor("afirma://x");
  const zoom = await ctx.externalApps.system.appFor("zoommtg://x");
  const none = await ctx.externalApps.system.appFor("nobody-handles-this://x");
  check("external apps: the app's name comes from the system's registered handler", app.name === "Autofirma" && zoom.name === "Zoom" && none.name === "", { app, zoom, none });

  const tab = open(`${SITE}/apps`);
  const wc = await loaded(tab, "#afirma");
  if (!wc) return check("external apps: the portal page loads", false);

  // The person opened the page from Corvus: it may ask once. Cancel opens nothing.
  await js(wc, "launch('afirma://sign?op=first'); true");
  const asked = await until(async () => (await dialogDom(win))?.title === "Open Autofirma?");
  const dom = await dialogDom(win);
  check(
    "external apps: a link to another app asks \"Open Autofirma?\", names the site, offers \"Always allow\" and an Open Autofirma button",
    asked && dom!.text.includes(`${SITE} wants to open this application.`) && dom!.check && dom!.text.includes(`Always allow ${SITE} to open links of this type in the associated app`) && dom!.buttons.join("|") === "Cancel|Open Autofirma",
    dom,
  );
  await shot(win, "open-app-en-light");
  await pressButton(win, 0);
  await sleep(400);
  check("external apps: Cancel opens nothing", (await dialogDom(win)) === null && xdg.opened().length === 0, xdg.opened());

  // Again with nothing done in the page: blocked, with a quiet bar (no modal).
  await js(wc, "launch('afirma://sign?op=again'); true");
  const barred = await until(async () => (await barText(win))?.includes("from opening an app by itself") === true);
  check("external apps: a second launch with no click in between is blocked with a quiet bar, not a dialog", barred && win.state().dialog === null && xdg.opened().length === 0, { bar: await barText(win), dialog: win.state().dialog?.title });
  await shot(win, "open-app-blocked-bar-en-light");
  await js(wc, "launch('afirma://sign?op=flood'); launch('afirma://sign?op=flood2'); true");
  await sleep(500);
  check("external apps: more launches without a click show no more bars or dialogs", win.state().dialogBars.length === 1 && win.state().dialog === null, win.state().dialogBars.map((b) => b.message));
  await chromeJs(win, "document.querySelector('.dialog-bar [data-dialog-button=\"0\"]')?.click(); true");
  await until(() => win.state().dialogBars.length === 0, 3000);

  // A real click on the link: asked again; "Always allow" + Open opens it, escaped as Chromium does.
  await clickIn(wc, "#afirma");
  await until(async () => (await dialogDom(win))?.title === "Open Autofirma?");
  await chromeJs(win, "document.querySelector('.dialog-card .dialog-check input')?.click(); true");
  await sleep(150);
  await pressButton(win, 1);
  const openedOnce = await until(() => xdg.opened().length === 1);
  check(
    "external apps: after a click, Open with \"Always allow\" opens the link with the system's app and remembers the site and scheme",
    openedOnce && xdg.opened()[0] === "afirma://sign?op=sign&id=smoke" && settings.externalAppAllowed(SITE, "afirma") && !settings.externalAppAllowed(SITE, "zoommtg"),
    { opened: xdg.opened(), allowed: settings.listPermissions() },
  );

  // Remembered: the next click opens it at once, no dialog.
  await clickIn(wc, "#afirma");
  const direct = await until(() => xdg.opened().length === 2, 4000);
  check("external apps: a remembered site opens its app on a click without asking", direct && win.state().dialog === null, xdg.opened());

  // A link with target=_blank opens no tab: it asks for Zoom, by its name.
  const tabCount = win.listTabs().length;
  await clickIn(wc, "#zoom");
  const zoomAsked = await until(async () => (await dialogDom(win))?.title === "Open Zoom?");
  check("external apps: a target=_blank link to an app asks \"Open Zoom?\" and opens no new tab", zoomAsked && win.listTabs().length === tabCount, { tabs: win.listTabs().length, tabCount });
  await pressButton(win, 0);
  await sleep(300);

  // An app nobody registered: named by its scheme.
  await clickIn(wc, "#unknown");
  const unknownAsked = await until(async () => (await dialogDom(win))?.title === "Open this nobody-handles-this: link?");
  check("external apps: without a registered app the question names the kind of link", unknownAsked && (await dialogDom(win))?.buttons.join("|") === "Cancel|Open link", await dialogDom(win));
  await pressButton(win, 0);
  await sleep(300);

  // A tab in the background asks with a bar and is not brought to the front; the bar's button does that.
  const active = win.activeTab()?.id;
  const background = open(`${SITE}/apps?background`, false);
  const bwc = await loaded(background, "#afirma");
  if (bwc) await js(bwc, "launch('zoommtg://zoom.us/join?confno=2'); true");
  const bar = await until(async () => (await barText(win))?.includes(`${SITE} wants to open this application.`) === true);
  check("external apps: a background tab asks with a bar in its window and keeps the tab you are on", bar && win.activeTab()?.id === active && win.state().dialog === null, { bar: await barText(win), active: win.activeTab()?.id });
  await shot(win, "open-app-background-bar-en-light");
  await chromeJs(win, "[...document.querySelectorAll('.dialog-bar [data-dialog-button=\"1\"]')].pop()?.click(); true");
  const front = await until(async () => win.activeTab()?.id === background.id && (await dialogDom(win))?.title === "Open Zoom?");
  check("external apps: the bar's Open button brings the tab to the front and asks there", front, { active: win.activeTab()?.id, dialog: win.state().dialog?.title });
  await pressButton(win, 0);
  await sleep(300);
  win.activate(tab.id);

  // Settings > Site permissions lists the allowed app and takes it back.
  const settingsTab = open("corvus://settings/");
  const swc = await loaded(settingsTab, "#site-permissions");
  const listed = swc ? await until(async () => (await js<boolean>(swc, "Boolean(document.querySelector('[data-external-app=\"afirma\"]'))")) === true) : false;
  const rowText = swc ? await js<string>(swc, "document.querySelector('[data-external-app=\"afirma\"]')?.innerText ?? ''") : "";
  if (swc) {
    await js(swc, "document.querySelector('[data-external-app=\"afirma\"]').scrollIntoView({ block: 'center' }); true");
    await sleep(300);
    if (shots) await capture(`${SHOTS}/settings-open-external-apps`, swc);
    await js(swc, "document.querySelector('[data-external-app=\"afirma\"] button')?.click(); true");
  }
  const revoked = await until(() => !settings.externalAppAllowed(SITE, "afirma"));
  check("external apps: Settings > Site permissions lists \"Open external apps\" for the site and Revoke forgets it", listed && /Open external apps/.test(rowText ?? "") && /afirma: links/.test(rowText ?? "") && revoked, { rowText });
  win.closeTab(settingsTab.id);
  win.activate(tab.id);

  // A private window asks every time and never offers to remember.
  const pw = ctx.windows.openPrivate(win.profile.profile.id, [`${SITE}/apps`]);
  try {
    const ptab = pw.activeTab()!;
    const pwc = await loaded(ptab, "#afirma");
    if (pwc) await clickIn(pwc, "#afirma");
    const pAsked = await until(async () => (await dialogDom(pw))?.title === "Open Autofirma?");
    const pdom = await dialogDom(pw);
    const where = { pdom, private: { dialog: pw.state().dialog?.title, bars: pw.state().dialogBars.map((b) => b.message) }, main: { dialog: win.state().dialog?.title, bars: win.state().dialogBars.map((b) => b.message) } };
    check("external apps: a private window asks with no \"Always allow\"", pAsked && pdom?.check === false, where);
    await pressButton(pw, 1);
    await sleep(500);
    check("external apps: a private window's answer is not remembered", !settings.externalAppAllowed(SITE, "afirma") && xdg.opened().length === 3, xdg.opened());
  } finally {
    pw.close();
    await sleep(300);
  }

  if (looks) await questionLooks(ctx, win, check, tab, wc);

  // An AI agent's tab: always asked, never remembered, and the agent is told the person must answer.
  settings.setExternalAppAllowed(SITE, "afirma", true);
  const agentTab = await ctx.controller.openTab(`${SITE}/apps?agent`);
  const snap = await ctx.controller.snapshot(agentTab.id);
  const ref = snap.elements.find((e) => e.name === "Firmar con Autofirma")?.ref;
  if (ref) await ctx.controller.click(agentTab.id, ref);
  const agentAsked = await until(async () => (await dialogDom(win))?.title === "Open Autofirma?");
  const adom = await dialogDom(win);
  const agentError = await ctx.controller.snapshot(agentTab.id).then(
    () => "",
    (e: Error) => e.message,
  );
  check(
    "external apps: in an agent's tab Corvus asks the person even for a remembered site, offers no \"Always allow\", and the agent is told it needs the person",
    agentAsked && adom?.check === false && /An AI agent is driving this tab/.test(adom.text) && /Agents cannot open apps/.test(agentError) && xdg.opened().length === 3,
    { adom, agentError, ref },
  );
  await pressButton(win, 0);
  await sleep(300);
  settings.setExternalAppAllowed(SITE, "afirma", false);
  await ctx.controller.closeTab(agentTab.id).catch(() => undefined);
}

/** The "Open Autofirma?" question in Spanish and in dark mode, with their screenshots. */
async function questionLooks(ctx: AppContext, win: BrowserWindowCtl, check: Helpers["check"], tab: TabRuntime, wc: WebContents): Promise<void> {
  win.activate(tab.id);
  await setLook(ctx, win, "es", "dark");
  await clickIn(wc, "#afirma");
  const es = await until(async () => (await dialogDom(win))?.title === "¿Abrir Autofirma?");
  const esDom = await dialogDom(win);
  check(
    "external apps: the question in Spanish",
    es && esDom!.text.includes(`${SITE} quiere abrir esta aplicación.`) && esDom!.text.includes(`Permitir siempre que ${SITE} abra este tipo de enlaces en la aplicación asociada`) && esDom!.buttons.join("|") === "Cancelar|Abrir Autofirma",
    esDom,
  );
  await shot(win, "open-app-es-dark");
  await pressButton(win, 0);
  await sleep(300);
  await setLook(ctx, win, "en", "dark");
  await clickIn(wc, "#afirma");
  await until(async () => (await dialogDom(win))?.title === "Open Autofirma?");
  await shot(win, "open-app-en-dark");
  await pressButton(win, 0);
  await sleep(300);
  await setLook(ctx, win, "es", "light");
  await clickIn(wc, "#afirma");
  await until(async () => (await dialogDom(win))?.title === "¿Abrir Autofirma?");
  await shot(win, "open-app-es-light");
  await pressButton(win, 0);
  await sleep(300);
  await setLook(ctx, win, "en", "light");
}

/**
 * Autofirma end to end: "Firmar" opens afirma:// (the person says Open), the system's handler gets
 * the link, the app's stand-in starts on the port the link names, and the public page then talks
 * to it on 127.0.0.1 over HTTP and a WebSocket. Electron 44 does not enforce Chromium's local
 * network access rules, so no permission is asked and nothing in Corvus blocks those requests.
 */
async function autofirmaChecks(
  win: BrowserWindowCtl,
  check: Helpers["check"],
  open: (url: string, activate?: boolean) => TabRuntime,
  xdg: { opened: () => string[] },
): Promise<http.Server | null> {
  const port = await freePort();
  const tab = open(`${SITE}/autofirma?port=${port}`);
  const wc = await loaded(tab, "#sign");
  if (!wc) {
    check("autofirma: the signing page loads", false);
    return null;
  }
  const before = xdg.opened().length;
  await clickIn(wc, "#sign");
  await until(async () => (await dialogDom(win))?.title === "Open Autofirma?");
  await pressButton(win, 1);
  const launched = await until(() => xdg.opened().length > before);
  const link = xdg.opened()[before] ?? "";
  const named = link ? new URL(link.replace(/^afirma:/, "http:")).searchParams.get("ports") : null;
  const stub = named ? await autofirmaStub(Number(named)) : null;
  const signed = await until(async () => (await js<string>(wc, "document.getElementById('status').textContent"))?.startsWith("signed:") === true, 15_000);
  const status = await js<string>(wc, "document.getElementById('status').textContent");
  check(
    "autofirma: Firmar opens afirma:// in the system's app, and the public page then reaches the app on 127.0.0.1 (HTTP and WebSocket) with no prompt",
    launched && named === String(port) && signed && status === "signed:OK-smoke123:WS" && win.state().permissionPrompt === null,
    { link, status, prompt: win.state().permissionPrompt },
  );
  return stub;
}

async function signInChecks(ctx: AppContext, win: BrowserWindowCtl, check: Helpers["check"], open: (url: string, activate?: boolean) => TabRuntime, looks: boolean): Promise<void> {
  const vault = win.profile.credentials;
  const clearAuth = (): Promise<void> => win.profile.session.clearAuthCache();
  await clearAuth();
  const tab = open(`${SITE}/apps?signin`);
  const wc = await loaded(tab, "#afirma");
  if (!wc) return check("sign-in: the page loads", false);
  const status = (): Promise<string | null> => js<string>(wc, "document.getElementById('s')?.textContent ?? ''");

  wc.loadURL(`${SITE}/auth/one`).catch(() => undefined);
  const asked = await until(async () => (await dialogDom(win))?.title === "Sign in");
  const dom = await dialogDom(win);
  check(
    "sign-in: a site's HTTP sign-in shows Corvus's Sign in dialog with the site, its realm, the plain-http warning, a username and a hidden password",
    asked &&
      dom!.text.includes(`127.0.0.1:${PUBLIC_PORT} asks for a username and password`) &&
      dom!.text.includes(`The site says: ${REALM}`) &&
      dom!.text.includes("Your connection to this site is not private") &&
      dom!.fields === 2 &&
      dom!.secret === "password" &&
      dom!.choices === 0 &&
      dom!.buttons.join("|") === "Cancel|Sign in",
    dom,
  );
  await typeField(win, 1, "visible-check");
  await chromeJs(win, "document.querySelector('.dialog-card [data-dialog-reveal=\"1\"]')?.click(); true");
  await sleep(150);
  const revealed = await chromeJs<string>(win, "document.querySelector('.dialog-card [data-dialog-field=\"1\"]')?.type");
  await chromeJs(win, "document.querySelector('.dialog-card [data-dialog-reveal=\"1\"]')?.click(); true");
  await typeField(win, 1, "");
  check("sign-in: the eye button shows the password", revealed === "text", revealed);
  await shot(win, "sign-in-en-light");
  await pressButton(win, 0);
  const denied = await until(async () => (await status()) === "denied");
  check("sign-in: Cancel shows the site's own 401 page", denied && win.state().dialog === null, await status());

  // A wrong password asks again with the username kept; the right one signs in and offers to save.
  wc.loadURL(`${SITE}/auth/two`).catch(() => undefined);
  await until(async () => (await dialogDom(win))?.title === "Sign in");
  await typeField(win, 0, USER);
  await typeField(win, 1, "wrong-pass");
  const firstAsk = win.state().dialog?.id;
  await pressButton(win, 1);
  const again = await until(async () => Boolean(win.state().dialog) && win.state().dialog?.id !== firstAsk && (await chromeJs<string>(win, "document.querySelector('.dialog-card [data-dialog-field=\"0\"]')?.value")) === USER);
  await typeField(win, 1, PASS);
  await pressButton(win, 1);
  const inside = await until(async () => (await status()) === "signed in to /auth/two");
  const save = await until(() => ctx.autofill.stateFor(win).canSave);
  check("sign-in: a refused password asks again with the username filled in; the right one opens the page and offers to save the login", again && inside && save, { status: await status(), autofill: ctx.autofill.stateFor(win) });
  const pending = ctx.autofill.stateFor(win);
  if (pending.canSave) ctx.autofill.dismissSave(win, pending.saveId);

  // A saved login is offered in the dialog: one click signs in with it.
  const saved = vault.add({ origin: SITE, username: USER, password: PASS });
  await clearAuth();
  wc.loadURL(`${SITE}/auth/three`).catch(() => undefined);
  const offered = await until(async () => (await dialogDom(win))?.choices === 1);
  const offeredText = (await dialogDom(win))?.text ?? "";
  await shot(win, "sign-in-saved-login-en-light");
  await chromeJs(win, "document.querySelector('.dialog-card [data-dialog-choice=\"0\"]')?.click(); true");
  const savedIn = await until(async () => (await status()) === "signed in to /auth/three");
  check("sign-in: the site's saved login is offered and signs in with one click", offered && offeredText.includes(USER) && offeredText.includes("Saved in Corvus") && savedIn, { offeredText, status: await status() });

  // A frame of the page asks for its own site.
  await clearAuth();
  wc.loadURL(`${SITE}/frame-host`).catch(() => undefined);
  const frameAsked = await until(async () => (await dialogDom(win))?.text.includes(`localhost:${PUBLIC_PORT} asks for a username and password`) === true);
  await typeField(win, 0, USER);
  await typeField(win, 1, PASS);
  await pressButton(win, 1);
  const frameText = async (): Promise<string> => String((await wc.mainFrame.frames[0]?.executeJavaScript("document.getElementById('s')?.textContent ?? ''").catch(() => "")) ?? "");
  const frameIn = await until(async () => (await frameText()) === "signed in to /auth/frame");
  check("sign-in: a frame's sign-in names the frame's site", frameAsked && frameIn, { dialog: win.state().dialog?.message });

  // A tab in the background asks with a bar, without switching tabs.
  await clearAuth();
  const active = win.activeTab()?.id;
  const background = open(`${SITE}/auth/four`, false);
  const bar = await until(async () => (await barText(win))?.includes("asks for a username and password") === true);
  check("sign-in: a background tab's sign-in waits in a bar and keeps the tab you are on", bar && win.activeTab()?.id === active && win.state().dialog === null, { bar: await barText(win), active: win.activeTab()?.id });
  await shot(win, "sign-in-background-bar-en-light");
  await chromeJs(win, "[...document.querySelectorAll('.dialog-bar [data-dialog-button=\"1\"]')].pop()?.click(); true");
  const front = await until(async () => win.activeTab()?.id === background.id && (await dialogDom(win))?.title === "Sign in");
  check("sign-in: the bar's Sign in brings the tab to the front with the dialog", front, { active: win.activeTab()?.id });
  await pressButton(win, 0);
  await sleep(300);
  win.activate(tab.id);
  if (looks) await signInLooks(ctx, win, check, tab, wc);

  // An AI agent's navigation: told at once that the person must sign in; the dialog says so.
  await clearAuth();
  vault.remove(saved.id);
  const agentTab = await ctx.controller.openTab(`${SITE}/apps?agent-signin`);
  const started = Date.now();
  const agentError = await ctx.controller.navigate(agentTab.id, `${SITE}/auth/five`).then(
    () => "",
    (e: Error) => e.message,
  );
  const ms = Date.now() - started;
  await until(async () => /An AI agent is driving this tab/.test((await dialogDom(win))?.text ?? ""));
  const adom = await dialogDom(win);
  check(
    "sign-in: an agent's navigation to a sign-in ends at once with \"hand this step to the person\", and the dialog tells the person",
    /hand this step to the person/.test(agentError) && ms < 10_000 && /An AI agent is driving this tab/.test(adom?.text ?? ""),
    { agentError, ms, dialog: adom?.text },
  );
  await pressButton(win, 0);
  await sleep(300);

  // A login the person opted in for agents signs the agent in after the person approves it.
  const agentLogin = vault.add({ origin: SITE, username: USER, password: PASS, agentSignIn: true });
  const accessBefore = ctx.settings.get().passwords.agentAccess;
  ctx.settings.update({ passwords: { agentAccess: true } });
  let approvals = 0;
  ctx.agentCredentials.setTestApprover(async () => {
    approvals++;
    return true;
  });
  try {
    await clearAuth();
    await ctx.controller.navigate(agentTab.id, `${SITE}/auth/six`);
    const agentWc = pageOf(ctx.windows.findTab(agentTab.id)?.tab.view);
    const agentStatus = agentWc ? await js<string>(agentWc, "document.getElementById('s')?.textContent ?? ''") : null;
    check("sign-in: an agent signs in with a login opted in for agents, after the person's approval", agentStatus === "signed in to /auth/six" && approvals === 1 && win.state().dialog === null, { agentStatus, approvals });
  } finally {
    ctx.agentCredentials.setTestApprover(null);
    ctx.settings.update({ passwords: { agentAccess: accessBefore } });
    vault.remove(agentLogin.id);
    await ctx.controller.closeTab(agentTab.id).catch(() => undefined);
  }
}

/** The Sign in dialog in Spanish and in dark mode, with their screenshots. */
async function signInLooks(ctx: AppContext, win: BrowserWindowCtl, check: Helpers["check"], tab: TabRuntime, wc: WebContents): Promise<void> {
  const clearAuth = (): Promise<void> => win.profile.session.clearAuthCache();
  win.activate(tab.id);
  await clearAuth();
  await setLook(ctx, win, "es", "dark");
  wc.loadURL(`${SITE}/auth/seven`).catch(() => undefined);
  const es = await until(async () => (await dialogDom(win))?.title === "Iniciar sesión");
  const esDom = await dialogDom(win);
  check(
    "sign-in: the dialog in Spanish",
    es && esDom!.text.includes(`127.0.0.1:${PUBLIC_PORT} pide un usuario y una contraseña`) && esDom!.text.includes("Tu conexión con este sitio no es privada") && esDom!.buttons.join("|") === "Cancelar|Iniciar sesión",
    esDom,
  );
  await shot(win, "sign-in-es-dark");
  await pressButton(win, 0);
  await sleep(300);
  await setLook(ctx, win, "en", "dark");
  await clearAuth();
  wc.loadURL(`${SITE}/auth/eight`).catch(() => undefined);
  await until(async () => (await dialogDom(win))?.title === "Sign in");
  await shot(win, "sign-in-en-dark");
  await pressButton(win, 0);
  await sleep(300);
  await setLook(ctx, win, "es", "light");
  await clearAuth();
  wc.loadURL(`${SITE}/auth/nine`).catch(() => undefined);
  await until(async () => (await dialogDom(win))?.title === "Iniciar sesión");
  await shot(win, "sign-in-es-light");
  await pressButton(win, 0);
  await sleep(300);
  await setLook(ctx, win, "en", "light");
}

/**
 * Chromium's local network access permission ("access other apps and services on this device"),
 * as Electron would hand it to Corvus: a prompt, remembered per site, with Block too. Electron 44
 * never asks for it (it does not enforce those rules), so the checks feed the request in directly.
 */
async function localNetworkChecks(ctx: AppContext, win: BrowserWindowCtl, check: Helpers["check"], open: (url: string, activate?: boolean) => TabRuntime, looks: boolean): Promise<void> {
  const settings = win.profile.siteSettings;
  const tab = open(`${SITE}/apps?lna`);
  const wc = await loaded(tab, "#afirma");
  if (!wc) return check("local network: the page loads", false);
  const ask = (permission: string): Promise<boolean> =>
    new Promise((resolve) => win.profile.permissions.handleRequest(wc, permission, resolve, { requestingUrl: wc.getURL(), isMainFrame: true }));
  const promptText = (): Promise<string | null> => chromeJs<string>(win, "document.querySelector('.perm-prompt')?.innerText ?? ''");

  const first = ask("loopback-network");
  const shown = await until(async () => (await promptText())?.includes("Access other apps and services on this device") === true);
  check("local network: a site reaching this computer's apps asks \"Access other apps and services on this device\"", shown && win.state().permissionPrompt?.kinds.join() === "loopback-network", await promptText());
  await shot(win, "local-network-en-light");
  for (const [language, theme] of looks ? ([["es", "dark"], ["en", "dark"], ["es", "light"]] as const) : []) {
    await setLook(ctx, win, language, theme);
    await until(async () => Boolean(await promptText()));
    if (language === "es") check(`local network: the prompt in Spanish (${theme})`, (await promptText())?.includes("Acceder a otras aplicaciones y servicios de este dispositivo") === true, await promptText());
    await shot(win, `local-network-${language}-${theme}`);
  }
  if (looks) {
    await setLook(ctx, win, "en", "light");
    await until(async () => Boolean(await promptText()));
  }
  await chromeJs(win, "[...document.querySelectorAll('.perm-prompt .btn')].find((b) => b.textContent === 'Allow')?.click(); true");
  const allowed = await first;
  check("local network: Allow grants it and is remembered for the site", allowed && settings.permission(SITE, "loopback-network") === "allow", settings.permissionsFor(SITE));
  const again = await Promise.race([ask("loopback-network"), sleep(2000).then(() => null)]);
  check("local network: the remembered site is not asked again", again === true && win.state().permissionPrompt === null, again);

  const lan = ask("local-network-access");
  await until(async () => (await promptText())?.includes("Look for and connect to any device on your local network") === true);
  await chromeJs(win, "[...document.querySelectorAll('.perm-prompt .btn')].find((b) => b.textContent === 'Block')?.click(); true");
  const blocked = await lan;
  const blockedAgain = await Promise.race([ask("local-network"), sleep(2000).then(() => null)]);
  check("local network: Block refuses access to the local network and is remembered", blocked === false && blockedAgain === false && settings.permission(SITE, "local-network") === "block", settings.permissionsFor(SITE));
  settings.resetPermissions(SITE);
}
