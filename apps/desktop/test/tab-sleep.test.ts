import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { defaultSettings, mergeSettings } from "../src/shared/settings";
import { CRASH_RELOAD_GAP_MS, EDITED_PAGE_SCRIPT, LOW_MEMORY_SHARE, PRESSURE_BATCH, formatMemory, mayReloadCrashedPage, memoryFreeShare, pageCanComeBack, tabsToSleep, tabsToSleepUnderPressure, type SleepCandidate } from "../src/shared/tab-sleep";

const HOUR = 3_600_000;
const tab = (patch: Partial<SleepCandidate>): SleepCandidate => ({
  id: "t",
  url: "https://example.com/",
  lastShownAt: 0,
  openedAt: 0,
  shown: false,
  pinned: false,
  audible: false,
  loading: false,
  agentControlled: false,
  crashed: false,
  unloaded: false,
  ...patch,
});

describe("sleeping tabs", () => {
  it("puts to sleep the web pages left in the background long enough", () => {
    const now = 2 * HOUR;
    const tabs = [
      tab({ id: "old", lastShownAt: 0 }),
      tab({ id: "recent", lastShownAt: now - 10 * 60_000 }),
      tab({ id: "shown", shown: true }),
      tab({ id: "pinned", pinned: true }),
      tab({ id: "music", audible: true }),
      tab({ id: "agent", agentControlled: true }),
      tab({ id: "loading", loading: true }),
      tab({ id: "crashed", crashed: true }),
      tab({ id: "asleep", unloaded: true }),
      tab({ id: "internal", url: "corvus://settings/" }),
      tab({ id: "never-shown", lastShownAt: undefined, openedAt: 0 }),
      tab({ id: "just-opened", lastShownAt: undefined, openedAt: now - 60_000 }),
    ];
    // A tab opened in the background and never shown counts from when it opened (it used to stay awake).
    expect(tabsToSleep(tabs, now, 60)).toEqual(["old", "never-shown"]);
    expect(tabsToSleep(tabs, now, 5)).toEqual(["old", "recent", "never-shown"]);
  });

  it("under memory pressure, sleeps the least recently used background tabs early, a few at a time", () => {
    const now = 10 * 60_000;
    const tabs = [
      tab({ id: "a", lastShownAt: now - 60_000 }),
      tab({ id: "b", lastShownAt: now - 5 * 60_000 }),
      tab({ id: "c", lastShownAt: undefined, openedAt: now - 9 * 60_000 }),
      tab({ id: "d", lastShownAt: now - 2 * 60_000 }),
      tab({ id: "pinned", pinned: true, lastShownAt: 0 }),
      tab({ id: "shown", shown: true, lastShownAt: 0 }),
    ];
    expect(tabsToSleepUnderPressure(tabs, LOW_MEMORY_SHARE + 0.05)).toEqual([]);
    expect(tabsToSleepUnderPressure(tabs, LOW_MEMORY_SHARE / 2)).toEqual(["c", "b", "d"].slice(0, PRESSURE_BATCH));
  });

  it("measures memory pressure by the tighter of RAM and, on Windows, the commit limit", () => {
    const info = { total: 16_000_000, free: 8_000_000, swapTotal: 20_000_000, swapFree: 1_000_000 };
    expect(memoryFreeShare(info, true)).toBe(0.05);
    // Elsewhere swap is only swap: a full swap with free RAM is no pressure.
    expect(memoryFreeShare(info, false)).toBe(0.5);
    expect(memoryFreeShare({ total: 16_000_000, free: 800_000 }, true)).toBe(0.05);
    expect(memoryFreeShare({ total: 16_000_000, free: 8_000_000, swapTotal: 0, swapFree: 0 }, true)).toBe(0.5);
  });

  it("brings back a page whose process died, but never in a loop", () => {
    for (const reason of ["oom", "crashed", "abnormal-exit", "killed"]) expect(pageCanComeBack(reason)).toBe(true);
    for (const reason of ["launch-failed", "integrity-failure", "clean-exit"]) expect(pageCanComeBack(reason)).toBe(false);
    const now = 10 * CRASH_RELOAD_GAP_MS;
    expect(mayReloadCrashedPage(undefined, now)).toBe(true);
    expect(mayReloadCrashedPage(now - 1000, now)).toBe(false);
    expect(mayReloadCrashedPage(now - CRASH_RELOAD_GAP_MS, now)).toBe(true);
  });

  it("keeps a page awake when the person typed into it", () => {
    const field = (patch: Record<string, unknown>) => ({ type: "text", value: "", defaultValue: "", checked: false, defaultChecked: false, ...patch });
    const run = (fields: unknown[], active: unknown = null) =>
      runInNewContext(EDITED_PAGE_SCRIPT, { document: { activeElement: active, querySelectorAll: () => fields } }) as boolean;
    expect(run([field({}), field({ type: "hidden", value: "x" })])).toBe(false);
    expect(run([field({ value: "draft" })])).toBe(true);
    expect(run([field({ type: "checkbox", checked: true })])).toBe(true);
    expect(run([], { tagName: "TEXTAREA", isContentEditable: false })).toBe(true);
    expect(run([], { tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("shows memory in MB", () => {
    expect(formatMemory(5 * 1024 + 512)).toBe("5.5 MB");
    expect(formatMemory(150 * 1024 + 300)).toBe("150 MB");
  });

  it("has sane settings", () => {
    expect(defaultSettings().memory).toEqual({ sleepTabs: true, sleepAfterMinutes: 60 });
    expect(mergeSettings(defaultSettings(), { memory: { sleepAfterMinutes: 1 } }).memory.sleepAfterMinutes).toBe(5);
    expect(mergeSettings(defaultSettings(), { memory: { sleepAfterMinutes: 99999 } }).memory.sleepAfterMinutes).toBe(1440);
  });
});
