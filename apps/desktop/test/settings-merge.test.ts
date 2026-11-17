import { describe, expect, it } from "vitest";
import { defaultSettings, mergeSettings } from "../src/shared/settings";

describe("mergeSettings numbers", () => {
  it("keeps the current value when a number is NaN or infinite", () => {
    const base = defaultSettings();
    const merged = mergeSettings(base, {
      ai: { maxOutputTokens: Number.NaN },
      agent: { maxSteps: Number.NaN },
      appearance: { sidebarWidth: Number.POSITIVE_INFINITY },
      reader: { fontSize: Number.NaN, lineWidth: Number.NEGATIVE_INFINITY },
      monitor: { maxWatches: Number.NaN },
    });
    expect(merged.ai.maxOutputTokens).toBe(base.ai.maxOutputTokens);
    expect(merged.agent.maxSteps).toBe(base.agent.maxSteps);
    expect(merged.appearance.sidebarWidth).toBe(base.appearance.sidebarWidth);
    expect(merged.reader.fontSize).toBe(base.reader.fontSize);
    expect(merged.reader.lineWidth).toBe(base.reader.lineWidth);
    expect(merged.monitor.maxWatches).toBe(base.monitor.maxWatches);
  });

  it("still clamps finite numbers", () => {
    expect(mergeSettings(defaultSettings(), { agent: { maxSteps: 999 } }).agent.maxSteps).toBe(50);
  });
});
