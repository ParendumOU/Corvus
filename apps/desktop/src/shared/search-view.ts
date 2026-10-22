import type {
  Confidence,
  EntityCard,
  KeyPoint,
  ResultRating,
  RetrieverKind,
  SearchCategory,
  SearchEvent,
  SearchResult,
} from "@corvus/shared";

/** View model of corvus://search, folded from the SearchEvent stream. */
export interface SearchViewState {
  results: SearchResult[] | null;
  retriever: RetrieverKind | null;
  cached: boolean;
  answer: string;
  answerDone: boolean;
  citations: number[];
  keyPoints: KeyPoint[];
  ratings: Record<number, ResultRating>;
  order: number[] | null;
  entity: EntityCard | null;
  followUps: string[];
  confidence: Confidence | null;
  disagreement: string | null;
  /** True once the structured stream is complete (insights or end of stream). */
  structuredDone: boolean;
  usage: { inputTokens: number; outputTokens: number; model: string } | null;
  errors: Array<{ message: string; recoverable: boolean }>;
  finished: boolean;
}

export const initialSearchView: SearchViewState = {
  results: null,
  retriever: null,
  cached: false,
  answer: "",
  answerDone: false,
  citations: [],
  keyPoints: [],
  ratings: {},
  order: null,
  entity: null,
  followUps: [],
  confidence: null,
  disagreement: null,
  structuredDone: false,
  usage: null,
  errors: [],
  finished: false,
};

export function reduceSearchView(s: SearchViewState, event: SearchEvent): SearchViewState {
  switch (event.type) {
    case "results":
      return { ...s, results: event.results, retriever: event.retriever, cached: event.cached };
    case "answer-delta":
      return { ...s, answer: s.answer + event.text };
    case "answer-done":
      return { ...s, answer: event.text || s.answer, answerDone: true, citations: event.citations };
    case "key-point":
      return { ...s, keyPoints: [...s.keyPoints, event.point] };
    case "rating":
      return { ...s, ratings: { ...s.ratings, [event.rating.index]: event.rating } };
    case "rerank":
      return { ...s, order: event.order };
    case "entity":
      return { ...s, entity: event.entity };
    case "follow-up":
      return s.followUps.includes(event.question) ? s : { ...s, followUps: [...s.followUps, event.question] };
    case "confidence":
      return { ...s, confidence: event.level, disagreement: event.sourcesDisagree ? (event.note ?? "") : null };
    case "insights": {
      const i = event.insights;
      return {
        ...s,
        answer: i.answer || s.answer,
        answerDone: true,
        citations: i.citations,
        keyPoints: i.keyPoints,
        ratings: Object.fromEntries(i.ratings.map((r) => [r.index, r])),
        order: i.ratings.length ? i.order : s.order,
        entity: i.entity ?? null,
        followUps: i.followUps,
        confidence: i.confidence ?? null,
        disagreement: i.disagreement ?? null,
        structuredDone: true,
      };
    }
    case "usage":
      return { ...s, usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, model: event.model }, finished: true, structuredDone: true, answerDone: true };
    case "error":
      return { ...s, errors: [...s.errors, { message: event.message, recoverable: event.recoverable }], finished: !event.recoverable || s.finished };
    default:
      return s;
  }
}

export type SortMode = "ai" | "original";

/** Result indices in display order: AI order once ratings arrived (and sort is "ai"), else retriever order. */
export function displayOrder(s: SearchViewState, sort: SortMode): number[] {
  const count = s.results?.length ?? 0;
  const natural = Array.from({ length: count }, (_, i) => i);
  if (sort === "original" || !s.order) return natural;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of s.order) {
    if (i >= 0 && i < count && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  for (const i of natural) if (!seen.has(i)) out.push(i);
  return out;
}

export function parseCategory(value: string | null): SearchCategory {
  return value === "news" || value === "images" || value === "videos" ? value : "general";
}
