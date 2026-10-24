/**
 * Pure, unit-tested helpers for the reading library (saved reader-mode articles): the stored record
 * shape, search, Markdown export composition and the sentence splitter used by read-aloud.
 */
import type { ReadingItem } from "@corvus/shared";

export { isLinkOnly, isReadingItem, linkOnlyReadingItem, withReadState, type ReadingItem } from "@corvus/shared";

/** List view of a saved item, without the large Markdown body. */
export type ReadingSummary = Omit<ReadingItem, "markdown">;

export function readingSummary(item: ReadingItem): ReadingSummary {
  const { markdown: _markdown, ...summary } = item;
  return summary;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Case-insensitive match over title, site, host, byline and key points; newest first. */
export function searchReadingItems<T extends ReadingSummary>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const sorted = [...items].sort((a, b) => b.savedAt - a.savedAt);
  if (!q) return sorted;
  return sorted.filter((item) =>
    [item.title, item.siteName, host(item.url), item.byline, item.excerpt, ...item.keyPoints]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

/** Splits the article's stored header from its body, using the `<url>` marker articleToMarkdown emits. */
function splitStoredMarkdown(item: ReadingItem): { header: string; body: string } {
  const marker = `<${item.url}>`;
  const idx = item.markdown.indexOf(marker);
  if (idx < 0) return { header: "", body: item.markdown.trim() };
  const end = idx + marker.length;
  return { header: item.markdown.slice(0, end).trim(), body: item.markdown.slice(end).trim() };
}

/** Full Markdown export for one saved item: header, AI key points, then the article body. */
export function readingItemToMarkdown(item: ReadingItem): string {
  const { header, body } = splitStoredMarkdown(item);
  const parts: string[] = [];
  parts.push(header || `# ${item.title}\n\n<${item.url}>`);
  if (item.keyPoints.length > 0) {
    parts.push(`## Key points\n\n${item.keyPoints.map((p) => `- ${p}`).join("\n")}`);
  }
  if (body) parts.push(body);
  return `${parts.join("\n\n")}\n`;
}

/** A safe-ish Markdown filename from the article title. */
export function readingExportFilename(item: ReadingItem): string {
  const slug = item.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "article"}.md`;
}

const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Co|No|Fig|Vol|pp|al|e\.g|i\.e)\./gi;
const DOT = "\u0001";

/**
 * Splits text into sentences for read-aloud highlighting. Keeps terminal punctuation and avoids
 * breaking on decimals (3.5) and common abbreviations (Dr., e.g.). Returns a single chunk when the
 * text has no sentence-ending punctuation.
 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const guarded = normalized
    .replace(/(\d)\.(\d)/g, `$1${DOT}$2`)
    .replace(ABBREVIATIONS, (m) => m.replace(/\./g, DOT));
  const parts = guarded.match(/[^.!?…]+[.!?…]+["'”’)\]]*(?=\s|$)|[^.!?…]+$/g);
  const out = (parts ?? [guarded]).map((p) => p.replace(new RegExp(DOT, "g"), ".").trim()).filter(Boolean);
  return out.length > 0 ? out : [normalized];
}
