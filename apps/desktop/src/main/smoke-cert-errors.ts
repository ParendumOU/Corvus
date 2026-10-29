import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { desktopCapturer, screen, type WebContents } from "electron";
import type { AppContext } from "./context";
import { openMcpSession, type McpSession } from "./smoke-agent";
import { selfSignedCert } from "./smoke-assist";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(100);
  }
  return false;
}

const js = <T>(wc: WebContents, expr: string): Promise<T | null> => (wc.executeJavaScript(expr) as Promise<T>).catch(() => null);

/** A 1x1 PNG, the router page's own image (a subresource on the same host). */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==", "base64");
const ROUTER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Router admin</title></head>
<body style="font-family:sans-serif;padding:24px"><h1>Router admin</h1><p>Signal strength: excellent.</p><img id="logo" src="/logo.png" width="16" height="16"></body></html>`;

/** The whole window as composited on screen (address bar and page together). */
async function windowShot(win: BrowserWindowCtl, name: string): Promise<void> {
  const dir = process.env.CORVUS_SMOKE_OUT;
  if (!dir) return;
  win.win.focus();
  await sleep(500);
  const bounds = win.win.getBounds();
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor;
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
  const image = sources[0]?.thumbnail;
  if (!image || image.isEmpty()) return;
  const png = image.crop({ x: Math.round(bounds.x * scale), y: Math.round(bounds.y * scale), width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) }).toPNG();
  const file = path.join(dir, "cert", `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
}

/** An HTTPS server for `host` with a throwaway self-signed certificate (Chromium: ERR_CERT_AUTHORITY_INVALID). */
async function routerServer(host: string): Promise<{ url: string; close: () => void } | null> {
  const tls = selfSignedCert(host);
  if (!tls) return null;
  const server = https.createServer(tls, (req, res) => {
    if (req.url === "/logo.png") res.writeHead(200, { "Content-Type": "image/png" }).end(PIXEL);
    else res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(ROUTER_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `https://${host}:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

interface ErrorPage {
  url: string;
  heading: string;
  code: string;
  proceed: boolean;
  blocked: string;
  title: string;
}

const ERROR_PAGE = `({
  url: location.href,
  heading: document.querySelector('.cert-card h1')?.textContent ?? '',
  code: document.querySelector('.cert-code')?.textContent ?? '',
  proceed: Boolean(document.querySelector('.cert-proceed')),
  blocked: document.querySelector('.cert-blocked')?.textContent ?? '',
  title: document.title,
})`;

/** The certificate error page in `tab`, with its Advanced section open. */
async function errorPage(tab: TabRuntime): Promise<ErrorPage | null> {
  const wc = tab.view.webContents;
  const shown = await until(async () => (await js<boolean>(wc, "Boolean(document.querySelector('.cert-card h1'))")) === true);
  if (!shown) return null;
  await js(wc, "document.querySelector('.cert-advanced[aria-expanded=\"false\"]')?.click()");
  await until(async () => (await js<boolean>(wc, "Boolean(document.querySelector('.cert-details'))")) === true, 3000);
  return js<ErrorPage>(wc, ERROR_PAGE);
}

const chip = (win: BrowserWindowCtl): Promise<{ cert: boolean; lock: boolean; text: string } | null> =>
  js(win.chrome.webContents, `({ cert: Boolean(document.querySelector('.omni-chip.warn.cert')), lock: Boolean(document.querySelector('.site-chip:not(.warn)')), text: document.querySelector('.site-chip')?.textContent ?? '' })`);

/**
 * Certificate errors: a self-signed site shows Corvus's error page (not a blank tab) with "Not secure"
 * in the address bar; Proceed loads it for this session only; subresources with a bad certificate
 * stay blocked; HSTS sites offer no Proceed; agents stop at it unless MCP has full access.
 */
export async function runCertErrorSmoke(ctx: AppContext, { win, check }: Helpers): Promise<void> {
  const router = await routerServer("corvus-smoke.test");
  const hsts = await routerServer("corvus-smoke.dev");
  if (!router || !hsts) {
    check("certificate errors: self-signed test servers (openssl)", false);
    return;
  }
  const plain = http.createServer((_req, res) => {
    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(`<!doctype html><title>Valid page</title><p>A valid page.</p><img src="${router.url}logo.png" onload="document.title='loaded'" onerror="document.title='blocked'">`);
  });
  await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
  const plainUrl = `http://127.0.0.1:${(plain.address() as AddressInfo).port}/`;
  const appearance = ctx.settings.get().appearance;
  const mcpBefore = ctx.settings.get().mcp;
  const session = win.profile.session;
  const opened: TabRuntime[] = [];
  let mcp: McpSession | null = null;
  try {
    const hstsAnswers = await Promise.all([ctx.certErrors.isHsts(session, "corvus-smoke.dev"), ctx.certErrors.isHsts(session, "www.youtube.com"), ctx.certErrors.isHsts(session, "corvus-smoke.test"), ctx.certErrors.isHsts(session, "10.0.10.1")]);
    check("certificate errors: HSTS comes from Chromium's own state (.dev and youtube.com preloaded, others not)", hstsAnswers.join() === "true,true,false,false", hstsAnswers);

    // A person opens the self-signed site: the error page, never a blank page or the lock.
    ctx.settings.update({ appearance: { theme: "light", language: "en" } });
    const tab = win.createTab(router.url);
    opened.push(tab);
    const page = await errorPage(tab);
    const view = win.state().tabs.find((t) => t.id === tab.id);
    const address = await chip(win);
    check(
      "certificate errors: a self-signed site shows the error page with Advanced and Proceed, not a blank tab",
      page?.url.startsWith("corvus://cert-error/") === true && page.heading === "Your connection is not private" && page.code === "ERR_CERT_AUTHORITY_INVALID" && page.proceed && page.title === "Privacy error",
      page,
    );
    check(
      "certificate errors: the address bar keeps the site's URL and says Not secure (no lock)",
      tab.url === router.url && view?.certError === "ERR_CERT_AUTHORITY_INVALID" && view.title === "Privacy error" && address?.cert === true && address.lock === false && address.text === "Not secure",
      { url: tab.url, view: view && { certError: view.certError, title: view.title }, address },
    );
    check("certificate errors: Back has no failed page to fall into", !tab.view.webContents.navigationHistory.canGoBack(), tab.view.webContents.navigationHistory.getAllEntries().map((e) => e.url));
    await windowShot(win, "cert-error-en-light");
    ctx.settings.update({ appearance: { theme: "dark" } });
    await sleep(400);
    await windowShot(win, "cert-error-en-dark");

    win.chrome.webContents.executeJavaScript("document.querySelector('.site-chip')?.click()").catch(() => undefined);
    const siteInfo = await until(async () => (await js<boolean>(win.chrome.webContents, "Boolean(document.querySelector('.site-info'))")) === true, 3000);
    const infoText = await js<string>(win.chrome.webContents, "document.querySelector('.site-info .site-connection')?.textContent ?? ''");
    check("certificate errors: site information says the certificate is not valid", siteInfo && infoText?.includes("The certificate of this site is not valid (ERR_CERT_AUTHORITY_INVALID)") === true, infoText);
    await windowShot(win, "cert-site-info-en-dark");
    win.sendCommand({ type: "close-overlays" });
    await sleep(200);

    // Spanish: the browser UI and the error page (Reload tries the site again).
    ctx.settings.update({ appearance: { language: "es", theme: "light" } });
    win.chrome.webContents.reload();
    await until(async () => (await js<boolean>(win.chrome.webContents, "Boolean(document.querySelector('.omni-input'))")) === true);
    win.reload(tab.id);
    await sleep(300);
    const spanish = await errorPage(tab);
    const spanishChip = await chip(win);
    check(
      "certificate errors: the error page and the chip in Spanish",
      spanish?.heading === "Tu conexión no es privada" && spanish.title === "Error de privacidad" && spanishChip?.text === "No es seguro",
      { spanish, spanishChip },
    );
    await windowShot(win, "cert-error-es-light");
    ctx.settings.update({ appearance: { theme: "dark" } });
    await sleep(400);
    await windowShot(win, "cert-error-es-dark");
    ctx.settings.update({ appearance: { language: "en", theme: "light" } });
    win.chrome.webContents.reload();
    await until(async () => (await js<boolean>(win.chrome.webContents, "Boolean(document.querySelector('.omni-input'))")) === true);
    win.reload(tab.id);
    await errorPage(tab);

    // A valid page with an image from the self-signed site: the image is blocked, no error page.
    const valid = win.createTab(plainUrl);
    opened.push(valid);
    const settled = await until(async () => ["loaded", "blocked"].includes((await js<string>(valid.view.webContents, "document.title")) ?? ""));
    check(
      "certificate errors: a subresource with a bad certificate is blocked, with no error page",
      settled && (await js<string>(valid.view.webContents, "document.title")) === "blocked" && valid.view.webContents.getURL() === plainUrl && !win.state().tabs.find((t) => t.id === valid.id)?.certError,
      { url: valid.view.webContents.getURL(), title: await js<string>(valid.view.webContents, "document.title") },
    );
    const httpChip = await chip(win);
    check("certificate errors: a plain http page says Not secure too (no lock)", httpChip?.text === "Not secure" && !httpChip.cert && !httpChip.lock, httpChip);

    // An agent (MCP at the standard access level) stops at the error: the person decides.
    const c = ctx.controller;
    const agentTab = await c.openTab("about:blank", { background: true });
    const refused = await c.navigate(agentTab.id, router.url).then(
      () => "loaded",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    const unreadable = await c.snapshot(agentTab.id).then(
      () => "read",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    const agentRuntime = win.getTab(agentTab.id);
    if (agentRuntime) opened.push(agentRuntime);
    check(
      "certificate errors: an agent's navigate returns the error and cannot read or click the error page",
      refused.startsWith("certificate error: ERR_CERT_AUTHORITY_INVALID for corvus-smoke.test; the person must choose to proceed") && unreadable === "Agents cannot access this page",
      { refused, unreadable },
    );

    // The person proceeds: the page loads with its own image, still Not secure, the error page gone from history.
    win.activate(tab.id);
    await js(tab.view.webContents, "document.querySelector('.cert-proceed')?.click()");
    const loaded = await until(() => tab.view.webContents.getURL() === router.url && !tab.loading);
    await until(async () => (await js<number>(tab.view.webContents, "document.getElementById('logo')?.naturalWidth ?? 0")) === 1, 5000);
    const after = { heading: await js<string>(tab.view.webContents, "document.querySelector('h1')?.textContent"), logo: await js<number>(tab.view.webContents, "document.getElementById('logo')?.naturalWidth ?? 0") };
    const afterChip = await chip(win);
    const entries = tab.view.webContents.navigationHistory.getAllEntries().map((e) => e.url);
    check(
      "certificate errors: Proceed loads the site and its own subresources; it stays Not secure",
      loaded && after.heading === "Router admin" && after.logo === 1 && afterChip?.cert === true && afterChip.lock === false && win.state().tabs.find((t) => t.id === tab.id)?.certError === "ERR_CERT_AUTHORITY_INVALID",
      { after, afterChip },
    );
    check("certificate errors: history keeps the site, not the error page", entries.length === 1 && entries[0] === router.url, entries);
    await windowShot(win, "cert-proceeded-en-light");
    win.chrome.webContents.executeJavaScript("document.querySelector('.site-chip')?.click()").catch(() => undefined);
    const offered = await until(async () => (await js<boolean>(win.chrome.webContents, "Boolean(document.querySelector('.site-cert-accepted .btn'))")) === true, 3000);
    check("certificate errors: site information offers Turn on warnings again after Proceed", offered);
    await windowShot(win, "cert-site-info-proceeded-en-light");
    win.sendCommand({ type: "close-overlays" });
    await sleep(200);

    // Exceptions are per session: a private window still gets the error page.
    const pw = ctx.windows.openPrivate(win.profile.profile.id, [router.url]);
    const privateTab = pw.activeTab();
    const privatePage = privateTab ? await errorPage(privateTab) : null;
    check("certificate errors: a private window keeps its own exceptions (error page there)", privatePage?.code === "ERR_CERT_AUTHORITY_INVALID", privatePage);
    pw.close();
    await sleep(300);

    // "Turn on warnings again": the error page comes back.
    win.activate(tab.id);
    win.restoreCertWarnings();
    const again = await errorPage(tab);
    check("certificate errors: Turn on warnings again shows the error page again", again?.code === "ERR_CERT_AUTHORITY_INVALID" && again.proceed, again);

    // HSTS: no Proceed for the person, and none for an agent even in full auto.
    const hstsTab = win.createTab(hsts.url);
    opened.push(hstsTab);
    const hstsPage = await errorPage(hstsTab);
    check("certificate errors: an HSTS site's error page offers no Proceed", hstsPage?.proceed === false && hstsPage.blocked.includes("HSTS"), hstsPage);
    await windowShot(win, "cert-error-hsts-en-light");

    // MCP at full access (full auto) goes on past it, and says so in the activity log.
    const clientName = "corvus-smoke-cert";
    ctx.settings.update({ mcp: { enabled: true, accessLevel: "full", approvedClients: [...mcpBefore.approvedClients.filter((n) => n !== clientName), clientName] } });
    await ctx.mcp.apply();
    const status = ctx.mcp.status();
    if (!status.running || !status.port || !status.token) {
      check("certificate errors: MCP server running", false, { running: status.running, error: status.error });
      return;
    }
    mcp = await openMcpSession(`http://127.0.0.1:${status.port}/mcp`, status.token, clientName);
    const fullOpen = await mcp.tool("tab_open", { url: router.url, background: true });
    const fullId = /"id":"([^"]+)"/.exec(fullOpen.text)?.[1] ?? "";
    const fullFound = ctx.windows.findTab(fullId);
    if (fullFound) opened.push(fullFound.tab);
    const fullView = fullFound?.window.state().tabs.find((t) => t.id === fullId);
    const logged = await until(() => ctx.mcp.audit.list({ client: clientName }).some((e) => e.tool === "tab_open" && e.certificateError === "ERR_CERT_AUTHORITY_INVALID"), 5000);
    check(
      "certificate errors: MCP in full auto loads the page past the error, Not secure, noted in the activity log",
      !fullOpen.isError && fullFound?.tab.view.webContents.getURL() === router.url && fullView?.certError === "ERR_CERT_AUTHORITY_INVALID" && logged,
      { text: fullOpen.text.slice(0, 200), url: fullFound?.tab.view.webContents.getURL(), certError: fullView?.certError, logged },
    );
    const fullHsts = await mcp.tool("navigate", { tabId: fullId, url: hsts.url });
    check("certificate errors: MCP in full auto never goes past an HSTS site", fullHsts.isError && fullHsts.text.includes("certificate error: ERR_CERT_AUTHORITY_INVALID for corvus-smoke.dev; the site uses HSTS"), fullHsts.text);
  } catch (err) {
    check("certificate errors smoke", false, err instanceof Error ? err.stack : String(err));
  } finally {
    await mcp?.close();
    ctx.settings.update({
      appearance: { theme: appearance.theme, language: appearance.language },
      mcp: { enabled: mcpBefore.enabled, accessLevel: mcpBefore.accessLevel, allowEvaluate: mcpBefore.allowEvaluate, approvedClients: mcpBefore.approvedClients },
    });
    await ctx.mcp.apply();
    win.chrome.webContents.reload();
    await sleep(800);
    for (const t of opened) {
      const found = ctx.windows.findTab(t.id);
      if (found) found.window.closeTab(t.id);
    }
    ctx.certErrors.exceptions.revoke(session, "corvus-smoke.test");
    router.close();
    hsts.close();
    plain.close();
  }
}
