import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SiteSearchStore } from "../src/main/site-search-store";
import {
  chromiumSiteSearches,
  chromiumTemplate,
  cleanKeyword,
  cleanSiteSearches,
  cleanTemplate,
  firefoxKeyword,
  firefoxSearchEngines,
  matchSiteSearch,
  MAX_SITE_SEARCHES,
  mergeSiteSearches,
  siteSearchUrl,
} from "../src/shared/site-search";
import { buildSuggestions } from "../src/shared/suggest";

const yt = { keyword: "yt", name: "YouTube", url: "https://www.youtube.com/results?search_query=%s" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("search shortcuts", () => {
  it("keeps usable keywords and addresses only", () => {
    expect(cleanKeyword("  YT ")).toBe("yt");
    expect(["", "two words", "x".repeat(33), 7].map(cleanKeyword)).toEqual(["", "", "", ""]);
    expect(cleanTemplate("https://a.example/?q=%s")).toBe("https://a.example/?q=%s");
    expect(["https://a.example/", "javascript:alert(%s)", "file:///%s", "not a url %s"].map(cleanTemplate)).toEqual(["", "", "", ""]);
    expect(cleanSiteSearches([yt, { ...yt, name: "Again" }, { keyword: "w", url: "https://w.example/%s" }, { keyword: "bad", url: "https://x.example/" }, null])).toEqual([
      yt,
      { keyword: "w", name: "w", url: "https://w.example/%s" },
    ]);
  });

  it("turns 'keyword terms' into the site's search address", () => {
    expect(siteSearchUrl("yt  corvus browser ", [yt])).toBe("https://www.youtube.com/results?search_query=corvus%20browser");
    expect(siteSearchUrl("YT cats & dogs", [yt])).toBe("https://www.youtube.com/results?search_query=cats%20%26%20dogs");
    expect(matchSiteSearch("yt cats", [yt])).toMatchObject({ shortcut: yt, terms: "cats" });
    expect(siteSearchUrl("yt", [yt])).toBeNull();
    expect(siteSearchUrl("ytcats", [yt])).toBeNull();
    expect(siteSearchUrl("how to cook", [yt])).toBeNull();
  });

  it("adds only new keywords when merging", () => {
    const merged = mergeSiteSearches([yt], [{ ...yt, name: "Other" }, { keyword: "w", name: "Wiki", url: "https://w.example/?s=%s" }]);
    expect(merged).toEqual({ list: [yt, { keyword: "w", name: "Wiki", url: "https://w.example/?s=%s" }], added: 1 });
    const full = Array.from({ length: MAX_SITE_SEARCHES }, (_, i) => ({ keyword: `k${i}`, name: "", url: "https://k.example/%s" }));
    expect(mergeSiteSearches(full, [yt]).added).toBe(0);
  });

  it("reads Chromium's site searches", () => {
    const google = "{google:baseURL}search?q={searchTerms}&{google:RLZ}{google:originalQueryForSuggestion}ie={inputEncoding}";
    expect(chromiumTemplate(google)).toBe("https://www.google.com/search?q=%s&ie=UTF-8");
    expect(chromiumTemplate("https://a.example/s?{google:sourceId}q={searchTerms}&")).toBe("https://a.example/s?q=%s");
    expect(chromiumTemplate("chrome://bookmarks/?q={searchTerms}")).toBe("");
    const rows = [
      { short_name: "YouTube", keyword: "yt", url: "https://www.youtube.com/results?search_query={searchTerms}", safe_for_autoreplace: 0, prepopulate_id: 0 },
      { short_name: "Google", keyword: "google.com", url: google, safe_for_autoreplace: 1, prepopulate_id: 1, is_active: 0 },
      { short_name: "Google", keyword: "g", url: google, safe_for_autoreplace: 0, prepopulate_id: 1 },
      { short_name: "GitHub", keyword: "github.com", url: "https://github.com/search?q={searchTerms}", safe_for_autoreplace: 1, is_active: 2 },
      { short_name: "Wikipedia", keyword: "wiki", url: "https://en.wikipedia.org/w/index.php?search={searchTerms}", safe_for_autoreplace: 1n, is_active: 1n },
      { short_name: "Tabs", keyword: "@tabs", url: "https://tabs.example/{searchTerms}", safe_for_autoreplace: 0, starter_pack_id: 2 },
      { short_name: "Policy", keyword: "p", url: "https://p.example/{searchTerms}", safe_for_autoreplace: 0, created_by_policy: 1 },
    ];
    expect(chromiumSiteSearches(rows)).toEqual([
      yt,
      { keyword: "g", name: "Google", url: "https://www.google.com/search?q=%s&ie=UTF-8" },
      { keyword: "wiki", name: "Wikipedia", url: "https://en.wikipedia.org/w/index.php?search=%s" },
    ]);
  });

  it("reads Firefox's engines with an alias and its bookmark keywords", () => {
    const engines = {
      engines: [
        { _name: "Built-in", _metaData: { alias: "b" } },
        { _name: "Own", _metaData: { alias: "own" }, _urls: [{ template: "https://own.example/?q={searchTerms}&src={moz:distributionID}" }] },
        { _name: "Site", _definedAliases: ["@site"], _urls: [{ template: "https://site.example/s", type: "text/html", params: [{ name: "q", value: "{searchTerms}" }, { name: "lang", value: "es es" }] }] },
        { _name: "Post", _metaData: { alias: "post" }, _urls: [{ template: "https://post.example/", method: "POST", params: [{ name: "q", value: "{searchTerms}" }] }] },
        { _name: "No alias", _urls: [{ template: "https://x.example/?q={searchTerms}" }] },
      ],
    };
    expect(firefoxSearchEngines(engines)).toEqual([
      { keyword: "own", name: "Own", url: "https://own.example/?q=%s&src=" },
      { keyword: "@site", name: "Site", url: "https://site.example/s?q=%s&lang=es%20es" },
    ]);
    expect(firefoxSearchEngines(null)).toEqual([]);
    expect(firefoxKeyword("bug", "https://bugs.example/?id=%S", null)).toEqual({ keyword: "bug", name: "bug", url: "https://bugs.example/?id=%s" });
    expect(firefoxKeyword("home", "https://home.example/", "Home")).toBeNull();
  });

  it("offers a shortcut's search first in the address bar suggestions", () => {
    const [first] = buildSuggestions("yt cats", [], [], 1, [yt]);
    expect(first).toEqual({ kind: "search", title: "cats", url: "https://www.youtube.com/results?search_query=cats", detail: "Search YouTube" });
    expect(buildSuggestions("yt", [], [], 1, [yt])[0]?.detail).toBe("Search with Corvus AI");
  });
});

describe("SiteSearchStore", () => {
  it("saves, replaces, removes and imports a profile's shortcuts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-site-search-"));
    dirs.push(dir);
    const store = new SiteSearchStore(dir);
    expect(store.save({ keyword: " YT ", name: "YouTube", url: yt.url })).toEqual([yt]);
    expect(store.save({ keyword: "w", name: "Wiki", url: "https://w.example/?s=%s" }).map((s) => s.keyword)).toEqual(["yt", "w"]);
    expect(store.save({ ...yt, name: "YT" })[0]).toEqual({ ...yt, name: "YT" });
    expect(() => store.save({ keyword: "x", url: "https://x.example/" })).toThrow(/%s/);
    expect(store.importMany([yt, { keyword: "g", name: "Google", url: "https://www.google.com/search?q=%s" }])).toBe(1);
    expect(store.remove("w").map((s) => s.keyword)).toEqual(["yt", "g"]);
    store.flush();
    expect(new SiteSearchStore(dir).list().map((s) => s.keyword)).toEqual(["yt", "g"]);
  });
});
