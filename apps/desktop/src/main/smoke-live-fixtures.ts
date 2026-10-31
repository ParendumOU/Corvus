// Fake Chrome and Firefox profiles whose history keeps growing, for the live history tests and smoke:
// a Chromium History (urls and visits, as Chrome writes them) and a Firefox places.sqlite in WAL mode
// (moz_places and moz_historyvisits), with made-up pages on example.com and example.org.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";
import { toChromiumTime, toFirefoxTime, type DataRoots } from "../shared/browser-import";

export interface LiveFixtures {
  roots: DataRoots;
  chromeHistory: string;
  firefoxPlaces: string;
  /** The fake Chrome's own icon (its menu entry names it); the fake Firefox has none, so it keeps its letter mark. */
  chromeIcon: string;
  /** A visit in Chrome (transition 1 = typed, 3 = a subframe, which Chrome's history leaves out). */
  chromeVisit(url: string, title: string, at: number, transition?: number): void;
  /** A visit in Firefox (visit type 1 = link, 4 = embedded, which its history leaves out). */
  firefoxVisit(url: string, title: string, at: number, visitType?: number): void;
  /** Closes Firefox's open database (its WAL stays on disk while it is open, as with a running Firefox). */
  close(): void;
}

/** Writes the fake browsers under `root` (a Linux layout) with an empty history each. */
export function writeLiveFixtures(root: string): LiveFixtures {
  const config = path.join(root, ".config");
  const chromeDir = path.join(config, "google-chrome", "Default");
  fs.mkdirSync(chromeDir, { recursive: true });
  fs.writeFileSync(path.join(config, "google-chrome", "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" } }, last_used: "Default" } }));
  const chromeHistory = path.join(chromeDir, "History");
  const chrome = new DatabaseSync(chromeHistory);
  chrome.exec(
    "CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL);" +
      "CREATE INDEX urls_url_index ON urls (url);" +
      "CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL, segment_id INTEGER, visit_duration INTEGER DEFAULT 0 NOT NULL);" +
      "CREATE INDEX visits_time_index ON visits (visit_time);",
  );
  chrome.close();

  const firefoxRoot = path.join(root, ".mozilla", "firefox");
  const firefoxDir = path.join(firefoxRoot, "live1234.default-release");
  fs.mkdirSync(firefoxDir, { recursive: true });
  fs.writeFileSync(path.join(firefoxRoot, "profiles.ini"), ["[Profile0]", "Name=default-release", "IsRelative=1", "Path=live1234.default-release", "Default=1", "", "[General]", "StartWithLastProfile=1", "Version=2", ""].join("\n"));
  const firefoxPlaces = path.join(firefoxDir, "places.sqlite");
  const firefox = new DatabaseSync(firefoxPlaces);
  firefox.exec(
    "PRAGMA journal_mode = WAL;" +
      "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, rev_host LONGVARCHAR, visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL, typed INTEGER DEFAULT 0 NOT NULL, frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER, guid TEXT);" +
      "CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER, visit_date INTEGER, visit_type INTEGER, session INTEGER, source INTEGER DEFAULT 0 NOT NULL, triggeringPlaceId INTEGER);" +
      "CREATE INDEX moz_historyvisits_dateindex ON moz_historyvisits (visit_date);",
  );

  const chromeVisit = (url: string, title: string, at: number, transition = 1): void => {
    const db = new DatabaseSync(chromeHistory);
    try {
      const time = toChromiumTime(at);
      const found = db.prepare("SELECT id FROM urls WHERE url = ?").get(url) as { id: number } | undefined;
      const id = found
        ? (db.prepare("UPDATE urls SET title = ?, visit_count = visit_count + 1, last_visit_time = ? WHERE id = ?").run(title, time, found.id), found.id)
        : Number(db.prepare("INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, 1, ?, ?)").run(url, title, time, transition === 3 ? 1 : 0).lastInsertRowid);
      db.prepare("INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)").run(id, time, transition);
    } finally {
      db.close();
    }
  };
  const firefoxVisit = (url: string, title: string, at: number, visitType = 1): void => {
    const time = toFirefoxTime(at);
    const found = firefox.prepare("SELECT id FROM moz_places WHERE url = ?").get(url) as { id: number } | undefined;
    const id = found
      ? (firefox.prepare("UPDATE moz_places SET title = ?, visit_count = visit_count + 1, last_visit_date = ? WHERE id = ?").run(title, time, found.id), found.id)
      : Number(firefox.prepare("INSERT INTO moz_places (url, title, visit_count, hidden, last_visit_date) VALUES (?, ?, 1, 0, ?)").run(url, title, time).lastInsertRowid);
    firefox.prepare("INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?, ?, ?)").run(id, time, visitType);
  };
  return {
    roots: { platform: "linux", home: root, localAppData: "", appData: "", config },
    chromeHistory,
    firefoxPlaces,
    chromeIcon: writeChromeEntry(root),
    chromeVisit,
    firefoxVisit,
    close: () => firefox.close(),
  };
}

/** A Chrome that keeps running: its History held open, its visits saved by commit(). */
export interface ChromeWriter {
  /** A visit in the open transaction: on disk only once committed. */
  visit(url: string, title: string, at: number): void;
  /** Saves the open transaction and opens the next one (Chrome does it about ten seconds after a change). */
  commit(): void;
  /**
   * Makes the open transaction too big for SQLite's memory, so part of it is written into History
   * before it is committed, as during a big commit: its journal is then one SQLite plays back.
   */
  spill(): void;
  /** Saves and closes, as when Chrome quits. */
  close(): void;
}

/**
 * Opens `history` as Chrome does while it runs: exclusive locking (other processes can only copy
 * the file), a rollback journal truncated after each commit, and a transaction always open.
 */
export function openChromeWriter(history: string): ChromeWriter {
  const db = new DatabaseSync(history);
  db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = TRUNCATE; PRAGMA synchronous = FULL; BEGIN");
  return {
    visit: (url, title, at) => {
      const time = toChromiumTime(at);
      const id = db.prepare("INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, 1, ?, 0)").run(url, title, time).lastInsertRowid;
      db.prepare("INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, 1)").run(id, time);
    },
    commit: () => db.exec("COMMIT; BEGIN"),
    spill: () => {
      db.exec("PRAGMA cache_size = 10");
      const add = db.prepare("INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, 0, 0, 1)");
      for (let i = 0; i < 2000; i++) add.run(`https://spill.example.org/${i}`, "Filler of a big transaction ".repeat(20));
    },
    close: () => {
      db.exec("COMMIT");
      db.close();
    },
  };
}

/**
 * Fills a Chromium History with `pages` pages and two visits each, long titles included, to about
 * the size of a heavy user's (about 50 MB for 92,000 pages), dated before `before`.
 */
export function fillChromeHistory(file: string, pages: number, before: number): void {
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN");
    const addUrl = db.prepare("INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, 2, ?, 0)");
    const addVisit = db.prepare("INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, 0)");
    const filler = "Archived article about made-up topics for the size test ".repeat(5);
    for (let i = 0; i < pages; i++) {
      const at = toChromiumTime(before - (pages - i) * 60_000);
      const id = addUrl.run(`https://archive.example.org/article/${i}?ref=size-test-${i % 97}`, `${filler}${i}`, at).lastInsertRowid;
      addVisit.run(id, at);
      addVisit.run(id, at);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A made-up round browser icon (a coloured ring around a blue dot) as a 32 px PNG. */
function fakeBrowserIcon(): Buffer {
  const size = 32;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const dx = x - 15.5;
      const dy = y - 15.5;
      const r = Math.hypot(dx, dy);
      const angle = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
      const ring = angle < 1 / 3 ? [219, 68, 55] : angle < 2 / 3 ? [244, 180, 0] : [15, 157, 88];
      const rgba = r > 15.5 ? [0, 0, 0, 0] : r > 7 ? [...ring, 255] : r > 5.5 ? [255, 255, 255, 255] : [66, 133, 244, 255];
      Buffer.from(rgba).copy(row, 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), pngChunk("IEND", Buffer.alloc(0))]);
}

/** The fake Chrome's menu entry, as a Linux package installs it, naming its icon file. */
function writeChromeEntry(root: string): string {
  const icon = path.join(root, "icons", "fake-chrome.png");
  fs.mkdirSync(path.dirname(icon), { recursive: true });
  fs.writeFileSync(icon, fakeBrowserIcon());
  const entries = path.join(root, ".local", "share", "applications");
  fs.mkdirSync(entries, { recursive: true });
  fs.writeFileSync(path.join(entries, "google-chrome.desktop"), ["[Desktop Entry]", "Name=Google Chrome", "Exec=/opt/google/chrome/google-chrome %U", `Icon=${icon}`, "Type=Application", ""].join("\n"));
  return icon;
}
