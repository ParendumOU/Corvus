import { defaultLookup, type LookupLike, resolvesToPublic } from "./deep.js";
import { type FetchLike, fetchWithTimeout, USER_AGENT } from "./http.js";

export interface FaviconFetchOptions {
  fetch?: FetchLike;
  lookup?: LookupLike;
  timeoutMs?: number; // default 2500
  maxBytes?: number; // default 32 KB
  signal?: AbortSignal;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const MAX_REDIRECTS = 3;

/**
 * Fetches https://<domain>/favicon.ico without cookies and returns it as a data: URL, or null.
 * Same public-address check as deep mode on every redirect hop; images only, size-capped.
 */
export async function fetchFavicon(domain: string, opts: FaviconFetchOptions = {}): Promise<string | null> {
  if (!DOMAIN.test(domain)) return null;
  const fetchImpl = opts.fetch ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;
  const maxBytes = opts.maxBytes ?? 32 * 1024;
  try {
    let url = `https://${domain}/favicon.ico`;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await resolvesToPublic(url, lookup))) return null;
      const res = await fetchWithTimeout(
        fetchImpl,
        url,
        { headers: { "User-Agent": USER_AGENT, Accept: "image/*" }, redirect: "manual", credentials: "omit" },
        opts.timeoutMs ?? 2500,
        opts.signal,
      );
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        await res.body?.cancel();
        url = new URL(location, url).toString();
        continue;
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const declared = Number(res.headers.get("content-length"));
      if (!res.ok || declared > maxBytes || !/^image\/(x-icon|vnd\.microsoft\.icon|png|gif|jpeg|webp|svg\+xml)$/.test(type)) {
        await res.body?.cancel();
        return null;
      }
      const body = new Uint8Array(await res.arrayBuffer());
      if (!body.byteLength || body.byteLength > maxBytes) return null;
      return `data:${type};base64,${Buffer.from(body).toString("base64")}`;
    }
    return null;
  } catch {
    return null;
  }
}
