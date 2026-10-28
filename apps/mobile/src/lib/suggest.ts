/**
 * What the address bar suggests while typing: the open tabs of the phone, bookmarks and history
 * that contain every word typed, best first. Pure, so it is tested as is; nothing typed leaves the
 * phone (no search engine is asked for suggestions).
 */
import type { Bookmark, SyncedHistoryEntry } from '@corvus/shared';

export interface Suggestion {
  kind: 'tab' | 'bookmark' | 'history';
  url: string;
  title: string;
  /** The phone's tab to switch to (kind "tab"). */
  tabId?: string;
}

const words = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Address without the scheme and "www.", as people type it. */
const bare = (url: string): string => url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');

function score(url: string, title: string, q: string[], raw: string): number {
  const hay = `${title} ${url}`.toLowerCase();
  if (!q.every((w) => hay.includes(w))) return 0;
  // The address starting with what was typed counts most, then the title starting with it.
  if (bare(url).startsWith(raw)) return 3;
  if (title.toLowerCase().startsWith(raw)) return 2;
  return 1;
}

export function suggest(
  query: string,
  sources: { tabs: ReadonlyArray<{ id: string; url: string; title: string }>; bookmarks: readonly Bookmark[]; history: readonly SyncedHistoryEntry[] },
  max = 8,
): Suggestion[] {
  const q = words(query);
  const raw = query.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
  if (q.length === 0) return [];
  const seen = new Set<string>();
  const out: Array<Suggestion & { score: number; order: number }> = [];
  const add = (s: Suggestion, base: number): void => {
    const key = s.url.replace(/#.*$/, '');
    if (!/^https?:\/\//i.test(s.url) || seen.has(key)) return;
    const points = score(s.url, s.title, q, raw);
    if (points === 0) return;
    seen.add(key);
    out.push({ ...s, score: points * 10 + base, order: out.length });
  };
  for (const tab of sources.tabs) add({ kind: 'tab', url: tab.url, title: tab.title, tabId: tab.id }, 3);
  for (const b of sources.bookmarks) if (b.kind === 'bookmark' && b.url) add({ kind: 'bookmark', url: b.url, title: b.title }, 2);
  // History comes most recent first: visited more often ranks first among equals.
  const history = [...sources.history].sort((a, b) => b.visitCount - a.visitCount || b.visitedAt - a.visitedAt);
  for (const h of history.slice(0, 5000)) add({ kind: 'history', url: h.url, title: h.title }, 1);
  return out
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .map(({ score: _s, order: _o, ...s }) => s);
}
