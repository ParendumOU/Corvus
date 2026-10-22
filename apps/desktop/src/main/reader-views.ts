import { WebContentsView, type BaseWindow, type Rectangle, type View, type WebContents } from "electron";
import { READER_EVENT, type ReaderEventMessage, type ReaderState } from "../shared/reader-ipc";
import { paths } from "./paths";

/** The reader view of one window: an opaque reading surface stacked over the active tab's content. */
export class ReaderView {
  private view: WebContentsView | null = null;
  private ready = false;
  private pending: ReaderState | null = null;
  open = false;
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
    const view = new WebContentsView({
      webPreferences: {
        preload: paths.assistPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event) => event.preventDefault());
    wc.on("did-finish-load", () => {
      this.ready = true;
      if (this.pending) this.send(this.pending);
    });
    wc.on("render-process-gone", () => {
      this.ready = false;
      if (!wc.isDestroyed()) void wc.loadURL("corvus://reader/");
    });
    wc.on("before-input-event", (event, input) => this.onInput(wc, event, input));
    void wc.loadURL("corvus://reader/");
    // Below the chrome UI (and its popovers), above the tab content it covers.
    const children = this.win.contentView.children;
    const index = children.indexOf(this.chrome);
    this.win.contentView.addChildView(view, index < 0 ? undefined : index);
    this.view = view;
    return view;
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
    const visible = this.open && bounds.width > 0 && bounds.height > 0;
    this.view.setVisible(visible);
    if (visible) this.view.setBounds(bounds);
  }

  send(state: ReaderState): void {
    this.pending = state;
    const wc = this.webContents;
    if (!wc || !this.ready) return;
    const message: ReaderEventMessage = { type: "state", state };
    wc.send(READER_EVENT, message);
  }

  dispose(): void {
    this.webContents?.close();
    this.view = null;
  }
}
