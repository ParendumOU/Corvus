/**
 * Live history from other browsers: which browser profiles a Corvus profile follows, where it is in
 * each one's visits, which visits come in, and when to look. Pure (no files), so the rules are unit
 * tested; main/live-history.ts reads the browsers' databases (from copies) and keeps the schedule.
 */
import type { SyncedHistoryEntry } from "./history-ops";

/** How far back a browser's visits are brought in when Corvus starts following it (or after a gap). */
export const LIVE_BACKFILL_MS = 7 * 24 * 3600_000;
/**
 * While a Corvus window of the profile is in front, a source is read this long after its files stop
 * changing (browsers write a commit in a burst of a few milliseconds), and never later than
 * LIVE_MAX_WAIT_MS after the first change.
 */
export const LIVE_DEBOUNCE_MS = 1000;
export const LIVE_MAX_WAIT_MS = 5000;
/** While Corvus is in the background, changes are read at most this often: switching to Corvus reads at once. */
export const LIVE_BACKGROUND_MS = 60_000;
/** A read that failed, or copied files that were being written, is tried again after this, then twice as long each time. */
export const LIVE_RETRY_MS = 3000;
/** The safety check for changes the file watcher missed. */
export const LIVE_POLL_MS = 5 * 60_000;
/** The same check while Corvus is in front and a followed browser wrote its history in the last LIVE_ACTIVE_MS. */
export const LIVE_ACTIVE_POLL_MS = 20_000;
export const LIVE_ACTIVE_MS = 10 * 60_000;
/** How long address bar suggestions wait for a read of what the browsers saved since the last look. */
export const LIVE_SUGGEST_WAIT_MS = 300;
/** Most visits taken from one read (the newest ones). */
export const LIVE_MAX_VISITS = 50_000;

/** Where a Corvus profile is in one browser profile's visits. */
export interface LiveCursor {
  /** Highest visit id the last read covered. */
  visitId: number;
  /** Newest visit time read (ms). */
  visitTime: number;
  /** Size and modification time of the source's files at the last settled read (filesStamp). */
  stamp: string;
}

/** A Corvus profile's setting, kept in the profile. */
export interface LiveHistoryConfig {
  /** On or off as the person set it; null while they never did, and then it is on (liveEnabled). */
  enabled: boolean | null;
  /**
   * The browser profiles the person picked, as sourceKey(browser, profile folder); null while they
   * picked none: then each browser's default profile is followed (liveDefaults).
   */
  sources: string[] | null;
  cursors: Record<string, LiveCursor>;
  /** Corvus said once (a bar under the toolbar) that it turned this on by itself. */
  noticeShown: boolean;
}

export const defaultLiveHistoryConfig = (): LiveHistoryConfig => ({ enabled: null, sources: null, cursors: {}, noticeShown: false });

/** On by default: only an Off the person chose turns it off. */
export const liveEnabled = (config: LiveHistoryConfig): boolean => config.enabled !== false;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function cleanLiveHistoryConfig(raw: unknown): LiveHistoryConfig {
  if (!isObject(raw)) return defaultLiveHistoryConfig();
  const sources = Array.isArray(raw.sources) ? [...new Set(raw.sources.filter((s): s is string => typeof s === "string" && parseSourceKey(s) !== null))] : null;
  const cursors: Record<string, LiveCursor> = {};
  if (isObject(raw.cursors)) {
    for (const [key, c] of Object.entries(raw.cursors)) {
      const kept = sources ? sources.includes(key) : parseSourceKey(key) !== null;
      if (kept && isObject(c) && isCount(c.visitId) && isCount(c.visitTime) && typeof c.stamp === "string") cursors[key] = { visitId: c.visitId, visitTime: c.visitTime, stamp: c.stamp };
    }
  }
  return { enabled: typeof raw.enabled === "boolean" ? raw.enabled : null, sources, cursors, noticeShown: raw.noticeShown === true };
}

/** The browser profiles followed while the person picked none: each browser's default one (its first when none is marked). */
export function liveDefaults(found: ReadonlyArray<{ key: string; browser: string; isDefault: boolean }>): string[] {
  const keys: string[] = [];
  for (const browser of new Set(found.map((s) => s.browser))) {
    const mine = found.filter((s) => s.browser === browser);
    keys.push((mine.find((s) => s.isDefault) ?? mine[0])!.key);
  }
  return keys;
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
 * The size and modification time of a source's files: the database, its write-ahead log and its
 * rollback journal, "-" for one that is missing. null when the database itself is missing: nothing
 * to read.
 */
export function filesStamp(files: ReadonlyArray<{ size: number; mtimeMs: number } | null>): string | null {
  if (!files[0]) return null;
  return files.map((f) => (f ? `${f.size}:${f.mtimeMs}` : "-")).join("|");
}

/**
 * What changed in a source's files since the last settled read. "journal": only the rollback
 * journal, which an open transaction fills (Chrome starts one right after each commit and saves it
 * about ten seconds later); the committed visits are in the database and the write-ahead log, so
 * nothing new can be read until one of those changes.
 */
export function liveChange(now: string | null, last: string | null): "none" | "read" | "journal" {
  if (now === null || now === last) return "none";
  if (last === null) return "read";
  const [db, wal] = now.split("|");
  const [lastDb, lastWal] = last.split("|");
  return db === lastDb && wal === lastWal ? "journal" : "read";
}

/** Whether two stamps have the same database file: a copy taken between them holds no half-written commit. */
export function sameDatabaseFile(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.split("|")[0] === b.split("|")[0];
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
  /** On because the person never turned it on or off: Corvus turned it on by itself. */
  byDefault: boolean;
  sources: LiveHistorySource[];
  /** Pages in this profile's history known only from each browser (by mark). */
  counts: Record<string, number>;
  /** Each browser's own icon on this computer (by mark, PNG data URLs); one without keeps its letter mark. */
  icons: Record<string, string>;
}

export interface LiveHistoryPatch {
  enabled?: boolean;
  /** The browser profiles to follow; null: each browser's default profile. */
  sources?: string[] | null;
}

/** A source of visits the schedule checks: the stamp of its files now, and a read of what is new. */
export interface LiveScheduleSource {
  stamp(): Promise<string | null>;
  /** The stamp of the files at the last settled read (null: never). */
  lastStamp(): string | null;
  /**
   * Reads the visits that are new, from a copy. True when the copy was settled (no commit was being
   * written while it was taken), which records `stamp`; false, or a throw, when it must be read again.
   */
  read(stamp: string): Promise<boolean>;
  /** Only an open transaction's journal changed (liveChange): nothing new to read, `stamp` counts as read. */
  skip(stamp: string): void;
}

export interface LiveScheduleOptions {
  debounceMs?: number;
  /** Whether a Corvus window of the profile is in front (default: yes). */
  foreground?: () => boolean;
}

/**
 * When one source is read: at once when asked (a Corvus window got focus, the person types in the
 * address bar, the safety poll), and after its files change: about a second after they stop while
 * Corvus is in front, at most once a minute while it is in the background. Only when the committed
 * part of its files changed since the last settled read, and never two reads at the same time (a
 * request during a read checks again once it ends). A read that failed or copied a commit being
 * written is tried again a few seconds later, then less and less often, without waiting for the
 * files to change again.
 */
export class LiveSchedule {
  /** When the files were last seen changing (ms; 0: not yet). */
  changedAt = 0;
  private touch: { timer: ReturnType<typeof setTimeout>; first: number } | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  /** The stamp a read failed on: read again by the retry, not by every check. */
  private pending: string | null = null;
  private forced = false;
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private readonly debounceMs: number;
  private readonly foreground: () => boolean;

  constructor(
    private readonly source: LiveScheduleSource,
    options: LiveScheduleOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? LIVE_DEBOUNCE_MS;
    this.foreground = options.foreground ?? (() => true);
  }

  /** Reads now if the files changed. */
  check(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.clearTouch();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop();
    return this.running;
  }

  /** The files changed. */
  touched(): void {
    if (this.closed) return;
    const now = Date.now();
    this.changedAt = now;
    const first = this.touch?.first ?? now;
    const due = this.foreground() ? Math.min(now + this.debounceMs, first + LIVE_MAX_WAIT_MS) : first + LIVE_BACKGROUND_MS;
    if (this.touch) clearTimeout(this.touch.timer);
    const timer = setTimeout(() => {
      this.touch = null;
      void this.check();
    }, Math.max(0, due - now));
    this.touch = { timer, first };
  }

  close(): void {
    this.closed = true;
    this.clearTouch();
    this.settle();
  }

  private clearTouch(): void {
    if (this.touch) clearTimeout(this.touch.timer);
    this.touch = null;
  }

  private settle(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.pending = null;
    this.failures = 0;
  }

  private retryLater(stamp: string): void {
    this.pending = stamp;
    if (this.retry) clearTimeout(this.retry);
    const delay = Math.min(LIVE_RETRY_MS * 2 ** this.failures, LIVE_POLL_MS);
    this.failures++;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.forced = true;
      void this.check();
    }, delay);
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.again = false;
        const forced = this.forced;
        this.forced = false;
        const stamp = await this.source.stamp().catch(() => null);
        if (this.closed) break;
        const change = liveChange(stamp, this.source.lastStamp());
        if (change === "none" || stamp === null) {
          this.settle();
          continue;
        }
        this.changedAt = Date.now();
        if (change === "journal") {
          this.source.skip(stamp);
          this.settle();
          continue;
        }
        if (stamp === this.pending && !forced) continue;
        const settled = await this.source.read(stamp).catch(() => false);
        if (this.closed) break;
        if (settled) this.settle();
        else this.retryLater(stamp);
      } while (this.again && !this.closed);
    } finally {
      this.running = null;
    }
  }
}
