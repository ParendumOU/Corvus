import { describe, expect, it } from "vitest";
import { type MergedItem, mergeStreams } from "../src/merge.js";

async function* timed(items: Array<[number, string]>, fail?: string): AsyncGenerator<string> {
  for (const [ms, value] of items) {
    await new Promise((r) => setTimeout(r, ms));
    yield value;
  }
  if (fail) throw new Error(fail);
}

async function collect<K, T>(iter: AsyncIterable<MergedItem<K, T>>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of iter) {
    if ("value" in item) out.push(`${String(item.key)}:${String(item.value)}`);
    else if ("done" in item) out.push(`${String(item.key)}:done`);
    else out.push(`${String(item.key)}:error ${(item.error as Error).message}`);
  }
  return out;
}

describe("mergeStreams", () => {
  it("yields items as they come, tagged, and says when each stream ends", async () => {
    const merged = mergeStreams([
      ["a", timed([[5, "a1"], [40, "a2"]])],
      ["b", timed([[20, "b1"]])],
    ]);
    expect(await collect(merged)).toEqual(["a:a1", "b:b1", "b:done", "a:a2", "a:done"]);
  });

  it("keeps reading the other streams when one throws", async () => {
    const merged = mergeStreams([
      ["a", timed([[5, "a1"]], "boom")],
      ["b", timed([[30, "b1"]])],
    ]);
    expect(await collect(merged)).toEqual(["a:a1", "a:error boom", "b:b1", "b:done"]);
  });

  it("closes the open streams when the reader stops early", async () => {
    let closed = false;
    async function* endless(): AsyncGenerator<number> {
      try {
        for (let i = 0; ; i++) {
          await new Promise((r) => setTimeout(r, 5));
          yield i;
        }
      } finally {
        closed = true;
      }
    }
    for await (const item of mergeStreams([["n", endless()]])) {
      if ("value" in item && item.value === 2) break;
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
  });
});
