/**
 * Pure bookmark tree operations over a flat Bookmark[] (the persisted shape).
 * Two fixed root folders exist: the bookmarks bar and "Other bookmarks". Roots cannot be
 * renamed, moved or deleted.
 */
import { BAR_FOLDER_ID, OTHER_FOLDER_ID, type Bookmark } from "@corvus/shared";
import { classifyOmnibox } from "./omnibox";

export { BAR_FOLDER_ID, OTHER_FOLDER_ID };
export const ROOT_IDS: ReadonlySet<string> = new Set([BAR_FOLDER_ID, OTHER_FOLDER_ID]);

/** Opening more of a folder's bookmarks at once than this asks first (as Chrome does). */
export const OPEN_ALL_ASK_ABOVE = 15;

/** A bookmark being dragged (the bookmarks page, the bookmarks bar): its id. */
export const BOOKMARK_DRAG_MIME = "application/x-corvus-bookmark";

export class BookmarkError extends Error {}

export function defaultTree(now: number): Bookmark[] {
  return [
    { id: BAR_FOLDER_ID, parentId: null, kind: "folder", title: "Bookmarks bar", position: 0, createdAt: now, updatedAt: now },
    { id: OTHER_FOLDER_ID, parentId: null, kind: "folder", title: "Other bookmarks", position: 1, createdAt: now, updatedAt: now },
  ];
}

/** Ensure both roots exist (repairs files written by older versions or partial syncs). */
export function ensureRoots(list: Bookmark[], now: number): Bookmark[] {
  const missing = defaultTree(now).filter((root) => !list.some((b) => b.id === root.id));
  return missing.length === 0 ? list : [...missing, ...list];
}

export function getNode(list: Bookmark[], id: string): Bookmark | undefined {
  return list.find((b) => b.id === id);
}

export function childrenOf(list: Bookmark[], parentId: string | null): Bookmark[] {
  return list.filter((b) => b.parentId === parentId).sort((a, b) => a.position - b.position);
}

/** The addresses of a folder's own bookmarks (not its subfolders'), in order: what "Open all" opens. */
export function folderUrls(list: Bookmark[], folderId: string): string[] {
  return childrenOf(list, folderId)
    .filter((b) => b.kind === "bookmark" && b.url)
    .map((b) => b.url as string);
}

/**
 * The address a bookmark is saved with, from what the person typed (the bookmarks page and the
 * bookmarks bar's Edit dialog): an address is completed as the address bar would ("example.com"
 * becomes https://example.com/), anything else is kept as typed. Null when nothing was typed.
 */
export function bookmarkUrlFromInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const intent = classifyOmnibox(text);
  return intent.kind === "url" ? intent.url : text;
}

/**
 * The index moveNode takes for an item dropped in a folder before the child shown at `slot` (the
 * folder's length: at the end). The slot counts the item itself when it is already there, moveNode's
 * index does not.
 */
export function dropMoveIndex(siblings: readonly { id: string }[], id: string, slot: number): number {
  const from = siblings.findIndex((b) => b.id === id);
  return from >= 0 && from < slot ? slot - 1 : slot;
}

export function isDescendant(list: Bookmark[], nodeId: string, ancestorId: string): boolean {
  let current = getNode(list, nodeId);
  const seen = new Set<string>();
  while (current && current.parentId !== null && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentId === ancestorId) return true;
    current = getNode(list, current.parentId);
  }
  return false;
}

export function descendantIds(list: Bookmark[], id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of list.filter((b) => b.parentId === current)) {
      out.push(child.id);
      stack.push(child.id);
    }
  }
  return out;
}

/** Ancestor chain from the root down to (and including) the node. */
export function pathTo(list: Bookmark[], id: string): Bookmark[] {
  const path: Bookmark[] = [];
  let current = getNode(list, id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId === null ? undefined : getNode(list, current.parentId);
  }
  return path;
}

function reindex(list: Bookmark[], parentId: string | null, ordered: Bookmark[], now: number, touched: Set<string>): Bookmark[] {
  const positions = new Map(ordered.map((b, i) => [b.id, i]));
  return list.map((b) => {
    if (b.parentId !== parentId) return b;
    const position = positions.get(b.id);
    if (position === undefined || (position === b.position && !touched.has(b.id))) return b;
    return { ...b, position, updatedAt: touched.has(b.id) ? now : b.updatedAt };
  });
}

function requireFolder(list: Bookmark[], id: string): Bookmark {
  const folder = getNode(list, id);
  if (!folder) throw new BookmarkError(`Folder ${id} does not exist`);
  if (folder.kind !== "folder") throw new BookmarkError(`${id} is not a folder`);
  return folder;
}

export interface NewNode {
  parentId: string;
  kind: Bookmark["kind"];
  title: string;
  url?: string;
  index?: number;
}

export function addNode(list: Bookmark[], node: NewNode, id: string, now: number): { list: Bookmark[]; node: Bookmark } {
  requireFolder(list, node.parentId);
  if (getNode(list, id)) throw new BookmarkError(`Duplicate bookmark id ${id}`);
  if (node.kind === "bookmark" && !node.url) throw new BookmarkError("A bookmark needs a URL");
  const created: Bookmark = {
    id,
    parentId: node.parentId,
    kind: node.kind,
    title: node.title.trim() || (node.kind === "folder" ? "New folder" : (node.url ?? "")),
    ...(node.kind === "bookmark" ? { url: node.url } : {}),
    position: 0,
    createdAt: now,
    updatedAt: now,
  };
  const siblings = childrenOf(list, node.parentId);
  const index = Math.max(0, Math.min(node.index ?? siblings.length, siblings.length));
  siblings.splice(index, 0, created);
  const next = reindex([...list, created], node.parentId, siblings, now, new Set([id]));
  return { list: next, node: getNode(next, id) as Bookmark };
}

export function updateNode(
  list: Bookmark[],
  id: string,
  patch: { title?: string; url?: string },
  now: number,
): Bookmark[] {
  const node = getNode(list, id);
  if (!node) throw new BookmarkError(`Bookmark ${id} does not exist`);
  if (ROOT_IDS.has(id)) throw new BookmarkError("Root folders cannot be edited");
  if (patch.url !== undefined && node.kind !== "bookmark") throw new BookmarkError("Folders have no URL");
  return list.map((b) =>
    b.id === id
      ? {
          ...b,
          ...(patch.title !== undefined ? { title: patch.title.trim() || b.title } : {}),
          ...(patch.url !== undefined && patch.url.length > 0 ? { url: patch.url } : {}),
          updatedAt: now,
        }
      : b,
  );
}

export function moveNode(list: Bookmark[], id: string, newParentId: string, index: number | undefined, now: number): Bookmark[] {
  const node = getNode(list, id);
  if (!node) throw new BookmarkError(`Bookmark ${id} does not exist`);
  if (ROOT_IDS.has(id)) throw new BookmarkError("Root folders cannot be moved");
  requireFolder(list, newParentId);
  if (newParentId === id || isDescendant(list, newParentId, id)) {
    throw new BookmarkError("Cannot move a folder into itself");
  }
  const oldParentId = node.parentId;
  const moved: Bookmark = { ...node, parentId: newParentId, updatedAt: now };
  let next = list.map((b) => (b.id === id ? moved : b));
  const targetSiblings = childrenOf(next, newParentId).filter((b) => b.id !== id);
  const at = Math.max(0, Math.min(index ?? targetSiblings.length, targetSiblings.length));
  targetSiblings.splice(at, 0, moved);
  next = reindex(next, newParentId, targetSiblings, now, new Set([id]));
  if (oldParentId !== newParentId) {
    next = reindex(next, oldParentId, childrenOf(next, oldParentId), now, new Set());
  }
  return next;
}

export function removeNode(list: Bookmark[], id: string, now: number): { list: Bookmark[]; removed: string[] } {
  const node = getNode(list, id);
  if (!node) return { list, removed: [] };
  if (ROOT_IDS.has(id)) throw new BookmarkError("Root folders cannot be deleted");
  const removed = [id, ...descendantIds(list, id)];
  const gone = new Set(removed);
  const remaining = list.filter((b) => !gone.has(b.id));
  return { list: reindex(remaining, node.parentId, childrenOf(remaining, node.parentId), now, new Set()), removed };
}

function comparableUrl(url: string): string {
  return url.replace(/#.*$/, "").replace(/\/$/, "");
}

export function findByUrl(list: Bookmark[], url: string): Bookmark[] {
  const target = comparableUrl(url);
  return list.filter((b) => b.kind === "bookmark" && b.url !== undefined && comparableUrl(b.url) === target);
}

/**
 * Insert or replace a node coming from sync. A node whose parent has not arrived yet is kept (it
 * stays hidden until the parent shows up) because sync pages are not ordered parent-first. Returns
 * the list unchanged for roots, top-level nodes, older revisions and moves that would form a cycle.
 */
export function upsertNode(list: Bookmark[], node: Bookmark): Bookmark[] {
  if (ROOT_IDS.has(node.id) || node.parentId === null || node.parentId === node.id) return list;
  const existing = getNode(list, node.id);
  if (existing && existing.updatedAt > node.updatedAt) return list;
  if (isDescendant(list, node.parentId, node.id)) return list;
  return existing ? list.map((b) => (b.id === node.id ? node : b)) : [...list, node];
}

export interface BookmarkTreeNode extends Bookmark {
  children: BookmarkTreeNode[];
}

export function toTree(list: Bookmark[], parentId: string | null = null): BookmarkTreeNode[] {
  return childrenOf(list, parentId).map((b) => ({ ...b, children: b.kind === "folder" ? toTree(list, b.id) : [] }));
}
