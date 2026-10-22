import { describe, expect, it } from "vitest";
import type { SearchEvent } from "@corvus/shared";
import { createSearchEngine } from "../src/engine.js";
import { createSearxngRetriever } from "../src/retrievers/searxng.js";

// Live test against the SearXNG container: `CORVUS_IT=1 pnpm --filter @corvus/ai-engine test`
// from `docker compose run --rm dev` after `docker compose up -d searxng`.
const enabled = process.env.CORVUS_IT === "1";
const searxngUrl = process.env.CORVUS_SEARXNG_URL ?? "http://searxng:8080";

describe.skipIf(!enabled)("integration: live SearXNG", () => {
  it("retrieves real results", async () => {
    const retriever = createSearxngRetriever(searxngUrl, { timeoutMs: 15_000 });
    const results = await retriever.search("rust programming language", { lang: "en", maxResults: 8 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.source).not.toBe("");
    }
    expect(new Set(results.map((r) => r.url)).size).toBe(results.length);
  }, 30_000);

  it("runs the engine end to end in results-only mode", async () => {
    const engine = createSearchEngine({ provider: "anthropic-api", retriever: "searxng", searxngUrl }, { provider: null });
    const events: SearchEvent[] = [];
    for await (const ev of engine.search("wie funktioniert eine wärmepumpe")) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["results"]);
    const first = events[0];
    expect(first?.type === "results" && first.results.length).toBeTruthy();
  }, 30_000);
});
