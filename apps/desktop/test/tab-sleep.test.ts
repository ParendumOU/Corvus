import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { defaultSettings, mergeSettings } from "../src/shared/settings";
import { EDITED_PAGE_SCRIPT, formatMemory, tabsToSleep, type SleepCandidate } from "../src/shared/tab-sleep";

const HOUR = 3_600_000;
const tab = (patch: Partial<SleepCandidate>): SleepCandidate => ({
  id: "t",
  url: "https://example.com/",
  lastShownAt: 0,
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
      tab({ id: "never-shown", lastShownAt: undefined }),
    ];
    expect(tabsToSleep(tabs, now, 60)).toEqual(["old"]);
    expect(tabsToSleep(tabs, now, 5)).toEqual(["old", "recent"]);
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
