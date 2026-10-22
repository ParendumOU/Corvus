import type { Confidence, EntityCard, KeyPoint, ResultRating, ResultTag, SearchInsights } from "@corvus/shared";
import { parseCitations } from "./prompt.js";
import { collapseWhitespace } from "./text.js";

/**
 * Line protocol of the single structured LLM call (see SYSTEM_PROMPT):
 *
 *   <answer: 1-3 sentences with [n] citations, untagged, may span lines>
 *   P: key point [n]                 3-5 lines
 *   R: n|score|tag,tag|summary       one per source
 *   E: name|description              only for entity queries
 *   F: label|value                   up to 5 facts for E
 *   Q: follow-up search              3 lines
 *   C: high|medium|low
 *   D: what the sources disagree on  only when they conflict
 *
 * The answer streams character by character; every other record is emitted once its line is
 * complete. Unknown, malformed and out-of-range lines are dropped, never fatal.
 */

export const RESULT_TAGS: readonly ResultTag[] = [
  "official",
  "docs",
  "reference",
  "news",
  "forum",
  "video",
  "academic",
  "opinion",
  "shopping",
  "outdated",
  "paywall",
];

const TAG_ALIASES: Record<string, ResultTag> = {
  documentation: "docs",
  doc: "docs",
  wiki: "reference",
  encyclopedia: "reference",
  blog: "opinion",
  community: "forum",
  qa: "forum",
  paper: "academic",
  research: "academic",
  shop: "shopping",
  store: "shopping",
  old: "outdated",
  paywalled: "paywall",
};

export const SUMMARY_MAX_WORDS = 18;
const SUMMARY_MAX_CHARS = 140;
const MAX_KEY_POINTS = 5;
const MAX_FOLLOW_UPS = 3;
const MAX_FACTS = 5;

export type StructuredEvent =
  | { type: "answer-delta"; text: string }
  | { type: "answer-done"; text: string; citations: number[] }
  | { type: "key-point"; point: KeyPoint }
  | { type: "rating"; rating: ResultRating }
  | { type: "rerank"; order: number[] }
  | { type: "entity"; entity: EntityCard }
  | { type: "follow-up"; question: string }
  | { type: "confidence"; level: Confidence | null; sourcesDisagree: boolean; note?: string };

type Section = "A" | "P" | "R" | "E" | "F" | "Q" | "C" | "D";
const SECTIONS = new Set<string>(["A", "P", "R", "E", "F", "Q", "C", "D"]);

// "P:", "- P:", "**P:**", "P :", "P：" (full-width colon from CJK output).
const TAG_LINE = /^[\s\-*•>]*\**([A-Za-z])\**\s?\**\s?[:：]\**\s*/;
// A line start that could still turn into TAG_LINE once more characters arrive.
const TAG_PREFIX = /^[\s\-*•>]*\**(?:[A-Za-z]\**\s?\**)?$/;

/** Stable re-rank: rated results by score (desc), ties and unrated keep retriever order, unrated last. */
export function rerankByRating(count: number, ratings: ResultRating[]): number[] {
  const score = new Map(ratings.map((r) => [r.index, r.score]));
  return Array.from({ length: count }, (_, i) => i).sort((a, b) => {
    const sa = score.get(a) ?? -1;
    const sb = score.get(b) ?? -1;
    return sb - sa || a - b;
  });
}

function clipSummary(text: string): string {
  const clean = collapseWhitespace(text).replace(/^["'“”]+|["'“”]+$/g, "");
  const words = clean.split(" ");
  let out = words.length > SUMMARY_MAX_WORDS ? `${words.slice(0, SUMMARY_MAX_WORDS).join(" ")}…` : clean;
  if (out.length > SUMMARY_MAX_CHARS) out = `${out.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  return out;
}

function parseTags(raw: string): ResultTag[] {
  const out: ResultTag[] = [];
  for (const part of raw.split(/[,;/\s]+/)) {
    const key = part.toLowerCase().replace(/[^a-z]/g, "");
    const tag = (RESULT_TAGS as readonly string[]).includes(key) ? (key as ResultTag) : TAG_ALIASES[key];
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 4);
}

function parseConfidence(raw: string): Confidence | null {
  const lower = raw.toLowerCase();
  if (/\bhigh\b|alta|alto|haute|élevée|hoch|高/.test(lower)) return "high";
  if (/\bmedium\b|\bmid\b|moderate|media|medio|moyenne|mittel|中/.test(lower)) return "medium";
  if (/\blow\b|baja|bajo|faible|basse|niedrig|低/.test(lower)) return "low";
  return null;
}

function stripListMarker(text: string): string {
  return text.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/^\*\*|\*\*$/g, "").trim();
}

export class StructuredAnswerParser {
  private buffer = "";
  /** How the current (incomplete) line is handled: undecided, streamed as answer, or buffered as a record. */
  private lineMode: "pending" | "answer" | "record" = "pending";
  private section: Section | null = null;
  private answerOpen = true;
  private answer = "";
  private pendingNewlines = 0;

  private readonly keyPoints: KeyPoint[] = [];
  private readonly ratings: ResultRating[] = [];
  private order: number[] | null = null;
  private readonly followUps: string[] = [];
  private entity: EntityCard | null = null;
  private entityEmitted = false;
  private confidence: Confidence | null = null;
  private disagreement = "";

  constructor(private readonly sourceCount: number) {}

  push(chunk: string): StructuredEvent[] {
    const out: StructuredEvent[] = [];
    this.buffer += chunk.replace(/\r/g, "");
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.completeLine(line, out);
    }
    this.partialLine(out);
    return out;
  }

  end(): StructuredEvent[] {
    const out: StructuredEvent[] = [];
    if (this.buffer) {
      const line = this.buffer;
      this.buffer = "";
      this.completeLine(line, out);
    }
    this.enter(null, out);
    if (this.confidence || this.disagreement) {
      out.push({
        type: "confidence",
        level: this.confidence,
        sourcesDisagree: Boolean(this.disagreement),
        ...(this.disagreement ? { note: this.disagreement } : {}),
      });
    }
    return out;
  }

  insights(): SearchInsights {
    const answer = this.answer.trim();
    return {
      answer,
      citations: parseCitations(answer, this.sourceCount),
      keyPoints: [...this.keyPoints],
      ratings: [...this.ratings],
      order: this.order ?? rerankByRating(this.sourceCount, this.ratings),
      followUps: [...this.followUps],
      ...(this.entity ? { entity: this.entity } : {}),
      ...(this.confidence ? { confidence: this.confidence } : {}),
      ...(this.disagreement ? { disagreement: this.disagreement } : {}),
    };
  }

  /** Decides what the incomplete tail of the buffer is and streams answer text as soon as it is safe. */
  private partialLine(out: StructuredEvent[]): void {
    if (this.lineMode === "pending" && this.buffer) {
      const tag = TAG_LINE.exec(this.buffer);
      if (tag && SECTIONS.has(tag[1]!.toUpperCase())) {
        const section = tag[1]!.toUpperCase() as Section;
        if (section === "A" && this.answerOpen) {
          this.buffer = this.buffer.slice(tag[0].length);
          this.lineMode = "answer";
          this.enter("A", out);
        } else {
          this.lineMode = "record";
        }
      } else if (TAG_PREFIX.test(this.buffer)) {
        return;
      } else {
        this.lineMode = this.answerOpen ? "answer" : "record";
        if (this.answerOpen) this.enter("A", out);
      }
    }
    if (this.lineMode === "answer" && this.buffer) {
      this.emitAnswer(this.buffer, out);
      this.buffer = "";
    }
  }

  private completeLine(line: string, out: StructuredEvent[]): void {
    const mode = this.lineMode;
    this.lineMode = "pending";
    if (mode === "answer") {
      this.emitAnswer(line, out);
      this.pendingNewlines++;
      return;
    }
    if (!line.trim()) {
      if (this.section === "A" && this.answer) this.pendingNewlines++;
      return;
    }
    const tag = TAG_LINE.exec(line);
    const section = tag ? tag[1]!.toUpperCase() : "";
    if (tag && SECTIONS.has(section)) {
      const body = line.slice(tag[0].length).trim();
      if (section === "A") {
        if (!this.answerOpen) return;
        this.enter("A", out);
        this.emitAnswer(body, out);
        this.pendingNewlines++;
        return;
      }
      this.enter(section as Section, out);
      this.record(section as Section, body, out);
      return;
    }
    if (this.answerOpen) {
      this.enter("A", out);
      this.emitAnswer(line, out);
      this.pendingNewlines++;
    }
    // Untagged text after the answer (headings like "Key points:", stray prose) is dropped.
  }

  private emitAnswer(text: string, out: StructuredEvent[]): void {
    if (!text) return;
    if (!this.answer) {
      text = text.replace(/^\s+/, "");
      if (!text) return;
      this.pendingNewlines = 0;
    }
    const prefix = this.pendingNewlines ? "\n".repeat(Math.min(2, this.pendingNewlines)) : "";
    this.pendingNewlines = 0;
    const delta = prefix + text;
    this.answer += delta;
    out.push({ type: "answer-delta", text: delta });
  }

  /** Section transitions close the previous block (answer-done, rerank, entity). */
  private enter(next: Section | null, out: StructuredEvent[]): void {
    if (next === this.section) return;
    const prev = this.section;
    if (next !== "A" && this.answerOpen) {
      this.answerOpen = false;
      // A trailing "Key points:"-style heading before the tagged records is not part of the answer.
      const text = this.answer.trim().replace(/\n+[^\n[]{1,40}[:：]$/, "");
      this.answer = text;
      out.push({ type: "answer-done", text, citations: parseCitations(text, this.sourceCount) });
    }
    if (prev === "R" && this.ratings.length && !this.order) {
      this.order = rerankByRating(this.sourceCount, this.ratings);
      out.push({ type: "rerank", order: this.order });
    }
    if ((prev === "E" || prev === "F") && next !== "E" && next !== "F") this.emitEntity(out);
    this.section = next;
    if (next === null && this.ratings.length && !this.order) {
      this.order = rerankByRating(this.sourceCount, this.ratings);
      out.push({ type: "rerank", order: this.order });
    }
    if (next === null) this.emitEntity(out);
  }

  private emitEntity(out: StructuredEvent[]): void {
    if (!this.entity || this.entityEmitted) return;
    this.entityEmitted = true;
    out.push({ type: "entity", entity: this.entity });
  }

  private record(section: Section, body: string, out: StructuredEvent[]): void {
    switch (section) {
      case "P": {
        const text = stripListMarker(body);
        if (!text || this.keyPoints.length >= MAX_KEY_POINTS) return;
        const point = { text, citations: parseCitations(text, this.sourceCount) };
        this.keyPoints.push(point);
        out.push({ type: "key-point", point });
        return;
      }
      case "R": {
        const rating = this.parseRating(body);
        if (!rating || this.ratings.some((r) => r.index === rating.index)) return;
        this.ratings.push(rating);
        out.push({ type: "rating", rating });
        return;
      }
      case "E": {
        if (this.entity) return;
        const [title = "", ...rest] = body.split("|").map((s) => s.trim());
        const cleanTitle = stripListMarker(title);
        if (!cleanTitle) return;
        this.entity = { title: cleanTitle, description: collapseWhitespace(rest.join(" ")), facts: [] };
        return;
      }
      case "F": {
        if (!this.entity || this.entity.facts.length >= MAX_FACTS) return;
        const split = body.includes("|") ? body.indexOf("|") : body.indexOf(":");
        if (split <= 0) return;
        const label = stripListMarker(body.slice(0, split));
        const value = collapseWhitespace(body.slice(split + 1));
        if (label && value) this.entity.facts.push({ label, value });
        return;
      }
      case "Q": {
        const question = stripListMarker(body).replace(/^["'“]+|["'”]+$/g, "");
        if (!question || this.followUps.length >= MAX_FOLLOW_UPS || this.followUps.includes(question)) return;
        this.followUps.push(question);
        out.push({ type: "follow-up", question });
        return;
      }
      case "C": {
        const [level = "", note] = body.split("|");
        this.confidence ??= parseConfidence(level);
        if (note?.trim() && !this.disagreement) this.disagreement = collapseWhitespace(note);
        return;
      }
      case "D": {
        const note = collapseWhitespace(body);
        if (note && !/^(none|no|n\/a|-)\.?$/i.test(note) && !this.disagreement) this.disagreement = note;
        return;
      }
      default:
    }
  }

  /** "3|8|docs,official|summary", tolerating "[3]", "8/10", "8.5" and a missing tags field. */
  private parseRating(body: string): ResultRating | null {
    const parts = body.split("|").map((s) => s.trim());
    if (parts.length < 2) return null;
    const index = Number(/\d+/.exec(parts[0] ?? "")?.[0]);
    const scoreMatch = /(\d+(?:[.,]\d+)?)/.exec(parts[1] ?? "");
    if (!Number.isInteger(index) || index < 1 || index > this.sourceCount || !scoreMatch) return null;
    const score = Math.max(0, Math.min(10, Math.round(Number(scoreMatch[1]!.replace(",", ".")))));
    let tags: ResultTag[] = [];
    let summary = "";
    if (parts.length >= 4) {
      tags = parseTags(parts[2] ?? "");
      summary = parts.slice(3).join(" ");
    } else if (parts.length === 3) {
      const maybeTags = parseTags(parts[2] ?? "");
      // A third field made only of tag words is the tag list; otherwise it is the summary.
      if (maybeTags.length && (parts[2] ?? "").split(/[,;/\s]+/).filter(Boolean).length <= 4) tags = maybeTags;
      else summary = parts[2] ?? "";
    }
    return { index: index - 1, score, summary: clipSummary(summary), tags };
  }
}
