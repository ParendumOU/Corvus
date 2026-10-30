import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { chromiumTime, firefoxTime, toChromiumTime, toFirefoxTime, type BrowserFamily } from "../shared/browser-import";
import {
  LIVE_MAX_VISITS,
  LIVE_POLL_MS,
  LiveSchedule,
  filesStamp,
  liveEntries,
  nextCursor,
  readWindow,
  sourceKey,
  sourceMark,
  type LiveCursor,
  type LiveHistoryPatch,
  type LiveHistoryView,
  type LiveSourceStatus,
  type LiveVisit,
} from "../shared/live-history";
import { withDatabase } from "./browser-import";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";

/** A followed browser profile: where its database is and what its pages are marked with. */
interface Source {
  key: string;
  mark: string;
  family: BrowserFamily;
  /** The profile folder (watched) and the database's files, the database first. */
  dir: string;
  files: string[];
}

interface Followed {
  source: Source;
  schedule: LiveSchedule;
  unwatch: () => void;
}

const FILES: Record<BrowserFamily, string[]> = {
  chromium: ["History", "History-journal", "History-wal"],
  firefox: ["places.sqlite", "places.sqlite-wal", "places.sqlite-journal"],
};

type Row = { id: bigint; t: bigint; url: string; title: string | null; n: bigint };

function visitsOf(db: DatabaseSync, cursor: LiveCursor | undefined, family: BrowserFamily, now: number): { visits: LiveVisit[]; maxId: number } {
  const table = family === "chromium" ? "visits" : "moz_historyvisits";
  const maxId = Number((db.prepare(`SELECT coalesce(max(id), 0) AS m FROM ${table}`).get() as { m: number | bigint }).m);
  const { afterId, since } = readWindow(cursor, maxId, now);
  // Main-frame visits of pages the browser shows in its history: Chromium leaves out subframe
  // navigations (core transitions 3 and 4), Firefox embedded loads, downloads and framed links.
  const sql =
    family === "chromium"
      ? "SELECT v.id AS id, v.visit_time AS t, u.url AS url, u.title AS title, u.visit_count AS n FROM visits v JOIN urls u ON u.id = v.url WHERE v.id > ? AND v.id <= ? AND v.visit_time >= ? AND u.hidden = 0 AND (v.transition & 255) NOT IN (3, 4) ORDER BY v.id DESC LIMIT ?"
      : "SELECT v.id AS id, v.visit_date AS t, p.url AS url, p.title AS title, p.visit_count AS n FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id WHERE v.id > ? AND v.id <= ? AND v.visit_date >= ? AND p.hidden = 0 AND v.visit_type NOT IN (4, 7, 8) ORDER BY v.id DESC LIMIT ?";
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  const found = statement.all(afterId, maxId, family === "chromium" ? toChromiumTime(since) : toFirefoxTime(since), LIVE_MAX_VISITS) as unknown as Row[];
  const time = family === "chromium" ? chromiumTime : firefoxTime;
  return { visits: found.map((r) => ({ id: Number(r.id), visitedAt: time(r.t), url: r.url, title: r.title ?? "", visitCount: Number(r.n) })), maxId };
}

async function stat(file: string): Promise<fs.Stats | null> {
  return fs.promises.stat(file).catch(() => null);
}

/**
 * "Live history from other browsers": pages opened in the browser profiles a Corvus profile follows
 * come into its history (local only) as they are visited. A followed database is read when a Corvus
 * window of the profile gets focus, about two seconds after its files stop changing (a watcher on
 * the profile folder), and on a slow safety poll; each time only if its files changed since the last
 * read, and only the visits after the profile's cursor, from a private copy. Nothing runs while the
 * setting is off.
 */
export class LiveHistoryService {
  private readonly followed = new Map<ProfileRuntime, Map<string, Followed>>();
  private readonly status = new WeakMap<ProfileRuntime, Map<string, LiveSourceStatus>>();
  private readonly watchers = new Map<string, { watcher: fs.FSWatcher; listeners: Set<(file: string) => void> }>();
  private poll: NodeJS.Timeout | null = null;
  /** Copies made of a browser's database (an unchanged one makes none). */
  copies = 0;

  constructor(private readonly ctx: AppContext) {}

  /** Switching to a Corvus window reads what its profile's browsers saved meanwhile. */
  start(): void {
    this.ctx.windows.onFocus((win) => void this.check(win.profile));
  }

  stop(): void {
    for (const runtime of [...this.followed.keys()]) this.unfollow(runtime);
  }

  attach(runtime: ProfileRuntime): void {
    this.apply(runtime);
  }

  /** Reads every followed browser profile of `runtime` whose files changed. */
  async check(runtime: ProfileRuntime): Promise<void> {
    // A profile that was removed stops following anything.
    if (!this.ctx.profiles.loaded().includes(runtime)) {
      this.unfollow(runtime);
      return;
    }
    await Promise.all([...(this.followed.get(runtime)?.values() ?? [])].map((f) => f.schedule.check()));
  }

  async view(runtime: ProfileRuntime): Promise<LiveHistoryView> {
    const config = runtime.liveHistory.get();
    const status = this.status.get(runtime);
    return {
      enabled: config.enabled,
      sources: this.ctx.browserImport.locate().flatMap((browser) =>
        browser.profiles.map((p) => {
          const key = sourceKey(browser.id, p.dir);
          const known = status?.get(key);
          return {
            key,
            browser: browser.id,
            mark: sourceMark(browser.id),
            browserName: browser.name,
            profileName: browser.profiles.length > 1 ? p.name : browser.name,
            isDefault: p.isDefault,
            followed: config.sources.includes(key),
            ...(known ? { status: known } : {}),
          };
        }),
      ),
      counts: runtime.history.liveCounts(),
    };
  }

  /** Turns the setting on or off, or changes the followed browser profiles; reads what they hold now. */
  async set(runtime: ProfileRuntime, patch: LiveHistoryPatch): Promise<LiveHistoryView> {
    runtime.liveHistory.set(patch);
    this.apply(runtime);
    await this.check(runtime);
    return this.view(runtime);
  }

  /** "Forget visits from Chrome": every page this profile knows only from that browser goes. */
  async forget(runtime: ProfileRuntime, mark: string): Promise<LiveHistoryView> {
    runtime.history.forgetSource(mark);
    return this.view(runtime);
  }

  /** Follows what the profile's setting says: watchers and schedules for its browser profiles, none when off. */
  private apply(runtime: ProfileRuntime): void {
    const config = runtime.liveHistory.get();
    const wanted = config.enabled ? config.sources : [];
    const current = this.followed.get(runtime) ?? new Map<string, Followed>();
    for (const [key, f] of current) {
      if (wanted.includes(key)) continue;
      f.schedule.close();
      f.unwatch();
      current.delete(key);
    }
    const missing = wanted.filter((key) => !current.has(key));
    if (missing.length > 0) {
      for (const source of this.sources(missing)) {
        const schedule = new LiveSchedule({
          stamp: async () => filesStamp(await Promise.all(source.files.map(stat))),
          lastStamp: () => runtime.liveHistory.cursor(source.key)?.stamp ?? null,
          read: (stamp) => this.read(runtime, source, stamp),
        });
        const unwatch = this.watch(source, () => schedule.touched());
        current.set(source.key, { source, schedule, unwatch });
      }
    }
    if (current.size > 0) this.followed.set(runtime, current);
    else this.followed.delete(runtime);
    this.updatePoll();
  }

  private unfollow(runtime: ProfileRuntime): void {
    for (const f of this.followed.get(runtime)?.values() ?? []) {
      f.schedule.close();
      f.unwatch();
    }
    this.followed.delete(runtime);
    this.updatePoll();
  }

  /** The browser profiles behind `keys` that are still on this computer. */
  private sources(keys: readonly string[]): Source[] {
    const found: Source[] = [];
    for (const browser of this.ctx.browserImport.locate()) {
      for (const p of browser.profiles) {
        const key = sourceKey(browser.id, p.dir);
        if (!keys.includes(key)) continue;
        const mark = sourceMark(browser.id);
        found.push({ key, mark, family: browser.family, dir: p.path, files: FILES[browser.family].map((f) => path.join(p.path, f)) });
      }
    }
    return found;
  }

  private async read(runtime: ProfileRuntime, source: Source, stamp: string): Promise<void> {
    const started = performance.now();
    const cursor = runtime.liveHistory.cursor(source.key);
    const statuses = this.status.get(runtime) ?? new Map<string, LiveSourceStatus>();
    this.status.set(runtime, statuses);
    try {
      this.copies++;
      const { visits, maxId } = await withDatabase(source.files[0]!, (db) => visitsOf(db, cursor, source.family, Date.now()));
      if (!this.ctx.profiles.loaded().includes(runtime)) return;
      const added = runtime.history.mergeLive(source.mark, liveEntries(visits));
      runtime.liveHistory.setCursor(source.key, nextCursor(cursor, visits, maxId, stamp));
      statuses.set(source.key, { readAt: Date.now(), added, ms: Math.round(performance.now() - started) });
    } catch (err) {
      // Not again until the files change: a copy taken while the browser was writing is read at its next write.
      runtime.liveHistory.setCursor(source.key, { visitId: cursor?.visitId ?? 0, visitTime: cursor?.visitTime ?? 0, stamp });
      statuses.set(source.key, { readAt: Date.now(), added: 0, ms: Math.round(performance.now() - started), error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Watches the profile folder (the database and its journal or WAL come and go) for the source's files. */
  private watch(source: Source, changed: () => void): () => void {
    const names = new Set(source.files.map((f) => path.basename(f)));
    const listener = (file: string): void => {
      if (names.has(file)) changed();
    };
    let entry = this.watchers.get(source.dir);
    if (!entry) {
      try {
        const listeners = new Set<(file: string) => void>();
        const watcher = fs.watch(source.dir, { persistent: false }, (_event, file) => {
          if (file) for (const l of listeners) l(String(file));
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(source.dir);
        });
        entry = { watcher, listeners };
        this.watchers.set(source.dir, entry);
      } catch {
        // No watcher (the folder went away): focus and the poll still read it.
        return () => undefined;
      }
    }
    entry.listeners.add(listener);
    const dir = source.dir;
    return () => {
      const current = this.watchers.get(dir);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        current.watcher.close();
        this.watchers.delete(dir);
      }
    };
  }

  /** The safety poll runs only while some profile follows a browser. */
  private updatePoll(): void {
    if (this.followed.size > 0 && !this.poll) {
      this.poll = setInterval(() => {
        for (const runtime of this.followed.keys()) void this.check(runtime);
      }, LIVE_POLL_MS);
      this.poll.unref();
    } else if (this.followed.size === 0 && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }
}
