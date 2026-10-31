import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { chromiumTime, firefoxTime, toChromiumTime, toFirefoxTime, type BrowserFamily } from "../shared/browser-import";
import {
  LIVE_ACTIVE_MS,
  LIVE_ACTIVE_POLL_MS,
  LIVE_MAX_VISITS,
  LIVE_POLL_MS,
  LIVE_RETRY_MS,
  LIVE_SUGGEST_WAIT_MS,
  LiveSchedule,
  filesStamp,
  liveDefaults,
  liveEnabled,
  liveEntries,
  liveSourceName,
  nextCursor,
  readWindow,
  sameDatabaseFile,
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
import { tr, uiLanguage } from "./menu-i18n";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

/** Where the setting is, for the bar's Settings button. */
export const LIVE_HISTORY_SETTINGS_URL = "corvus://settings/#live-history";
/** A profile's browsers are first looked at this long after it loads, so starting Corvus is not slowed. */
const START_DELAY_MS = 2500;

/** A browser profile on this computer: where its database is and what its pages are marked with. */
interface Source {
  key: string;
  browser: string;
  mark: string;
  family: BrowserFamily;
  isDefault: boolean;
  /** The profile folder (watched) and the database's files: the database, its write-ahead log, its journal. */
  dir: string;
  files: string[];
}

interface Followed {
  source: Source;
  schedule: LiveSchedule;
  unwatch: () => void;
}

interface Watch {
  watcher: fs.FSWatcher | null;
  listeners: Set<(file: string | null) => void>;
  retry: NodeJS.Timeout | null;
}

const FILES: Record<BrowserFamily, string[]> = {
  chromium: ["History", "History-wal", "History-journal"],
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

const stampOf = async (source: Source): Promise<string | null> => filesStamp(await Promise.all(source.files.map(stat)));

/** "Chrome", "Chrome and Edge", "Chrome, Edge and Firefox", in Corvus's language. */
function browserList(names: readonly string[]): string {
  return new Intl.ListFormat(uiLanguage(), { style: "long", type: "conjunction" }).format(names);
}

/**
 * "Live history from other browsers": pages opened in the browser profiles a Corvus profile follows
 * come into its history (local only) as they are visited. On by default, following each browser's
 * default profile, until the person turns it off or picks profiles. Chromium browsers save a visit
 * about ten seconds after it (Firefox at once); a followed database is then read about a second
 * after its files change while Corvus is in front (a watcher on the profile folder), at most once a
 * minute while it is in the background, at once when a Corvus window gets focus or the person types
 * in the address bar, and on a safety poll; each time only if its committed files changed since the
 * last read, and only the visits after the profile's cursor, from a private copy. Private windows
 * never read it. Nothing runs while the setting is off.
 */
export class LiveHistoryService {
  private readonly followed = new Map<ProfileRuntime, Map<string, Followed>>();
  private readonly status = new WeakMap<ProfileRuntime, Map<string, LiveSourceStatus>>();
  private readonly watchers = new Map<string, Watch>();
  private readonly starting = new Set<NodeJS.Timeout>();
  private readonly polled = new WeakMap<ProfileRuntime, number>();
  private poll: NodeJS.Timeout | null = null;
  private announcing = false;
  private readonly changeListeners = new Set<(runtime: ProfileRuntime) => void>();
  /** Copies made of a browser's database (an unchanged one makes none). */
  copies = 0;

  constructor(private readonly ctx: AppContext) {}

  /**
   * Switching to a Corvus window reads what its profile's browsers saved meanwhile. With `announce`
   * (not in automated runs), the first window in front says once that Corvus turned it on by itself.
   */
  start(options: { announce?: boolean } = {}): void {
    this.announcing = options.announce === true;
    this.ctx.windows.onFocus((win) => {
      if (win.isPrivate) return;
      void this.check(win.profile).then(() => (this.announcing ? this.announce(win) : undefined));
    });
  }

  /** What a profile's Settings shows changed: browsers followed, a read, pages forgotten. */
  onChange(listener: (runtime: ProfileRuntime) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(runtime: ProfileRuntime): void {
    for (const l of this.changeListeners) l(runtime);
  }

  stop(): void {
    for (const timer of this.starting) clearTimeout(timer);
    this.starting.clear();
    for (const runtime of [...this.followed.keys()]) this.unfollow(runtime);
  }

  /** A profile loaded: its browsers are followed, and read, a moment later (or at once with `delayMs` 0). */
  attach(runtime: ProfileRuntime, delayMs = START_DELAY_MS): void {
    const timer = setTimeout(() => {
      this.starting.delete(timer);
      this.apply(runtime);
      // Their icons are ready before the address bar first suggests one of their pages.
      void this.ctx.browserIcons.icons([...(this.followed.get(runtime)?.values() ?? [])].map((f) => f.source.mark));
      void this.check(runtime).then(() => {
        const win = this.ctx.windows.inFront();
        if (this.announcing && win?.profile === runtime) return this.announce(win);
      });
    }, delayMs);
    timer.unref();
    this.starting.add(timer);
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

  /**
   * The address bar asks for suggestions: what the followed browsers saved since the last look is
   * read first, waiting at most `waitMs` (an unchanged database only costs a look at its files).
   */
  async fresh(runtime: ProfileRuntime, waitMs = LIVE_SUGGEST_WAIT_MS): Promise<void> {
    if (!this.followed.get(runtime)?.size) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.check(runtime), new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
  }

  async view(runtime: ProfileRuntime): Promise<LiveHistoryView> {
    const config = runtime.liveHistory.get();
    const status = this.status.get(runtime);
    const sources = this.ctx.browserImport.locate().flatMap((browser) =>
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
          followed: false,
          ...(known ? { status: known } : {}),
        };
      }),
    );
    // Followed by default: the profiles followed now, or (off, or not looked at yet) each browser's default.
    const followed = config.sources ?? (liveEnabled(config) ? this.followedKeys(runtime) : undefined) ?? liveDefaults(sources);
    const counts = runtime.history.liveCounts();
    return {
      enabled: liveEnabled(config),
      byDefault: config.enabled === null,
      sources: sources.map((s) => ({ ...s, followed: followed.includes(s.key) })),
      counts,
      icons: await this.ctx.browserIcons.icons([...sources.map((s) => s.mark), ...Object.keys(counts)]),
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
    this.changed(runtime);
    return this.view(runtime);
  }

  /**
   * Says once, in a quiet bar under the toolbar, that Corvus turned this on by itself: which
   * browsers, that their pages stay on this computer, and Settings or Turn off (which also removes
   * the pages it brought). Only while the person never chose on or off, never in a private window,
   * over an AI agent's tab or next to another bar; it waits for a later focus then.
   */
  async announce(win: BrowserWindowCtl): Promise<void> {
    const runtime = win.profile;
    const config = runtime.liveHistory.get();
    if (win.isPrivate || config.enabled !== null || config.noticeShown || win.win.isDestroyed()) return;
    if (win.activeTab()?.agentControlled || this.ctx.dialogs.bars(win).length > 0 || this.ctx.defaultBrowser.offerFor(win)) return;
    const names = [...new Set([...(this.followed.get(runtime)?.values() ?? [])].map((f) => liveSourceName(f.source.mark)))];
    if (names.length === 0) return;
    runtime.liveHistory.setNoticeShown(true);
    const answer = await this.ctx.dialogs.ask(
      {
        tone: "info",
        title: tr("Live history from other browsers"),
        message: tr("Corvus now also suggests the pages you visit in {browsers} when you type in the address bar.", { browsers: browserList(names) }),
        detail: tr("They stay on this computer and are not synced."),
        buttons: [tr("Turn off"), tr("Settings"), tr("OK")],
        defaultId: 2,
        cancelId: 2,
        bar: true,
      },
      win,
    );
    if (answer.button === 1) win.openSingleton(LIVE_HISTORY_SETTINGS_URL);
    if (answer.button !== 0 || runtime.liveHistory.get().enabled !== null) return;
    await this.set(runtime, { enabled: false });
    for (const mark of Object.keys(runtime.history.liveCounts())) runtime.history.forgetSource(mark);
    this.changed(runtime);
  }

  /** The browser profiles followed now, by key (undefined: none followed yet). */
  private followedKeys(runtime: ProfileRuntime): string[] | undefined {
    const current = this.followed.get(runtime);
    return current ? [...current.keys()] : undefined;
  }

  /** Every browser profile on this computer. */
  private located(): Source[] {
    return this.ctx.browserImport.locate().flatMap((browser) =>
      browser.profiles.map((p) => ({
        key: sourceKey(browser.id, p.dir),
        browser: browser.id,
        mark: sourceMark(browser.id),
        family: browser.family,
        isDefault: p.isDefault,
        dir: p.path,
        files: FILES[browser.family].map((f) => path.join(p.path, f)),
      })),
    );
  }

  /** Whether a Corvus window of `runtime` (not a private one) is in front of the other apps. */
  private inFront(runtime: ProfileRuntime): boolean {
    const win = this.ctx.windows.inFront();
    return !!win && !win.isPrivate && win.profile === runtime;
  }

  /** Follows what the profile's setting says: watchers and schedules for its browser profiles, none when off. */
  private apply(runtime: ProfileRuntime): void {
    const config = runtime.liveHistory.get();
    const located = liveEnabled(config) ? this.located() : [];
    // Followed by default, the cursors of browser profiles not followed now stay: one found again later goes on where it was.
    const wanted = liveEnabled(config) ? (config.sources ?? liveDefaults(located)) : [];
    const current = this.followed.get(runtime) ?? new Map<string, Followed>();
    for (const [key, f] of current) {
      if (wanted.includes(key)) continue;
      f.schedule.close();
      f.unwatch();
      current.delete(key);
    }
    for (const source of located) {
      if (!wanted.includes(source.key) || current.has(source.key)) continue;
      const schedule = new LiveSchedule(
        {
          stamp: () => stampOf(source),
          lastStamp: () => runtime.liveHistory.cursor(source.key)?.stamp ?? null,
          read: (stamp) => this.read(runtime, source, stamp),
          skip: (stamp) => {
            const cursor = runtime.liveHistory.cursor(source.key);
            if (cursor) runtime.liveHistory.setCursor(source.key, { ...cursor, stamp });
          },
        },
        { foreground: () => this.inFront(runtime) },
      );
      const unwatch = this.watch(source, () => schedule.touched());
      current.set(source.key, { source, schedule, unwatch });
    }
    // An empty map still says "following none" to Settings until the setting changes.
    this.followed.set(runtime, current);
    this.changed(runtime);
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

  /**
   * Reads the visits after the cursor from a copy. A copy taken while a commit was being written
   * (the database changed meanwhile, or its journal was being played back) is not used: it is read
   * again shortly. A failed read is tried again too (the schedule retries both).
   */
  private async read(runtime: ProfileRuntime, source: Source, stamp: string): Promise<boolean> {
    const started = performance.now();
    const cursor = runtime.liveHistory.cursor(source.key);
    const statuses = this.status.get(runtime) ?? new Map<string, LiveSourceStatus>();
    this.status.set(runtime, statuses);
    try {
      this.copies++;
      const { visits, maxId, journalHot } = await withDatabase(source.files[0]!, (db, copied) => ({ ...visitsOf(db, cursor, source.family, Date.now()), journalHot: copied.journalHot }));
      if (journalHot || !sameDatabaseFile(stamp, await stampOf(source))) return false;
      if (!this.ctx.profiles.loaded().includes(runtime)) return true;
      const added = runtime.history.mergeLive(source.mark, liveEntries(visits));
      runtime.liveHistory.setCursor(source.key, nextCursor(cursor, visits, maxId, stamp));
      statuses.set(source.key, { readAt: Date.now(), added, ms: Math.round(performance.now() - started) });
      this.changed(runtime);
      return true;
    } catch (err) {
      statuses.set(source.key, { readAt: Date.now(), added: 0, ms: Math.round(performance.now() - started), error: err instanceof Error ? err.message : String(err) });
      this.changed(runtime);
      return false;
    }
  }

  /** Watches the profile folder (the database and its journal or WAL come and go) for the source's files. */
  private watch(source: Source, changed: () => void): () => void {
    const names = new Set(source.files.map((f) => path.basename(f)));
    // No file name: the system dropped events of a busy folder; any of them may be ours.
    const listener = (file: string | null): void => {
      if (file === null || names.has(file)) changed();
    };
    const dir = source.dir;
    let entry = this.watchers.get(dir);
    if (!entry) {
      entry = { watcher: null, listeners: new Set(), retry: null };
      this.watchers.set(dir, entry);
      this.startWatcher(dir, entry);
    }
    entry.listeners.add(listener);
    const watch = entry;
    return () => {
      watch.listeners.delete(listener);
      if (watch.listeners.size > 0) return;
      watch.watcher?.close();
      if (watch.retry) clearTimeout(watch.retry);
      if (this.watchers.get(dir) === watch) this.watchers.delete(dir);
    };
  }

  /** A watcher that fails (the folder went away) is set up again a moment later; focus and the poll read meanwhile. */
  private startWatcher(dir: string, entry: Watch): void {
    entry.retry = null;
    try {
      const watcher = fs.watch(dir, { persistent: false }, (_event, file) => {
        for (const l of entry.listeners) l(file ? String(file) : null);
      });
      watcher.on("error", () => {
        watcher.close();
        entry.watcher = null;
        if (this.watchers.get(dir) !== entry) return;
        entry.retry = setTimeout(() => {
          if (this.watchers.get(dir) !== entry) return;
          this.startWatcher(dir, entry);
          for (const l of entry.listeners) l(null);
        }, LIVE_RETRY_MS);
        entry.retry.unref();
      });
      entry.watcher = watcher;
    } catch {
      entry.watcher = null;
    }
  }

  /**
   * The safety poll runs only while some profile follows a browser: every five minutes, every twenty
   * seconds while Corvus is in front and a followed browser wrote its history in the last minutes.
   * It also sets up again watchers that could not be set up.
   */
  private updatePoll(): void {
    const following = [...this.followed.values()].some((m) => m.size > 0);
    if (following && !this.poll) {
      this.poll = setInterval(() => this.tick(), LIVE_ACTIVE_POLL_MS);
      this.poll.unref();
    } else if (!following && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const [dir, entry] of this.watchers) if (!entry.watcher && !entry.retry) this.startWatcher(dir, entry);
    for (const [runtime, sources] of this.followed) {
      const active = this.inFront(runtime) && [...sources.values()].some((f) => now - f.schedule.changedAt < LIVE_ACTIVE_MS);
      if (!active && now - (this.polled.get(runtime) ?? 0) < LIVE_POLL_MS) continue;
      this.polled.set(runtime, now);
      void this.check(runtime);
    }
  }
}
