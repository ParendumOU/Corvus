import { BrowserWindow, ipcMain, nativeTheme, type IpcMainEvent } from "electron";
import type { TabId } from "@corvus/shared";
import { DRAG_PREVIEW_DROP, DRAG_PREVIEW_EVENT, type DragPreviewState } from "../shared/drag-preview";
import { PREVIEW_SIZE, previewBounds, showsTearOffPreview, tearOffAtEnd, tearsOff, type Point } from "../shared/tab-tearoff";
import { uiLanguage } from "./menu-i18n";
import { paths } from "./paths";
import type { BrowserWindowCtl } from "./window";

/** How often the preview follows the pointer during a drag. */
const FOLLOW_MS = 16;
/** How long the preview's own drop may come after the source heard the drag end (two processes). */
const LATE_DROP_MS = 1500;

interface Drag {
  from: BrowserWindowCtl;
  ids: TabId[];
  /** The preview is under the pointer now. */
  shown: boolean;
  /** The preview went where it was put at least once in this drag (it cannot where windows cannot be placed). */
  worked: boolean;
  follow: NodeJS.Timeout;
  /** Set once the source's drag ended: waiting for the preview's drop (see tearOffAtEnd). */
  late: NodeJS.Timeout | null;
}

export interface TabDragHost {
  /** Where the pointer is on screen. */
  pointer(): Point;
  /** Windows whose strip takes tabs dropped from `from` (shown, of its profile and kind). */
  partners(from: BrowserWindowCtl): BrowserWindowCtl[];
  tearOff(from: BrowserWindowCtl, ids: readonly TabId[], pointer: Point): BrowserWindowCtl | null;
}

/**
 * Tabs dragged out of their strip: a small preview of their new window follows the pointer wherever
 * a drop would open one, as in Chrome (see shared/tab-tearoff.ts showsTearOffPreview). The preview
 * takes the drop itself, so the system shows a move pointer there instead of "not allowed", and the
 * window opens where it was let go. One preview for the app, made on the first drag and kept hidden.
 */
export class TabDragPreview {
  private win: BrowserWindow | null = null;
  private ready = false;
  private state: DragPreviewState | null = null;
  private drag: Drag | null = null;

  constructor(private readonly host: TabDragHost) {
    ipcMain.on(DRAG_PREVIEW_DROP, (event: IpcMainEvent) => this.onDrop(event));
  }

  /** A drag of `ids` (the person holds `grabbed`) started in `from`'s strip. */
  start(from: BrowserWindowCtl, ids: readonly TabId[], grabbed: TabId): void {
    this.finish();
    this.ensure();
    this.drag = { from, ids: [...ids], shown: false, worked: false, follow: setInterval(() => this.follow(), FOLLOW_MS), late: null };
    void this.describe(from, ids, grabbed);
  }

  /**
   * The drag that started in `from` ended there; `accepted`: it was dropped on something that took it
   * (a strip, or the preview). `ids` stand for a drag the preview never heard of starting.
   */
  end(from: BrowserWindowCtl, accepted: boolean, ids: readonly TabId[]): void {
    const drag = this.drag && this.drag.from === from && !this.drag.late ? this.drag : null;
    const pointer = this.host.pointer();
    const verdict = tearOffAtEnd({
      accepted,
      previewShown: drag?.shown ?? false,
      previewWorked: drag?.worked ?? false,
      awayFromStrip: !from.isDisposed() && tearsOff(pointer, from.stripOnScreen()),
    });
    if (drag) clearInterval(drag.follow);
    this.hide();
    if (drag && verdict === "wait") {
      drag.late = setTimeout(() => this.finish(), LATE_DROP_MS);
      return;
    }
    if (drag) this.finish();
    if (verdict === "tear") this.host.tearOff(from, drag?.ids ?? ids, pointer);
  }

  /** The preview's window, once made (for the smoke). */
  window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** No windows left: the preview goes too. */
  dispose(): void {
    this.finish();
    const win = this.win;
    this.win = null;
    this.ready = false;
    if (win && !win.isDestroyed()) win.destroy();
  }

  private onDrop(event: IpcMainEvent): void {
    const drag = this.drag;
    if (!drag || !this.win || event.sender !== this.win.webContents || event.senderFrame !== event.sender.mainFrame) return;
    const pointer = this.host.pointer();
    this.finish();
    this.hide();
    if (!drag.from.isDisposed()) this.host.tearOff(drag.from, drag.ids, pointer);
  }

  private follow(): void {
    const drag = this.drag;
    if (!drag || drag.late) return;
    if (drag.from.isDisposed()) {
      this.finish();
      this.hide();
      return;
    }
    const pointer = this.host.pointer();
    const others = this.host.partners(drag.from).map((w) => w.stripOnScreen());
    if (showsTearOffPreview(pointer, drag.from.stripOnScreen(), others)) this.place(pointer);
    else this.hide();
  }

  private place(pointer: Point): void {
    const drag = this.drag;
    const win = this.win;
    if (!drag || !win || win.isDestroyed()) return;
    const bounds = previewBounds(pointer);
    win.setBounds(bounds);
    if (!win.isVisible()) win.showInactive();
    // Until its page loaded it takes no drop: the drag then ends as it did before the preview.
    drag.shown = this.ready;
    const at = win.getBounds();
    if (this.ready && Math.abs(at.x - bounds.x) <= 2 && Math.abs(at.y - bounds.y) <= 2) drag.worked = true;
  }

  private hide(): void {
    if (this.drag) this.drag.shown = false;
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  private finish(): void {
    const drag = this.drag;
    if (!drag) return;
    clearInterval(drag.follow);
    if (drag.late) clearTimeout(drag.late);
    this.drag = null;
  }

  /** What the preview shows: the title of the grabbed tab, its page small, and how many tabs go. */
  private async describe(from: BrowserWindowCtl, ids: readonly TabId[], grabbed: TabId): Promise<void> {
    const tab = from.getTab(grabbed);
    let thumbnail: string | null = null;
    try {
      if (tab && tab.view.getVisible()) {
        const image = await tab.view.webContents.capturePage();
        if (!image.isEmpty()) thumbnail = `data:image/jpeg;base64,${image.resize({ width: PREVIEW_SIZE.width }).toJPEG(75).toString("base64")}`;
      }
    } catch {
      // The title alone, then.
    }
    this.state = { language: uiLanguage(), title: tab?.title ?? "", count: ids.length, thumbnail };
    this.post();
  }

  private post(): void {
    if (this.ready && this.state && this.win && !this.win.isDestroyed()) this.win.webContents.send(DRAG_PREVIEW_EVENT, this.state);
  }

  /**
   * The preview's window, made once. It loads its page the first time it shows (on Windows a window
   * never shown loads nothing), so the very first drag gets it a moment later; then it stays hidden
   * between drags, loaded.
   */
  private ensure(): void {
    if (this.win && !this.win.isDestroyed()) return;
    const win = new BrowserWindow({
      ...PREVIEW_SIZE,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: "Corvus",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#202124" : "#ffffff",
      webPreferences: { preload: paths.assistPreload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    win.setAlwaysOnTop(true, "pop-up-menu");
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event) => event.preventDefault());
    wc.on("did-finish-load", () => {
      this.ready = true;
      this.post();
    });
    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.ready = false;
      }
    });
    void wc.loadURL("corvus://drag-preview/");
    this.win = win;
  }
}
