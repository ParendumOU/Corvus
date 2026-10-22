import path from "node:path";
import { buildSnapshot, restorePlan, reviveSession, type SessionSnapshot } from "../shared/session-state";
import type { AppContext } from "./context";
import { JsonFile } from "./json-file";
import type { BrowserWindowCtl } from "./window";

const SAVE_INTERVAL_MS = 3000;

/**
 * "Continue where you left off": the open windows, tabs and groups are written to session.json
 * (atomically, a few seconds after any change) so a crash loses at most that much. Closing the last
 * window or quitting freezes the file, so the windows open at that moment come back on next start.
 */
export class SessionRestore {
  private readonly file: JsonFile<SessionSnapshot | null>;
  private dirty = false;
  private frozen = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    dir: string,
  ) {
    this.file = JsonFile.load<SessionSnapshot | null>(path.join(dir, "session.json"), () => null, reviveSession, 0);
  }

  /** The last saved session, as found on disk at startup. */
  saved(): SessionSnapshot | null {
    return this.file.get();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.dirty) this.save();
    }, SAVE_INTERVAL_MS);
    this.timer.unref();
  }

  markDirty(): void {
    if (!this.frozen) this.dirty = true;
  }

  /** A window opened again after the session was frozen (e.g. on macOS with no windows left). */
  resume(): void {
    this.frozen = false;
    this.dirty = true;
  }

  capture(): SessionSnapshot {
    const windows = this.ctx.windows.all().filter((w) => !w.isDisposed());
    return buildSnapshot(
      windows.map((w) => w.sessionWindow()),
      Date.now(),
    );
  }

  save(snapshot: SessionSnapshot = this.capture()): void {
    this.dirty = false;
    try {
      this.file.set(snapshot);
    } catch (err) {
      console.error("[corvus] could not save the session:", err);
    }
  }

  /** Called before a window closes. Closing the last one keeps it in the saved session. */
  windowClosing(win: BrowserWindowCtl): void {
    if (this.frozen) return;
    const others = this.ctx.windows.all().filter((w) => w !== win && !w.isDisposed());
    if (others.length > 0) {
      this.markDirty();
      return;
    }
    this.save();
    this.frozen = true;
  }

  quitting(): void {
    if (this.frozen) return;
    this.save();
    this.frozen = true;
  }

  /** Reopen the saved windows. Returns the windows opened (none when there was nothing to restore). */
  restore(snapshot: SessionSnapshot | null = this.saved()): BrowserWindowCtl[] {
    const plan = restorePlan(snapshot, this.ctx.profiles.list().map((p) => p.id));
    const opened: BrowserWindowCtl[] = [];
    for (const sw of plan) {
      try {
        opened.push(this.ctx.windows.restore(sw));
      } catch (err) {
        console.error("[corvus] could not restore a window:", err);
      }
    }
    return opened;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
