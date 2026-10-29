import type { HistoryPage, HistorySummary } from "@corvus/webscope";
import { describe, expect, it } from "vitest";
import { ChangeCoalescer, anchoredScrollTop, firstIndexOf, mergeHistory, scrollAnchor, serialRefresher, type Timers } from "../src/shared/webscope-live";

/** Manual clock: timers fire only when the test advances time. */
class FakeTimers implements Timers {
  time = 0;
  private queue: Array<{ at: number; fn: () => void; id: number }> = [];
  private ids = 0;
  now(): number {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.ids;
    this.queue.push({ at: this.time + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== handle);
  }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = this.queue.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.queue = this.queue.filter((t) => t !== next);
      this.time = next.at;
      next.fn();
    }
    this.time = end;
  }
  get pending(): number {
    return this.queue.length;
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function row(id: string, status: number | null = 200): HistorySummary {
  return { id, method: "GET", host: "example.com", path: `/${id}`, status, type: "document", length: 1, durationMs: 1, startedAt: 1, inScope: true, source: "capture" };
}
const page = (rows: HistorySummary[], reset = false): HistoryPage => ({ rows, reset, cursor: { epoch: 0, seq: 0 } });
const ids = (rows: HistorySummary[]): string[] => rows.map((r) => r.id);

describe("ChangeCoalescer", () => {
  it("flushes the first change on the next tick, with every topic seen meanwhile", () => {
    const timers = new FakeTimers();
    const flushed: string[][] = [];
    const live = new ChangeCoalescer<string>((topics) => flushed.push(topics), 250, timers);
    live.push("history");
    live.push("history");
    live.push("intercept");
    expect(flushed).toEqual([]);
    timers.advance(0);
    expect(flushed).toEqual([["history", "intercept"]]);
  });

  it("flushes at most once per interval under a steady stream of changes", () => {
    const timers = new FakeTimers();
    const flushed: Array<{ at: number; topics: string[] }> = [];
    const live = new ChangeCoalescer<string>((topics) => flushed.push({ at: timers.now(), topics }), 250, timers);
    for (let ms = 0; ms < 1000; ms += 10) {
      live.push(ms % 100 === 0 ? "capture" : "history");
      timers.advance(10);
    }
    timers.advance(250);
    expect(flushed.map((f) => f.at)).toEqual([0, 250, 500, 750, 1000]);
    expect(flushed.every((f, i) => i === 0 || f.at - flushed[i - 1]!.at >= 250)).toBe(true);
    expect(flushed[1]?.topics.sort()).toEqual(["capture", "history"]);
  });

  it("drops pending changes on dispose", () => {
    const timers = new FakeTimers();
    const flushed: string[][] = [];
    const live = new ChangeCoalescer<string>((topics) => flushed.push(topics), 250, timers);
    live.push("history");
    live.dispose();
    timers.advance(1000);
    expect(flushed).toEqual([]);
    expect(timers.pending).toBe(0);
  });
});

describe("serialRefresher", () => {
  it("never runs two refreshes at once and folds triggers during a run into one more", async () => {
    const timers = new FakeTimers();
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    const done: Array<() => void> = [];
    const refresher = serialRefresher(
      () =>
        new Promise<void>((resolve) => {
          runs++;
          running++;
          maxRunning = Math.max(maxRunning, running);
          done.push(() => {
            running--;
            resolve();
          });
        }),
      0,
      timers,
    );
    refresher.trigger();
    refresher.trigger();
    refresher.trigger();
    expect(runs).toBe(1);
    done.shift()!();
    await tick();
    expect(runs).toBe(2);
    done.shift()!();
    await tick();
    expect(runs).toBe(2);
    expect(maxRunning).toBe(1);
  });

  it("spaces runs out by the minimum gap", async () => {
    const timers = new FakeTimers();
    const at: number[] = [];
    const refresher = serialRefresher(async () => void at.push(timers.now()), 1000, timers);
    refresher.trigger();
    await tick();
    refresher.trigger();
    refresher.trigger();
    timers.advance(999);
    expect(at).toEqual([0]);
    timers.advance(1);
    await tick();
    expect(at).toEqual([0, 1000]);
  });

  it("keeps going after a failed refresh and stops after dispose", async () => {
    const timers = new FakeTimers();
    let runs = 0;
    const refresher = serialRefresher(
      async () => {
        runs++;
        throw new Error("page closed");
      },
      0,
      timers,
    );
    refresher.trigger();
    await tick();
    refresher.trigger();
    await tick();
    expect(runs).toBe(2);
    refresher.dispose();
    refresher.trigger();
    await tick();
    expect(runs).toBe(2);
  });
});

describe("mergeHistory", () => {
  it("puts new rows on top, updates known rows in place and keeps the cap", () => {
    const current = [row("c"), row("b"), row("a")];
    const { rows, added } = mergeHistory(current, page([row("e"), row("d"), row("b", 500)]), 4);
    expect(ids(rows)).toEqual(["e", "d", "c", "b"]);
    expect(rows[3]?.status).toBe(500);
    expect(added).toEqual(["e", "d"]);
  });

  it("replaces everything on a reset page and leaves the list untouched when nothing changed", () => {
    const current = [row("b"), row("a")];
    expect(mergeHistory(current, page([row("x")], true), 10)).toEqual({ rows: [row("x")], added: [] });
    expect(mergeHistory(current, page([]), 10).rows).toBe(current);
  });
});

describe("scroll anchoring", () => {
  const H = 27;

  it("keeps the row at the top of the view in place when rows arrive above it", () => {
    const before = ["r9", "r8", "r7", "r6", "r5", "r4"];
    const anchor = scrollAnchor(before, 2 * H + 5, H);
    expect(anchor).toEqual({ id: "r7", offset: 5 });
    const after = ["r12", "r11", "r10", ...before];
    expect(anchoredScrollTop(after, anchor, H)).toBe(5 * H + 5);
  });

  it("does not anchor at the very top, where new rows should simply show up", () => {
    expect(scrollAnchor(["a", "b"], 0, H)).toBeNull();
    expect(anchoredScrollTop(["a"], null, H)).toBeNull();
    expect(anchoredScrollTop(["a"], { id: "gone", offset: 3 }, H)).toBeNull();
  });

  it("finds the first of the new rows", () => {
    expect(firstIndexOf(["a", "b", "c", "d"], new Set(["d", "b"]))).toBe(1);
    expect(firstIndexOf(["a"], new Set())).toBe(-1);
  });
});
