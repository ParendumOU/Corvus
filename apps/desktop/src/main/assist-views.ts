import { WebContentsView, type BaseWindow, type Rectangle, type View, type WebContents } from "electron";
import {
  ASSIST_DEFAULT_WIDTH,
  ASSIST_EVENT,
  ASSIST_MAX_WIDTH,
  ASSIST_MIN_WIDTH,
  OVERLAY_EVENT,
  type AssistEventMessage,
  type AssistPanelState,
  type AssistView,
  type OverlayEvent,
} from "../shared/assist-ipc";
import { paths } from "./paths";

/** Narrowest the page may get while the panel is open. */
const MIN_PAGE_WIDTH = 360;

function trustedView(url: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: paths.assistPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  const wc = view.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event) => event.preventDefault());
  void wc.loadURL(url);
  return view;
}

/** Inserts `view` directly below `above` so the chrome UI (and its popovers) stays on top. */
function insertBelow(win: BaseWindow, view: View, above: View): void {
  const children = win.contentView.children;
  const index = children.indexOf(above);
  win.contentView.addChildView(view, index < 0 ? undefined : index);
}

/** The Corvus Assist side panel of one window. Created on first open. */
export class AssistPanelView {
  private view: WebContentsView | null = null;
  private ready = false;
  private pending: AssistPanelState | null = null;
  open = false;
  width = ASSIST_DEFAULT_WIDTH;
  current: AssistView = "assist";
  focusToken = 0;

  constructor(
    private readonly win: BaseWindow,
    private readonly chrome: View,
    private readonly onInput: (wc: WebContents, event: Electron.Event, input: Electron.Input) => void,
  ) {}

  get webContents(): WebContents | null {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = trustedView("corvus://assist/");
    view.setBackgroundColor("#00000000");
    const wc = view.webContents;
    wc.on("did-finish-load", () => {
      this.ready = true;
      if (this.pending) this.send(this.pending);
    });
    wc.on("render-process-gone", () => {
      this.ready = false;
      if (!wc.isDestroyed()) void wc.loadURL("corvus://assist/");
    });
    wc.on("before-input-event", (event, input) => this.onInput(wc, event, input));
    insertBelow(this.win, view, this.chrome);
    this.view = view;
    return view;
  }

  /** Width reserved on the right of the page area; 0 when closed. */
  reserved(total: number): number {
    if (!this.open) return 0;
    const max = Math.min(ASSIST_MAX_WIDTH, total - MIN_PAGE_WIDTH);
    if (max < ASSIST_MIN_WIDTH) return 0;
    return Math.round(Math.max(ASSIST_MIN_WIDTH, Math.min(max, this.width)));
  }

  setOpen(open: boolean): void {
    this.open = open;
    if (open) this.ensure();
  }

  focus(): void {
    this.focusToken += 1;
    this.webContents?.focus();
  }

  layout(bounds: Rectangle): void {
    if (!this.view) return;
    const visible = this.open && bounds.width > 0;
    this.view.setVisible(visible);
    if (visible) this.view.setBounds(bounds);
  }

  send(state: AssistPanelState): void {
    this.pending = state;
    const wc = this.webContents;
    if (!wc || !this.ready) return;
    const message: AssistEventMessage = { type: "state", state };
    wc.send(ASSIST_EVENT, message);
  }

  dispose(): void {
    const wc = this.webContents;
    if (wc) wc.close();
    this.view = null;
  }
}

/**
 * Transparent view stacked over the active tab while an MCP agent acts: animated cursor,
 * highlight ring and caption. It is not part of the page, so page scripts, extensions and the
 * agent's own snapshots and screenshots never see it. It hides itself shortly after the last
 * action, and any click on it hides it at once.
 */
export class AgentOverlayView {
  private view: WebContentsView | null = null;
  private ready = false;
  private queued: OverlayEvent | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  visible = false;

  constructor(
    private readonly win: BaseWindow,
    private readonly below: () => View,
  ) {}

  get webContents(): WebContents | null {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = trustedView("corvus://agent-overlay/");
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    view.webContents.on("did-finish-load", () => {
      this.ready = true;
      if (this.queued) this.post(this.queued);
      this.queued = null;
    });
    insertBelow(this.win, view, this.below());
    this.view = view;
    return view;
  }

  private post(event: OverlayEvent): void {
    const wc = this.webContents;
    if (!wc) return;
    if (!this.ready) {
      this.queued = event;
      return;
    }
    wc.send(OVERLAY_EVENT, event);
  }

  layout(bounds: Rectangle): void {
    this.bounds = bounds;
    if (this.view && this.visible) this.view.setBounds(bounds);
  }

  show(event: OverlayEvent, holdMs: number): void {
    const view = this.ensure();
    view.setBounds(this.bounds);
    view.setVisible(true);
    this.visible = true;
    this.post(event);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), holdMs);
  }

  hide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (!this.view || !this.visible) return;
    this.visible = false;
    this.post({ type: "hide" });
    const view = this.view;
    // Let the fade-out play; a new action within that time keeps the view up.
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (!this.visible) view.setVisible(false);
    }, 200);
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.webContents?.close();
    this.view = null;
  }
}
