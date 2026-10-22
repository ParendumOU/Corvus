import { describe, expect, it, vi } from "vitest";
import { RateLimiter, clampRate, expandPayloadSet, planRequests, runFuzz, processPayload, fuzzResultsToCsv, FuzzLimitError, FuzzScopeError } from "../src/fuzzer.js";
import type { FuzzerConfig, OutboundRequest } from "../src/types.js";

const template: OutboundRequest = { method: "GET", url: "https://example.com/u/§id§?x=§y§", headers: [] };

function config(partial: Partial<FuzzerConfig> = {}): FuzzerConfig {
  return {
    template,
    attack: "sniper",
    payloadSets: [{ kind: "wordlist", values: ["a", "b"] }],
    concurrency: 4,
    requestsPerSecond: 1000,
    ...partial,
  };
}

describe("payload expansion", () => {
  it("expands wordlist, numbers and charset", () => {
    expect(expandPayloadSet({ kind: "wordlist", values: ["x", "y"] })).toEqual(["x", "y"]);
    expect(expandPayloadSet({ kind: "numbers", from: 1, to: 5, step: 2 })).toEqual(["1", "3", "5"]);
    expect(expandPayloadSet({ kind: "charset", charset: "ab" })).toEqual(["a", "b"]);
  });
});

describe("planRequests", () => {
  it("sniper varies one position at a time", () => {
    const planned = planRequests(config());
    // 2 positions * 2 payloads
    expect(planned).toHaveLength(4);
    expect(planned[0]!.request.url).toBe("https://example.com/u/a?x=y");
    expect(planned[2]!.request.url).toBe("https://example.com/u/id?x=a");
  });
  it("cluster-bomb is the cartesian product", () => {
    const planned = planRequests(
      config({ attack: "cluster-bomb", payloadSets: [{ kind: "wordlist", values: ["1", "2"] }, { kind: "wordlist", values: ["x", "y"] }] }),
    );
    expect(planned).toHaveLength(4);
    expect(planned.map((p) => p.request.url)).toContain("https://example.com/u/1?x=x");
    expect(planned.map((p) => p.request.url)).toContain("https://example.com/u/2?x=y");
  });
});

describe("RateLimiter", () => {
  it("spaces acquisitions by the interval", async () => {
    let clock = 0;
    const slept: number[] = [];
    const limiter = new RateLimiter(
      10,
      async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      () => clock,
    );
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    // First acquire is free; each later one waits one 100ms interval.
    expect(slept).toEqual([100, 100]);
  });
  it("clampRate enforces the ceiling and a sane default", () => {
    expect(clampRate(99999)).toBe(50);
    expect(clampRate(0)).toBe(5);
    expect(clampRate(-3)).toBe(5);
  });
});

describe("runFuzz", () => {
  it("refuses out-of-scope targets", async () => {
    await expect(runFuzz(config(), { send: vi.fn(), inScope: () => false })).rejects.toBeInstanceOf(FuzzScopeError);
  });
  it("refuses attacks over the request cap", async () => {
    await expect(
      runFuzz(config({ maxRequests: 2 }), { send: vi.fn(), inScope: () => true }),
    ).rejects.toBeInstanceOf(FuzzLimitError);
  });
  it("sends in-scope requests and greps responses", async () => {
    const send = vi.fn(async (req: OutboundRequest) => ({ status: 200, length: 10, durationMs: 1, body: req.url.includes("a") ? "FOUND" : "" }));
    const { rows, summary } = await runFuzz(config({ grep: ["FOUND"] }), { send, inScope: () => true });
    expect(summary.total).toBe(4);
    expect(summary.completed).toBe(4);
    expect(rows.filter((r) => r.matched.includes("FOUND")).length).toBeGreaterThan(0);
  });
  it("marks individual out-of-scope generated requests without sending them", async () => {
    const send = vi.fn(async () => ({ status: 200, length: 1, durationMs: 1 }));
    const inScope = (url: string) => !url.includes("/u/b");
    const { rows } = await runFuzz(config(), { send, inScope });
    expect(rows.some((r) => r.error === "out of scope")).toBe(true);
  });
});

describe("pitchfork + payload processing + extract", () => {
  it("pitchfork steps sets in lockstep (shortest bounds)", () => {
    const planned = planRequests(
      config({
        attack: "pitchfork",
        payloadSets: [
          { kind: "wordlist", values: ["a", "b", "c"] },
          { kind: "wordlist", values: ["1", "2"] },
        ],
      }),
    );
    expect(planned.map((p) => p.payloads)).toEqual([["a", "1"], ["b", "2"]]);
  });

  it("applies payload processing rules in order", () => {
    expect(processPayload("x", [{ kind: "prefix", text: "<" }, { kind: "suffix", text: ">" }])).toBe("<x>");
    expect(processPayload("a b", [{ kind: "url-encode" }])).toBe("a%20b");
    expect(processPayload("abc", [{ kind: "upper" }])).toBe("ABC");
    expect(processPayload("x", [{ kind: "hash-sha256" }])).toHaveLength(64);
    const planned = planRequests(config({ payloadSets: [{ kind: "wordlist", values: ["v"] }], payloadRules: [{ kind: "prefix", text: "p-" }] }));
    expect(planned[0]!.payloads[0]).toBe("p-v");
  });

  it("extracts a capture group from the response body", async () => {
    const { rows } = await runFuzz(config({ extract: ["token=(\\w+)"] }), {
      inScope: () => true,
      send: async () => ({ status: 200, length: 10, durationMs: 1, body: "token=SECRET42;" }),
    });
    expect(rows.every((r) => r.extracted?.[0] === "SECRET42")).toBe(true);
  });

  it("renders results as CSV with escaping", () => {
    const csv = fuzzResultsToCsv([
      { index: 0, payloads: ["a,b"], status: 200, length: 5, durationMs: 3, matched: ["hit"], extracted: ["x"] },
      { index: 1, payloads: ["c"], status: null, length: 0, durationMs: null, matched: [], error: "boom" },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("index,payloads,status,length,durationMs,matched,extracted,error");
    expect(lines[1]).toContain('"a,b"');
    expect(lines[2]).toContain("boom");
  });
});
