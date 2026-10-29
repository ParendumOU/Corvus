/**
 * Live updates for corvus://webscope: the main process batches engine changes into a few events a
 * second, and the page merges what is new into its lists without losing its place. Pure logic, so it
 * is unit tested without Electron.
 */
import type { HistoryPage, HistorySummary } from "@corvus/webscope";

/** What changed in a WebScope engine; each view refreshes only for the topics it shows. */
export type WebScopeTopic = "history" | "intercept" | "config" | "capture";

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Coalesces bursts of change notices: the first notice after a quiet spell flushes on the next tick,
 * and under heavy traffic there is at most one flush per `intervalMs`, carrying every topic seen
 * since the previous one.
 */
export class ChangeCoalescer<T> {
  private readonly pending = new Set<T>();
  private timer: unknown = null;
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly flush: (topics: T[]) => void,
    private readonly intervalMs = 250,
    private readonly timers: Timers = realTimers,
  ) {}

  push(topic: T): void {
    this.pending.add(topic);
    if (this.timer !== null) return;
    const wait = Math.max(0, this.last + this.intervalMs - this.timers.now());
    this.timer = this.timers.setTimeout(() => this.fire(), wait);
  }

  private fire(): void {
    this.timer = null;
    this.last = this.timers.now();
    const topics = [...this.pending];
    this.pending.clear();
    if (topics.length > 0) this.flush(topics);
  }

  dispose(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}

export interface Refresher {
  trigger(): void;
  dispose(): void;
}

/**
 * Runs an async refresh with at most one in flight: triggers that arrive while it runs fold into one
 * more run after it. `minGapMs` spaces runs out for views rebuilt from all the traffic.
 */
export function serialRefresher(run: () => Promise<unknown>, minGapMs = 0, timers: Timers = realTimers): Refresher {
  let running = false;
  let queued = false;
  let disposed = false;
  let timer: unknown = null;
  let last = Number.NEGATIVE_INFINITY;

  const start = (): void => {
    timer = null;
    if (disposed) return;
    running = true;
    last = timers.now();
    void run()
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (queued) {
          queued = false;
          trigger();
        }
      });
  };
  const trigger = (): void => {
    if (disposed) return;
    if (running) {
      queued = true;
      return;
    }
    if (timer !== null) return;
    const wait = Math.max(0, last + minGapMs - timers.now());
    if (wait === 0) start();
    else timer = timers.setTimeout(start, wait);
  };
  return {
    trigger,
    dispose: () => {
      disposed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Applies a history page to the rows on screen (newest first). A reset page replaces them; an
 * incremental one updates the rows it already has in place and puts the new ones on top, keeping at
 * most `cap`. `added` lists the new row ids.
 */
export function mergeHistory(current: readonly HistorySummary[], page: HistoryPage, cap: number): { rows: HistorySummary[]; added: string[] } {
  if (page.reset) return { rows: page.rows.slice(0, cap), added: [] };
  if (page.rows.length === 0) return { rows: current as HistorySummary[], added: [] };
  const known = new Set(current.map((r) => r.id));
  const updates = new Map<string, HistorySummary>();
  const fresh: HistorySummary[] = [];
  for (const row of page.rows) {
    if (known.has(row.id)) updates.set(row.id, row);
    else fresh.push(row);
  }
  const kept = updates.size > 0 ? current.map((r) => updates.get(r.id) ?? r) : current;
  return { rows: [...fresh, ...kept].slice(0, cap), added: fresh.map((r) => r.id) };
}

/** The row at the top of a scrolled list and how far past its top edge the list is scrolled. */
export interface ScrollAnchor {
  id: string;
  offset: number;
}

/** Where the list is anchored, or null at the very top (there, new rows simply show up). */
export function scrollAnchor(ids: readonly string[], scrollTop: number, rowHeight: number): ScrollAnchor | null {
  if (scrollTop <= 0) return null;
  const index = Math.floor(scrollTop / rowHeight);
  const id = ids[index];
  return id === undefined ? null : { id, offset: scrollTop - index * rowHeight };
}

/** The scroll position that keeps the anchor row where it was after rows moved, or null if it is gone. */
export function anchoredScrollTop(ids: readonly string[], anchor: ScrollAnchor | null, rowHeight: number): number | null {
  if (!anchor) return null;
  const index = ids.indexOf(anchor.id);
  return index < 0 ? null : index * rowHeight + anchor.offset;
}

/** Index of the first of `wanted` in `ids`, or -1. */
export function firstIndexOf(ids: readonly string[], wanted: ReadonlySet<string>): number {
  if (wanted.size === 0) return -1;
  return ids.findIndex((id) => wanted.has(id));
}
