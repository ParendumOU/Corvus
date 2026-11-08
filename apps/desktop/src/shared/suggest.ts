/** Omnibox suggestions: the typed intent first, then ranked history and bookmark matches. */
import type { Bookmark, HistoryEntry } from "@corvus/shared";
import { classifyOmnibox, intentToUrl } from "./omnibox";
import { matchSiteSearch, type SiteSearch } from "./site-search";

export interface Suggestion {
  kind: "search" | "url" | "history" | "bookmark";
  title: string;
  url: string;
  /** Text shown in the secondary column (usually the URL). */
  detail?: string;
  /** The browser a history page is only known from ("chrome"), read live from its history. */
  source?: string;
  /** That browser's own icon on this computer (a PNG data URL); without it, its letter mark shows. */
  sourceIcon?: string;
  /**
   * Inline autocomplete: the rest of this page's address after the typed text, which the address bar
   * fills in selected. Only on the first row, which then goes before the typed intent.
   */
  inline?: string;
}

type SuggestHistory = HistoryEntry & { source?: string; typedCount?: number };

const DAY = 86_400_000;

function strip(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "");
}

const pageKey = (url: string): string => strip(url).replace(/\/$/, "");

function score(input: string, title: string, url: string, visitCount: number, visitedAt: number, isBookmark: boolean, now: number): number {
  const u = strip(url).toLowerCase();
  const t = title.toLowerCase();
  const terms = input.split(/\s+/).filter(Boolean);
  if (!terms.every((term) => u.includes(term) || t.includes(term))) return 0;
  let s = 1;
  if (u.startsWith(input)) s += 60;
  else if (u.includes(`.${input}`) || u.includes(`/${input}`)) s += 20;
  if (t.startsWith(input)) s += 25;
  else if (t.split(/\W+/).some((w) => w.startsWith(terms[0] ?? ""))) s += 10;
  if (isBookmark) s += 25;
  s += Math.log2(visitCount + 1) * 8;
  const age = now - visitedAt;
  if (age < DAY) s += 12;
  else if (age < 7 * DAY) s += 6;
  return s;
}

/** How much a visit counts by its age: recent ones most. */
function recencyWeight(age: number): number {
  if (age < 4 * DAY) return 100;
  if (age < 14 * DAY) return 70;
  if (age < 31 * DAY) return 50;
  if (age < 90 * DAY) return 30;
  return 10;
}

/** A page's frecency: its visits weighed by how recent the last one is, each address typed in the address bar counting as four more. */
export function frecency(visitCount: number, typedCount: number, visitedAt: number, now: number): number {
  return recencyWeight(now - visitedAt) * (visitCount + 4 * typedCount);
}

/** What a bookmark adds to its page's frecency: as much as an address typed four times a month ago. */
const BOOKMARK_FRECENCY = 200;

/** An http(s) page address as the address bar shows it: host without "www." and the rest after it ("" for the root). */
interface Address {
  scheme: string;
  www: boolean;
  host: string;
  tail: string;
}

function addressOf(url: string): Address | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
  const www = u.host.startsWith("www.");
  const tail = u.pathname === "/" && !u.search && !u.hash ? "" : `${u.pathname}${u.search}${u.hash}`;
  return { scheme: u.protocol.slice(0, -1), www, host: www ? u.host.slice(4) : u.host, tail };
}

/** The site of an http(s) address as inline autocomplete matches it (host and port, without "www."), or null. */
export function addressSite(url: string): string | null {
  return addressOf(url)?.host ?? null;
}

/** A page history or bookmarks know, with what inline autocomplete ranks it by. */
interface Known {
  url: string;
  address: Address;
  title: string;
  kind: "history" | "bookmark";
  source?: string;
  visits: number;
  typed: number;
  bookmarked: boolean;
  frecency: number;
}

/** The pages whose address, minus scheme and "www.", starts with `body` (lower case). */
function knownPages(body: string, history: readonly SuggestHistory[], bookmarks: readonly Bookmark[], now: number): Known[] {
  // Checked on the raw address first: parsing every page of a long history on each key press would lag.
  const starts = (url: string): boolean => strip(url).toLowerCase().startsWith(body);
  const pages = new Map<string, Known>();
  for (const h of history) {
    if (!starts(h.url)) continue;
    const address = addressOf(h.url);
    if (!address) continue;
    const typed = h.typedCount ?? 0;
    pages.set(h.url, {
      url: h.url,
      address,
      title: h.title,
      kind: "history",
      ...(h.source ? { source: h.source } : {}),
      visits: h.visitCount,
      typed,
      bookmarked: false,
      frecency: frecency(h.visitCount, typed, h.visitedAt, now),
    });
  }
  for (const b of bookmarks) {
    if (b.kind !== "bookmark" || !b.url || !starts(b.url)) continue;
    const address = addressOf(b.url);
    if (!address) continue;
    const page = pages.get(b.url);
    pages.set(b.url, {
      ...(page ?? { url: b.url, address, visits: 0, typed: 0, frecency: 0 }),
      title: b.title || page?.title || b.url,
      kind: "bookmark",
      bookmarked: true,
      frecency: (page?.frecency ?? 0) + BOOKMARK_FRECENCY,
    });
  }
  return [...pages.values()];
}

/** Inline autocomplete fills in only what the person typed, bookmarked or went back to: one visit through a link is not enough. */
const trusted = (p: { typed: number; bookmarked: boolean; visits: number }): boolean => p.typed > 0 || p.bookmarked || p.visits >= 2;

interface Candidate {
  /** The address as the field shows it, minus scheme and "www." ("edge.example.com", "edge.example.com/login"). */
  text: string;
  frecency: number;
  row: Suggestion;
}

/** The most frecent candidate; on a tie the shorter address, then the first in alphabetical order. */
function best(candidates: readonly Candidate[]): Candidate | null {
  let top: Candidate | null = null;
  for (const c of candidates) {
    if (!top || c.frecency > top.frecency || (c.frecency === top.frecency && (c.text.length < top.text.length || (c.text.length === top.text.length && c.text < top.text)))) top = c;
  }
  return top;
}

function rowOf(page: Known): Suggestion {
  return { kind: page.kind, title: page.title || page.url, url: page.url, detail: strip(page.url), ...(page.source ? { source: page.source } : {}) };
}

const byFrecency = (a: Known, b: Known): number => b.frecency - a.frecency;

/**
 * The address the typed text is the start of, for the address bar to fill in (Chrome's inline
 * autocomplete), or null. The text must begin a known page's address, scheme and "www." left out
 * unless typed. While it has no "/" it completes to a site's root ("edge" fills in
 * "edge.example.com", even when only deeper pages were visited), the site whose pages add up to the
 * most frecency; after a "/" it completes to the page with the most.
 */
export function inlineMatch(input: string, history: readonly SuggestHistory[], bookmarks: readonly Bookmark[], now: number): Suggestion | null {
  if (/\s/.test(input)) return null;
  const prefix = /^(?:(https?):\/\/)?(www\.)?/i.exec(input)?.[0] ?? "";
  const scheme = /^https?(?=:)/i.exec(prefix)?.[0].toLowerCase();
  const www = /www\.$/i.test(prefix);
  const body = input.slice(prefix.length).toLowerCase();
  if (!body) return null;
  const pages = knownPages(body, history, bookmarks, now).filter((p) => (!scheme || p.address.scheme === scheme) && (!www || p.address.www));

  let found: Candidate | null;
  if (body.includes("/")) {
    found = best(
      pages.flatMap((p) => {
        const text = p.address.host + p.address.tail;
        return trusted(p) && text.length > body.length && text.toLowerCase().startsWith(body) ? [{ text, frecency: p.frecency, row: rowOf(p) }] : [];
      }),
    );
  } else {
    const sites = new Map<string, Known[]>();
    for (const p of pages) {
      if (p.address.host.startsWith(body)) sites.set(p.address.host, [...(sites.get(p.address.host) ?? []), p]);
    }
    // The person typed a whole site they know: nothing to fill in.
    if (sites.has(body)) return null;
    found = best(
      [...sites].flatMap(([host, site]): Candidate[] => {
        const sum = site.reduce((s, p) => ({ typed: s.typed + p.typed, bookmarked: s.bookmarked || p.bookmarked, visits: s.visits + p.visits }), { typed: 0, bookmarked: false, visits: 0 });
        const top = [...site].sort(byFrecency)[0];
        if (!top || !trusted(sum)) return [];
        const siteFrecency = site.reduce((s, p) => s + p.frecency, 0);
        const root = site.filter((p) => p.address.tail === "").sort(byFrecency)[0];
        // Only deeper pages known: the site's root on the scheme its best page uses.
        const row: Suggestion = root ? rowOf(root) : { kind: "url", title: host, url: `${top.address.scheme}://${top.address.www ? "www." : ""}${host}/` };
        return [{ text: host, frecency: siteFrecency, row }];
      }),
    );
  }
  return found ? { ...found.row, inline: found.text.slice(body.length) } : null;
}

/** The suggestions as they are without inline autocomplete: the typed intent first, the page it would have filled in second. */
export function withoutInline(list: readonly Suggestion[]): Suggestion[] {
  const [first, second, ...rest] = list;
  if (first?.inline === undefined || !second) return [...list];
  const page = { ...first };
  delete page.inline;
  return [second, page, ...rest];
}

/**
 * Typing on along the address the field filled in keeps the rest of it filled in until new
 * suggestions arrive: the new field value, or null when the text no longer begins that address.
 */
export function keepCompletion(fill: string | undefined, text: string): string | null {
  if (!fill || text.length >= fill.length || !fill.toLowerCase().startsWith(text.toLowerCase())) return null;
  return text + fill.slice(text.length);
}

export function buildSuggestions(
  rawInput: string,
  history: readonly SuggestHistory[],
  bookmarks: readonly Bookmark[],
  now: number,
  shortcuts: readonly SiteSearch[] = [],
  options: { inline?: boolean; limit?: number } = {},
): Suggestion[] {
  const input = rawInput.trim();
  if (input.length === 0) return [];
  const lower = input.toLowerCase();
  const intent = classifyOmnibox(input);
  // A search shortcut's keyword first ("yt cats") searches that site.
  const site = matchSiteSearch(input, shortcuts);
  const typedIntent: Suggestion = site
    ? { kind: "search", title: site.terms, url: site.url, detail: `Search ${site.shortcut.name}` }
    : intent.kind === "url"
      ? { kind: "url", title: intent.url, url: intent.url, detail: "Open address" }
      : { kind: "search", title: intent.query, url: intentToUrl(intent), detail: "Search with Corvus AI" };
  // With inline autocomplete the page the address bar fills in goes first, as in Chrome and Brave.
  const filled = options.inline && rawInput === input ? inlineMatch(input, history, bookmarks, now) : null;
  const top = filled ? [filled, typedIntent] : [typedIntent];
  const taken = new Set(top.map((s) => pageKey(s.url)));

  const scored = new Map<string, { s: Suggestion; score: number }>();
  const offer = (s: Suggestion, value: number): void => {
    const key = pageKey(s.url);
    if (value <= 0 || taken.has(key)) return;
    const current = scored.get(key);
    if (!current || current.score < value) scored.set(key, { s, score: value });
  };

  for (const b of bookmarks) {
    if (b.kind !== "bookmark" || !b.url) continue;
    offer({ kind: "bookmark", title: b.title || b.url, url: b.url, detail: strip(b.url) }, score(lower, b.title, b.url, 0, b.updatedAt, true, now));
  }
  for (const h of history) {
    offer(
      { kind: "history", title: h.title || h.url, url: h.url, detail: strip(h.url), ...(h.source ? { source: h.source } : {}) },
      score(lower, h.title, h.url, h.visitCount, h.visitedAt, false, now),
    );
  }

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score).map((x) => x.s);
  return [...top, ...ranked].slice(0, options.limit ?? 7);
}
