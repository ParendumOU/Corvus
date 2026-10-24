import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, shell } from "electron";
import {
  LINUX_MIME_TYPES,
  WINDOWS_APP_NAME,
  WINDOWS_REGISTRY_KEYS,
  WINDOWS_URL_PROGID,
  linuxDesktopEntry,
  parseRegistered,
  parseUserChoice,
  windowsRegFile,
} from "../shared/default-browser";
import type { DefaultBrowserAnswer, DefaultBrowserView, MakeDefaultResult } from "../shared/browser-ipc";
import type { AppContext } from "./context";
import { paths } from "./paths";
import type { BrowserWindowCtl } from "./window";

const DESCRIPTION = "AI-native browser that is also an MCP server";
/** The .desktop file deb packages install, and the one Corvus writes for AppImage builds. */
const LINUX_DESKTOP_FILE = "corvus.desktop";
const USER_CHOICE = String.raw`HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`;
const REGISTERED_APPS = String.raw`HKCU\Software\RegisteredApplications`;

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? "") }));
  });
}

/**
 * Making Corvus the default browser, per operating system. Windows: Corvus registers itself for the
 * current user (links and web files) and opens Default apps, where the person picks it (Windows does
 * not let an app set itself). Linux: xdg-settings and xdg-mime, after the person asks. macOS: the
 * system asks the person to confirm. Unpackaged (development) builds never register anything.
 */
export class DefaultBrowser {
  /** The window showing this launch's "Corvus is not your default browser" bar. */
  private offerWindow: string | null = null;
  private offered = false;
  private testStatus: DefaultBrowserView | null = null;
  private testMake: (() => MakeDefaultResult) | null = null;

  constructor(private readonly ctx: AppContext) {}

  /** Smoke tests pretend Corvus is (not) the default, and answer "Make default" themselves. */
  setTest(status: DefaultBrowserView | null, make: (() => MakeDefaultResult) | null = null): void {
    this.testStatus = status;
    this.testMake = make;
    // Each test setup counts as a new launch.
    this.offered = false;
    this.offerWindow = null;
  }

  /** The program the system should start: the portable .exe or the AppImage the person ran, else this one. */
  private exe(): string {
    return process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath;
  }

  private supported(): boolean {
    return app.isPackaged && ["win32", "linux", "darwin"].includes(process.platform);
  }

  async status(): Promise<DefaultBrowserView> {
    if (this.testStatus) return { ...this.testStatus };
    const platform = process.platform;
    if (!this.supported()) return { supported: false, isDefault: false, platform };
    if (platform === "win32") {
      const choice = await run("reg", ["query", USER_CHOICE, "/v", "ProgId"]);
      const registered = await run("reg", ["query", REGISTERED_APPS, "/v", WINDOWS_APP_NAME]);
      return { supported: true, isDefault: parseUserChoice(choice.stdout) === WINDOWS_URL_PROGID, platform, registered: registered.ok && parseRegistered(registered.stdout) };
    }
    if (platform === "linux") {
      const current = await run("xdg-settings", ["get", "default-web-browser"]);
      if (!current.ok) return { supported: false, isDefault: false, platform };
      return { supported: true, isDefault: current.stdout.trim() === LINUX_DESKTOP_FILE, platform };
    }
    return { supported: true, isDefault: app.isDefaultProtocolClient("https"), platform };
  }

  /** Does what this system allows to make Corvus the default, and says how it went. */
  async makeDefault(): Promise<MakeDefaultResult> {
    if (this.testMake) return this.testMake();
    if (!this.supported()) return "failed";
    try {
      if (process.platform === "win32") {
        await this.registerWindows();
        await shell.openExternal(`ms-settings:defaultapps?registeredAppUser=${WINDOWS_APP_NAME}`);
        return "settings-opened";
      }
      if (process.platform === "linux") {
        if (process.env.APPIMAGE) this.writeDesktopFile();
        const browser = await run("xdg-settings", ["set", "default-web-browser", LINUX_DESKTOP_FILE]);
        const mime = await run("xdg-mime", ["default", LINUX_DESKTOP_FILE, ...LINUX_MIME_TYPES]);
        return browser.ok && mime.ok ? "default" : "failed";
      }
      const ok = app.setAsDefaultProtocolClient("http") && app.setAsDefaultProtocolClient("https");
      return ok ? "asked" : "failed";
    } catch (err) {
      console.warn("[corvus] default browser:", err);
      return "failed";
    }
  }

  /** Windows: takes Corvus out of Default apps (the uninstaller does the same). */
  async unregister(): Promise<void> {
    if (this.testStatus || process.platform !== "win32" || !this.supported()) return;
    for (const key of WINDOWS_REGISTRY_KEYS) await run("reg", ["delete", key, "/f"]);
    await run("reg", ["delete", REGISTERED_APPS, "/v", WINDOWS_APP_NAME, "/f"]);
  }

  /** Windows: the registration for the current user, written with `reg import` (no administrator rights). */
  private async registerWindows(): Promise<void> {
    const file = path.join(os.tmpdir(), `corvus-default-browser-${process.pid}.reg`);
    // .reg files are UTF-16 LE with a byte order mark.
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(windowsRegFile(this.exe(), { description: DESCRIPTION }), "utf16le")]));
    try {
      const res = await run("reg", ["import", file]);
      if (!res.ok) throw new Error("reg import failed");
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  /** AppImage builds install no .desktop file: write one (and its icon) for the current user. */
  private writeDesktopFile(): void {
    const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    const iconDir = path.join(data, "icons", "hicolor", "512x512", "apps");
    fs.mkdirSync(iconDir, { recursive: true });
    fs.writeFileSync(path.join(iconDir, "corvus.png"), fs.readFileSync(paths.icon));
    const appsDir = path.join(data, "applications");
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(path.join(appsDir, LINUX_DESKTOP_FILE), linuxDesktopEntry(this.exe(), "corvus"));
  }

  /**
   * At startup: a Windows registration follows this executable (portable builds and updates move
   * it), and the first window offers "Make default" once, unless Corvus already is the default or
   * the person said not to ask again.
   */
  async startup(win: BrowserWindowCtl | undefined): Promise<void> {
    const status = await this.status();
    if (process.platform === "win32" && status.registered && !this.testStatus) await this.registerWindows().catch(() => undefined);
    if (this.offered || !win || !status.supported || status.isDefault || !this.ctx.settings.get().startup.askDefaultBrowser) return;
    this.offered = true;
    this.offerWindow = win.id;
    win.pushState();
  }

  /** Whether this window shows the default-browser bar. */
  offerFor(win: BrowserWindowCtl): boolean {
    return this.offerWindow === win.id;
  }

  /** The bar's buttons: Make default, Not now (this launch), Don't ask again. */
  async answer(win: BrowserWindowCtl, choice: DefaultBrowserAnswer): Promise<MakeDefaultResult | null> {
    const shown = this.offerWindow;
    this.offerWindow = null;
    if (shown) this.ctx.windows.all().find((w) => w.id === shown)?.pushState();
    if (choice === "never") this.ctx.settings.update({ startup: { askDefaultBrowser: false } });
    if (choice !== "make") return null;
    const result = await this.makeDefault();
    if (result === "failed") win.openSingleton("corvus://settings/#default-browser");
    return result;
  }
}
