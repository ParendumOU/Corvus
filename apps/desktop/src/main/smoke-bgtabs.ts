import { spawnSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { app, nativeImage, type NativeImage, type WebContents } from "electron";
import { AGENT_RENDER_CAP, AGENT_RENDER_CAP_LOW_MEMORY, OPEN_ALL_LOAD_NOW } from "../shared/background-tabs";
import { OTHER_FOLDER_ID } from "../shared/bookmark-tree";
import { openBookmarkFolder } from "./bookmark-actions";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

export interface BgTabsSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
  log: (step: string, data: unknown) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The test page's own color, and the color of its (lazy, slow) images. */
const PAGE_RGB = [51, 102, 204] as const;
const IMAGE_RGB = [255, 0, 0] as const;
const IMAGES = 12;
const IMAGE_DELAY_MS = 400;

function page(title: string, opts: { animate: boolean; imageDelay: number }): string {
  const images = Array.from({ length: IMAGES }, (_, i) => `<img loading="lazy" width="120" height="90" alt="" src="/bg-img?i=${i}&delay=${opts.imageDelay}&t=${encodeURIComponent(title)}">`).join("");
  return `<!doctype html><html><head><title>${title}</title><style>
body{margin:0;background:rgb(${PAGE_RGB.join(",")});font:16px sans-serif}
img{display:inline-block;margin:4px;vertical-align:top}
.spin{width:40px;height:40px;background:#fff;${opts.animate ? "animation:s 1s linear infinite" : ""}}
@keyframes s{to{transform:rotate(360deg)}}
#go{position:absolute;left:300px;top:320px;font-size:40px;color:#fff}
</style></head><body><div class="spin"></div><div id="imgs">${images}</div>
<a id="go" href="/bg?title=${encodeURIComponent(`${title} linked`)}">Linked page</a>
<script>
window.__input = { clicks: 0, keys: 0 };
window.__frames = 0;
(function frame() { window.__frames++; requestAnimationFrame(frame); })();
addEventListener("mousedown", () => window.__input.clicks++, true);
addEventListener("keydown", () => window.__input.keys++, true);
</script></body></html>`;
}

const IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="rgb(${IMAGE_RGB.join(",")})"/></svg>`;
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#e33"/></svg>`;

/** A 440 Hz tone, 8 kHz mono 8-bit PCM: a media file made on the spot. */
function toneWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) wav[44 + i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return wav;
}
const TONE = toneWav(20);

/**
 * A page that plays by itself in every way the tab's hold covers: a video and an audio element with
 * autoplay, and an audio element its script starts 300 ms after load (window.__late: what its play()
 * promise did).
 */
function mediaPage(title: string): string {
  return `<!doctype html><html><head><title>${title}</title><link rel="icon" href="/bg-icon.svg"></head><body>
<video id="video" autoplay muted loop src="/bg-tone.wav"></video>
<audio id="audio" autoplay loop src="/bg-tone.wav"></audio>
<audio id="late" loop src="/bg-tone.wav"></audio>
<script>
window.__late = "not yet";
addEventListener("load", () => setTimeout(() => {
  window.__late = "pending";
  document.getElementById("late").play().then(() => (window.__late = "played"), (e) => (window.__late = "failed " + e.name));
}, 300));
</script></body></html>`;
}

function serve(): Promise<{ base: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname === "/bg-media") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(mediaPage(u.searchParams.get("title") ?? "Background media"));
      return;
    }
    if (u.pathname === "/bg-tone.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": TONE.length });
      res.end(TONE);
      return;
    }
    if (u.pathname === "/bg-icon.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(ICON);
      return;
    }
    if (u.pathname === "/bg-img") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
        res.end(IMAGE);
      }, Number(u.searchParams.get("delay") ?? 0));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page(u.searchParams.get("title") ?? "Background page", { animate: u.searchParams.get("anim") === "1", imageDelay: Number(u.searchParams.get("idelay") ?? IMAGE_DELAY_MS) }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() })));
}

function loaded(wc: WebContents, ms = 15_000): Promise<void> {
  return new Promise((resolve) => {
    if (wc.getURL() && !wc.isLoading()) return resolve();
    const timer = setTimeout(resolve, ms);
    wc.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return fn();
}

/** Waits until the test page in `wc` has all its (lazy, slow) images, generously: a busy machine loads them late. */
function imagesLoaded(wc: WebContents, ms = 20_000): Promise<boolean> {
  return until(async () => (await pageState(wc))?.images === IMAGES, ms);
}

interface PageState {
  ready: string;
  title: string;
  width: number;
  height: number;
  images: number;
  clicks: number;
  keys: number;
  referrer: string;
}

function pageState(wc: WebContents): Promise<PageState | null> {
  return wc
    .executeJavaScript(
      "({ ready: document.readyState, title: document.title, width: innerWidth, height: innerHeight, images: [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length, clicks: window.__input?.clicks ?? -1, keys: window.__input?.keys ?? -1, referrer: document.referrer })",
    )
    .catch(() => null) as Promise<PageState | null>;
}

/** The pixel at a point of an image, as [r, g, b]. */
function pixel(image: NativeImage, x: number, y: number): number[] {
  const { width } = image.getSize();
  const bmp = image.toBitmap();
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [bmp[i + 2]!, bmp[i + 1]!, bmp[i]!];
}

const near = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= 6);

/** The test page as captured: its own color in a corner, and the first lazy image drawn. */
function showsPage(image: NativeImage, scale = 1): { page: boolean; image: boolean; size: Electron.Size } {
  const size = image.getSize();
  return { page: near(pixel(image, size.width - 6, size.height - 6), PAGE_RGB), image: near(pixel(image, 60 * scale, 90 * scale), IMAGE_RGB), size };
}

function decode(base64: string): NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
}

/**
 * A click and a key press as the person makes them: real X input (XTest) at a point of the screen,
 * which the window hands to whatever view is on top there; then the pointer and the keyboard focus
 * go back where they were, so what runs next finds the display as it was. Null when this display
 * cannot fake input.
 */
function personInput(x: number, y: number): boolean | null {
  const script = `
import ctypes, sys, time
x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
xt = ctypes.cdll.LoadLibrary("libXtst.so.6")
vp, ul, ui, i, pi = ctypes.c_void_p, ctypes.c_ulong, ctypes.c_uint, ctypes.c_int, ctypes.POINTER(ctypes.c_int)
x11.XOpenDisplay.restype = vp
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ul
x11.XDefaultRootWindow.argtypes = [vp]
x11.XQueryPointer.argtypes = [vp, ul, ctypes.POINTER(ul), ctypes.POINTER(ul), pi, pi, pi, pi, ctypes.POINTER(ui)]
x11.XGetInputFocus.argtypes = [vp, ctypes.POINTER(ul), pi]
x11.XSetInputFocus.argtypes = [vp, ul, i, ul]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [vp, ul]
x11.XFlush.argtypes = [vp]
x11.XSync.argtypes = [vp, i]
xt.XTestFakeMotionEvent.argtypes = [vp, i, i, i, ul]
xt.XTestFakeButtonEvent.argtypes = [vp, ui, i, ul]
xt.XTestFakeKeyEvent.argtypes = [vp, ui, i, ul]
d = x11.XOpenDisplay(None)
ignore = ctypes.CFUNCTYPE(i, vp, vp)(lambda display, error: 0)
x11.XSetErrorHandler(ignore)
if not d:
    sys.exit(3)
# Where the pointer and the keyboard focus were, to leave the display as it was for what runs next.
root, child, focus = ul(), ul(), ul()
rx, ry, wx, wy, revert = i(), i(), i(), i(), i()
mask = ui()
x11.XQueryPointer(d, x11.XDefaultRootWindow(d), ctypes.byref(root), ctypes.byref(child), ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(mask))
x11.XGetInputFocus(d, ctypes.byref(focus), ctypes.byref(revert))
xt.XTestFakeMotionEvent(d, -1, int(sys.argv[1]), int(sys.argv[2]), 0)
xt.XTestFakeButtonEvent(d, 1, 1, 0)
xt.XTestFakeButtonEvent(d, 1, 0, 0)
key = x11.XKeysymToKeycode(d, 0x61)
xt.XTestFakeKeyEvent(d, key, 1, 0)
xt.XTestFakeKeyEvent(d, key, 0, 0)
x11.XSync(d, 0)
time.sleep(0.6)
xt.XTestFakeMotionEvent(d, -1, rx.value, ry.value, 0)
x11.XSetInputFocus(d, focus.value, revert.value, 0)
x11.XSync(d, 0)
`;
  if (process.platform !== "linux" || !process.env.DISPLAY) return null;
  const run = spawnSync("python3", ["-c", script, String(Math.round(x)), String(Math.round(y))], { timeout: 10_000 });
  return run.status === 0 ? true : null;
}

/** A middle click on the page's link, as the person makes it in the tab on screen. */
async function middleClickLink(wc: WebContents): Promise<void> {
  const box = (await wc.executeJavaScript("(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 }; })()")) as { x: number; y: number };
  wc.sendInputEvent({ type: "mouseMove", x: box.x, y: box.y });
  wc.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "middle", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "middle", clickCount: 1 });
}

/** The tab a middle click in `front` opened, once it is there. */
async function openedFrom(win: BrowserWindowCtl, front: TabRuntime, before: readonly string[]): Promise<TabRuntime | undefined> {
  await until(() => win.tabIds().some((id) => !before.includes(id)), 6000);
  const id = win.tabIds().find((t) => !before.includes(t) && win.openerOf(t) === front.id);
  return id ? win.getTab(id) : undefined;
}

/** ms from showing a tab until it is drawn complete (its color and its first image on screen). */
async function timeToComplete(win: BrowserWindowCtl, tab: TabRuntime): Promise<{ firstPaint: number; complete: number }> {
  const start = Date.now();
  win.activate(tab.id);
  let firstPaint = -1;
  let complete = -1;
  while (Date.now() - start < 8000 && complete < 0) {
    const image = await tab.view.webContents.capturePage().catch(() => null);
    if (image && !image.isEmpty()) {
      const shown = showsPage(image);
      if (firstPaint < 0 && shown.page) firstPaint = Date.now() - start;
      if (shown.page && shown.image) complete = Date.now() - start;
    }
    if (complete < 0) await sleep(10);
  }
  return { firstPaint, complete };
}

interface MediaState {
  elements: Array<{ id: string; paused: boolean; time: number }>;
  late: string;
  visibility: string;
}

/** The media page's elements (paused, seconds played), what its script's play() did, and whether it is hidden. */
function mediaState(wc: WebContents): Promise<MediaState | null> {
  return wc
    .executeJavaScript(
      '({ elements: [...document.querySelectorAll("video, audio")].map((m) => ({ id: m.id, paused: m.paused, time: Math.round(m.currentTime * 100) / 100 })), late: window.__late, visibility: document.visibilityState })',
    )
    .catch(() => null) as Promise<MediaState | null>;
}

/** Every media element plays: not paused, and past `seconds`. */
const allPlaying = (s: MediaState | null, seconds = 0.3): boolean => Boolean(s && s.elements.length === 3 && s.elements.every((m) => !m.paused && m.time > seconds));
/** No media element has played: paused, still at the start. */
const nonePlayed = (s: MediaState | null): boolean => Boolean(s && s.elements.length === 3 && s.elements.every((m) => m.paused && m.time < 0.25));

/**
 * Background tabs (CORVUS_SMOKE_ONLY=bgtabs; also in the full run): a tab the person opens in the
 * background loads at once (its title and icon show) but plays nothing until they first go to it,
 * neither autoplay nor what its script starts later, and it is muted meanwhile; shown, it plays,
 * with the mute the person chose. Tabs an MCP client opens in the background play as before and
 * render, so screenshots show the page without taking the person's tab or focus; only the most
 * recently used agent tabs keep painting, and a capture paints any other; the person's clicks and
 * keys reach only the tab on screen.
 */
export async function runBgTabsSmoke(ctx: AppContext, h: BgTabsSmokeHelpers): Promise<void> {
  const { win, check, capture, log } = h;
  const { base, close } = await serve();
  const before = ctx.settings.get();
  const freeShare = ctx.tabSleeper.freeShare;
  const opened: string[] = [];
  const keep = (tab: { id: string } | undefined): void => void (tab && opened.push(tab.id));
  const c = ctx.controller;
  try {
    ctx.settings.update({ agent: { renderInBackground: true } });
    const front = win.createTab(`${base}bg?title=Front`, { activate: true });
    keep(front);
    await loaded(front.view.webContents);
    await sleep(800);
    const content = front.view.getBounds();

    // A middle click opens the link in a background tab that loads at once, at the window's size, without painting.
    let ids = win.tabIds();
    await middleClickLink(front.view.webContents);
    const linked = await openedFrom(win, front, ids);
    keep(linked);
    if (linked) await loaded(linked.view.webContents);
    const state = linked ? await until(async () => (await pageState(linked.view.webContents))?.ready === "complete", 15_000).then(() => pageState(linked.view.webContents)) : null;
    check(
      "background tabs: a middle-clicked link loads in the background at the window's size, named after its page, without painting",
      Boolean(linked) &&
        win.activeTab()?.id === front.id &&
        state?.ready === "complete" &&
        state.title === "Front linked" &&
        linked?.title === "Front linked" &&
        state.width === content.width &&
        state.height === content.height &&
        state.referrer.startsWith(base) &&
        linked !== undefined &&
        !win.isPainting(linked) &&
        !linked.view.getVisible(),
      { linked: Boolean(linked), active: win.activeTab()?.id === front.id, state, title: linked?.title, painting: linked && win.isPainting(linked), content },
    );

    // A page that plays by itself, opened in the background: its title and icon show, nothing plays.
    win.activate(front.id);
    ids = win.tabIds();
    await front.view.webContents.executeJavaScript("document.getElementById('go').href = '/bg-media?title=Background%20media'; true");
    await middleClickLink(front.view.webContents);
    const media = await openedFrom(win, front, ids);
    keep(media);
    const mwc = media?.view.webContents;
    if (mwc) await loaded(mwc);
    const named = media ? await until(() => media.title === "Background media" && media.faviconUrl === `${base}bg-icon.svg`, 10_000) : false;
    check(
      "background tabs: a background tab gets its page's title and icon without being shown",
      named && win.activeTab()?.id === front.id && media?.view.getVisible() === false,
      { title: media?.title, favicon: media?.faviconUrl, active: win.activeTab()?.id === front.id },
    );
    // Long enough for autoplay and for the script's own play() 300 ms after load.
    await until(async () => (mwc ? (await mediaState(mwc))?.late : "") === "pending", 8000);
    await sleep(1500);
    const held = mwc ? await mediaState(mwc) : null;
    check(
      "background tabs: in a background tab nothing plays, neither autoplay nor a play() its script calls, and it is muted meanwhile",
      nonePlayed(held) && held?.late === "pending" && held.visibility === "hidden" && mwc?.isAudioMuted() === true && mwc.isCurrentlyAudible() === false && media?.mediaHold !== undefined,
      { held, muted: mwc?.isAudioMuted(), audible: mwc?.isCurrentlyAudible(), hold: media?.mediaHold },
    );
    // Its menu says what the person chose, not the hold: unmuted; a mute chosen now is kept for when it is shown.
    check("background tabs: the hold does not show as the person's mute", media !== undefined && !win.isMuted(media.id));

    // The same page in a tab an agent opens in the background plays as before.
    const agentMedia = await c.openTab(`${base}bg-media?title=Agent%20media`, { background: true, agent: true });
    keep(agentMedia);
    const awc = win.getTab(agentMedia.id)?.view.webContents;
    const agentPlays = awc ? await until(async () => allPlaying(await mediaState(awc)), 10_000) : false;
    check("background tabs: an agent's background tab plays as before", agentPlays && win.getTab(agentMedia.id)?.mediaHold === undefined && awc?.isAudioMuted() === false, awc && (await mediaState(awc)));
    win.closeTab(agentMedia.id);

    // Without the hold (an extension's background tab), whether Chromium in Electron holds a never-shown tab's media by itself.
    const plain = win.createTab(`${base}bg-media?title=Plain%20media`, { activate: false });
    keep(plain);
    await loaded(plain.view.webContents);
    await sleep(2500);
    const unheld = await mediaState(plain.view.webContents);
    log("background tabs: a never-shown tab without the hold (Electron's own behaviour)", { plays: allPlaying(unheld, 0.1), unheld });
    win.closeTab(plain.id);

    // A bookmark opened in the background holds too; the mute the person chooses meanwhile stays once shown.
    ids = win.tabIds();
    win.openUrl(`${base}bg-media?title=Muted%20media`, "background-tab");
    const marked = win.getTab(win.tabIds().find((id) => !ids.includes(id)) ?? "")!;
    keep(marked);
    await loaded(marked.view.webContents);
    win.setMuted(marked.id, true);
    await until(async () => (await mediaState(marked.view.webContents))?.late === "pending", 8000);
    await sleep(1500);
    const markedState = await mediaState(marked.view.webContents);
    const markedHeld = marked.mediaHold !== undefined && win.isMuted(marked.id) && nonePlayed(markedState) && markedState?.late === "pending";

    // Shown, the held tab plays: autoplay and the script's play() start, and its sound is on.
    if (media) {
      win.activate(media.id);
      const plays = mwc ? await until(async () => allPlaying(await mediaState(mwc)), 10_000) : false;
      const shown = mwc ? await mediaState(mwc) : null;
      check(
        "background tabs: shown, the held tab plays (autoplay and the script's play()), with its sound on",
        plays && shown?.late === "played" && mwc?.isAudioMuted() === false && media.mediaHold === undefined,
        { shown, muted: mwc?.isAudioMuted() },
      );
      await capture("bgtabs-media-shown", media.view.webContents);
    }
    win.activate(marked.id);
    const markedPlays = await until(async () => allPlaying(await mediaState(marked.view.webContents)), 10_000);
    check(
      "background tabs: a bookmark opened in the background holds its media too; muted by the person meanwhile, it plays muted once shown",
      markedHeld && markedPlays && marked.view.webContents.isAudioMuted() && win.isMuted(marked.id),
      { markedHeld, markedState, markedPlays, muted: marked.view.webContents.isAudioMuted() },
    );
    win.activate(front.id);
    await sleep(300);

    // An MCP client's background tab renders: its screenshot shows the page, and the person's tab and focus stay.
    front.view.webContents.focus();
    await sleep(200);
    const focusBefore = front.view.webContents.isFocused();
    const mcpTab = await c.openTab(`${base}bg?title=Agent%20background`, { background: true, agent: true });
    keep(mcpTab);
    // tab_open returns at the page's load; its lazy images come in after it.
    await imagesLoaded(win.getTab(mcpTab.id)!.view.webContents);
    const snap = await c.snapshot(mcpTab.id, { maxChars: 500 });
    const mcpShot = await c.capture(mcpTab.id, { mode: "viewport", format: "png" });
    const mcpImage = decode(mcpShot.base64);
    const mcpDrawn = showsPage(mcpImage);
    check(
      "background tabs: tab_open in the background, then screenshot, shows the page at full size",
      mcpDrawn.page && mcpDrawn.image && mcpShot.width === content.width && mcpShot.height === content.height && (snap.viewport?.width ?? 0) === content.width,
      { drawn: mcpDrawn, width: mcpShot.width, height: mcpShot.height, viewport: snap.viewport, content },
    );
    check(
      "background tabs: ...without changing the person's tab or focus",
      win.activeTab()?.id === front.id && front.view.webContents.isFocused() === focusBefore && !win.getTab(mcpTab.id)!.view.getVisible(),
      { active: win.activeTab()?.id, front: front.id, focusBefore, focusAfter: front.view.webContents.isFocused() },
    );
    const legacy = await c.screenshot(mcpTab.id);
    check("background tabs: the plain screenshot of it works too", showsPage(decode(legacy.base64)).page, { bytes: legacy.base64.length });
    await capture("bgtabs-agent-background", win.getTab(mcpTab.id)!.view.webContents);

    // Ten agent tabs: only the most recent keep painting; a screenshot of the oldest paints it on demand.
    const agentTabs = [mcpTab];
    for (let i = 1; i < 10; i++) {
      const t = await c.openTab(`${base}bg?title=Agent%20${i}&idelay=0`, { background: true, agent: true });
      keep(t);
      agentTabs.push(t);
    }
    const painting = ctx.backgroundRender.rendering();
    const oldest = agentTabs[0]!.id;
    check(
      `background tabs: of 10 agent tabs, the ${AGENT_RENDER_CAP} used last keep painting`,
      painting.length === AGENT_RENDER_CAP && !painting.includes(oldest) && !painting.includes(agentTabs[1]!.id) && painting[0] === agentTabs[9]!.id,
      { painting: painting.length, oldest: painting.includes(oldest) },
    );
    const oldTab = win.getTab(oldest)!;
    check("background tabs: an agent tab over the cap stops painting", !win.isPainting(oldTab), oldTab.paintHolds);
    // Its page changes while it does not paint; the screenshot paints it on demand and shows the change.
    await oldTab.view.webContents.executeJavaScript("document.body.style.background = 'rgb(0, 160, 0)'; true");
    const started = Date.now();
    const onDemand = decode((await c.capture(oldest, { mode: "viewport", format: "png" })).base64);
    const corner = pixel(onDemand, onDemand.getSize().width - 6, onDemand.getSize().height - 6);
    check(
      "background tabs: the screenshot of the least recently used agent tab paints it on demand",
      near(corner, [0, 160, 0]) && showsPage(onDemand).image,
      { corner, ms: Date.now() - started },
    );
    check(
      "background tabs: using it again brings it back among the painting ones, still within the cap",
      ctx.backgroundRender.rendering()[0] === oldest && ctx.backgroundRender.rendering().length === AGENT_RENDER_CAP,
      ctx.backgroundRender.rendering().length,
    );
    ctx.tabSleeper.freeShare = () => 0.05;
    ctx.backgroundRender.enforce();
    check(`background tabs: low on memory, only ${AGENT_RENDER_CAP_LOW_MEMORY} keep painting`, ctx.backgroundRender.rendering().length === AGENT_RENDER_CAP_LOW_MEMORY, ctx.backgroundRender.rendering().length);
    ctx.tabSleeper.freeShare = freeShare;

    // The person's click and key press reach the tab on screen, never a hidden agent tab painting under it.
    win.activate(front.id);
    for (const t of agentTabs.slice(-4)) win.markAgent(t.id);
    await sleep(500);
    const box = win.win.getContentBounds();
    const clicksBefore = (await pageState(front.view.webContents))?.clicks ?? 0;
    const sent = personInput(box.x + content.x + 160, box.y + content.y + 250);
    if (sent !== null) await until(async () => ((await pageState(front.view.webContents))?.clicks ?? 0) > clicksBefore);
    const frontInput = await pageState(front.view.webContents);
    const agentInput = await Promise.all(agentTabs.map((t) => pageState(win.getTab(t.id)!.view.webContents)));
    if (sent === null) log("background tabs: person input check skipped", "no X test input on this display");
    else
      check(
        "background tabs: the person's click and keys go to the tab on screen only",
        (frontInput?.clicks ?? 0) > clicksBefore && agentInput.every((s) => s !== null && s.clicks === 0 && s.keys === 0),
        { front: frontInput && { clicks: frontInput.clicks - clicksBefore, keys: frontInput.keys }, agents: agentInput.map((s) => s && s.clicks + s.keys) },
      );

    // "Open all" on a folder: the first few load at once, the rest when first shown, named after their bookmarks.
    const folder = win.profile.bookmarks.create({ parentId: OTHER_FOLDER_ID, kind: "folder", title: "Background smoke" });
    for (let i = 0; i < OPEN_ALL_LOAD_NOW + 2; i++) win.profile.bookmarks.create({ parentId: folder.id, kind: "bookmark", title: `Saved ${i}`, url: `${base}bg?title=Saved%20${i}&idelay=0` });
    ids = win.tabIds();
    const count = await openBookmarkFolder(ctx, win, folder.id);
    const all = win.tabIds().filter((id) => !ids.includes(id));
    all.forEach((id) => opened.push(id));
    const lazy = all.map((id) => win.getTab(id)?.pendingUrl !== undefined);
    check(
      `background tabs: Open all loads the first ${OPEN_ALL_LOAD_NOW} at once and the rest when shown`,
      count === OPEN_ALL_LOAD_NOW + 2 &&
        lazy.filter((l) => !l).length === OPEN_ALL_LOAD_NOW &&
        lazy.slice(OPEN_ALL_LOAD_NOW).every(Boolean) &&
        all.slice(OPEN_ALL_LOAD_NOW).every((id, i) => win.getTab(id)?.title === `Saved ${OPEN_ALL_LOAD_NOW + i}`) &&
        win.activeTab()?.id === front.id,
      { count, lazy },
    );
    // An agent asked to read a tab that waits unloaded loads it first (it would otherwise read an empty page).
    const waiting = all[all.length - 1];
    const read = waiting ? await c.getText(waiting, { maxChars: 200 }).catch((err: unknown) => ({ text: String(err) })) : null;
    check("background tabs: an agent reading a tab that waits unloaded loads it first", Boolean(read?.text.includes("Linked page")) && win.getTab(waiting ?? "")?.pendingUrl === undefined, read);
    if (waiting) win.clearAgentMark(waiting);
    win.profile.bookmarks.remove(folder.id);

    // Agent rendering off: agent tabs do not paint, but still load, and their screenshots still work.
    ctx.settings.update({ agent: { renderInBackground: false } });
    check("background tabs: turning agent rendering off stops every agent tab painting", ctx.backgroundRender.rendering().length === 0 && agentTabs.every((t) => !win.isPainting(win.getTab(t.id)!)));
    const offTab = await c.openTab(`${base}bg?title=Agent%20off&idelay=0`, { background: true, agent: true });
    keep(offTab);
    const offPainting = ctx.backgroundRender.rendering().includes(offTab.id);
    const offShot = showsPage(decode((await c.capture(offTab.id, { mode: "viewport", format: "png" })).base64));
    check(
      "background tabs: with agent rendering off, the agent tab does not paint, but its screenshot is painted on demand",
      !offPainting && offShot.page && offShot.image && !win.isPainting(win.getTab(offTab.id)!),
      { offPainting, offShot },
    );

    // A sleeping agent tab is loaded again for its screenshot.
    const sleeper = win.getTab(agentTabs[3]!.id)!;
    win.clearAgentMark(sleeper.id);
    const slept = win.sleepTab(sleeper.id);
    const woken = showsPage(decode((await c.capture(sleeper.id, { mode: "viewport", format: "png" })).base64));
    check("background tabs: a sleeping tab is loaded for its screenshot", slept && woken.page, { slept, woken });

    if (process.env.CORVUS_BGTABS_MEASURE === "1") await measure(ctx, win, base, log);
  } catch (err) {
    check("background tabs smoke", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  } finally {
    ctx.tabSleeper.freeShare = freeShare;
    ctx.settings.update({ agent: { renderInBackground: before.agent.renderInBackground } });
    for (const id of opened) if (win.hasTab(id)) win.closeTab(id);
    close();
    await sleep(300);
  }
}

function usage(): { mb: number; cpu: number } {
  const metrics = app.getAppMetrics();
  return {
    mb: Math.round(metrics.reduce((s, m) => s + (m.memory?.workingSetSize ?? 0), 0) / 1024),
    cpu: Math.round(metrics.reduce((s, m) => s + (m.cpu?.percentCPUUsage ?? 0), 0) * 10) / 10,
  };
}

async function settled(ms: number): Promise<{ mb: number; cpu: number }> {
  usage();
  await sleep(ms);
  return usage();
}

/** Frames a page drew in the last second (0 when it does not paint). */
function framesPerSecond(wc: WebContents): Promise<number> {
  return wc.executeJavaScript("(async () => { const a = window.__frames; await new Promise((r) => setTimeout(r, 1000)); return window.__frames - a; })()").catch(() => -1) as Promise<number>;
}

/**
 * CORVUS_BGTABS_MEASURE=1: memory and processor of 1, 4 and 8 agent tabs painting in the background
 * (an animated page) against the same tabs hidden and not painting, and asleep; and how long a
 * person's background tab (loaded, never painted) takes to show complete.
 */
async function measure(ctx: AppContext, win: BrowserWindowCtl, base: string, log: (step: string, data: unknown) => void): Promise<void> {
  const front = win.activeTab()!;
  const runs: Array<{ firstPaint: number; complete: number }> = [];
  for (let i = 0; i < 3; i++) {
    const tab = win.createTab(`${base}bg?title=Measure%20${i}`, { activate: false, byPerson: true });
    await loaded(tab.view.webContents);
    await sleep(2500);
    runs.push(await timeToComplete(win, tab));
    win.activate(front.id);
    win.closeTab(tab.id);
    await sleep(300);
  }
  log("measure: showing a background tab (ms)", runs);
  ctx.settings.update({ agent: { renderInBackground: true } });
  log("measure: baseline", await settled(3000));
  for (const n of [1, 4, 8]) {
    const tabs: TabRuntime[] = [];
    for (let i = 0; i < n; i++) {
      const t = await ctx.controller.openTab(`${base}bg?title=Load%20${i}&anim=1&idelay=0`, { background: true, agent: true });
      tabs.push(win.getTab(t.id)!);
    }
    await sleep(1500);
    const rendering = { ...(await settled(4000)), fps: await framesPerSecond(tabs[0]!.view.webContents), painting: tabs.filter((t) => win.isPainting(t)).length };
    for (const t of tabs) ctx.backgroundRender.forget(t.id);
    await sleep(1500);
    const hidden = { ...(await settled(4000)), fps: await framesPerSecond(tabs[0]!.view.webContents) };
    for (const t of tabs) {
      win.clearAgentMark(t.id);
      win.sleepTab(t.id);
    }
    await sleep(2000);
    const asleep = await settled(4000);
    log(`measure: ${n} agent tabs in the background (MB, % CPU)`, { rendering, hidden, asleep });
    for (const t of tabs) if (win.hasTab(t.id)) win.closeTab(t.id);
    await sleep(1500);
  }
}
