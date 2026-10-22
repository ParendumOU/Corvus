import type { RetrieverKind, SearchCategory, SearchResult } from "@corvus/shared";
import type { FetchLike } from "../http.js";
import { cleanText, truncate } from "../text.js";
import { dedupeResults, domainOf, stripTracking } from "../url.js";

export interface RetrieveOptions {
  /** BCP-47 language, e.g. "es" or "pt-BR". */
  lang: string;
  maxResults: number;
  /** Vertical; only sent to retrievers that list it in `categories`. Default "general". */
  category?: SearchCategory;
  signal?: AbortSignal;
}

export interface Retriever {
  readonly kind: RetrieverKind;
  /** Verticals besides "general" this retriever can serve. */
  readonly categories?: readonly SearchCategory[];
  search(query: string, opts: RetrieveOptions): Promise<SearchResult[]>;
}

export interface RetrieverHttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

export const DEFAULT_RETRIEVER_TIMEOUT_MS = 6000;
const MAX_TITLE = 160;
const MAX_SNIPPET = 500;

export interface RawHit {
  url: string | undefined | null;
  title: string | undefined | null;
  snippet: string | undefined | null;
}

/** Maps raw hits to SearchResult: http(s) only, tracking stripped, text cleaned, deduped, ranked 1..n. */
export function toResults(hits: RawHit[], maxResults: number): SearchResult[] {
  const mapped: SearchResult[] = [];
  for (const hit of hits) {
    if (!hit.url || !/^https?:\/\//i.test(hit.url)) continue;
    const url = stripTracking(hit.url);
    const source = domainOf(url);
    if (!source) continue;
    mapped.push({
      url,
      title: truncate(cleanText(hit.title) || source, MAX_TITLE),
      snippet: truncate(cleanText(hit.snippet), MAX_SNIPPET),
      source,
      rank: 0,
    });
  }
  return dedupeResults(mapped).slice(0, maxResults);
}

export class RetrieverError extends Error {
  constructor(
    readonly kind: RetrieverKind,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "RetrieverError";
  }
}

export function baseLang(lang: string): string {
  return (lang.split("-")[0] ?? "en").toLowerCase();
}
