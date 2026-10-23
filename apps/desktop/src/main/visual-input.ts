/**
 * Coordinate ("visual") actions for the in-browser agents: screenshots sized for the model, and
 * click/hover/scroll at a point, key presses and typing into the focused element with real input
 * events (webContents.sendInputEvent / insertText), for canvas apps, maps and custom widgets where
 * element refs fail.
 *
 * Deliberately NOT the BrowserController `input`/`capture` capabilities: implementing those on the
 * desktop controller would also light up the MCP server's coordinate tools, which have no spend
 * gate. These functions are only reachable through runAgentTool, behind the runners' approval gate
 * (classifyPointAction reads what is under the point first).
 */
import type { TabId } from "@corvus/shared";
import type { WebContents } from "electron";
import type { PointTarget } from "../shared/agent-safety";
import { isAgentAllowedUrl } from "../shared/internal-urls";
import { cssToDip, fitShot, type KeyPress, type Point, type ShotGeometry } from "../shared/visual-input";
import type { AppContext } from "./context";
import { AGENT_WORLD_ID, describeFocusedScript, describePointScript, pointerFallbackScript, viewportScript } from "./page-scripts";
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
  const wc = found.tab.view.webContents;
  if (wc.isDestroyed()) throw new Error(`Tab ${id} is closed`);
  if (!isAgentAllowedUrl(wc.getURL() || found.tab.url)) throw new Error("Agents cannot access this page");
  return { win: found.window, wc };
}

function exec<T>(wc: WebContents, code: string): Promise<T> {
  return withTimeout(wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code }]) as Promise<T>, SCRIPT_TIMEOUT_MS);
}

function foreground(win: BrowserWindowCtl, id: TabId): boolean {
  return win.activeTab()?.id === id && win.win.isVisible() && !win.win.isMinimized();
}

/**
 * A screenshot of the visible page sized to the viewport's CSS pixels (scaled down only past the
 * caps), so a point the model reads off the image maps straight to page coordinates.
 */
export async function agentScreenshot(ctx: AppContext, id: TabId): Promise<AgentShot> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "screenshot" });
  const view = await exec<{ width: number; height: number }>(wc, viewportScript());
  const image = await wc.capturePage(undefined, { stayHidden: true });
  if (image.isEmpty()) throw new Error("The tab has not been painted yet; activate it and retry");
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

/** Left click at a viewport point with real mouse events (synthetic events in a background tab). */
export async function clickAt(ctx: AppContext, id: TabId, p: Point, label: string): Promise<void> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "point", x: p.x, y: p.y, label, action: "click" });
  if (foreground(win, id)) {
    const { x, y } = cssToDip(p, wc.getZoomFactor());
    wc.sendInputEvent({ type: "mouseMove", x, y });
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  } else if (!(await exec<boolean>(wc, pointerFallbackScript("click", p.x, p.y)))) {
    throw new Error("Nothing to click at that point");
  }
  await sleep(SETTLE_MS);
}

/** Move the mouse to a viewport point (opens hover menus and tooltips). */
export async function hoverAt(ctx: AppContext, id: TabId, p: Point, label: string): Promise<void> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "point", x: p.x, y: p.y, label, action: "hover" });
  if (foreground(win, id)) {
    const { x, y } = cssToDip(p, wc.getZoomFactor());
    wc.sendInputEvent({ type: "mouseMove", x, y });
  } else {
    await exec<boolean>(wc, pointerFallbackScript("hover", p.x, p.y));
  }
  await sleep(SETTLE_MS);
}

/**
 * Mouse-wheel scroll at a viewport point, so the element under it scrolls (map, list, canvas).
 * deltaY > 0 scrolls down. Returns the page's scroll position afterwards.
 */
export async function scrollAt(ctx: AppContext, id: TabId, p: Point, delta: { deltaX: number; deltaY: number }, label: string): Promise<{ scrollY: number; maxScrollY: number }> {
  const { win, wc } = target(ctx, id);
  win.markAgent(id);
  await ctx.agents.beforeAction(win, id, wc, { kind: "point", x: p.x, y: p.y, label, action: "scroll" });
  if (foreground(win, id)) {
    const { x, y } = cssToDip(p, wc.getZoomFactor());
    wc.sendInputEvent({ type: "mouseMove", x, y });
    // Chromium wheel deltas point the other way from DOM WheelEvent.deltaY.
    wc.sendInputEvent({ type: "mouseWheel", x, y, deltaX: -delta.deltaX, deltaY: -delta.deltaY, canScroll: true });
  } else {
    await exec<boolean>(wc, pointerFallbackScript("scroll", p.x, p.y, delta.deltaX, delta.deltaY));
  }
  await sleep(SETTLE_MS * 2);
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
