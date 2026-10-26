import os from "node:os";
import { app } from "electron";
import { tabsToSleep, tabsToSleepUnderPressure } from "../shared/tab-sleep";
import type { AppContext } from "./context";

const TICK_MS = 60_000;
const MEMORY_TICK_MS = 15_000;

/**
 * Puts background tabs to sleep after Settings > Memory's delay (unless they are pinned, playing
 * sound, driven by an agent, or hold typed text), and keeps each window's per-tab memory figures
 * fresh for the tab strip.
 */
export class TabSleeper {
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    if (this.timers.length > 0) return;
    this.timers.push(setInterval(() => void this.tick(Date.now()), TICK_MS).unref());
    this.timers.push(setInterval(() => this.refreshMemory(), MEMORY_TICK_MS).unref());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** One pass over every window; returns how many tabs went to sleep. */
  async tick(now: number): Promise<number> {
    const memory = this.ctx.settings.get().memory;
    if (!memory.sleepTabs) return 0;
    let slept = 0;
    // Low on memory: the least recently used background tabs sleep early, a few per pass.
    const freeShare = this.freeShare();
    for (const win of this.ctx.windows.all()) {
      const candidates = win.sleepCandidates();
      const due = new Set([...tabsToSleep(candidates, now, memory.sleepAfterMinutes), ...tabsToSleepUnderPressure(candidates, freeShare)]);
      for (const id of due) {
        if (await win.pageIsEdited(id)) continue;
        if (win.sleepTab(id)) slept++;
      }
    }
    return slept;
  }

  /** Share of the system memory that is free (tests set it). */
  freeShare: () => number = () => os.freemem() / Math.max(1, os.totalmem());

  /** Per-process memory (working set, KB) for every window's tab strip. */
  refreshMemory(): void {
    const byPid = new Map<number, number>();
    for (const metric of app.getAppMetrics()) byPid.set(metric.pid, metric.memory.workingSetSize);
    for (const win of this.ctx.windows.all()) win.setProcessMemory(byPid);
  }
}
