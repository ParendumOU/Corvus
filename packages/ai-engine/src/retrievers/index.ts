import type { RetrieverKind, SearchResult } from "@corvus/shared";
import { isAbortError } from "../http.js";
import { createBraveRetriever } from "./brave.js";
import { createDuckDuckGoRetriever } from "./duckduckgo.js";
import { createSearxngRetriever } from "./searxng.js";
import { type RetrieveOptions, type Retriever, RetrieverError, type RetrieverHttpOptions } from "./types.js";

export * from "./brave.js";
export * from "./duckduckgo.js";
export * from "./searxng.js";
export * from "./types.js";

export interface RetrieverChainConfig {
  retriever: RetrieverKind;
  searxngUrl?: string;
  braveApiKey?: string;
}

const FALLBACK_ORDER: RetrieverKind[] = ["searxng", "brave", "duckduckgo"];

/** Configured retriever first, then every other usable one (SearXNG needs a URL, Brave a key; DDG always works). */
export function createRetrieverChain(config: RetrieverChainConfig, http: RetrieverHttpOptions = {}): Retriever[] {
  const order = [config.retriever, ...FALLBACK_ORDER.filter((k) => k !== config.retriever)];
  const chain: Retriever[] = [];
  for (const kind of order) {
    if (kind === "searxng" && config.searxngUrl) chain.push(createSearxngRetriever(config.searxngUrl, http));
    else if (kind === "brave" && config.braveApiKey) chain.push(createBraveRetriever(config.braveApiKey, http));
    else if (kind === "duckduckgo") chain.push(createDuckDuckGoRetriever(http));
  }
  return chain;
}

export interface ChainResult {
  results: SearchResult[];
  retriever: RetrieverKind;
  errors: string[];
}

/**
 * Tries each retriever in order; an error or an empty result list moves on to the next one.
 * Throws only when every retriever failed. Caller aborts are rethrown immediately.
 */
export async function retrieveWithFallback(
  chain: Retriever[],
  query: string,
  opts: RetrieveOptions,
): Promise<ChainResult> {
  const errors: string[] = [];
  let empty: ChainResult | undefined;
  for (const retriever of chain) {
    try {
      const results = await retriever.search(query, opts);
      if (results.length > 0) return { results, retriever: retriever.kind, errors };
      empty ??= { results, retriever: retriever.kind, errors };
      errors.push(`${retriever.kind}: no results`);
    } catch (err) {
      if (opts.signal?.aborted || isAbortError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(err instanceof RetrieverError ? message : `${retriever.kind}: ${message}`);
    }
  }
  if (empty) return empty;
  throw new Error(`All retrievers failed (${errors.join("; ") || "none configured"})`);
}
