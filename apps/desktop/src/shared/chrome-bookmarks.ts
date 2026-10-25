import type { Bookmark } from "@corvus/shared";
import { ROOT_IDS, childrenOf } from "./bookmark-tree";

/**
 * chrome.bookmarks over Corvus's bookmark list: Chrome's node shape, search, and the events a
 * change between two versions of the list amounts to. Pure, so the main process and the tests share
 * it. Corvus's two root folders (bar and other bookmarks) sit under Chrome's invisible root "0".
 */
export const CHROME_ROOT_ID = "0";

export interface ChromeBookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  dateAdded: number;
  dateGroupModified?: number;
  children?: ChromeBookmarkNode[];
}

const indexIn = (list: Bookmark[], node: Bookmark): number => childrenOf(list, node.parentId).findIndex((b) => b.id === node.id);

/** One node in Chrome's shape, with its children when asked (recursively). */
export function toChromeNode(list: Bookmark[], node: Bookmark, withChildren = false): ChromeBookmarkNode {
  const folder = node.kind === "folder";
  return {
    id: node.id,
    parentId: node.parentId ?? CHROME_ROOT_ID,
    index: indexIn(list, node),
    title: node.title,
    ...(folder ? {} : { url: node.url ?? "" }),
    dateAdded: node.createdAt,
    ...(folder ? { dateGroupModified: node.updatedAt } : {}),
    ...(folder && withChildren ? { children: childrenOf(list, node.id).map((c) => toChromeNode(list, c, true)) } : {}),
  };
}

/** chrome.bookmarks.getTree(): the invisible root with every folder below it. */
export function chromeTree(list: Bookmark[]): ChromeBookmarkNode[] {
  return [{ id: CHROME_ROOT_ID, title: "", dateAdded: 0, children: childrenOf(list, null).map((r) => toChromeNode(list, r, true)) }];
}

export type BookmarkQuery = string | { query?: string; url?: string; title?: string };

/** chrome.bookmarks.search(): every word in the title or address, or an exact address / title. */
export function searchBookmarks(list: Bookmark[], query: BookmarkQuery): Bookmark[] {
  const q = typeof query === "string" ? { query } : query;
  const words = (q.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((b) => {
    if (ROOT_IDS.has(b.id)) return false;
    if (q.url !== undefined && b.url !== q.url) return false;
    if (q.title !== undefined && b.title !== q.title) return false;
    const hay = `${b.title} ${b.url ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** chrome.bookmarks.getRecent(): the newest bookmarks (not folders). */
export function recentBookmarks(list: Bookmark[], count: number): Bookmark[] {
  return list
    .filter((b) => b.kind === "bookmark")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(1, count));
}

/** Addresses an extension may bookmark (no javascript: or data: bookmarklets). */
export const isBookmarkableUrl = (url: string): boolean => {
  try {
    return ["http:", "https:", "ftp:", "file:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

export type ChromeBookmarkEvent =
  | { event: "onCreated"; args: [string, ChromeBookmarkNode] }
  | { event: "onRemoved"; args: [string, { parentId: string; index: number; node: ChromeBookmarkNode }] }
  | { event: "onChanged"; args: [string, { title: string; url?: string }] }
  | { event: "onMoved"; args: [string, { parentId: string; index: number; oldParentId: string; oldIndex: number }] }
  | { event: "onChildrenReordered"; args: [string, { childIds: string[] }] };

/**
 * The chrome.bookmarks events between two versions of the list, whoever made the change (the
 * person, sync, an extension): created and removed nodes (a removed folder once, with its
 * subtree), new titles or addresses, nodes in another folder, and folders whose order changed.
 */
export function bookmarkEvents(before: Bookmark[], after: Bookmark[]): ChromeBookmarkEvent[] {
  const was = new Map(before.map((b) => [b.id, b]));
  const now = new Map(after.map((b) => [b.id, b]));
  const out: ChromeBookmarkEvent[] = [];
  for (const b of before) {
    if (now.has(b.id)) continue;
    // Only the top of a removed subtree: its descendants go with it.
    if (b.parentId && !now.has(b.parentId) && was.has(b.parentId)) continue;
    out.push({ event: "onRemoved", args: [b.id, { parentId: b.parentId ?? CHROME_ROOT_ID, index: indexIn(before, b), node: toChromeNode(before, b, true) }] });
  }
  const reordered = new Set<string>();
  for (const b of after) {
    const old = was.get(b.id);
    if (!old) {
      out.push({ event: "onCreated", args: [b.id, toChromeNode(after, b)] });
      continue;
    }
    if (old.title !== b.title || old.url !== b.url) out.push({ event: "onChanged", args: [b.id, { title: b.title, ...(b.url !== undefined ? { url: b.url } : {}) }] });
    if (old.parentId !== b.parentId) {
      out.push({
        event: "onMoved",
        args: [b.id, { parentId: b.parentId ?? CHROME_ROOT_ID, index: indexIn(after, b), oldParentId: old.parentId ?? CHROME_ROOT_ID, oldIndex: indexIn(before, old) }],
      });
    } else if (b.parentId) reordered.add(b.parentId);
  }
  // Same folder, other order among the children both versions have.
  for (const parentId of reordered) {
    const common = (list: Bookmark[], other: Map<string, Bookmark>): string[] =>
      childrenOf(list, parentId).filter((c) => other.has(c.id) && other.get(c.id)!.parentId === parentId).map((c) => c.id);
    const a = common(before, now);
    const b = common(after, was);
    if (a.join() !== b.join()) out.push({ event: "onChildrenReordered", args: [parentId, { childIds: childrenOf(after, parentId).map((c) => c.id) }] });
  }
  return out;
}
