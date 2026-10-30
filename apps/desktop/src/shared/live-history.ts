/**
 * Live history from other browsers: which browser profiles a Corvus profile follows, where it is in
 * each one's visits, which visits come in, and when to look. Pure (no files), so the rules are unit
 * tested; main/live-history.ts reads the browsers' databases (from copies) and keeps the schedule.
 */
import type { SyncedHistoryEntry } from "./history-ops";

/** How far back a browser's visits are brought in when Corvus starts following it (or after a gap). */
export const LIVE_BACKFILL_MS = 7 * 24 * 3600_000;
/** A source is read this long after its files last changed: browsers write their history in bursts. */
export const LIVE_DEBOUNCE_MS = 2000;
/** The safety check while the setting is on, for changes the file watcher missed. */
export const LIVE_POLL_MS = 5 * 60_000;
/** Most visits taken from one read (the newest ones). */
export const LIVE_MAX_VISITS = 50_000;

/** Where a Corvus profile is in one browser profile's visits. */
export interface LiveCursor {
  /** Highest visit id the last read covered. */
  visitId: number;
  /** Newest visit time read (ms). */
  visitTime: number;
  /** Size and modification time of the source's files at the last read (filesStamp). */
  stamp: string;
}

/** A Corvus profile's setting, kept in the profile. */
export interface LiveHistoryConfig {
  enabled: boolean;
  /** Followed browser profiles, as sourceKey(browser, profile folder). */
  sources: string[];
  cursors: Record<string, LiveCursor>;
}

export const defaultLiveHistoryConfig = (): LiveHistoryConfig => ({ enabled: false, sources: [], cursors: {} });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function cleanLiveHistoryConfig(raw: unknown): LiveHistoryConfig {
  if (!isObject(raw)) return defaultLiveHistoryConfig();
  const sources = Array.isArray(raw.sources) ? [...new Set(raw.sources.filter((s): s is string => typeof s === "string" && parseSourceKey(s) !== null))] : [];
  const cursors: Record<string, LiveCursor> = {};
  if (isObject(raw.cursors)) {
    for (const [key, c] of Object.entries(raw.cursors)) {
      if (sources.includes(key) && isObject(c) && isCount(c.visitId) && isCount(c.visitTime) && typeof c.stamp === "string") cursors[key] = { visitId: c.visitId, visitTime: c.visitTime, stamp: c.stamp };
    }
  }
  return { enabled: raw.enabled === true, sources, cursors };
}

/** "chrome/Default", "firefox/abcd1234.default-release": a browser id and one of its profile folders. */
export function sourceKey(browser: string, profileDir: string): string {
  return `${browser}/${profileDir}`;
}

export function parseSourceKey(key: string): { browser: string; profileDir: string } | null {
  const at = key.indexOf("/");
  if (at <= 0 || key.length > 1100) return null;
  const browser = key.slice(0, at);
  return /^[a-z][a-z0-9-]*$/.test(browser) ? { browser, profileDir: key.slice(at + 1) } : null;
}

/** The browser a page came from, as its history entries are marked: the same for its snap and flatpak installs. */
export function sourceMark(browser: string): string {
  return browser.replace(/-(snap|flatpak)$/, "");
}

/** Short names of the browsers, for "From Chrome" and "Forget visits from Chrome". */
export const LIVE_SOURCE_NAMES: Readonly<Record<string, string>> = {
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  vivaldi: "Vivaldi",
  opera: "Opera",
  "opera-gx": "Opera GX",
  chromium: "Chromium",
  firefox: "Firefox",
};

export const liveSourceName = (mark: string): string => LIVE_SOURCE_NAMES[mark] ?? mark;

/** One visit read from a browser: its id there, when (ms), the page, and how often that browser has visited the page. */
export interface LiveVisit {
  id: number;
  visitedAt: number;
  url: string;
  title: string;
  visitCount: number;
}

/**
 * Which visits a read takes: those after the cursor and no older than the backfill. When the
 * browser's highest visit id is below the cursor, its history was cleared or replaced: it is read
 * from its start again, from the newest visit already read on.
 */
export function readWindow(cursor: LiveCursor | undefined, maxId: number, now: number): { afterId: number; since: number } {
  const floor = now - LIVE_BACKFILL_MS;
  if (!cursor) return { afterId: 0, since: floor };
  if (maxId < cursor.visitId) return { afterId: 0, since: Math.max(floor, cursor.visitTime + 1) };
  return { afterId: cursor.visitId, since: floor };
}

/** The cursor once visits up to `maxId` were read from files with `stamp`. */
export function nextCursor(prev: LiveCursor | undefined, visits: readonly LiveVisit[], maxId: number, stamp: string): LiveCursor {
  let visitTime = prev?.visitTime ?? 0;
  for (const v of visits) if (v.visitedAt > visitTime) visitTime = v.visitedAt;
  return { visitId: maxId, visitTime, stamp };
}

/**
 * The history entries a batch of visits brings: one per web page (http and https only), at its
 * latest visit, with the browser's visit count (at least the visits seen), so reading the same
 * visits twice gives the same entries.
 */
export function liveEntries(visits: readonly LiveVisit[]): SyncedHistoryEntry[] {
  const byUrl = new Map<string, SyncedHistoryEntry & { seen: number }>();
  for (const v of visits) {
    if (!/^https?:\/\//i.test(v.url) || v.url.length > 8192 || !Number.isFinite(v.visitedAt) || v.visitedAt <= 0) continue;
    const found = byUrl.get(v.url);
    const title = v.title.slice(0, 500);
    if (!found) {
      byUrl.set(v.url, { url: v.url, title, visitedAt: v.visitedAt, visitCount: Math.max(1, v.visitCount), seen: 1 });
      continue;
    }
    found.seen++;
    if (v.visitedAt >= found.visitedAt) {
      found.visitedAt = v.visitedAt;
      if (title) found.title = title;
    }
    found.visitCount = Math.max(found.visitCount, v.visitCount, found.seen);
  }
  return [...byUrl.values()].map(({ seen: _seen, ...entry }) => entry);
}

/**
 * The size and modification time of a source's files (the database, then its journal or WAL; null
 * for one that is missing). null when the database itself is missing: nothing to read.
 */
export function filesStamp(files: ReadonlyArray<{ size: number; mtimeMs: number } | null>): string | null {
  if (!files[0]) return null;
  return files.map((f) => (f ? `${f.size}:${f.mtimeMs}` : "-")).join("|");
}

/** What one read of a source did, for Settings. */
export interface LiveSourceStatus {
  readAt: number;
  /** New pages it added to the history. */
  added: number;
  /** How long it took (copy, read and merge), in ms. */
  ms: number;
  error?: string;
}

/** A browser profile Corvus can follow, as Settings lists it. */
export interface LiveHistorySource {
  key: string;
  /** Browser id ("chrome", "firefox-snap") and the mark its pages get ("firefox"). */
  browser: string;
  mark: string;
  browserName: string;
  profileName: string;
  isDefault: boolean;
  followed: boolean;
  status?: LiveSourceStatus;
}

export interface LiveHistoryView {
  enabled: boolean;
  sources: LiveHistorySource[];
  /** Pages in this profile's history known only from each browser (by mark). */
  counts: Record<string, number>;
}

export interface LiveHistoryPatch {
  enabled?: boolean;
  sources?: string[];
}

/** A source of visits the schedule checks: the stamp of its files now, and a read of what is new. */
export interface LiveScheduleSource {
  stamp(): Promise<string | null>;
  /** The stamp of the files when they were last read (null: never). */
  lastStamp(): string | null;
  /** Reads the visits that are new; records `stamp` as read, also when the read fails. */
  read(stamp: string): Promise<void>;
}

/**
 * When one source is read: at once when asked (a Corvus window got focus, the safety poll), and a
 * moment after its files stop changing. Only when its files changed since the last read, and never
 * two reads at the same time (a request during a read checks again once it ends).
 */
export class LiveSchedule {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;

  constructor(
    private readonly source: LiveScheduleSource,
    private readonly debounceMs = LIVE_DEBOUNCE_MS,
  ) {}

  /** Reads now if the files changed. */
  check(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop();
    return this.running;
  }

  /** The files changed: checks once they have been quiet for the debounce. */
  touched(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, this.debounceMs);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.again = false;
        const stamp = await this.source.stamp().catch(() => null);
        if (stamp !== null && stamp !== this.source.lastStamp() && !this.closed) await this.source.read(stamp).catch(() => undefined);
      } while (this.again && !this.closed);
    } finally {
      this.running = null;
    }
  }
}
