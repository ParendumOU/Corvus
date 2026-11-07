import { describe, expect, it } from "vitest";
import type { SearchEvent, SearchResult } from "@corvus/shared";
import {
  aiSettled,
  answerReady,
  contextFor,
  displayOrder,
  initialSearchView,
  listReady,
  openingSort,
  parseTurns,
  ratingsReady,
  reduceSearchView,
  type SearchViewState,
  visibleAnswer,
} from "../src/shared/search-view";

const RESULTS: SearchResult[] = ["a", "b", "c"].map((n, i) => ({
  url: `https://${n}.example/`,
  title: n.toUpperCase(),
  snippet: `${n} snippet`,
  source: `${n}.example`,
  rank: i + 1,
}));

function fold(events: SearchEvent[], from: SearchViewState = initialSearchView): SearchViewState {
  return events.reduce(reduceSearchView, from);
}

const results = (cached = false): SearchEvent => ({ type: "results", results: RESULTS, retriever: "searxng", cached });
const rating = (index: number, score: number): SearchEvent => ({ type: "rating", rating: { index, score, tags: [], summary: `summary ${index}` } });
/** A live AI stream, as the structured parser emits it, up to (not including) its insights. */
const STREAM: SearchEvent[] = [
  results(),
  { type: "answer-delta", text: "Alpha " },
  { type: "answer-delta", text: "[3]." },
  { type: "answer-done", text: "Alpha [3].", citations: [2] },
  { type: "key-point", point: { text: "Point [1]", citations: [0] } },
  rating(0, 4),
  rating(1, 6),
  rating(2, 9),
  { type: "rerank", order: [2, 1, 0] },
  { type: "follow-up", question: "More?" },
];
const INSIGHTS: SearchEvent = {
  type: "insights",
  insights: {
    answer: "Alpha [3].",
    citations: [2],
    keyPoints: [{ text: "Point [1]", citations: [0] }],
    ratings: [0, 1, 2].map((index) => ({ index, score: [4, 6, 9][index]!, tags: [], summary: `summary ${index}` })),
    order: [2, 1, 0],
    followUps: ["More?"],
  },
};

describe("aiSettled", () => {
  it("stays false through the whole live stream, answer and ratings included", () => {
    let s = initialSearchView;
    for (const event of STREAM) {
      s = reduceSearchView(s, event);
      expect(aiSettled(s)).toBe(false);
    }
    // The answer is complete and every result is rated, but more AI output can still come.
    expect(s.citations).toEqual([2]);
    expect(Object.keys(s.ratings)).toHaveLength(3);
  });

  it("turns true with the insights, the usage, or a failed search", () => {
    expect(aiSettled(fold([...STREAM, INSIGHTS]))).toBe(true);
    expect(aiSettled(fold([...STREAM, { type: "usage", inputTokens: 1, outputTokens: 1, model: "m" }]))).toBe(true);
    expect(aiSettled(fold([results(), { type: "error", message: "down", recoverable: false }]))).toBe(true);
  });

  it("stays false after a recoverable error until the stream ends", () => {
    const failed = fold([results(), { type: "answer-delta", text: "Alp" }, { type: "error", message: "overloaded", recoverable: true }]);
    expect(aiSettled(failed)).toBe(false);
    // The page marks the end of the stream ("done") as finished.
    expect(aiSettled({ ...failed, finished: true })).toBe(true);
  });
});

describe("answerReady and ratingsReady", () => {
  // The answer and rating calls are written side by side: their events interleave.
  const LIVE: SearchEvent[] = [
    results(),
    { type: "answer-delta", text: "Alpha " },
    rating(0, 4),
    { type: "answer-delta", text: "[3]." },
    { type: "answer-done", text: "Alpha [3].", citations: [2] },
    { type: "key-point", point: { text: "Point [1]", citations: [0] } },
    { type: "confidence", level: "high", sourcesDisagree: false },
    rating(1, 6),
    { type: "answer-complete" },
    rating(2, 9),
    { type: "rerank", order: [2, 1, 0] },
    { type: "follow-up", question: "More?" },
  ];

  it("shows the answer box once its whole part is in, before the ratings are", () => {
    const at = (n: number) => fold(LIVE.slice(0, n));
    const complete = LIVE.findIndex((e) => e.type === "answer-complete") + 1;
    for (let n = 1; n < complete; n++) expect(answerReady(at(n))).toBe(false);
    expect(answerReady(at(complete))).toBe(true);
    expect(ratingsReady(at(complete))).toBe(false);
  });

  it("shows ratings, summaries and the AI order once the rating block is complete", () => {
    const rerank = LIVE.findIndex((e) => e.type === "rerank") + 1;
    expect(ratingsReady(fold(LIVE.slice(0, rerank - 1)))).toBe(false);
    expect(ratingsReady(fold(LIVE.slice(0, rerank)))).toBe(true);
    expect(aiSettled(fold(LIVE))).toBe(false);
  });

  it("shows whatever came once no more AI output is coming", () => {
    const failed = fold([results(), { type: "answer-delta", text: "Alp" }, { type: "error", message: "overloaded", recoverable: true }]);
    expect(answerReady(failed)).toBe(false);
    expect(answerReady({ ...failed, finished: true })).toBe(true);
    expect(ratingsReady({ ...failed, finished: true })).toBe(true);
  });
});

describe("listReady", () => {
  it("waits for the results and for knowing whether AI output follows", () => {
    expect(listReady(initialSearchView, true)).toBe(false);
    const live = fold([results()]);
    expect(listReady(live, null)).toBe(false);
    expect(listReady(live, true)).toBe(true);
    expect(listReady(live, false)).toBe(true);
  });

  it("holds a cached search until its replay ends, so it opens complete", () => {
    const replaying = fold([results(true), { type: "answer-delta", text: "Alpha" }]);
    expect(listReady(replaying, true)).toBe(false);
    expect(listReady({ ...replaying, finished: true }, true)).toBe(true);
  });
});

describe("openingSort", () => {
  it("opens a live search in the retriever order: the AI order comes after the list is shown", () => {
    const shown = fold([results()]);
    expect(openingSort(shown, "ai")).toBe("original");
    expect(displayOrder(shown, openingSort(shown, "ai"))).toEqual([0, 1, 2]);
  });

  it("opens a cached search in the saved order, since its AI order is already there", () => {
    const replayed = fold([results(true), ...STREAM.slice(1), INSIGHTS]);
    expect(openingSort(replayed, "ai")).toBe("ai");
    expect(displayOrder(replayed, "ai")).toEqual([2, 1, 0]);
    expect(openingSort(replayed, "original")).toBe("original");
  });

  it("keeps the order once chosen even when the AI order arrives", () => {
    const opening = openingSort(fold([results()]), "ai");
    const later = fold([...STREAM, INSIGHTS]);
    expect(displayOrder(later, opening)).toEqual([0, 1, 2]);
    // The Sort toggle still offers the AI order.
    expect(displayOrder(later, "ai")).toEqual([2, 1, 0]);
  });
});

describe("visibleAnswer", () => {
  it("shows the answer a whole sentence at a time while it is written, all of it once complete", () => {
    expect(visibleAnswer("Ravens are large", false)).toBe("");
    expect(visibleAnswer("Ravens are large [1]. They pla", false)).toBe("Ravens are large [1].");
    expect(visibleAnswer("Ravens are large [1]. They play.", false)).toBe("Ravens are large [1].");
    expect(visibleAnswer("Ravens are large [1]. They play.", true)).toBe("Ravens are large [1]. They play.");
    expect(visibleAnswer("First line\nSecond li", false)).toBe("First line");
    expect(visibleAnswer("¿Cuánto mide? Mide 8.848", false)).toBe("¿Cuánto mide?");
    expect(visibleAnswer("東京は首都です。人口は", false)).toBe("東京は首都です。");
  });

  it("does not end a sentence inside a number or an abbreviation without a space after it", () => {
    expect(visibleAnswer("It is 8.8", false)).toBe("");
    expect(visibleAnswer("See e.g.", false)).toBe("");
  });
});

describe("conversation turns", () => {
  const turn = (query: string, answer: string) => ({ key: query, query, state: { ...initialSearchView, answer } });

  it("answers a follow-up in the context of the earlier turns that have an answer", () => {
    expect(contextFor([turn("ravens", "Large birds [1]."), turn("crows", "")])).toEqual([{ question: "ravens", answer: "Large birds [1]." }]);
    expect(contextFor([])).toEqual([]);
  });

  it("accepts only well-formed turns from a page, the last 6, cut to size", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, answer: "a".repeat(5000) }));
    const parsed = parseTurns(many);
    expect(parsed.map((t) => t.question)).toEqual(["q3", "q4", "q5", "q6", "q7", "q8"]);
    expect(parsed[0]!.answer).toHaveLength(4000);
    expect(parseTurns([{ question: 1, answer: "x" }, null, "text", { question: "ok", answer: "fine" }])).toEqual([{ question: "ok", answer: "fine" }]);
    expect(parseTurns("not a list")).toEqual([]);
  });
});
