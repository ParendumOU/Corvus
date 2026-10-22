import { app } from "electron";
import electronUpdater, { type ProgressInfo, type UpdateInfo } from "electron-updater";
import type { UpdatePhase, UpdateStatus } from "../shared/ipc";
import type { UpdateChannel } from "../shared/settings";
import { displayFeedUrl, resolveUpdateFeed, updaterChannel } from "../shared/update-feed";
import type { AppContext } from "./context";

const { autoUpdater } = electronUpdater;

/**
 * Self-update from GitHub Releases (ParendumOU/Corvus), or from a self-hosted electron-builder
 * "generic" feed when Settings > Updates has a feed URL. Checks on startup (opt-in) and on demand;
 * downloads are user-initiated, installs happen on restart. The app must be packaged for any of
 * this to run: in development every call is a no-op and the UI explains why.
 */
export class UpdateService {
  private phase: UpdatePhase = "idle";
  private newVersion: string | null = null;
  private percent: number | null = null;
  private releaseNotes: string | null = null;
  private error: string | null = null;
  private checkedAt: number | null = null;
  private wired = false;
  private checking: Promise<void> | null = null;

  constructor(private readonly ctx: AppContext) {}

  private supported(): boolean {
    return app.isPackaged;
  }

  private channel(): UpdateChannel {
    return this.ctx.settings.get().update.channel;
  }

  private feedUrl(): string {
    return displayFeedUrl(this.ctx.settings.get().update.feedUrl);
  }

  /** Attach listeners once, then point the updater at the configured feed and channel. */
  private configure(): boolean {
    if (!this.supported()) return false;
    if (!this.wired) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.logger = null;
      autoUpdater.on("checking-for-update", () => this.set("checking"));
      autoUpdater.on("update-available", (info: UpdateInfo) => {
        this.newVersion = info.version;
        this.releaseNotes = notesToText(info.releaseNotes);
        this.set("available");
      });
      autoUpdater.on("update-not-available", () => {
        this.newVersion = null;
        this.set("not-available");
      });
      autoUpdater.on("download-progress", (p: ProgressInfo) => {
        this.percent = Math.max(0, Math.min(100, Math.round(p.percent)));
        this.set("downloading");
      });
      autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
        this.newVersion = info.version;
        this.releaseNotes = notesToText(info.releaseNotes);
        this.percent = 100;
        this.set("downloaded");
      });
      autoUpdater.on("error", (err: Error) => {
        this.error = cleanError(err);
        this.set("error");
      });
      this.wired = true;
    }
    const { channel, allowPrerelease, allowDowngrade } = updaterChannel(this.channel(), app.getVersion());
    autoUpdater.channel = channel;
    autoUpdater.allowPrerelease = allowPrerelease;
    autoUpdater.allowDowngrade = allowDowngrade;
    try {
      // Set every time: clearing a custom URL must switch back to GitHub within the same session.
      autoUpdater.setFeedURL(resolveUpdateFeed(this.ctx.settings.get().update.feedUrl, channel));
    } catch (err) {
      this.error = cleanError(err as Error);
      this.set("error");
      return false;
    }
    return true;
  }

  /** Check the feed. Manual checks reset any prior error so the result is fresh. */
  check(): Promise<void> {
    if (this.checking) return this.checking;
    if (!this.configure()) return Promise.resolve();
    this.error = null;
    this.checking = (async () => {
      try {
        await autoUpdater.checkForUpdates();
        this.checkedAt = Date.now();
      } catch (err) {
        this.error = cleanError(err as Error);
        this.set("error");
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /** Start downloading an offered update. Progress and completion arrive via events. */
  download(): void {
    if (this.phase !== "available" && this.phase !== "error") return;
    if (!this.configure()) return;
    this.error = null;
    this.percent = 0;
    this.set("downloading");
    autoUpdater.downloadUpdate().catch((err: unknown) => {
      this.error = cleanError(err as Error);
      this.set("error");
    });
  }

  /** Quit and install a downloaded update. */
  install(): void {
    if (this.phase !== "downloaded") return;
    try {
      autoUpdater.quitAndInstall();
    } catch (err) {
      this.error = cleanError(err as Error);
      this.set("error");
    }
  }

  /** Optional check when Corvus starts; failures only surface in the UI. */
  startupCheck(): void {
    if (!this.supported() || !this.ctx.settings.get().update.autoCheck) return;
    void this.check();
  }

  status(): UpdateStatus {
    const supported = this.supported();
    return {
      supported,
      reason: supported ? null : "Updates apply to installed builds only (this one runs from source).",
      phase: supported ? this.phase : "idle",
      currentVersion: app.getVersion(),
      channel: this.channel(),
      feedUrl: this.feedUrl(),
      newVersion: this.newVersion,
      percent: this.percent,
      releaseNotes: this.releaseNotes,
      checkedAt: this.checkedAt,
      error: this.error,
    };
  }

  private set(phase: UpdatePhase): void {
    this.phase = phase;
    const status = this.status();
    for (const win of this.ctx.windows.all()) win.notifyInternalPages({ type: "update-changed", status }, ["settings"]);
  }
}

function notesToText(notes: UpdateInfo["releaseNotes"]): string | null {
  if (!notes) return null;
  const text = typeof notes === "string" ? notes : notes.map((n) => n.note ?? "").filter(Boolean).join("\n\n");
  const trimmed = text.replace(/<[^>]+>/g, "").trim();
  return trimmed ? trimmed.slice(0, 4000) : null;
}

function cleanError(err: Error | string): string {
  const msg = (err instanceof Error ? err.message : String(err)) || "Update failed.";
  return msg.length > 300 ? `${msg.slice(0, 299)}…` : msg;
}
