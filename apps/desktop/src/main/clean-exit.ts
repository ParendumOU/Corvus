import fs from "node:fs";
import path from "node:path";

const FLAG_FILE = "running.flag";

/**
 * Detects an unclean shutdown (renderer-less main crash, power loss, SIGKILL) across launches.
 * On construction the previous flag is read: a flag still on disk means the last run never reached
 * a normal quit. The flag is (re)written for this run by markRunning() and removed only by
 * markCleanExit() on a graceful quit. Writes are synchronous and swallow errors so this is safe to
 * call on the lifecycle hot path.
 */
export class CleanExitTracker {
  private readonly file: string;
  private readonly unclean: boolean;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, FLAG_FILE);
    this.unclean = this.readFlagPresent();
  }

  /** The previous session ended without a clean quit. False on a first-ever launch (no flag yet). */
  wasUnclean(): boolean {
    return this.unclean;
  }

  /** Mark the app as running. Call once at startup, after construction captured the prior state. */
  markRunning(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    } catch {
      // A missing flag only costs us the restore prompt; never fail startup over it.
    }
  }

  /** Record a clean exit so the next launch does not treat this run as a crash. */
  markCleanExit(): void {
    try {
      if (fs.existsSync(this.file)) fs.rmSync(this.file);
    } catch {
      // ignore
    }
  }

  private readFlagPresent(): boolean {
    try {
      return fs.existsSync(this.file);
    } catch {
      return false;
    }
  }
}
