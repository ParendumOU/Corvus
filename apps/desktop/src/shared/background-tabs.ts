/**
 * Tabs that are not on screen. A tab the person opens in the background (a middle click, Ctrl+click,
 * "Open link in new tab") waits unloaded until they first go to it, so opening ten videos does not
 * start ten players; with Settings > Memory's "Load tabs opened in the background right away" it
 * loads at once and paints until its page has loaded, so it is complete the moment it is shown. A
 * tab an AI agent works in always loads, and keeps painting while hidden, so screenshots and
 * coordinate tools work without bringing it to the front; only the agent tabs used most recently
 * do, so memory and processor use stay bounded. Pure rules here; main/background-render.ts and
 * BrowserWindowCtl do the work.
 */
import { isAttachmentDisposition } from "./pdf-ipc";

/** Why a hidden tab paints: an agent works in it, it was opened in the background, or a capture waits for it. */
export type PaintReason = "agent" | "preload" | "capture";

/** Agent tabs that keep painting while hidden at most. */
export const AGENT_RENDER_CAP = 8;
/** The same when the computer is low on memory. */
export const AGENT_RENDER_CAP_LOW_MEMORY = 2;
/** Free memory below this share of the total counts as low (as for sleeping tabs). */
export const RENDER_LOW_MEMORY_SHARE = 0.1;

/** How many agent tabs may paint while hidden, given the share of the system memory that is free. */
export function agentRenderCap(freeShare: number): number {
  return freeShare < RENDER_LOW_MEMORY_SHARE ? AGENT_RENDER_CAP_LOW_MEMORY : AGENT_RENDER_CAP;
}

export interface RenderEntry {
  id: string;
  /** When an agent last used the tab (epoch ms). */
  usedAt: number;
}

/** The agent tabs that stop painting so at most `cap` do: the least recently used ones. */
export function tabsToStopRendering(entries: readonly RenderEntry[], cap: number): string[] {
  if (entries.length <= cap) return [];
  return [...entries]
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(Math.max(0, cap))
    .map((e) => e.id);
}

export interface NewTabPaint {
  /** The tab opens in front (it paints like any shown tab). */
  activate: boolean;
  /** It loads only when first shown (session restore, the later tabs of "Open all"). */
  lazy: boolean;
  /** An AI agent opened it. */
  agent: boolean;
  /** The person opened it in the background to look at it soon (a middle click, "Open link in new tab"). */
  preload: boolean;
}

export interface BackgroundTabSettings {
  /** Settings > Memory: "Load tabs opened in the background right away". */
  loadBackgroundTabs: boolean;
  /** Settings > AI agents: "Let AI agents render pages in the background". */
  agentsRenderInBackground: boolean;
}

/**
 * Whether a new tab waits, unloaded, until it is first shown: restored tabs and the later tabs of
 * "Open all", and the tabs the person opens in the background unless the setting loads them right
 * away. A tab in front loads, and so does an agent's, wherever it opens: agents work in tabs the
 * person never looks at.
 */
export function waitsUntilShown(tab: NewTabPaint, settings: BackgroundTabSettings): boolean {
  if (tab.activate) return false;
  if (tab.lazy) return true;
  return tab.preload && !tab.agent && !settings.loadBackgroundTabs;
}

/**
 * Whether a new tab paints while it is not on screen, and why: an agent's tab keeps painting, a tab
 * the person opened in the background (loaded right away) paints until it has loaded; other tabs
 * (shown, restored, received from another device) paint only when shown.
 */
export function newTabPaint(tab: NewTabPaint, settings: BackgroundTabSettings): PaintReason | null {
  if (tab.activate || tab.lazy) return null;
  if (tab.agent) return settings.agentsRenderInBackground ? "agent" : null;
  return tab.preload && settings.loadBackgroundTabs ? "preload" : null;
}

/** Types Chromium shows in a tab (a page, text, media, a PDF in the viewer); anything else downloads. */
const SHOWN_TYPES = [/^text\//, /^image\//, /^audio\//, /^video\//, /^multipart\/x-mixed-replace$/, /^application\/(pdf|json|xml|xhtml\+xml|javascript|ecmascript|wasm)$/, /\+(xml|json)$/];

/**
 * Whether a response is a file to download rather than something to show: sent as an attachment,
 * or of a type a tab does not show. A link the person opens in the background that leads to one
 * loads at once, so it downloads and its tab closes as before, instead of waiting to be shown as an
 * empty tab. No type known: it waits.
 */
export function isDownloadResponse(contentType: string | null, disposition: string | null): boolean {
  if (disposition && isAttachmentDisposition(disposition)) return true;
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return type !== "" && !SHOWN_TYPES.some((shown) => shown.test(type));
}

/** With background tabs loading right away, "Open all" loads this many of a folder's tabs at once; the rest load when first shown. */
export const OPEN_ALL_LOAD_NOW = 5;

/** For each tab "Open all" opens, in order: true when it loads at once, false when it waits until shown. */
export function openAllPlan(count: number, loadBackgroundTabs: boolean): boolean[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => loadBackgroundTabs && i < OPEN_ALL_LOAD_NOW);
}

/**
 * Runs in a page that has just started painting while hidden: resolves after two frames, and once
 * the images in view have loaded (a page that was never shown has not even asked for its lazy
 * images yet), or after `waitMs`, then one more frame.
 */
export function paintedScript(waitMs: number): string {
  return `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  await frame();
  await frame();
  const end = Date.now() + ${Math.max(0, Math.round(waitMs))};
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  while (Date.now() < end && [...document.images].some((img) => !img.complete && inView(img))) await new Promise((r) => setTimeout(r, 50));
  await frame();
  return true;
})()`;
}
