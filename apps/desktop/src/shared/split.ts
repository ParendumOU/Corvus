/**
 * Split view (two to four tabs tiled live) — pure geometry and the contracts shared between the
 * main process, the divider preload and the chrome UI. No Electron imports, so it unit-tests freely.
 */
import type { TabId } from "@corvus/shared";

/** IPC channel the divider helper view uses to report drag gestures to the main process. */
export const SPLIT_DIVIDER_CHANNEL = "corvus:split-divider";

/** Width of the draggable gap between the two panes. */
export const DIVIDER_WIDTH = 6;

/** Thickness of the accent ring drawn around the focused pane (also the inset of every pane). */
export const FOCUS_BORDER = 3;

/** Smallest/largest fraction of the content width the left pane may take. */
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SplitGeometry {
  /** Full cell for each pane (the accent ring fills the focused cell behind its inset page). */
  leftCell: Rect;
  rightCell: Rect;
  /** The draggable gap between the cells. */
  divider: Rect;
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
}

/** Tile `content` into a left cell, a right cell and the divider gap between them. */
export function computeSplitGeometry(content: Rect, ratio: number): SplitGeometry {
  const avail = Math.max(0, content.width - DIVIDER_WIDTH);
  const leftW = Math.round(avail * clampRatio(ratio));
  const rightW = Math.max(0, avail - leftW);
  return {
    leftCell: { x: content.x, y: content.y, width: leftW, height: content.height },
    divider: { x: content.x + leftW, y: content.y, width: DIVIDER_WIDTH, height: content.height },
    rightCell: { x: content.x + leftW + DIVIDER_WIDTH, y: content.y, width: rightW, height: content.height },
  };
}

/** A pane's page view is inset inside its cell so the accent ring can show around the focused one. */
export function insetPage(cell: Rect, border = FOCUS_BORDER): Rect {
  return {
    x: cell.x + border,
    y: cell.y + border,
    width: Math.max(0, cell.width - border * 2),
    height: Math.max(0, cell.height - border * 2),
  };
}

/** Most tabs one split tiles: two side by side, one beside two stacked, or a 2×2 grid. */
export const MAX_PANES = 4;

/** "x": the vertical divider between columns; "y": the horizontal one between rows. */
export type SplitAxis = "x" | "y";

export interface GridGeometry {
  /** One cell per pane, in pane order: left, right (2); left, top right, bottom right (3); row by row (4). */
  cells: Rect[];
  dividers: Array<{ axis: SplitAxis; rect: Rect }>;
}

/** Splits `cell` into a top and a bottom cell with a horizontal divider gap between them. */
function splitRows(cell: Rect, ratioY: number): { top: Rect; divider: Rect; bottom: Rect } {
  const avail = Math.max(0, cell.height - DIVIDER_WIDTH);
  const topH = Math.round(avail * clampRatio(ratioY));
  return {
    top: { x: cell.x, y: cell.y, width: cell.width, height: topH },
    divider: { x: cell.x, y: cell.y + topH, width: cell.width, height: DIVIDER_WIDTH },
    bottom: { x: cell.x, y: cell.y + topH + DIVIDER_WIDTH, width: cell.width, height: Math.max(0, avail - topH) },
  };
}

/**
 * Tiles `content` for 2 to 4 panes. `ratioX` is the left column's share of the width; `ratioY`
 * the top row's share of the height (the right column with 3 panes, both columns with 4).
 */
export function computeGridGeometry(content: Rect, panes: number, ratioX: number, ratioY: number): GridGeometry {
  const n = Math.max(2, Math.min(MAX_PANES, Math.floor(panes)));
  const cols = computeSplitGeometry(content, ratioX);
  const vertical = { axis: "x" as const, rect: cols.divider };
  if (n === 2) return { cells: [cols.leftCell, cols.rightCell], dividers: [vertical] };
  const right = splitRows(cols.rightCell, ratioY);
  if (n === 3) return { cells: [cols.leftCell, right.top, right.bottom], dividers: [vertical, { axis: "y", rect: right.divider }] };
  const left = splitRows(cols.leftCell, ratioY);
  // One horizontal divider across the whole width: both rows move together.
  const horizontal = { axis: "y" as const, rect: { x: content.x, y: left.divider.y, width: content.width, height: DIVIDER_WIDTH } };
  return { cells: [left.top, right.top, left.bottom, right.bottom], dividers: [vertical, horizontal] };
}

export type SplitDividerMessage = { phase: "start" } | { phase: "move"; fraction: number } | { phase: "end" };

/** Snapshot of the window's split, exposed to the chrome UI through WindowState. */
export interface SplitState {
  /** Tabs tiled in the split, in pane order (2 to 4). */
  paneIds: TabId[];
  /** The pane taking keyboard/omnibox input; null while another tab is shown and the split waits. */
  focusedTabId: TabId | null;
  ratio: number;
  ratioY: number;
  /**
   * On screen now. Showing a tab outside the split keeps the split for later: showing any of its
   * panes again brings the whole split back.
   */
  shown: boolean;
}
