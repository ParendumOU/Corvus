import { describe, expect, it } from "vitest";
import type { AiEngineConfig, SearchEvent, SearchResult } from "@corvus/shared";
import { SearchCache } from "../src/cache.js";
import { createSearchEngine } from "../src/engine.js";
import type { AnswerProvider, AnswerRequest } from "../src/providers/types.js";
import type { Retriever } from "../src/retrievers/types.js";

const config: AiEngineConfig = { provider: "anthropic-api", retriever: "searxng", uiLocale: "en-US" };

const RESULTS: SearchResult[] = [
  { url: "https://a.example/", title: "A", snippet: "alpha", source: "a.example", rank: 1 },
  { url: "https://b.example/", title: "B", snippet: "beta", source: "b.example", rank: 2 },
  { url: "https://c.example/", title: "C", snippet: "gamma", source: "c.example", rank: 3 },
];

function retriever(results = RESULTS, calls: { n: number; lang?: string } = { n: 0 }): Retriever {
  return {
    kind: "searxng",
    async search(_q, opts) {
      calls.n++;
      calls.lang = opts.lang;
      return results.slice(0, opts.maxResults);
    },
  };
}

function provider(chunks: string[], seen: AnswerRequest[] = [], failAfter?: number): AnswerProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *answer(req) {
      seen.push(req);
      for (const [i, text] of chunks.entries()) {
        if (failAfter === i) throw new Error("overloaded_error");
        yield { type: "delta", text };
      }
      yield { type: "usage", inputTokens: 321, outputTokens: 12, model: "claude-haiku-5-5" };
    },
  };
}

async function collect(iter: AsyncIterable<SearchEvent>): Promise<SearchEvent[]> {
  const out: SearchEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe("createSearchEngine", () => {
  it("emits results, deltas, answer-done, usage in order", async () => {
    const seen: AnswerRequest[] = [];
    const engine = createSearchEngine(
      { ...config, maxOutputTokens: 256 },
      { retrievers: [retriever()], provider: provider(["Alpha [1]", " and gamma [3]."], seen) },
    );
    const events = await collect(engine.search("what is alpha"));
    expect(events.map((e) => e.type)).toEqual(["results", "answer-delta", "answer-delta", "answer-done", "insights", "usage"]);
    expect(events[0]).toMatchObject({ type: "results", retriever: "searxng", cached: false });
    expect(events[3]).toEqual({ type: "answer-done", text: "Alpha [1] and gamma [3].", citations: [0, 2] });
    expect(events[5]).toEqual({ type: "usage", inputTokens: 321, outputTokens: 12, model: "claude-haiku-5-5" });
    expect(seen[0]!.maxOutputTokens).toBe(256);
    expect(seen[0]!.prompt.user).toContain("lang: en");
  });

  it("emits results before the provider is even called", async () => {
    let providerStarted = false;
    const slow: AnswerProvider = {
      kind: "anthropic-api",
      model: "m",
      async *answer() {
        providerStarted = true;
        yield { type: "delta", text: "x" };
      },
    };
    const iter = createSearchEngine(config, { retrievers: [retriever()], provider: slow }).search("q")[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value?.type).toBe("results");
    expect(providerStarted).toBe(false);
    await iter.return?.();
  });

  it("defaults max_tokens to 700 and passes the resolved language to the retriever", async () => {
    const seen: AnswerRequest[] = [];
    const calls = { n: 0 } as { n: number; lang?: string };
    const engine = createSearchEngine(config, { retrievers: [retriever(RESULTS, calls)], provider: provider(["ok"], seen) });
    await collect(engine.search("como hacer una tortilla de patatas"));
    expect(seen[0]!.maxOutputTokens).toBe(700);
    expect(calls.lang).toBe("es");
    await collect(engine.search("rust async", { lang: "de" }));
    expect(calls.lang).toBe("de");
  });

  it("returns results only when no provider is configured", async () => {
    const engine = createSearchEngine(config, { retrievers: [retriever()] });
    const events = await collect(engine.search("q"));
    expect(events.map((e) => e.type)).toEqual(["results"]);
  });

  it("reports provider failures as recoverable errors after results", async () => {
    const engine = createSearchEngine(config, { retrievers: [retriever()], provider: provider(["partial", "more"], [], 1) });
    const events = await collect(engine.search("q"));
    expect(events.map((e) => e.type)).toEqual(["results", "answer-delta", "error"]);
    expect(events[2]).toEqual({ type: "error", message: "overloaded_error", recoverable: true });
  });

  it("reports retrieval failure as a fatal error", async () => {
    const broken: Retriever = {
      kind: "searxng",
      async search() {
        throw new Error("ECONNREFUSED");
      },
    };
    const events = await collect(createSearchEngine(config, { retrievers: [broken], provider: provider(["x"]) }).search("q"));
    expect(events).toEqual([
      { type: "error", message: "All retrievers failed (searxng: ECONNREFUSED)", recoverable: false },
    ]);
  });

  it("rejects empty queries", async () => {
    const events = await collect(createSearchEngine(config, { retrievers: [retriever()] }).search("   "));
    expect(events).toEqual([{ type: "error", message: "Empty query", recoverable: false }]);
  });

  it("replays cached answers with cached: true and zero usage", async () => {
    const calls = { n: 0 };
    const seen: AnswerRequest[] = [];
    const engine = createSearchEngine(config, {
      retrievers: [retriever(RESULTS, calls)],
      provider: provider(["Alpha [1]."], seen),
      cache: new SearchCache(),
    });
    await collect(engine.search("What is alpha"));
    const replay = await collect(engine.search("  what IS alpha "));
    expect(calls.n).toBe(1);
    expect(seen).toHaveLength(1);
    expect(replay).toEqual([
      { type: "results", results: RESULTS, retriever: "searxng", cached: true, category: "general" },
      { type: "answer-delta", text: "Alpha [1]." },
      { type: "answer-done", text: "Alpha [1].", citations: [0] },
      {
        type: "insights",
        insights: { answer: "Alpha [1].", citations: [0], keyPoints: [], ratings: [], order: [0, 1, 2], followUps: [] },
      },
      { type: "usage", inputTokens: 0, outputTokens: 0, model: "claude-haiku-5-5" },
    ]);
    await collect(engine.search("what is alpha", { depth: "deep" }));
    expect(calls.n).toBe(2);
  });

  it("does not cache failed answers", async () => {
    const calls = { n: 0 };
    const engine = createSearchEngine(config, { retrievers: [retriever(RESULTS, calls)], provider: provider(["x"], [], 0) });
    await collect(engine.search("q"));
    await collect(engine.search("q"));
    expect(calls.n).toBe(2);
  });

  it("deep mode feeds page excerpts into the prompt", async () => {
    const seen: AnswerRequest[] = [];
    let deepCalls = 0;
    const engine = createSearchEngine(config, {
      retrievers: [retriever()],
      provider: provider(["ok [2]"], seen),
      deepFetch: async (results) => {
        deepCalls++;
        expect(results).toHaveLength(3);
        return [{ index: 1, text: "Full text of page B" }];
      },
    });
    await collect(engine.search("q"));
    expect(deepCalls).toBe(0);
    const events = await collect(engine.search("q", { depth: "deep" }));
    expect(deepCalls).toBe(1);
    expect(seen[1]!.prompt.user).toContain("[2] B (b.example)\nbeta\nPage: Full text of page B");
    expect(events.find((e) => e.type === "answer-done")).toMatchObject({ citations: [1] });
  });

  it("stops quietly when aborted", async () => {
    const controller = new AbortController();
    const engine = createSearchEngine(config, {
      retrievers: [retriever()],
      provider: {
        kind: "anthropic-api",
        model: "m",
        async *answer(req) {
          yield { type: "delta", text: "abc" };
          controller.abort();
          if (req.signal?.aborted) throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
        },
      },
    });
    const events = await collect(engine.search("q", { signal: controller.signal }));
    expect(events.map((e) => e.type)).toEqual(["results", "answer-delta"]);
  });

  it("streams structured output as typed events in order and caches it", async () => {
    const reply = [
      "Gamma is best [3], alpha helps [1].",
      "P: gamma point [3]",
      "R: 1|6|docs|Alpha page",
      "R: 2|2|forum,outdated|Old beta thread",
      "R: 3|9|official|Gamma home",
      "Q: more gamma",
      "C: medium",
      "D: alpha and gamma differ on dates",
    ].join("\n");
    const chunks = reply.match(/[\s\S]{1,5}/g)!;
    const calls = { n: 0 };
    const engine = createSearchEngine(config, { retrievers: [retriever(RESULTS, calls)], provider: provider(chunks), cache: new SearchCache() });
    const events = await collect(engine.search("gamma"));
    const types = events.map((e) => e.type).filter((t, i, all) => t !== all[i - 1]);
    expect(types).toEqual([
      "results",
      "answer-delta",
      "answer-done",
      "key-point",
      "rating",
      "rerank",
      "follow-up",
      "confidence",
      "insights",
      "usage",
    ]);
    expect(events.find((e) => e.type === "answer-done")).toEqual({ type: "answer-done", text: "Gamma is best [3], alpha helps [1].", citations: [2, 0] });
    expect(events.find((e) => e.type === "rerank")).toEqual({ type: "rerank", order: [2, 0, 1] });
    expect(events.find((e) => e.type === "confidence")).toEqual({
      type: "confidence",
      level: "medium",
      sourcesDisagree: true,
      note: "alpha and gamma differ on dates",
    });
    const results = events[0]!.type === "results" ? events[0]!.results : [];
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);

    const replay = await collect(engine.search("gamma"));
    expect(calls.n).toBe(1);
    expect(replay[0]).toMatchObject({ type: "results", cached: true });
    const live = events.filter((e) => !["answer-delta", "results", "usage"].includes(e.type));
    const cached = replay.filter((e) => !["answer-delta", "results", "usage"].includes(e.type));
    expect(cached).toEqual(live);
    expect(replay.at(-1)).toEqual({ type: "usage", inputTokens: 0, outputTokens: 0, model: "claude-haiku-5-5" });
  });

  it("serves verticals from capable retrievers only, with zero tokens", async () => {
    const seen: AnswerRequest[] = [];
    const asked: Array<string | undefined> = [];
    const searx: Retriever = {
      kind: "searxng",
      categories: ["news", "images", "videos"],
      async search(_q, opts) {
        asked.push(opts.category);
        return RESULTS.slice(0, opts.maxResults).map((r) => ({ ...r, thumbnail: "https://img.example/t.jpg" }));
      },
    };
    const ddg: Retriever = {
      kind: "duckduckgo",
      async search() {
        throw new Error("must not be asked for a vertical");
      },
    };
    const engine = createSearchEngine(config, { retrievers: [ddg, searx], provider: provider(["x"], seen), cache: new SearchCache() });
    const events = await collect(engine.search("ravens", { category: "images" }));
    expect(events.map((e) => e.type)).toEqual(["results"]);
    expect(events[0]).toMatchObject({ type: "results", category: "images", retriever: "searxng", cached: false });
    expect(seen).toHaveLength(0);
    expect(asked).toEqual(["images"]);
    const again = await collect(engine.search("ravens", { category: "images" }));
    expect(again[0]).toMatchObject({ type: "results", cached: true, category: "images" });
    const news = await collect(engine.search("ravens", { category: "news" }));
    expect(news[0]).toMatchObject({ type: "results", cached: false, category: "news" });
    expect(asked).toEqual(["images", "news"]);

    const noVerticals = createSearchEngine(config, { retrievers: [ddg], provider: null });
    expect(await collect(noVerticals.search("ravens", { category: "videos" }))).toEqual([
      { type: "error", message: "Videos search needs the SearXNG backend.", recoverable: false },
    ]);
  });
});

describe("follow-up questions", () => {
  const context = [{ question: "Which viewpoints in Lisbon are best at sunset?", answer: "Senhora do Monte [1] and Santa Catarina [2]." }];

  function recording(queries: string[]): Retriever {
    return {
      kind: "searxng",
      async search(q, opts) {
        queries.push(q);
        return RESULTS.slice(0, opts.maxResults);
      },
    };
  }

  it("answers in the context of the earlier turns, and searches a short follow-up with the previous question", async () => {
    const seen: AnswerRequest[] = [];
    const queries: string[] = [];
    const engine = createSearchEngine(config, { retrievers: [recording(queries)], provider: provider(["Take tram 28 [1]."], seen) });
    await collect(engine.search("how do I get there?", { context }));
    expect(queries[0]).toBe("Which viewpoints in Lisbon are best at sunset? how do I get there?");
    expect(seen[0]!.prompt.user).toContain("<conversation>\nQ: Which viewpoints in Lisbon are best at sunset?\nA: Senhora do Monte and Santa Catarina.\n</conversation>");
    expect(seen[0]!.prompt.user).toContain("query: how do I get there?");

    await collect(engine.search("what are the opening hours of the São Jorge castle in Lisbon", { context }));
    expect(queries[1]).toBe("what are the opening hours of the São Jorge castle in Lisbon");
  });

  it("does not answer a follow-up from the answer cached for the same words asked alone", async () => {
    const seen: AnswerRequest[] = [];
    const engine = createSearchEngine(config, { retrievers: [retriever()], provider: provider(["ok"], seen), cache: new SearchCache() });
    await collect(engine.search("and in winter?"));
    await collect(engine.search("and in winter?", { context }));
    await collect(engine.search("and in winter?", { context }));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.prompt.user).not.toContain("<conversation>");
  });
});
