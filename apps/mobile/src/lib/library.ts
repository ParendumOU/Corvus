/** Bookmarks and the reading list as the phone shows them, from the synced records. */
import { BAR_FOLDER_ID, OTHER_FOLDER_ID, isReadingItem, isSyncedBookmark, type Bookmark, type ReadingItem } from '@corvus/shared';

/** The two root folders every device has (never synced, so the phone makes its own). */
export const ROOT_FOLDERS: readonly Bookmark[] = [
  { id: BAR_FOLDER_ID, parentId: null, kind: 'folder', title: 'Bookmarks bar', position: 0, createdAt: 0, updatedAt: 0 },
  { id: OTHER_FOLDER_ID, parentId: null, kind: 'folder', title: 'Other bookmarks', position: 1, createdAt: 0, updatedAt: 0 },
];

/** Every valid synced bookmark and folder. */
export function bookmarkList(records: Record<string, unknown>): Bookmark[] {
  return Object.values(records).filter(isSyncedBookmark);
}

/** A folder's contents in their order; null is the top level (the two roots). */
export function folderContents(bookmarks: readonly Bookmark[], folderId: string | null): Bookmark[] {
  if (folderId === null) return [...ROOT_FOLDERS];
  return bookmarks.filter((b) => b.parentId === folderId).sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
}

/** The folders from the top level down to `folderId` (for the breadcrumb). */
export function folderPath(bookmarks: readonly Bookmark[], folderId: string | null): Bookmark[] {
  const byId = new Map([...ROOT_FOLDERS, ...bookmarks].map((b) => [b.id, b]));
  const path: Bookmark[] = [];
  const seen = new Set<string>();
  for (let id = folderId; id !== null && !seen.has(id); ) {
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) break;
    path.unshift(folder);
    id = folder.parentId;
  }
  return path;
}

const words = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Bookmarks (not folders) whose title or address contains every word of the query. */
export function searchBookmarks(bookmarks: readonly Bookmark[], query: string): Bookmark[] {
  const q = words(query);
  if (q.length === 0) return [];
  return bookmarks
    .filter((b) => b.kind === 'bookmark' && q.every((w) => `${b.title} ${b.url ?? ''}`.toLowerCase().includes(w)))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Where a bookmark added at the end of a folder goes. */
export function nextPosition(bookmarks: readonly Bookmark[], parentId: string): number {
  return bookmarks.filter((b) => b.parentId === parentId).reduce((max, b) => Math.max(max, b.position + 1), 0);
}

/** The reading list: unread first, newest saved first within each. */
export function readingList(records: Record<string, unknown>): ReadingItem[] {
  return Object.entries(records)
    .map(([url, item]) => (isReadingItem(item) ? { ...item, url } : null))
    .filter((item): item is ReadingItem => item !== null)
    .sort((a, b) => Number(a.readAt !== undefined) - Number(b.readAt !== undefined) || b.savedAt - a.savedAt);
}

/** Reading list entries whose title, site, address or excerpt contain every word of the query. */
export function searchReading(items: readonly ReadingItem[], query: string): ReadingItem[] {
  const q = words(query);
  if (q.length === 0) return [...items];
  return items.filter((i) => q.every((w) => `${i.title} ${i.siteName} ${i.url} ${i.excerpt}`.toLowerCase().includes(w)));
}
