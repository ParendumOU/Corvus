/**
 * AI search contract (packages/ai-engine implements, apps/desktop consumes).
 *
 * Flow: query -> retriever (SearXNG/Brave/DDG, no LLM) -> compact snippets
 *       -> ONE small-model call that answers, rates and summarizes in the user's language, with citations.
 * News/images/videos verticals stop after the retriever (zero tokens).
 */

export type AIProviderKind = "anthropic-api" | "claude-code-cli" | "local";
/** Wire protocol a local model server speaks. Ollama's native API, or the OpenAI-compatible one (llama.cpp, LM Studio). */
export type LocalModelApi = "ollama" | "openai";
export type RetrieverKind = "searxng" | "brave" | "duckduckgo";

export interface SearchOptions {
  /** BCP-47 language for the answer. If omitted, detected from the query, then UI locale. */
  lang?: string;
  /** "quick": snippets only (cheapest). "deep": also reads top pages (Readability, truncated). */
  depth?: "quick" | "deep";
  maxResults?: number; // default 8 (news/videos 12, images 30)
  /** Vertical. Anything but "general" is results-only: no LLM call, zero tokens. Default "general". */
  category?: SearchCategory;
  signal?: AbortSignal;
}

export type SearchCategory = "general" | "news" | "images" | "videos";

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  source: string; // domain
  rank: number; // original retriever rank (1-based); AI re-ranking never rewrites it
  /** Vertical extras, present when the retriever knows them. */
  publishedAt?: string; // ISO 8601
  age?: string; // retriever's relative label, e.g. "13 hours ago"
  publisher?: string; // news outlet, video channel, image site name
  thumbnail?: string; // http(s) URL
  image?: { src: string; width?: number; height?: number; format?: string };
  duration?: string; // "10:21"
}

/** Labels the AI may attach to a result (the runtime list lives in @corvus/ai-engine: RESULT_TAGS). */
export type ResultTag =
  | "official"
  | "docs"
  | "reference"
  | "news"
  | "forum"
  | "video"
  | "academic"
  | "opinion"
  | "shopping"
  | "outdated"
  | "paywall";

export interface ResultRating {
  index: number; // 0-based into results
  score: number; // relevance 0..10
  summary: string; // one line, user's language
  tags: ResultTag[];
}

export interface KeyPoint {
  text: string;
  citations: number[]; // 0-based into results
}

export interface EntityCard {
  title: string;
  description: string;
  facts: Array<{ label: string; value: string }>; // up to 5
}

export type Confidence = "high" | "medium" | "low";

/** Everything the single structured LLM call produced, aggregated. */
export interface SearchInsights {
  answer: string;
  citations: number[];
  keyPoints: KeyPoint[];
  ratings: ResultRating[];
  /** Result indices, best first (stable re-rank by AI score; unrated keep retriever order at the end). */
  order: number[];
  followUps: string[];
  entity?: EntityCard;
  confidence?: Confidence;
  /** Set when the sources conflict: what they disagree on. */
  disagreement?: string;
}

export type SearchEvent =
  | { type: "results"; results: SearchResult[]; retriever: RetrieverKind; cached: boolean; category?: SearchCategory }
  | { type: "answer-delta"; text: string }
  | { type: "answer-done"; text: string; citations: number[] /* indices into results */ }
  | { type: "usage"; inputTokens: number; outputTokens: number; model: string }
  | { type: "error"; message: string; recoverable: boolean }
  // Structured AI output (additive). Order: answer-done, key-point*, rating*, rerank, entity?,
  // follow-up*, confidence?, insights, usage. Older consumers can ignore all of these.
  | { type: "key-point"; point: KeyPoint }
  | { type: "rating"; rating: ResultRating }
  | { type: "rerank"; order: number[] }
  | { type: "entity"; entity: EntityCard }
  | { type: "follow-up"; question: string }
  | { type: "confidence"; level: Confidence | null; sourcesDisagree: boolean; note?: string }
  | { type: "insights"; insights: SearchInsights };

export interface SearchEngine {
  search(query: string, opts?: SearchOptions): AsyncIterable<SearchEvent>;
}

/** Omnibox classification: is the input a URL to navigate to or a query to search? */
export type OmniboxIntent = { kind: "url"; url: string } | { kind: "search"; query: string };
