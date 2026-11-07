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
  citations: number[];
  keyPoints: KeyPoint[];
  ratings: Record<number, ResultRating>;
  order: number[] | null;
  entity: EntityCard | null;
  followUps: string[];
  confidence: Confidence | null;
  disagreement: string | null;
  /** True once the answer part of the reply is complete (answer, key points, confidence). */
  answerComplete: boolean;
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
  citations: [],
  keyPoints: [],
  ratings: {},
  order: null,
  entity: null,
  followUps: [],
  confidence: null,
  disagreement: null,
  answerComplete: false,
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
      return { ...s, answer: event.text || s.answer, citations: event.citations };
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
    case "answer-complete":
      return { ...s, answerComplete: true };
    case "insights": {
      const i = event.insights;
      return {
        ...s,
        answer: i.answer || s.answer,
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
      return { ...s, usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, model: event.model }, finished: true, structuredDone: true };
    case "error":
      return { ...s, errors: [...s.errors, { message: event.message, recoverable: event.recoverable }], finished: !event.recoverable || s.finished };
    default:
      return s;
  }
}

/** True once no more AI output is coming: the structured stream ended, or the search finished or failed. */
export function aiSettled(s: SearchViewState): boolean {
  return s.structuredDone || s.finished;
}

/*
 * The page shows each part of the AI reply only once that part is complete, all of it at once, so
 * nothing is seen half written: the answer box when the answer part is in, the ratings, summaries
 * and tags when the rating block is in, the side panel when the reply is over.
 */

/** The answer box can show: answer, key points and confidence are in, or no more AI output is coming. */
export function answerReady(s: SearchViewState): boolean {
  return s.answerComplete || aiSettled(s);
}

/** Ratings, AI summaries, tags and the AI order can show: the rating block is complete. */
export function ratingsReady(s: SearchViewState): boolean {
  return s.order !== null || aiSettled(s);
}

/**
 * True when the result list can be drawn: its results are in, the page knows whether AI output
 * follows (`answers`, null until known), and a cached search has replayed (its events come at once).
 */
export function listReady(s: SearchViewState, answers: boolean | null): boolean {
  return s.results !== null && answers !== null && (!s.cached || s.finished);
}

export type SortMode = "ai" | "original";

/**
 * The order a result list opens with. The saved choice applies when the AI order is already there
 * as the list is first drawn; an AI order that arrives later never moves results the person can
 * see (the Sort toggle applies it on request).
 */
export function openingSort(s: SearchViewState, saved: SortMode): SortMode {
  return saved === "ai" && s.order ? "ai" : "original";
}

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

/**
 * The answer as the page shows it: while it is still written, only up to the last whole sentence
 * (a sentence ends at . ! ? followed by a space or a line break, or at 。！？), so text appears a
 * sentence at a time and never half written; all of it once the answer part is complete.
 */
export function visibleAnswer(text: string, complete: boolean): string {
  if (complete) return text;
  let cut = 0;
  for (const m of text.matchAll(/[.!?]["'”’)\]]*(?=\s)|[。！？]|\n/g)) cut = (m.index ?? 0) + m[0].length;
  return text.slice(0, cut).trimEnd();
}

/** One question of a conversation on corvus://search and the search that answers it. */
export interface Turn {
  /** Page-local key; the search id comes later from the main process. */
  key: string;
  query: string;
  state: SearchViewState;
}

/** The earlier turns a follow-up is answered in the context of: those with an answer. */
export function contextFor(turns: readonly Turn[]): Array<{ question: string; answer: string }> {
  return turns.filter((t) => t.state.answer.trim()).map((t) => ({ question: t.query, answer: t.state.answer }));
}

/** The earlier turns a page sends with a follow-up (IPC input): the last 6, each cut to size. */
export function parseTurns(value: unknown): Array<{ question: string; answer: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(-6).flatMap((t: unknown) => {
    const turn = t as { question?: unknown; answer?: unknown } | null;
    return typeof turn?.question === "string" && typeof turn.answer === "string" ? [{ question: turn.question.slice(0, 2048), answer: turn.answer.slice(0, 4000) }] : [];
  });
}
