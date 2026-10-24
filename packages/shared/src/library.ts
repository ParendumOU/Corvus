/**
 * Synced bookmarks (collection `bookmarks`, one record per node, keyed by its id) and the reading
 * list (collection `reading`, one record per saved article, keyed by its URL), as the desktop and
 * the mobile app both read and write them.
 */
import type { Bookmark } from "./browser.js";

/** The two fixed root folders every device has; they are never synced. */
export const BAR_FOLDER_ID = "bar";
export const OTHER_FOLDER_ID = "other";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A bookmark or folder received from another device (roots excluded: their parent is never null). */
export function isSyncedBookmark(v: unknown): v is Bookmark {
  if (!isObject(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.parentId === "string" &&
    (v.kind === "folder" || (v.kind === "bookmark" && typeof v.url === "string")) &&
    typeof v.title === "string" &&
    typeof v.position === "number" &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}

export interface ReadingItem {
  id: string;
  url: string;
  title: string;
  siteName: string;
  byline: string;
  excerpt: string;
  /** Export-ready article Markdown (header + body). Empty for a link saved without its article. */
  markdown: string;
  /** AI key points captured at save time. */
  keyPoints: string[];
  wordCount: number;
  readingMinutes: number;
  savedAt: number;
  /** When it was marked read; absent while unread. */
  readAt?: number;
}

/** Shape guard for a persisted/synced reading item (tolerant of older records missing optional fields). */
export function isReadingItem(value: unknown): value is ReadingItem {
  const v = value as Partial<ReadingItem> | null;
  return (
    typeof v?.id === "string" &&
    typeof v.url === "string" &&
    typeof v.title === "string" &&
    typeof v.markdown === "string" &&
    typeof v.savedAt === "number" &&
    Array.isArray(v.keyPoints) &&
    (v.readAt === undefined || typeof v.readAt === "number")
  );
}

/** A link saved without its article (from the phone): a computer with Corvus fills the article in. */
export function isLinkOnly(item: Pick<ReadingItem, "markdown" | "wordCount">): boolean {
  return item.markdown === "" && !item.wordCount;
}

/** A reading list entry for a link alone, as the phone saves it. */
export function linkOnlyReadingItem(id: string, url: string, title: string, now: number): ReadingItem {
  let siteName = "";
  try {
    siteName = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // isSyncableTabUrl was checked by the caller.
  }
  return { id, url, title, siteName, byline: "", excerpt: "", markdown: "", keyPoints: [], wordCount: 0, readingMinutes: 0, savedAt: now };
}

/** The same item marked read (now) or unread (null). */
export function withReadState(item: ReadingItem, readAt: number | null): ReadingItem {
  const { readAt: _previous, ...rest } = item;
  return readAt === null ? rest : { ...rest, readAt };
}
