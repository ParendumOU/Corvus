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
