/**
 * Where the desktop and the phone get their ad and tracker filter lists: Ghostery's CDN, which
 * republishes uBlock Origin's, EasyList's and Peter Lowe's lists every day. Each list has a
 * metadata.json naming its revisions, and each revision an immutable file.
 */
const CDN = "https://cdn.ghostery.com/adblocker/resources";

export function filterListMetadataUrl(name: string): string {
  return `${CDN}/${name}/metadata.json`;
}

export function filterListUrl(name: string, revision: string): string {
  return `${CDN}/${name}/${revision}/list.txt`;
}

/** The newest revision named by a list's metadata.json; it becomes part of an address, so it is checked. */
export function latestFilterListRevision(metadata: string): string {
  const revisions = (JSON.parse(metadata) as { revisions?: unknown }).revisions;
  const latest = Array.isArray(revisions) ? revisions[revisions.length - 1] : undefined;
  if (typeof latest !== "string" || !/^[0-9a-f]{16,128}$/i.test(latest)) throw new Error("no valid revision in the list metadata");
  return latest;
}

/** The lists move daily: a week without a new one means the updates have stopped, whatever the reason. */
const FILTER_LISTS_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether lists last updated at `updatedAt` have gone stale; never-updated lists have their own message. */
export function filterListsStale(updatedAt: number | null, now: number): boolean {
  return updatedAt !== null && now - updatedAt > FILTER_LISTS_STALE_MS;
}

/** Whole days since the lists were last updated, for the warning. */
export function filterListsAgeDays(updatedAt: number, now: number): number {
  return Math.floor((now - updatedAt) / (24 * 60 * 60 * 1000));
}
