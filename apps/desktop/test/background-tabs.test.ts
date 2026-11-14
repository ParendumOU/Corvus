import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  AGENT_RENDER_CAP,
  AGENT_RENDER_CAP_LOW_MEMORY,
  OPEN_ALL_LOAD_NOW,
  agentRenderCap,
  holdsMedia,
  newTabPaint,
  openAllPlan,
  paintedScript,
  tabsToStopRendering,
  type NewTab,
} from "../src/shared/background-tabs";
import { defaultSettings, mergeSettings } from "../src/shared/settings";

const tab = (patch: Partial<NewTab>): NewTab => ({ activate: false, lazy: false, agent: false, byPerson: false, ...patch });

describe("which new tabs hold their media until first shown", () => {
  it("a tab the person opens in the background loads but holds its media", () => {
    expect(holdsMedia(tab({ byPerson: true }))).toBe(true);
  });

  it("an agent's tab plays as any page, even opened from a page the person uses", () => {
    expect(holdsMedia(tab({ agent: true }))).toBe(false);
    expect(holdsMedia(tab({ agent: true, byPerson: true }))).toBe(false);
  });

  it("a tab in front, a tab that loads only when shown and an extension's tab hold nothing", () => {
    expect(holdsMedia(tab({ activate: true, byPerson: true }))).toBe(false);
    expect(holdsMedia(tab({ lazy: true, byPerson: true }))).toBe(false);
    expect(holdsMedia(tab({}))).toBe(false);
  });
});

describe("which new tabs paint while not on screen", () => {
  it("an agent's background tab keeps painting while agents render in the background", () => {
    expect(newTabPaint(tab({ agent: true }), true)).toBe("agent");
    expect(newTabPaint(tab({ agent: true, byPerson: true }), true)).toBe("agent");
    expect(newTabPaint(tab({ agent: true }), false)).toBeNull();
  });

  it("the person's background tabs stay throttled: they paint only when shown", () => {
    expect(newTabPaint(tab({ byPerson: true }), true)).toBeNull();
    expect(newTabPaint(tab({ activate: true, agent: true }), true)).toBeNull();
    expect(newTabPaint(tab({ lazy: true, agent: true }), true)).toBeNull();
    expect(newTabPaint(tab({}), true)).toBeNull();
  });

  it("agents render in the background by default", () => {
    expect(defaultSettings().agent.renderInBackground).toBe(true);
    expect(mergeSettings(defaultSettings(), { agent: { renderInBackground: false } }).agent.renderInBackground).toBe(false);
  });

  it("saved settings that still carry an old background tab key load without it", () => {
    for (const key of ["loadBackgroundTabs", "preloadBackgroundTabs"]) {
      const merged = mergeSettings(defaultSettings(), { memory: { [key]: true, sleepAfterMinutes: 30 } });
      expect(merged.memory).toEqual({ sleepTabs: true, sleepAfterMinutes: 30 });
    }
  });
});

describe("Open all in tabs", () => {
  it("loads the first tabs at once and the rest when first shown", () => {
    const plan = openAllPlan(8);
    expect(plan.filter(Boolean)).toHaveLength(OPEN_ALL_LOAD_NOW);
    expect(plan.slice(0, OPEN_ALL_LOAD_NOW).every(Boolean)).toBe(true);
    expect(plan.slice(OPEN_ALL_LOAD_NOW).some(Boolean)).toBe(false);
    expect(openAllPlan(3)).toEqual([true, true, true]);
    expect(openAllPlan(0)).toEqual([]);
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
