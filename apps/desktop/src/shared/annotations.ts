/**
 * Pure, unit-tested helpers for page annotations (highlights + notes): the stored record shape, a
 * robust text-quote anchor (W3C TextQuoteSelector-style exact + prefix/suffix context), the
 * re-anchoring algorithm used to re-apply a saved highlight on the next visit, URL normalization,
 * grouping for the manager, and Markdown export.
 *
 * None of this touches the DOM. The tab preload builds the page's text (whitespace collapsed) and an
 * offset map, calls locateAnchor() to find character offsets, then maps those offsets back to a Range.
 */

export const ANNOTATION_COLORS = ["yellow", "green", "blue", "pink", "orange"] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

/** Highlight background colors, shared by the in-page renderer (preload) and the manager UI. */
export const ANNOTATION_COLOR_HEX: Record<AnnotationColor, string> = {
  yellow: "#fff18c",
  green: "#b6f2c0",
  blue: "#bcdcff",
  pink: "#ffc4de",
  orange: "#ffd4a3",
};

/** Caps keep the store bounded and local-first. */
export const MAX_ANNOTATIONS = 2000;
export const MAX_ANNOTATIONS_PER_PAGE = 200;
export const MAX_NOTE_CHARS = 2000;
export const MAX_QUOTE_CHARS = 1000;
/** How much surrounding text is captured on each side of the quote for disambiguation. */
export const ANCHOR_CONTEXT_CHARS = 32;

export interface AnnotationAnchor {
  /** The exact selected text (the TextQuoteSelector "exact" field). */
  quote: string;
  /** Up to ANCHOR_CONTEXT_CHARS of text immediately before the quote. */
  prefix: string;
  /** Up to ANCHOR_CONTEXT_CHARS of text immediately after the quote. */
  suffix: string;
}

export interface Annotation {
  id: string;
  /** Normalized page URL (fragment stripped); keys the per-page re-application. */
  url: string;
  pageTitle: string;
  color: AnnotationColor;
  /** May be empty (a bare highlight). */
  note: string;
  anchor: AnnotationAnchor;
  createdAt: number;
  updatedAt: number;
}

export function isAnnotationColor(value: unknown): value is AnnotationColor {
  return typeof value === "string" && (ANNOTATION_COLORS as readonly string[]).includes(value);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isAnnotationAnchor(value: unknown): value is AnnotationAnchor {
  if (!isObject(value)) return false;
  return typeof value.quote === "string" && typeof value.prefix === "string" && typeof value.suffix === "string" && value.quote.length > 0;
}

/** Shape guard for a persisted/synced annotation. Enforces the quote/note caps so bad records are dropped. */
export function isAnnotation(value: unknown): value is Annotation {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.url === "string" &&
    typeof value.pageTitle === "string" &&
    isAnnotationColor(value.color) &&
    typeof value.note === "string" &&
    value.note.length <= MAX_NOTE_CHARS &&
    isAnnotationAnchor(value.anchor) &&
    value.anchor.quote.length <= MAX_QUOTE_CHARS &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

export function clampNote(note: string): string {
  return note.replace(/\u0000/g, "").slice(0, MAX_NOTE_CHARS);
}

/**
 * Normalize a page URL for keying annotations: drop the fragment (#...), keep origin + path + query.
 * Two visits to the same page (ignoring the in-page anchor) share one annotation bucket.
 */
export function normalizePageUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url.trim();
  }
}

/** Only public web pages carry annotations (mirrors the injection guard). */
export function isAnnotatableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Builds a text-quote anchor from a [start, end) character range within the page's normalized text. */
export function buildAnchor(fullText: string, start: number, end: number): AnnotationAnchor {
  const s = Math.max(0, Math.min(start, fullText.length));
  const e = Math.max(s, Math.min(end, fullText.length));
  return {
    quote: fullText.slice(s, e),
    prefix: fullText.slice(Math.max(0, s - ANCHOR_CONTEXT_CHARS), s),
    suffix: fullText.slice(e, e + ANCHOR_CONTEXT_CHARS),
  };
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function allIndexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/**
 * Re-anchors a saved annotation in the page's current text. Returns the best-matching [start, end)
 * character range, or null when the quoted text no longer appears (the annotation is orphaned and the
 * caller simply skips it). When the quote appears several times, the prefix/suffix context picks the
 * occurrence whose surroundings match best.
 */
export function locateAnchor(fullText: string, anchor: AnnotationAnchor): { start: number; end: number } | null {
  const quote = anchor.quote;
  if (!quote) return null;
  const hits = allIndexesOf(fullText, quote);
  if (hits.length === 0) return null;
  if (hits.length === 1) {
    const i = hits[0] as number;
    return { start: i, end: i + quote.length };
  }
  let best = hits[0] as number;
  let bestScore = -1;
  for (const i of hits) {
    const before = fullText.slice(Math.max(0, i - anchor.prefix.length), i);
    const after = fullText.slice(i + quote.length, i + quote.length + anchor.suffix.length);
    const score = commonSuffixLen(anchor.prefix, before) + commonPrefixLen(anchor.suffix, after);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return { start: best, end: best + quote.length };
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Case-insensitive match over note, page title, host and quoted text; newest first. */
export function searchAnnotations(items: Annotation[], query: string): Annotation[] {
  const q = query.trim().toLowerCase();
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
  if (!q) return sorted;
  return sorted.filter((a) =>
    [a.note, a.pageTitle, host(a.url), a.anchor.quote].join(" ").toLowerCase().includes(q),
  );
}

export interface AnnotationPageGroup {
  url: string;
  title: string;
  items: Annotation[];
}

/** Groups annotations by page, pages ordered by most recently touched, items within a page oldest first. */
export function groupAnnotationsByPage(items: Annotation[]): AnnotationPageGroup[] {
  const byUrl = new Map<string, AnnotationPageGroup>();
  for (const a of items) {
    let group = byUrl.get(a.url);
    if (!group) {
      group = { url: a.url, title: a.pageTitle || a.url, items: [] };
      byUrl.set(a.url, group);
    }
    if (a.pageTitle) group.title = a.pageTitle;
    group.items.push(a);
  }
  const groups = [...byUrl.values()];
  for (const g of groups) g.items.sort((a, b) => a.createdAt - b.createdAt);
  groups.sort((a, b) => Math.max(...b.items.map((i) => i.updatedAt)) - Math.max(...a.items.map((i) => i.updatedAt)));
  return groups;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Full Markdown export of all annotations, grouped by page (reuses the reading library's export style). */
export function annotationsToMarkdown(items: Annotation[]): string {
  const groups = groupAnnotationsByPage(items);
  const parts: string[] = ["# Annotations"];
  for (const g of groups) {
    const section: string[] = [`## ${g.title}`, `<${g.url}>`];
    for (const a of g.items) {
      const quote = oneLine(a.anchor.quote);
      let block = `> ${quote} _(${a.color})_`;
      if (a.note.trim()) block += `\n\n${a.note.trim()}`;
      section.push(block);
    }
    parts.push(section.join("\n\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

export function annotationsExportFilename(): string {
  return "annotations.md";
}
