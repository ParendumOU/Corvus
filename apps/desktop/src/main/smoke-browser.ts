import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { app, type WebContents } from "electron";
import type { TabId } from "@corvus/shared";
import { originOf } from "../shared/permissions";
import { reviveSession } from "../shared/session-state";
import type { AppContext } from "./context";
import { SiteSettingsStore } from "./site-settings";
import type { BrowserWindowCtl } from "./window";

const FIND_PAGE = `<!doctype html><html><head><title>Find</title></head><body>
<h1>Find smoke</h1><p>needle one</p><p>needle two</p><p>a NEEDLE three</p><p>needles four</p><div>needle five</div>
</body></html>`;
const PLAIN_PAGE = `<!doctype html><html><head><title>Permissions</title></head><body><h1>Permission smoke</h1></body></html>`;
// Requests several known ad/tracker URLs so the built-in blocker cancels them (offline-safe: the
// blocker runs before any network request). Classic ad slot markup lets cosmetic filters hide it.
const ADS_PAGE = `<!doctype html><html><head><title>Ads</title></head><body>
<h1>Ad blocker smoke</h1>
<div class="adsbygoogle">ad slot</div>
<img src="https://doubleclick.net/pixel.gif" alt="">
<img src="https://ad.doubleclick.net/ddm/ad.png" alt="">
<img src="https://pagead2.googlesyndication.com/pagead/show_ads.js" alt="">
<img src="https://www.google-analytics.com/collect?v=1&t=pageview" alt="">
<img src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST" alt="">
<script src="https://doubleclick.net/tag.js"></script>
</body></html>`;
// A OneTrust cookie notice, the most common consent platform.
const CONSENT_PAGE = `<!doctype html><html><head><title>Consent</title></head><body>
<h1>Cookie notice smoke</h1>
<div id="onetrust-banner-sdk" style="display:block;position:fixed;bottom:0">We use cookies <button>Accept all</button></div>
</body></html>`;
// Something to hide with "Hide this element", next to something to keep.
const PICKER_PAGE = `<!doctype html><html><head><title>Picker</title></head><body style="margin:40px">
<p id="keep">The article.</p>
<div class="promo" style="width:300px;height:80px;background:#fde68a">Buy now!</div>
</body></html>`;
export const DOWNLOAD_BODY = "corvus download smoke\n";

/** Extra routes on the smoke server. Returns true when the request was handled. */
export function serveBrowserSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pathname = (req.url ?? "/").split("?")[0];
  switch (pathname) {
    case "/find":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(FIND_PAGE);
      return true;
    case "/perm":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PLAIN_PAGE);
      return true;
    case "/ads":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(ADS_PAGE);
      return true;
    case "/consent":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(CONSENT_PAGE);
      return true;
    case "/picker":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PICKER_PAGE);
      return true;
    case "/report.txt":
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="report.txt"' });
      res.end(DOWNLOAD_BODY);
      return true;
    case "/setup.exe":
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="setup.exe"' });
      res.end("MZ not really a program");
      return true;
    default:
      return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 8000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await sleep(100);
  }
  return null;
}

/** Waits until a page expression is truthy (false after the timeout). */
async function untilJs(wc: WebContents, expr: string, timeoutMs = 6000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(100);
  }
  return false;
}

function waitForLoad(wc: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    wc.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const GEO_SCRIPT = `new Promise((resolve) => navigator.geolocation.getCurrentPosition(
  () => resolve("ok"), (e) => resolve("err:" + e.code), { timeout: 8000 }))`;

export interface SmokeHelpers {
  url: string;
  agentTabId: TabId;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

/** Permissions, downloads, find, zoom and session restore, end to end. */
export async function runBrowserSmoke(ctx: AppContext, h: SmokeHelpers): Promise<void> {
  const { url, win, check, capture } = h;
  const profile = win.profile;
  const origin = originOf(url);
  const chrome = win.chrome.webContents;
  const chromeHas = (selector: string): Promise<unknown> => chrome.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);

  // ------------------------------------------------------------------ permissions (user tab)
  const userTab = win.createTab(`${url}perm`);
  await waitForLoad(userTab.view.webContents);
  const wc = userTab.view.webContents;

  const notification = wc.executeJavaScript("Notification.requestPermission()", true) as Promise<string>;
  const prompt = await waitFor(() => win.state().permissionPrompt);
  check("permission prompt queued for the tab", prompt?.kinds.join() === "notifications" && prompt.rememberable && !prompt.agent, prompt);
  await sleep(400);
  check("permission prompt rendered in chrome UI", (await chromeHas(".perm-prompt")) === true);
  await capture("permission-prompt", chrome);
  if (prompt) win.respondPermission(prompt.id, "allow", true);
  const granted = await notification;
  check("permission allow + remember", granted === "granted" && profile.siteSettings.permission(origin, "notifications") === "allow", granted);
  check("permission check handler matches", (await wc.executeJavaScript("Notification.permission")) === "granted");

  const geo = wc.executeJavaScript(GEO_SCRIPT, true) as Promise<string>;
  const geoPrompt = await waitFor(() => win.state().permissionPrompt);
  if (geoPrompt) win.respondPermission(geoPrompt.id, "block", false);
  const geoResult = await geo;
  check(
    "permission block for this page only",
    geoPrompt?.kinds.join() === "geolocation" && geoResult === "err:1" && profile.siteSettings.permission(origin, "geolocation") === undefined,
    { geoResult },
  );

  // ------------------------------------------------------------------ permissions (agent tab)
  profile.siteSettings.setPermission(origin, "geolocation", "allow");
  const agent = ctx.windows.findTab(h.agentTabId);
  const agentWc = agent?.tab.view.webContents;
  if (agent && agentWc) {
    const agentGeo = await agentWc.executeJavaScript(GEO_SCRIPT, true);
    check("agent tab denied geolocation despite stored allow", agentGeo === "err:1" && profile.permissions.promptFor(agentWc) === null, agentGeo);
    const agentNotification = agentWc.executeJavaScript("Notification.requestPermission()", true) as Promise<string>;
    const agentPrompt = await waitFor(() => profile.permissions.promptFor(agentWc));
    check("agent tab not auto-approved from stored allow", agentPrompt?.agent === true && !agentPrompt.rememberable, agentPrompt);
    if (agentPrompt) agent.window.respondPermission(agentPrompt.id, "dismiss", false);
    check("agent prompt dismissed", (await agentNotification) !== "granted");
  } else {
    check("agent tab available", false);
  }
  profile.siteSettings.setPermission(origin, "geolocation", null);

  // ------------------------------------------------------------------ site info popover
  win.activate(userTab.id);
  await sleep(300);
  await chrome.executeJavaScript("document.querySelector('.site-chip')?.click()");
  await sleep(500);
  check("site info popover", (await chromeHas(".site-info .site-perms")) === true);
  await capture("site-info", chrome);
  win.sendCommand({ type: "close-overlays" });

  // ------------------------------------------------------------------ downloads
  const dir = path.join(app.getPath("userData"), "smoke-downloads");
  ctx.settings.update({ downloads: { directory: dir, askWhereToSave: false } });
  wc.downloadURL(`${url}report.txt`);
  const done = await waitFor(() => ctx.downloads.list(profile).find((d) => d.url.endsWith("/report.txt") && d.state === "completed"));
  const saved = done ? fs.readFileSync(done.savePath, "utf8") : null;
  check("download from local server", Boolean(done) && saved === DOWNLOAD_BODY && path.dirname(done?.savePath ?? "") === dir, done);

  agentWc?.downloadURL(`${url}setup.exe`);
  const blocked = await waitFor(() => ctx.downloads.list(profile).find((d) => d.url.endsWith("/setup.exe") && d.state === "blocked"));
  check("agent executable download held back", Boolean(blocked) && !fs.existsSync(path.join(dir, "setup.exe")), blocked);
  await sleep(400);
  check("downloads bubble opens for blocked download", (await chromeHas(".downloads-bubble .dl-row.blocked")) === true);
  await capture("downloads-bubble", chrome);
  win.sendCommand({ type: "close-overlays" });
  if (blocked) ctx.downloads.act(profile, blocked.id, "keep");
  const kept = await waitFor(() => ctx.downloads.list(profile).find((d) => d.url.endsWith("/setup.exe") && d.state === "completed"));
  check("blocked executable kept after confirmation", Boolean(kept) && fs.existsSync(path.join(dir, "setup.exe")), kept);

  const downloadsPage = win.createTab("corvus://downloads/");
  await sleep(1500);
  check(
    "page corvus://downloads",
    (await downloadsPage.view.webContents.executeJavaScript("document.querySelectorAll('.download-row').length")) >= 2,
  );
  await capture("downloads", downloadsPage.view.webContents);
  win.closeTab(downloadsPage.id);

  // ------------------------------------------------------------------ find in page
  win.activate(userTab.id);
  win.loadUrl(userTab.id, `${url}find`);
  await waitForLoad(wc);
  win.runCommand({ type: "find" });
  const found = new Promise<Electron.Result | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    const listener = (_e: Electron.Event, result: Electron.Result): void => {
      if (!result.finalUpdate) return;
      clearTimeout(timer);
      wc.off("found-in-page", listener);
      resolve(result);
    };
    wc.on("found-in-page", listener);
  });
  win.findQuery("needle");
  const result = await found;
  await sleep(300);
  check("find in page match count", result?.matches === 5 && win.state().find?.matches === 5, { matches: result?.matches, state: win.state().find });
  check("find bar rendered", (await chromeHas(".find-bar .find-input")) === true);
  await capture("find-bar", chrome);
  win.closeFind();
  check("find bar closed", win.state().find === null);

  // ------------------------------------------------------------------ zoom
  win.runCommand({ type: "zoom", delta: 1 });
  win.runCommand({ type: "zoom", delta: 1 });
  await sleep(300);
  const key = "127.0.0.1";
  profile.siteSettings.flush();
  const reread = new SiteSettingsStore(profile.dataDir).zoom(key);
  check("zoom per site persisted", Math.abs(wc.getZoomFactor() - 1.25) < 0.01 && win.state().zoomPercent === 125 && reread === 1.25, {
    factor: wc.getZoomFactor(),
    reread,
  });
  const sibling = win.createTab(`${url}perm?zoom`);
  await waitForLoad(sibling.view.webContents);
  await sleep(200);
  check("zoom applied to same site in new tab", Math.abs(sibling.view.webContents.getZoomFactor() - 1.25) < 0.01, sibling.view.webContents.getZoomFactor());
  await sleep(300);
  check("zoom indicator rendered", (await chromeHas(".omni-zoom")) === true);
  await capture("zoom-indicator", chrome);
  win.runCommand({ type: "zoom", delta: 0 });
  profile.siteSettings.flush();
  check("zoom reset clears the site entry", new SiteSettingsStore(profile.dataDir).zoom(key) === 1 && Math.abs(sibling.view.webContents.getZoomFactor() - 1) < 0.01);

  // ------------------------------------------------------------------ ad / tracker blocker
  const adTab = win.createTab(`${url}ads`);
  await waitForLoad(adTab.view.webContents);
  const blockedCount = await waitFor(() => {
    const n = win.state().adblock.blocked;
    return n > 0 ? n : false;
  });
  check("adblock blocks ad-domain requests", (blockedCount ?? 0) > 0, { blocked: blockedCount, host: win.state().adblock.host });
  check("shield reports active blocking for the tab", win.state().adblock.active && win.state().adblock.enabled, win.state().adblock);
  await sleep(300);
  await chrome.executeJavaScript("document.querySelector('.shield-btn')?.click()");
  await sleep(400);
  check("shield popover opens", (await chromeHas(".shield-popover")) === true);
  await capture("adblock-shield-light", chrome);

  ctx.settings.update({ appearance: { theme: "dark" } });
  await sleep(500);
  await chrome.executeJavaScript("document.querySelector('.shield-popover') || document.querySelector('.shield-btn')?.click()");
  await sleep(400);
  check("shield popover renders in dark theme", (await chromeHas(".shield-popover")) === true);
  await capture("adblock-shield-dark", chrome);
  ctx.settings.update({ appearance: { theme: "light" } });
  win.sendCommand({ type: "close-overlays" });
  await sleep(200);

  // Pause on this site: new requests on the ad page are no longer blocked.
  profile.adblock.setSiteAllowed("127.0.0.1", true);
  check("pause on site records the allow", profile.adblock.settings().allowed.includes("127.0.0.1"));
  win.loadUrl(adTab.id, `${url}ads`);
  await waitForLoad(adTab.view.webContents);
  await sleep(500);
  check("paused site is not blocked", win.state().adblock.blocked === 0 && win.state().adblock.allowed, win.state().adblock);
  profile.adblock.setSiteAllowed("127.0.0.1", false);

  // Global off: nothing is blocked anywhere.
  profile.adblock.setEnabled(false);
  win.loadUrl(adTab.id, `${url}ads`);
  await waitForLoad(adTab.view.webContents);
  await sleep(500);
  check("global off disables blocking", win.state().adblock.blocked === 0 && !win.state().adblock.enabled, win.state().adblock);
  profile.adblock.setEnabled(true);

  // Tracking parameters come off the address; a cookie notice is hidden; both switch off per profile.
  const site = url.replace("127.0.0.1", "corvus-smoke.test");
  const consentState = (): Promise<{ href: string; banner: string | null }> =>
    adTab.view.webContents.executeJavaScript(
      "({ href: location.href, banner: (() => { const b = document.getElementById('onetrust-banner-sdk'); return b ? getComputedStyle(b).display : null; })() })",
    ) as Promise<{ href: string; banner: string | null }>;
  win.loadUrl(adTab.id, `${site}consent?utm_source=news&keep=1&fbclid=abc`);
  await waitForLoad(adTab.view.webContents);
  await sleep(800);
  const cleaned = await consentState();
  check("tracking parameters are removed from the address", cleaned.href === `${site}consent?keep=1`, cleaned);
  check("a cookie notice is hidden", cleaned.banner === "none", cleaned);
  profile.adblock.setOptions({ annoyances: false, cleanUrls: false });
  win.loadUrl(adTab.id, `${site}consent?utm_source=news&keep=1`);
  await waitForLoad(adTab.view.webContents);
  await sleep(800);
  const unfiltered = await consentState();
  check("with both options off the address and the notice stay", unfiltered.href === `${site}consent?utm_source=news&keep=1` && unfiltered.banner === "block", unfiltered);
  profile.adblock.setOptions({ annoyances: true, cleanUrls: true });

  // "Hide this element": the picker takes a real click and Enter, the element hides at once and
  // stays hidden on reload (a rule in the profile's filters); Escape cancels without a rule.
  const pageWc = adTab.view.webContents;
  const promoDisplay = (): Promise<string> =>
    pageWc.executeJavaScript("getComputedStyle(document.querySelector('.promo')).display") as Promise<string>;
  win.activate(adTab.id);
  win.loadUrl(adTab.id, `${site}picker`);
  await waitForLoad(pageWc);
  await sleep(300);
  const picking = ctx.adblock.pickElement(win, adTab);
  await untilJs(pageWc, "document.querySelector('corvus-element-picker')");
  const promo = (await pageWc.executeJavaScript(
    "(() => { const r = document.querySelector('.promo').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 20) }; })()",
  )) as { x: number; y: number };
  pageWc.sendInputEvent({ type: "mouseMove", x: promo.x, y: promo.y });
  pageWc.sendInputEvent({ type: "mouseDown", x: promo.x, y: promo.y, button: "left", clickCount: 1 });
  pageWc.sendInputEvent({ type: "mouseUp", x: promo.x, y: promo.y, button: "left", clickCount: 1 });
  await sleep(300);
  await capture("element-picker", pageWc);
  pageWc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  const rule = await picking;
  const hiddenNow = await promoDisplay();
  const keepShown = (await pageWc.executeJavaScript("getComputedStyle(document.getElementById('keep')).display")) as string;
  check("hide this element saves a site rule and hides it at once", rule === "corvus-smoke.test##div.promo" && hiddenNow === "none" && keepShown !== "none", {
    rule,
    hiddenNow,
    keepShown,
    filters: profile.adblock.userFilters(),
  });
  win.loadUrl(adTab.id, `${site}picker`);
  await waitForLoad(pageWc);
  await sleep(800);
  check("a hidden element stays hidden after a reload", (await promoDisplay()) === "none");
  const cancelling = ctx.adblock.pickElement(win, adTab);
  await untilJs(pageWc, "document.querySelector('corvus-element-picker')");
  pageWc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  const cancelled = await cancelling;
  check("escape cancels the picker without a rule", cancelled === null && profile.adblock.userFilters().length === 1, profile.adblock.userFilters());
  profile.adblock.setUserFilters("");
  win.loadUrl(adTab.id, `${site}picker`);
  await waitForLoad(pageWc);
  await sleep(800);
  check("removing the rule shows the element again", (await promoDisplay()) !== "none");

  const adblockSettings = win.createTab("corvus://settings/#adblock");
  await sleep(1500);
  check("settings adblock section", (await adblockSettings.view.webContents.executeJavaScript("Boolean(document.querySelector('#adblock'))")) === true);
  await capture("settings-adblock", adblockSettings.view.webContents);
  win.closeTab(adblockSettings.id);
  win.closeTab(adTab.id);

  // ------------------------------------------------------------------ settings: site permissions
  const settings = win.createTab("corvus://settings/#site-permissions");
  await sleep(1500);
  check("settings site permissions list", (await settings.view.webContents.executeJavaScript("document.querySelectorAll('.site-entry').length")) >= 1);
  await capture("settings-site-permissions", settings.view.webContents);
  win.closeTab(settings.id);

  // ------------------------------------------------------------------ session save / restore
  const group = win.createGroup([userTab.id, sibling.id], { title: "Session", color: "purple" });
  ctx.sessionRestore.save();
  const file = path.join(app.getPath("userData"), "session.json");
  const snapshot = reviveSession(JSON.parse(fs.readFileSync(file, "utf8")));
  const savedWindow = snapshot?.windows.find((w) => w.tabs.some((t) => t.url === `${url}find`));
  check(
    "session saved",
    Boolean(group && savedWindow?.groups.some((g) => g.title === "Session" && g.color === "purple")),
    savedWindow && { tabs: savedWindow.tabs.length, groups: savedWindow.groups },
  );
  if (snapshot && savedWindow) {
    const restored = ctx.sessionRestore.restore({ ...snapshot, windows: [savedWindow] })[0];
    await sleep(800);
    const urls = restored?.listTabs().map((t) => t.url) ?? [];
    const groups = restored?.listGroups() ?? [];
    const lazy = restored ? restored.tabIds().filter((id) => restored.getTab(id)?.pendingUrl !== undefined).length : 0;
    check(
      "session restore round-trip",
      JSON.stringify(urls) === JSON.stringify(savedWindow.tabs.map((t) => t.url)) &&
        groups.some((g) => g.title === "Session" && g.color === "purple") &&
        lazy === savedWindow.tabs.length - 1,
      { tabs: urls.length, groups: groups.map((g) => g.title), lazy },
    );
    restored?.close();
    await sleep(300);
  }
}
