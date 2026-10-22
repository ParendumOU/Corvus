/**
 * App-level KeePass housekeeping across profiles: unlocks databases whose master password was kept
 * when a profile loads, auto-locks after the idle time in Settings (Passwords), and locks everything
 * not kept unlocked when the screen locks or the machine sleeps. The per-profile KeePassStore holds
 * the data; this only decides when to lock.
 */
import { powerMonitor } from "electron";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";

const TICK_MS = 30_000;

export class KeePassService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {}

  /** Called once per profile runtime as it is created. */
  attach(runtime: ProfileRuntime): void {
    runtime.keepass.onChange(() => {
      for (const win of this.ctx.windows.forProfile(runtime.profile.id)) {
        win.notifyInternalPages({ type: "keepass-changed" }, ["passwords"]);
        win.pushState();
      }
    });
    if (runtime.keepass.configured) void runtime.keepass.restoreRemembered();
    this.start();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    const lockTransient = (): void => {
      for (const runtime of this.ctx.profiles.loaded()) runtime.keepass.lockTransient();
    };
    powerMonitor.on("lock-screen", lockTransient);
    powerMonitor.on("suspend", lockTransient);
  }

  private tick(): void {
    const minutes = this.ctx.settings.get().passwords.keepassAutoLockMinutes;
    if (minutes <= 0) return;
    const idle = powerMonitor.getSystemIdleTime();
    for (const runtime of this.ctx.profiles.loaded()) runtime.keepass.autoLock(idle, minutes);
  }
}
