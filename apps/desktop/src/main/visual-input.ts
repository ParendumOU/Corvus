/**
 * Coordinate ("visual") actions for the in-browser agents: screenshots sized for the model, and
 * click/hover/scroll at a point, key presses and typing into the focused element with real input
 * events (webContents.sendInputEvent / insertText), for canvas apps, maps and custom widgets where
 * element refs fail.
 *
 * The in-browser agents reach these through runAgentTool, behind the runners' approval gate
 * (classifyPointAction reads what is under the point first). MCP clients reach them through the
 * controller's `input` / `capture` capabilities, behind the MCP server's spend gate (click_at and
 * Enter/Space read the point or the focused element through describePoint / describeFocused first).
 */
import type { Capture, CaptureOptions, MouseButton, TabId } from "@corvus/shared";
import { nativeImage, type WebContents } from "electron";
import type { PointTarget } from "../shared/agent-safety";
import { isAgentAllowedUrl } from "../shared/internal-urls";
import { cssToDip, fitShot, parseKey, type KeyPress, type Point, type ShotGeometry } from "../shared/visual-input";
import type { AppContext } from "./context";
import { AGENT_WORLD_ID, describeFocusedScript, describePointScript, rectScript, viewportInfoScript, viewportScript } from "./page-scripts";
import { pageOf } from "./tab-page";
import type { BrowserWindowCtl } from "./window";

const SCRIPT_TIMEOUT_MS = 8_000;
const SHOT_JPEG_QUALITY = 80;
/** Pause after an input so the page can react before the next tool reads it. */
const SETTLE_MS = 120;

export interface AgentShot {
  base64: string;
  mediaType: "image/jpeg";
  geometry: ShotGeometry;
}

export type PointInfo = PointTarget & { box?: { x: number; y: number; width: number; height: number } };

/** A tab out of sight is painted for its capture; this is the rare page that still gave no picture. */
export const NOT_PAINTED = "The tab could not be painted out of sight; bring it to the front and retry";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Page script timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function target(ctx: AppContext, id: TabId): { win: BrowserWindowCtl; wc: WebContents } {
  const found = ctx.windows.findTab(id);
  if (!found) throw new Error(`Unknown tab ${id}`);
  const wc = pageOf(found.tab.view);
  if (!wc) throw new Error(`Tab ${id} is closed`);
  if (!isAgentAllowedUrl(wc.getURL() || found.tab.url)) throw new Error("Agents cannot access this page");
  return { win: found.window, wc };
}

function exec<T>(wc: WebContents, code: string): Promise<T> {
  return withTimeout(wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code }]) as Promise<T>, SCRIPT_TIMEOUT_MS);
}

/** How long input waits at most for the page's next frame. */
const FRAME_WAIT_MS = 1000;

/**
 * Mouse input with real events, whether the tab is on screen or not: a tab out of sight (behind the
 * person's tab, or in a minimized window) paints at the window's size while `act` runs and the page
 * reacts, so it takes the events as from the mouse without being shown. Chromium hands mouse moves
 * to the page with its next frame, which an idle page out of sight draws seldom: one is asked for.
 */
async function withRealMouse(win: BrowserWindowCtl, id: TabId, wc: WebContents, settleMs: number, act: () => void | Promise<void>): Promise<void> {
  const release = await win.paintHidden(id);
  try {
    await act();
    await Promise.race([exec(wc, NEXT_FRAME_SCRIPT).catch(() => undefined), sleep(FRAME_WAIT_MS)]);
    await sleep(settleMs);
  } finally {
    release();
  }
}

const NEXT_FRAME_SCRIPT = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

/**
 * A screenshot of the visible page sized to the viewport's CSS pixels (scaled down only past the
 * caps), so a point the model reads off the image maps straight to page coordinates.
 */
export async function agentScreenshot(ctx: AppContext, id: TabId): Promise<AgentShot> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "screenshot" });
  const release = await win.paintHidden(id);
  let image: Electron.NativeImage;
  let view: { width: number; height: number };
  try {
    view = await exec<{ width: number; height: number }>(wc, viewportScript());
    image = await wc.capturePage(undefined, { stayHidden: true });
  } finally {
    release();
  }
  if (image.isEmpty()) throw new Error(NOT_PAINTED);
  const fit = fitShot(view.width, view.height);
  const size = image.getSize();
  const sized = size.width === fit.width && size.height === fit.height ? image : image.resize({ width: fit.width, height: fit.height, quality: "better" });
  // Map against the pixels actually encoded, in case the resize rounded differently.
  const out = sized.getSize();
  return { base64: sized.toJPEG(SHOT_JPEG_QUALITY).toString("base64"), mediaType: "image/jpeg", geometry: { ...fit, width: out.width || fit.width, height: out.height || fit.height } };
}

/** What is at a viewport point (CSS px): role, name, form, frame and CAPTCHA flags. Null when unreadable. */
export async function describePoint(ctx: AppContext, id: TabId, p: Point): Promise<PointInfo | null> {
  const { wc } = target(ctx, id);
  return exec<PointInfo | null>(wc, describePointScript(p.x, p.y)).catch(() => null);
}

/** The focused element (press_key / type_text target). Null when unreadable. */
export async function describeFocused(ctx: AppContext, id: TabId): Promise<PointTarget | null> {
  const { wc } = target(ctx, id);
  return exec<PointTarget | null>(wc, describeFocusedScript()).catch(() => null);
}

/** Left click at a viewport point with real mouse events. */
export async function clickAt(ctx: AppContext, id: TabId, p: Point, label: string): Promise<void> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "point", x: p.x, y: p.y, label, action: "click" });
  await withRealMouse(win, id, wc, SETTLE_MS, () => {
    const { x, y } = cssToDip(p, wc.getZoomFactor());
    wc.sendInputEvent({ type: "mouseMove", x, y });
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  });
}

/** Move the mouse to a viewport point (opens hover menus and tooltips). */
export async function hoverAt(ctx: AppContext, id: TabId, p: Point, label: string): Promise<void> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "point", x: p.x, y: p.y, label, action: "hover" });
  await withRealMouse(win, id, wc, SETTLE_MS, () => {
    const { x, y } = cssToDip(p, wc.getZoomFactor());
    wc.sendInputEvent({ type: "mouseMove", x, y });
  });
}

/**
 * Mouse-wheel scroll at a viewport point, so the element under it scrolls (map, list, canvas).
 * deltaY > 0 scrolls down. Returns the page's scroll position afterwards.
 */
export async function scrollAt(ctx: AppContext, id: TabId, p: Point, delta: { deltaX: number; deltaY: number }, label: string): Promise<{ scrollY: number; maxScrollY: number }> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "point", x: p.x, y: p.y, label, action: "scroll" });
  await withRealMouse(win, id, wc, SETTLE_MS * 2, () => {
    const { x, y } = cssToDip(p, wc.getZoomFactor());
    wc.sendInputEvent({ type: "mouseMove", x, y });
    // Chromium wheel deltas point the other way from DOM WheelEvent.deltaY.
    wc.sendInputEvent({ type: "mouseWheel", x, y, deltaX: -delta.deltaX, deltaY: -delta.deltaY, canScroll: true });
  });
  return exec<{ scrollY: number; maxScrollY: number }>(wc, viewportScript()).catch(() => ({ scrollY: 0, maxScrollY: 0 }));
}

/** One key press (with modifiers) into the focused element of the tab. */
export async function pressKey(ctx: AppContext, id: TabId, press: KeyPress): Promise<void> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "key", key: press.label });
  const modifiers = press.modifiers;
  wc.sendInputEvent({ type: "keyDown", keyCode: press.keyCode, modifiers });
  if (press.char !== null) wc.sendInputEvent({ type: "char", keyCode: press.char, modifiers });
  wc.sendInputEvent({ type: "keyUp", keyCode: press.keyCode, modifiers });
  await sleep(SETTLE_MS);
}

/** Types text into whatever has focus, as if from the keyboard (IME commit). */
export async function typeText(ctx: AppContext, id: TabId, text: string): Promise<void> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "key", key: text.length > 24 ? `${text.slice(0, 23)}…` : text });
  await wc.insertText(text);
  await sleep(SETTLE_MS);
}

type HeldModifier = "alt" | "control" | "meta" | "shift";
const ELECTRON_MODIFIERS: Record<string, HeldModifier> = { alt: "alt", control: "control", ctrl: "control", meta: "meta", shift: "shift" };

/** Held modifier names ("Control", "Shift") as Electron input event modifiers. */
function electronModifiers(modifiers: readonly string[] | undefined): HeldModifier[] {
  return [...new Set((modifiers ?? []).map((m) => ELECTRON_MODIFIERS[m.toLowerCase()]).filter((m): m is HeldModifier => Boolean(m)))];
}

/**
 * A click at a viewport point with any button, click count and held modifiers (click_at,
 * double_click_at, right_click_at over MCP).
 */
export async function mouseClickAt(
  ctx: AppContext,
  id: TabId,
  p: Point,
  opts: { button?: MouseButton; clickCount?: number; modifiers?: readonly string[] },
  label: string,
): Promise<void> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "point", x: p.x, y: p.y, label, action: "click" });
  const button = opts.button ?? "left";
  const count = Math.max(1, Math.min(3, Math.round(opts.clickCount ?? 1)));
  await withRealMouse(win, id, wc, SETTLE_MS, () => {
    const { x, y } = cssToDip(p, wc.getZoomFactor());
    const modifiers = electronModifiers(opts.modifiers);
    wc.sendInputEvent({ type: "mouseMove", x, y, modifiers });
    for (let n = 1; n <= count; n++) {
      wc.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: n, modifiers });
      wc.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: n, modifiers });
    }
  });
}

/** Drag with the left button held from one viewport point to another, in `steps` moves. */
export async function dragBetween(ctx: AppContext, id: TabId, from: Point, to: Point, steps: number, label: string): Promise<void> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "point", x: from.x, y: from.y, label, action: "click" });
  await withRealMouse(win, id, wc, SETTLE_MS, async () => {
    const zoom = wc.getZoomFactor();
    const a = cssToDip(from, zoom);
    const b = cssToDip(to, zoom);
    const n = Math.max(1, Math.min(50, Math.round(steps)));
    wc.sendInputEvent({ type: "mouseMove", x: a.x, y: a.y });
    wc.sendInputEvent({ type: "mouseDown", x: a.x, y: a.y, button: "left", clickCount: 1 });
    for (let i = 1; i <= n; i++) {
      const x = Math.round(a.x + ((b.x - a.x) * i) / n);
      const y = Math.round(a.y + ((b.y - a.y) * i) / n);
      wc.sendInputEvent({ type: "mouseMove", x, y, modifiers: ["leftbuttondown"] });
      await sleep(16);
    }
    wc.sendInputEvent({ type: "mouseUp", x: b.x, y: b.y, button: "left", clickCount: 1 });
  });
}

/** Keys or shortcuts pressed in order ("Control+A", "Enter", "Shift+Tab"); an unknown key fails before any is pressed. */
export async function pressKeys(ctx: AppContext, id: TabId, keys: readonly string[]): Promise<void> {
  const presses = keys.map((k) => {
    const press = parseKey(k);
    if (!press) throw new Error(`Unknown key "${k}". Use Enter, Tab, Escape, ArrowDown, Backspace, a single character, or a shortcut like Control+A.`);
    return press;
  });
  for (const press of presses) await pressKey(ctx, id, press);
}

/** Types text into what has focus; line breaks press Enter, and `delayMs` paces the characters. */
export async function typeTextPaced(ctx: AppContext, id: TabId, text: string, delayMs = 0): Promise<void> {
  const enter = parseKey("Enter")!;
  for (const part of text.split(/(\r\n|\r|\n)/)) {
    if (!part) continue;
    if (/^(\r\n|\r|\n)$/.test(part)) {
      await pressKey(ctx, id, enter);
    } else if (delayMs > 0) {
      for (const ch of part) {
        await typeText(ctx, id, ch);
        await sleep(delayMs);
      }
    } else {
      await typeText(ctx, id, part);
    }
  }
}

interface ViewportInfo {
  width: number;
  height: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  scrollWidth: number;
  scrollHeight: number;
}

/** Tallest full-page capture (CSS px), as Chromium caps one screenshot. */
const FULL_PAGE_MAX = 16_384;

/**
 * The screenshot tool's capture: the viewport, one element (scrolled into view, then cropped) or the
 * whole page (through the tab's DevTools protocol), at `scale` image px per CSS px, so points read
 * off the image divide by `scale` into viewport CSS px for the *_at tools.
 */
export async function captureTab(ctx: AppContext, id: TabId, opts: CaptureOptions = {}): Promise<Capture> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "screenshot" });
  // A tab out of sight is painted at the window's size for the capture, without showing it.
  const release = await win.paintHidden(id);
  try {
    return await capturePainted(wc, opts);
  } finally {
    release();
  }
}

async function capturePainted(wc: WebContents, opts: CaptureOptions): Promise<Capture> {
  const mode = opts.mode ?? "viewport";
  const scale = Math.max(0.1, Math.min(2, opts.scale ?? 1));
  const jpeg = opts.format === "jpeg";
  const quality = Math.max(1, Math.min(100, Math.round(opts.quality ?? 80)));
  const view = await exec<ViewportInfo>(wc, viewportInfoScript());
  const viewport = { width: view.width, height: view.height, devicePixelRatio: view.dpr, scrollX: view.scrollX, scrollY: view.scrollY, zoom: wc.getZoomFactor() };

  if (mode === "full") {
    const clip = { x: 0, y: 0, width: Math.round(view.scrollWidth), height: Math.round(Math.min(view.scrollHeight, FULL_PAGE_MAX)) };
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const shot = (await dbg.sendCommand("Page.captureScreenshot", {
      format: jpeg ? "jpeg" : "png",
      ...(jpeg ? { quality } : {}),
      captureBeyondViewport: true,
      clip: { ...clip, scale: scale / (view.dpr || 1) },
    })) as { data: string };
    const size = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64")).getSize();
    return { mimeType: jpeg ? "image/jpeg" : "image/png", base64: shot.data, width: size.width, height: size.height, scale, viewport, clip };
  }

  let clip = { x: 0, y: 0, width: view.width, height: view.height };
  if (mode === "element") {
    if (!opts.ref && !opts.selector) throw new Error("mode=element needs a ref or a selector");
    const target = opts.ref ? { ref: opts.ref } : { selector: opts.selector! };
    type Rect = { x: number; y: number; width: number; height: number } | { error: string } | null;
    const measure = async (scroll: boolean): Promise<{ x: number; y: number; width: number; height: number }> => {
      const r = await exec<Rect>(wc, rectScript(target, scroll));
      if (r && "error" in r) throw new Error(r.error);
      if (!r) throw new Error(opts.ref ? `Element ${opts.ref} not found; take a new page_snapshot` : `No element matches ${opts.selector}`);
      return r;
    };
    await measure(true);
    // Measured again once the scroll has painted: a drawer's scroll or a transition may still move it.
    await sleep(SETTLE_MS);
    const r = await measure(false);
    const x = Math.max(0, r.x);
    const y = Math.max(0, r.y);
    if (x >= view.width || y >= view.height || r.x + r.width <= 0 || r.y + r.height <= 0) throw new Error("The element is not on screen (hidden or clipped by its container)");
    clip = { x, y, width: Math.max(1, Math.min(view.width, r.x + r.width) - x), height: Math.max(1, Math.min(view.height, r.y + r.height) - y) };
  }
  const image = await wc.capturePage(undefined, { stayHidden: true });
  if (image.isEmpty()) throw new Error(NOT_PAINTED);
  const ratio = image.getSize().width / view.width;
  const region =
    mode === "element"
      ? image.crop({ x: Math.round(clip.x * ratio), y: Math.round(clip.y * ratio), width: Math.max(1, Math.round(clip.width * ratio)), height: Math.max(1, Math.round(clip.height * ratio)) })
      : image;
  const width = Math.max(1, Math.round(clip.width * scale));
  const height = Math.max(1, Math.round(clip.height * scale));
  const sized = region.getSize().width === width && region.getSize().height === height ? region : region.resize({ width, height, quality: "better" });
  const out = sized.getSize();
  return {
    mimeType: jpeg ? "image/jpeg" : "image/png",
    base64: (jpeg ? sized.toJPEG(quality) : sized.toPNG()).toString("base64"),
    width: out.width,
    height: out.height,
    scale,
    viewport,
    clip,
  };
}
