import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromiumTime, firefoxTime, toChromiumTime, toFirefoxTime } from "../src/shared/browser-import";
import { applyLiveHistory, applySyncedHistory, prune, recordVisit, type HistoryRecord } from "../src/shared/history-ops";
import {
  LIVE_BACKFILL_MS,
  LiveSchedule,
  cleanLiveHistoryConfig,
  filesStamp,
  liveEntries,
  nextCursor,
  parseSourceKey,
  readWindow,
  sourceKey,
  sourceMark,
  type LiveVisit,
} from "../src/shared/live-history";
import { buildSuggestions } from "../src/shared/suggest";
import { BrowserImport } from "../src/main/browser-import";
import { LiveHistoryService } from "../src/main/live-history";
import { LiveHistoryStore } from "../src/main/live-history-store";
import { writeLiveFixtures, type LiveFixtures } from "../src/main/smoke-live-fixtures";
import { HistoryStore } from "../src/main/stores";
import { historyAdapter } from "../src/main/sync-adapters";
import type { AppContext } from "../src/main/context";
import type { ProfileRuntime } from "../src/main/profiles";

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const visit = (id: number, url: string, title: string, visitedAt: number, visitCount = 1): LiveVisit => ({ id, url, title, visitedAt, visitCount });
const entry = (url: string, extra: Partial<HistoryRecord> = {}): HistoryRecord => ({ id: url, url, title: url, visitedAt: NOW - 60_000, visitCount: 1, ...extra });
let n = 0;
const newId = (): string => `id-${++n}`;

describe("browser times", () => {
  it("converts Chromium's microseconds since 1601 both ways", () => {
    expect(toChromiumTime(0)).toBe(11_644_473_600_000_000n);
    expect(chromiumTime(11_644_473_600_000_000n)).toBe(0);
    expect(chromiumTime(toChromiumTime(NOW))).toBe(NOW);
    // 2026-10-30 12:00 UTC as Chrome stores it (past Number.MAX_SAFE_INTEGER, hence BigInt).
    expect(toChromiumTime(NOW)).toBe(13_437_835_200_000_000n);
  });

  it("converts Firefox's microseconds since 1970 both ways", () => {
    expect(toFirefoxTime(NOW)).toBe(BigInt(NOW) * 1000n);
    expect(firefoxTime(toFirefoxTime(NOW))).toBe(NOW);
    expect(firefoxTime(1_500_000)).toBe(1500);
  });
});

describe("live history cursor", () => {
  it("starts at the backfill when a browser is first followed", () => {
    expect(readWindow(undefined, 900, NOW)).toEqual({ afterId: 0, since: NOW - LIVE_BACKFILL_MS });
  });

  it("goes on after the last visit read", () => {
    expect(readWindow({ visitId: 40, visitTime: NOW - 5000, stamp: "s" }, 52, NOW)).toEqual({ afterId: 40, since: NOW - LIVE_BACKFILL_MS });
  });

  it("starts over, after the newest visit read, when the browser's history was cleared", () => {
    expect(readWindow({ visitId: 400, visitTime: NOW - 5000, stamp: "s" }, 3, NOW)).toEqual({ afterId: 0, since: NOW - 4999 });
    // After a long gap the backfill still bounds it.
    expect(readWindow({ visitId: 400, visitTime: NOW - 30 * LIVE_BACKFILL_MS, stamp: "s" }, 3, NOW).since).toBe(NOW - LIVE_BACKFILL_MS);
  });

  it("moves to the highest visit id the read covered and keeps the newest time", () => {
    const visits = [visit(7, "https://example.com/a", "A", NOW - 3000), visit(9, "https://example.com/b", "B", NOW - 1000)];
    expect(nextCursor(undefined, visits, 12, "stamp-2")).toEqual({ visitId: 12, visitTime: NOW - 1000, stamp: "stamp-2" });
    expect(nextCursor({ visitId: 12, visitTime: NOW, stamp: "x" }, [], 12, "stamp-3")).toEqual({ visitId: 12, visitTime: NOW, stamp: "stamp-3" });
  });

  it("keeps only the cursors of followed browser profiles", () => {
    const cursor = { visitId: 3, visitTime: 9, stamp: "s" };
    expect(
      cleanLiveHistoryConfig({ enabled: true, sources: ["chrome/Default", "chrome/Default", "bad", 4], cursors: { "chrome/Default": cursor, "edge/Default": cursor, "chrome/Profile 1": { visitId: "x" } } }),
    ).toEqual({ enabled: true, sources: ["chrome/Default"], cursors: { "chrome/Default": cursor } });
    expect(cleanLiveHistoryConfig(null)).toEqual({ enabled: false, sources: [], cursors: {} });
  });

  it("names sources by browser and profile folder, and marks pages by browser", () => {
    expect(parseSourceKey(sourceKey("firefox", "abcd.default-release"))).toEqual({ browser: "firefox", profileDir: "abcd.default-release" });
    expect(parseSourceKey(sourceKey("firefox", "/home/someone/ff/x"))).toEqual({ browser: "firefox", profileDir: "/home/someone/ff/x" });
    expect(parseSourceKey("no-folder")).toBeNull();
    expect(sourceMark("firefox-snap")).toBe("firefox");
    expect(sourceMark("chromium-snap")).toBe("chromium");
    expect(sourceMark("opera-gx")).toBe("opera-gx");
  });
});

describe("live history entries and dedupe", () => {
  it("makes one entry per web page at its latest visit, with the browser's count", () => {
    const entries = liveEntries([
      visit(1, "https://example.com/news", "News (old title)", NOW - 9000, 4),
      visit(2, "https://example.com/news", "News", NOW - 1000, 4),
      visit(3, "https://example.com/news", "", NOW - 2000, 4),
      visit(4, "chrome://settings/", "Settings", NOW),
      visit(5, "file:///home/someone/a.pdf", "a.pdf", NOW),
      visit(6, "https://example.org/x", "X", NOW - 500, 0),
      visit(7, "https://example.org/y", "Y", 0),
    ]);
    expect(entries).toEqual([
      { url: "https://example.com/news", title: "News", visitedAt: NOW - 1000, visitCount: 4 },
      { url: "https://example.org/x", title: "X", visitedAt: NOW - 500, visitCount: 1 },
    ]);
  });

  it("adds new pages marked with their browser and leaves Corvus's own pages as they are", () => {
    const own = entry("https://example.com/own", { visitedAt: NOW - 86_400_000, visitCount: 3 });
    const { list, added } = applyLiveHistory(
      [own],
      "chrome",
      [
        { url: "https://example.com/own", title: "Changed", visitedAt: NOW, visitCount: 50 },
        { url: "https://example.org/new", title: "New page", visitedAt: NOW, visitCount: 2 },
      ],
      newId,
    );
    expect(added).toBe(1);
    expect(list.find((e) => e.url === own.url)).toEqual(own);
    expect(list.find((e) => e.url === "https://example.org/new")).toMatchObject({ title: "New page", visitedAt: NOW, visitCount: 2, source: "chrome" });
  });

  it("changes nothing when the same visits are read again, and takes later ones", () => {
    const first = applyLiveHistory([], "firefox", [{ url: "https://example.org/a", title: "A", visitedAt: NOW - 5000, visitCount: 2 }], newId).list;
    const again = applyLiveHistory(first, "firefox", [{ url: "https://example.org/a", title: "A", visitedAt: NOW - 5000, visitCount: 2 }], newId);
    expect(again.list).toBe(first);
    expect(again.added).toBe(0);
    const later = applyLiveHistory(first, "edge", [{ url: "https://example.org/a", title: "A, edited", visitedAt: NOW, visitCount: 1 }], newId).list;
    expect(later[0]).toMatchObject({ title: "A, edited", visitedAt: NOW, visitCount: 2, source: "firefox" });
    // An older visit does not take the title.
    const older = applyLiveHistory(later, "firefox", [{ url: "https://example.org/a", title: "Old", visitedAt: NOW - 9000, visitCount: 5 }], newId).list;
    expect(older[0]).toMatchObject({ title: "A, edited", visitedAt: NOW, visitCount: 5 });
  });

  it("drops other browsers' pages first when the history is full", () => {
    const list = [entry("https://example.com/1", { visitedAt: NOW - 9000 }), entry("https://example.org/live", { visitedAt: NOW, source: "chrome" }), entry("https://example.com/2", { visitedAt: NOW - 8000 })];
    expect(prune(list, 2).map((e) => e.url)).toEqual(["https://example.com/2", "https://example.com/1"]);
    const { list: capped } = applyLiveHistory(list.filter((e) => !e.source), "chrome", [{ url: "https://example.org/b", title: "B", visitedAt: NOW, visitCount: 1 }], newId, 2);
    expect(capped.some((e) => e.source)).toBe(false);
  });

  it("makes a page Corvus visits its own, without the other browser's visits", () => {
    const live = entry("https://example.org/a", { visitCount: 37, source: "chrome" });
    const [visited] = recordVisit([live], { url: live.url, title: "A" }, "x", NOW);
    expect(visited).toEqual({ id: live.id, url: live.url, title: "A", visitedAt: NOW, visitCount: 1 });
  });

  it("takes a synced page as it is over one known only from another browser", () => {
    const live = entry("https://example.org/a", { visitedAt: NOW, visitCount: 37, source: "chrome" });
    const [synced] = applySyncedHistory([live], [{ url: live.url, entry: { url: live.url, title: "Synced", visitedAt: NOW - 50_000, visitCount: 2 } }], newId);
    expect(synced).toEqual({ id: live.id, url: live.url, title: "Synced", visitedAt: NOW - 50_000, visitCount: 2 });
  });

  it("suggests other browsers' pages by address and title words, with their browser", () => {
    const history = [entry("https://example.org/recipes/bread", { title: "Sourdough bread recipe", source: "firefox" })];
    expect(buildSuggestions("example.org/rec", history, [], NOW)[1]).toMatchObject({ kind: "history", url: "https://example.org/recipes/bread", source: "firefox" });
    expect(buildSuggestions("sourdough", history, [], NOW)[1]).toMatchObject({ url: "https://example.org/recipes/bread", source: "firefox" });
  });
});

describe("live history schedule", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const source = (stamps: Array<string | null>) => {
    let last: string | null = null;
    let i = 0;
    const reads: string[] = [];
    let block: Promise<void> | null = null;
    return {
      reads,
      hold(p: Promise<void>) {
        block = p;
      },
      src: {
        stamp: async () => stamps[Math.min(i++, stamps.length - 1)] ?? null,
        lastStamp: () => last,
        read: async (stamp: string) => {
          reads.push(stamp);
          if (block) await block;
          last = stamp;
        },
      },
    };
  };

  it("reads on focus only when the files changed", async () => {
    const s = source(["a", "a", "b", null]);
    const schedule = new LiveSchedule(s.src);
    await schedule.check();
    await schedule.check();
    expect(s.reads).toEqual(["a"]);
    await schedule.check();
    expect(s.reads).toEqual(["a", "b"]);
    // The database went away: nothing to read.
    await schedule.check();
    expect(s.reads).toEqual(["a", "b"]);
  });

  it("reads once, two seconds after the files stop changing", async () => {
    const s = source(["a"]);
    const schedule = new LiveSchedule(s.src, 2000);
    schedule.touched();
    await vi.advanceTimersByTimeAsync(1500);
    schedule.touched();
    await vi.advanceTimersByTimeAsync(1500);
    schedule.touched();
    await vi.advanceTimersByTimeAsync(1999);
    expect(s.reads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.reads).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.reads).toEqual(["a"]);
  });

  it("never reads twice at once: a request during a read checks again once it ends", async () => {
    const s = source(["a", "b"]);
    let release!: () => void;
    s.hold(new Promise<void>((r) => (release = r)));
    const schedule = new LiveSchedule(s.src);
    const first = schedule.check();
    await vi.advanceTimersByTimeAsync(0);
    const second = schedule.check();
    expect(s.reads).toEqual(["a"]);
    release();
    await Promise.all([first, second]);
    expect(s.reads).toEqual(["a", "b"]);
  });

  it("does nothing once closed", async () => {
    const s = source(["a"]);
    const schedule = new LiveSchedule(s.src, 2000);
    schedule.touched();
    schedule.close();
    await vi.advanceTimersByTimeAsync(5000);
    await schedule.check();
    expect(s.reads).toEqual([]);
  });

  it("stamps a source's files by size and modification time", () => {
    expect(filesStamp([null, { size: 3, mtimeMs: 1 }])).toBeNull();
    expect(filesStamp([{ size: 4096, mtimeMs: 1000.25 }, null, { size: 9, mtimeMs: 2000 }])).toBe("4096:1000.25|-|9:2000");
  });
});

describe("live history from fake Chrome and Firefox profiles", () => {
  let root = "";
  let fixtures: LiveFixtures;
  let history: HistoryStore;
  let store: LiveHistoryStore;
  let service: LiveHistoryService;
  let runtime: ProfileRuntime;
  let focus: ((win: { profile: ProfileRuntime }) => void) | null = null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-live-test-"));
    fixtures = writeLiveFixtures(path.join(root, "browsers"));
    const browserImport = new BrowserImport();
    browserImport.setTestRoots(fixtures.roots);
    history = new HistoryStore(path.join(root, "profile"));
    store = new LiveHistoryStore(path.join(root, "profile"));
    runtime = { history, liveHistory: store } as unknown as ProfileRuntime;
    const ctx = {
      browserImport,
      profiles: { loaded: () => [runtime] },
      windows: { onFocus: (l: typeof focus) => ((focus = l), () => undefined) },
    } as unknown as AppContext;
    service = new LiveHistoryService(ctx);
    service.start();
  });

  afterEach(() => {
    service.stop();
    history.flush();
    store.flush();
    fixtures.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does nothing while the setting is off", async () => {
    fixtures.chromeVisit("https://example.com/off", "Off", Date.now());
    focus?.({ profile: runtime });
    await service.check(runtime);
    expect(service.copies).toBe(0);
    expect(history.all()).toEqual([]);
  });

  it("brings each browser's new visits, local only, and forgets them on request", async () => {
    const now = Date.now();
    fixtures.chromeVisit("https://example.com/before", "Visited last week", now - 6 * 86_400_000);
    fixtures.chromeVisit("https://example.com/too-old", "Visited last month", now - 30 * 86_400_000);
    fixtures.firefoxVisit("https://example.org/fox", "Fox page", now - 60_000);
    const view = await service.set(runtime, { enabled: true, sources: ["chrome/Default", "firefox/live1234.default-release"] });
    expect(view.sources.map((s) => [s.key, s.followed])).toEqual([
      ["chrome/Default", true],
      ["firefox/live1234.default-release", true],
    ]);
    expect(history.all().map((e) => [e.url, e.source]).sort()).toEqual([
      ["https://example.com/before", "chrome"],
      ["https://example.org/fox", "firefox"],
    ]);
    expect(view.counts).toEqual({ chrome: 1, firefox: 1 });

    // Unchanged files: no copy at all.
    const copies = service.copies;
    await service.check(runtime);
    expect(service.copies).toBe(copies);

    fixtures.chromeVisit("https://example.com/news/live-history", "Live history arrives", now);
    fixtures.chromeVisit("https://example.com/frame", "A subframe", now, 3);
    fixtures.firefoxVisit("https://example.org/fox", "Fox page, again", now);
    fixtures.firefoxVisit("https://example.org/embed", "Embedded", now, 4);
    focus?.({ profile: runtime });
    await service.check(runtime);
    expect(history.all().map((e) => e.url).sort()).toEqual(["https://example.com/before", "https://example.com/news/live-history", "https://example.org/fox"]);
    expect(history.all().find((e) => e.url === "https://example.org/fox")).toMatchObject({ title: "Fox page, again", visitCount: 2, source: "firefox" });
    expect(store.cursor("chrome/Default")?.visitId).toBe(4);

    // Sync never sees them; a page Corvus visits itself is its own and syncs.
    history.recordVisit("https://example.com/own", "Own page");
    expect((await historyAdapter(history).list()).map((i) => i.id)).toEqual(["https://example.com/own"]);

    const after = await service.forget(runtime, "chrome");
    expect(after.counts).toEqual({ firefox: 1 });
    expect(history.all().map((e) => e.url).sort()).toEqual(["https://example.com/own", "https://example.org/fox"]);
    // Forgotten visits do not come back with the next read.
    fixtures.firefoxVisit("https://example.org/fox-2", "Another fox page", now);
    await service.check(runtime);
    expect(history.all().some((e) => e.source === "chrome")).toBe(false);
  });

  it("stops following a browser profile that is unticked or a setting turned off", async () => {
    await service.set(runtime, { enabled: true, sources: ["chrome/Default"] });
    await service.set(runtime, { enabled: false });
    fixtures.chromeVisit("https://example.com/later", "Later", Date.now());
    const copies = service.copies;
    await service.check(runtime);
    expect(service.copies).toBe(copies);
    expect(history.all()).toEqual([]);
    await service.set(runtime, { enabled: true, sources: [] });
    expect(store.cursor("chrome/Default")).toBeUndefined();
  });
});
