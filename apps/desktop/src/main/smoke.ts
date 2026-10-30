import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { app, webContents } from "electron";
import { decodePairing, linkOnlyReadingItem, newAsk, parseAsk, parseDeviceWatchStatus, stoppedAsk, type Ask, type SearchEvent } from "@corvus/shared";
import { createSyncClient } from "@corvus/sync-core";
import type { AppContext } from "./context";
import { runAgentSmoke } from "./smoke-agent";
import { runAgentRunsSmoke } from "./smoke-agent-runs";
import { runAnnotationsSmoke } from "./smoke-annotations";
import { runAuthenticatorImportSmoke } from "./smoke-authenticator-import";
import { runAssistSmoke } from "./smoke-assist";
import { runDictationSmoke } from "./smoke-dictation";
import { runDialogsSmoke } from "./smoke-dialogs";
import { runLibrarySmoke } from "./smoke-library";
import { runAssistAgentSmoke } from "./smoke-assist-agent";
import { runBrowserSmoke, serveBrowserSmokeRoute } from "./smoke-browser";
import { runCertErrorSmoke } from "./smoke-cert-errors";
import { runScheduledAgentSmoke } from "./smoke-scheduled";
import { runSplitSmoke } from "./smoke-split";
import { runTabCloseSmoke } from "./smoke-tab-close";
import { runUxSmoke, serveUxSmokeRoute } from "./smoke-ux";
import { runSignInSmoke, serveSignInSmokeRoute } from "./smoke-signin";
import { runNewTabSmoke } from "./smoke-newtab";
import { runChromeUiSmoke } from "./smoke-chrome-ui";
import { runBookmarksBarSmoke } from "./smoke-bookmarks-bar";
import { runSleepSmoke } from "./smoke-sleep";
import { runMediaSmoke, serveMediaSmokeRoute } from "./smoke-media";
import { runFlowsSmoke } from "./smoke-flows";
import { runWorkflowsSmoke } from "./smoke-workflows";
import { runSiteMemorySmoke } from "./smoke-site-memory";
import { runSyncLearnedSmoke } from "./smoke-sync-learned";
import { runBuiltinSyncSmoke } from "./smoke-builtin-sync";
import { runCredentialsSmoke, runSavePromptSmoke, serveCredentialsSmokeRoute } from "./smoke-credentials";
import { runFeaturesSmoke } from "./smoke-features";
import { runLocalModelsSmoke } from "./smoke-local-models";
import { narrowLayout, narrowWindow, runPairPhoneUiSmoke, runPairingAddressSmoke } from "./smoke-pairing";
import { runPhoneSmoke } from "./smoke-phone";
import { runConnectionsSmoke } from "./smoke-connections";
import { runPrivateSmoke } from "./smoke-private";
import { runCookieConsentSmoke } from "./smoke-cookie-consent";
import { runGrabberSmoke } from "./smoke-grabber";
import { runDefaultBrowserSmoke } from "./smoke-default-browser";
import { runBrowserImportSmoke } from "./smoke-browser-import";
import { runDownloadAiSmoke } from "./smoke-download-ai";
import { runProfileTransferSmoke } from "./smoke-profile-transfer";
import { runPdfSmoke } from "./smoke-pdf";
import { runReaderSmoke } from "./smoke-reader";
import { runExtensionSmoke } from "./smoke-extensions";
import { runFaviconSmoke, serveFaviconSmokeRoute } from "./smoke-favicon";
import { fakeSearchDeps, runSearchSmoke } from "./smoke-search";
import { runSettingsLayoutSmoke } from "./smoke-settings";
import { runWebscopeSmoke } from "./smoke-webscope";

const PAGE = `<!doctype html><html><head><title>Smoke</title></head><body>
<nav>Navigation that should not appear in text</nav>
<main><h1>Corvus smoke page</h1><p>Hello from the smoke test.</p>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted:' + document.getElementById('q').value;">
<label for="q">Query</label><input id="q" name="q" placeholder="Type here">
<button type="button" onclick="document.getElementById('out').textContent = 'clicked:' + document.getElementById('q').value">Go</button>
</form><div id="out">idle</div><a href="/next">Next page</a></main></body></html>`;

const LOGIN_PAGE = `<!doctype html><html><head><title>Sign in</title></head><body>
<main><h1>Sign in</h1>
<form method="GET" action="/after-login">
<label for="u">Username</label><input id="u" name="u" type="text" autocomplete="username">
<label for="p">Password</label><input id="p" name="p" type="password" autocomplete="current-password">
<button type="submit">Sign in</button>
</form></main></body></html>`;

function log(step: string, data: unknown): void {
  console.log(`[smoke] ${step}: ${JSON.stringify(data)}`);
}

/**
 * Headless end-to-end check (CORVUS_SMOKE_TEST=1): drives the BrowserController against a local
 * page, exercises search/MCP fallbacks, then exits with 0 on success and 1 on failure.
 */
export async function runSmokeTest(ctx: AppContext): Promise<void> {
  // The host's free memory must not decide which tabs sleep while the checks run.
  ctx.tabSleeper.freeShare = () => 1;
  app.on("web-contents-created", (_e, wc) => {
    wc.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") log(`console ${event.level}`, { url: wc.getURL(), message: event.message });
    });
  });
  for (const wc of webContents.getAllWebContents()) {
    wc.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") log(`console ${event.level}`, { url: wc.getURL(), message: event.message });
    });
  }
  const server = http.createServer((req, res) => {
    if (serveBrowserSmokeRoute(req, res)) return;
    if (serveCredentialsSmokeRoute(req, res)) return;
    if (serveFaviconSmokeRoute(req, res)) return;
    if (serveMediaSmokeRoute(req, res)) return;
    if (serveUxSmokeRoute(req, res)) return;
    if (serveSignInSmokeRoute(req, res)) return;
    const path = (req.url ?? "/").split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(path === "/login" ? LOGIN_PAGE : path === "/after-login" ? "<!doctype html><title>Signed in</title><main>Welcome</main>" : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  let failed = false;
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    log(`${ok ? "PASS" : "FAIL"} ${name}`, detail ?? null);
    if (!ok) failed = true;
  };

  if (process.env.CORVUS_PERF === "1") {
    try {
      const { runPerfProbe } = await import("./smoke-perf");
      await runPerfProbe(ctx, url, (msg, detail) => log(msg, detail ?? null), check);
    } catch (err) {
      check("perf probe", false, (err as Error).stack ?? String(err));
    } finally {
      server.close();
      log("RESULT", failed ? "FAILED" : "OK");
      app.exit(failed ? 1 : 0);
    }
    return;
  }

  try {
    await new Promise((r) => setTimeout(r, 1500));
    const c = ctx.controller;
    const tab = await c.openTab(url);
    check("openTab", tab.url.startsWith(url) && tab.agentControlled, tab);

    const snap = await c.snapshot(tab.id, { maxChars: 2000 });
    check("snapshot text", snap.text.includes("Hello from the smoke test") && !snap.text.includes("Navigation that"), snap.text);
    const input = snap.elements.find((e) => e.role === "textbox");
    const button = snap.elements.find((e) => e.role === "button" && e.name === "Go");
    const link = snap.elements.find((e) => e.role === "link");
    check("snapshot elements", Boolean(input && button && link), snap.elements);

    if (input && button) {
      await c.type(tab.id, input.ref, "corvus");
      await c.click(tab.id, button.ref);
      await new Promise((r) => setTimeout(r, 300));
      const after = await c.snapshot(tab.id);
      check("type + click", after.text.includes("clicked:corvus"), after.text);
      await c.type(tab.id, input.ref, "again", { submit: true });
      await new Promise((r) => setTimeout(r, 300));
      const submitted = await c.snapshot(tab.id);
      check("type submit", submitted.text.includes("submitted:again"), submitted.text);
      const stable = submitted.elements.find((e) => e.ref === input.ref);
      check("stable refs", Boolean(stable), stable);
    }

    await c.scroll(tab.id, "down");
    const shot = await c.screenshot(tab.id);
    check("screenshot", shot.base64.length > 1000, { bytes: shot.base64.length });

    const blocked = await c.navigate(tab.id, "corvus://settings").then(
      () => false,
      () => true,
    );
    check("agent blocked from settings", blocked);

    const second = await c.openTab("about:blank", { background: true });
    const group = await c.createGroup([tab.id, second.id], { title: "Smoke", color: "green" });
    const groups = await c.listGroups();
    check("createGroup", groups.some((g) => g.id === group.id && g.title === "Smoke"), groups);
    await c.ungroup([tab.id, second.id]);
    check("ungroup", (await c.listGroups()).length === 0);

    const bookmark = await c.addBookmark({ title: "Smoke", url, parentId: null });
    check("addBookmark", (await c.listBookmarks()).some((b) => b.id === bookmark.id));
    const history = await c.searchHistory("127.0.0.1");
    check("searchHistory", history.length > 0, history);

    const tabs = await c.listTabs();
    check("listTabs", tabs.length >= 3, tabs.map((t) => ({ id: t.id, url: t.url, agent: t.agentControlled })));
    await c.closeTab(second.id);

    const events: SearchEvent["type"][] = [];
    for await (const event of ctx.search.proxy.search("smoke test")) events.push(event.type);
    const info = await ctx.search.engineInfo();
    check("search service responds", events.length > 0, { events, info });

    const win = ctx.windows.target();
    const chromeRendered = await win.chrome.webContents.executeJavaScript(
      "Boolean(document.querySelector('.tab-strip') && document.querySelectorAll('.tab').length > 0 && document.querySelector('.omni-input'))",
    );
    check("chrome UI rendered", chromeRendered === true);
    const outDir = process.env.CORVUS_SMOKE_OUT;
    const capture = async (name: string, wc: Electron.WebContents): Promise<void> => {
      if (!outDir) return;
      const file = path.join(outDir, `${name}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const image = await wc.capturePage();
      fs.writeFileSync(file, image.toPNG());
    };
    // CORVUS_SMOKE_ONLY=settings: only the Settings layout checks, for work on Settings (with CORVUS_SMOKE_SETTINGS_SHOTS=1, every section).
    if (process.env.CORVUS_SMOKE_ONLY === "settings") {
      await runSettingsLayoutSmoke(ctx, { win, check, capture });
      return;
    }
    // CORVUS_SMOKE_ONLY=cert: only the certificate error checks.
    if (process.env.CORVUS_SMOKE_ONLY === "cert") {
      await runCertErrorSmoke(ctx, { win, check });
      return;
    }
    // CORVUS_SMOKE_ONLY=tabclose: only the checks that closing tabs keeps the chrome UI up to date.
    if (process.env.CORVUS_SMOKE_ONLY === "tabclose") {
      await runTabCloseSmoke(ctx, { win, check, capture });
      return;
    }
    // CORVUS_SMOKE_ONLY=passwords: only the save-password prompt checks.
    if (process.env.CORVUS_SMOKE_ONLY === "passwords") {
      await runSavePromptSmoke(ctx, { url, win, check, capture });
      return;
    }
    // CORVUS_SMOKE_ONLY=authenticator: only the Import from Google Authenticator checks.
    if (process.env.CORVUS_SMOKE_ONLY === "authenticator") {
      await runAuthenticatorImportSmoke(ctx, { win, check, capture });
      return;
    }
    // CORVUS_SMOKE_ONLY=webscope: only the WebScope checks, for work on WebScope.
    if (process.env.CORVUS_SMOKE_ONLY === "webscope") {
      await runWebscopeSmoke(ctx, { url, win, check, capture });
      return;
    }
    await capture("chrome", win.chrome.webContents);
    await runFaviconSmoke(ctx, { url, win, check, capture });
    const pages: Array<[string, string]> = [
      ["newtab", ".nt-search"],
      ["search?q=what%20is%20corvus", ".search-header"],
      ["settings", "#agents"],
      ["bookmarks", ".tree"],
      ["history", ".list-row"],
      ["extensions", ".notice"],
      ["schedules", ".page-toolbar .btn.primary"],
      ["agent-runs", ".side-nav a.active"],
      ["site-profiles", ".page-toolbar .btn.primary"],
      ["flows", ".side-nav"],
      ["annotations", ".side-nav a.active"],
      ["passwords", ".btn.primary"],
      ["crash?url=https%3A%2F%2Fexample.com%2F&reason=crashed", ".crash-view .btn.primary"],
      ["cert-error?url=https%3A%2F%2F10.0.10.1%2F&code=ERR_CERT_AUTHORITY_INVALID&kind=authority", ".cert-view .btn.primary"],
      ["devices", ".devices-page"],
      ["welcome", ".wz"],
    ];
    for (const [page, selector] of pages) {
      const internal = win.createTab(`corvus://${page}`);
      await new Promise((r) => setTimeout(r, 1500));
      const wc = internal.view.webContents;
      const ok = await wc.executeJavaScript(`Boolean(window.corvusInternal && document.querySelector(${JSON.stringify(selector)}))`);
      check(`page corvus://${page}`, ok === true);
      await capture(page.split("?")[0] ?? page, wc);
    }
    await runSearchSmoke(ctx, { win, check, capture });
    const historyTab = win.createTab("corvus://history");
    await new Promise((r) => setTimeout(r, 1000));
    const remoteTabs = await historyTab.view.webContents.executeJavaScript("window.corvusInternal.call('sync.remoteTabs')");
    check("history sync.remoteTabs IPC", Array.isArray(remoteTabs), remoteTabs);
    await runPairingAddressSmoke(check);
    await runBuiltinSyncSmoke(ctx, url, check, capture);
    if (process.env.CORVUS_SMOKE_SYNC_URL) await smokeSync(ctx, process.env.CORVUS_SMOKE_SYNC_URL, url, check, capture);
    await runSettingsLayoutSmoke(ctx, { win, check, capture });

    const webTab = ctx.windows.findTab(tab.id)?.tab;
    const leaked = await webTab?.view.webContents.executeJavaScript("typeof window.corvusInternal + '/' + typeof window.corvus");
    check("no IPC bridge on web content", leaked === "undefined/undefined", leaked);

    await runBrowserSmoke(ctx, { url, agentTabId: tab.id, win, check, capture });
    await runSplitSmoke(ctx, { url, win, check, capture });
    await runUxSmoke(ctx, { url, win, check, capture });
    await runSignInSmoke(ctx, { url, win, check });
    await runNewTabSmoke(ctx, { url, win, check, capture });
    await runChromeUiSmoke(ctx, { url, win, check, capture });
    await runBookmarksBarSmoke(ctx, { url, win, check, capture });
    await runSleepSmoke(ctx, { url, win, check });
    await runMediaSmoke(ctx, { url, win, check, capture });
    await runCertErrorSmoke(ctx, { win, check });
    await runTabCloseSmoke(ctx, { win, check, capture });

    ctx.settings.update({ mcp: { enabled: true } });
    await ctx.mcp.apply();
    const status = ctx.mcp.status();
    check("mcp service", status.running || !status.available, { ...status, token: "<redacted>", command: status.command ? "<set>" : null });
    ctx.settings.update({ mcp: { enabled: false } });
    await ctx.mcp.apply();

    await runAssistSmoke(ctx, { win, check, capture });
    await runDictationSmoke(ctx, { url, win, check, capture });
    await runDialogsSmoke(ctx, { url, win, check, capture });
    await runLibrarySmoke(ctx, { win, check, capture });
    await runFeaturesSmoke(ctx, { win, check, capture });
    await runLocalModelsSmoke(ctx, { win, check, capture });
    await runPhoneSmoke(ctx, { url, win, check, capture });
    await runGrabberSmoke(ctx, { win, check, capture });
    await runConnectionsSmoke(ctx, { win, check, capture });
    await runPrivateSmoke(ctx, { win, check, capture });
    await runCookieConsentSmoke(ctx, { win, check, capture });
    await runDefaultBrowserSmoke(ctx, { win, check, capture });
    await runBrowserImportSmoke(ctx, { win, check, capture });
    await runDownloadAiSmoke(ctx, { win, check, capture });
    await runProfileTransferSmoke(ctx, { win, check, capture });
    await runReaderSmoke(ctx, { win, check, capture });
    await runPdfSmoke(ctx, { win, check, capture });
    await runCredentialsSmoke(ctx, { url, win, check, capture });
    await runAuthenticatorImportSmoke(ctx, { win, check, capture });
    await runAnnotationsSmoke(ctx, { url, win, check, capture });
    if (process.env.CORVUS_SMOKE_NO_AGENT !== "1") await runAgentSmoke(ctx, { win, check, capture });
    if (process.env.CORVUS_SMOKE_NO_AGENT !== "1") await runScheduledAgentSmoke(ctx, { win, check, capture });
    if (process.env.CORVUS_SMOKE_NO_AGENT !== "1") await runAgentRunsSmoke(ctx, { win, check, capture });
    await runFlowsSmoke(ctx, { win, check, capture });
    if (process.env.CORVUS_SMOKE_NO_AGENT !== "1") await runWorkflowsSmoke(ctx, { win, check, capture });
    if (process.env.CORVUS_SMOKE_NO_AGENT !== "1") await runSiteMemorySmoke(ctx, { win, check, capture });
    if (process.env.CORVUS_SMOKE_NO_AGENT !== "1") await runAssistAgentSmoke(ctx, { win, check, capture });
    await runWebscopeSmoke(ctx, { url, win, check, capture });

    await runExtensionSmoke(ctx, { check, capture, log });
  } catch (err) {
    check("unexpected error", false, (err as Error).stack ?? String(err));
  } finally {
    server.close();
    log("RESULT", failed ? "FAILED" : "OK");
    app.exit(failed ? 1 : 0);
  }
}

/**
 * Live sync round trip (CORVUS_SMOKE_SYNC_URL=http://sync-server:8787): turn sync on for the window's
 * profile, act as a second device with sync-core directly, and check every collection both ways.
 */
async function smokeSync(
  ctx: AppContext,
  serverUrl: string,
  pageUrl: string,
  check: (name: string, ok: boolean, detail?: unknown) => void,
  capture: (name: string, wc: Electron.WebContents) => Promise<void>,
): Promise<void> {
  const win = ctx.windows.target();
  const profile = win.profile;
  profile.credentials.add({ origin: "https://sync-login.example", username: "sync-user", password: "sync-pass" });
  const phrase = await ctx.sync.generatePhrase();
  const on = await ctx.sync.enable(profile, { serverUrl, phrase, deviceName: "Smoke laptop" });
  check("sync enable", on.enabled && on.lastSyncAt !== null && on.error === null, { ...on, chainId: on.chainId?.slice(0, 8) });
  const pairing = await ctx.sync.pairingCode(profile);
  const decoded = decodePairing(pairing.code);
  check(
    "pair a phone: the QR code carries this chain's server and phrase",
    decoded?.phrase === phrase &&
      decoded.serverUrl === serverUrl.replace(/\/+$/, "") &&
      pairing.qrSvg.startsWith("<svg") &&
      // A bare Docker name is not localhost: it goes in the code as it is, with the warning.
      !pairing.lanOnly &&
      !pairing.reachable &&
      pairing.desktopServerUrl === decoded.serverUrl,
    { serverUrl: decoded?.serverUrl, lanOnly: pairing.lanOnly, reachable: pairing.reachable },
  );

  const memory = new Map<string, string>();
  const phone = createSyncClient({
    serverUrl,
    phrase,
    deviceName: "Smoke phone",
    platform: "android",
    storage: { get: async (k) => memory.get(k), set: async (k, v) => void memory.set(k, v) },
  });
  await phone.register();
  const pulled = await phone.pull();
  const collections = new Set<string>(pulled.map((i) => i.collection));
  check(
    "sync pushes every collection",
    ["bookmarks", "history", "settings", "profiles", "open_tabs", "extensions", "credentials"].every((c) => collections.has(c)),
    [...collections],
  );
  const syncedCred = pulled.find((i) => i.collection === "credentials")?.payload as { username?: string; password?: string } | undefined;
  check("sync credential round-trip (E2E-encrypted)", syncedCred?.username === "sync-user" && syncedCred?.password === "sync-pass", {
    username: syncedCred?.username,
    password: syncedCred?.password ? "<set>" : null,
  });
  const ownTabs = pulled.find((i) => i.collection === "open_tabs")?.payload as { tabs?: Array<{ url: string }> } | undefined;
  check("sync publishes open tabs", Boolean(ownTabs?.tabs?.some((t) => t.url.startsWith(pageUrl))), ownTabs);
  const synced = pulled.filter((i) => i.collection === "settings").map((i) => i.id);
  check("sync settings exclude MCP", synced.length > 0 && !synced.some((id) => id.startsWith("mcp.")), synced);

  const phoneId = await phone.getDeviceId();
  const extId = "cjpalhdlnbpafiamejdnhcphjbkeiagm";
  await phone.push([
    {
      collection: "open_tabs",
      id: phoneId,
      payload: { device: "Smoke phone", platform: "android", updatedAt: Date.now(), tabs: [{ url: "https://example.org/remote", title: "Remote tab", pinned: false }] },
      deleted: false,
    },
    { collection: "extensions", id: phoneId, payload: { device: "Smoke phone", extensions: [{ id: extId, name: "uBlock Origin" }] }, deleted: false },
  ]);
  await ctx.sync.syncNow(profile);
  const remote = await ctx.sync.remoteTabs(profile);
  check("sync remote tabs", remote.some((d) => d.device === "Smoke phone" && d.tabs[0]?.url === "https://example.org/remote"), remote);
  const suggestions = await ctx.sync.extensionSuggestions(profile);
  check("sync extension suggestions", suggestions.some((s) => s.id === extId), suggestions);

  const listed = await ctx.sync.devices(profile);
  check("sync devices", listed.length === 2 && listed[0]?.current === true && listed[1]?.name === "Smoke phone", listed);

  // A page sent from the phone opens here once, and its record then leaves the chain.
  const sentUrl = `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}corvus-sent=1`;
  const sentId = "smoke-sent-page-1";
  const deskId = listed.find((d) => d.current)?.id ?? "";
  await phone.push([
    {
      collection: "sent_tabs",
      id: sentId,
      payload: { url: sentUrl, title: "Sent from the phone", to: deskId, fromId: phoneId, from: "Smoke phone", sentAt: Date.now() },
      deleted: false,
    },
  ]);
  await ctx.sync.syncNow(profile);
  await ctx.sync.syncNow(profile);
  const sentTabs = win.listTabs().filter((t) => t.url === sentUrl);
  const sentGone = (await phone.pull()).some((i) => i.collection === "sent_tabs" && i.id === sentId && i.deleted);
  check("send to computer: a page sent from the phone opens once, then leaves the chain", sentTabs.length === 1 && sentGone, {
    opened: sentTabs.length,
    deletedOnChain: sentGone,
  });
  for (const tab of sentTabs) win.closeTab(tab.id);

  // "Send to your phone" lists the paired phone and sends the page to it.
  const phones = ctx.sync.phones(profile);
  const toPhoneUrl = `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}corvus-to-phone=1`;
  await ctx.sync.sendTab(profile, phoneId, toPhoneUrl, "Sent to the phone");
  const onPhone = (await phone.pull()).find((i) => i.collection === "sent_tabs" && !i.deleted && (i.payload as { url?: string } | null)?.url === toPhoneUrl);
  check(
    "send to phone: the paired phone is offered and gets the page, addressed to it",
    phones.some((p) => p.id === phoneId && p.name === "Smoke phone") && (onPhone?.payload as { to?: string } | undefined)?.to === phoneId,
    { phones, payload: onPhone?.payload ?? null },
  );
  if (onPhone) await phone.push([{ collection: "sent_tabs", id: onPhone.id, payload: null, deleted: true }]);

  // A question asked on the phone is answered here with the AI search, streaming onto the chain:
  // the phone (looking as often as the app does while it waits) sees the answer grow before it is
  // done. Nothing pokes the sync: this computer finds the question by itself, as with a real phone.
  ctx.search.setTestDeps(fakeSearchDeps(70));
  const askId = "smoke-ask-1";
  let asked: Ask | null = null;
  try {
    const askedAt = Date.now();
    await phone.push([{ collection: "asks", id: askId, payload: newAsk("How long do ravens live?", deskId, phoneId, "Smoke phone", askedAt), deleted: false }]);
    const states = new Set<string>();
    const partials: string[] = [];
    let firstText = 0;
    const until = Date.now() + 30_000;
    while (Date.now() < until && asked?.state !== "done" && asked?.state !== "error") {
      await new Promise((r) => setTimeout(r, 150));
      for (const item of await phone.pull()) {
        if (item.collection !== "asks" || item.id !== askId || item.deleted) continue;
        asked = parseAsk(item.payload);
        if (!asked) continue;
        states.add(asked.state);
        if (asked.state === "answering" && asked.answer && partials.at(-1) !== asked.answer) partials.push(asked.answer);
        if (asked.answer && !firstText) firstText = Date.now() - askedAt;
      }
    }
    console.log(`[smoke] ask from the phone: first text after ${firstText} ms, ${partials.length} partial answers, done after ${Date.now() - askedAt} ms`);
    check(
      "ask from the phone: partial answers arrive, each one longer, before the final one",
      partials.length >= 3 && partials.every((p, i) => i === 0 || p.length > partials[i - 1]!.length) && asked?.state === "done" && asked.answer.startsWith(partials[0]!.trimEnd().slice(0, 8)),
      { partials: partials.length, lengths: partials.map((p) => p.length), firstText },
    );
    check(
      "ask from the phone: this computer answers with its AI search, with sources, while the phone watches",
      asked?.state === "done" && asked.answer.length > 20 && asked.sources.length > 0 && asked.answeredBy.length > 0 && states.has("answering"),
      { state: asked?.state, states: [...states], answer: asked?.answer.slice(0, 120), sources: asked?.sources.length, error: asked?.error },
    );
  } finally {
    ctx.search.setTestDeps(null);
    await phone.push([{ collection: "asks", id: askId, payload: null, deleted: true }]);
  }

  // The person stops that answer on the phone while it is written (or sends another message): the
  // phone writes a copy with the answer so far, marked stopped, and deletes the question ahead of
  // this computer's writes, in one request. This computer stops its search, never brings the
  // question back (not even through a full sync), and leaves the copy alone.
  let pieces = 0;
  ctx.search.setTestDeps(fakeSearchDeps(150, () => pieces++));
  const stopId = "smoke-ask-stop";
  const copyId = "smoke-ask-stop-copy";
  try {
    await phone.push([{ collection: "asks", id: stopId, payload: newAsk("Why are ravens so clever?", deskId, phoneId, "Smoke phone", Date.now()), deleted: false }]);
    let partial: Ask | null = null;
    for (const until = Date.now() + 20_000; !partial && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 150));
      for (const item of await phone.pull()) {
        const seen = item.collection === "asks" && item.id === stopId && !item.deleted ? parseAsk(item.payload) : null;
        if (seen?.state === "answering" && seen.answer) partial = seen;
      }
    }
    const copy = partial ? stoppedAsk({ id: stopId, ...partial }, Date.now()) : null;
    const { conflicts } = copy
      ? await phone.push(
          [
            { collection: "asks", id: copyId, payload: copy, deleted: false },
            { collection: "asks", id: stopId, payload: null, deleted: true },
          ],
          { deleteAhead: 1000 },
        )
      : { conflicts: [] };
    const atStop = pieces;
    // Several more pieces of the answer would have been due by now.
    await new Promise((r) => setTimeout(r, 2500));
    await ctx.sync.syncNow(profile);
    const settled = pieces;
    await new Promise((r) => setTimeout(r, 1500));
    const after = (await phone.pull()).filter((i) => i.collection === "asks" && (i.id === stopId || i.id === copyId));
    check(
      "stop an answer from the phone: this computer stops its search and never brings the question back; the stopped copy stays as written",
      !!copy && conflicts.length === 0 && pieces === settled && after.length === 0,
      { partial: partial?.answer.length ?? null, conflicts: conflicts.length, piecesAtStop: atStop, piecesAfter: pieces, changedOnChain: after.map((i) => `${i.id}:${i.deleted ? "deleted" : (i.payload as Ask).state}`) },
    );
  } finally {
    ctx.search.setTestDeps(null);
    await phone.push([{ collection: "asks", id: stopId, payload: null, deleted: true }, { collection: "asks", id: copyId, payload: null, deleted: true }], { deleteAhead: 1000 });
  }

  // A link saved for later on the phone joins the reading list here; read state syncs both ways.
  const laterUrl = `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}corvus-later=1`;
  await phone.push([{ collection: "reading", id: laterUrl, payload: linkOnlyReadingItem("smoke-later-1", laterUrl, "Saved on the phone", Date.now()), deleted: false }]);
  await ctx.sync.syncNow(profile);
  const later = profile.reading.allItems().find((i) => i.url === laterUrl);
  profile.reading.setRead("smoke-later-1", true);
  await ctx.sync.syncNow(profile);
  const readBack = (await phone.pull()).find((i) => i.collection === "reading" && i.id === laterUrl)?.payload as { readAt?: number } | undefined;
  check("reading list: a link saved on the phone arrives, and reading it here reaches the phone", later?.title === "Saved on the phone" && typeof readBack?.readAt === "number", {
    arrived: Boolean(later),
    readAt: readBack?.readAt ?? null,
  });

  // A watch added on the phone is monitored here, and what this computer sees is published for it.
  const watchUrl = "https://example.org/watched-from-the-phone";
  await phone.push([
    { collection: "watches", id: watchUrl, payload: { url: watchUrl, title: "", intervalMinutes: 60, paused: false, createdAt: Date.now(), condition: "it mentions ravens" }, deleted: false },
  ]);
  await ctx.sync.syncNow(profile);
  await ctx.sync.syncNow(profile);
  const watches = ctx.monitor.storeFor(profile);
  const watched = watches.list().find((w) => w.url === watchUrl);
  const published = (await phone.pull()).filter((i) => i.collection === "watch_status" && i.id === deskId);
  const deskStatus = parseDeviceWatchStatus(published[published.length - 1]?.payload);
  check(
    "watched pages: a watch added on the phone is monitored here, and its status reaches the phone",
    watched?.condition === "it mentions ravens" && deskStatus?.device === "Smoke laptop" && Boolean(deskStatus.watches.some((w) => w.url === watchUrl)),
    { watched: Boolean(watched), status: deskStatus?.watches.map((w) => w.url) ?? null },
  );
  if (watched) watches.remove(watched.id);
  await runSyncLearnedSmoke(ctx, { profile, phone, win, check });

  const history = win.createTab("corvus://history");
  const shown = await waitForText(history.view.webContents, ".remote-tabs", "Remote tab");
  check("history shows tabs from other devices", shown.includes("Remote tab"), shown);
  const settings = win.createTab("corvus://settings#sync");
  const devicesShown = await waitForText(settings.view.webContents, ".sync-devices", "Smoke phone");
  check("settings lists devices", devicesShown.includes("Smoke phone") && devicesShown.includes("This device"), devicesShown);
  await runPairPhoneUiSmoke(ctx, { profile, settings: settings.view.webContents, window: win.win, phrase, check, capture });

  const devices = await ctx.sync.removeDevice(profile, phoneId);
  check("sync remove device", devices.length === 1 && devices[0]?.current === true, devices);
  check("removed device tabs are gone", (await ctx.sync.remoteTabs(profile)).length === 0);
  check("sync reveal phrase", ctx.sync.revealPhrase(profile) === phrase);

  const wiped = await ctx.sync.wipe(profile, "DELETE");
  check("sync wipe chain", !wiped.enabled && wiped.chainId === null, { enabled: wiped.enabled, error: wiped.error });

  // Sync off: "Where your data syncs" is a list of radios, each with its title and description, wide and narrow.
  settings.view.webContents.reload();
  await waitForText(settings.view.webContents, ".sync-choice", "This computer (recommended)");
  await settings.view.webContents.executeJavaScript(`document.querySelector(".sync-choice")?.scrollIntoView({ block: "center" })`);
  const wide = await narrowLayout(settings.view.webContents);
  await capture("settings-sync-setup", settings.view.webContents);
  let narrow = wide;
  await narrowWindow(win.win, async () => {
    await settings.view.webContents.executeJavaScript(`document.querySelector(".sync-choice")?.scrollIntoView({ block: "center" })`);
    narrow = await narrowLayout(settings.view.webContents);
    await capture("settings-sync-setup-narrow", settings.view.webContents);
  });
  check("sync setup: each place to sync is a radio with its title and description beside it, wide and narrow", wide.radiosOk && wide.radios === 2 && narrow.radiosOk && narrow.fits, { wide, narrow });
  win.closeTab(settings.id);
}

/** Poll a page until `selector` contains `text` (or 10 s pass); returns the element's text. */
async function waitForText(wc: Electron.WebContents, selector: string, text: string): Promise<string> {
  let last = "";
  for (let i = 0; i < 40; i++) {
    last = String(await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`));
    if (last.includes(text)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  const state = await wc.executeJavaScript("document.readyState + ' ' + location.href + ' ' + document.body.innerHTML.length");
  return `${last} [timeout: ${String(state)}]`;
}
