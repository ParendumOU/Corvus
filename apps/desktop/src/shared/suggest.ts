/** Omnibox suggestions: the typed intent first, then ranked history and bookmark matches. */
import type { Bookmark, HistoryEntry } from "@corvus/shared";
import { classifyOmnibox, intentToUrl } from "./omnibox";

export interface Suggestion {
  kind: "search" | "url" | "history" | "bookmark";
  title: string;
  url: string;
  /** Text shown in the secondary column (usually the URL). */
  detail?: string;
}

const DAY = 86_400_000;

function strip(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "");
}

function score(input: string, title: string, url: string, visitCount: number, visitedAt: number, isBookmark: boolean, now: number): number {
  const u = strip(url).toLowerCase();
  const t = title.toLowerCase();
  const terms = input.split(/\s+/).filter(Boolean);
  if (!terms.every((term) => u.includes(term) || t.includes(term))) return 0;
  let s = 1;
  if (u.startsWith(input)) s += 60;
  else if (u.includes(`.${input}`) || u.includes(`/${input}`)) s += 20;
  if (t.startsWith(input)) s += 25;
  else if (t.split(/\W+/).some((w) => w.startsWith(terms[0] ?? ""))) s += 10;
  if (isBookmark) s += 25;
  s += Math.log2(visitCount + 1) * 8;
  const age = now - visitedAt;
  if (age < DAY) s += 12;
  else if (age < 7 * DAY) s += 6;
  return s;
}

export function buildSuggestions(
  rawInput: string,
  history: readonly HistoryEntry[],
  bookmarks: readonly Bookmark[],
  now: number,
  limit = 7,
): Suggestion[] {
  const input = rawInput.trim();
  if (input.length === 0) return [];
  const lower = input.toLowerCase();
  const intent = classifyOmnibox(input);
  const first: Suggestion =
    intent.kind === "url"
      ? { kind: "url", title: intent.url, url: intent.url, detail: "Open address" }
      : { kind: "search", title: intent.query, url: intentToUrl(intent), detail: "Search with Corvus AI" };

  const scored = new Map<string, { s: Suggestion; score: number }>();
  const offer = (s: Suggestion, value: number): void => {
    if (value <= 0 || s.url === first.url) return;
    const key = strip(s.url).replace(/\/$/, "");
    const current = scored.get(key);
    if (!current || current.score < value) scored.set(key, { s, score: value });
  };

  for (const b of bookmarks) {
    if (b.kind !== "bookmark" || !b.url) continue;
    offer({ kind: "bookmark", title: b.title || b.url, url: b.url, detail: strip(b.url) }, score(lower, b.title, b.url, 0, b.updatedAt, true, now));
  }
  for (const h of history) {
    offer(
      { kind: "history", title: h.title || h.url, url: h.url, detail: strip(h.url) },
      score(lower, h.title, h.url, h.visitCount, h.visitedAt, false, now),
    );
  }

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score).map((x) => x.s);
  return [first, ...ranked].slice(0, limit);
}
