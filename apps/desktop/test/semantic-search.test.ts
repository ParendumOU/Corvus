import { describe, expect, it } from "vitest";
import {
  type IndexDoc,
  type IndexDocKind,
  bm25Rank,
  blendScores,
  capByKind,
  cosineSimilarity,
  docId,
  makeSnippet,
  queryTokens,
  snippetAround,
  tokenize,
  upsertDoc,
} from "../src/shared/semantic-search";

function doc(kind: IndexDocKind, url: string, title: string, text = "", ts = 1): IndexDoc {
  return { id: docId(kind, url), kind, url, title, text, ts };
}

describe("tokenize / queryTokens", () => {
  it("lowercases, splits on non-alphanumerics and drops short + stopwords", () => {
    expect(tokenize("The Raven-Bird, v2!")).toEqual(["raven", "bird", "v2"]);
  });
  it("falls back to raw tokens when stopword stripping empties the query", () => {
    expect(queryTokens("how to")).toEqual(["how", "to"]);
  });
});

describe("bm25Rank", () => {
  const corpus: IndexDoc[] = [
    doc("history", "https://en.wikipedia.org/wiki/Common_raven", "Common raven", "The common raven is a large black passerine bird found across the Northern Hemisphere."),
    doc("reading", "https://birds.example/crows", "Crows and intelligence", "Corvids including crows and ravens show remarkable problem-solving intelligence."),
    doc("bookmark", "https://cooking.example/pasta", "Best pasta recipe", "A simple tomato pasta you can cook in twenty minutes."),
  ];

  it("ranks the on-topic doc first and drops non-matches", () => {
    const hits = bm25Rank(corpus, "raven bird");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.doc.url).toContain("Common_raven");
    expect(hits.some((h) => h.doc.url.includes("pasta"))).toBe(false);
  });

  it("weights a title hit above a body-only hit", () => {
    const hits = bm25Rank(corpus, "crows");
    expect(hits[0]!.doc.title).toBe("Crows and intelligence");
  });

  it("returns [] for an empty query or empty corpus", () => {
    expect(bm25Rank(corpus, "")).toEqual([]);
    expect(bm25Rank([], "raven")).toEqual([]);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("is 0 when a vector is degenerate", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("blendScores", () => {
  const cands = [
    { doc: doc("history", "https://a", "A", "", 1), keywordScore: 1 },
    { doc: doc("history", "https://b", "B", "", 2), keywordScore: 3 },
  ];

  it("keeps BM25 order when no semantic scores are given", () => {
    const ranked = blendScores(cands, []);
    expect(ranked.map((r) => r.doc.url)).toEqual(["https://b", "https://a"]);
    expect(ranked[0]!.semanticScore).toBeUndefined();
  });

  it("lets a strong semantic match overtake a weak keyword lead", () => {
    const ranked = blendScores(cands, [0.95, 0.05]);
    expect(ranked[0]!.doc.url).toBe("https://a");
    expect(ranked[0]!.semanticScore).toBeCloseTo(0.95, 6);
  });
});

describe("snippets", () => {
  it("makeSnippet collapses whitespace and caps length", () => {
    expect(makeSnippet("  a\n\n  b   c  ", 5)).toBe("a b c");
  });
  it("snippetAround windows around the first matching term", () => {
    const text = `${"x ".repeat(100)}ravens are clever ${"y ".repeat(100)}`;
    const out = snippetAround(text, "ravens", 40);
    expect(out).toContain("ravens");
    expect(out.startsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(60);
  });
});

describe("upsertDoc / capByKind", () => {
  it("replaces a doc with the same id", () => {
    const list = [doc("history", "https://a", "Old", "", 1)];
    const next = upsertDoc(list, doc("history", "https://a", "New", "", 2));
    expect(next).toHaveLength(1);
    expect(next[0]!.title).toBe("New");
  });

  it("caps each kind to the newest N, independently", () => {
    const docs: IndexDoc[] = [];
    for (let i = 0; i < 5; i++) docs.push(doc("history", `https://h/${i}`, `h${i}`, "", i));
    for (let i = 0; i < 5; i++) docs.push(doc("bookmark", `https://b/${i}`, `b${i}`, "", i));
    const capped = capByKind(docs, 2);
    const hist = capped.filter((d) => d.kind === "history").map((d) => d.ts).sort();
    const book = capped.filter((d) => d.kind === "bookmark");
    expect(hist).toEqual([3, 4]);
    expect(book).toHaveLength(2);
  });
});
