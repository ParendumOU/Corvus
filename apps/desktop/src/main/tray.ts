import { Menu, Tray, app, nativeImage, type NativeImage } from "electron";
import { keepWindowOnClose, trayAvailable } from "../shared/close-to-tray";
import type { AppContext } from "./context";
import { tr } from "./menu-i18n";
import { paths } from "./paths";
import type { BrowserWindowCtl } from "./window";

/** Notification area icon sizes: 16 px at 100% scaling, up to 32 px at 200%. */
const TRAY_SCALES = [1, 1.25, 1.5, 2];

/**
 * Settings > Startup and closing, "Keep running in the notification area" (Windows and Linux;
 * on macOS an app with no window already stays in the Dock). Closing the last window then tucks it
 * away (see BrowserWindowCtl.tuck) instead of quitting: its tabs, the MCP server and the agents'
 * work go on, and the icon next to the clock opens Corvus again or quits it.
 */
export class TrayService {
  private tray: Tray | null = null;
  private quitting = false;

  constructor(private readonly ctx: AppContext) {
    ctx.settings.onChange((next, prev) => {
      if (next.startup.closeToTray !== prev.startup.closeToTray) this.apply();
      else if (next.appearance.language !== prev.appearance.language) this.tray?.setContextMenu(this.menu());
    });
  }

  start(): void {
    this.apply();
  }

  /** Corvus quits for real (Quit, an update): windows close as asked. */
  markQuitting(): void {
    this.quitting = true;
  }

  /** Whether Corvus stays running with no window open instead of quitting: only with its icon to come back by. */
  keepsRunning(): boolean {
    return this.wanted() && this.tray !== null;
  }

  private wanted(): boolean {
    return !this.quitting && trayAvailable(process.platform) && this.ctx.settings.get().startup.closeToTray;
  }

  /** Whether closing this window tucks it away instead (see shared/close-to-tray). */
  keepsOnClose(win: BrowserWindowCtl): boolean {
    return keepWindowOnClose({
      enabled: this.keepsRunning(),
      isPrivate: win.isPrivate,
      tabCount: win.tabCount,
      otherWindows: this.ctx.windows.all().filter((w) => w !== win && !w.isDisposed()).length,
    });
  }

  /** The person asked for Corvus (the tray icon, or starting it again): its window, or the start ones. */
  open(): void {
    const win = this.ctx.windows.focused();
    if (win && !win.isDisposed()) {
      win.present();
      return;
    }
    if (this.ctx.settings.get().startup.mode === "restore" && this.ctx.sessionRestore.restore().length > 0) return;
    this.ctx.windows.open(this.ctx.profiles.manager.lastUsed);
  }

  private apply(): void {
    if (this.wanted()) {
      if (!this.tray) this.tray = this.create();
      return;
    }
    this.tray?.destroy();
    this.tray = null;
    // Turned off with a window tucked away: it goes back to the taskbar, still minimized.
    for (const win of this.ctx.windows.all()) win.untuck();
  }

  private create(): Tray | null {
    try {
      const tray = new Tray(trayIcon());
      tray.setToolTip("Corvus");
      tray.setContextMenu(this.menu());
      tray.on("click", () => this.open());
      return tray;
    } catch (err) {
      // A Linux desktop without a notification area: Corvus quits with its last window, as before.
      console.error("[corvus] no notification area icon:", err);
      return null;
    }
  }

  private menu(): Menu {
    return Menu.buildFromTemplate([
      { label: tr("Open Corvus"), click: () => this.open() },
      { type: "separator" },
      { label: tr("Quit Corvus"), click: () => app.quit() },
    ]);
  }
}

function trayIcon(): NativeImage {
  const source = nativeImage.createFromPath(paths.icon);
  const icon = nativeImage.createEmpty();
  for (const scaleFactor of TRAY_SCALES) {
    const size = Math.round(16 * scaleFactor);
    icon.addRepresentation({ scaleFactor, buffer: source.resize({ width: size, height: size, quality: "best" }).toPNG() });
  }
  return icon;
}
