import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  AGENT_RENDER_CAP,
  AGENT_RENDER_CAP_LOW_MEMORY,
  OPEN_ALL_LOAD_NOW,
  agentRenderCap,
  newTabPaint,
  openAllPlan,
  paintedScript,
  tabsToStopRendering,
  type NewTabPaint,
} from "../src/shared/background-tabs";
import { defaultSettings, mergeSettings } from "../src/shared/settings";

const on = { preloadBackgroundTabs: true, agentsRenderInBackground: true };
const off = { preloadBackgroundTabs: false, agentsRenderInBackground: false };
const tab = (patch: Partial<NewTabPaint>): NewTabPaint => ({ activate: false, lazy: false, agent: false, preload: false, ...patch });

describe("which new tabs paint while not on screen", () => {
  it("a tab the person opens in the background paints until it has loaded", () => {
    expect(newTabPaint(tab({ preload: true }), on)).toBe("preload");
  });

  it("an agent's tab keeps painting", () => {
    expect(newTabPaint(tab({ agent: true }), on)).toBe("agent");
    expect(newTabPaint(tab({ agent: true, preload: true }), on)).toBe("agent");
  });

  it("tabs opened in front, restored tabs and tabs from other devices paint only when shown", () => {
    expect(newTabPaint(tab({ activate: true, preload: true }), on)).toBeNull();
    expect(newTabPaint(tab({ activate: true, agent: true }), on)).toBeNull();
    expect(newTabPaint(tab({ lazy: true, preload: true }), on)).toBeNull();
    expect(newTabPaint(tab({}), on)).toBeNull();
  });

  it("the settings turned off bring back the old behaviour", () => {
    expect(newTabPaint(tab({ preload: true }), off)).toBeNull();
    expect(newTabPaint(tab({ agent: true }), off)).toBeNull();
    expect(newTabPaint(tab({ preload: true }), { ...on, agentsRenderInBackground: false })).toBe("preload");
    expect(newTabPaint(tab({ agent: true }), { ...on, preloadBackgroundTabs: false })).toBe("agent");
  });

  it("both settings are on by default", () => {
    const s = defaultSettings();
    expect(s.memory.preloadBackgroundTabs).toBe(true);
    expect(s.agent.renderInBackground).toBe(true);
    const merged = mergeSettings(s, { memory: { preloadBackgroundTabs: false }, agent: { renderInBackground: false } });
    expect(merged.memory.preloadBackgroundTabs).toBe(false);
    expect(merged.agent.renderInBackground).toBe(false);
  });
});

describe("Open all in tabs", () => {
  it("loads the first tabs at once and the rest when first shown", () => {
    const plan = openAllPlan(8, true);
    expect(plan.filter(Boolean)).toHaveLength(OPEN_ALL_LOAD_NOW);
    expect(plan.slice(0, OPEN_ALL_LOAD_NOW).every(Boolean)).toBe(true);
    expect(plan.slice(OPEN_ALL_LOAD_NOW).some(Boolean)).toBe(false);
    expect(openAllPlan(3, true)).toEqual([true, true, true]);
    expect(openAllPlan(0, true)).toEqual([]);
  });

  it("loads every tab at once, as before, with the setting off", () => {
    expect(openAllPlan(8, false).every(Boolean)).toBe(true);
  });
});

describe("agent tabs painting in the background", () => {
  it("are capped, lower when memory is low", () => {
    expect(agentRenderCap(0.5)).toBe(AGENT_RENDER_CAP);
    expect(agentRenderCap(0.05)).toBe(AGENT_RENDER_CAP_LOW_MEMORY);
    expect(AGENT_RENDER_CAP_LOW_MEMORY).toBeLessThan(AGENT_RENDER_CAP);
  });

  it("stop painting least recently used first", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, usedAt: 1000 + i }));
    expect(tabsToStopRendering(entries, 8).sort()).toEqual(["t0", "t1"]);
    expect(tabsToStopRendering(entries, 2).sort()).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
    expect(tabsToStopRendering(entries.slice(0, 8), 8)).toEqual([]);
    expect(tabsToStopRendering(entries, 0)).toHaveLength(10);
  });

  it("a tab used again moves to the front", () => {
    const entries = [
      { id: "a", usedAt: 1 },
      { id: "b", usedAt: 2 },
      { id: "c", usedAt: 3 },
    ];
    expect(tabsToStopRendering(entries, 2)).toEqual(["a"]);
    expect(tabsToStopRendering([{ id: "a", usedAt: 4 }, ...entries.slice(1)], 2)).toEqual(["b"]);
  });
});

describe("waiting for a page to paint", () => {
  it("waits for frames and for the images in view", async () => {
    let frames = 0;
    const images = [
      { complete: false, getBoundingClientRect: () => ({ width: 10, height: 10, top: 10, left: 10, bottom: 20, right: 20 }) },
      { complete: false, getBoundingClientRect: () => ({ width: 10, height: 10, top: 5000, left: 10, bottom: 5010, right: 20 }) },
    ];
    setTimeout(() => (images[0]!.complete = true), 120);
    const started = Date.now();
    const done = await runInNewContext(paintedScript(2000), {
      requestAnimationFrame: (cb: () => void) => setTimeout(() => (frames++, cb()), 5),
      document: { images },
      innerWidth: 800,
      innerHeight: 600,
      setTimeout,
      Date,
      Promise,
    });
    expect(done).toBe(true);
    expect(frames).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("gives up on images after the wait", async () => {
    const images = [{ complete: false, getBoundingClientRect: () => ({ width: 10, height: 10, top: 10, left: 10, bottom: 20, right: 20 }) }];
    const started = Date.now();
    await runInNewContext(paintedScript(150), { requestAnimationFrame: (cb: () => void) => setTimeout(cb, 1), document: { images }, innerWidth: 800, innerHeight: 600, setTimeout, Date, Promise });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
