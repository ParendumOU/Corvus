/** Browsing history from every device of the chain, as the phone shows it. */
import { parseSyncedHistory, type SyncedHistoryEntry } from '@corvus/shared';

/** How many entries the history screen shows at a time ("Show more" adds as many). */
export const HISTORY_PAGE = 200;

/** Every valid entry, most recent visit first. */
export function historyList(records: Record<string, unknown>): SyncedHistoryEntry[] {
  const out: SyncedHistoryEntry[] = [];
  for (const raw of Object.values(records)) {
    const entry = parseSyncedHistory(raw);
    if (entry && /^https?:\/\//i.test(entry.url)) out.push(entry);
  }
  return out.sort((a, b) => b.visitedAt - a.visitedAt);
}

/** Entries whose title or address contain every word of the query (order kept). */
export function searchHistory(entries: readonly SyncedHistoryEntry[], query: string): SyncedHistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((e) => {
    const text = `${e.title} ${e.url}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const dayStart = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "Today", "Yesterday", "Monday 21 October", or with the year when it is not this year (local time). */
export function dayLabel(ms: number, now: number = Date.now()): string {
  const start = dayStart(ms);
  const today = dayStart(now);
  if (start === today) return 'Today';
  if (start === dayStart(today - 1)) return 'Yesterday';
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

export interface HistoryDay {
  label: string;
  entries: SyncedHistoryEntry[];
}

/** Consecutive entries of the same day, in the order given (most recent first). */
export function groupByDay(entries: readonly SyncedHistoryEntry[], now: number = Date.now()): HistoryDay[] {
  const days: HistoryDay[] = [];
  for (const entry of entries) {
    const label = dayLabel(entry.visitedAt, now);
    const last = days[days.length - 1];
    if (last?.label === label) last.entries.push(entry);
    else days.push({ label, entries: [entry] });
  }
  return days;
}

/** "14:05" in local time. */
export function timeOfDay(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
