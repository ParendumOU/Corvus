import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetch = vi.fn(async () => {
  throw new Error("offline");
});
vi.mock("electron", () => ({ net: { fetch }, utilityProcess: {} }));

const { FilterSet } = await import("../src/main/adblock-lists");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FilterSet", () => {
  it("keeps one retry pending however many checks fail while offline", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spec = { set: "test", lists: ["easylist"], fallback: "||ads.example^", engineFile: "e.bin", metaFile: "m.json" };
    const set = new FilterSet(path.join(os.tmpdir(), "corvus-no-adblock-cache"), spec, () => undefined);
    for (let i = 0; i < 4; i++) await set.refresh(false);
    expect(fetch).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });
});
