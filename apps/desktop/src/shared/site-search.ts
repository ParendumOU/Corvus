/**
 * Search shortcuts: a keyword typed first in the address bar searches a site with the rest ("yt
 * cats" searches YouTube). Added in Settings or imported from another browser: Chromium's site
 * search, Firefox's search engines with an alias and its bookmark keywords. Pure, so the rules are
 * unit tested; main/site-search-store.ts keeps them per profile.
 */

export interface SiteSearch {
  /** What is typed before the search terms: no spaces, lower case. */
  keyword: string;
  name: string;
  /** http(s) address with %s where the search terms go. */
  url: string;
}

export const MAX_SITE_SEARCHES = 200;

/** A keyword as stored: trimmed, lower case, no whitespace, 1-32 characters; "" when unusable. */
export function cleanKeyword(value: unknown): string {
  if (typeof value !== "string") return "";
  const keyword = value.trim().toLowerCase();
  return keyword.length > 0 && keyword.length <= 32 && !/\s/.test(keyword) ? keyword : "";
}

/** An http(s) address holding %s, or "" when it is not one. */
export function cleanTemplate(value: unknown): string {
  if (typeof value !== "string") return "";
  const url = value.trim();
  if (url.length > 2048 || !url.includes("%s")) return "";
  try {
    const parsed = new URL(url.replaceAll("%s", "corvus"));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : "";
  } catch {
    return "";
  }
}

export function cleanSiteSearch(raw: unknown): SiteSearch | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const keyword = cleanKeyword(r.keyword);
  const url = cleanTemplate(r.url);
  if (!keyword || !url) return null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 100) : keyword;
  return { keyword, name, url };
}

/** Valid shortcuts, the first of each keyword, at most MAX_SITE_SEARCHES. */
export function cleanSiteSearches(raw: unknown): SiteSearch[] {
  const out: SiteSearch[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const s = cleanSiteSearch(item);
    if (s && !out.some((o) => o.keyword === s.keyword)) out.push(s);
    if (out.length >= MAX_SITE_SEARCHES) break;
  }
  return out;
}

/** Adds the shortcuts whose keyword is new; the ones already there stay as they are. */
export function mergeSiteSearches(current: readonly SiteSearch[], incoming: readonly SiteSearch[]): { list: SiteSearch[]; added: number } {
  const list = [...current];
  let added = 0;
  for (const raw of incoming) {
    const s = cleanSiteSearch(raw);
    if (!s || list.length >= MAX_SITE_SEARCHES || list.some((o) => o.keyword === s.keyword)) continue;
    list.push(s);
    added++;
  }
  return { list, added };
}

/** The shortcut a typed "keyword terms" uses, its terms and the address, or null. */
export function matchSiteSearch(input: string, shortcuts: readonly SiteSearch[]): { shortcut: SiteSearch; terms: string; url: string } | null {
  const m = /^(\S+)\s+(\S[\s\S]*)$/.exec(input.trim());
  if (!m) return null;
  const keyword = m[1]!.toLowerCase();
  const shortcut = shortcuts.find((s) => s.keyword === keyword);
  if (!shortcut) return null;
  const terms = m[2]!.trim();
  return { shortcut, terms, url: shortcut.url.replaceAll("%s", encodeURIComponent(terms)) };
}

/** The address a typed "keyword terms" goes to, or null when it does not start with a keyword. */
export function siteSearchUrl(input: string, shortcuts: readonly SiteSearch[]): string | null {
  return matchSiteSearch(input, shortcuts)?.url ?? null;
}

/**
 * A Chromium search address as a shortcut template: {searchTerms} becomes %s, {google:baseURL} is
 * Google's address, and Chromium's other placeholders (tracking and suggestion parameters) go.
 */
export function chromiumTemplate(url: string): string {
  const filled = url
    .replace(/\{searchTerms\}/g, "%s")
    .replace(/\{google:baseURL\}/g, "https://www.google.com/")
    .replace(/\{inputEncoding\}|\{outputEncoding\}/g, "UTF-8")
    .replace(/\{[^}]*\}/g, "")
    .replace(/([?&])&+/g, "$1")
    .replace(/[?&]+$/, "");
  return cleanTemplate(filled);
}

/**
 * The person's own site searches from Chromium's keywords table (Web Data): ones they added or
 * edited (not safe to replace) or turned on, without the browser's prepopulated engines left as they
 * came, the starter packs (@bookmarks, @tabs…) and policy ones.
 */
export function chromiumSiteSearches(rows: ReadonlyArray<Record<string, unknown>>): SiteSearch[] {
  const n = (value: unknown): number => Number(value ?? 0) || 0;
  const out: SiteSearch[] = [];
  for (const r of rows) {
    if (n(r.starter_pack_id) > 0 || n(r.created_by_policy) > 0 || n(r.enforced_by_policy) > 0) continue;
    if (n(r.safe_for_autoreplace) !== 0 && n(r.is_active) !== 1) continue;
    const s = cleanSiteSearch({ keyword: r.keyword, name: r.short_name, url: chromiumTemplate(typeof r.url === "string" ? r.url : "") });
    if (s) out.push(s);
  }
  return cleanSiteSearches(out);
}

/** One of Firefox's search engines (search.json.mozlz4). */
interface FirefoxEngine {
  _name?: unknown;
  _metaData?: { alias?: unknown };
  _definedAliases?: unknown;
  _urls?: Array<{ template?: unknown; type?: unknown; method?: unknown; params?: Array<{ name?: unknown; value?: unknown }> }>;
}

/**
 * Firefox's search engines that have an alias (the person's own, or the engine's "@name"), as
 * shortcuts. Engines Firefox ships keep no address in the file and are left out, like POST ones.
 */
export function firefoxSearchEngines(data: unknown): SiteSearch[] {
  const engines = (data as { engines?: unknown } | null)?.engines;
  const out: SiteSearch[] = [];
  for (const e of Array.isArray(engines) ? (engines as FirefoxEngine[]) : []) {
    const aliases = Array.isArray(e._definedAliases) ? e._definedAliases : [];
    const keyword = cleanKeyword(e._metaData?.alias) || cleanKeyword(aliases[0]);
    const html = (e._urls ?? []).find((u) => (u.type === undefined || u.type === "text/html") && (u.method === undefined || String(u.method).toUpperCase() === "GET"));
    if (!keyword || !html || typeof html.template !== "string") continue;
    let address = html.template;
    const params = (html.params ?? []).filter((p) => typeof p.name === "string" && typeof p.value === "string");
    if (params.length > 0) {
      const query = params.map((p) => `${encodeURIComponent(p.name as string)}=${p.value === "{searchTerms}" ? "{searchTerms}" : encodeURIComponent(p.value as string)}`).join("&");
      address += (address.includes("?") ? "&" : "?") + query;
    }
    const url = cleanTemplate(address.replace(/\{searchTerms\}/g, "%s").replace(/\{[^}]*\}/g, ""));
    const s = url ? cleanSiteSearch({ keyword, name: e._name, url }) : null;
    if (s) out.push(s);
  }
  return out;
}

/** Firefox's bookmark keywords: a bookmarked address with %s (or %S) typed after its keyword. */
export function firefoxKeyword(keyword: unknown, url: unknown, title: unknown): SiteSearch | null {
  return cleanSiteSearch({ keyword, name: title, url: typeof url === "string" ? url.replace(/%S/g, "%s") : url });
}
