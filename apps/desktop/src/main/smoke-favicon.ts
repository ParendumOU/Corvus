import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import { BAR_FOLDER_ID } from "../shared/bookmark-tree";
import type { SessionWindow } from "../shared/session-state";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

// 16x16 opaque PNG (solid colour) so naturalWidth is a real, non-zero size.
const ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOQWhBAEmIY1TCqYfhqAAA06QoQ2+LT7gAAAABJRU5ErkJggg==",
  "base64",
);
const page = (title: string, head: string): string => `<!doctype html><html><head><title>${title}</title>${head}</head><body><h1>${title}</h1></body></html>`;
const PAGES: Record<string, string> = {
  "/favicon-page": page("Favicon smoke", `<link rel="icon" type="image/png" href="/smoke-icon.png">`),
  "/favicon-other": page("Favicon other", `<link rel="icon" type="image/png" href="/smoke-icon.png?other">`),
  "/favicon-late": page(
    "Favicon late",
    `<link id="i" rel="icon" href="/missing-icon.png"><script>setTimeout(() => { document.getElementById("i").href = "/smoke-icon.png?late"; }, 1200);</script>`,
  ),
};

/** Where /favicon-away and /favicon-meta send the tab: a page of another local test server. */
const LOCAL_TARGET = /^http:\/\/127\.0\.0\.1:\d+\/[\w/-]*$/;

export function serveFaviconSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  if (pathname === "/favicon-away" || pathname === "/favicon-meta") {
    const to = new URL(req.url ?? "/", "http://127.0.0.1/").searchParams.get("to") ?? "";
    if (!LOCAL_TARGET.test(to)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad target");
    } else if (pathname === "/favicon-away") {
      // A server redirect to another site.
      res.writeHead(302, { Location: to });
      res.end();
    } else {
      // A page that sends the tab on by itself as soon as it opens.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Favicon meta</title><meta http-equiv="refresh" content="0;url=${to}"></head><body>Moving on</body></html>`);
    }
    return true;
  }
  const html = PAGES[pathname];
  if (html) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }
  if (pathname === "/smoke-icon.png") {
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": ICON_PNG.length });
    res.end(ICON_PNG);
    return true;
  }
  if (pathname === "/missing-icon.png") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no icon");
    return true;
  }
  return false;
}

interface SmokeCtx {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface IconProbe {
  img: { src: string; complete: boolean; naturalWidth: number } | null;
  letter: boolean;
  spinner: boolean;
  found: boolean;
}

function probeTabIcon(chrome: WebContents, title: string): Promise<IconProbe> {
  return chrome.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => (t.getAttribute('title') || '').startsWith(${JSON.stringify(title)}));
    if (!tab) return { found: false, img: null, letter: false, spinner: false };
    const img = tab.querySelector('.tab-icon img');
    return {
      found: true,
      img: img ? { src: img.src, complete: img.complete, naturalWidth: img.naturalWidth } : null,
      letter: Boolean(tab.querySelector('.tab-icon .letter-icon')),
      spinner: Boolean(tab.querySelector('.tab-icon .spinner')),
    };
  })()`) as Promise<IconProbe>;
}

const loaded = (p: IconProbe): boolean => Boolean(p.img && p.img.complete && p.img.naturalWidth > 0) && !p.letter;

async function waitIcon(chrome: WebContents, title: string, timeoutMs = 6000): Promise<IconProbe> {
  const end = Date.now() + timeoutMs;
  let probe = await probeTabIcon(chrome, title);
  while (!loaded(probe) && Date.now() < end) {
    await delay(200);
    probe = await probeTabIcon(chrome, title);
  }
  return probe;
}

function timeline(tab: TabRuntime): string[] {
  const wc = tab.view.webContents;
  const start = Date.now();
  const events: string[] = [];
  const at = (name: string): void => {
    events.push(`${Date.now() - start}ms ${name} fav=${tab.faviconUrl ?? "-"} loading=${tab.loading}`);
  };
  wc.on("did-start-loading", () => at("did-start-loading"));
  wc.on("did-navigate", (_e, u) => at(`did-navigate ${u}`));
  wc.on("did-navigate-in-page", (_e, u) => at(`did-navigate-in-page ${u}`));
  wc.on("did-stop-loading", () => at("did-stop-loading"));
  wc.on("page-favicon-updated", (_e, f) => at(`page-favicon-updated ${JSON.stringify(f)}`));
  return events;
}

/**
 * Site favicons in the tab strip, end to end: the chrome UI must show a loaded <img> (naturalWidth
 * > 0), not the letter placeholder, for a live page, after Back, when a page swaps a broken icon for
 * a working one, and for background tabs restored from the session without loading.
 */
export async function runFaviconSmoke(ctx: AppContext, { url, win, check, capture }: SmokeCtx): Promise<void> {
  const chrome = win.chrome.webContents;

  // 1. A page declaring <link rel="icon">.
  const tab = win.createTab(`${url}favicon-page`);
  const events = timeline(tab);
  const first = await waitIcon(chrome, "Favicon smoke");
  check("favicon: tab strip shows the site icon (loaded <img>, not the letter tile)", loaded(first), { first, faviconUrl: tab.faviconUrl ?? null });
  await capture("favicon-tab", chrome);

  // 1b. Corvus's own pages show the site's icon from the cache too (a bookmark on the bookmarks
  // page), while a web page cannot load it from there, with or without a made-up key.
  const mark = win.profile.bookmarks.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Favicon mark", url: `${url}favicon-page` });
  const library = win.createTab("corvus://bookmarks/", { activate: true });
  try {
    const rowIcon = `document.querySelector('.bm-row[data-bookmark-id="${mark.id}"] img.favicon')`;
    let shown: { naturalWidth: number; key: boolean } | null = null;
    for (let i = 0; i < 40 && !(shown && shown.naturalWidth > 0); i++) {
      await delay(200);
      shown = (await library.view.webContents
        .executeJavaScript(`(() => { const img = ${rowIcon}; return img && img.complete ? { naturalWidth: img.naturalWidth, key: img.src.includes("key=") } : null; })()`)
        .catch(() => null)) as { naturalWidth: number; key: boolean } | null;
    }
    check("favicon: the bookmarks page shows a bookmark's site icon from Corvus's cache", Boolean(shown && shown.naturalWidth > 0 && shown.key), shown);
    await capture("favicon-bookmarks-page", library.view.webContents);
  } finally {
    win.closeTab(library.id);
    win.activate(tab.id);
    win.profile.bookmarks.remove(mark.id);
  }
  const leaked = await tab.view.webContents.executeJavaScript(`(async () => {
    const tryLoad = (src) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth);
      img.onerror = () => resolve(0);
      img.src = src;
      setTimeout(() => resolve(-1), 3000);
    });
    const icon = "corvus://favicon/?url=" + encodeURIComponent(location.href);
    return [await tryLoad(icon), await tryLoad(icon + "&key=0123456789abcdef0123456789abcdef")];
  })()`);
  check("favicon: a web page cannot load icons from Corvus's cache", JSON.stringify(leaked) === "[0,0]", leaked);

  // 2. Navigate away and back.
  win.loadUrl(tab.id, `${url}favicon-other`);
  const other = await waitIcon(chrome, "Favicon other");
  win.goBack(tab.id);
  await delay(300);
  const back = await waitIcon(chrome, "Favicon smoke");
  check("favicon: icon survives navigating away and back", loaded(other) && loaded(back), { other, back, events });

  // 3. The first icon 404s, then the page swaps in a working one (the tab's <Favicon> stays mounted).
  const late = win.createTab(`${url}favicon-late`);
  const lateEvents = timeline(late);
  const lateProbe = await waitIcon(chrome, "Favicon late", 8000);
  check("favicon: a page's later icon replaces a failed one", loaded(lateProbe), { lateProbe, faviconUrl: late.faviconUrl ?? null, events: lateEvents });
  win.closeTab(late.id);

  // 4. Session restore: background tabs stay unloaded but show their icon, either the one saved with
  // the session (a data: URL here, so it cannot come from anywhere else) or, for sessions saved
  // without one, the last icon history knows for the page.
  const savedIcon = `data:image/png;base64,${ICON_PNG.toString("base64")}`;
  const saved: SessionWindow = {
    profileId: win.profile.profile.id,
    maximized: false,
    tabs: [
      { url, title: "Smoke", pinned: false },
      { url: `${url}favicon-page`, title: "Favicon smoke", pinned: false },
      { url: `${url}favicon-other?restored`, title: "Favicon restored", pinned: false, faviconUrl: savedIcon },
    ],
    groups: [],
    activeIndex: 0,
  };
  const restored = ctx.sessionRestore.restore({ version: 1, savedAt: Date.now(), windows: [saved] })[0];
  if (!restored) {
    check("favicon: session restore opened a window", false);
  } else {
    await delay(1000);
    const fromHistory = await waitIcon(restored.chrome.webContents, "Favicon smoke");
    const fromSession = await waitIcon(restored.chrome.webContents, "Favicon restored");
    const lazy = restored.tabIds().filter((id) => restored.getTab(id)?.pendingUrl !== undefined).length;
    check(
      "favicon: lazily restored background tabs keep their icon (saved, else from history)",
      loaded(fromHistory) && loaded(fromSession) && fromSession.img?.src === savedIcon && lazy === 2,
      { fromHistory, fromSession: { ...fromSession, img: fromSession.img && { ...fromSession.img, src: fromSession.img.src.slice(0, 30) } }, lazy },
    );
    await capture("favicon-restored", restored.chrome.webContents);
    const resaved = restored.sessionWindow()?.tabs.filter((t) => t.url !== url) ?? [];
    check(
      "favicon: icons of never-loaded tabs survive the next session save",
      resaved.length === 2 && resaved.every((t) => typeof t.faviconUrl === "string" && t.faviconUrl.length > 0),
      resaved.map((t) => ({ url: t.url, faviconUrl: t.faviconUrl?.slice(0, 40) ?? null })),
    );
    restored.close();
    await delay(300);
  }
  win.closeTab(tab.id);

  await runRedirectSmoke({ url, win, check, capture });
}

// A 32x32 icon, so the bookmarks that lead to its site are told apart from the 16x16 one of the
// main test server (naturalWidth).
const LANDING_ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" fill="#1a73e8"/></svg>');

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })));
}

/** The loaded icon of a bookmark on the bookmarks page, or null while it has none. */
async function bookmarkRowIcon(page: WebContents, id: string): Promise<{ naturalWidth: number } | null> {
  return (await page
    .executeJavaScript(`(() => { const img = document.querySelector('.bm-row[data-bookmark-id="${id}"] img.favicon'); return img && img.complete ? { naturalWidth: img.naturalWidth } : null; })()`)
    .catch(() => null)) as { naturalWidth: number } | null;
}

/** Polls `probe` until `done` holds or `timeoutMs` passes; the last value either way. */
async function until<T>(probe: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 8000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let value = await probe();
  while (!done(value) && Date.now() < end) {
    await delay(200);
    value = await probe();
  }
  return value;
}

/**
 * Bookmarks whose address leads to another site show the icon of the page they end on: one never
 * opened (Corvus follows its redirects), one opened through a server redirect, and one through a
 * page that moves on by itself (meta refresh). Another test server plays the other site; the main
 * one already has an icon of its own (16x16), which those bookmarks must not show.
 */
async function runRedirectSmoke({ url, win, check, capture }: SmokeCtx): Promise<void> {
  const landing = await listen((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/landing") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page("Favicon landing", `<link rel="icon" type="image/svg+xml" href="/landing-icon.svg">`));
    } else if (pathname === "/landing-icon.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(LANDING_ICON);
    } else {
      // No /favicon.ico: the icon is only found through the page that names it.
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not here");
    }
  });
  const landingPage = `${landing.url}landing`;
  // A site that moved: every address (its /favicon.ico too) redirects to the landing page.
  const moved = await listen((_req, res) => {
    res.writeHead(302, { Location: landingPage });
    res.end();
  });
  const bookmarks = win.profile.bookmarks;
  const mark = (title: string, address: string): { id: string; url: string } => {
    const b = bookmarks.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title, url: address });
    return { id: b.id, url: address };
  };
  const neverOpened = mark("Favicon moved", moved.url);
  const away = mark("Favicon away", `${url}favicon-away?to=${encodeURIComponent(landingPage)}`);
  const meta = mark("Favicon meta", `${url}favicon-meta?to=${encodeURIComponent(landingPage)}`);
  const chrome = win.chrome.webContents;
  const barIcon = (): Promise<{ naturalWidth: number } | null> =>
    chrome
      .executeJavaScript(`(() => { const img = document.querySelector('.bookmarks-bar .bar-item[title^="Favicon away"] img.favicon'); return img && img.complete ? { naturalWidth: img.naturalWidth, src: img.src } : null; })()`)
      .catch(() => null) as Promise<{ naturalWidth: number } | null>;
  try {
    // 1. Never opened: fetched and followed to the landing page, whose <link rel=icon> it shows.
    const library = win.createTab("corvus://bookmarks/", { activate: true });
    const fresh = await until(
      () => bookmarkRowIcon(library.view.webContents, neverOpened.id),
      (icon) => icon?.naturalWidth === 32,
    );
    check("favicon: a bookmark never opened that redirects to another site shows that site's icon", fresh?.naturalWidth === 32, fresh);
    win.closeTab(library.id);
    // Before it is opened, the redirecting bookmark of the main server shows that server's icon.
    const before = await until(barIcon, (icon) => (icon?.naturalWidth ?? 0) > 0, 4000);

    // 2. Opened in a tab: a server redirect, then a page that moves on by itself.
    const visits: unknown[] = [];
    for (const bookmark of [away, meta]) {
      const tab = win.createTab(bookmark.url, { activate: true });
      const landed = await until(
        async () => ({ url: tab.url, faviconUrl: tab.faviconUrl ?? null }),
        (t) => t.url === landingPage && t.faviconUrl !== null,
      );
      visits.push(landed);
      await delay(300);
      win.closeTab(tab.id);
    }
    const shown = win.createTab("corvus://bookmarks/", { activate: true });
    const awayIcon = await until(
      () => bookmarkRowIcon(shown.view.webContents, away.id),
      (icon) => icon?.naturalWidth === 32,
    );
    const metaIcon = await until(
      () => bookmarkRowIcon(shown.view.webContents, meta.id),
      (icon) => icon?.naturalWidth === 32,
    );
    check("favicon: a bookmark opened through a server redirect shows the final page's icon", awayIcon?.naturalWidth === 32, { awayIcon, visits });
    check("favicon: a bookmark opened through a page that moves on by itself shows the final page's icon", metaIcon?.naturalWidth === 32, { metaIcon, visits });
    await capture("favicon-redirects", shown.view.webContents);
    win.closeTab(shown.id);
    // The bookmarks bar, which had already shown an icon for it, asks again.
    const after = await until(barIcon, (icon) => icon?.naturalWidth === 32);
    check("favicon: the bookmarks bar picks up the icon of where a bookmark leads", before !== null && before.naturalWidth !== 32 && after?.naturalWidth === 32, { before, after });
  } finally {
    for (const b of [neverOpened, away, meta]) bookmarks.remove(b.id);
    landing.server.close();
    moved.server.close();
  }
}
