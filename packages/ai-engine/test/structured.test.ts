import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/prompt.js";
import { rerankByRating, type StructuredEvent, StructuredAnswerParser } from "../src/structured.js";

export const SAMPLE = [
  "Rust ownership is a set of compile-time rules that manage memory without a garbage collector [1][2].",
  "Each value has one owner and is dropped when the owner goes out of scope [1].",
  "P: Every value has exactly one owner at a time [1]",
  "P: Assignment moves ownership; the old binding becomes invalid [2]",
  "P: Borrowing lends access through references without taking ownership [3]",
  "R: 1|10|official,docs|The Rust Book chapter that defines ownership rules with runnable examples",
  "R: 2|8|reference|Encyclopedia overview of Rust including its ownership and borrowing model",
  "R: 3|9|docs|Rust by Example pages on borrowing, references and lifetimes",
  "R: 4|3|forum,outdated|Old forum thread asking about ownership errors in pre-1.0 Rust",
  "E: Rust|Systems programming language focused on safety and performance",
  "F: Developer|Rust Foundation",
  "F: First release|2015",
  "Q: rust borrowing rules",
  "Q: rust lifetimes explained",
  "Q: rust ownership vs garbage collection",
  "C: high",
].join("\n");

function feed(text: string, chunkSize: number, sources = 4): { events: StructuredEvent[]; parser: StructuredAnswerParser } {
  const parser = new StructuredAnswerParser(sources);
  const events: StructuredEvent[] = [];
  for (let i = 0; i < text.length; i += chunkSize) events.push(...parser.push(text.slice(i, i + chunkSize)));
  events.push(...parser.end());
  return { events, parser };
}

const answerOf = (events: StructuredEvent[]) =>
  events
    .filter((e): e is Extract<StructuredEvent, { type: "answer-delta" }> => e.type === "answer-delta")
    .map((e) => e.text)
    .join("");

describe("StructuredAnswerParser", () => {
  it("parses every section and orders events", () => {
    const { events, parser } = feed(SAMPLE, 1_000_000);
    const types = events.map((e) => e.type);
    expect(types.indexOf("answer-done")).toBeGreaterThan(types.lastIndexOf("answer-delta"));
    expect(types.indexOf("key-point")).toBeGreaterThan(types.indexOf("answer-done"));
    expect(types.indexOf("rerank")).toBeGreaterThan(types.lastIndexOf("rating"));
    expect(types.indexOf("entity")).toBeGreaterThan(types.indexOf("rerank"));
    expect(types.at(-1)).toBe("confidence");

    const insights = parser.insights();
    expect(insights.answer).toBe(
      "Rust ownership is a set of compile-time rules that manage memory without a garbage collector [1][2].\nEach value has one owner and is dropped when the owner goes out of scope [1].",
    );
    expect(insights.citations).toEqual([0, 1]);
    expect(insights.keyPoints).toHaveLength(3);
    expect(insights.keyPoints[1]).toEqual({ text: "Assignment moves ownership; the old binding becomes invalid [2]", citations: [1] });
    expect(insights.ratings.map((r) => [r.index, r.score])).toEqual([
      [0, 10],
      [1, 8],
      [2, 9],
      [3, 3],
    ]);
    expect(insights.ratings[0]!.tags).toEqual(["official", "docs"]);
    expect(insights.ratings[3]!.tags).toEqual(["forum", "outdated"]);
    expect(insights.order).toEqual([0, 2, 1, 3]);
    expect(insights.entity).toEqual({
      title: "Rust",
      description: "Systems programming language focused on safety and performance",
      facts: [
        { label: "Developer", value: "Rust Foundation" },
        { label: "First release", value: "2015" },
      ],
    });
    expect(insights.followUps).toEqual(["rust borrowing rules", "rust lifetimes explained", "rust ownership vs garbage collection"]);
    expect(insights.confidence).toBe("high");
    expect(insights.disagreement).toBeUndefined();
  });

  it("produces the same result for any chunking, and streams the answer before its line ends", () => {
    const whole = feed(SAMPLE, 1_000_000).parser.insights();
    for (const size of [1, 2, 3, 7, 16, 64]) {
      const { events, parser } = feed(SAMPLE, size);
      expect(parser.insights(), `chunk ${size}`).toEqual(whole);
      expect(answerOf(events).trim()).toBe(whole.answer);
    }
    const parser = new StructuredAnswerParser(4);
    expect(parser.push("Rust owner")).toEqual([{ type: "answer-delta", text: "Rust owner" }]);
    expect(parser.push("ship is")).toEqual([{ type: "answer-delta", text: "ship is" }]);
  });

  it("holds back a line start that may still become a tag", () => {
    const parser = new StructuredAnswerParser(3);
    expect(parser.push("Answer [1].\n")).toEqual([{ type: "answer-delta", text: "Answer [1]." }]);
    expect(parser.push("P")).toEqual([]);
    const next = parser.push(": point [2]\n");
    expect(next.map((e) => e.type)).toEqual(["answer-done", "key-point"]);
  });

  it("tolerates decorated, lower-case and full-width tags", () => {
    const text = ["Answer.", "- **P:** bullet point [1]", "r: [2] | 7/10 | Docs, Blog | Guide page", "q：次の検索"].join("\n");
    const { parser } = feed(text, 5, 3);
    const insights = parser.insights();
    expect(insights.keyPoints[0]!.text).toBe("bullet point [1]");
    expect(insights.ratings).toEqual([{ index: 1, score: 7, summary: "Guide page", tags: ["docs", "opinion"] }]);
    expect(insights.followUps).toEqual(["次の検索"]);
  });

  it("drops malformed and out-of-range records without failing", () => {
    const text = [
      "Short answer [1] [9].",
      "Key points:",
      "R: 9|8|docs|out of range",
      "R: x|8|docs|no index",
      "R: 1",
      "R: 1|eleven|docs|no score",
      "R: 2|15|nonsense-tag|score clamps to ten",
      "R: 2|1|docs|duplicate index is ignored",
      "F: Founded|1999",
      "Z: unknown tag",
      "Q:",
      "C: not sure",
      "garbage after the answer",
    ].join("\n");
    const { events, parser } = feed(text, 4, 2);
    const insights = parser.insights();
    expect(insights.answer).toBe("Short answer [1] [9].");
    expect(insights.citations).toEqual([0]);
    expect(insights.ratings).toEqual([{ index: 1, score: 10, summary: "score clamps to ten", tags: [] }]);
    expect(insights.entity).toBeUndefined();
    expect(insights.followUps).toEqual([]);
    expect(insights.confidence).toBeUndefined();
    expect(events.filter((e) => e.type === "rerank")).toEqual([{ type: "rerank", order: [1, 0] }]);
  });

  it("treats an untagged reply as a plain answer and keeps paragraphs", () => {
    const { events, parser } = feed("First paragraph [1].\n\nSecond paragraph [2].\n", 3, 2);
    expect(parser.insights().answer).toBe("First paragraph [1].\n\nSecond paragraph [2].");
    expect(events.map((e) => e.type).filter((t) => t !== "answer-delta")).toEqual(["answer-done"]);
  });

  it("keeps markdown bullets inside the answer", () => {
    const { parser } = feed("Options:\n- Rust [1]\n- Go [2]\nP: point", 2, 2);
    expect(parser.insights().answer).toBe("Options:\n- Rust [1]\n- Go [2]");
  });

  it("handles multilingual output (Spanish, Japanese, Arabic)", () => {
    const es = feed(
      "La bomba de calor mueve calor del exterior al interior [1].\nP: Usa un refrigerante [1]\nR: 1|9|docs|Guía técnica sobre el ciclo del refrigerante\nC: alta\nD: Las fuentes discrepan sobre la eficiencia",
      6,
      1,
    ).parser.insights();
    expect(es.ratings[0]!.summary).toBe("Guía técnica sobre el ciclo del refrigerante");
    expect(es.confidence).toBe("high");
    expect(es.disagreement).toBe("Las fuentes discrepan sobre la eficiencia");

    const ja = feed("東京は日本の首都です[1]。\nE: 東京|日本の首都\nF: 人口|約1400万人\nQ: 東京の歴史", 1, 1).parser.insights();
    expect(ja.answer).toBe("東京は日本の首都です[1]。");
    expect(ja.entity).toEqual({ title: "東京", description: "日本の首都", facts: [{ label: "人口", value: "約1400万人" }] });

    const ar = feed("القاهرة هي عاصمة مصر [1].\nQ: تاريخ القاهرة", 3, 1).parser.insights();
    expect(ar.answer).toBe("القاهرة هي عاصمة مصر [1].");
    expect(ar.followUps).toEqual(["تاريخ القاهرة"]);
  });

  it("clips summaries to 18 words and caps lists", () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const text = ["A.", `R: 1|5|docs|${long}`, ...Array.from({ length: 8 }, (_, i) => `P: point ${i}`), ...Array.from({ length: 6 }, (_, i) => `Q: q${i}`)].join("\n");
    const insights = feed(text, 9, 1).parser.insights();
    expect(insights.ratings[0]!.summary.split(" ")).toHaveLength(18);
    expect(insights.ratings[0]!.summary.endsWith("…")).toBe(true);
    expect(insights.keyPoints).toHaveLength(5);
    expect(insights.followUps).toHaveLength(3);
  });

  it("emits the entity once its block closes, and finalizes a truncated stream", () => {
    const { events } = feed("Answer.\nE: Ada Lovelace|Mathematician\nF: Born|1815\nR: 1|9|reference|Biog", 4, 2);
    const types = events.map((e) => e.type);
    expect(types).toContain("entity");
    expect(types.at(-1)).toBe("rerank");
    expect(events.find((e) => e.type === "rating")).toMatchObject({ rating: { summary: "Biog" } });
  });

  it("stays within the output budget for a full structured reply", () => {
    // 8 rated sources, 5 points, entity with 5 facts, 3 follow-ups: comfortably under the 700 default cap.
    const reply = [
      SAMPLE,
      "P: extra point about moves and copies [1]",
      "P: extra point about drop order [2]",
      ...[5, 6, 7, 8].map((n) => `R: ${n}|6|docs,forum|A page that discusses one aspect of ownership with code samples`),
      "F: Paradigm|Multi-paradigm",
      "F: Typing|Static, strong",
      "F: License|MIT and Apache 2.0",
    ].join("\n");
    expect(estimateTokens(reply)).toBeLessThan(700);
  });
});

describe("rerankByRating", () => {
  it("is stable and puts unrated results last in retriever order", () => {
    const r = (index: number, score: number) => ({ index, score, summary: "", tags: [] });
    expect(rerankByRating(5, [r(0, 5), r(1, 9), r(3, 5)])).toEqual([1, 0, 3, 2, 4]);
    expect(rerankByRating(3, [])).toEqual([0, 1, 2]);
  });
});
