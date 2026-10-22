/**
 * Pure mappings between Corvus stores and the shapes of the chrome.bookmarks, chrome.history,
 * chrome.tabGroups, chrome.sessions and chrome.topSites extension APIs.
 */
import type { Bookmark, GroupColor, TabGroup } from "@corvus/shared";
import { BAR_FOLDER_ID, OTHER_FOLDER_ID, childrenOf } from "./bookmark-tree";
import type { HistoryRecord } from "./history-ops";

/** Permission an extension must declare for each Corvus-provided namespace. */
export const CORVUS_EXTENSION_APIS = ["bookmarks", "history", "tabGroups", "sessions", "search", "sidePanel", "topSites"] as const;
export type CorvusExtensionApi = (typeof CORVUS_EXTENSION_APIS)[number];

// ------------------------------------------------------------------ bookmarks

/** Chrome's fixed IDs: "0" is the invisible root, "1" the bookmarks bar, "2" other bookmarks. */
export const CHROME_ROOT_ID = "0";
const TO_CHROME: Record<string, string> = { [BAR_FOLDER_ID]: "1", [OTHER_FOLDER_ID]: "2" };
const FROM_CHROME: Record<string, string> = { "1": BAR_FOLDER_ID, "2": OTHER_FOLDER_ID };

export function toChromeBookmarkId(id: string): string {
  return TO_CHROME[id] ?? id;
}

export function fromChromeBookmarkId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) throw new Error("Bookmark id must be a non-empty string");
  return FROM_CHROME[id] ?? id;
}

export interface ChromeBookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  dateAdded: number;
  dateGroupModified?: number;
  syncing: boolean;
  children?: ChromeBookmarkNode[];
}

export function toChromeBookmark(list: Bookmark[], node: Bookmark, depth: number): ChromeBookmarkNode {
  const out: ChromeBookmarkNode = {
    id: toChromeBookmarkId(node.id),
    parentId: node.parentId === null ? CHROME_ROOT_ID : toChromeBookmarkId(node.parentId),
    index: node.position,
    title: node.title,
    dateAdded: node.createdAt,
    syncing: false,
  };
  if (node.kind === "bookmark") out.url = node.url ?? "";
  else {
    out.dateGroupModified = node.updatedAt;
    if (depth > 0) out.children = childrenOf(list, node.id).map((c) => toChromeBookmark(list, c, depth - 1));
  }
  return out;
}

/** The whole tree as chrome.bookmarks.getTree() returns it: one root node holding both folders. */
export function chromeBookmarkTree(list: Bookmark[]): ChromeBookmarkNode[] {
  const roots = childrenOf(list, null);
  return [
    {
      id: CHROME_ROOT_ID,
      title: "",
      dateAdded: Math.min(...roots.map((r) => r.createdAt), Date.now()),
      syncing: false,
      children: roots.map((r) => toChromeBookmark(list, r, Infinity)),
    },
  ];
}

/** chrome.bookmarks.search: a string matches title or URL (all words), an object matches fields. */
export function searchBookmarks(list: Bookmark[], query: unknown): Bookmark[] {
  if (typeof query === "string") {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    return list.filter((b) => b.parentId !== null && terms.every((t) => `${b.title} ${b.url ?? ""}`.toLowerCase().includes(t)));
  }
  const q = (typeof query === "object" && query !== null ? query : {}) as { query?: unknown; url?: unknown; title?: unknown };
  let out = list.filter((b) => b.parentId !== null);
  if (typeof q.query === "string") {
    const words = new Set(searchBookmarks(list, q.query).map((b) => b.id));
    out = out.filter((b) => words.has(b.id));
  }
  if (typeof q.url === "string") out = out.filter((b) => b.url === q.url);
  if (typeof q.title === "string") out = out.filter((b) => b.title === q.title);
  return out;
}

export type BookmarkEvent =
  | { name: "bookmarks.onCreated"; args: [string, ChromeBookmarkNode] }
  | { name: "bookmarks.onRemoved"; args: [string, { parentId: string; index: number; node: ChromeBookmarkNode }] }
  | { name: "bookmarks.onChanged"; args: [string, { title: string; url?: string }] }
  | { name: "bookmarks.onMoved"; args: [string, { parentId: string; index: number; oldParentId: string; oldIndex: number }] };

/**
 * Events between two snapshots of the bookmark list. A removed folder yields one onRemoved for the
 * folder only (like Chrome). Siblings that only shift position are not reported as moved: a node
 * is "moved" when its parent changed, or when it was touched (updatedAt) without a title/URL edit.
 */
export function diffBookmarks(before: Bookmark[], after: Bookmark[]): BookmarkEvent[] {
  const prev = new Map(before.map((b) => [b.id, b]));
  const next = new Map(after.map((b) => [b.id, b]));
  const events: BookmarkEvent[] = [];
  for (const b of before) {
    if (next.has(b.id) || b.parentId === null) continue;
    if (prev.has(b.parentId) && !next.has(b.parentId)) continue;
    events.push({
      name: "bookmarks.onRemoved",
      args: [toChromeBookmarkId(b.id), { parentId: toChromeBookmarkId(b.parentId), index: b.position, node: toChromeBookmark(before, b, Infinity) }],
    });
  }
  for (const b of after) {
    const old = prev.get(b.id);
    if (b.parentId === null) continue;
    if (!old) {
      events.push({ name: "bookmarks.onCreated", args: [toChromeBookmarkId(b.id), toChromeBookmark(after, b, Infinity)] });
      continue;
    }
    const edited = old.title !== b.title || old.url !== b.url;
    if (edited) {
      events.push({ name: "bookmarks.onChanged", args: [toChromeBookmarkId(b.id), { title: b.title, ...(b.url !== undefined ? { url: b.url } : {}) }] });
    }
    const reparented = old.parentId !== b.parentId;
    const reordered = old.position !== b.position && old.updatedAt !== b.updatedAt && !edited;
    if ((reparented || reordered) && old.parentId !== null) {
      events.push({
        name: "bookmarks.onMoved",
        args: [
          toChromeBookmarkId(b.id),
          { parentId: toChromeBookmarkId(b.parentId), index: b.position, oldParentId: toChromeBookmarkId(old.parentId), oldIndex: old.position },
        ],
      });
    }
  }
  return events;
}

// ------------------------------------------------------------------ history

export interface ChromeHistoryItem {
  id: string;
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
  typedCount: number;
}

export function toChromeHistoryItem(e: HistoryRecord): ChromeHistoryItem {
  return { id: e.id, url: e.url, title: e.title, lastVisitTime: e.visitedAt, visitCount: e.visitCount, typedCount: 0 };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** chrome.history.search: `text` matches title/URL words; startTime defaults to 24 hours ago. */
export function searchHistory(list: HistoryRecord[], query: unknown, now: number): HistoryRecord[] {
  const q = (typeof query === "object" && query !== null ? query : {}) as { text?: unknown; startTime?: unknown; endTime?: unknown; maxResults?: unknown };
  const text = typeof q.text === "string" ? q.text : "";
  const start = typeof q.startTime === "number" ? q.startTime : now - DAY_MS;
  const end = typeof q.endTime === "number" ? q.endTime : Infinity;
  const max = typeof q.maxResults === "number" && q.maxResults > 0 ? Math.floor(q.maxResults) : 100;
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  return list
    .filter((e) => e.visitedAt >= start && e.visitedAt < end)
    .filter((e) => terms.every((t) => `${e.title} ${e.url}`.toLowerCase().includes(t)))
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, max);
}

// ------------------------------------------------------------------ tab groups

export interface ChromeTabGroup {
  id: number;
  collapsed: boolean;
  color: GroupColor;
  title: string;
  windowId: number;
}

export const GROUP_COLORS: readonly GroupColor[] = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

export function toChromeTabGroup(group: TabGroup, id: number, windowId: number): ChromeTabGroup {
  return { id, collapsed: group.collapsed, color: group.color, title: group.title, windowId };
}

/** Validates a chrome.tabGroups.update() properties object. */
export function groupPatchOf(raw: unknown): { title?: string; color?: GroupColor; collapsed?: boolean } {
  const p = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: { title?: string; color?: GroupColor; collapsed?: boolean } = {};
  if (p.title !== undefined) {
    if (typeof p.title !== "string") throw new Error("title must be a string");
    out.title = p.title.slice(0, 200);
  }
  if (p.color !== undefined) {
    if (!GROUP_COLORS.includes(p.color as GroupColor)) throw new Error(`Invalid color ${String(p.color)}`);
    out.color = p.color as GroupColor;
  }
  if (p.collapsed !== undefined) out.collapsed = p.collapsed === true;
  return out;
}

export type GroupEvent =
  | { name: "tabGroups.onCreated" | "tabGroups.onUpdated" | "tabGroups.onRemoved"; group: ChromeTabGroup }
  | { name: "tabGroups.onMoved"; group: ChromeTabGroup };

/** Group events between two snapshots of one window (groups listed in strip order). */
export function diffGroups(before: ChromeTabGroup[], after: ChromeTabGroup[]): GroupEvent[] {
  const prev = new Map(before.map((g, i) => [g.id, { g, i }]));
  const next = new Set(after.map((g) => g.id));
  const events: GroupEvent[] = before.filter((g) => !next.has(g.id)).map((group) => ({ name: "tabGroups.onRemoved", group }));
  const surviving = before.filter((g) => next.has(g.id)).map((g) => g.id);
  const kept = after.filter((g) => prev.has(g.id)).map((g) => g.id);
  after.forEach((group) => {
    const old = prev.get(group.id);
    if (!old) {
      events.push({ name: "tabGroups.onCreated", group });
      return;
    }
    if (old.g.title !== group.title || old.g.color !== group.color || old.g.collapsed !== group.collapsed) {
      events.push({ name: "tabGroups.onUpdated", group });
    }
    if (surviving.indexOf(group.id) !== kept.indexOf(group.id)) events.push({ name: "tabGroups.onMoved", group });
  });
  return events;
}

// ------------------------------------------------------------------ side panel

/** Resolves an extension-relative side panel path to a URL inside that extension, or throws. */
export function sidePanelUrl(extensionId: string, pathOrUrl: string): string {
  const base = `chrome-extension://${extensionId}/`;
  const url = new URL(pathOrUrl, base);
  if (url.protocol !== "chrome-extension:" || url.host !== extensionId) throw new Error("The side panel path must be a page of the extension");
  return url.href;
}
