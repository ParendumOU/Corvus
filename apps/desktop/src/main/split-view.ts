import { ipcMain, View, WebContentsView, type WebContents } from "electron";
import type { TabId } from "@corvus/shared";
import {
  MAX_PANES,
  SPLIT_DIVIDER_CHANNEL,
  clampRatio,
  computeGridGeometry,
  insetPage,
  type Rect,
  type SplitAxis,
  type SplitDividerMessage,
} from "../shared/split";

/** Empty document; the split preload builds the divider's visuals and drag handling (axis in the hash). */
const dividerUrl = (axis: SplitAxis): string =>
  `data:text/html,${encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')}#${axis}`;

/** Maps each divider helper view's webContents to its session and axis so the shared IPC handler can route drags. */
const dividers = new Map<WebContents, { session: SplitSession; axis: SplitAxis }>();

let registered = false;

/** Register the divider drag channel once. Safe to call multiple times. */
export function registerSplitIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.on(SPLIT_DIVIDER_CHANNEL, (event, raw) => {
    const target = dividers.get(event.sender);
    if (!target) return;
    const message = raw as SplitDividerMessage;
    if (message?.phase === "start") target.session.beginResize(target.axis);
    else if (message?.phase === "move" && typeof message.fraction === "number") target.session.applyResize(target.axis, message.fraction);
    else if (message?.phase === "end") target.session.endResize();
  });
}

export interface SplitSessionOptions {
  dark: boolean;
  accent: string;
  preload: string;
  /** Re-run the owning window's layout (the session positions the views inside it). */
  onRelayout(): void;
}

/**
 * Owns the auxiliary views of a split: the accent focus ring (a cheap renderer-less View behind
 * the focused pane) and one draggable divider per axis (thin helper WebContentsViews). The page
 * views themselves stay owned by the window; this session only positions them via `layout`.
 */
export class SplitSession {
  ratio = 0.5;
  ratioY = 0.5;
  private readonly frame: View;
  private readonly dividerViews: Record<SplitAxis, WebContentsView>;
  private resizing: SplitAxis | null = null;

  constructor(
    private readonly contentView: View,
    private paneIds: TabId[],
    private readonly opts: SplitSessionOptions,
  ) {
    this.frame = new View();
    this.frame.setBackgroundColor(opts.accent);
    this.frame.setBorderRadius(4);
    this.frame.setVisible(false);
    // Below the pages (index 0): the ring shows around the focused page, the dividers sit in the gaps.
    this.contentView.addChildView(this.frame, 0);
    const divider = (axis: SplitAxis): WebContentsView => {
      const view = new WebContentsView({
        webPreferences: { preload: opts.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      view.setBackgroundColor("#00000000");
      view.setVisible(false);
      this.contentView.addChildView(view, 0);
      dividers.set(view.webContents, { session: this, axis });
      void view.webContents.loadURL(dividerUrl(axis));
      return view;
    };
    this.dividerViews = { x: divider("x"), y: divider("y") };
  }

  /** The tiled tabs, in pane order. */
  get panes(): readonly TabId[] {
    return this.paneIds;
  }

  has(id: TabId): boolean {
    return this.paneIds.includes(id);
  }

  /** Adds a pane (at most four); false when it is already there or the split is full. */
  add(id: TabId): boolean {
    if (this.has(id) || this.paneIds.length >= MAX_PANES) return false;
    this.paneIds = [...this.paneIds, id];
    return true;
  }

  /** Removes a pane; the panes left keep their order. */
  remove(id: TabId): void {
    this.paneIds = this.paneIds.filter((p) => p !== id);
  }

  setTheme(accent: string): void {
    this.frame.setBackgroundColor(accent);
  }

  /** Position the pages, the focus ring and the dividers inside `content`. */
  layout(content: Rect, focusedId: TabId | null, views: ReadonlyArray<WebContentsView | undefined>): void {
    const geom = computeGridGeometry(content, this.paneIds.length, this.ratio, this.ratioY);
    geom.cells.forEach((cell, i) => {
      const view = views[i];
      if (view && !view.webContents.isDestroyed()) view.setBounds(insetPage(cell));
    });
    const focusCell = geom.cells[Math.max(0, this.paneIds.indexOf(focusedId ?? ""))] ?? geom.cells[0];
    if (focusCell) this.frame.setBounds(focusCell);
    this.frame.setVisible(true);
    for (const axis of ["x", "y"] as const) {
      const view = this.dividerViews[axis];
      const divider = geom.dividers.find((d) => d.axis === axis);
      // During a drag the divider is expanded over the whole content area so it keeps receiving the
      // pointer events even as the cursor passes over the page views (per-view mouse passthrough does
      // not exist in Electron). Otherwise it is the thin strip in its gap.
      if (divider) view.setBounds(this.resizing === axis ? content : divider.rect);
      view.setVisible(divider !== undefined);
    }
  }

  /** Another tab is shown: the split waits, out of sight, for one of its panes to come back. */
  hide(): void {
    this.frame.setVisible(false);
    this.dividerViews.x.setVisible(false);
    this.dividerViews.y.setVisible(false);
  }

  beginResize(axis: SplitAxis): void {
    this.resizing = axis;
    this.contentView.addChildView(this.dividerViews[axis]); // raise above the pages to capture the drag
    this.opts.onRelayout();
  }

  applyResize(axis: SplitAxis, fraction: number): void {
    if (axis === "x") this.ratio = clampRatio(fraction);
    else this.ratioY = clampRatio(fraction);
    this.opts.onRelayout();
  }

  endResize(): void {
    const axis = this.resizing;
    this.resizing = null;
    if (axis) this.contentView.addChildView(this.dividerViews[axis], 0); // tuck back below the pages / chrome
    this.opts.onRelayout();
  }

  dispose(): void {
    this.contentView.removeChildView(this.frame);
    for (const view of Object.values(this.dividerViews)) {
      dividers.delete(view.webContents);
      this.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  }
}
