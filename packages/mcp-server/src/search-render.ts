import type { SearchInsights, SearchResult } from "@corvus/shared";
import { truncate } from "./content.js";

const SNIPPET_CHARS = 300;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function verticalMeta(r: SearchResult): string {
  const parts = [r.age ?? r.publishedAt?.slice(0, 10), r.publisher, r.duration].filter(Boolean);
  if (r.image) parts.push(`img ${r.image.src}${r.image.width && r.image.height ? ` ${r.image.width}x${r.image.height}` : ""}`);
  return parts.join(" · ");
}

/**
 * Compact, agent-oriented text for web_search. Results keep their retriever number [n] (what
 * citations refer to) but are listed in AI order when ratings exist; the AI one-liner replaces
 * the 300-char snippet, which keeps the output small.
 */
export function renderSearch(results: SearchResult[], answer: string, insights?: SearchInsights): string {
  const lines: string[] = [];
  const text = (insights?.answer || answer).trim();
  if (text) lines.push(`answer: ${text}`);
  if (insights?.confidence || insights?.disagreement) {
    const parts = [insights.confidence ? `confidence: ${insights.confidence}` : ""];
    if (insights.disagreement) parts.push(`sources disagree: ${oneLine(insights.disagreement)}`);
    lines.push(parts.filter(Boolean).join("; "));
  }
  if (insights?.keyPoints.length) {
    lines.push("points:");
    for (const p of insights.keyPoints) lines.push(`- ${oneLine(p.text)}`);
  }
  if (insights?.entity) {
    const e = insights.entity;
    const facts = e.facts.map((f) => `${f.label}: ${f.value}`).join("; ");
    lines.push(`entity: ${e.title} - ${oneLine(e.description)}${facts ? ` | ${facts}` : ""}`);
  }

  const ratings = new Map((insights?.ratings ?? []).map((r) => [r.index, r]));
  const order = ratings.size && insights ? insights.order : results.map((_, i) => i);
  if (results.length && ratings.size) lines.push("results (best first; score/10, [n] = citation):");
  for (const i of order) {
    const r = results[i];
    if (!r) continue;
    const rating = ratings.get(i);
    const head = [`[${i + 1}]`, rating ? `${rating.score}/10` : "", r.title, "|", r.url].filter(Boolean).join(" ");
    const tags = rating?.tags.length ? ` | ${rating.tags.join(",")}` : "";
    const meta = verticalMeta(r);
    lines.push(`${head}${tags}${meta ? ` | ${meta}` : ""}`);
    if (rating?.summary) lines.push(rating.summary);
    else if (r.snippet) lines.push(truncate(oneLine(r.snippet), SNIPPET_CHARS).text);
  }
  if (insights?.followUps.length) lines.push(`next: ${insights.followUps.map(oneLine).join(" | ")}`);
  return lines.length ? lines.join("\n") : "no results";
}
