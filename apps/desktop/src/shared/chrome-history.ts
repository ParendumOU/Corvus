import type { HistoryRecord } from "./history-ops";

/**
 * chrome.history over Corvus's history: Chrome's item shape and search. Corvus keeps one entry per
 * address (last visit and count), so getVisits answers with that last visit. Pure, for the main
 * process and the tests.
 */
export interface ChromeHistoryItem {
  id: string;
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
  typedCount: number;
}

export interface ChromeVisitItem {
  id: string;
  visitId: string;
  visitTime: number;
  referringVisitId: string;
  transition: "link";
  isLocal: boolean;
}

export interface HistoryQuery {
  text?: string;
  startTime?: number;
  endTime?: number;
  maxResults?: number;
}

/** Chrome's default window when a search gives no start: the last 24 hours. */
const DEFAULT_SPAN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESULTS = 100;

export const toHistoryItem = (e: HistoryRecord): ChromeHistoryItem => ({
  id: e.id,
  url: e.url,
  title: e.title,
  lastVisitTime: e.visitedAt,
  visitCount: e.visitCount,
  typedCount: 0,
});

/** chrome.history.search(): every word in the title or address, last visit in the window, newest first. */
export function searchHistory(list: HistoryRecord[], query: HistoryQuery, now: number): ChromeHistoryItem[] {
  const start = typeof query.startTime === "number" ? query.startTime : now - DEFAULT_SPAN_MS;
  const end = typeof query.endTime === "number" ? query.endTime : now;
  const words = (query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const max = typeof query.maxResults === "number" && query.maxResults > 0 ? Math.floor(query.maxResults) : query.maxResults === 0 ? Infinity : DEFAULT_RESULTS;
  return list
    .filter((e) => e.visitedAt >= start && e.visitedAt <= end && words.every((w) => `${e.title} ${e.url}`.toLowerCase().includes(w)))
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, max)
    .map(toHistoryItem);
}

/** chrome.history.getVisits(): the last visit Corvus keeps for that address. */
export function visitsFor(list: HistoryRecord[], url: string): ChromeVisitItem[] {
  return list
    .filter((e) => e.url === url)
    .map((e) => ({ id: e.id, visitId: e.id, visitTime: e.visitedAt, referringVisitId: "0", transition: "link", isLocal: true }));
}
