import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countBookmarks, parseChromeJson, type ImportedNode } from "../shared/bookmark-import";
import { OTHER_FOLDER_ID } from "../shared/bookmark-tree";
import {
  browserLocations,
  chromiumExtensionEntries,
  chromiumProfiles,
  chromiumTime,
  firefoxBookmarkTree,
  firefoxExtensions,
  firefoxProfiles,
  firefoxTime,
  importableHistory,
  isChromiumProfileDir,
  webStoreExtension,
  type DataRoots,
  type FirefoxBookmarkRow,
  type ImportExtension,
  type ImportKind,
  type ImportProfile,
  type ImportResult,
  type ImportScan,
  type ImportSource,
} from "../shared/browser-import";
import { MAX_HISTORY_ENTRIES } from "../shared/history-ops";
import { chromiumSession, decodeMozLz4, firefoxSession, type ImportedWindow } from "../shared/browser-sessions";
import { chromiumSiteSearches, cleanSiteSearches, firefoxKeyword, firefoxSearchEngines, type SiteSearch } from "../shared/site-search";
import type { ProfileRuntime } from "./profiles";

type Family = ImportSource["family"];

function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Why a browser file could not be read, for the person. */
function readError(err: unknown, browser: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES" || /locked|busy/i.test(String(err))) return `${browser} is using its files: close ${browser} and try again.`;
  return `Could not read it (${err instanceof Error ? err.message : String(err)}).`;
}

/**
 * Reads a browser's SQLite database from a private copy (with its write-ahead log), so a running
 * browser's open file is never touched and Corvus never writes to another browser's data.
 */
async function withDatabase<T>(file: string, read: (db: DatabaseSync) => T): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "corvus-import-"));
  try {
    // Copied without blocking: a browser's history can be hundreds of megabytes.
    const copy = path.join(dir, "db.sqlite");
    await fs.promises.copyFile(file, copy);
    for (const suffix of ["-wal", "-journal"]) if (exists(file + suffix)) await fs.promises.copyFile(file + suffix, copy + suffix);
    const db = new DatabaseSync(copy);
    try {
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/** Rows of a query, integers as BigInt: Chromium's timestamps are past Number.MAX_SAFE_INTEGER. */
function rows<T>(db: DatabaseSync, sql: string): T[] {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all() as unknown as T[];
}

const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { n: number | bigint } | undefined)?.n ?? 0);

const CHROMIUM_HISTORY_COUNT = "SELECT count(*) AS n FROM urls WHERE hidden = 0 AND (url LIKE 'http://%' OR url LIKE 'https://%')";
const FIREFOX_BOOKMARK_COUNT = "SELECT count(*) AS n FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk WHERE b.type = 1 AND (p.url LIKE 'http%' OR p.url LIKE 'ftp%' OR p.url LIKE 'file%')";
/** Firefox's bookmark keywords ("w" + a bookmarked address with %s); ones that POST are left out. */
function firefoxKeywords(db: DatabaseSync): SiteSearch[] {
  try {
    const found = db
      .prepare(
        "SELECT k.keyword AS keyword, p.url AS url, k.post_data AS post, (SELECT b.title FROM moz_bookmarks b WHERE b.fk = p.id AND b.title <> '' LIMIT 1) AS title FROM moz_keywords k JOIN moz_places p ON p.id = k.place_id",
      )
      .all() as Array<{ keyword: unknown; url: unknown; post: unknown; title: unknown }>;
    return found.filter((r) => !r.post).flatMap((r) => firefoxKeyword(r.keyword, r.url, r.title) ?? []);
  } catch {
    // An older places.sqlite without moz_keywords.
    return [];
  }
}

const FIREFOX_HISTORY_COUNT = "SELECT count(*) AS n FROM moz_places WHERE visit_count > 0 AND hidden = 0 AND last_visit_date IS NOT NULL AND (url LIKE 'http://%' OR url LIKE 'https://%')";

/**
 * Importing from the other browsers installed for this user (Chrome, Edge, Brave, Vivaldi, Opera,
 * Chromium, Firefox): finds them and their profiles, counts what each holds, and imports bookmarks
 * and history into a Corvus profile. Their files are only ever read, from copies.
 */
export class BrowserImport {
  private testRoots: DataRoots | null = null;

  /** Smoke tests point the scan at fake browser folders. */
  setTestRoots(roots: DataRoots | null): void {
    this.testRoots = roots;
  }

  private roots(): DataRoots {
    if (this.testRoots) return this.testRoots;
    const home = os.homedir();
    return {
      platform: process.platform,
      home,
      localAppData: process.env.LOCALAPPDATA ?? "",
      appData: process.env.APPDATA ?? "",
      config: process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
    };
  }

  /** Every installed browser with at least one profile, and what each profile holds. */
  async scan(): Promise<ImportScan> {
    const sources: ImportSource[] = [];
    for (const loc of browserLocations(this.roots())) {
      if (!exists(loc.dir) || sources.some((s) => s.id === loc.id)) continue;
      const profiles = loc.family === "chromium" ? this.chromiumProfiles(loc.dir, loc.singleProfile === true, loc.name) : this.firefoxProfiles(loc.dir);
      if (profiles.length === 0) continue;
      const counted: ImportProfile[] = [];
      for (const p of profiles) counted.push({ ...p, counts: await this.counts(loc.family, p.path), extensions: this.extensions(loc.family, p.path) });
      sources.push({ id: loc.id, name: loc.name, family: loc.family, profiles: counted });
    }
    return { sources };
  }

  private chromiumProfiles(dir: string, single: boolean, browser: string): Array<Omit<ImportProfile, "counts" | "extensions">> {
    if (single) return exists(path.join(dir, "Bookmarks")) || exists(path.join(dir, "History")) ? [{ dir: "", name: browser, path: dir, isDefault: true }] : [];
    let found: string[] = [];
    try {
      found = fs.readdirSync(dir).filter((d) => isChromiumProfileDir(d) && (exists(path.join(dir, d, "Bookmarks")) || exists(path.join(dir, d, "History"))));
    } catch {
      return [];
    }
    return chromiumProfiles(readText(path.join(dir, "Local State")), found).map((p) => ({ ...p, path: path.join(dir, p.dir) }));
  }

  private firefoxProfiles(dir: string): Array<Omit<ImportProfile, "counts" | "extensions">> {
    const ini = readText(path.join(dir, "profiles.ini"));
    if (!ini) return [];
    return firefoxProfiles(ini)
      .map((p) => ({ dir: p.path, name: p.name, path: p.relative ? path.join(dir, ...p.path.split("/")) : p.path, isDefault: p.isDefault }))
      .filter((p) => exists(path.join(p.path, "places.sqlite")));
  }

  /**
   * Extensions the person installed in a profile: a Chromium profile's Web Store extensions (name
   * from the installed manifest), a Firefox profile's add-ons by name. Small files, read directly.
   */
  private extensions(family: Family, dir: string): ImportExtension[] {
    if (family === "firefox") return firefoxExtensions(readText(path.join(dir, "extensions.json")));
    const found: ImportExtension[] = [];
    for (const entry of chromiumExtensionEntries([readText(path.join(dir, "Preferences")), readText(path.join(dir, "Secure Preferences"))])) {
      const folder = path.isAbsolute(entry.path) ? entry.path : path.join(dir, "Extensions", ...entry.path.split(/[\\/]/));
      let manifest: unknown = null;
      try {
        manifest = JSON.parse(readText(path.join(folder, "manifest.json")) ?? "null");
      } catch {
        manifest = null;
      }
      // An entry without its files is a leftover of an uninstall.
      if (!manifest && !entry.manifest) continue;
      const locale = ((manifest ?? entry.manifest) as { default_locale?: unknown }).default_locale;
      const messages = typeof locale === "string" && /^[\w-]+$/.test(locale) ? readText(path.join(folder, "_locales", locale, "messages.json")) : null;
      const extension = webStoreExtension(entry, manifest, messages);
      if (extension) found.push(extension);
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async counts(family: Family, dir: string): Promise<ImportProfile["counts"]> {
    const safe = async (fn: () => number | Promise<number>): Promise<number | null> => {
      try {
        return await fn();
      } catch {
        return null;
      }
    };
    const tabs = await safe(async () => (await this.sessionWindows(family, dir)).reduce((n, w) => n + w.tabs.length, 0));
    if (family === "chromium") {
      return {
        tabs,
        bookmarks: exists(path.join(dir, "Bookmarks")) ? await safe(async () => countBookmarks(parseChromeJson(await fs.promises.readFile(path.join(dir, "Bookmarks"), "utf8")))) : 0,
        history: exists(path.join(dir, "History")) ? await safe(() => withDatabase(path.join(dir, "History"), (db) => count(db, CHROMIUM_HISTORY_COUNT))) : 0,
        search: exists(path.join(dir, "Web Data")) ? await safe(async () => (await this.searches(family, dir)).length) : 0,
      };
    }
    try {
      // One copy of places.sqlite serves the bookmark, history and keyword counts.
      const { keywords, ...counts } = await withDatabase(path.join(dir, "places.sqlite"), (db) => ({
        bookmarks: count(db, FIREFOX_BOOKMARK_COUNT),
        history: count(db, FIREFOX_HISTORY_COUNT),
        keywords: firefoxKeywords(db),
      }));
      return { ...counts, tabs, search: cleanSiteSearches([...(await this.firefoxEngines(dir)), ...keywords]).length };
    } catch {
      return { bookmarks: null, history: null, tabs, search: null };
    }
  }

  /**
   * Search shortcuts of a profile: Chromium's own site searches (Web Data), Firefox's engines with
   * an alias and its bookmark keywords.
   */
  private async searches(family: Family, dir: string): Promise<SiteSearch[]> {
    if (family === "chromium") {
      const file = path.join(dir, "Web Data");
      return exists(file) ? withDatabase(file, (db) => chromiumSiteSearches(db.prepare("SELECT * FROM keywords").all() as Array<Record<string, unknown>>)) : [];
    }
    const keywords = await withDatabase(path.join(dir, "places.sqlite"), firefoxKeywords);
    return cleanSiteSearches([...(await this.firefoxEngines(dir)), ...keywords]);
  }

  /** Firefox's search engines (search.json.mozlz4); none when the file is missing or unreadable. */
  private async firefoxEngines(dir: string): Promise<SiteSearch[]> {
    try {
      const data = new Uint8Array(await fs.promises.readFile(path.join(dir, "search.json.mozlz4")));
      return firefoxSearchEngines(JSON.parse(decodeMozLz4(data)) as unknown);
    } catch {
      return [];
    }
  }

  /** Imports the chosen kinds of one browser profile into `runtime`. */
  async run(runtime: ProfileRuntime, sourceId: string, profileDir: string, kinds: readonly ImportKind[]): Promise<ImportResult> {
    const source = (await this.scan()).sources.find((s) => s.id === sourceId);
    const profile = source?.profiles.find((p) => p.dir === profileDir);
    if (!source || !profile) throw new Error("That browser profile is no longer there.");
    const label = source.profiles.length > 1 ? `${source.name} (${profile.name})` : source.name;
    const result: ImportResult = { errors: {} };
    if (kinds.includes("bookmarks")) {
      try {
        const tree = await this.bookmarks(source.family, profile.path);
        result.bookmarks = runtime.bookmarks.importTree(OTHER_FOLDER_ID, `Imported from ${label}`, tree);
      } catch (err) {
        result.errors.bookmarks = readError(err, source.name);
      }
    }
    if (kinds.includes("history")) {
      try {
        result.history = { imported: runtime.history.importEntries(await this.history(source.family, profile.path)) };
      } catch (err) {
        result.errors.history = readError(err, source.name);
      }
    }
    if (kinds.includes("search")) {
      try {
        result.search = { imported: runtime.siteSearch.importMany(await this.searches(source.family, profile.path)) };
      } catch (err) {
        result.errors.search = readError(err, source.name);
      }
    }
    if (kinds.includes("tabs")) {
      try {
        const windows = await this.sessionWindows(source.family, profile.path);
        let saved = 0;
        let tabs = 0;
        for (const [i, w] of windows.entries()) {
          const before = runtime.workspaces.list().length;
          runtime.workspaces.save(windows.length > 1 ? `${label}, window ${i + 1}` : label, w.tabs, w.groups);
          if (runtime.workspaces.list().length > before) {
            saved++;
            tabs += w.tabs.length;
          }
        }
        result.tabs = { windows: saved, tabs };
      } catch (err) {
        result.errors.tabs = readError(err, source.name);
      }
    }
    return result;
  }

  /**
   * The browser's open windows from its newest session file: Chromium's Sessions/Session_* (or
   * "Current Session" before Chromium 100), Firefox's sessionstore (the running one's recovery copy
   * when it is newer). No session file means no windows.
   */
  private async sessionWindows(family: Family, dir: string): Promise<ImportedWindow[]> {
    const candidates =
      family === "chromium"
        ? [...(await fs.promises.readdir(path.join(dir, "Sessions")).catch(() => [] as string[])).filter((f) => f.startsWith("Session_")).map((f) => path.join(dir, "Sessions", f)), path.join(dir, "Current Session")]
        : [path.join(dir, "sessionstore-backups", "recovery.jsonlz4"), path.join(dir, "sessionstore.jsonlz4"), path.join(dir, "sessionstore-backups", "previous.jsonlz4")];
    let newest: { file: string; at: number } | null = null;
    for (const file of candidates) {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat?.isFile() && (!newest || stat.mtimeMs > newest.at)) newest = { file, at: stat.mtimeMs };
    }
    if (!newest) return [];
    const data = new Uint8Array(await fs.promises.readFile(newest.file));
    return family === "chromium" ? chromiumSession(data) : firefoxSession(JSON.parse(decodeMozLz4(data)) as unknown);
  }

  private async bookmarks(family: Family, dir: string): Promise<ImportedNode[]> {
    if (family === "chromium") {
      const file = path.join(dir, "Bookmarks");
      return exists(file) ? parseChromeJson(await fs.promises.readFile(file, "utf8")) : [];
    }
    return withDatabase(path.join(dir, "places.sqlite"), (db) => {
      const rows = db
        .prepare("SELECT b.id AS id, b.parent AS parent, b.type AS type, b.title AS title, p.url AS url, b.position AS position FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk")
        .all() as unknown as FirefoxBookmarkRow[];
      const roots: Record<string, number> = {};
      for (const r of db.prepare("SELECT guid, id FROM moz_bookmarks WHERE guid IN ('toolbar_____', 'menu________', 'unfiled_____', 'mobile______')").all() as Array<{ guid: string; id: number }>) roots[r.guid] = Number(r.id);
      return firefoxBookmarkTree(rows.map((r) => ({ ...r, id: Number(r.id), parent: Number(r.parent), type: Number(r.type), position: Number(r.position) })), roots);
    });
  }

  private async history(family: Family, dir: string): Promise<Array<{ url: string; title: string; visitedAt: number; visitCount: number }>> {
    if (family === "chromium") {
      const file = path.join(dir, "History");
      if (!exists(file)) return [];
      return withDatabase(file, (db) => {
        const found = rows<{ url: string; title: string | null; t: bigint; n: bigint }>(
          db,
          `SELECT url, title, last_visit_time AS t, visit_count AS n FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ${MAX_HISTORY_ENTRIES * 2}`,
        );
        return importableHistory(
          found.map((r) => ({ url: r.url, title: (r.title ?? "").slice(0, 500), visitedAt: chromiumTime(r.t), visitCount: Math.max(1, Number(r.n)) })),
          MAX_HISTORY_ENTRIES,
        );
      });
    }
    return withDatabase(path.join(dir, "places.sqlite"), (db) => {
      const found = rows<{ url: string; title: string | null; t: bigint; n: bigint }>(
        db,
        `SELECT url, title, last_visit_date AS t, visit_count AS n FROM moz_places WHERE visit_count > 0 AND hidden = 0 AND last_visit_date IS NOT NULL ORDER BY last_visit_date DESC LIMIT ${MAX_HISTORY_ENTRIES * 2}`,
      );
      return importableHistory(
        found.map((r) => ({ url: r.url, title: (r.title ?? "").slice(0, 500), visitedAt: firefoxTime(r.t), visitCount: Math.max(1, Number(r.n)) })),
        MAX_HISTORY_ENTRIES,
      );
    });
  }
}
