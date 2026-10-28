import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface ConsentSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 12_000): Promise<boolean> {
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

function waitForLoad(wc: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    wc.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const html = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

// OneTrust's banner as sites ship it (ids and buttons from its SDK): "Reject All" stores the choice
// in the OptanonConsent cookie with every optional group off, as OneTrust does, and closes the banner.
const ONETRUST_PAGE = html(
  "OneTrust",
  `<h1>Article</h1><p>Text of the article.</p>
<div id="onetrust-consent-sdk">
  <div id="onetrust-banner-sdk" class="otFlat" role="region" aria-label="Cookie banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:16px;border-top:1px solid #ccc">
    <div id="onetrust-policy-text">We use cookies to personalise ads and measure you.</div>
    <div id="onetrust-button-group">
      <button id="onetrust-pc-btn-handler">Cookie Settings</button>
      <button id="onetrust-reject-all-handler">Reject All</button>
      <button id="onetrust-accept-btn-handler">Accept All Cookies</button>
    </div>
  </div>
</div>
<script>
  function decide(groups) {
    document.cookie = "OptanonConsent=isGpcEnabled=1&groups=" + encodeURIComponent(groups) + "; path=/";
    document.cookie = "OptanonAlertBoxClosed=" + new Date().toISOString() + "; path=/";
    document.getElementById("onetrust-banner-sdk").style.display = "none";
  }
  document.getElementById("onetrust-reject-all-handler").addEventListener("click", function () { decide("C0001:1,C0002:0,C0003:0,C0004:0"); });
  document.getElementById("onetrust-accept-btn-handler").addEventListener("click", function () { decide("C0001:1,C0002:1,C0003:1,C0004:1"); });
</script>`,
);

// Didomi's notice without a "disagree" button: Autoconsent answers through Didomi's own JavaScript
// API in the page (its EVAL_DIDOMI_OPT_OUT snippet), which tests the main-world bridge.
const DIDOMI_PAGE = html(
  "Didomi",
  `<h1>News</h1>
<div id="didomi-host"><div id="didomi-notice" class="didomi-notice-banner" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:16px">
  We and our 812 partners store data. <button id="didomi-notice-agree-button">Agree and close</button>
</div></div>
<script>
  window.Didomi = {
    setUserDisagreeToAll: function () {
      document.cookie = "didomi_token=rejected; path=/";
      document.getElementById("didomi-host").innerHTML = "";
    },
    setUserAgreeToAll: function () { document.cookie = "didomi_token=accepted; path=/"; },
  };
</script>`,
);

/**
 * Cookie banners and Global Privacy Control: a OneTrust banner is rejected (its "Reject All" is
 * clicked), a Didomi notice through its page API, the shield names them, a site's exception leaves
 * its banner alone, and GPC goes out as a header and shows in every frame (also a cross-site one).
 */
export async function runCookieConsentSmoke(ctx: AppContext, { win, check, capture }: ConsentSmokeHelpers): Promise<void> {
  const profile = win.profile;
  const gpcHeaders: Array<{ path: string; gpc: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    gpcHeaders.push({ path, gpc: req.headers["sec-gpc"] as string | undefined });
    const send = (body: string, type = "text/html; charset=utf-8"): void => {
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
    };
    if (path === "/onetrust") return send(ONETRUST_PAGE);
    if (path === "/didomi") return send(DIDOMI_PAGE);
    if (path === "/pixel.gif") return send("GIF89a", "image/gif");
    if (path === "/gpc-frame") return send(html("Frame", "<p>frame</p>"));
    if (path === "/gpc") {
      const port = (server.address() as AddressInfo).port;
      return send(html("GPC", `<p>GPC</p><img src="/pixel.gif" alt=""><iframe id="f" src="http://localhost:${port}/gpc-frame"></iframe>`));
    }
    send(html("Other", "<p>other</p>"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const optanon = "decodeURIComponent((document.cookie.match(/OptanonConsent=([^;]*)/) || [])[1] || '')";

  try {
    // ------------------------------------------------------------------ OneTrust: "Reject All"
    const tab = win.createTab(`${base}/onetrust`);
    win.activate(tab.id);
    const wc = tab.view.webContents;
    await waitForLoad(wc);
    const rejected = await poll(wc, `${optanon}.includes('C0002:0')`);
    const cookie = await wc.executeJavaScript(optanon).catch(() => null);
    check("cookie banner: OneTrust's Reject All is clicked (every optional group off)", rejected && !String(cookie).includes(":1,C0002:1"), cookie);
    const shown = await waitFor(() => win.state().adblock.cookieBanner);
    check("cookie banner: the shield names the rejected platform", shown?.outcome === "rejected" && shown.cmp === "OneTrust", win.state().adblock);
    check("cookie banner: rejected banners count in the shield's stats", win.state().adblock.bannersHandled >= 1, win.state().adblock.bannersHandled);
    const bannerGone = await poll(wc, "getComputedStyle(document.getElementById('onetrust-banner-sdk')).display === 'none'", 3000);
    check("cookie banner: the banner is gone", bannerGone);
    const chrome = win.chrome.webContents;
    await chrome.executeJavaScript("document.querySelector('.shield-btn')?.click()");
    const line = await poll(chrome, "document.querySelector('.shield-popover [data-cookie-banner=rejected]')?.textContent.includes('OneTrust') && document.querySelector('.shield-popover [data-allow-cookie-banner]')", 3000);
    check("cookie banner: the shield popover says the banner was rejected, with the switch for the site", line);
    await capture("cookie-banner-shield", chrome);
    win.sendCommand({ type: "close-overlays" });

    // ------------------------------------------------------------------ agents see the page without it
    const agentTab = await ctx.controller.openTab(`${base}/onetrust?agent`);
    const agentWc = ctx.windows.findTab(agentTab.id)?.tab.view.webContents;
    const agentRejected = agentWc ? await poll(agentWc, `${optanon}.includes('C0002:0') && getComputedStyle(document.getElementById('onetrust-banner-sdk')).display === 'none'`) : false;
    const snap = await ctx.controller.snapshot(agentTab.id, { maxChars: 4000 });
    check(
      "cookie banner: an agent's snapshot shows the page without the dismissed banner (text or buttons)",
      agentRejected &&
        snap.text.includes("Text of the article") &&
        !snap.text.includes("We use cookies") &&
        !snap.elements.some((e) => /Reject All|Accept All/.test(e.name ?? "")),
      {
        text: snap.text,
        elements: snap.elements.map((e) => e.name),
        agentRejected,
        found: Boolean(agentWc),
        sameSession: agentWc?.session === profile.session,
        page: agentWc ? await agentWc.executeJavaScript("({ url: location.href, display: getComputedStyle(document.getElementById('onetrust-banner-sdk')).display, gpc: navigator.globalPrivacyControl })").catch((e) => String(e)) : null,
        banner: agentWc ? profile.adblock.barState(agentWc) : null,
      },
    );
    await ctx.controller.closeTab(agentTab.id);

    // ------------------------------------------------------------------ Didomi: through its page API
    win.loadUrl(tab.id, `${base}/didomi`);
    await waitForLoad(wc);
    const didomi = await poll(wc, "document.cookie.includes('didomi_token=rejected')");
    check("cookie banner: Didomi is answered through its own API in the page (main-world snippet)", didomi, await wc.executeJavaScript("document.cookie").catch(() => null));
    check("cookie banner: the shield shows the Didomi rejection", (await waitFor(() => win.state().adblock.cookieBanner?.cmp === "Didomi")) === true, win.state().adblock);

    // ------------------------------------------------------------------ per-site exception
    await wc.executeJavaScript("document.cookie = 'OptanonConsent=; max-age=0; path=/'; document.cookie = 'OptanonAlertBoxClosed=; max-age=0; path=/'");
    win.loadUrl(tab.id, `${base}/onetrust`);
    await waitForLoad(wc);
    await poll(wc, `${optanon}.includes('C0002:0')`);
    await wc.executeJavaScript("document.cookie = 'OptanonConsent=; max-age=0; path=/'");
    win.activate(tab.id);
    win.allowCookieBanner(true);
    check("cookie banner: allowing a site's banner is saved", profile.adblock.consentAllowedSites().includes("127.0.0.1") && win.state().adblock.consentAllowed, profile.adblock.consentAllowedSites());
    await waitForLoad(wc);
    await sleep(3000);
    const untouched = await wc.executeJavaScript(`({ cookie: ${optanon}, display: getComputedStyle(document.getElementById('onetrust-banner-sdk')).display })`).catch(() => null);
    check(
      "cookie banner: a site with its banner allowed keeps it (nothing clicked, nothing hidden)",
      untouched?.cookie === "" && untouched.display !== "none" && win.state().adblock.cookieBanner === undefined,
      untouched,
    );
    win.allowCookieBanner(false);
    check("cookie banner: the exception can be removed", profile.adblock.consentAllowedSites().length === 0, profile.adblock.consentAllowedSites());
    await waitForLoad(wc);
    check("cookie banner: rejected again once the exception is gone", await poll(wc, `${optanon}.includes('C0002:0')`));

    // ------------------------------------------------------------------ the switch
    profile.adblock.setOptions({ cookieConsent: false });
    await wc.executeJavaScript("document.cookie = 'OptanonConsent=; max-age=0; path=/'");
    win.loadUrl(tab.id, `${base}/onetrust?off`);
    await waitForLoad(wc);
    await sleep(2500);
    check("cookie banner: with the setting off nothing is answered", (await wc.executeJavaScript(optanon).catch(() => "x")) === "" && win.state().adblock.cookieConsent === false);
    profile.adblock.setOptions({ cookieConsent: true });

    // ------------------------------------------------------------------ Global Privacy Control
    gpcHeaders.length = 0;
    win.loadUrl(tab.id, `${base}/gpc`);
    await waitForLoad(wc);
    await poll(wc, "document.getElementById('f').contentDocument === null");
    await waitFor(() => gpcHeaders.some((h) => h.path === "/gpc-frame") && gpcHeaders.some((h) => h.path === "/pixel.gif"), 5000);
    const topGpc = await wc.executeJavaScript("navigator.globalPrivacyControl").catch(() => null);
    const frame = wc.mainFrame.frames.find((f) => f.url.includes("/gpc-frame"));
    const frameGpc = frame ? await frame.executeJavaScript("navigator.globalPrivacyControl").catch(() => null) : null;
    check("GPC: navigator.globalPrivacyControl is true in the page and in a cross-site iframe", topGpc === true && frameGpc === true, { topGpc, frameGpc });
    const sent = (p: string): string | undefined => gpcHeaders.find((h) => h.path === p)?.gpc;
    check("GPC: Sec-GPC: 1 reaches the server for the page, its iframe and its images", sent("/gpc") === "1" && sent("/gpc-frame") === "1" && sent("/pixel.gif") === "1", gpcHeaders);

    profile.adblock.setOptions({ gpc: false });
    gpcHeaders.length = 0;
    win.loadUrl(tab.id, `${base}/gpc?off`);
    await waitForLoad(wc);
    const offGpc = await wc.executeJavaScript("navigator.globalPrivacyControl").catch(() => null);
    check("GPC: off sends no header and sets nothing in the page", offGpc === undefined && gpcHeaders.some((h) => h.path === "/gpc") && gpcHeaders.every((h) => h.gpc === undefined), { offGpc, gpcHeaders });
    profile.adblock.setOptions({ gpc: true });

    // ------------------------------------------------------------------ Settings
    const settings = win.createTab("corvus://settings/#adblock");
    await waitForLoad(settings.view.webContents);
    const toggles = await poll(settings.view.webContents, "[...document.querySelectorAll('#adblock .row')].some((r) => r.textContent.includes('Global Privacy Control'))", 6000);
    check("settings: cookie banner and GPC switches are shown", toggles);
    await capture("settings-cookie-consent", settings.view.webContents);
    win.closeTab(settings.id);
    win.closeTab(tab.id);
  } finally {
    profile.adblock.setOptions({ cookieConsent: true, gpc: true });
    for (const site of profile.adblock.consentAllowedSites()) profile.adblock.setConsentAllowed(site, false);
    server.close();
  }
}
