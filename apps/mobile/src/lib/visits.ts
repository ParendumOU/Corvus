/**
 * What the browser records in history (sync collection `history`, one record per address, as the
 * desktop keeps it): which page loads count as a visit, and how a visit merges into the entry the
 * chain already has. Pure, so it is tested as is.
 */
import { MAX_TAB_URL, parseSyncedHistory, type SyncedHistoryEntry } from '@corvus/shared';

/** A page loaded again this soon in the same tab (a reload, a redirect back, a page that rewrites its own address) is the same visit. */
export const SAME_VISIT_MS = 30_000;

/** The last visit a tab recorded. */
export interface LastVisit {
  url: string;
  at: number;
}

const withoutHash = (url: string): string => url.replace(/#.*$/, '');

/** Whether a finished page load is a new visit to record: a web page, not the one this tab just recorded. */
export function isNewVisit(url: string, last: LastVisit | undefined, now: number): boolean {
  if (!/^https?:\/\/[^\s/?#]+/i.test(url) || url.length > MAX_TAB_URL) return false;
  if (!last) return true;
  return withoutHash(last.url) !== withoutHash(url) || now - last.at > SAME_VISIT_MS;
}

/** The history entry after one more visit: counted, dated now, with the page's title when it has one. */
export function mergeVisit(existing: unknown, visit: { url: string; title: string }, now: number): SyncedHistoryEntry {
  const entry = parseSyncedHistory(existing);
  const title = visit.title.trim().slice(0, 1000);
  if (!entry || entry.url !== visit.url) return { url: visit.url, title, visitedAt: now, visitCount: 1 };
  return { ...entry, title: title || entry.title, visitedAt: Math.max(now, entry.visitedAt), visitCount: entry.visitCount + 1 };
}

/** The entry with the title the page showed once it loaded, or null when nothing changes. */
export function retitled(existing: unknown, title: string): SyncedHistoryEntry | null {
  const entry = parseSyncedHistory(existing);
  const next = title.trim().slice(0, 1000);
  if (!entry || !next || entry.title === next) return null;
  return { ...entry, title: next };
}

/**
 * The phone's history when it is not paired (kept on the phone only, for the address bar), most
 * recent first: the visit added or moved to the top, `max` entries at most.
 */
export function addLocalVisit(list: readonly SyncedHistoryEntry[], entry: SyncedHistoryEntry, max: number): SyncedHistoryEntry[] {
  return [entry, ...list.filter((e) => e.url !== entry.url)].slice(0, max);
}
