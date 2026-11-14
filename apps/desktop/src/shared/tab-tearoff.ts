/**
 * Tabs dragged out of their window's tab strip (as in every browser): dropped on another window's
 * strip they move there, dropped anywhere else they go to a new window of their own. Pure geometry,
 * so the rules are unit tested; WindowManager and BrowserWindowCtl move the tabs.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

/** How far around its tab strip a tab may be let go of and stay in its window (a drag given up). */
export const STRIP_MARGIN = 24;

/**
 * Whether a tab dragged out of a window and dropped on no tab strip goes to a new window: when it
 * was let go of away from its own strip (screen coordinates). Near the strip, the drag was given up.
 */
export function tearsOff(pointer: Point, strip: Rect, margin = STRIP_MARGIN): boolean {
  return pointer.x < strip.x - margin || pointer.x > strip.x + strip.width + margin || pointer.y < strip.y - margin || pointer.y > strip.y + strip.height + margin;
}

/** Where the pointer holds a torn-off window: on its first tab, as it held the tab. */
export const TEAR_OFF_GRAB: Point = { x: 120, y: 18 };

/** A torn-off window's bounds: the size of the window it left, its first tab under the pointer. */
export function tearOffBounds(pointer: Point, size: { width: number; height: number }, grab: Point = TEAR_OFF_GRAB): Rect {
  return { x: Math.round(pointer.x - grab.x), y: Math.round(pointer.y - grab.y), width: size.width, height: size.height };
}

/** A window's tab strip on screen: the band along its top, or its tab sidebar on the left. */
export function stripRect(content: Rect, layout: { vertical: boolean; sidebarWidth: number; stripHeight: number }): Rect {
  return layout.vertical
    ? { x: content.x, y: content.y, width: layout.sidebarWidth, height: content.height }
    : { x: content.x, y: content.y, width: content.width, height: layout.stripHeight };
}

/**
 * While tabs are dragged, a small preview of their new window follows the pointer wherever a drop
 * would open one: the preview is the drop target there, so the system shows a "move" pointer instead
 * of "not allowed", and dropping on it opens the window. Where the pointer holds the preview, and its size.
 */
export const PREVIEW_GRAB: Point = { x: 28, y: 22 };
export const PREVIEW_SIZE = { width: 260, height: 196 };

/** The preview's bounds on screen for a pointer: the pointer on its tab, near the top left corner. */
export function previewBounds(pointer: Point, grab: Point = PREVIEW_GRAB, size: { width: number; height: number } = PREVIEW_SIZE): Rect {
  return { x: Math.round(pointer.x - grab.x), y: Math.round(pointer.y - grab.y), width: size.width, height: size.height };
}

function inside(pointer: Point, rect: Rect): boolean {
  return pointer.x >= rect.x && pointer.x < rect.x + rect.width && pointer.y >= rect.y && pointer.y < rect.y + rect.height;
}

/**
 * Whether the preview of a new window shows under the pointer: away from the tabs' own strip (near it
 * the drag reorders them), and not on another window's strip `others` (a drop there moves them in).
 */
export function showsTearOffPreview(pointer: Point, own: Rect, others: readonly Rect[]): boolean {
  return tearsOff(pointer, own) && !others.some((strip) => inside(pointer, strip));
}

/** How a tab drag ended, as the main process sees it (see tearOffAtEnd). */
export interface TabDragEnd {
  /** The drop landed on a tab strip, or on the preview (the system's drop effect was not "none"). */
  accepted: boolean;
  /** The preview was under the pointer when the drag ended. */
  previewShown: boolean;
  /** The preview showed at some point of this drag (it cannot, where windows cannot be placed). */
  previewWorked: boolean;
  /** The pointer is away from the tabs' own strip. */
  awayFromStrip: boolean;
}

/**
 * What a tab drag's end does: "wait" for the preview's own drop (the system told the source first),
 * "tear" (a drop with no preview to land on, away from the strip, as before the preview), or nothing:
 * a drop on a strip moved the tabs already, and a drag given up (Esc) or let go near the strip keeps them.
 */
export function tearOffAtEnd(end: TabDragEnd): "wait" | "tear" | null {
  if (end.accepted) return end.previewShown ? "wait" : null;
  if (end.previewWorked) return null;
  return end.awayFromStrip ? "tear" : null;
}
