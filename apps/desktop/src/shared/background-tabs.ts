/**
 * Tabs that are not on screen. A tab the person opens in the background (a middle click, Ctrl+click,
 * "Open link in new tab", a bookmark) loads at once, so its title and icon show, but its media waits
 * until they first go to it (see shared/media-hold.ts), so opening ten videos does not start ten
 * players. A tab an AI agent works in loads and plays as any page, and keeps painting while hidden,
 * so screenshots and coordinate tools work without bringing it to the front; only the agent tabs
 * used most recently do, so memory and processor use stay bounded. Pure rules here;
 * main/background-render.ts and BrowserWindowCtl do the work.
 */

/** Why a hidden tab paints: an agent works in it, or a capture waits for it. */
export type PaintReason = "agent" | "capture";

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

export interface NewTab {
  /** The tab opens in front. */
  activate: boolean;
  /** It loads only when first shown (session restore, the later tabs of "Open all"). */
  lazy: boolean;
  /** An AI agent opened it. */
  agent: boolean;
  /** The person opened it (a link, a bookmark), in front or in the background. */
  byPerson: boolean;
}

/**
 * Whether a new tab's media waits until the tab is first shown: a tab the person opens in the
 * background loads at once but plays nothing until they go to it, as in Chrome. An agent's tab
 * plays as any page (agents work in tabs the person never looks at), and a tab that loads only when
 * shown has nothing to hold.
 */
export function holdsMedia(tab: NewTab): boolean {
  return tab.byPerson && !tab.activate && !tab.lazy && !tab.agent;
}

/**
 * Whether a new tab paints while it is not on screen: an agent's tab opened in the background does,
 * with Settings > AI agents' "Let AI agents render pages in the background"; other tabs paint only
 * when shown, so the person's background tabs stay throttled and cheap.
 */
export function newTabPaint(tab: NewTab, agentsRenderInBackground: boolean): PaintReason | null {
  return tab.agent && !tab.activate && !tab.lazy && agentsRenderInBackground ? "agent" : null;
}

/** "Open all" loads this many of a folder's tabs at once; the rest load when first shown. */
export const OPEN_ALL_LOAD_NOW = 5;

/** For each tab "Open all" opens, in order: true when it loads at once, false when it waits until shown. */
export function openAllPlan(count: number): boolean[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => i < OPEN_ALL_LOAD_NOW);
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
