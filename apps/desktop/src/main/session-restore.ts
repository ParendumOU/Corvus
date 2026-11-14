import fs from "node:fs";
import path from "node:path";
import { buildSnapshot, hasRealPages, restorePlan, reviveSession, type SessionSnapshot, type SessionWindow } from "../shared/session-state";
import type { AppContext } from "./context";
import { JsonFile } from "./json-file";
import type { BrowserWindowCtl, WindowOpenOptions } from "./window";

const SAVE_INTERVAL_MS = 3000;
/**
 * How long a window that closed while others stayed open still counts as open. Closing Corvus from
 * outside (taskkill without /F, an installer, Windows ending the session) closes every window one
 * after another; each looked like the person closing that window, so only the last one was kept.
 */
export const CLOSE_BURST_MS = 2000;
/** Copies of the session found at each start (session.json.1 is the newest). */
export const SESSION_BACKUPS = 3;
/** The last-good copy is rewritten at most this often while Corvus runs (always when it quits). */
const LAST_GOOD_INTERVAL_MS = 30_000;

/**
 * Keeps the session found on disk before this run writes anything: session.json.1 to .<keep>,
 * newest first. A start that restores nothing then never costs the session it could not open.
 */
export function rotateSessionBackups(file: string, keep = SESSION_BACKUPS): void {
  try {
    if (fs.statSync(file).size === 0) return;
  } catch {
    return;
  }
  try {
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.copyFileSync(file, `${file}.1`);
  } catch (err) {
    console.error("[corvus] could not back up the session:", err);
  }
}

/**
 * "Continue where you left off": the open windows, tabs and groups are written to session.json
 * (atomically, a few seconds after any change) so a crash loses at most that much. Closing the last
 * window or quitting freezes the file, so the windows open at that moment come back on next start.
 * Windows closed just before the last one (all of them closed at once from outside) come back too.
 * The last session with real pages is also kept in session.last-good.json.
 */
export class SessionRestore {
  private readonly file: JsonFile<SessionSnapshot | null>;
  private readonly lastGood: JsonFile<SessionSnapshot | null>;
  private lastGoodAt = 0;
  private dirty = false;
  private frozen = false;
  private timer: NodeJS.Timeout | null = null;
  /** Windows that closed while others stayed open, as they were, for CLOSE_BURST_MS. */
  private closing: Array<{ window: SessionWindow; at: number; from: BrowserWindowCtl }> = [];

  constructor(
    private readonly ctx: Pick<AppContext, "windows" | "profiles">,
    dir: string,
    private readonly now: () => number = Date.now,
  ) {
    const file = path.join(dir, "session.json");
    rotateSessionBackups(file);
    this.file = JsonFile.load<SessionSnapshot | null>(file, () => null, reviveSession, 0);
    this.lastGood = new JsonFile<SessionSnapshot | null>(path.join(dir, "session.last-good.json"), null, 0);
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
    const now = this.now();
    this.closing = this.closing.filter((c) => now - c.at < CLOSE_BURST_MS);
    const windows = this.ctx.windows.regular().filter((w) => !w.isDisposed() && !this.closing.some((c) => c.from === w));
    return buildSnapshot([...this.closing.map((c) => c.window), ...windows.map((w) => w.sessionWindow())], now);
  }

  save(snapshot: SessionSnapshot = this.capture()): void {
    this.dirty = false;
    try {
      this.file.set(snapshot);
      if (hasRealPages(snapshot) && (this.frozen || this.now() - this.lastGoodAt >= LAST_GOOD_INTERVAL_MS)) {
        this.lastGood.set(snapshot);
        this.lastGoodAt = this.now();
      }
    } catch (err) {
      console.error("[corvus] could not save the session:", err);
    }
  }

  /** Called before a window closes. Closing the last one keeps it in the saved session. */
  windowClosing(win: BrowserWindowCtl): void {
    if (this.frozen) return;
    const others = this.ctx.windows.regular().filter((w) => w !== win && !w.isDisposed());
    if (others.length > 0) {
      const window = win.sessionWindow();
      if (window) {
        this.closing.push({ window, at: this.now(), from: win });
        // Once the burst is over, the window the person closed leaves the saved session.
        setTimeout(() => this.markDirty(), CLOSE_BURST_MS).unref();
      }
      this.markDirty();
      return;
    }
    this.frozen = true;
    this.save();
  }

  quitting(): void {
    if (this.frozen) return;
    this.frozen = true;
    this.save();
  }

  /** Reopen the saved windows. Returns the windows opened (none when there was nothing to restore). */
  restore(snapshot: SessionSnapshot | null = this.saved(), opts: Pick<WindowOpenOptions, "background"> = {}): BrowserWindowCtl[] {
    const plan = restorePlan(snapshot, this.ctx.profiles.list().map((p) => p.id));
    const opened: BrowserWindowCtl[] = [];
    for (const sw of plan) {
      try {
        opened.push(this.ctx.windows.restore(sw, opts));
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
