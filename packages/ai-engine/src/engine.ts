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
import { buildPrompt, type PageExtract, parseCitations } from "./prompt.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createClaudeCliProvider } from "./providers/claude-cli.js";
import { createLocalProvider } from "./providers/local.js";
import { type AnswerProvider, DEFAULT_MODEL } from "./providers/types.js";
import { createRetrieverChain, type Retriever, retrieveWithFallback } from "./retrievers/index.js";
import { StructuredAnswerParser } from "./structured.js";

export const DEFAULT_MAX_RESULTS = 8;
/** Structured output (answer, points, per-result ratings, follow-ups) needs more room than a bare answer. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 700;

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

/** The structured events an insights object stands for, in live-stream order (cache replay). */
export function* insightEvents(insights: SearchInsights): Generator<SearchEvent> {
  for (const point of insights.keyPoints) yield { type: "key-point", point };
  for (const rating of insights.ratings) yield { type: "rating", rating };
  if (insights.ratings.length) yield { type: "rerank", order: insights.order };
  if (insights.entity) yield { type: "entity", entity: insights.entity };
  for (const question of insights.followUps) yield { type: "follow-up", question };
  if (insights.confidence || insights.disagreement) {
    yield {
      type: "confidence",
      level: insights.confidence ?? null,
      sourcesDisagree: Boolean(insights.disagreement),
      ...(insights.disagreement ? { note: insights.disagreement } : {}),
    };
  }
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
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const deepFetch =
    deps.deepFetch ?? ((results: SearchResult[], signal?: AbortSignal) => fetchPageExtracts(results, { fetch: deps.fetch, signal }));

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
    const key = cacheKey({ query: trimmed, lang, depth, retriever: config.retriever, maxResults });

    const hit = await cache.get(key);
    // A results-only entry is not good enough once a provider is available.
    if (hit && (hit.answer || !provider)) {
      yield* replay(hit, category);
      return;
    }

    let results: SearchResult[];
    let retriever: CachedAnswer["retriever"];
    try {
      ({ results, retriever } = await retrieveWithFallback(chain, trimmed, { lang, maxResults, signal }));
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) return;
      yield { type: "error", message: errorMessage(err), recoverable: false };
      return;
    }
    yield { type: "results", results, retriever, cached: false, category };

    if (!provider) {
      if (results.length) await cache.set(key, { results, retriever });
      return;
    }
    if (!results.length) {
      yield { type: "error", message: "No results to answer from", recoverable: true };
      return;
    }

    try {
      const pages = depth === "deep" ? await deepFetch(results, signal) : [];
      if (signal?.aborted) return;
      const prompt = buildPrompt(trimmed, lang, results, pages);
      const parser = new StructuredAnswerParser(results.length);
      let usage: Extract<SearchEvent, { type: "usage" }> | undefined;
      for await (const ev of provider.answer({ prompt, maxOutputTokens, signal })) {
        if (ev.type === "delta") yield* parser.push(ev.text);
        else usage = { type: "usage", inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, model: ev.model };
      }
      if (signal?.aborted) return;
      yield* parser.end();
      const insights = parser.insights();
      yield { type: "insights", insights };
      const model = usage?.model ?? provider.model;
      yield usage ?? { type: "usage", inputTokens: 0, outputTokens: 0, model };
      if (insights.answer) {
        const answer = { text: insights.answer, citations: parseCitations(insights.answer, results.length), model, insights };
        await cache.set(key, { results, retriever, answer });
      }
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) return;
      yield { type: "error", message: errorMessage(err), recoverable: true };
    }
  }

  return { search };
}
