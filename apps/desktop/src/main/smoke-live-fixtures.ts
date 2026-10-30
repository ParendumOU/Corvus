// Fake Chrome and Firefox profiles whose history keeps growing, for the live history tests and smoke:
// a Chromium History (urls and visits, as Chrome writes them) and a Firefox places.sqlite in WAL mode
// (moz_places and moz_historyvisits), with made-up pages on example.com and example.org.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toChromiumTime, toFirefoxTime, type DataRoots } from "../shared/browser-import";

export interface LiveFixtures {
  roots: DataRoots;
  chromeHistory: string;
  firefoxPlaces: string;
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
    chromeVisit,
    firefoxVisit,
    close: () => firefox.close(),
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
