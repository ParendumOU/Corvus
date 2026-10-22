/**
 * Split view (two tabs tiled side by side) — pure geometry and the contracts shared between the
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

export type SplitDividerMessage = { phase: "start" } | { phase: "move"; fraction: number } | { phase: "end" };

/** Snapshot of the active split, exposed to the chrome UI through WindowState. */
export interface SplitState {
  leftTabId: TabId;
  rightTabId: TabId;
  /** Which pane currently takes keyboard/omnibox input. Always one of the two above. */
  focusedTabId: TabId;
  ratio: number;
}
