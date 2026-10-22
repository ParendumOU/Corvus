import type { SearchResult } from "@corvus/shared";
import { fetchWithTimeout } from "../http.js";
import {
  baseLang,
  DEFAULT_RETRIEVER_TIMEOUT_MS,
  type RawHit,
  type RetrieveOptions,
  type Retriever,
  RetrieverError,
  type RetrieverHttpOptions,
  toResults,
} from "./types.js";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

// Brave's search_lang codes differ from BCP-47 in a few places.
const BRAVE_LANGS = new Set(
  "ar eu bn bg ca hr cs da nl en et fi fr gl de gu he hi hu is it kn ko lv lt ms ml mr nb pl pa ro ru sr sk sl es sv ta te th tr uk vi".split(
    " ",
  ),
);

export function braveSearchLang(lang: string): string | undefined {
  const lower = lang.toLowerCase();
  const base = baseLang(lang);
  if (base === "ja") return "jp";
  if (base === "zh") return /-(tw|hk|mo|hant)/.test(lower) ? "zh-hant" : "zh-hans";
  if (base === "pt") return lower === "pt-pt" ? "pt-pt" : "pt-br";
  if (lower === "en-gb") return "en-gb";
  if (base === "no" || base === "nn") return "nb";
  return BRAVE_LANGS.has(base) ? base : undefined;
}

interface BraveResponse {
  web?: { results?: Array<{ url?: string; title?: string; description?: string }> };
}

export function parseBrave(body: unknown, maxResults: number): SearchResult[] {
  const response = body as BraveResponse | null;
  if (!response || typeof response !== "object") throw new RetrieverError("brave", "unexpected response shape");
  const results = response.web?.results ?? [];
  const hits: RawHit[] = results.map((r) => ({ url: r.url, title: r.title, snippet: r.description }));
  return toResults(hits, maxResults);
}

export function createBraveRetriever(apiKey: string, http: RetrieverHttpOptions = {}): Retriever {
  const fetchImpl = http.fetch ?? fetch;
  const timeoutMs = http.timeoutMs ?? DEFAULT_RETRIEVER_TIMEOUT_MS;
  return {
    kind: "brave",
    async search(query: string, opts: RetrieveOptions) {
      const url = new URL(ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(20, Math.max(1, opts.maxResults))));
      const searchLang = braveSearchLang(opts.lang);
      if (searchLang) url.searchParams.set("search_lang", searchLang);
      url.searchParams.set("safesearch", "moderate");
      url.searchParams.set("text_decorations", "false");
      const res = await fetchWithTimeout(
        fetchImpl,
        url.toString(),
        { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } },
        timeoutMs,
        opts.signal,
      );
      if (!res.ok) throw new RetrieverError("brave", `HTTP ${res.status}`);
      return parseBrave(await res.json(), opts.maxResults);
    },
  };
}
