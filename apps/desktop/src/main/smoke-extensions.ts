import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { nativeImage, type WebContents } from "electron";
import type { AppContext } from "./context";
import { setInstallPrompt, type ExtensionHost, type InstallRequest } from "./extensions";
import type { BrowserWindowCtl } from "./window";

export interface SmokeHelpers {
  check(name: string, ok: boolean, detail?: unknown): void;
  capture(name: string, wc: WebContents): Promise<void>;
  log(step: string, data: unknown): void;
}

interface ProbeEvent {
  type: string;
  data: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 200): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // keep polling
    }
    await sleep(intervalMs);
  }
  return undefined;
}

const FIXTURE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Extension fixture</title></head>
<body style="background:#ffffff;color:#111111;font:16px sans-serif"><h1>Extension fixture</h1><p>Plain page for content scripts.</p>
<script>window.__dnr = "pending";</script>
<script src="/blocked-by-probe.js" onload="window.__dnr='loaded'" onerror="window.__dnr='blocked'"></script>
<script src="/blocked-dynamic.js" onload="window.__dnrDynamic='loaded'" onerror="window.__dnrDynamic='blocked'"></script>
</body></html>`;

/**
 * Loads well-known ad/tracker resources and classifies each one. Content blockers either block a
 * request (error) or redirect it to a harmless surrogate shipped with the extension (uBlock Origin
 * Lite does this for adsbygoogle.js and gpt.js, so `onload` fires). A surrogate leaves no resource
 * timing entry under the original URL, a real network load does: "loaded" means the ad server was
 * actually reached. Resolves to { [name]: "blocked" | "surrogate" | "loaded" }.
 */
const AD_PROBE = `(async () => {
  const classify = (url, ok) => (!ok ? "blocked" : performance.getEntriesByName(url).length > 0 ? "loaded" : "surrogate");
  const script = (url) => new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = () => resolve(classify(url, true));
    s.onerror = () => resolve(classify(url, false));
    document.head.appendChild(s);
  });
  const image = (url) => new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve(classify(url, true));
    i.onerror = () => resolve(classify(url, false));
    i.src = url;
  });
  const xhr = (url) => fetch(url, { cache: "no-store" }).then((r) => (r.url.startsWith("chrome-extension:") ? "surrogate" : "loaded"), () => "blocked");
  const probes = {
    "googlesyndication adsbygoogle.js": script("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"),
    "googlesyndication show_ads_impl.js": script("https://pagead2.googlesyndication.com/pagead/managed/js/adsense/m202410100101/show_ads_impl.js"),
    "googlesyndication xhr": xhr("https://pagead2.googlesyndication.com/getconfig/sodar?sv=200"),
    "doubleclick gpt.js": script("https://securepubads.g.doubleclick.net/tag/js/gpt.js"),
    "doubleclick dc.js": script("https://stats.g.doubleclick.net/dc.js"),
    "doubleclick image": image("https://ad.doubleclick.net/ddm/ad/corvus-smoke.gif"),
  };
  const out = {};
  for (const [name, p] of Object.entries(probes)) out[name] = await Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), 15000))]);
  return out;
})()`;

const ADS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Ad fixture</title></head><body><h1>Ad fixture</h1>
<script>window.__control = "pending";</script>
<script src="/control.js" onload="window.__control='loaded'" onerror="window.__control='blocked'"></script>
</body></html>`;

function adsStopped(results: unknown): boolean {
  const values = Object.values((results ?? {}) as Record<string, string>);
  return values.length > 0 && values.every((v) => v === "blocked" || v === "surrogate");
}

function probeFiles(server: string): Record<string, string> {
  const sw = `
const SERVER = ${JSON.stringify(server)};
const report = (type, data) => fetch(SERVER + "/probe", { method: "POST", body: JSON.stringify({ type, data }) }).catch(() => {});
const NS = ["action","alarms","bookmarks","commands","contextMenus","cookies","declarativeNetRequest","downloads","history","i18n","idle",
  "management","notifications","offscreen","permissions","privacy","proxy","runtime","scripting","search","sessions","sidePanel","storage",
  "tabGroups","tabs","topSites","tts","webNavigation","webRequest","windows","identity","system","fontSettings","declarativeContent"];
report("apis", Object.fromEntries(NS.map((n) => [n, typeof chrome[n]])));
const desc = (n) => { const d = Object.getOwnPropertyDescriptor(chrome, n); return d ? [d.configurable, d.writable, d.enumerable, typeof d.get].join("/") : "none"; };
report("chrome-object", { frozen: Object.isFrozen(chrome), action: desc("action"), tabs: desc("tabs"), runtime: desc("runtime"), keys: Object.getOwnPropertyNames(chrome).join(",") });
report("storage", { local: typeof chrome.storage?.local, session: typeof chrome.storage?.session, sync: typeof chrome.storage?.sync, managed: typeof chrome.storage?.managed });
(async () => {
  const dnr = chrome.declarativeNetRequest;
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = "error: " + ((e && e.message) || e); } };
  await step("enabledRulesets", () => dnr.getEnabledRulesets());
  await step("availableStaticRuleCount", () => dnr.getAvailableStaticRuleCount());
  await step("updateDynamicRules", () => dnr.updateDynamicRules({ addRules: [{ id: 7, priority: 1, action: { type: "block" }, condition: { urlFilter: "blocked-dynamic", resourceTypes: ["script", "xmlhttprequest", "image"] } }], removeRuleIds: [7] }).then(() => "ok"));
  await step("dynamicRules", () => dnr.getDynamicRules().then((r) => r.length));
  await step("isRegexSupported", () => dnr.isRegexSupported({ regex: "a+b" }));
  report("dnr", out);
})();
chrome.tabs.onCreated.addListener((t) => report("tabs.onCreated", { id: t.id, url: t.url || t.pendingUrl, windowId: t.windowId }));
chrome.tabs.onUpdated.addListener((id, info, t) => {
  if (info.status === "complete") report("tabs.onUpdated", { id, url: t && t.url, index: t && t.index, windowId: t && t.windowId });
  if (info.status === "complete" && t && t.url && t.url.includes("/run-security")) runSecurity(id);
});
chrome.tabs.onRemoved.addListener((id, info) => report("tabs.onRemoved", { id, windowId: info.windowId }));
chrome.tabs.onActivated.addListener((info) => report("tabs.onActivated", info));
if (chrome.windows) chrome.windows.onCreated.addListener((w) => report("windows.onCreated", { id: w.id }));
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "content") report("content", { url: msg.url, tabId: sender.tab && sender.tab.id });
  sendResponse({ ok: true });
});
async function attempt(name, fn) {
  try { const v = await fn(); return { name, ok: v !== undefined && v !== null, value: v === undefined ? null : JSON.stringify(v).slice(0, 300) }; }
  catch (e) { return { name, ok: false, error: String((e && e.message) || e) }; }
}
async function runSecurity(fixtureTabId) {
  const tabs = await chrome.tabs.query({});
  const results = [{ name: "tab urls", ok: true, value: JSON.stringify(tabs.map((t) => t.url)) }];
  for (const t of tabs.filter((t) => (t.url || "").startsWith("corvus:"))) {
    results.push(await attempt("scripting.executeScript " + t.url, () => chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => location.href + "|" + typeof window.corvusInternal })));
    results.push(await attempt("scripting.insertCSS " + t.url, () => chrome.scripting.insertCSS({ target: { tabId: t.id }, css: "body{display:none}" }).then(() => "inserted")));
  }
  results.push(await attempt("tabs.create corvus://settings", () => chrome.tabs.create({ url: "corvus://settings/" })));
  results.push(await attempt("tabs.update corvus://settings", () => chrome.tabs.update(fixtureTabId, { url: "corvus://settings/" })));
  results.push(await attempt("windows.create corvus://settings", () => chrome.windows.create({ url: "corvus://settings/" })));
  results.push(await attempt("fetch corvus://settings", async () => { const r = await fetch("corvus://settings/"); return { status: r.status, type: r.type, body: (await r.text()).slice(0, 40) }; }));
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  results.push({ name: "active tab", ok: Boolean(active), value: JSON.stringify(active && { id: active.id, url: active.url, index: active.index }) });
  report("security", results);
}
`;
  return {
    "manifest.json": JSON.stringify(
      {
        manifest_version: 3,
        name: "Corvus Probe",
        version: "1.0.0",
        description: "Smoke-test extension: reports chrome.* availability, tab events and security probes.",
        background: { service_worker: "sw.js" },
        action: { default_popup: "popup.html", default_title: "Corvus Probe", default_icon: { "16": "icon.png", "32": "icon.png" } },
        icons: { "32": "icon.png", "48": "icon.png" },
        options_page: "options.html",
        permissions: [
          "storage",
          "tabs",
          "scripting",
          "alarms",
          "contextMenus",
          "notifications",
          "webNavigation",
          "declarativeNetRequest",
          "offscreen",
          "idle",
          "downloads",
          "history",
          "bookmarks",
          "cookies",
          "webRequest",
        ],
        host_permissions: ["<all_urls>"],
        content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], run_at: "document_end" }],
        declarative_net_request: { rule_resources: [{ id: "probe", enabled: true, path: "rules.json" }] },
      },
      null,
      2,
    ),
    "sw.js": sw,
    "content.js": `document.documentElement.dataset.corvusProbe = "1";
chrome.runtime.sendMessage({ type: "content", url: location.href }).catch(() => {});`,
    "popup.html": `<!doctype html><html><head><meta charset="utf-8"><title>Probe popup</title>
<style>body{font:14px sans-serif;width:280px;margin:14px;color:#111;background:#fff}h1{font-size:18px;margin:0 0 8px}</style></head>
<body><h1>Corvus Probe</h1><p>Active tab:</p><p id="tab">…</p><script src="popup.js"></script></body></html>`,
    "popup.js": `chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => { document.getElementById("tab").textContent = t ? t.url : "no tab"; });`,
    "options.html": `<!doctype html><html><head><meta charset="utf-8"><title>Probe options</title></head><body><h1>Probe options</h1></body></html>`,
    "rules.json": JSON.stringify([
      { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "blocked-by-probe", resourceTypes: ["script", "xmlhttprequest", "image"] } },
    ]),
  };
}

function writeProbe(server: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-probe-"));
  for (const [name, content] of Object.entries(probeFiles(server))) fs.writeFileSync(path.join(dir, name), content);
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) pixels.set([0xd6, 0x5b, 0x5b, 0xff], i * 4); // BGRA
  fs.writeFileSync(path.join(dir, "icon.png"), nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }).toPNG());
  return dir;
}

interface PopupHandle {
  browserWindow?: Electron.BrowserWindow;
  extensionId: string;
  whenReady(): Promise<void>;
  destroy(): void;
}

class PopupWatcher {
  private latest: PopupHandle | null = null;

  constructor(host: ExtensionHost) {
    host.api.on("browser-action-popup-created", (popup: PopupHandle) => {
      this.latest = popup;
    });
  }

  reset(): void {
    this.latest = null;
  }

  async next(extensionId: string, timeoutMs: number): Promise<PopupHandle | undefined> {
    return (await waitFor(() => (this.latest?.extensionId === extensionId ? this.latest : null), timeoutMs)) ?? undefined;
  }
}

async function chromeQuery<T>(win: BrowserWindowCtl, script: string): Promise<T> {
  return (await win.chrome.webContents.executeJavaScript(script)) as T;
}

async function clickAction(win: BrowserWindowCtl, id: string): Promise<boolean> {
  return chromeQuery<boolean>(
    win,
    `(() => { const b = document.querySelector('.ext-action[data-extension-id="${id}"]'); if (!b) return false; b.click(); return true; })()`,
  );
}

async function actionVisible(win: BrowserWindowCtl, id: string): Promise<boolean> {
  return chromeQuery<boolean>(win, `Boolean(document.querySelector('.ext-action[data-extension-id="${id}"]'))`);
}

function workerRunning(session: Electron.Session, id: string): boolean {
  return Object.values(session.serviceWorkers.getAllRunning()).some((w) => w.scope.startsWith(`chrome-extension://${id}/`));
}

/** Opens the action popup through the toolbar button, screenshots it and returns what it rendered. */
async function openPopup(
  h: SmokeHelpers,
  win: BrowserWindowCtl,
  popups: PopupWatcher,
  id: string,
  shot: string,
  settleMs: number,
): Promise<{ text: string; width: number; height: number } | null> {
  popups.reset();
  if (!(await clickAction(win, id))) return null;
  const popup = await popups.next(id, 8000);
  if (!popup?.browserWindow) return null;
  await Promise.race([popup.whenReady(), sleep(10_000)]);
  await sleep(settleMs);
  const bw = popup.browserWindow;
  if (!bw || bw.isDestroyed()) return null;
  const wc = bw.webContents;
  const text = String(await wc.executeJavaScript("document.body ? document.body.innerText : ''").catch(() => ""));
  const { width, height } = bw.getBounds();
  await h.capture(shot, wc);
  popup.destroy();
  return { text, width, height };
}

export async function runExtensionSmoke(ctx: AppContext, h: SmokeHelpers): Promise<void> {
  const events: ProbeEvent[] = [];
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    if (req.method === "POST" && url.pathname === "/probe") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        try {
          events.push(JSON.parse(body) as ProbeEvent);
        } catch {
          // ignore malformed reports
        }
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      });
      return;
    }
    const html = url.pathname === "/ads" ? ADS_PAGE : FIXTURE_PAGE;
    if (url.pathname.endsWith(".js")) {
      res.writeHead(200, { "Content-Type": "text/javascript" }).end("/* fixture */");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const prompts: InstallRequest[] = [];
  setInstallPrompt(async (request) => {
    prompts.push(request);
    h.log("install prompt", { id: request.id, name: request.name, warnings: request.warnings });
    return true;
  });

  try {
    const win = ctx.windows.target();
    const host = win.profile.extensions;
    await host.whenReady();
    const popups = new PopupWatcher(host);
    const session = win.profile.session;

    // ------------------------------------------------------------ probe (offline)
    // Under --no-sandbox Electron skips service-worker preloads (electron/electron#54322), so the
    // worker lacks electron-chrome-extensions' chrome.* APIs; those checks are skipped, not failed.
    const sandboxed = process.env.CORVUS_SMOKE_NO_SANDBOX !== "1";
    const swCheck = (name: string, ok: boolean, detail?: unknown): void => {
      if (sandboxed) h.check(name, ok, detail);
      else h.log(`SKIP ${name}`, "needs the Chromium sandbox (electron/electron#54322); run with --cap-add SYS_ADMIN");
    };
    const probeDir = writeProbe(origin);
    const probe = await host.loadUnpacked(probeDir);
    const id = probe.id;
    h.check("ext: load unpacked", probe.enabled && probe.source === "unpacked", { id, warnings: probe.warnings, unsupported: probe.unsupported });
    h.check("ext: permission warnings computed", probe.warnings.includes("Read and change all your data on all websites"), probe.warnings);

    const worker = await waitFor(() => workerRunning(session, id), 10_000);
    swCheck("ext: MV3 service worker running", worker === true);
    const apis = await waitFor(() => events.find((e) => e.type === "apis"), 10_000);
    h.log("probe chrome.* namespaces", apis?.data ?? null);
    h.log("probe chrome.storage areas", events.find((e) => e.type === "storage")?.data ?? null);
    h.log("probe chrome object", events.find((e) => e.type === "chrome-object")?.data ?? null);
    h.log("probe errors", host.info(id)?.errors.map((e) => `${e.source}: ${e.message}`) ?? []);

    const visible = await waitFor(() => actionVisible(win, id), 6000);
    h.check("ext: action button pinned in toolbar", visible === true);
    await h.capture("chrome-extensions-toolbar", win.chrome.webContents);

    // Corvus's built-in blocker takes over request handling (webRequest), which supersedes an
    // extension's declarativeNetRequest. Disable it here so this check exercises extension DNR
    // in isolation; it's re-enabled afterwards. (In normal use the built-in blocker is the filter.)
    const adblockWasEnabled = win.profile.adblock.settings().enabled;
    win.profile.adblock.setEnabled(false);
    const page = win.createTab(`${origin}/page`);
    await waitFor(() => page.view.webContents.executeJavaScript("document.readyState === 'complete' && document.documentElement.dataset.corvusProbe === '1'"), 8000);
    const marker = await page.view.webContents.executeJavaScript("document.documentElement.dataset.corvusProbe || null");
    h.check("ext: content script runs on web page", marker === "1", marker);
    const contentReport = await waitFor(() => events.find((e) => e.type === "content" && String((e.data as { url: string }).url).includes("/page")), 5000);
    swCheck("ext: content script -> service worker messaging", Boolean(contentReport), contentReport?.data);
    h.log("probe declarativeNetRequest", events.find((e) => e.type === "dnr")?.data ?? null);
    h.log("dynamic rule result", await page.view.webContents.executeJavaScript("window.__dnrDynamic"));
    const dnr = await page.view.webContents.executeJavaScript("window.__dnr");
    swCheck("ext: declarativeNetRequest static rule blocks request", dnr === "blocked" && !hits.get("/blocked-by-probe.js"), {
      dnr,
      serverHits: hits.get("/blocked-by-probe.js") ?? 0,
    });
    win.profile.adblock.setEnabled(adblockWasEnabled);

    const popup = await openPopup(h, win, popups, id, "ext-probe-popup", 800);
    h.check("ext: popup opens and renders", Boolean(popup && popup.text.includes("Corvus Probe") && popup.text.includes("/page")), popup);

    // chrome.tabs reflects agent-driven tabs
    const agentTab = await ctx.controller.openTab(`${origin}/agent`);
    const agentWc = ctx.windows.findTab(agentTab.id)?.tab.view.webContents;
    const seen = await waitFor(
      () => events.find((e) => e.type === "tabs.onUpdated" && String((e.data as { url?: string }).url ?? "").includes("/agent")),
      8000,
    );
    swCheck("ext: chrome.tabs.onUpdated sees agent tab", Boolean(seen) && (seen?.data as { id: number }).id === agentWc?.id, seen?.data);
    win.activate(page.id);
    const activated = await waitFor(() => events.find((e) => e.type === "tabs.onActivated" && (e.data as { tabId: number }).tabId === page.view.webContents.id), 5000);
    swCheck("ext: chrome.tabs.onActivated on tab switch", Boolean(activated), activated?.data);
    await ctx.controller.closeTab(agentTab.id);
    const removed = await waitFor(() => events.find((e) => e.type === "tabs.onRemoved" && (e.data as { id: number }).id === agentWc?.id), 5000);
    swCheck("ext: chrome.tabs.onRemoved on agent tab close", Boolean(removed), removed?.data);

    // security: corvus:// pages are off limits
    const settingsTab = win.createTab("corvus://settings/");
    await sleep(1200);
    const fixture = win.createTab(`${origin}/run-security`);
    const security = await waitFor(() => events.find((e) => e.type === "security"), 10_000);
    const results = (security?.data ?? []) as Array<{ name: string; ok: boolean; value?: string; error?: string }>;
    h.log("probe security results", results);
    const attempts = results.filter((r) => /corvus:\/\//.test(r.name) && r.name !== "tab urls");
    swCheck(
      "ext: cannot script, navigate to or read corvus:// pages",
      security !== undefined && attempts.length >= 5 && attempts.every((r) => !r.ok || r.name.startsWith("fetch")) &&
        !attempts.some((r) => r.name.startsWith("fetch") && r.ok && String(r.value).includes('"status":200') && !String(r.value).includes('"body":""')),
      attempts,
    );
    const contentOnInternal = events.some((e) => e.type === "content" && String((e.data as { url: string }).url).startsWith("corvus:"));
    h.check("ext: content scripts never run on corvus:// pages", !contentOnInternal);
    const tabUrls = results.find((r) => r.name === "tab urls")?.value ?? "";
    swCheck("ext: chrome UI is not an extension-visible tab", security !== undefined && !tabUrls.includes("corvus://chrome"), tabUrls);
    const settingsStill = settingsTab.view.webContents.getURL();
    h.check("ext: settings tab untouched", settingsStill.startsWith("corvus://settings"), settingsStill);
    win.closeTab(settingsTab.id);
    win.closeTab(fixture.id);

    // options page in a tab
    await host.openOptions(id);
    const optionsTab = await waitFor(() => win.activeTab()?.view.webContents.getURL().startsWith(`chrome-extension://${id}/options.html`) && win.activeTab(), 5000);
    const optionsTitle = optionsTab ? await waitFor(() => optionsTab.view.webContents.executeJavaScript("document.title"), 5000) : null;
    h.check("ext: options page opens in a tab", optionsTitle === "Probe options", optionsTitle);
    if (optionsTab) win.closeTab(optionsTab.id);

    // puzzle menu, unpin
    host.setPinned(id, false);
    const unpinned = await waitFor(async () => !(await actionVisible(win, id)), 4000);
    h.check("ext: unpin removes toolbar button", unpinned === true);
    await chromeQuery(win, "document.querySelector('.ext-puzzle').click()");
    const inMenu = await waitFor(() => chromeQuery<boolean>(win, `Boolean(document.querySelector('.ext-menu-row[data-extension-id="${id}"]'))`), 3000);
    h.check("ext: puzzle menu lists unpinned extension", inMenu === true);
    await sleep(300);
    await h.capture("chrome-extensions-menu", win.chrome.webContents);
    await chromeQuery(win, "document.querySelector('.ext-menu-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
    host.setPinned(id, true);

    // disable / enable
    await host.setEnabled(id, false);
    const disabled = host.list().find((e) => e.id === id);
    h.check("ext: disable unloads extension", disabled?.enabled === false && session.extensions.getExtension(id) === null);
    const goneFromToolbar = await waitFor(async () => !(await actionVisible(win, id)), 4000);
    h.check("ext: disabled extension leaves toolbar", goneFromToolbar === true);
    const plain = win.createTab(`${origin}/plain`);
    await waitFor(() => plain.view.webContents.executeJavaScript("document.readyState === 'complete'"), 5000);
    await sleep(500);
    const markerDisabled = await plain.view.webContents.executeJavaScript("document.documentElement.dataset.corvusProbe || null");
    h.check("ext: disabled extension injects no content script", markerDisabled === null, markerDisabled);
    win.closeTab(plain.id);
    await host.setEnabled(id, true);
    const reenabled = await waitFor(() => workerRunning(session, id), 8000);
    swCheck("ext: re-enable reloads and restarts worker", host.list().find((e) => e.id === id)?.enabled === true && reenabled === true);

    // extensions page
    const extPage = win.createTab("corvus://extensions/");
    const card = await waitFor(() => extPage.view.webContents.executeJavaScript(`Boolean(document.querySelector('.ext-card[data-extension-id="${id}"]'))`), 5000);
    h.check("ext: corvus://extensions shows the card", card === true);
    await h.capture("extensions-installed", extPage.view.webContents);
    win.closeTab(extPage.id);

    // per-profile isolation
    const other = ctx.profiles.create("Smoke isolation");
    const otherRuntime = ctx.profiles.get(other.id);
    await otherRuntime.extensions.whenReady();
    h.check(
      "ext: other profile does not see the extension",
      otherRuntime.extensions.list().length === 0 && otherRuntime.session.extensions.getAllExtensions().length === 0,
      otherRuntime.extensions.list().map((e) => e.id),
    );
    await ctx.profiles.remove(other.id);

    if (process.env.CORVUS_SMOKE_CWS === "1") await runStoreSmoke(ctx, h, win, host, popups, origin, prompts);

    await host.remove(id);
    h.check("ext: remove", !host.list().some((e) => e.id === id) && session.extensions.getExtension(id) === null);
    win.closeTab(page.id);
    fs.rmSync(probeDir, { recursive: true, force: true });
  } finally {
    server.close();
  }
}

interface StoreTarget {
  id: string;
  slug: string;
  name: string;
}

const STORE_TARGETS: StoreTarget[] = [
  { id: "ddkjiahejlhfcafbddmgiahcphecmpfh", slug: "ublock-lite", name: "uBlock Origin Lite" },
  { id: "eimadpbcbfnmbkopoojfekhnkhdbieeh", slug: "darkreader", name: "Dark Reader" },
  { id: "nngceckbapebfimnlniiiahkandclblb", slug: "bitwarden", name: "Bitwarden" },
];

/** Live Chrome Web Store installs (CORVUS_SMOKE_CWS=1): needs network access. */
async function runStoreSmoke(
  ctx: AppContext,
  h: SmokeHelpers,
  win: BrowserWindowCtl,
  host: ExtensionHost,
  popups: PopupWatcher,
  origin: string,
  prompts: InstallRequest[],
): Promise<void> {
  // Without a content blocker these should all be "loaded" (shows the network reaches the ad servers).
  const baselineTab = win.createTab(`${origin}/ads`);
  await waitFor(() => baselineTab.view.webContents.executeJavaScript("document.readyState === 'complete'"), 10_000);
  h.log("cws: ad requests before any blocker", await baselineTab.view.webContents.executeJavaScript(AD_PROBE).catch((err: unknown) => String(err)));
  win.closeTab(baselineTab.id);

  for (const target of STORE_TARGETS) {
    const label = `cws ${target.slug}`;
    const started = Date.now();
    let info;
    try {
      info = await host.installFromStore(target.id, win.win);
    } catch (err) {
      h.check(`${label}: install`, false, (err as Error).message);
      continue;
    }
    const prompt = prompts.find((p) => p.id === target.id);
    h.check(`${label}: install`, info?.enabled === true, { version: info?.version, ms: Date.now() - started, warnings: prompt?.warnings });
    if (!info) continue;
    h.log(`${label}: manifest`, { mv: info.manifestVersion, permissions: info.permissions, unsupported: info.unsupported });
    const needsWorker = info.manifestVersion === 3;
    if (needsWorker) {
      const running = await waitFor(() => workerRunning(win.profile.session, target.id), 15_000);
      h.check(`${label}: service worker running`, running === true);
    }
    const visible = info.hasAction ? await waitFor(() => actionVisible(win, target.id), 6000) : false;
    h.check(`${label}: toolbar action`, visible === true);
    await sleep(2500);
    const popup = visible ? await openPopup(h, win, popups, target.id, `cws-${target.slug}-popup`, 3500) : null;
    h.check(`${label}: popup renders`, Boolean(popup && popup.text.trim().length > 0 && popup.width > 50 && popup.height > 50), popup && {
      width: popup.width,
      height: popup.height,
      text: popup.text.slice(0, 160),
    });

    if (target.slug === "darkreader") {
      const tab = win.createTab(`${origin}/plain-dark`);
      await waitFor(() => tab.view.webContents.executeJavaScript("document.readyState === 'complete'"), 8000);
      const styled = await waitFor(
        () =>
          tab.view.webContents.executeJavaScript(
            "Boolean(document.querySelector('style.darkreader') || document.documentElement.hasAttribute('data-darkreader-mode') || document.documentElement.hasAttribute('data-darkreader-scheme'))",
          ),
        10_000,
      );
      const background = await tab.view.webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor");
      h.check(`${label}: content script restyles page`, styled === true, { background });
      await h.capture(`cws-${target.slug}-page`, tab.view.webContents);
      win.closeTab(tab.id);
    }
    if (target.slug === "ublock-lite") {
      const dash = win.createTab(`chrome-extension://${target.id}/dashboard.html`);
      await waitFor(() => dash.view.webContents.executeJavaScript("document.readyState === 'complete'"), 8000);
      const rulesets = await dash.view.webContents
        .executeJavaScript(
          "Promise.all([chrome.declarativeNetRequest.getEnabledRulesets(), chrome.declarativeNetRequest.getDynamicRules().then(r => r.length), chrome.declarativeNetRequest.getSessionRules().then(r => r.length)])",
        )
        .catch((err: unknown) => String(err));
      h.log(`${label}: enabled rulesets / dynamic / session rules`, rulesets);
      const sample = await dash.view.webContents
        .executeJavaScript(
          "chrome.declarativeNetRequest.getSessionRules().then(r => { const c = {}; for (const x of r) c[x.action.type] = (c[x.action.type]||0)+1; return { types: c, allow: r.filter(x => x.action.type.startsWith('allow')).slice(0,3) }; })",
        )
        .catch((err: unknown) => String(err));
      h.log(`${label}: session rule sample`, sample);
      win.closeTab(dash.id);
      const tab = win.createTab(`${origin}/ads`);
      await waitFor(() => tab.view.webContents.executeJavaScript("document.readyState === 'complete'"), 10_000);
      const ads = await tab.view.webContents.executeJavaScript(AD_PROBE).catch((err: unknown) => String(err));
      const control = await tab.view.webContents.executeJavaScript("window.__control");
      h.check(`${label}: blocks doubleclick/googlesyndication (local fixture)`, adsStopped(ads) && control === "loaded", { ads, control });
      await h.capture(`cws-${target.slug}-ads`, tab.view.webContents);
      win.closeTab(tab.id);
      const real = win.createTab("https://example.com/");
      await waitFor(() => real.view.webContents.executeJavaScript("document.readyState === 'complete'"), 15_000);
      const onReal = await real.view.webContents.executeJavaScript(AD_PROBE).catch((err: unknown) => String(err));
      h.check(`${label}: blocks doubleclick/googlesyndication (example.com)`, adsStopped(onReal), onReal);
      win.closeTab(real.id);
    }
    const after = host.info(target.id);
    h.log(`${label}: errors`, (after?.errors ?? []).slice(0, 8).map((e) => `${e.source}: ${e.message.slice(0, 240)}`));
  }

  const update = await host.checkForUpdates().catch((err: unknown) => ({ error: (err as Error).message }));
  h.check("cws: update check", !("error" in update), update);
  const removedProfile = ctx.profiles.create("Smoke CWS isolation");
  const runtime = ctx.profiles.get(removedProfile.id);
  await runtime.extensions.whenReady();
  h.check("cws: other profile isolated", runtime.extensions.list().length === 0);
  await ctx.profiles.remove(removedProfile.id);
}
