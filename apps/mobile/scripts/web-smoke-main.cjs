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
  const article = `${base}/smoke/article`;
  const node = (id, parentId, kind, title, position, url) => ({ id, parentId, kind, title, position, createdAt: 1, updatedAt: 1, ...(url ? { url } : {}) });
  await computer.push([
    { collection: "bookmarks", id: "smoke-folder", payload: node("smoke-folder", "bar", "folder", "Smoke folder", 1), deleted: false },
    { collection: "bookmarks", id: "smoke-home", payload: node("smoke-home", "bar", "bookmark", "Smoke home", 0, `${base}/smoke/home`), deleted: false },
    { collection: "bookmarks", id: "smoke-deep", payload: node("smoke-deep", "smoke-folder", "bookmark", "Deep smoke page", 0, `${base}/smoke/deep`), deleted: false },
    ...[
      [`${base}/smoke/visited-1`, "First visited page", Date.now() - 60_000],
      [`${base}/smoke/visited-2`, "Second visit of the day", Date.now() - 120_000],
      [`${base}/smoke/visited-3`, "A page from last week", Date.now() - 7 * 86_400_000],
    ].map(([url, title, visitedAt]) => ({ collection: "history", id: url, payload: { url, title, visitedAt, visitCount: 1 }, deleted: false })),
    {
      collection: "assist_history",
      id: "smoke-conversation",
      payload: {
        url: `${base}/smoke/flights`,
        pageTitle: "Smoke flights",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
        messages: [{ id: "smoke-turn", kind: "ask", prompt: "cheapest flight to Lisbon", text: "Vueling, 111 euros, direct", status: "done", at: Date.now() - 30_000 }],
      },
      deleted: false,
    },
    {
      collection: "watches",
      id: `${base}/smoke/shop`,
      payload: { url: `${base}/smoke/shop`, title: "Smoke shop item", intervalMinutes: 60, paused: false, createdAt: 1, condition: "the price is under 100" },
      deleted: false,
    },
    {
      collection: "watch_status",
      id: deskId,
      payload: {
        device: "Smoke desktop",
        platform: "win32",
        updatedAt: Date.now(),
        watches: [
          {
            url: `${base}/smoke/shop`,
            lastCheckedAt: Date.now() - 60_000,
            lastChangedAt: Date.now() - 120_000,
            result: "changed",
            summary: "The price dropped to 89",
            conditionMet: true,
            conditionDetail: "Price: 89",
          },
        ],
      },
      deleted: false,
    },
    {
      collection: "reading",
      id: article,
      payload: { id: "smoke-article", url: article, title: "A smoke article", siteName: "Smoke", byline: "", excerpt: "About smoke.", markdown: "# A smoke article\n\nBody", keyPoints: [], wordCount: 300, readingMinutes: 2, savedAt: Date.now() },
      deleted: false,
    },
  ]);

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

  // Sent to this phone: a page from the computer shows on the home screen; opening it takes it off the chain.
  const phoneId = (await computer.listDevices()).find((d) => d.name === "Phone")?.id;
  const inboxUrl = `${base}/smoke/for-the-phone`;
  await computer.push([
    { collection: "sent_tabs", id: "smoke-to-phone-1", payload: { url: inboxUrl, title: "For the phone", to: phoneId, fromId: deskId, from: "Smoke desktop", sentAt: Date.now() }, deleted: false },
  ]);
  await win.loadURL(`${base}/`);
  const inboxRow = `document.querySelector('[data-testid="inbox-${inboxUrl}"]')?.innerText ?? ''`;
  const inboxShown = await until(win, `(${inboxRow}).includes("For the phone") && (${inboxRow}).includes("From Smoke desktop")`, 20000);
  await shot(win, "home-inbox");
  await win.webContents.executeJavaScript(`window.open = () => null; document.querySelector('[data-testid="inbox-${inboxUrl}"]').click()`);
  const openedGone = await (async () => {
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
      if ((await computer.pull()).some((i) => i.collection === "sent_tabs" && i.id === "smoke-to-phone-1" && i.deleted)) return true;
    }
    return false;
  })();
  const leftInbox = await until(win, `!document.querySelector('[data-testid="inbox-${inboxUrl}"]')`, 5000);
  check("sent to this phone: a page from the computer shows on the phone, and opening it takes it off the chain", inboxShown && openedGone && leftInbox, await win.webContents.executeJavaScript(inboxRow));

  // Library: the computer's bookmarks and reading list, and changes made on the phone.
  const pulledUntil = async (pred) => {
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
      const item = (await computer.pull()).find(pred);
      if (item) return item;
    }
    return null;
  };
  const tap = (testId) => win.webContents.executeJavaScript(`document.querySelector('[data-testid=${JSON.stringify(testId)}]').click()`);
  const present = (testId) => `Boolean(document.querySelector('[data-testid=${JSON.stringify(testId)}]'))`;
  await win.loadURL(`${base}/library`);
  await until(win, present("folder-Bookmarks bar"), 20000);
  await tap("folder-Bookmarks bar");
  await until(win, present("folder-Smoke folder"));
  const inBar = await until(win, present(`bookmark-${base}/smoke/home`));
  await tap("folder-Smoke folder");
  const inFolder = await until(win, present(`bookmark-${base}/smoke/deep`));
  check("library: bookmarks are browsed folder by folder", inBar && inFolder);
  await tap("crumb-top");
  await typeInto(win, "library-search", "deep smoke");
  check("library: a bookmark is found by its title from any folder", await until(win, present(`bookmark-${base}/smoke/deep`)));
  await typeInto(win, "library-search", "");

  await tap("library-reading");
  const articleListed = await until(win, `(document.querySelector('[data-testid="reading-${article}"]')?.innerText ?? '').includes('2 min read')`);
  await shot(win, "library-reading");
  await tap(`reading-toggle-${article}`);
  const marked = await pulledUntil((i) => i.collection === "reading" && i.id === article);
  check(
    "library: marking an article read on the phone reaches the computer, article intact",
    articleListed && typeof marked?.payload?.readAt === "number" && marked.payload.markdown === "# A smoke article\n\nBody",
    marked?.payload ? { readAt: marked.payload.readAt, markdown: marked.payload.markdown.length } : null,
  );

  await tap("library-history");
  const visited = (n) => present(`history-${base}/smoke/visited-${n}`);
  const historyShown = await until(win, `${present("history-day-Today")} && ${visited(1)} && ${visited(2)} && ${visited(3)}`);
  await shot(win, "library-history");
  await typeInto(win, "library-search", "second visit");
  const historyFound = await until(win, `${visited(2)} && !${visited(1)}`);
  check("history: pages visited on the computer, grouped by day, found by title", historyShown && historyFound);
  await typeInto(win, "library-search", "");


  // Watched pages: what the computer saw, and a watch added on the phone.
  await win.loadURL(`${base}/`);
  const homeCard = await until(win, `(document.querySelector('[data-testid=home-watches]')?.innerText ?? '').includes('1 watched · 1 changed')`, 20000);
  await tap("home-watches");
  const shopCard = `document.querySelector('[data-testid="watch-${base}/smoke/shop"]')?.innerText ?? ''`;
  const watchShown = await until(win, `(${shopCard}).includes('The price dropped to 89') && (${shopCard}).includes('Yes') && (${shopCard}).includes('Smoke desktop')`);
  await shot(win, "watches");
  check("watches: the phone shows what the computer saw, condition included", homeCard && watchShown, await win.webContents.executeJavaScript(shopCard));
  const watchedUrl = "https://example.org/watch-from-phone";
  await typeInto(win, "watch-url", watchedUrl);
  await typeInto(win, "watch-condition", "it is back in stock");
  await tap("watch-every-15");
  await until(win, "document.querySelector('[data-testid=watch-add]')?.getAttribute('aria-disabled') !== 'true'");
  await tap("watch-add");
  const added = await pulledUntil((i) => i.collection === "watches" && i.id === watchedUrl);
  check(
    "watches: a watch added on the phone reaches the computer",
    added?.payload?.intervalMinutes === 15 && added.payload.condition === "it is back in stock" && added.payload.paused === false,
    added?.payload ?? null,
  );

  const keep = async (url, title, action) => {
    await win.loadURL(`${base}/send`);
    await until(win, present("send-url"), 20000);
    await typeInto(win, "send-url", url);
    if (title) await typeInto(win, "send-title", title);
    await until(win, `document.querySelector('[data-testid=${action}]')?.getAttribute('aria-disabled') !== 'true'`);
    await tap(action);
  };
  const later = "https://example.org/read-this-later";
  await keep(later, "", "send-read-later");
  const saved = await pulledUntil((i) => i.collection === "reading" && i.id === later);
  check("share: a link saved for later reaches the computer as a link to fill in", saved?.payload?.markdown === "" && saved.payload.url === later, saved?.payload ?? null);
  // The Open screen, paired: the same actions as Save or send, here saving to the reading list.
  const openedLater = "https://example.org/link-opened-in-corvus";
  await win.loadURL(`${base}/open?url=${encodeURIComponent(openedLater)}`);
  const openActions = await until(win, `${present("open-submit")} && ${present("send-to-Smoke desktop")} && ${present("send-read-later")}`, 20000);
  await shot(win, "open-link-paired");
  await tap("send-read-later");
  const openSaved = await pulledUntil((i) => i.collection === "reading" && i.id === openedLater);
  check("open a link: paired, it can be sent or kept instead, as from Save or send", openActions && openSaved?.payload?.url === openedLater, openSaved?.payload ?? null);

  const marked2 = "https://example.org/bookmark-me";
  await keep(marked2, "Bookmarked on the phone", "send-bookmark");
  const bookmark = await pulledUntil((i) => i.collection === "bookmarks" && i.payload?.url === marked2);
  check(
    "share: a bookmark made on the phone lands in Other bookmarks",
    bookmark?.payload?.parentId === "other" && bookmark.payload.title === "Bookmarked on the phone" && bookmark.payload.kind === "bookmark",
    bookmark?.payload ?? null,
  );

  // Assist: a chat with the computer. The question reaches it, its answer shows as it is written,
  // a suggested follow-up asks again in the same conversation with the earlier turn, and deleting
  // the conversation takes every question off the chain.
  const question = "How long do ravens live?";
  await win.loadURL(`${base}/`);
  await until(win, present("home-ask"), 20000);
  await tap("home-ask");
  await until(win, `${present("chat-new")} && (document.querySelector('[data-testid=chat-computer]')?.innerText ?? '').includes('Smoke desktop')`, 20000);
  await shot(win, "assist-new");
  await typeInto(win, "ask-question", question);
  await until(win, "document.querySelector('[data-testid=ask-submit]')?.getAttribute('aria-disabled') !== 'true'");
  // Enter sends (the keyboard's Send key), without a new line.
  await win.webContents.executeJavaScript("document.querySelector('[data-testid=ask-question]').focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  const asked = await pulledUntil((i) => i.collection === "asks" && i.payload?.question === question);
  check("ask: Enter in the message box sends the question", asked?.payload?.question === question, asked?.payload?.question ?? null);
  const status = (q) => `document.querySelector('[data-testid="ask-status-${q}"]')?.innerText ?? ''`;
  const answerText = `document.querySelector('[data-testid="ask-answer-${question}"]')?.innerText ?? ''`;
  const waitingShown = await until(win, `(${status(question)}).includes("Waiting for Smoke desktop")`, 10000);
  check("ask: a question asked on the phone reaches the computer, addressed to it", asked?.payload?.to === deskId && asked.payload.state === "waiting" && !asked.payload.thread && waitingShown, asked?.payload ?? null);
  if (asked) {
    // The computer writes the answer as Corvus does: its first words at once, then a longer piece
    // every 500 ms, then the whole answer marked done. The phone shows text soon after the first
    // piece and writes it out smoothly (sampled every 100 ms: it never shrinks nor jumps).
    const full =
      "Ravens live **10 to 15 years** in the wild [1]. In captivity some reach 40 years, as the oldest known raven at the Tower of London did. Their long lives come with long pair bonds: most mate for life and defend a territory together for years.";
    const sources = [{ title: "Ravens", url: "https://birds.example/raven" }];
    const answer = { ...asked.payload, state: "answering", answeredBy: "Smoke desktop", answer: "", sources, updatedAt: Date.now() };
    const samples = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        // Without the caret that ends the text while it is written.
        samples.push({ at: Date.now(), length: String(await win.webContents.executeJavaScript(answerText).catch(() => "")).replace(/▍/g, "").trim().length });
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    const pieces = [18, 60, 110, 160, full.length];
    const firstAt = Date.now();
    for (const [i, end] of pieces.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, 500));
      await computer.push([{ collection: "asks", id: asked.id, payload: { ...answer, answer: full.slice(0, end), updatedAt: Date.now() }, deleted: false }]);
    }
    const partial = await until(win, `(${status(question)}).includes("Smoke desktop is writing")`, 5000);
    await computer.push([{ collection: "asks", id: asked.id, payload: { ...answer, state: "done", answer: full, followUps: ["Do ravens mate for life?"], updatedAt: Date.now() }, deleted: false }]);
    const done = await until(win, `(${status(question)}).includes("Answered by Smoke desktop") && (${answerText}).includes("defend a territory together") && ${present("ask-source-https://birds.example/raven")}`, 15000);
    sampling = false;
    await sampler;
    const firstText = samples.find((x) => x.length > 0);
    const shown = samples.filter((x) => x.length > 0).map((x) => x.length);
    const steps = shown.slice(1).map((n, i) => n - shown[i]);
    console.log(`[mobile-smoke] time to first visible text: ${firstText ? firstText.at - firstAt : -1} ms after the computer wrote it; ${shown.length} samples, largest step ${Math.max(0, ...steps)} characters`);
    check(
      "ask: the answer appears soon after the computer's first words and is written out smoothly, never shrinking or jumping",
      partial && !!firstText && firstText.at - firstAt < 2500 && steps.every((d) => d >= 0 && d <= 40) && shown.length >= 8,
      { firstTextMs: firstText ? firstText.at - firstAt : null, steps },
    );
    const cite = await win.webContents.executeJavaScript(`(() => {
      const pill = document.querySelector('[data-testid="ask-answer-${question}"] [data-testid=cite-1]');
      const r = pill?.getBoundingClientRect();
      return r ? { height: Math.round(r.height), width: Math.round(r.width) } : null;
    })()`);
    await shot(win, "ask");
    check("ask: the phone shows the answer as the computer writes it, then with its sources", partial && done, await win.webContents.executeJavaScript(answerText));
    check("ask: citations are small pills in the line, at text height", !!cite && cite.height <= 18 && cite.width <= 24, cite);

    const followUp = "Do ravens mate for life?";
    await until(win, present(`follow-up-${followUp}`), 5000);
    await tap(`follow-up-${followUp}`);
    const next = await pulledUntil((i) => i.collection === "asks" && i.payload?.question === followUp);
    const turn = next?.payload?.context?.[0];
    check(
      "ask: a suggested follow-up asks again in the same conversation, with the earlier question and answer",
      next?.payload?.thread === asked.id && turn?.question === question && turn.answer.startsWith("Ravens live 10 to 15 years in the wild. In captivity") && (await until(win, `(${status(followUp)}).includes("Waiting for Smoke desktop")`, 10000)),
      next?.payload ?? null,
    );

    // Stop, as in other AI chats: while an answer is coming the send button stops it when the box is
    // empty. A message sent meanwhile stops it where it is and is answered with it, as the next turn
    // of the same conversation. The computer is a fake here, so it writes what Corvus would.
    const chain = new Map();
    const onChain = async (pred) => {
      for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
        for (const i of await computer.pull()) if (i.collection === "asks") chain.set(i.id, i);
        const found = [...chain.values()].find(pred);
        if (found) return found;
      }
      return null;
    };
    const stopButton = "document.querySelector('[data-testid=ask-stop]')";
    const sendEnabled = "document.querySelector('[data-testid=ask-submit]')?.getAttribute('aria-disabled') !== 'true'";
    const extra = "And do they mourn their partner?";
    let threadIds = [asked.id];
    if (next) {
      const partial = "Most ravens pair for life and";
      const writing = { ...next.payload, state: "answering", answeredBy: "Smoke desktop", answer: partial, sources, updatedAt: Date.now() };
      await computer.push([{ collection: "asks", id: next.id, payload: writing, deleted: false }]);
      const stopShown = await until(win, `(${status(followUp)}).includes("Smoke desktop is writing") && ${stopButton}?.getAttribute('aria-label') === 'Stop'`, 10000);
      await shot(win, "ask-stop-button");
      await typeInto(win, "ask-question", extra);
      const sendsWhenTyped = await until(win, `!${stopButton} && ${sendEnabled}`, 5000);
      check("ask: while an answer is coming, the send button is a Stop button until something is typed", stopShown && sendsWhenTyped);

      await tap("ask-submit");
      const oneChat = await until(
        win,
        `(${status(followUp)}).includes("Stopped") && (document.querySelector('[data-testid="ask-answer-${followUp}"]')?.innerText ?? '').includes("pair for life") && (${status(extra)}).includes("Waiting for Smoke desktop")`,
        10000,
      );
      await shot(win, "ask-interrupted");
      // The computer, still writing the stopped answer without having seen the deletion (it has not
      // pulled since its last write), gets the deletion back instead of bringing the question back.
      const late = await computer.push([{ collection: "asks", id: next.id, payload: { ...writing, answer: `${partial} defend a territory`, updatedAt: Date.now() }, deleted: false }]);
      const copy = await onChain((i) => !i.deleted && i.payload?.stopped === true && i.payload.question === followUp);
      const added = await onChain((i) => !i.deleted && i.payload?.question === extra);
      // That conflict is the deletion: the computer now knows it, so no pull brings it again.
      const gone = late.conflicts.some((c) => c.id === next.id && c.deleted);
      const last = added?.payload?.context?.at(-1);
      check(
        "ask: a message sent while an answer is coming stops it where it is and is answered with it, in the same conversation",
        !!copy &&
          gone &&
          copy.payload.state === "done" &&
          copy.payload.answer === partial &&
          copy.payload.thread === asked.id &&
          copy.payload.askedAt === next.payload.askedAt &&
          added?.payload?.thread === asked.id &&
          last?.question === followUp &&
          last.answer === partial &&
          oneChat,
        { copy: copy?.payload ?? null, context: added?.payload?.context ?? null, gone, oneChat },
      );

      // The Stop button itself: the answer to the new message stops where it is, marked as stopped.
      if (added) {
        const writing2 = { ...added.payload, state: "answering", answeredBy: "Smoke desktop", answer: "Ravens have been seen", updatedAt: Date.now() };
        await computer.push([{ collection: "asks", id: added.id, payload: writing2, deleted: false }]);
        await until(win, `(${status(extra)}).includes("Smoke desktop is writing") && ${stopButton}`, 10000);
        await tap("ask-stop");
        const copy2 = await onChain((i) => !i.deleted && i.payload?.stopped === true && i.payload.question === extra);
        const gone2 = await onChain((i) => i.id === added.id && i.deleted);
        const stopped = await until(win, `(${status(extra)}).includes("Stopped") && !${stopButton} && !(${sendEnabled})`, 10000);
        await shot(win, "ask-stopped");
        check("ask: Stop stops the answer being written; what came of it stays, marked Stopped", !!copy2 && !!gone2 && copy2.payload.answer === "Ravens have been seen" && copy2.payload.thread === asked.id && stopped, copy2?.payload ?? null);
        threadIds = [asked.id, copy?.id, copy2?.id].filter(Boolean);
      }
    }

    await win.loadURL(`${base}/assist`);
    const listed = await until(win, `(document.querySelector('[data-testid="chat-${question}"]')?.innerText ?? '').includes('Smoke desktop') && ${present("chat-assist-smoke-conversation")}`, 20000);
    await shot(win, "assist");
    check("assist: the phone's conversation and the computer's Assist conversation are listed together", listed);
    const split = await win.webContents.executeJavaScript(`${present(`chat-${followUp}`)} || ${present(`chat-${extra}`)}`);
    check("assist: a stopped answer and the message that interrupted it stay in their one conversation", listed && !split);

    await tap(`chat-${question}`);
    await until(win, present("chat-delete"), 10000);
    await tap("chat-delete");
    await until(win, present("dialog-confirm"), 5000);
    await tap("dialog-confirm");
    const deleted = new Set();
    for (const end = Date.now() + 15000; threadIds.some((id) => !deleted.has(id)) && Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
      for (const i of await computer.pull()) if (i.collection === "asks" && i.deleted) deleted.add(i.id);
    }
    check("ask: deleting a conversation takes all its questions off the chain", threadIds.every((id) => deleted.has(id)), { expected: threadIds, deleted: [...deleted] });
  }

  // A computer's Assist conversation: read in the same chat view; writing below continues it as a
  // new conversation of the phone that quotes it and carries its turns.
  await win.loadURL(`${base}/assist`);
  await until(win, present("chat-assist-smoke-conversation"), 20000);
  await tap("chat-assist-smoke-conversation");
  const answered = await until(win, `(document.querySelector('[data-testid="conversation-answer-smoke-turn"]')?.innerText ?? '').includes('Vueling') && ${present("chat-continue-note")}`, 10000);
  await shot(win, "assist-conversation");
  check("assist conversations from the computer show on the phone and open to read", answered);
  const continued = "And the cheapest hotel there?";
  await typeInto(win, "ask-question", continued);
  await until(win, "document.querySelector('[data-testid=ask-submit]')?.getAttribute('aria-disabled') !== 'true'");
  await tap("ask-submit");
  const quoted = await pulledUntil((i) => i.collection === "asks" && i.payload?.question === continued);
  check(
    "assist: replying to a computer's conversation starts a phone conversation that quotes it and carries its turns",
    quoted?.payload?.origin?.conversation === "smoke-conversation" &&
      quoted.payload.context?.[0]?.question === "cheapest flight to Lisbon" &&
      quoted.payload.context[0].answer === "Vueling, 111 euros, direct" &&
      (await until(win, present("chat-origin"), 10000)),
    quoted?.payload ?? null,
  );
  if (quoted) await computer.push([{ collection: "asks", id: quoted.id, payload: null, deleted: true }]);

  await win.loadURL(`${base}/settings`);
  const listed = await until(win, "document.querySelector('[data-testid=\"device-Smoke desktop\"]') && document.querySelector('[data-testid=\"device-Phone\"]')?.textContent.includes('(this phone)')", 20000);
  const devices = await computer.listDevices();
  check("pairing: the app joins the computer's sync chain and lists both devices", listed && devices.some((d) => d.name === "Phone"), {
    devices: devices.map((d) => `${d.name}/${d.platform}`),
  });
  await shot(win, "settings-paired");
  await until(win, "document.querySelector('[data-testid=settings-unpair]')");
  await win.webContents.executeJavaScript("document.querySelector('[data-testid=settings-unpair]').click()");
  // The app asks first, in its own dialog.
  const confirmAsked = await until(win, "document.querySelector('[data-testid=dialog-confirm]')", 5000);
  await shot(win, "settings-unpair-dialog");
  await win.webContents.executeJavaScript("document.querySelector('[data-testid=dialog-confirm]')?.click()");
  const unpaired = confirmAsked && (await until(win, "document.querySelector('[data-testid=settings-pair]')", 15000));
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
    const settings = await screen(win, base, "/settings", "settings", "/^\\d+\\.\\d+\\.\\d+/.test(document.querySelector('[data-testid=app-version]')?.textContent ?? '')");
    check("settings screen shows the app version", settings);
    const browserCard = await win.webContents.executeJavaScript("Boolean(document.querySelector('[data-testid=default-browser-card]'))");
    check("settings: no default browser card outside Android", !browserCard);

    // A web link Corvus is asked to open as the phone's browser (Android) lands on the Open screen;
    // here, unpaired, it offers Open (a new tab on the web) and a hint to pair.
    const link = "https://example.org/opened-with-corvus?x=1#part";
    let openedLink = null;
    win.webContents.setWindowOpenHandler(({ url }) => {
      openedLink = url;
      return { action: "deny" };
    });
    const openShown = await screen(
      win,
      base,
      `/open?url=${encodeURIComponent(link)}`,
      "open-link",
      `document.querySelector('[data-testid=open-url]')?.textContent === ${JSON.stringify(link)} && document.querySelector('[data-testid=open-pair]')`,
    );
    await win.webContents.executeJavaScript("document.querySelector('[data-testid=open-submit]')?.click()");
    for (const end = Date.now() + 5000; openedLink === null && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
    check("open a link: the Open screen shows the link and opens it with one tap (unpaired: with a hint to pair)", openShown && openedLink === link, openedLink);

    // Corvus's browser (on the web build its page is a stand-in card): a link opens in a tab with its
    // site in the address bar, the page menu has Corvus's actions, and the address bar searches.
    const page = "https://example.com/browsed?x=1";
    const browserShown = await screen(
      win,
      base,
      `/browser?open=${encodeURIComponent(page)}`,
      "browser",
      `document.querySelector('[data-testid=browser-page-url]')?.textContent === ${JSON.stringify(page)} && (document.querySelector('[data-testid=browser-address]')?.innerText ?? '').includes('example.com')`,
    );
    await win.webContents.executeJavaScript("document.querySelector('[data-testid=browser-menu]')?.click()");
    const menuShown = await until(win, "Boolean(document.querySelector('[data-testid=menu-ask]')) && Boolean(document.querySelector('[data-testid=menu-bookmark]')) && Boolean(document.querySelector('[data-testid=menu-desktop]'))", 5000);
    await shot(win, "browser-menu");
    check("browser: a link opens in a tab with its site in the address bar, and the page menu has Corvus's actions", browserShown && menuShown);
    await screen(win, base, "/browser?edit=1", "browser-new-tab", "Boolean(document.querySelector('[data-testid=browser-address-input]'))");
    await typeInto(win, "browser-address-input", "what do crows eat");
    const searchOffered = await until(win, "(document.querySelector('[data-testid=browser-suggest-go]')?.innerText ?? '').includes('DuckDuckGo')", 5000);
    await shot(win, "browser-search");
    check("browser: the address bar offers to search with DuckDuckGo", searchOffered);
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
