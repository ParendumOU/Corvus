import { describe, expect, it } from "vitest";
import { smokeShard, stepDeadlineMs } from "../src/main/smoke-shard";

const steps = ["a", "b", "c", "d", "e", "f"];
const seconds: Record<string, number> = { a: 50, b: 10, c: 40, d: 10, e: 30, f: 20 };
const weight = (s: string): number | undefined => seconds[s];

describe("smoke shards", () => {
  it("runs everything without a spec", () => {
    expect(smokeShard(steps, weight, undefined)).toEqual(steps);
  });

  it("gives every step to exactly one share, in the original order", () => {
    const shares = [1, 2, 3].map((k) => smokeShard(steps, weight, `${k}/3`));
    expect(shares.flat().sort()).toEqual([...steps].sort());
    for (const share of shares) expect(share).toEqual(steps.filter((s) => share.includes(s)));
  });

  it("evens out the shares' length", () => {
    const totals = [1, 2].map((k) => smokeShard(steps, weight, `${k}/2`).reduce((sum, s) => sum + seconds[s]!, 0));
    expect(Math.abs(totals[0]! - totals[1]!)).toBeLessThanOrEqual(10);
  });

  it("counts an unknown step as an average one", () => {
    expect(smokeShard(["x", "y"], () => undefined, "2/2")).toEqual(["y"]);
  });

  it("gives a hung step minutes, a long one four times its usual time", () => {
    expect(stepDeadlineMs("no-such-step")).toBe(180_000);
    expect(stepDeadlineMs("credentials")).toBeGreaterThan(180_000);
  });

  it("refuses a bad spec", () => {
    expect(() => smokeShard(steps, weight, "4/3")).toThrow();
    expect(() => smokeShard(steps, weight, "two")).toThrow();
  });
});
