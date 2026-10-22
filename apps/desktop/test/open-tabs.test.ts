import type { Tab, TabGroup } from "@corvus/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncScheduler } from "../src/main/sync-scheduler";
import { MAX_SYNCED_TABS, OpenTabsPublisher, collectTabs, parseDeviceTabs, type SyncedTab } from "../src/shared/open-tabs";

function tab(id: string, url: string, extra: Partial<Tab> = {}): Tab {
  return { id, windowId: "w1", url, title: `Title ${id}`, pinned: false, active: false, loading: false, agentControlled: false, ...extra };
}

const group: TabGroup = { id: "g1", title: "Research", color: "blue", collapsed: false };

describe("collectTabs", () => {
  it("publishes web tabs with pin and group, skipping internal and local URLs", () => {
    const tabs = collectTabs([
      {
        tabs: [
          tab("1", "https://a.example/", { pinned: true }),
          tab("2", "corvus://settings/"),
          tab("3", "file:///home/me/notes.txt"),
          tab("4", "http://b.example/page", { groupId: "g1" }),
          tab("5", "about:blank"),
        ],
        groups: [group],
      },
      { tabs: [tab("6", "https://c.example/")], groups: [] },
    ]);
    expect(tabs).toEqual([
      { url: "https://a.example/", title: "Title 1", pinned: true },
      { url: "http://b.example/page", title: "Title 4", pinned: false, group: { title: "Research", color: "blue" } },
      { url: "https://c.example/", title: "Title 6", pinned: false },
    ]);
  });

  it("caps the number of published tabs", () => {
    const many = Array.from({ length: MAX_SYNCED_TABS + 20 }, (_, i) => tab(String(i), `https://x.example/${i}`));
    expect(collectTabs([{ tabs: many, groups: [] }])).toHaveLength(MAX_SYNCED_TABS);
  });
});

describe("OpenTabsPublisher", () => {
  it("only changes the record (and its timestamp) when the tab set changes", () => {
    let tabs: SyncedTab[] = [{ url: "https://a.example/", title: "A", pinned: false }];
    let now = 1000;
    const publisher = new OpenTabsPublisher(() => ({ device: "Laptop", platform: "linux", tabs }), () => now);

    expect(publisher.refresh()).toBe(true);
    const first = publisher.record();
    expect(first).toEqual({ device: "Laptop", platform: "linux", updatedAt: 1000, tabs });

    now = 2000;
    tabs = [...tabs];
    expect(publisher.refresh()).toBe(false);
    expect(publisher.record()).toBe(first);

    now = 3000;
    tabs = [{ url: "https://a.example/", title: "A (renamed)", pinned: false }];
    expect(publisher.refresh()).toBe(true);
    expect(publisher.record().updatedAt).toBe(3000);
  });
});

describe("parseDeviceTabs", () => {
  it("drops unsafe or malformed tabs from remote records", () => {
    expect(parseDeviceTabs(null)).toBeNull();
    expect(parseDeviceTabs({ device: "Phone", updatedAt: "x", tabs: [] })).toBeNull();
    const parsed = parseDeviceTabs({
      device: "Phone",
      platform: "android",
      updatedAt: 5,
      tabs: [
        { url: "javascript:alert(1)", title: "x" },
        { url: "https://ok.example/", title: "OK", pinned: true, group: { title: "G", color: "not-a-color" } },
        { url: "https://g.example/", title: 7, group: { title: "Work", color: "red" } },
        "garbage",
      ],
    });
    expect(parsed).toEqual({
      device: "Phone",
      platform: "android",
      updatedAt: 5,
      tabs: [
        { url: "https://ok.example/", title: "OK", pinned: true },
        { url: "https://g.example/", title: "", pinned: false, group: { title: "Work", color: "red" } },
      ],
    });
  });
});

describe("SyncScheduler (publish throttle)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function scheduler(intervalMs = 0) {
    const runs: number[] = [];
    let release: (() => void) | null = null;
    let block = false;
    const s = new SyncScheduler(
      {
        debounceMs: 10_000,
        maxWaitMs: 60_000,
        intervalMs,
        run: async () => {
          runs.push(Date.now());
          if (block) {
            block = false;
            await new Promise<void>((r) => (release = r));
          }
        },
      },
      () => Date.now(),
    );
    return { s, runs, blockNext: () => (block = true), release: () => release?.() };
  }

  it("debounces bursts of changes into one sync 10 s after the last change", async () => {
    const { s, runs } = scheduler();
    s.poke();
    await vi.advanceTimersByTimeAsync(4_000);
    s.poke();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toHaveLength(1);
    s.stop();
  });

  it("does not let a constant stream of changes postpone sync beyond the max wait", async () => {
    const { s, runs } = scheduler();
    const start = Date.now();
    for (let i = 0; i < 20; i++) {
      s.poke();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]! - start).toBeLessThanOrEqual(60_000);
    s.stop();
  });

  it("syncs periodically and never runs two cycles at once", async () => {
    const { s, runs, blockNext, release } = scheduler(300_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runs).toHaveLength(1);

    blockNext();
    const first = s.trigger();
    const second = s.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(2);
    expect(s.busy).toBe(true);
    release();
    await first;
    await second;
    expect(runs).toHaveLength(3);
    s.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runs).toHaveLength(3);
  });
});
