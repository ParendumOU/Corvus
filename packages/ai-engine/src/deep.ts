import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import type { SearchResult } from "@corvus/shared";
import { parseHTML } from "linkedom";
import { type FetchLike, fetchWithTimeout, readTextCapped, USER_AGENT } from "./http.js";
import { EXCERPT_MAX_CHARS, type PageExtract } from "./prompt.js";
import { cleanText, truncate } from "./text.js";

/** Resolves a hostname to all of its IP addresses. */
export type LookupLike = (hostname: string) => Promise<string[]>;

export const defaultLookup: LookupLike = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

const MAX_REDIRECTS = 5;

export interface DeepFetchOptions {
  fetch?: FetchLike;
  /** DNS resolver used to refuse hostnames that point at private addresses. */
  lookup?: LookupLike;
  /** Pages to read, from the top of the results. Default 3. */
  count?: number;
  timeoutMs?: number; // default 4000
  maxBytes?: number; // default 1.5 MB
  maxChars?: number; // default 1500
  signal?: AbortSignal;
}

/** textContent glues adjacent blocks together ("menuShort page"); tags become spaces instead. */
function htmlToText(html: string): string {
  return cleanText(html.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " "));
}

/** Readability extraction; falls back to <body> text for pages Readability rejects. */
export function extractReadableText(html: string): string {
  const { document } = parseHTML(html);
  let content = "";
  try {
    content = new Readability(document as never, { charThreshold: 200 }).parse()?.content ?? "";
  } catch {
    content = "";
  }
  if (!htmlToText(content)) {
    const { document: fresh } = parseHTML(html);
    for (const el of fresh.querySelectorAll("script, style, noscript, nav, header, footer, aside")) el.remove();
    content = fresh.body?.innerHTML ?? "";
  }
  return htmlToText(content);
}

function isPrivateIPv4(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/** IPv4 embedded in an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:7f00:1), if any. */
function mappedIPv4(ip: string): string | undefined {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m?.[1]) return undefined;
  if (isIP(m[1]) === 4) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]);
  if (!hex?.[1] || !hex[2]) return undefined;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version !== 6) return true; // not an IP: refuse rather than guess
  const lower = ip.toLowerCase();
  const v4 = mappedIPv4(lower);
  if (v4) return isPrivateIPv4(v4);
  return (
    lower === "::" ||
    lower === "::1" ||
    /^f[cd]/.test(lower) || // unique local fc00::/7
    /^fe[89ab]/.test(lower) || // link-local fe80::/10
    /^ff/.test(lower) // multicast
  );
}

/** Deep mode only reads public http(s) pages; loopback/private literals are never fetched. */
export function isFetchablePublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isIP(host)) return !isPrivateAddress(host);
  return true;
}

/** Checks the URL and, for hostnames, that every resolved address is public (blocks DNS pointing at the LAN). */
export async function resolvesToPublic(raw: string, lookup: LookupLike): Promise<boolean> {
  if (!isFetchablePublicUrl(raw)) return false;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return true;
  try {
    const addresses = await lookup(host);
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a));
  } catch {
    return false;
  }
}

async function fetchPage(
  result: SearchResult,
  index: number,
  opts: Required<Omit<DeepFetchOptions, "signal" | "count">> & { signal?: AbortSignal },
): Promise<PageExtract | undefined> {
  try {
    // Redirects are followed by hand so every hop gets the same public-address check.
    let url = result.url;
    let res: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await resolvesToPublic(url, opts.lookup))) return undefined;
      res = await fetchWithTimeout(
        opts.fetch,
        url,
        { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" }, redirect: "manual" },
        opts.timeoutMs,
        opts.signal,
      );
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      await res.body?.cancel();
      url = new URL(location, url).toString();
      res = undefined;
    }
    if (!res) return undefined;
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/text\/html|application\/xhtml\+xml/i.test(type)) {
      await res.body?.cancel();
      return undefined;
    }
    const html = await readTextCapped(res, opts.maxBytes);
    if (!html) return undefined;
    const text = extractReadableText(html);
    return text ? { index, text: truncate(text, opts.maxChars) } : undefined;
  } catch {
    // Deep mode is best effort: a slow or broken page just means fewer excerpts.
    return undefined;
  }
}

/** Fetches the top pages concurrently and returns the excerpts that could be extracted. */
export async function fetchPageExtracts(results: SearchResult[], opts: DeepFetchOptions = {}): Promise<PageExtract[]> {
  const resolved = {
    fetch: opts.fetch ?? fetch,
    lookup: opts.lookup ?? defaultLookup,
    timeoutMs: opts.timeoutMs ?? 4000,
    maxBytes: opts.maxBytes ?? 1.5 * 1024 * 1024,
    maxChars: opts.maxChars ?? EXCERPT_MAX_CHARS,
    signal: opts.signal,
  };
  const top = results.slice(0, opts.count ?? 3);
  const pages = await Promise.all(top.map((r, i) => fetchPage(r, i, resolved)));
  return pages.filter((p): p is PageExtract => p !== undefined);
}
