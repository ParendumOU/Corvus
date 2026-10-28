/**
 * Where a page's icon comes from on the phone, and the letter its tile shows when it has none.
 * Pure, so it is unit tested; components/favicon.tsx renders it. Icons are only ever asked of the
 * site itself (no third-party icon services).
 */

/** Second-level labels under which country registries sell names: example.co.uk, example.com.au, example.ne.jp. */
const COUNTRY_SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'go', 'gob', 'gov', 'govt', 'lg', 'ltd', 'me', 'mil', 'ne', 'net', 'nhs', 'nic', 'nom', 'or', 'org', 'plc', 'police', 'sch']);

/** Hosting suffixes where each subdomain is someone else's site (alice.github.io is Alice's, not GitHub's). */
const HOSTING_SUFFIXES = new Set(['appspot.com', 'blogspot.com', 'firebaseapp.com', 'github.io', 'gitlab.io', 'herokuapp.com', 'netlify.app', 'pages.dev', 'vercel.app', 'web.app', 'workers.dev']);

function isIpAddress(host: string): boolean {
  return host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * The site a host belongs to, its registrable domain: "wikipedia.org" for en.wikipedia.org,
 * "bbc.co.uk" for www.bbc.co.uk, "alice.github.io" as it is. A small heuristic, not the full Public
 * Suffix List: one label after the public suffix, which is the top-level domain, a country's
 * second level (co.uk, com.au) or a known hosting suffix. IP addresses and single labels stay as they are.
 */
export function siteDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.+$/, '');
  if (!h.includes('.') || isIpAddress(h)) return h;
  const labels = h.split('.');
  const tld = labels[labels.length - 1] ?? '';
  const second = labels[labels.length - 2] ?? '';
  const suffix = HOSTING_SUFFIXES.has(`${second}.${tld}`) || (tld.length === 2 && COUNTRY_SECOND_LEVEL.has(second)) ? 2 : 1;
  return labels.length <= suffix + 1 ? h : labels.slice(-(suffix + 1)).join('.');
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** The site a page is on, for its letter tile's letter and color ("wikipedia.org" for https://en.wikipedia.org/wiki/X); "" when the address has no host. */
export function pageSite(url: string): string {
  return siteDomain(hostname(url));
}

/** The letter on a page's tile: the first letter of its site's name, so "W" for en.wikipedia.org rather than the "E" of its language. */
export function siteInitial(url: string): string {
  const site = pageSite(url);
  const first = [...site].find((ch) => !'.-_[]:'.includes(ch));
  return first ? first.toUpperCase() : '?';
}

/**
 * The icon addresses to try for a page, in order, all on its own site: the classic /favicon.ico,
 * then the PNG icons many sites keep at fixed paths (sites like booking.com have no /favicon.ico),
 * then the main domain's /favicon.ico for a subdomain without icons. No SVG: the native image
 * loader cannot draw it. Empty for addresses that are not web pages.
 */
export function faviconCandidates(url: string): string[] {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return [];
  }
  if ((page.protocol !== 'https:' && page.protocol !== 'http:') || !page.hostname) return [];
  const origin = `${page.protocol}//${page.host}`;
  const out = ['/favicon.ico', '/apple-touch-icon.png', '/favicon.png'].map((path) => `${origin}${path}`);
  const host = page.hostname.toLowerCase();
  const site = siteDomain(host);
  if (site !== host && site.includes('.') && !isIpAddress(host)) out.push(`${page.protocol}//${site}/favicon.ico`);
  return out;
}

/**
 * The User-Agent icon requests carry on Android. React Native's image loader there (Fresco over
 * OkHttp) sets none, so OkHttp's own "okhttp/x.y.z" goes out, and Wikimedia's sites (Wikipedia,
 * Wikivoyage, Commons…) answer 403 to generic HTTP-library agents. It names Corvus, without a fake
 * browser version, in the browser shape some CDNs require (a bot-style "+https://…" one gets 403
 * from Akamai-fronted shops such as zara.com).
 */
export function faviconUserAgent(version: string): string {
  const v = version.replace(/[^0-9A-Za-z.+-]/g, '');
  return `Mozilla/5.0 (Linux; Android) Corvus${v ? `/${v}` : ''}`;
}

interface MemoEntry {
  /** Candidate that loaded (`loaded`), or the next one to try after those that failed. */
  index: number;
  loaded: boolean;
  at: number;
}

/**
 * Which of a site's icon candidates works, remembered for the session, so a list does not ask a
 * site again for icons it does not have each time a row appears. A site where every candidate
 * failed (it has none, or the phone was offline) is asked again after `retryMs`.
 */
export class FaviconMemo {
  private readonly sites = new Map<string, MemoEntry>();

  constructor(
    private readonly retryMs = 10 * 60_000,
    private readonly limit = 1000,
  ) {}

  /** The candidate to show first for `key` (a page origin), out of `count`; `count` means none works, so show the letter. */
  first(key: string, count: number, now = Date.now()): number {
    const entry = this.sites.get(key);
    if (!entry) return 0;
    if (!entry.loaded && entry.index >= count && now - entry.at >= this.retryMs) {
      this.sites.delete(key);
      return 0;
    }
    return Math.min(entry.index, count);
  }

  /** Candidate `index` failed to load or draw: the one to try next (`count` when none is left). */
  failed(key: string, index: number, count: number, now = Date.now()): number {
    const entry = this.sites.get(key);
    // Another tile of the same site already found the one that loads, or got past more failures.
    if (entry?.loaded && entry.index !== index) return Math.min(entry.index, count);
    if (entry && !entry.loaded && entry.index > index) return Math.min(entry.index, count);
    const next = Math.min(index + 1, count);
    this.set(key, { index: next, loaded: false, at: now });
    return next;
  }

  /** Candidate `index` loaded: later tiles of this site start with it. */
  loaded(key: string, index: number, now = Date.now()): void {
    this.set(key, { index, loaded: true, at: now });
  }

  private set(key: string, entry: MemoEntry): void {
    this.sites.delete(key);
    if (this.sites.size >= this.limit) {
      const oldest = this.sites.keys().next().value;
      if (oldest !== undefined) this.sites.delete(oldest);
    }
    this.sites.set(key, entry);
  }
}
