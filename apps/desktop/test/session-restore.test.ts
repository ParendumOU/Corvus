import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLOSE_BURST_MS, SessionRestore, rotateSessionBackups } from "../src/main/session-restore";
import { hasRealPages, type SessionSnapshot, type SessionWindow } from "../src/shared/session-state";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-session-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sessionWindow = (...urls: string[]): SessionWindow => ({
  profileId: "default",
  maximized: false,
  tabs: urls.map((url) => ({ url, title: url, pinned: false })),
  groups: [],
  activeIndex: 0,
});
const snapshot = (...windows: SessionWindow[]): SessionSnapshot => ({ version: 1, savedAt: 1, windows });

/** A window as SessionRestore sees it: its saved form, and whether it is gone. */
const fakeWindow = (saved: SessionWindow) => {
  const win = { disposed: false, isDisposed: () => win.disposed, sessionWindow: () => saved };
  return win;
};

/** A SessionRestore over fake windows, with a clock the test moves. */
const setup = (dir: string, windows: Array<ReturnType<typeof fakeWindow>>) => {
  const clock = { now: 1_000_000 };
  const ctx = { windows: { regular: () => windows }, profiles: { list: () => [{ id: "default" }] } };
  const restore = new SessionRestore(ctx as never, dir, () => clock.now);
  return { restore, clock };
};
const onDisk = (dir: string, name = "session.json"): SessionSnapshot => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const urlsOf = (s: SessionSnapshot): string[][] => s.windows.map((w) => w.tabs.map((t) => t.url));

describe("rotateSessionBackups", () => {
  it("keeps the session found at each start as .1, .2 and .3, newest first", () => {
    const dir = tempDir();
    const file = path.join(dir, "session.json");
    for (const n of ["a", "b", "c", "d"]) {
      fs.writeFileSync(file, n);
      rotateSessionBackups(file);
    }
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("d");
    expect(fs.readFileSync(`${file}.2`, "utf8")).toBe("c");
    expect(fs.readFileSync(`${file}.3`, "utf8")).toBe("b");
    expect(fs.existsSync(`${file}.4`)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("d");
  });

  it("leaves the backups alone when there is no session or it is empty", () => {
    const dir = tempDir();
    const file = path.join(dir, "session.json");
    rotateSessionBackups(file);
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.writeFileSync(`${file}.1`, "old");
    fs.writeFileSync(file, "");
    rotateSessionBackups(file);
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("old");
  });
});

describe("SessionRestore", () => {
  it("backs up the session it finds before it saves anything", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(snapshot(sessionWindow("https://example.com/"))));
    const { restore } = setup(dir, [fakeWindow(sessionWindow("corvus://newtab/"))]);
    restore.save();
    expect(urlsOf(onDisk(dir, "session.json.1"))).toEqual([["https://example.com/"]]);
    expect(urlsOf(onDisk(dir))).toEqual([["corvus://newtab/"]]);
  });

  it("keeps every window when they all close one after another (Corvus closed from outside)", () => {
    const dir = tempDir();
    const a = fakeWindow(sessionWindow("https://example.com/a", "https://example.com/b"));
    const b = fakeWindow(sessionWindow("corvus://newtab/"));
    const { restore, clock } = setup(dir, [a, b]);
    restore.windowClosing(a as never);
    a.disposed = true;
    restore.save();
    expect(urlsOf(onDisk(dir))).toEqual([["https://example.com/a", "https://example.com/b"], ["corvus://newtab/"]]);
    clock.now += 300;
    restore.windowClosing(b as never);
    expect(urlsOf(onDisk(dir))).toEqual([["https://example.com/a", "https://example.com/b"], ["corvus://newtab/"]]);
  });

  it("forgets a window the person closed once the burst is over", () => {
    const dir = tempDir();
    const a = fakeWindow(sessionWindow("https://example.com/a"));
    const b = fakeWindow(sessionWindow("https://example.org/"));
    const { restore, clock } = setup(dir, [a, b]);
    restore.windowClosing(a as never);
    a.disposed = true;
    clock.now += CLOSE_BURST_MS;
    restore.save();
    expect(urlsOf(onDisk(dir))).toEqual([["https://example.org/"]]);
    restore.windowClosing(b as never);
    expect(urlsOf(onDisk(dir))).toEqual([["https://example.org/"]]);
  });

  it("never lists a closing window twice while it is still open", () => {
    const dir = tempDir();
    const a = fakeWindow(sessionWindow("https://example.com/a"));
    const b = fakeWindow(sessionWindow("https://example.org/"));
    const { restore } = setup(dir, [a, b]);
    restore.windowClosing(a as never);
    expect(urlsOf(restore.capture())).toEqual([["https://example.com/a"], ["https://example.org/"]]);
  });

  it("keeps the last session with real pages, which a session of new tabs never replaces", () => {
    const dir = tempDir();
    const win = { saved: sessionWindow("https://example.com/") };
    const fake = { isDisposed: () => false, sessionWindow: () => win.saved };
    const { restore, clock } = setup(dir, [fake as never]);
    restore.save();
    expect(urlsOf(onDisk(dir, "session.last-good.json"))).toEqual([["https://example.com/"]]);
    win.saved = sessionWindow("corvus://newtab/");
    clock.now += 60_000;
    restore.quitting();
    expect(urlsOf(onDisk(dir))).toEqual([["corvus://newtab/"]]);
    expect(urlsOf(onDisk(dir, "session.last-good.json"))).toEqual([["https://example.com/"]]);
  });
});

describe("hasRealPages", () => {
  it("is true only for a session with a page beyond new tabs", () => {
    expect(hasRealPages(null)).toBe(false);
    expect(hasRealPages(snapshot())).toBe(false);
    expect(hasRealPages(snapshot(sessionWindow("corvus://newtab/"), sessionWindow("corvus://newtab/")))).toBe(false);
    expect(hasRealPages(snapshot(sessionWindow("corvus://newtab/", "https://example.com/")))).toBe(true);
  });
});
