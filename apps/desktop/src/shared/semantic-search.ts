/**
 * Pure, unit-tested core of the local "find in my stuff" search over the user's own history,
 * bookmarks and reading library. No Electron, no network, no I/O so it runs the same in the main
 * process, in tests and (for display helpers) in the renderer.
 *
 * Ranking is a two-stage pipeline:
 *   1. BM25 keyword scoring — always available, no network. Narrows the whole index to a small
 *      candidate set.
 *   2. Optional embedding re-rank — when a local/OpenAI-compatible embedding endpoint is configured
 *      the caller embeds the query and the candidates and blends cosine similarity into the score.
 *      This file only owns the pure math (`cosineSimilarity`, `blendScores`); the HTTP lives in the
 *      main-process service. With no embeddings the BM25 order is returned unchanged.
 */

export type IndexDocKind = "history" | "bookmark" | "reading";

/** One indexed page: a visited URL, a bookmark or a saved reader-mode article. */
export interface IndexDoc {
  /** Stable id = `${kind}:${url}`; the same URL in two sources is two docs. */
  id: string;
  kind: IndexDocKind;
  url: string;
  title: string;
  /** Captured text snippet (readable page text / excerpt), already whitespace-collapsed and capped. */
  text: string;
  /** Last update time (last visit / save), epoch ms. Used for recency tie-breaks and capping. */
  ts: number;
}

export interface ScoredDoc {
  doc: IndexDoc;
  /** BM25 keyword score (unbounded, higher is better). */
  keywordScore: number;
}

export interface RankedDoc extends ScoredDoc {
  /** Final blended score after optional semantic re-rank. */
  score: number;
  /** Cosine similarity used in the blend, when embeddings were applied. */
  semanticScore?: number;
}

/** Hard cap on indexed docs per source kind, newest kept. Keeps the JSON store small and queries cheap. */
export const MAX_DOCS_PER_KIND = 4000;
/** Captured snippet length ceiling (characters). */
export const MAX_SNIPPET_CHARS = 600;
/** Display snippet window length. */
export const DISPLAY_SNIPPET_CHARS = 180;
/** How many BM25 candidates to hand to the (optional, costlier) embedding re-rank. */
export const CANDIDATE_LIMIT = 48;

const K1 = 1.5;
const B = 0.75;
/** Title terms count this many times in the term-frequency model (a title hit beats a body hit). */
const TITLE_WEIGHT = 3;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be",
  "by", "with", "at", "as", "it", "this", "that", "from", "how", "what", "when", "where", "why",
  "i", "my", "me", "about", "find", "page",
]);

/** Lowercase word tokens: letters/digits runs, 2+ chars, stopwords dropped. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** Query tokens WITHOUT stopword removal of single meaningful words, but length>=2 still applies. */
export function queryTokens(query: string): string[] {
  const toks = tokenize(query);
  // If stopword stripping emptied the query (e.g. "how to"), fall back to raw length>=2 tokens.
  if (toks.length > 0) return toks;
  return query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/** Weighted term-frequency map for one doc: title terms counted TITLE_WEIGHT times, plus body + host. */
function docTerms(doc: IndexDoc): { tf: Map<string, number>; length: number } {
  const tf = new Map<string, number>();
  let length = 0;
  const add = (tokens: string[], weight: number): void => {
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + weight);
      length += weight;
    }
  };
  add(tokenize(doc.title), TITLE_WEIGHT);
  add(tokenize(doc.text), 1);
  add(tokenize(hostOf(doc.url)), 1);
  return { tf, length };
}

/** BM25 ranking over the whole corpus. Returns matches only (docs sharing >=1 query term), best first. */
export function bm25Rank(docs: readonly IndexDoc[], query: string, limit = CANDIDATE_LIMIT): ScoredDoc[] {
  const terms = queryTokens(query);
  if (terms.length === 0 || docs.length === 0) return [];

  const prepared = docs.map((doc) => ({ doc, ...docTerms(doc) }));
  const n = prepared.length;
  const avgdl = prepared.reduce((sum, p) => sum + p.length, 0) / n || 1;

  const df = new Map<string, number>();
  for (const term of new Set(terms)) {
    let count = 0;
    for (const p of prepared) if (p.tf.has(term)) count++;
    df.set(term, count);
  }

  const idf = new Map<string, number>();
  for (const [term, count] of df) idf.set(term, Math.log(1 + (n - count + 0.5) / (count + 0.5)));

  const scored: ScoredDoc[] = [];
  for (const p of prepared) {
    let score = 0;
    for (const term of terms) {
      const f = p.tf.get(term);
      if (!f) continue;
      const termIdf = idf.get(term) ?? 0;
      score += termIdf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * p.length) / avgdl)));
    }
    if (score > 0) scored.push({ doc: p.doc, keywordScore: score });
  }

  scored.sort((a, b) => b.keywordScore - a.keywordScore || b.doc.ts - a.doc.ts);
  return scored.slice(0, limit);
}

/** Cosine similarity of two equal-length vectors; 0 when either is degenerate. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Min-max normalize to 0..1; a flat array maps to all-1 so keyword order is preserved. */
function normalize(values: number[]): number[] {
  if (values.length === 0) return values;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-9) return values.map(() => 1);
  return values.map((v) => (v - min) / (max - min));
}

const KEYWORD_WEIGHT = 0.4;
const SEMANTIC_WEIGHT = 0.6;

/**
 * Blend BM25 and cosine scores into final ranked order. `semantic` may be shorter/empty; where a
 * cosine value is absent the keyword score alone decides. Keyword weight stays non-zero so an exact
 * title match is never buried by a merely-related page.
 */
export function blendScores(candidates: ScoredDoc[], semantic: number[]): RankedDoc[] {
  if (candidates.length === 0) return [];
  const normKw = normalize(candidates.map((c) => c.keywordScore));
  const hasSemantic = semantic.length === candidates.length && semantic.some((s) => s > 0);
  const ranked: RankedDoc[] = candidates.map((c, i) => {
    if (!hasSemantic) return { ...c, score: c.keywordScore };
    const sem = semantic[i] ?? 0;
    return { ...c, semanticScore: sem, score: KEYWORD_WEIGHT * normKw[i]! + SEMANTIC_WEIGHT * sem };
  });
  ranked.sort((a, b) => b.score - a.score || b.doc.ts - a.doc.ts);
  return ranked;
}

/** Host of a URL, or "" when unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Collapse whitespace and cap raw captured text for storage. */
export function makeSnippet(raw: string, max = MAX_SNIPPET_CHARS): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

/** A short display window around the first matching query term, else the start of the text. */
export function snippetAround(text: string, query: string, max = DISPLAY_SNIPPET_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const terms = queryTokens(query);
  const lower = clean.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (at < 0 || idx < at)) at = idx;
  }
  if (at < 0) return `${clean.slice(0, max).trimEnd()}…`;
  const start = Math.max(0, at - Math.floor(max / 3));
  const end = Math.min(clean.length, start + max);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${end < clean.length ? "…" : ""}`;
}

export function docId(kind: IndexDocKind, url: string): string {
  return `${kind}:${url}`;
}

/**
 * Insert or replace a doc (keyed by id), then keep only the newest MAX_DOCS_PER_KIND of each kind.
 * Returns a new array; the input is never mutated.
 */
export function upsertDoc(list: readonly IndexDoc[], doc: IndexDoc, maxPerKind = MAX_DOCS_PER_KIND): IndexDoc[] {
  const next = list.filter((d) => d.id !== doc.id);
  next.push(doc);
  return capByKind(next, maxPerKind);
}

export function removeDocUrl(list: readonly IndexDoc[], url: string): IndexDoc[] {
  return list.filter((d) => d.url !== url);
}

/** Enforce the per-kind cap, dropping the oldest docs of any over-cap kind. */
export function capByKind(list: readonly IndexDoc[], maxPerKind = MAX_DOCS_PER_KIND): IndexDoc[] {
  const counts = new Map<IndexDocKind, number>();
  for (const d of list) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  if ([...counts.values()].every((c) => c <= maxPerKind)) return [...list];
  const byKindNewest = [...list].sort((a, b) => b.ts - a.ts);
  const kept: IndexDoc[] = [];
  const perKind = new Map<IndexDocKind, number>();
  for (const d of byKindNewest) {
    const used = perKind.get(d.kind) ?? 0;
    if (used >= maxPerKind) continue;
    perKind.set(d.kind, used + 1);
    kept.push(d);
  }
  return kept;
}
