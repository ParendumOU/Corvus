import { filterListMetadataUrl, filterListUrl, latestFilterListRevision } from "@corvus/shared";

/**
 * Where the filter lists come from: Ghostery's CDN, which republishes uBlock Origin's, EasyList's and
 * Peter Lowe's lists every day in the syntax its engine reads (scriptlet arguments encoded). Its GitHub
 * assets, which the library's own helpers fetch, are test fixtures that only move when a maintainer
 * merges an update, and they leave out the newest uBlock Origin lists: YouTube's rules go stale there.
 */
export const ADS_AND_TRACKING_LISTS = [
  "easylist",
  "plowe-0",
  "ublock-badware",
  "ublock-filters-2020",
  "ublock-filters-2021",
  "ublock-filters-2022",
  "ublock-filters-2023",
  "ublock-filters-2024",
  "ublock-filters-2025",
  "ublock-filters-2026",
  "ublock-filters",
  "ublock-quick-fixes",
  "ublock-abuse",
  "ublock-unbreak",
  "easyprivacy",
  "ublock-privacy",
] as const;

export const ANNOYANCE_LISTS = ["easylist-cookie", "ublock-annoyances-others", "ublock-annoyances-cookies"] as const;

/** uBlock Origin's scriptlets and redirect stand-ins, at the version of the lists that use them. */
export const RESOURCES_LIST = "ublock-resources-json";

export type ListFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

async function getText(fetchImpl: ListFetch, url: string): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

/** The newest revision of each list, in order. */
export function latestRevisions(fetchImpl: ListFetch, names: readonly string[]): Promise<string[]> {
  return Promise.all(names.map(async (name) => latestFilterListRevision(await getText(fetchImpl, filterListMetadataUrl(name)))));
}

/** One list at one revision. An empty answer is a failure: an engine built from it would block nothing. */
export async function downloadList(fetchImpl: ListFetch, name: string, revision: string): Promise<string> {
  const text = await getText(fetchImpl, filterListUrl(name, revision));
  if (text.trim() === "") throw new Error(`${name}: empty list`);
  return text;
}
