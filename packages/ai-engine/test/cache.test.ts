import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CachedAnswer, cacheKey, normalizeQuery, SearchCache } from "../src/cache.js";

const value: CachedAnswer = {
  results: [{ url: "https://a.example/", title: "A", snippet: "s", source: "a.example", rank: 1 }],
  retriever: "searxng",
  answer: { text: "Answer [1]", citations: [0], model: "claude-haiku-5-5" },
};

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "corvus-cache-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("cache key", () => {
  it("normalizes case and whitespace but separates lang/depth/retriever", () => {
    const base = { query: "Rust  Async ", lang: "en", depth: "quick", retriever: "searxng", maxResults: 8 } as const;
    expect(cacheKey(base)).toBe(cacheKey({ ...base, query: "rust async" }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, lang: "es" }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, depth: "deep" }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, retriever: "brave" }));
    expect(normalizeQuery("  ＲＵＳＴ\tlang ")).toBe("rust lang");
  });
});

describe("SearchCache", () => {
  it("expires entries after the TTL", async () => {
    let now = 1_000;
    const cache = new SearchCache({ ttlMs: 100, now: () => now });
    await cache.set("k", value);
    expect(await cache.get("k")).toEqual(value);
    now += 101;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("evicts the least recently used entry", async () => {
    const cache = new SearchCache({ maxEntries: 2 });
    await cache.set("a", value);
    await cache.set("b", value);
    await cache.get("a");
    await cache.set("c", value);
    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toBeDefined();
  });

  it("persists to disk and survives a new instance", async () => {
    const dir = join(await tempDir(), "nested");
    await new SearchCache({ dir }).set("persist", value);
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect(await new SearchCache({ dir }).get("persist")).toEqual(value);
  });

  it("drops expired disk entries", async () => {
    const dir = await tempDir();
    let now = 0;
    await new SearchCache({ dir, ttlMs: 10, now: () => now }).set("old", value);
    now = 50;
    expect(await new SearchCache({ dir, ttlMs: 10, now: () => now }).get("old")).toBeUndefined();
    expect(await readdir(dir)).toHaveLength(0);
  });
});
