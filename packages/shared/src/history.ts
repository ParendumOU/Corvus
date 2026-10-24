/**
 * Synced browsing history (collection `history`, one record per URL, keyed by the URL). Visits to
 * the same page on several devices merge into one entry.
 */

export interface SyncedHistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
  visitCount: number;
  faviconUrl?: string;
}

export function parseSyncedHistory(raw: unknown): SyncedHistoryEntry | null {
  const v = raw as Partial<SyncedHistoryEntry> | null;
  if (typeof v?.url !== "string" || v.url.length === 0 || v.url.length > 8192) return null;
  if (typeof v.visitedAt !== "number" || !Number.isFinite(v.visitedAt)) return null;
  return {
    url: v.url,
    title: typeof v.title === "string" ? v.title.slice(0, 1000) : "",
    visitedAt: v.visitedAt,
    visitCount: typeof v.visitCount === "number" && v.visitCount >= 1 ? Math.floor(v.visitCount) : 1,
    ...(typeof v.faviconUrl === "string" && v.faviconUrl.length <= 8192 ? { faviconUrl: v.faviconUrl } : {}),
  };
}
