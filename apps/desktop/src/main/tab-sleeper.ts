import { app } from "electron";
import { memoryFreeShare, tabsToSleep, tabsToSleepUnderPressure } from "../shared/tab-sleep";
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
    if (!memory.sleepTabs) return this.relievePressure();
    let slept = 0;
    for (const win of this.ctx.windows.all()) {
      for (const id of tabsToSleep(win.sleepCandidates(), now, memory.sleepAfterMinutes)) {
        if (await win.pageIsEdited(id)) continue;
        if (win.sleepTab(id)) slept++;
      }
    }
    return slept + (await this.relievePressure());
  }

  /**
   * Low on memory: fewer agent tabs keep painting while hidden, and the least recently used
   * background tabs sleep early, a few per window per pass, before Windows starts refusing pages
   * memory and they crash. Runs with every memory refresh, not only every minute.
   */
  async relievePressure(): Promise<number> {
    this.ctx.backgroundRender.enforce();
    if (!this.ctx.settings.get().memory.sleepTabs) return 0;
    const freeShare = this.freeShare();
    let slept = 0;
    for (const win of this.ctx.windows.all()) {
      for (const id of tabsToSleepUnderPressure(win.sleepCandidates(), freeShare)) {
        if (await win.pageIsEdited(id)) continue;
        if (win.sleepTab(id)) slept++;
      }
    }
    return slept;
  }

  /** Share of the system memory that is free (tests set it). */
  freeShare: () => number = () => memoryFreeShare(process.getSystemMemoryInfo(), process.platform === "win32");

  /** Per-process memory (working set, KB) for every window's tab strip. */
  refreshMemory(): void {
    void this.relievePressure();
    const byPid = new Map<number, number>();
    for (const metric of app.getAppMetrics()) byPid.set(metric.pid, metric.memory.workingSetSize);
    for (const win of this.ctx.windows.all()) win.setProcessMemory(byPid);
  }
}
