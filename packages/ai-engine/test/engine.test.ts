import { describe, expect, it } from "vitest";
import type { AiEngineConfig, SearchEvent, SearchResult } from "@corvus/shared";
import { SearchCache } from "../src/cache.js";
import { createSearchEngine, DEFAULT_ANSWER_TOKENS, DEFAULT_MAX_RESULTS, ratingTokens } from "../src/engine.js";
import { ANSWER_SYSTEM_PROMPT } from "../src/prompt.js";
import type { AnswerProvider, AnswerRequest, PreparedCall } from "../src/providers/types.js";
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

const isAnswer = (req: AnswerRequest): boolean => req.prompt.system === ANSWER_SYSTEM_PROMPT;
const answerCalls = (seen: AnswerRequest[]): AnswerRequest[] => seen.filter(isAnswer);

/**
 * A provider that writes `reply` for the answer call (a list) or each call's own reply, and fails
 * the answer call before chunk `failAfter`.
 */
function provider(reply: string[] | { answer?: string[]; rating?: string[] }, seen: AnswerRequest[] = [], failAfter?: number): AnswerProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *answer(req) {
      seen.push(req);
      const chunks = Array.isArray(reply) ? (isAnswer(req) ? reply : []) : ((isAnswer(req) ? reply.answer : reply.rating) ?? []);
      for (const [i, text] of chunks.entries()) {
        if (failAfter === i && isAnswer(req)) throw new Error("overloaded_error");
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
  it("emits results, deltas, answer-done, answer-complete, usage of both calls in order", async () => {
    const seen: AnswerRequest[] = [];
    const engine = createSearchEngine(
      { ...config, maxOutputTokens: 256 },
      { retrievers: [retriever()], provider: provider(["Alpha [1]", " and gamma [3]."], seen) },
    );
    const events = await collect(engine.search("what is alpha"));
    expect(events.map((e) => e.type)).toEqual(["results", "answer-delta", "answer-delta", "answer-done", "answer-complete", "insights", "usage"]);
    expect(events[0]).toMatchObject({ type: "results", retriever: "searxng", cached: false });
    expect(events[3]).toEqual({ type: "answer-done", text: "Alpha [1] and gamma [3].", citations: [0, 2] });
    expect(events[6]).toEqual({ type: "usage", inputTokens: 642, outputTokens: 24, model: "claude-haiku-5-5" });
    expect(seen).toHaveLength(2);
    expect(answerCalls(seen)[0]!.maxOutputTokens).toBe(256);
    expect(seen.find((r) => !isAnswer(r))!.maxOutputTokens).toBe(ratingTokens(DEFAULT_MAX_RESULTS));
    for (const req of seen) expect(req.prompt.user).toContain("lang: en");
  });

  it("shows the answer part as soon as it is complete, while the ratings are still written", async () => {
    let ratingsWritten = false;
    const slowRatings: AnswerProvider = {
      kind: "anthropic-api",
      model: "m",
      async *answer(req) {
        if (!isAnswer(req)) {
          await new Promise((r) => setTimeout(r, 40));
          ratingsWritten = true;
          yield { type: "delta", text: "R: 1|9|docs|Alpha home\nR: 2|3|forum|Beta thread\n" };
        } else {
          yield { type: "delta", text: "Alpha [1].\nP: alpha point [1]\nC: high\n" };
        }
        yield { type: "usage", inputTokens: 1, outputTokens: 1, model: "m" };
      },
    };
    const seen: Array<{ type: string; ratingsWritten: boolean }> = [];
    for await (const ev of createSearchEngine(config, { retrievers: [retriever()], provider: slowRatings }).search("alpha")) {
      seen.push({ type: ev.type, ratingsWritten });
    }
    const complete = seen.findIndex((e) => e.type === "answer-complete");
    expect(seen[complete]!.ratingsWritten).toBe(false);
    expect(seen.slice(0, complete).map((e) => e.type)).toEqual(["results", "answer-delta", "answer-done", "key-point", "confidence"]);
    expect(seen.findIndex((e) => e.type === "rating")).toBeGreaterThan(complete);
    expect(seen.at(-1)?.type).toBe("usage");
  });

  it("starts prepared calls with the search and releases them without a request when there is nothing to answer", async () => {
    const prepared: PreparedCall[] = [];
    let made = 0;
    let searched = false;
    const cli: AnswerProvider = {
      kind: "claude-code-cli",
      model: "m",
      answer: () => {
        throw new Error("a prepared provider is only called through prepare");
      },
      prepare(call) {
        expect(searched).toBe(false);
        prepared.push(call);
        return {
          async *answer() {
            made++;
            yield { type: "usage", inputTokens: 0, outputTokens: 0, model: "m" };
          },
        };
      },
    };
    const empty: Retriever = {
      kind: "searxng",
      async search() {
        searched = true;
        return [];
      },
    };
    const events = await collect(createSearchEngine(config, { retrievers: [empty], provider: cli }).search("q"));
    expect(events.map((e) => e.type)).toEqual(["results", "error"]);
    expect(prepared.map((c) => c.system === ANSWER_SYSTEM_PROMPT)).toEqual([true, false]);
    expect(prepared.every((c) => c.signal?.aborted)).toBe(true);
    expect(made).toBe(0);

    searched = false;
    const answered = await collect(createSearchEngine(config, { retrievers: [retriever()], provider: cli }).search("q"));
    expect(answered.at(-1)?.type).toBe("usage");
    expect(made).toBe(2);
  });

  it("says whether general searches stream an answer", () => {
    expect(createSearchEngine(config, { retrievers: [retriever()], provider: provider([]) }).answers).toBe(true);
    expect(createSearchEngine(config, { retrievers: [retriever()], provider: null }).answers).toBe(false);
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

  it("caps the answer at the answer length, gives the ratings room per source, and passes the resolved language to the retriever", async () => {
    const seen: AnswerRequest[] = [];
    const calls = { n: 0 } as { n: number; lang?: string };
    const engine = createSearchEngine(config, { retrievers: [retriever(RESULTS, calls)], provider: provider(["ok"], seen) });
    await collect(engine.search("como hacer una tortilla de patatas"));
    expect(answerCalls(seen)[0]!.maxOutputTokens).toBe(DEFAULT_ANSWER_TOKENS);
    // A rating line per source plus entity, facts and follow-ups: ~500-700 tokens for 8 sources.
    expect(ratingTokens(8)).toBeGreaterThanOrEqual(650);
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
    expect(events.map((e) => e.type)).toEqual(["results", "answer-delta", "error", "answer-done", "answer-complete", "insights", "usage"]);
    expect(events[2]).toEqual({ type: "error", message: "overloaded_error", recoverable: true });
  });

  it("keeps the answer when the rating call fails, and does not cache it", async () => {
    const calls = { n: 0 };
    const ratingFails: AnswerProvider = {
      kind: "anthropic-api",
      model: "m",
      async *answer(req) {
        if (!isAnswer(req)) throw new Error("rate_limit_error");
        yield { type: "delta", text: "Alpha [1]." };
      },
    };
    const engine = createSearchEngine(config, { retrievers: [retriever(RESULTS, calls)], provider: ratingFails, cache: new SearchCache() });
    const events = await collect(engine.search("q"));
    expect(events).toContainEqual({ type: "error", message: "rate_limit_error", recoverable: true });
    expect(events.find((e) => e.type === "insights")).toMatchObject({ insights: { answer: "Alpha [1].", ratings: [] } });
    await collect(engine.search("q"));
    expect(calls.n).toBe(2);
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
      // Deep mode must not reach the network for the test's made-up result pages.
      deepFetch: async () => [],
    });
    await collect(engine.search("What is alpha"));
    const replay = await collect(engine.search("  what IS alpha "));
    expect(calls.n).toBe(1);
    expect(seen).toHaveLength(2);
    expect(replay).toEqual([
      { type: "results", results: RESULTS, retriever: "searxng", cached: true, category: "general" },
      { type: "answer-delta", text: "Alpha [1]." },
      { type: "answer-done", text: "Alpha [1].", citations: [0] },
      { type: "answer-complete" },
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
    const deep = seen.slice(2);
    expect(answerCalls(deep)[0]!.prompt.user).toContain("[2] B (b.example)\nbeta\nPage: Full text of page B");
    expect(deep.find((r) => !isAnswer(r))!.prompt.user).not.toContain("Page: ");
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

  it("streams each call's structured output as typed events in order and caches it", async () => {
    const chunked = (lines: string[]) => lines.join("\n").match(/[\s\S]{1,5}/g)!;
    const answer = chunked(["Gamma is best [3], alpha helps [1].", "P: gamma point [3]", "C: medium", "D: alpha and gamma differ on dates"]);
    // Stray lines of the other call's kind are dropped.
    const rating = chunked(["R: 1|6|docs|Alpha page", "R: 2|2|forum,outdated|Old beta thread", "R: 3|9|official|Gamma home", "Q: more gamma", "P: not a rating"]);
    const calls = { n: 0 };
    const engine = createSearchEngine(config, { retrievers: [retriever(RESULTS, calls)], provider: provider({ answer, rating }), cache: new SearchCache() });
    const events = await collect(engine.search("gamma"));
    const order = (kinds: string[]) =>
      events
        .map((e) => e.type)
        .filter((t) => kinds.includes(t))
        .filter((t, i, all) => t !== all[i - 1]);
    expect(order(["answer-delta", "answer-done", "key-point", "confidence", "answer-complete"])).toEqual([
      "answer-delta",
      "answer-done",
      "key-point",
      "confidence",
      "answer-complete",
    ]);
    expect(order(["rating", "rerank", "follow-up"])).toEqual(["rating", "rerank", "follow-up"]);
    expect(events.filter((e) => e.type === "key-point")).toHaveLength(1);
    expect(events.map((e) => e.type).slice(-2)).toEqual(["insights", "usage"]);
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
    // A replay comes answer part first, with the same events as the live search.
    const skip = ["answer-delta", "results", "usage"];
    const live = events.filter((e) => !skip.includes(e.type));
    const cached = replay.filter((e) => !skip.includes(e.type));
    expect(cached.map((e) => e.type)).toEqual(["answer-done", "key-point", "confidence", "answer-complete", "rating", "rating", "rating", "rerank", "follow-up", "insights"]);
    expect([...cached].sort((a, b) => a.type.localeCompare(b.type))).toEqual([...live].sort((a, b) => a.type.localeCompare(b.type)));
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
    expect(answerCalls(seen)).toHaveLength(2);
    expect(seen[0]!.prompt.user).not.toContain("<conversation>");
  });
});
