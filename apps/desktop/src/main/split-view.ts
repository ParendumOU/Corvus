import { ipcMain, View, WebContentsView, type WebContents } from "electron";
import type { TabId } from "@corvus/shared";
import {
  SPLIT_DIVIDER_CHANNEL,
  clampRatio,
  computeSplitGeometry,
  insetPage,
  type Rect,
  type SplitDividerMessage,
} from "../shared/split";

/** Empty document; the split preload builds the divider's visuals and drag handling. */
const DIVIDER_URL = `data:text/html,${encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')}`;

/** Maps each divider helper view's webContents to its session so the shared IPC handler can route drags. */
const sessions = new Map<WebContents, SplitSession>();

let registered = false;

/** Register the divider drag channel once. Safe to call multiple times. */
export function registerSplitIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.on(SPLIT_DIVIDER_CHANNEL, (event, raw) => {
    const session = sessions.get(event.sender);
    if (!session) return;
    const message = raw as SplitDividerMessage;
    if (message?.phase === "start") session.beginResize();
    else if (message?.phase === "move" && typeof message.fraction === "number") session.applyResize(message.fraction);
    else if (message?.phase === "end") session.endResize();
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
 * Owns the two auxiliary views of a split: the accent focus ring (a cheap renderer-less View behind
 * the focused pane) and the draggable divider (a thin helper WebContentsView). The two page views
 * themselves stay owned by the window; this session only positions them via `layout`.
 */
export class SplitSession {
  ratio = 0.5;
  private readonly frame: View;
  private readonly divider: WebContentsView;
  private resizing = false;

  constructor(
    private readonly contentView: View,
    readonly left: TabId,
    readonly right: TabId,
    private readonly opts: SplitSessionOptions,
  ) {
    this.frame = new View();
    this.frame.setBackgroundColor(opts.accent);
    this.frame.setBorderRadius(4);
    this.frame.setVisible(false);

    this.divider = new WebContentsView({
      webPreferences: { preload: opts.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.divider.setBackgroundColor("#00000000");
    this.divider.setVisible(false);

    // Below the pages (index 0): the ring shows around the focused page, the divider sits in the gap.
    this.contentView.addChildView(this.frame, 0);
    this.contentView.addChildView(this.divider, 0);
    sessions.set(this.divider.webContents, this);
    void this.divider.webContents.loadURL(DIVIDER_URL);
  }

  setTheme(accent: string): void {
    this.frame.setBackgroundColor(accent);
  }

  /** Position both pages, the focus ring and the divider inside `content`. */
  layout(content: Rect, focusedId: TabId | null, leftView?: WebContentsView, rightView?: WebContentsView): void {
    const geom = computeSplitGeometry(content, this.ratio);
    if (leftView && !leftView.webContents.isDestroyed()) leftView.setBounds(insetPage(geom.leftCell));
    if (rightView && !rightView.webContents.isDestroyed()) rightView.setBounds(insetPage(geom.rightCell));
    const focusCell = focusedId === this.right ? geom.rightCell : geom.leftCell;
    this.frame.setBounds(focusCell);
    this.frame.setVisible(true);
    // During a drag the divider is expanded over the whole content area so it keeps receiving the
    // pointer events even as the cursor passes over the page views (per-view mouse passthrough does
    // not exist in Electron). Otherwise it is the thin strip in the gap.
    this.divider.setBounds(this.resizing ? content : geom.divider);
    this.divider.setVisible(true);
  }

  beginResize(): void {
    this.resizing = true;
    this.contentView.addChildView(this.divider); // raise above the pages to capture the drag
    this.opts.onRelayout();
  }

  applyResize(fraction: number): void {
    this.ratio = clampRatio(fraction);
    this.opts.onRelayout();
  }

  endResize(): void {
    this.resizing = false;
    this.contentView.addChildView(this.divider, 0); // tuck back below the pages / chrome
    this.opts.onRelayout();
  }

  dispose(): void {
    sessions.delete(this.divider.webContents);
    this.contentView.removeChildView(this.divider);
    this.contentView.removeChildView(this.frame);
    if (!this.divider.webContents.isDestroyed()) this.divider.webContents.close();
  }
}
