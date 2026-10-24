// Electron main process for scripts/web-smoke.mjs: serves dist-web, opens each screen in a hidden
// window at a phone's size, checks what it shows and saves screenshots to out/mobile-smoke.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist-web");
const shots = path.resolve(root, "../../out/mobile-smoke");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".ttf": "font/ttf" };

/** Every check, then the overall result: the same "[smoke] PASS/FAIL" lines as the desktop smoke. */
const results = [];
/** Errors the app logs to the console (there should be none). */
const errors = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`[mobile-smoke] ${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

function serve() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = path.join(dist, pathname);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function until(win, expr, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await win.webContents.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** Saves a screenshot once the page has painted its latest state (a hidden window paints lazily). */
async function shot(win, name) {
  await win.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300))))");
  fs.mkdirSync(shots, { recursive: true });
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(shots, `${name}.png`), image.toPNG());
}

async function screen(win, base, route, name, expr) {
  await win.loadURL(`${base}${route}`);
  const ok = await until(win, expr);
  await shot(win, name);
  return ok;
}

/** Sets a React-controlled input's value as typing would. */
function typeInto(win, testId, value) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-testid=${testId}]');
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

/** The computer's open tabs as Corvus desktop publishes them (pages of the local server, so favicons load). */
function deskTabs(base, extra = []) {
  return {
    device: "Smoke desktop",
    platform: "win32",
    updatedAt: Date.now(),
    tabs: [
      { url: `${base}/smoke/first`, title: "First smoke page", pinned: true },
      { url: `${base}/smoke/second`, title: "Second smoke page", pinned: false, group: { title: "Research", color: "blue" } },
      { url: "file:///C:/private.txt", title: "Not a web page", pinned: false },
      ...extra,
    ],
  };
}

const visible = (url) => `Boolean(document.querySelector('[data-testid="tab-${url}"]'))`;

/**
 * Pairing against the real sync server: a "computer" joins a new chain with sync-core and
 * publishes its open tabs, the app pairs with the same phrase typed by hand, both see each other
 * in the chain's device list, the phone shows the computer's tabs (and later changes to them),
 * and unpairing takes the phone off the chain. The browser build needs CORS, which only this
 * check adds.
 */
async function pairingSmoke(win, base, syncUrl) {
  const { session } = require("electron");
  const origin = new URL(syncUrl).origin;
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    const responseHeaders = {
      ...details.responseHeaders,
      "access-control-allow-origin": ["*"],
      "access-control-allow-headers": ["authorization, content-type"],
      "access-control-allow-methods": ["GET, POST, DELETE, OPTIONS"],
    };
    callback(details.method === "OPTIONS" ? { responseHeaders, statusLine: "HTTP/1.1 204 No Content" } : { responseHeaders });
  });

  const { createSyncClient, generateRecoveryPhrase } = await import("@corvus/sync-core");
  const phrase = generateRecoveryPhrase();
  const memory = new Map();
  const computer = createSyncClient({
    serverUrl: syncUrl,
    phrase,
    deviceName: "Smoke desktop",
    platform: "win32",
    storage: { get: async (k) => memory.get(k), set: async (k, v) => void memory.set(k, v) },
  });
  await computer.register();
  const deskId = await computer.getDeviceId();
  await computer.push([{ collection: "open_tabs", id: deskId, payload: deskTabs(base), deleted: false }]);

  await win.loadURL(`${base}/pair`);
  await until(win, "document.querySelector('[data-testid=pair-server]')");
  await typeInto(win, "pair-server", syncUrl);
  await typeInto(win, "pair-phrase", phrase);
  await new Promise((r) => setTimeout(r, 200));
  await shot(win, "pair");
  await win.webContents.executeJavaScript("document.querySelector('[data-testid=pair-submit]').click()");
  const first = `${base}/smoke/first`;
  const second = `${base}/smoke/second`;
  const shown = await until(win, `${visible(first)} && ${visible(second)} && !document.querySelector('[data-testid=pair-submit]')`, 20000);
  const error = await win.webContents.executeJavaScript("document.querySelector('[data-testid=pair-error]')?.textContent ?? null");
  const card = await win.webContents.executeJavaScript("document.querySelector('[data-testid=\"computer-Smoke desktop\"]')?.innerText ?? ''");
  check("tabs: the phone shows the computer's open web pages after pairing", shown && card.includes("2 tabs") && card.includes("Research") && !card.includes("Not a web page"), {
    error,
    card: card.slice(0, 300),
  });
  await shot(win, "home-tabs");

  await typeInto(win, "tabs-filter", "second");
  const filtered = await until(win, `${visible(second)} && !${visible(first)}`);
  check("tabs: finding a tab by its title", filtered);
  await typeInto(win, "tabs-filter", "");

  let opened = null;
  win.webContents.setWindowOpenHandler(({ url }) => {
    opened = url;
    return { action: "deny" };
  });
  await until(win, visible(first));
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="tab-${first}"]').click()`);
  for (const end = Date.now() + 5000; opened === null && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  check("tabs: tapping a tab opens its page", opened === first, opened);

  // The computer's tabs change; the next refresh (here, opening the app again) brings only that.
  const third = `${base}/smoke/third`;
  await computer.push([{ collection: "open_tabs", id: deskId, payload: deskTabs(base, [{ url: third, title: "Third smoke page", pinned: false }]), deleted: false }]);
  await win.loadURL(`${base}/`);
  const updated = await until(win, `${visible(third)} && ${visible(first)}`, 20000);
  check("tabs: a refresh brings the computer's new tabs", updated);

  // Send to computer: the page waits in the outbox until the computer opens it (deletes its record).
  const received = async (url) => {
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
      const item = (await computer.pull()).find((i) => i.collection === "sent_tabs" && (i.deleted || i.payload?.url === url));
      if (item) return item;
    }
    return null;
  };
  const sendPage = async (text) => {
    await win.loadURL(`${base}/send`);
    if (!(await until(win, "document.querySelector('[data-testid=\"send-to-Smoke desktop\"]')", 20000))) {
      await shot(win, "send-failed");
      const page = await win.webContents.executeJavaScript("document.body.innerText.slice(0, 400)");
      throw new Error(`the Send screen did not list the computer: ${JSON.stringify({ page, errors: errors.slice(-3) })}`);
    }
    await typeInto(win, "send-url", text);
    await until(win, "document.querySelector('[data-testid=send-submit]')?.getAttribute('aria-disabled') !== 'true'");
    await win.webContents.executeJavaScript("document.querySelector('[data-testid=send-submit]').click()");
  };
  const sentUrl = "https://example.org/sent-from-phone";
  await sendPage(`Read this later: ${sentUrl}`);
  const sent = await received(sentUrl);
  check("send: a page typed on the phone reaches the computer, addressed to it", sent?.payload?.to === deskId && sent.payload.from === "Phone" && !sent.deleted, sent?.payload ?? null);
  const waiting = await until(win, `Boolean(document.querySelector('[data-testid="outbox-${sentUrl}"]'))`, 15000);
  const waitingText = await win.webContents.executeJavaScript(`document.querySelector('[data-testid="outbox-${sentUrl}"]')?.innerText ?? ''`);
  check("send: the phone shows it waiting for the computer", waiting && waitingText.includes("Waiting for Smoke desktop"), waitingText);
  await shot(win, "home-outbox");
  if (sent) await computer.push([{ collection: "sent_tabs", id: sent.id, payload: null, deleted: true }]);
  const delivered = await until(win, `!document.querySelector('[data-testid="outbox-${sentUrl}"]')`, 25000);
  check("send: once the computer opens it, it leaves the outbox (checked every few seconds)", delivered);

  const cancelUrl = "https://example.org/changed-my-mind";
  await sendPage(cancelUrl);
  const toCancel = await received(cancelUrl);
  await until(win, `Boolean(document.querySelector('[data-testid="outbox-cancel-${cancelUrl}"]'))`, 15000);
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="outbox-cancel-${cancelUrl}"]').click()`);
  const cancelled = await received(cancelUrl);
  const gone = await until(win, `!document.querySelector('[data-testid="outbox-${cancelUrl}"]')`, 5000);
  check("send: a page can be taken back before the computer opens it", Boolean(toCancel) && cancelled?.deleted === true && cancelled.id === toCancel.id && gone, cancelled);

  await win.loadURL(`${base}/settings`);
  const listed = await until(win, "document.querySelector('[data-testid=\"device-Smoke desktop\"]') && document.querySelector('[data-testid=\"device-Phone\"]')?.textContent.includes('(this phone)')", 20000);
  const devices = await computer.listDevices();
  check("pairing: the app joins the computer's sync chain and lists both devices", listed && devices.some((d) => d.name === "Phone"), {
    devices: devices.map((d) => `${d.name}/${d.platform}`),
  });
  await shot(win, "settings-paired");
  await until(win, "document.querySelector('[data-testid=settings-unpair]')");
  await win.webContents.executeJavaScript("window.confirm = () => true; document.querySelector('[data-testid=settings-unpair]').click()");
  const unpaired = await until(win, "document.querySelector('[data-testid=settings-pair]')", 15000);
  const after = await computer.listDevices();
  check("pairing: unpairing takes the phone off the chain", unpaired && !after.some((d) => d.name === "Phone"), after.map((d) => d.name));
}

app.whenReady().then(async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    check("web build exists (run pnpm export:web first)", false);
    app.exit(1);
    return;
  }
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({ show: false, width: 412, height: 915, webPreferences: { offscreen: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  try {
    const home = await screen(win, base, "/", "home", "document.querySelector('[data-testid=home-title]')?.textContent === 'Corvus' && document.querySelector('[data-testid=pairing-card]')");
    check("home screen shows Corvus and how to pair", home);
    const settings = await screen(win, base, "/settings", "settings", "/Corvus for mobile \\d/.test(document.querySelector('[data-testid=app-version]')?.textContent ?? '')");
    check("settings screen shows the app version", settings);
    if (process.env.CORVUS_SYNC_URL) await pairingSmoke(win, base, process.env.CORVUS_SYNC_URL);
    else check("pairing (needs CORVUS_SYNC_URL and the sync-server service)", false, "CORVUS_SYNC_URL is not set");
    check("no errors in the console", errors.length === 0, errors.slice(0, 5));
  } catch (err) {
    check("unexpected error", false, String(err && err.stack ? err.stack : err));
  } finally {
    server.close();
    const ok = results.every(Boolean);
    console.log(`[mobile-smoke] RESULT: ${ok ? "OK" : "FAILED"}`);
    app.exit(ok ? 0 : 1);
  }
});
