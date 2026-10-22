import fs from "node:fs";
import path from "node:path";
import { shell } from "electron";

const LOG_DIR = "crash-logs";
const LOG_FILE = "crash.log";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const MAX_LINE = 8192;

/**
 * Opt-in, purely local crash/error log. Appends newline-delimited JSON to a rotating file under the
 * user data folder, and only when the user has turned logging on. Nothing is ever uploaded. Every
 * method swallows its own errors: a logger must never be the reason the app goes down.
 */
export class CrashReporter {
  private readonly dir: string;
  private readonly file: string;

  constructor(
    userDataDir: string,
    private readonly enabled: () => boolean,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly maxFiles = DEFAULT_MAX_FILES,
  ) {
    this.dir = path.join(userDataDir, LOG_DIR);
    this.file = path.join(this.dir, LOG_FILE);
  }

  logFolder(): string {
    return this.dir;
  }

  record(kind: string, data: Record<string, unknown> = {}): void {
    // Always surface to the console so crashes stay visible in dev and smoke even with logging off.
    console.error(`[corvus] ${kind}`, data);
    if (!this.enabled()) return;
    try {
      let line = JSON.stringify({ at: new Date().toISOString(), kind, ...data });
      if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}…`;
      line += "\n";
      fs.mkdirSync(this.dir, { recursive: true });
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.file, line);
    } catch {
      // A crash logger that throws would defeat its own purpose.
    }
  }

  /** Open the log folder in the OS file manager. Returns an error string, or null on success. */
  async openFolder(): Promise<string | null> {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const err = await shell.openPath(this.dir);
      return err || null;
    } catch (e) {
      return String(e);
    }
  }

  private rotateIfNeeded(incoming: number): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return; // no current file: nothing to rotate
    }
    if (size + incoming <= this.maxBytes) return;
    this.rotate();
  }

  private rotate(): void {
    const drop = `${this.file}.${this.maxFiles - 1}`;
    try {
      if (fs.existsSync(drop)) fs.rmSync(drop);
    } catch {
      // ignore
    }
    for (let i = this.maxFiles - 2; i >= 1; i--) {
      try {
        if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      } catch {
        // ignore
      }
    }
    try {
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      // ignore
    }
  }
}

/**
 * Route main-process uncaught exceptions and unhandled rejections into the reporter. Registering an
 * uncaughtException handler also stops Node's default action (print + exit), so a stray throw in the
 * main process no longer kills the whole browser; it is logged and the app keeps running.
 */
export function installCrashHandlers(reporter: CrashReporter): void {
  process.on("uncaughtException", (err: Error, origin) => {
    reporter.record("uncaught-exception", { message: err?.message ?? String(err), stack: err?.stack, origin });
  });
  process.on("unhandledRejection", (reason: unknown) => {
    const err = reason instanceof Error ? reason : undefined;
    reporter.record("unhandled-rejection", { message: err?.message ?? String(reason), stack: err?.stack });
  });
}
