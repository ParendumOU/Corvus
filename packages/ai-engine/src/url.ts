import type { SearchResult } from "@corvus/shared";

const TRACKING_PARAMS = new Set([
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "li_fat_id",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "_ga",
  "_gl",
  "mkt_tok",
  "oly_anon_id",
  "oly_enc_id",
  "vero_id",
  "rb_clickid",
  "s_cid",
  "ref_src",
  "ref_url",
  "spm",
]);

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  return key.startsWith("utm_") || key.startsWith("pk_") || TRACKING_PARAMS.has(key);
}

/** Removes tracking query parameters, keeping the URL otherwise intact. Returns the input if it is not a valid http(s) URL. */
export function stripTracking(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParam(name)) url.searchParams.delete(name);
  }
  return url.toString();
}

/**
 * Canonical key used for deduplication: scheme-insensitive, lowercased host without "www.",
 * no default port, no fragment, no trailing slash, sorted query without tracking params.
 */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "/") path = "";
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return `${host}${port}${path}${query}`;
}

export function domainOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Keeps the first occurrence of each normalized URL and re-ranks 1..n. */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = normalizeUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, rank: out.length + 1 });
  }
  return out;
}
