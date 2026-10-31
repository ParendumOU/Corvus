import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromiumTime, firefoxTime, toChromiumTime, toFirefoxTime } from "../src/shared/browser-import";
import { applyLiveHistory, applySyncedHistory, prune, recordVisit, type HistoryRecord } from "../src/shared/history-ops";
import {
  LIVE_BACKFILL_MS,
  LIVE_BACKGROUND_MS,
  LIVE_RETRY_MS,
  LiveSchedule,
  cleanLiveHistoryConfig,
  filesStamp,
  liveChange,
  liveDefaults,
  liveEnabled,
  liveEntries,
  nextCursor,
  parseSourceKey,
  readWindow,
  sameDatabaseFile,
  sourceKey,
  sourceMark,
  type LiveVisit,
} from "../src/shared/live-history";
import { buildSuggestions } from "../src/shared/suggest";
import { BrowserImport } from "../src/main/browser-import";
import { LiveHistoryService } from "../src/main/live-history";
import { LiveHistoryStore } from "../src/main/live-history-store";
import { openChromeWriter, writeLiveFixtures, type LiveFixtures } from "../src/main/smoke-live-fixtures";
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
    ).toEqual({ enabled: true, sources: ["chrome/Default"], cursors: { "chrome/Default": cursor }, noticeShown: false });
    // Following each browser's default profile: any browser profile's cursor is kept.
    expect(cleanLiveHistoryConfig({ cursors: { "chrome/Default": cursor, bad: cursor }, noticeShown: true })).toEqual({ enabled: null, sources: null, cursors: { "chrome/Default": cursor }, noticeShown: true });
  });

  it("is on by default, following each browser's default profile, and keeps an Off the person chose", () => {
    const fresh = cleanLiveHistoryConfig(null);
    expect(fresh).toEqual({ enabled: null, sources: null, cursors: {}, noticeShown: false });
    expect(liveEnabled(fresh)).toBe(true);
    // Files written by 0.32.6 to 0.32.9 exist only once the person used the switch.
    expect(liveEnabled(cleanLiveHistoryConfig({ enabled: false, sources: [], cursors: {} }))).toBe(false);
    expect(liveEnabled(cleanLiveHistoryConfig({ enabled: false, sources: ["chrome/Default"], cursors: {} }))).toBe(false);
    expect(cleanLiveHistoryConfig({ enabled: true, sources: ["edge/Default"], cursors: {} })).toMatchObject({ enabled: true, sources: ["edge/Default"] });
  });

  it("follows the default profile of each browser, or its first one when none is marked", () => {
    expect(
      liveDefaults([
        { key: "chrome/Profile 1", browser: "chrome", isDefault: false },
        { key: "chrome/Default", browser: "chrome", isDefault: true },
        { key: "edge/Default", browser: "edge", isDefault: true },
        { key: "firefox/a.default", browser: "firefox", isDefault: false },
        { key: "firefox/b.work", browser: "firefox", isDefault: false },
      ]),
    ).toEqual(["chrome/Default", "edge/Default", "firefox/a.default"]);
    expect(liveDefaults([])).toEqual([]);
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

  /** A source whose files' stamps come from `stamps` (the last repeats); `outcomes` say how each read goes. */
  const source = (stamps: Array<string | null>, outcomes: Array<"settled" | "moving" | "fails"> = []) => {
    let last: string | null = null;
    let i = 0;
    const reads: string[] = [];
    const skipped: string[] = [];
    let block: Promise<void> | null = null;
    return {
      reads,
      skipped,
      setStamps(next: Array<string | null>) {
        stamps = next;
        i = 0;
      },
      hold(p: Promise<void> | null) {
        block = p;
      },
      src: {
        stamp: async () => stamps[Math.min(i++, stamps.length - 1)] ?? null,
        lastStamp: () => last,
        read: async (stamp: string) => {
          const outcome = outcomes[reads.length] ?? "settled";
          reads.push(stamp);
          if (block) await block;
          if (outcome === "fails") throw new Error("database disk image is malformed");
          if (outcome === "settled") last = stamp;
          return outcome === "settled";
        },
        skip: (stamp: string) => {
          skipped.push(stamp);
          last = stamp;
        },
      },
    };
  };

  it("reads on focus only when the files changed", async () => {
    const s = source(["a|-|-", "a|-|-", "b|-|-", null]);
    const schedule = new LiveSchedule(s.src);
    await schedule.check();
    await schedule.check();
    expect(s.reads).toEqual(["a|-|-"]);
    await schedule.check();
    expect(s.reads).toEqual(["a|-|-", "b|-|-"]);
    // The database went away: nothing to read.
    await schedule.check();
    expect(s.reads).toEqual(["a|-|-", "b|-|-"]);
  });

  it("makes no copy when only an open transaction's journal changed", async () => {
    const s = source(["db1|-|0:1", "db1|-|41552:2", "db1|-|41552:2", "db2|-|0:3"]);
    const schedule = new LiveSchedule(s.src);
    await schedule.check();
    await schedule.check();
    await schedule.check();
    expect(s.reads).toEqual(["db1|-|0:1"]);
    expect(s.skipped).toEqual(["db1|-|41552:2"]);
    // The commit wrote the database: read.
    await schedule.check();
    expect(s.reads).toEqual(["db1|-|0:1", "db2|-|0:3"]);
  });

  it("while Corvus is in front, reads about a second after the files stop changing, and within five seconds of the first change", async () => {
    const s = source(["a|-|-"]);
    const schedule = new LiveSchedule(s.src, { debounceMs: 1000 });
    schedule.touched();
    await vi.advanceTimersByTimeAsync(800);
    schedule.touched();
    await vi.advanceTimersByTimeAsync(999);
    expect(s.reads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.reads).toEqual(["a|-|-"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.reads).toEqual(["a|-|-"]);

    // Files that never stop changing are still read five seconds after the first change.
    s.setStamps(["b|-|-"]);
    for (let t = 0; t < 5400; t += 600) {
      schedule.touched();
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(s.reads).toEqual(["a|-|-", "b|-|-"]);
  });

  it("while Corvus is in the background, reads changes at most once a minute, and at once on focus", async () => {
    const s = source(["a|-|-"]);
    const schedule = new LiveSchedule(s.src, { foreground: () => false });
    // Chrome saving every ten seconds does not hold the read back.
    schedule.touched();
    for (let t = 10_000; t < LIVE_BACKGROUND_MS; t += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      schedule.touched();
    }
    await vi.advanceTimersByTimeAsync(9_999);
    expect(s.reads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.reads).toEqual(["a|-|-"]);

    s.setStamps(["b|-|-"]);
    schedule.touched();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.reads).toEqual(["a|-|-"]);
    await schedule.check();
    expect(s.reads).toEqual(["a|-|-", "b|-|-"]);
    // The read on focus covered the change: the minute passing reads nothing more.
    await vi.advanceTimersByTimeAsync(LIVE_BACKGROUND_MS);
    expect(s.reads).toEqual(["a|-|-", "b|-|-"]);
  });

  it("loses no change: a change during a read is read once it ends", async () => {
    const s = source(["a|-|-"]);
    let release!: () => void;
    s.hold(new Promise<void>((r) => (release = r)));
    const schedule = new LiveSchedule(s.src, { debounceMs: 1000 });
    const first = schedule.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.reads).toEqual(["a|-|-"]);
    // The browser commits while the copy is being read.
    s.setStamps(["b|-|-"]);
    schedule.touched();
    await vi.advanceTimersByTimeAsync(1000);
    const second = schedule.check();
    s.hold(null);
    release();
    await Promise.all([first, second]);
    expect(s.reads).toEqual(["a|-|-", "b|-|-"]);
  });

  it("tries a failed read again a few seconds later without a new change, then less often", async () => {
    const s = source(["a|-|-"], ["fails", "fails", "settled"]);
    const schedule = new LiveSchedule(s.src);
    await schedule.check();
    expect(s.reads).toEqual(["a|-|-"]);
    // A focus meanwhile does not copy the same files again: the retry does.
    await schedule.check();
    expect(s.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_MS);
    expect(s.reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_MS * 2 - 1);
    expect(s.reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.reads).toHaveLength(3);
    // Read: no more retries.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.reads).toHaveLength(3);
  });

  it("reads again shortly a copy taken while a commit was being written", async () => {
    const s = source(["a|-|-"], ["moving", "settled"]);
    const schedule = new LiveSchedule(s.src);
    await schedule.check();
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_MS);
    expect(s.reads).toEqual(["a|-|-", "a|-|-"]);
    expect(s.src.lastStamp()).toBe("a|-|-");
  });

  it("reads a new change at once even while a retry waits", async () => {
    const s = source(["a|-|-"], ["fails", "settled"]);
    const schedule = new LiveSchedule(s.src);
    await schedule.check();
    s.setStamps(["b|-|-"]);
    await schedule.check();
    expect(s.reads).toEqual(["a|-|-", "b|-|-"]);
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_MS * 4);
    expect(s.reads).toEqual(["a|-|-", "b|-|-"]);
  });

  it("does nothing once closed", async () => {
    const s = source(["a|-|-"], ["fails"]);
    const schedule = new LiveSchedule(s.src);
    await schedule.check();
    schedule.touched();
    schedule.close();
    await vi.advanceTimersByTimeAsync(60_000);
    await schedule.check();
    expect(s.reads).toEqual(["a|-|-"]);
  });

  it("stamps a source's files by size and modification time, and tells a journal-only change", () => {
    expect(filesStamp([null, { size: 3, mtimeMs: 1 }])).toBeNull();
    expect(filesStamp([{ size: 4096, mtimeMs: 1000.25 }, null, { size: 9, mtimeMs: 2000 }])).toBe("4096:1000.25|-|9:2000");
    expect(liveChange(null, "a|-|-")).toBe("none");
    expect(liveChange("a|-|-", "a|-|-")).toBe("none");
    expect(liveChange("a|-|-", null)).toBe("read");
    expect(liveChange("a|-|9:2", "a|-|0:1")).toBe("journal");
    expect(liveChange("a|-|-", "a|-|0:1")).toBe("journal");
    expect(liveChange("b|-|0:1", "a|-|0:1")).toBe("read");
    // Firefox's commits are in its write-ahead log.
    expect(liveChange("a|512:3|-", "a|256:2|-")).toBe("read");
    expect(sameDatabaseFile("a|1:1|-", "a|2:2|9:9")).toBe(true);
    expect(sameDatabaseFile("a|-|-", "b|-|-")).toBe(false);
    expect(sameDatabaseFile("a|-|-", null)).toBe(false);
  });
});

describe("live history from fake Chrome and Firefox profiles", () => {
  let root = "";
  let fixtures: LiveFixtures;
  let history: HistoryStore;
  let store: LiveHistoryStore;
  let service: LiveHistoryService;
  let runtime: ProfileRuntime;
  let focus: ((win: { profile: ProfileRuntime; isPrivate?: boolean }) => void) | null = null;
  const hasUrl = (url: string): boolean => history.all().some((e) => e.url === url);
  const statusOf = async (key: string) => (await service.view(runtime)).sources.find((s) => s.key === key)?.status;
  /** attach() reads a moment after a profile loads: waits for that first look. */
  const attached = async (): Promise<void> => {
    service.attach(runtime, 0);
    await new Promise((r) => setTimeout(r, 20));
    await service.check(runtime);
  };

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
      windows: { onFocus: (l: typeof focus) => ((focus = l), () => undefined), inFront: () => null },
      browserIcons: { icons: async () => ({}) },
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

  it("is on by default: follows each browser's default profile and brings its recent pages without a click", async () => {
    fixtures.chromeVisit("https://example.com/chrome-page", "Seen in Chrome", Date.now() - 60_000);
    fixtures.firefoxVisit("https://example.org/firefox-page", "Seen in Firefox", Date.now() - 60_000);
    await attached();
    expect(history.all().map((e) => [e.url, e.source]).sort()).toEqual([
      ["https://example.com/chrome-page", "chrome"],
      ["https://example.org/firefox-page", "firefox"],
    ]);
    const view = await service.view(runtime);
    expect(view).toMatchObject({ enabled: true, byDefault: true });
    expect(view.sources.map((s) => [s.key, s.followed])).toEqual([
      ["chrome/Default", true],
      ["firefox/live1234.default-release", true],
    ]);
    // Still the person's choice until they make one: nothing was written but the cursors.
    expect(store.get()).toMatchObject({ enabled: null, sources: null });
  });

  it("does nothing while the person has turned it off, and a private window's focus reads nothing", async () => {
    store.set({ enabled: false });
    fixtures.chromeVisit("https://example.com/off", "Off", Date.now());
    await attached();
    focus?.({ profile: runtime });
    await service.check(runtime);
    expect(service.copies).toBe(0);
    expect(history.all()).toEqual([]);
    expect((await service.view(runtime)).byDefault).toBe(false);

    await service.set(runtime, { enabled: true });
    fixtures.chromeVisit("https://example.com/private", "Seen while a private window had focus", Date.now());
    const copies = service.copies;
    focus?.({ profile: runtime, isPrivate: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(service.copies).toBe(copies);
    expect(hasUrl("https://example.com/private")).toBe(false);
  });

  it("reads a visit once a running Chrome commits it, and never a half-written commit", async () => {
    await service.set(runtime, { enabled: true, sources: ["chrome/Default"] });
    const chrome = openChromeWriter(fixtures.chromeHistory);
    try {
      // Not saved yet: the open transaction only fills the journal, which is not even copied.
      chrome.visit("https://example.com/running/one", "Opened while Chrome runs", Date.now());
      let copies = service.copies;
      await service.fresh(runtime);
      expect(hasUrl("https://example.com/running/one")).toBe(false);
      expect(service.copies).toBe(copies);

      // Chrome's commit, ten seconds later: the address bar's look reads it, Chrome still running.
      chrome.commit();
      await service.fresh(runtime);
      expect(hasUrl("https://example.com/running/one")).toBe(true);

      // A big transaction written into History before its commit: that copy is played back by its journal, so not used.
      chrome.visit("https://example.com/running/two", "A big commit", Date.now());
      chrome.spill();
      expect(fs.readFileSync(`${fixtures.chromeHistory}-journal`).subarray(0, 4).toString("hex")).toBe("d9d505f9");
      copies = service.copies;
      const stamp = store.cursor("chrome/Default")?.stamp;
      await service.check(runtime);
      expect(service.copies).toBe(copies + 1);
      expect(hasUrl("https://example.com/running/two")).toBe(false);
      expect(store.cursor("chrome/Default")?.stamp).toBe(stamp);
      expect((await statusOf("chrome/Default"))?.error).toBeUndefined();
      chrome.commit();
      await service.check(runtime);
      expect(hasUrl("https://example.com/running/two")).toBe(true);
      expect((await statusOf("chrome/Default"))?.error).toBeUndefined();
    } finally {
      chrome.close();
    }
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
