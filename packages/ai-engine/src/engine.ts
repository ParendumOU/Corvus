import { createHash } from "node:crypto";
import type {
  AiEngineConfig,
  SearchCategory,
  SearchEngine,
  SearchEvent,
  SearchInsights,
  SearchOptions,
  SearchResult,
} from "@corvus/shared";
import { type CachedAnswer, cacheKey, SearchCache } from "./cache.js";
import { fetchPageExtracts } from "./deep.js";
import { type FetchLike, isAbortError } from "./http.js";
import { resolveLanguage } from "./language.js";
import { mergeStreams } from "./merge.js";
import { ANSWER_SYSTEM_PROMPT, buildPrompts, type PageExtract, RATING_SYSTEM_PROMPT, retrievalQuery, type SearchPrompts } from "./prompt.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createClaudeCliProvider } from "./providers/claude-cli.js";
import { createLocalProvider } from "./providers/local.js";
import { type AnswerProvider, DEFAULT_MODEL, type ProviderEvent } from "./providers/types.js";
import { createRetrieverChain, type Retriever, retrieveWithFallback } from "./retrievers/index.js";
import { StructuredAnswerParser, type StructuredEvent } from "./structured.js";

export const DEFAULT_MAX_RESULTS = 8;
/** Output cap of the answer call (answer, key points, confidence): the "Answer length" setting. */
export const DEFAULT_ANSWER_TOKENS = 400;
const RATING_TOKENS = 60;
const TRAILER_TOKENS = 200;

/**
 * Output cap of the rating call: a line per source, then the entity, facts and follow-ups. (One
 * call capped at the answer length used to cut off the last ratings and the follow-ups.)
 */
export function ratingTokens(sourceCount: number): number {
  return RATING_TOKENS * sourceCount + TRAILER_TOKENS;
}

type Part = "answer" | "rating";
type Call = (user: string) => AsyncIterable<ProviderEvent>;

/** What each call may add to the stream; anything else it writes (a stray answer line, say) is dropped. */
const PART_EVENTS: Record<Part, ReadonlySet<StructuredEvent["type"]>> = {
  answer: new Set(["answer-delta", "answer-done", "key-point", "confidence"]),
  rating: new Set(["rating", "rerank", "entity", "follow-up"]),
};

function* keep(part: Part, events: StructuredEvent[]): Generator<SearchEvent> {
  for (const ev of events) if (PART_EVENTS[part].has(ev.type)) yield ev;
}

function combine(a: SearchInsights, r: SearchInsights): SearchInsights {
  return {
    answer: a.answer,
    citations: a.citations,
    keyPoints: a.keyPoints,
    ratings: r.ratings,
    order: r.order,
    followUps: r.followUps,
    ...(r.entity ? { entity: r.entity } : {}),
    ...(a.confidence ? { confidence: a.confidence } : {}),
    ...(a.disagreement ? { disagreement: a.disagreement } : {}),
  };
}

const VERTICAL_MAX_RESULTS: Record<SearchCategory, number> = { general: DEFAULT_MAX_RESULTS, news: 12, videos: 12, images: 30 };
const VERTICAL_CAP = 50;
const NEWS_TTL_MS = 30 * 60 * 1000;

/** Test/integration seams. Production callers only pass the config. */
export interface SearchEngineDeps {
  retrievers?: Retriever[];
  /** `null` forces results-only mode. */
  provider?: AnswerProvider | null;
  fetch?: FetchLike;
  cache?: SearchCache;
  deepFetch?: (results: SearchResult[], signal?: AbortSignal) => Promise<PageExtract[]>;
}

export function createProvider(config: AiEngineConfig): AnswerProvider | null {
  const model = config.model || DEFAULT_MODEL;
  if (config.provider === "claude-code-cli") return createClaudeCliProvider({ model, cliPath: config.claudeCliPath, env: config.claudeCliEnv });
  if (config.provider === "local") return createLocalProvider({ model, baseUrl: config.localBaseUrl, api: config.localApi });
  if (config.provider === "anthropic-api" && config.apiKey) return createAnthropicProvider({ apiKey: config.apiKey, model });
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The structured events an insights object stands for, answer part first (cache replay). */
export function* insightEvents(insights: SearchInsights): Generator<SearchEvent> {
  for (const point of insights.keyPoints) yield { type: "key-point", point };
  if (insights.confidence || insights.disagreement) {
    yield {
      type: "confidence",
      level: insights.confidence ?? null,
      sourcesDisagree: Boolean(insights.disagreement),
      ...(insights.disagreement ? { note: insights.disagreement } : {}),
    };
  }
  yield { type: "answer-complete" };
  for (const rating of insights.ratings) yield { type: "rating", rating };
  if (insights.ratings.length) yield { type: "rerank", order: insights.order };
  if (insights.entity) yield { type: "entity", entity: insights.entity };
  for (const question of insights.followUps) yield { type: "follow-up", question };
  yield { type: "insights", insights };
}

function* replay(hit: CachedAnswer, category: SearchCategory): Generator<SearchEvent> {
  yield { type: "results", results: hit.results, retriever: hit.retriever, cached: true, category };
  if (!hit.answer) return;
  if (hit.answer.text) yield { type: "answer-delta", text: hit.answer.text };
  yield { type: "answer-done", text: hit.answer.text, citations: hit.answer.citations };
  if (hit.answer.insights) yield* insightEvents(hit.answer.insights);
  yield { type: "usage", inputTokens: 0, outputTokens: 0, model: hit.answer.model };
}

export function createSearchEngine(config: AiEngineConfig, deps: SearchEngineDeps = {}): SearchEngine {
  const chain = deps.retrievers ?? createRetrieverChain(config, { fetch: deps.fetch });
  const provider = deps.provider !== undefined ? deps.provider : createProvider(config);
  const cache = deps.cache ?? new SearchCache({ dir: config.cacheDir });
  const answerTokens = config.maxOutputTokens ?? DEFAULT_ANSWER_TOKENS;
  const deepFetch =
    deps.deepFetch ?? ((results: SearchResult[], signal?: AbortSignal) => fetchPageExtracts(results, { fetch: deps.fetch, signal }));

  /** The two calls of a search, started now (a CLI process starts at once; see AnswerProvider.prepare). */
  function startCalls(ai: AnswerProvider, sourceCount: number, signal: AbortSignal): Record<Part, Call> {
    const start = (system: string, maxOutputTokens: number): Call => {
      if (ai.prepare) {
        const prepared = ai.prepare({ system, maxOutputTokens, signal });
        return (user) => prepared.answer(user);
      }
      return (user) => ai.answer({ prompt: { system, user }, maxOutputTokens, signal });
    };
    return { answer: start(ANSWER_SYSTEM_PROMPT, answerTokens), rating: start(RATING_SYSTEM_PROMPT, ratingTokens(sourceCount)) };
  }

  /**
   * Runs the answer call and the rating call side by side and yields their events as they come;
   * the answer part ends with answer-complete, insights and usage (both calls) close the stream.
   * Returns the answer to cache, or nothing when a call failed or no answer came.
   */
  async function* answerAndRate(
    calls: Record<Part, Call>,
    prompts: SearchPrompts,
    sourceCount: number,
    model: string,
    signal?: AbortSignal,
  ): AsyncGenerator<SearchEvent, CachedAnswer["answer"]> {
    const parsers: Record<Part, StructuredAnswerParser> = {
      answer: new StructuredAnswerParser(sourceCount),
      rating: new StructuredAnswerParser(sourceCount),
    };
    const usage = { inputTokens: 0, outputTokens: 0, model };
    let failed = false;
    const streams: Array<[Part, AsyncIterable<ProviderEvent>]> = [
      ["answer", calls.answer(prompts.answer.user)],
      ["rating", calls.rating(prompts.rating.user)],
    ];
    for await (const item of mergeStreams(streams)) {
      const part = item.key;
      if ("value" in item) {
        const ev = item.value;
        if (ev.type === "delta") yield* keep(part, parsers[part].push(ev.text));
        else {
          usage.inputTokens += ev.inputTokens;
          usage.outputTokens += ev.outputTokens;
          usage.model = ev.model;
        }
        continue;
      }
      if ("error" in item) {
        if (signal?.aborted || isAbortError(item.error)) return undefined;
        failed = true;
        yield { type: "error", message: errorMessage(item.error), recoverable: true };
      }
      yield* keep(part, parsers[part].end());
      if (part === "answer") yield { type: "answer-complete" };
    }
    if (signal?.aborted) return undefined;
    const insights = combine(parsers.answer.insights(), parsers.rating.insights());
    yield { type: "insights", insights };
    yield { type: "usage", ...usage };
    if (failed || !insights.answer) return undefined;
    return { text: insights.answer, citations: insights.citations, model: usage.model, insights };
  }

  async function* vertical(
    query: string,
    category: Exclude<SearchCategory, "general">,
    lang: string,
    opts: SearchOptions,
  ): AsyncGenerator<SearchEvent> {
    const maxResults = Math.min(VERTICAL_CAP, Math.max(1, Math.floor(opts.maxResults ?? VERTICAL_MAX_RESULTS[category])));
    const key = cacheKey({ query, lang, depth: "quick", retriever: config.retriever, maxResults, category });
    const hit = await cache.get(key);
    if (hit) {
      yield* replay(hit, category);
      return;
    }
    const capable = chain.filter((r) => r.categories?.includes(category));
    if (!capable.length) {
      yield { type: "error", message: `${category[0]!.toUpperCase()}${category.slice(1)} search needs the SearXNG backend.`, recoverable: false };
      return;
    }
    try {
      const { results, retriever } = await retrieveWithFallback(capable, query, { lang, maxResults, category, signal: opts.signal });
      yield { type: "results", results, retriever, cached: false, category };
      if (results.length) await cache.set(key, { results, retriever }, category === "news" ? NEWS_TTL_MS : undefined);
    } catch (err) {
      if (opts.signal?.aborted || isAbortError(err)) return;
      yield { type: "error", message: errorMessage(err), recoverable: false };
    }
  }

  async function* search(query: string, opts: SearchOptions = {}): AsyncGenerator<SearchEvent> {
    const signal = opts.signal;
    const trimmed = query.trim();
    if (!trimmed) {
      yield { type: "error", message: "Empty query", recoverable: false };
      return;
    }
    const lang = resolveLanguage(trimmed, opts.lang, config.uiLocale);
    const category = opts.category ?? "general";
    if (category !== "general") {
      yield* vertical(trimmed, category, lang, opts);
      return;
    }
    const depth = opts.depth ?? "quick";
    const maxResults = Math.min(20, Math.max(1, Math.floor(opts.maxResults ?? DEFAULT_MAX_RESULTS)));
    // A follow-up: answered in the context of the earlier turns, searched for with the previous
    // question when it is short, and cached apart from the same words asked on their own.
    const context = opts.context?.filter((t) => t.question.trim()) ?? [];
    const searched = retrievalQuery(trimmed, context);
    const contextKey = context.length ? `\u0001${createHash("sha256").update(JSON.stringify(context)).digest("hex").slice(0, 16)}` : "";
    const key = cacheKey({ query: trimmed + contextKey, lang, depth, retriever: config.retriever, maxResults });

    const hit = await cache.get(key);
    // A results-only entry is not good enough once a provider is available.
    if (hit && (hit.answer || !provider)) {
      yield* replay(hit, category);
      return;
    }

    // The calls start with the search, so a CLI process starts while the web is searched; any
    // not made by the end (no results, an error, a cancel) are released without a request.
    const release = new AbortController();
    const calls = provider && startCalls(provider, maxResults, signal ? AbortSignal.any([signal, release.signal]) : release.signal);
    try {
      let results: SearchResult[];
      let retriever: CachedAnswer["retriever"];
      try {
        ({ results, retriever } = await retrieveWithFallback(chain, searched, { lang, maxResults, signal }));
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) return;
        yield { type: "error", message: errorMessage(err), recoverable: false };
        return;
      }
      yield { type: "results", results, retriever, cached: false, category };

      if (!provider || !calls) {
        if (results.length) await cache.set(key, { results, retriever });
        return;
      }
      if (!results.length) {
        yield { type: "error", message: "No results to answer from", recoverable: true };
        return;
      }
      let pages: PageExtract[] = [];
      try {
        if (depth === "deep") pages = await deepFetch(results, signal);
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) return;
        yield { type: "error", message: errorMessage(err), recoverable: true };
        return;
      }
      if (signal?.aborted) return;
      const prompts = buildPrompts(trimmed, lang, results, pages, context);
      const answer = yield* answerAndRate(calls, prompts, results.length, provider.model, signal);
      if (answer) await cache.set(key, { results, retriever, answer });
    } finally {
      release.abort();
    }
  }

  return { search, answers: provider !== null };
}
