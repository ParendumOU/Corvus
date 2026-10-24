// Fake Chrome and Firefox profiles (real file formats, a few entries) for the browser-import tests
// and smoke: a Chromium "User Data" folder with Local State, Bookmarks and History, and a Firefox
// folder with profiles.ini and places.sqlite.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DataRoots } from "../shared/browser-import";

/** Chromium time: microseconds since 1601-01-01. */
const chromium = (ms: number): number => (ms + 11_644_473_600_000) * 1000;

/** A base::Pickle (4-byte payload size, fields padded to 4 bytes). */
function pickle(fields: Array<["int", number] | ["u64", bigint] | ["str", string] | ["str16", string]>): Buffer {
  const parts: Buffer[] = [];
  const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  for (const [kind, value] of fields) {
    if (kind === "int") parts.push(Buffer.from(new Int32Array([value]).buffer));
    else if (kind === "u64") parts.push(Buffer.from(new BigUint64Array([value]).buffer));
    else if (kind === "str") {
      const bytes = Buffer.from(value, "utf8");
      parts.push(Buffer.from(new Int32Array([bytes.length]).buffer), pad(bytes));
    } else {
      const bytes = Buffer.from(value, "utf16le");
      parts.push(Buffer.from(new Int32Array([value.length]).buffer), pad(bytes));
    }
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(new Uint32Array([body.length]).buffer), body]);
}

/** A Chromium SNSS session: one window with a pinned tab and two tabs in a "Research" group. */
function chromiumSessionFile(): Buffer {
  const ints = (...v: number[]): Buffer => Buffer.from(new Int32Array(v).buffer);
  const command = (id: number, body: Buffer): Buffer => Buffer.concat([Buffer.from(new Uint16Array([body.length + 1]).buffer), Buffer.from([id]), body]);
  const nav = (tab: number, url: string, title: string): Buffer => command(6, pickle([["int", tab], ["int", 0], ["str", url], ["str16", title], ["str", ""], ["int", 0]]));
  const group = Buffer.alloc(32);
  group.writeInt32LE(3, 0);
  group.writeBigUInt64LE(7n, 8);
  group.writeBigUInt64LE(9n, 16);
  group[24] = 1;
  const group4 = Buffer.from(group);
  group4.writeInt32LE(4, 0);
  return Buffer.concat([
    Buffer.from("SNSS"),
    ints(3),
    command(9, ints(1, 0)),
    ...[2, 3, 4].map((tab) => command(0, ints(1, tab))),
    ...[2, 3, 4].map((tab, i) => command(2, ints(tab, i))),
    nav(2, "https://mail.example/", "Mail"),
    command(12, Buffer.from([2, 0, 0, 0, 1, 0, 0, 0])),
    nav(3, "https://paper.example/", "Paper"),
    nav(4, "https://data.example/", "Data"),
    command(25, group),
    command(25, group4),
    command(27, pickle([["u64", 7n], ["u64", 9n], ["str16", "Research"], ["int", 1], ["int", 0]])),
  ]);
}

/** A Firefox .jsonlz4 file: "mozLz40\0", the size, then one LZ4 block (here, literals only). */
function mozLz4(text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  const head = [0xf0];
  let rest = data.length - 15;
  while (rest >= 255) {
    head.push(255);
    rest -= 255;
  }
  head.push(rest);
  return Buffer.concat([Buffer.from("mozLz40\0", "latin1"), Buffer.from(new Uint32Array([data.length]).buffer), Buffer.from(head), data]);
}

export const FIXTURE_NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

/** Writes the fake browsers under `root` (a Linux layout) and returns the roots to scan. */
export function writeBrowserFixtures(root: string): DataRoots {
  const config = path.join(root, ".config");
  const chrome = path.join(config, "google-chrome");
  for (const dir of ["Default", "Profile 1"]) fs.mkdirSync(path.join(chrome, dir), { recursive: true });
  fs.writeFileSync(
    path.join(chrome, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" }, "Profile 1": { name: "Work" } }, last_used: "Default" } }),
  );
  fs.writeFileSync(
    path.join(chrome, "Default", "Bookmarks"),
    JSON.stringify({
      roots: {
        bookmark_bar: {
          type: "folder",
          name: "Bookmarks bar",
          children: [
            { type: "url", name: "Corvus", url: "https://corvus.example/" },
            { type: "folder", name: "News", children: [{ type: "url", name: "Daily", url: "https://news.example/daily" }] },
          ],
        },
        other: { type: "folder", name: "Other", children: [{ type: "url", name: "Docs", url: "https://docs.example/" }] },
        synced: { type: "folder", name: "Mobile", children: [] },
      },
    }),
  );
  const history = new DatabaseSync(path.join(chrome, "Default", "History"));
  history.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)");
  const addUrl = history.prepare("INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, 0, ?, ?)");
  addUrl.run("https://corvus.example/", "Corvus", 12, chromium(FIXTURE_NOW - 3_600_000), 0);
  addUrl.run("https://news.example/daily", "Daily news", 3, chromium(FIXTURE_NOW - 86_400_000), 0);
  addUrl.run("chrome://settings/", "Settings", 2, chromium(FIXTURE_NOW - 7_200_000), 0);
  addUrl.run("https://hidden.example/", "Hidden", 1, chromium(FIXTURE_NOW - 7_200_000), 1);
  history.close();
  fs.mkdirSync(path.join(chrome, "Default", "Sessions"), { recursive: true });
  fs.writeFileSync(path.join(chrome, "Default", "Sessions", "Session_13400000000000000"), chromiumSessionFile());
  // Extensions: two from the Web Store (one named through its locale messages), and a component,
  // one from Microsoft's store, a theme, one installed with the browser and an uninstall leftover,
  // which are not offered.
  const extension = (id: string, version: string, manifest: Record<string, unknown>, messages?: Record<string, { message: string }>): void => {
    const dir = path.join(chrome, "Default", "Extensions", id, version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, version: version.split("_")[0], ...manifest }));
    if (messages) {
      fs.mkdirSync(path.join(dir, "_locales", "en"), { recursive: true });
      fs.writeFileSync(path.join(dir, "_locales", "en", "messages.json"), JSON.stringify(messages));
    }
  };
  const store = "https://clients2.google.com/service/update2/crx";
  extension("eimadpbcbfnmbkopoojfekhnkhdbieeh", "4.9.1_0", { name: "__MSG_extName__", default_locale: "en", update_url: store }, { extname: { message: "Night Mode" } });
  extension("ddkjiahejlhfcafbddmgiahcphecmpfh", "2025.1_0", { name: "uBlock Origin Lite", update_url: store });
  extension("odfafepnkmbhccpbejgmiehpchacaeak", "1.60_0", { name: "uBlock Origin (Edge)", update_url: "https://edge.microsoft.com/extensionwebstorebase/v1/crx" });
  extension("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab", "1.0_0", { name: "Dark theme", theme: { colors: {} }, update_url: store });
  extension("ghbmnnjooekpmoecnnnilnnbdlolhkhi", "1.9_0", { name: "Docs offline", update_url: store });
  const installed = (id: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ location: 1, from_webstore: true, path: `${id}/${version}`, ...extra });
  fs.writeFileSync(
    path.join(chrome, "Default", "Secure Preferences"),
    JSON.stringify({
      extensions: {
        settings: {
          eimadpbcbfnmbkopoojfekhnkhdbieeh: installed("eimadpbcbfnmbkopoojfekhnkhdbieeh", "4.9.1_0"),
          ddkjiahejlhfcafbddmgiahcphecmpfh: installed("ddkjiahejlhfcafbddmgiahcphecmpfh", "2025.1_0"),
          odfafepnkmbhccpbejgmiehpchacaeak: installed("odfafepnkmbhccpbejgmiehpchacaeak", "1.60_0", { from_webstore: false }),
          aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab: installed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab", "1.0_0"),
          ghbmnnjooekpmoecnnnilnnbdlolhkhi: installed("ghbmnnjooekpmoecnnnilnnbdlolhkhi", "1.9_0", { was_installed_by_default: true }),
          mhjfbmdgcfjbbpaeojofohoefgiehjai: { location: 5, path: "/opt/chrome/resources/pdf", manifest: { name: "Chrome PDF Viewer" } },
          bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: installed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "3.0_0"),
        },
      },
      protection: { macs: {} },
    }),
  );
  fs.writeFileSync(path.join(chrome, "Default", "Preferences"), JSON.stringify({ extensions: { settings: { eimadpbcbfnmbkopoojfekhnkhdbieeh: { state: 1 } } } }));
  // Site search (Web Data's keywords): the person's own, an edited built-in and an auto-added one
  // they turned on are imported; a built-in as it came, an inactive auto-added one, a starter pack
  // and a policy one are not.
  const webData = new DatabaseSync(path.join(chrome, "Default", "Web Data"));
  webData.exec(
    "CREATE TABLE keywords (id INTEGER PRIMARY KEY, short_name TEXT, keyword TEXT, url TEXT, safe_for_autoreplace INTEGER, prepopulate_id INTEGER, created_by_policy INTEGER, is_active INTEGER, starter_pack_id INTEGER)",
  );
  const addKeyword = webData.prepare("INSERT INTO keywords (short_name, keyword, url, safe_for_autoreplace, prepopulate_id, created_by_policy, is_active, starter_pack_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const google = "{google:baseURL}search?q={searchTerms}&{google:RLZ}{google:originalQueryForSuggestion}ie={inputEncoding}";
  addKeyword.run("YouTube", "yt", "https://www.youtube.com/results?search_query={searchTerms}", 0, 0, 0, 1, 0);
  addKeyword.run("Google", "google.com", google, 1, 1, 0, 0, 0);
  addKeyword.run("Google", "g", google, 0, 1, 0, 0, 0);
  addKeyword.run("GitHub", "github.com", "https://github.com/search?q={searchTerms}", 1, 0, 0, 2, 0);
  addKeyword.run("Wikipedia", "wiki", "https://en.wikipedia.org/w/index.php?search={searchTerms}", 1, 0, 0, 1, 0);
  addKeyword.run("Bookmarks", "@bookmarks", "chrome://bookmarks/?q={searchTerms}", 0, 0, 0, 0, 1);
  addKeyword.run("Intranet", "in", "https://intranet.example/?q={searchTerms}", 0, 0, 1, 1, 0);
  webData.close();
  // A second profile with bookmarks only.
  fs.writeFileSync(path.join(chrome, "Profile 1", "Bookmarks"), JSON.stringify({ roots: { bookmark_bar: { type: "folder", name: "Bar", children: [{ type: "url", name: "Work", url: "https://work.example/" }] } } }));

  const firefox = path.join(root, ".mozilla", "firefox");
  const profile = path.join(firefox, "abcd1234.default-release");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(firefox, "profiles.ini"),
    ["[Install4F96D1932A9F858E]", "Default=abcd1234.default-release", "Locked=1", "", "[Profile0]", "Name=default-release", "IsRelative=1", "Path=abcd1234.default-release", "", "[General]", "StartWithLastProfile=1", "Version=2", ""].join("\n"),
  );
  const places = new DatabaseSync(path.join(profile, "places.sqlite"));
  places.exec(
    "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, hidden INTEGER, last_visit_date INTEGER);" +
      "CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, guid TEXT);" +
      "CREATE TABLE moz_keywords (id INTEGER PRIMARY KEY, keyword TEXT UNIQUE, place_id INTEGER, post_data TEXT);",
  );
  const addPlace = places.prepare("INSERT INTO moz_places (id, url, title, visit_count, hidden, last_visit_date) VALUES (?, ?, ?, ?, ?, ?)");
  addPlace.run(1, "https://firefox.example/", "Firefox page", 5, 0, (FIXTURE_NOW - 1_800_000) * 1000);
  addPlace.run(2, "https://mdn.example/", "MDN", 0, 0, null);
  addPlace.run(3, "place:sort=8", "Most visited", 0, 1, null);
  // Bookmark keywords: "bug 123" opens a bug; a POST one and one the MDN engine already has are left out.
  addPlace.run(4, "https://bugs.example/show_bug.cgi?id=%S", "Bug", 0, 0, null);
  addPlace.run(5, "https://developer.mozilla.org/search?q=%s", "MDN search", 0, 0, null);
  addPlace.run(6, "https://post.example/search", "Post search", 0, 0, null);
  const addFxKeyword = places.prepare("INSERT INTO moz_keywords (keyword, place_id, post_data) VALUES (?, ?, ?)");
  addFxKeyword.run("bug", 4, null);
  addFxKeyword.run("mdn", 5, null);
  addFxKeyword.run("post", 6, "q=%s");
  const addMark = places.prepare("INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES (?, ?, ?, ?, ?, ?, ?)");
  addMark.run(1, 2, null, 0, 0, "", "root________");
  addMark.run(2, 2, null, 1, 0, "menu", "menu________");
  addMark.run(3, 2, null, 1, 1, "toolbar", "toolbar_____");
  addMark.run(5, 2, null, 1, 3, "unfiled", "unfiled_____");
  addMark.run(10, 1, 2, 3, 0, "MDN Web Docs", "bm10");
  addMark.run(11, 2, null, 3, 1, "Reading", "bm11");
  addMark.run(12, 1, 1, 11, 0, "Firefox page", "bm12");
  addMark.run(13, 1, 3, 2, 0, "Most visited", "bm13");
  places.close();
  fs.writeFileSync(
    path.join(profile, "extensions.json"),
    JSON.stringify({
      schemaVersion: 36,
      addons: [
        { id: "{a1b2c3d4-0000-4000-8000-000000000001}", type: "extension", location: "app-profile", defaultLocale: { name: "uBlock Origin" } },
        { id: "{a1b2c3d4-0000-4000-8000-000000000002}", type: "extension", location: "app-system-defaults", isSystem: true, defaultLocale: { name: "Form Autofill" } },
        { id: "{a1b2c3d4-0000-4000-8000-000000000003}", type: "theme", location: "app-profile", defaultLocale: { name: "Dark" } },
      ],
    }),
  );
  // Search engines: the person's own with an alias and a site's with its "@" alias are imported; a
  // built-in engine (no address in the file) and one without an alias are not.
  fs.writeFileSync(
    path.join(profile, "search.json.mozlz4"),
    mozLz4(
      JSON.stringify({
        version: 12,
        engines: [
          { id: "ddg", _name: "DuckDuckGo", _isConfigEngine: true, _metaData: { alias: "d" } },
          { id: "u1", _name: "MDN", _loadPath: "[user]", _metaData: { alias: "mdn" }, _urls: [{ template: "https://developer.mozilla.org/search?q={searchTerms}", params: [] }] },
          {
            id: "o1",
            _name: "Wikipedia (es)",
            _loadPath: "[https]es.wikipedia.org/opensearch.xml",
            _definedAliases: ["@wikies"],
            _urls: [
              { template: "https://es.wikipedia.org/w/api.php?action=opensearch&search={searchTerms}", type: "application/x-suggestions+json" },
              { template: "https://es.wikipedia.org/w/index.php", type: "text/html", params: [{ name: "search", value: "{searchTerms}" }] },
            ],
          },
          { id: "u2", _name: "No alias", _loadPath: "[user]", _metaData: {}, _urls: [{ template: "https://noalias.example/?q={searchTerms}" }] },
        ],
      }),
    ),
  );
  fs.mkdirSync(path.join(profile, "sessionstore-backups"), { recursive: true });
  fs.writeFileSync(
    path.join(profile, "sessionstore-backups", "recovery.jsonlz4"),
    mozLz4(JSON.stringify({ windows: [{ tabs: [{ entries: [{ url: "https://firefox.example/", title: "Firefox page" }], index: 1 }], groups: [] }] })),
  );

  return { platform: "linux", home: root, localAppData: "", appData: "", config };
}
