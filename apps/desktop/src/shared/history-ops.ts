/** Pure browsing-history operations. Entries are unique per URL. */
import type { HistoryEntry, SyncedHistoryEntry } from "@corvus/shared";
import { isFaviconUrl } from "./favicon";

export interface HistoryRecord extends HistoryEntry {
  faviconUrl?: string;
  /**
   * The browser a page is only known from ("chrome", "firefox"), read live from its history: such
   * an entry stays on this computer (sync leaves it out) until Corvus itself visits the page.
   */
  source?: string;
}

export const MAX_HISTORY_ENTRIES = 20_000;

export function recordVisit(
  list: HistoryRecord[],
  visit: { url: string; title: string },
  id: string,
  now: number,
  max = MAX_HISTORY_ENTRIES,
): HistoryRecord[] {
  const existing = list.find((e) => e.url === visit.url);
  if (existing) {
    // A page known only from another browser becomes Corvus's own, without that browser's visits.
    const { source, ...own } = existing;
    const updated: HistoryRecord = {
      ...own,
      title: visit.title || existing.title,
      visitedAt: now,
      visitCount: source ? 1 : existing.visitCount + 1,
    };
    return [updated, ...list.filter((e) => e.id !== existing.id)];
  }
  const entry: HistoryRecord = { id, url: visit.url, title: visit.title, visitedAt: now, visitCount: 1 };
  const next = [entry, ...list];
  return next.length > max ? prune(next, max) : next;
}

export function updateEntry(list: HistoryRecord[], url: string, patch: { title?: string; faviconUrl?: string }): HistoryRecord[] {
  let changed = false;
  const next = list.map((e) => {
    if (e.url !== url) return e;
    const title = patch.title !== undefined && patch.title.length > 0 ? patch.title : e.title;
    const faviconUrl = patch.faviconUrl ?? e.faviconUrl;
    if (title === e.title && faviconUrl === e.faviconUrl) return e;
    changed = true;
    return { ...e, title, ...(faviconUrl !== undefined ? { faviconUrl } : {}) };
  });
  return changed ? next : list;
}

/** "scheme://host[:port]" of an http(s) URL, lower-cased. String-based: it runs over the whole history. */
function siteOf(url: string): string | null {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/**
 * Last known favicon for each of `urls`: the icon recorded for that exact page, else the one of the
 * most recently visited page of the same site. Seeds tabs that are restored without loading (session
 * restore, workspaces), so they show their site icon instead of the letter placeholder. One pass.
 */
export function faviconsFromHistory(list: readonly HistoryRecord[], urls: readonly string[]): Map<string, string> {
  const wanted = new Set(urls);
  const sites = new Set(urls.map(siteOf).filter((s): s is string => s !== null));
  const exact = new Map<string, string>();
  const bySite = new Map<string, HistoryRecord>();
  for (const e of list) {
    if (!isFaviconUrl(e.faviconUrl)) continue;
    if (wanted.has(e.url) && !exact.has(e.url)) exact.set(e.url, e.faviconUrl);
    const site = siteOf(e.url);
    if (site && sites.has(site)) {
      const best = bySite.get(site);
      if (!best || e.visitedAt > best.visitedAt) bySite.set(site, e);
    }
  }
  const out = new Map<string, string>();
  for (const url of urls) {
    const site = siteOf(url);
    const icon = exact.get(url) ?? (site ? bySite.get(site)?.faviconUrl : undefined);
    if (icon) out.set(url, icon);
  }
  return out;
}

/**
 * Keep the `max` most recently visited entries. Pages known only from another browser go first, so
 * they never push Corvus's own (and synced) history out.
 */
export function prune(list: HistoryRecord[], max: number): HistoryRecord[] {
  return [...list].sort((a, b) => Number(Boolean(a.source)) - Number(Boolean(b.source)) || b.visitedAt - a.visitedAt).slice(0, max);
}

function matches(entry: HistoryRecord, terms: string[]): boolean {
  const haystack = `${entry.title} ${entry.url}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export function queryHistory(
  list: HistoryRecord[],
  query: string,
  offset = 0,
  limit = 100,
): { entries: HistoryRecord[]; total: number } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = (terms.length === 0 ? list : list.filter((e) => matches(e, terms))).sort(
    (a, b) => b.visitedAt - a.visitedAt,
  );
  return { entries: filtered.slice(offset, offset + limit), total: filtered.length };
}

/** Which history "Clear history" removes: visits since a time, matching a search, on a site. */
export interface HistoryFilter {
  /** Visits at or after this time (ms); 0 or absent: all time. */
  since?: number;
  /** Only entries the search box would show for this text. */
  query?: string;
  /** Only this site and its subdomains ("example.com"). */
  site?: string;
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The site a person typed ("https://www.Example.com/x" → "www.example.com"), or "" when none. */
export function typedSite(input: string): string {
  const raw = input.trim().toLowerCase();
  if (!raw) return "";
  const host = hostOfUrl(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`);
  return /^[a-z0-9.-]+$/.test(host) && host.includes(".") ? host.replace(/^www\./, "") : "";
}

/** The entries a filter covers. */
export function historyMatching(list: readonly HistoryRecord[], filter: HistoryFilter): HistoryRecord[] {
  const terms = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const site = filter.site ? typedSite(filter.site) : "";
  const since = filter.since ?? 0;
  return list.filter((e) => {
    if (since > 0 && e.visitedAt < since) return false;
    if (terms.length > 0 && !matches(e, terms)) return false;
    if (site) {
      const host = hostOfUrl(e.url);
      if (host !== site && !host.endsWith(`.${site}`)) return false;
    }
    return true;
  });
}

export function removeEntries(list: HistoryRecord[], ids: string[]): HistoryRecord[] {
  const gone = new Set(ids);
  return list.filter((e) => !gone.has(e.id));
}

/** History as synced: one record per URL (also the record key), without the device-local id. */
export { parseSyncedHistory, type SyncedHistoryEntry } from "@corvus/shared";

export function toSyncedHistory(e: HistoryRecord): SyncedHistoryEntry {
  return {
    url: e.url,
    title: e.title,
    visitedAt: e.visitedAt,
    visitCount: e.visitCount,
    ...(e.faviconUrl ? { faviconUrl: e.faviconUrl } : {}),
  };
}

function rankAbove(a: SyncedHistoryEntry, b: SyncedHistoryEntry): boolean {
  if (a.visitedAt !== b.visitedAt) return a.visitedAt > b.visitedAt;
  if (a.title !== b.title) return a.title > b.title;
  return (a.faviconUrl ?? "") >= (b.faviconUrl ?? "");
}

/**
 * Merge two devices' versions of one URL: the most recent visit supplies title and favicon, the
 * visit count is the maximum. Commutative and idempotent, so devices converge in any order.
 */
export function mergeHistory(a: SyncedHistoryEntry, b: SyncedHistoryEntry): SyncedHistoryEntry {
  const winner = rankAbove(a, b) ? a : b;
  return { ...winner, visitCount: Math.max(a.visitCount, b.visitCount) };
}

function sameEntry(a: SyncedHistoryEntry, b: SyncedHistoryEntry): boolean {
  return a.title === b.title && a.visitedAt === b.visitedAt && a.visitCount === b.visitCount && a.faviconUrl === b.faviconUrl;
}

/** Apply synced upserts (merged per URL) and deletions; returns `list` itself when nothing changed. */
export function applySyncedHistory(
  list: HistoryRecord[],
  changes: Array<{ url: string; entry: SyncedHistoryEntry | null }>,
  newId: () => string,
  max = MAX_HISTORY_ENTRIES,
): HistoryRecord[] {
  const byUrl = new Map(list.map((e) => [e.url, e]));
  let changed = false;
  for (const { url, entry } of changes) {
    const existing = byUrl.get(url);
    if (!entry) {
      changed = byUrl.delete(url) || changed;
      continue;
    }
    // A page known only from another browser takes the synced version as it is: nothing of that
    // browser's visits is merged into what syncs.
    const current = existing && !existing.source ? toSyncedHistory(existing) : null;
    const merged = current ? mergeHistory(current, entry) : entry;
    if (current && sameEntry(merged, current)) continue;
    byUrl.set(url, { id: existing?.id ?? newId(), ...merged, url });
    changed = true;
  }
  if (!changed) return list;
  const next = [...byUrl.values()];
  return next.length > max ? prune(next, max) : next;
}

/**
 * Adds pages read live from another browser's history, marked with `source`. A page Corvus already
 * has as its own is left as it is (it is suggested already, and its synced visits stay Corvus's); a
 * page known only from other browsers takes the later visit and the larger count, so reading the
 * same visits again changes nothing. Returns `list` itself when nothing changed.
 */
export function applyLiveHistory(
  list: HistoryRecord[],
  source: string,
  entries: readonly SyncedHistoryEntry[],
  newId: () => string,
  max = MAX_HISTORY_ENTRIES,
): { list: HistoryRecord[]; added: number } {
  const byUrl = new Map(list.map((e) => [e.url, e]));
  let added = 0;
  let changed = false;
  for (const entry of entries) {
    const existing = byUrl.get(entry.url);
    if (existing && !existing.source) continue;
    if (!existing) {
      byUrl.set(entry.url, { id: newId(), url: entry.url, title: entry.title, visitedAt: entry.visitedAt, visitCount: entry.visitCount, source });
      added++;
      changed = true;
      continue;
    }
    const later = entry.visitedAt >= existing.visitedAt;
    const next: HistoryRecord = {
      ...existing,
      title: later && entry.title ? entry.title : existing.title,
      visitedAt: Math.max(existing.visitedAt, entry.visitedAt),
      visitCount: Math.max(existing.visitCount, entry.visitCount),
    };
    if (next.title === existing.title && next.visitedAt === existing.visitedAt && next.visitCount === existing.visitCount) continue;
    byUrl.set(entry.url, next);
    changed = true;
  }
  if (!changed) return { list, added: 0 };
  const next = [...byUrl.values()];
  return { list: next.length > max ? prune(next, max) : next, added };
}

/** How many pages each browser brought live (entries Corvus has not visited itself). */
export function liveSourceCounts(list: readonly HistoryRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of list) if (e.source) counts[e.source] = (counts[e.source] ?? 0) + 1;
  return counts;
}

/** Most visited sites for the new tab page, one per host. */
export function topSites(list: HistoryRecord[], limit = 8): HistoryRecord[] {
  const byHost = new Map<string, HistoryRecord>();
  for (const entry of [...list].sort((a, b) => b.visitCount - a.visitCount || b.visitedAt - a.visitedAt)) {
    let host: string;
    try {
      host = new URL(entry.url).host;
    } catch {
      continue;
    }
    if (!byHost.has(host)) byHost.set(host, entry);
    if (byHost.size >= limit) break;
  }
  return [...byHost.values()];
}
