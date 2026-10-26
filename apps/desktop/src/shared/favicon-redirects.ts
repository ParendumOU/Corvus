/**
 * Site icons for pages that lead to another site. A bookmark whose address redirects elsewhere (an
 * old domain, a short link) shows the icon of the page it ends on, not a letter: the main process
 * follows each tab's navigation through its redirects (RedirectChain), and fetches a bookmark never
 * opened to see where it goes (pageIconLinks reads the icon its final page names). Pure, so they
 * are unit tested; main/favicon-cache.ts keeps the result.
 */
import { faviconOrigin, isFaviconUrl } from "./favicon";

/**
 * The page an icon is remembered for when it leads to another site: web pages only, without the
 * #fragment (never sent to the site) or a trailing slash, so "https://a.test" and "https://a.test/"
 * are one bookmark.
 */
export function faviconPageKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** The keys of every bookmark in a list (folders have no address). */
export function bookmarkPageKeys(list: ReadonlyArray<{ kind: string; url?: string }>): Set<string> {
  const keys = new Set<string>();
  for (const b of list) {
    const key = b.kind === "bookmark" && b.url ? faviconPageKey(b.url) : null;
    if (key) keys.add(key);
  }
  return keys;
}

export interface RedirectIcons {
  /** The site the navigation ended on. */
  to: string;
  /** Pages it went through on other sites: they show `to`'s icon from now on. */
  from: string[];
  /** Pages on `to` itself, the final one included: they show their own site's icon again. */
  same: string[];
}

/** What a navigation through `chain` (oldest first, ending on the page that opened) says about icons. */
export function redirectIcons(chain: readonly string[]): RedirectIcons | null {
  const final = chain[chain.length - 1];
  const to = final === undefined ? null : faviconOrigin(final);
  if (!to) return null;
  const from: string[] = [];
  const same: string[] = [];
  for (const url of chain) {
    const key = faviconPageKey(url);
    if (!key) continue;
    const list = faviconOrigin(url) === to ? same : from;
    if (!list.includes(key)) list.push(key);
  }
  return { to, from, same };
}

/** Most pages one navigation is followed through (Chromium itself gives up after 20 redirects). */
const MAX_CHAIN = 20;
/** How long after a page opens it may still send the tab on by itself as a redirect (meta refresh, location.replace). */
export const CLIENT_REDIRECT_MS = 10_000;
/** ...and once it finished loading, how much longer. */
export const CLIENT_REDIRECT_AFTER_LOAD_MS = 3_000;

/** Input that means the person moved the tab on, not the page (Electron's input-event types). */
const PERSON_INPUT = new Set(["mouseDown", "rawKeyDown", "keyDown", "touchStart", "gestureTap"]);

export function isPersonInput(type: string): boolean {
  return PERSON_INPUT.has(type);
}

/**
 * The pages one tab's navigation goes through before a page stays open: the address it started
 * from, each server redirect, and the pages that sent it on by themselves right after they opened
 * (a meta refresh or a script, with no click or key press of the person's in between).
 */
export class RedirectChain {
  private urls: string[] = [];
  /** Until when a navigation the page starts continues this chain (0: it would start a new one). */
  private openUntil = 0;

  /**
   * A navigation to a new document starts in the main frame. `byPage`: the page started it (a link,
   * a script, a meta refresh), not Corvus (an address typed or a bookmark opened, Back, Reload).
   */
  start(url: string, byPage: boolean, now: number): void {
    const continues = byPage && this.urls.length > 0 && now <= this.openUntil;
    this.urls = continues ? [...this.urls, url].slice(-MAX_CHAIN) : [url];
    this.openUntil = 0;
  }

  /** The server sent it on to `url`. */
  redirect(url: string): void {
    if (this.urls.length > 0) this.urls = [...this.urls, url].slice(-MAX_CHAIN);
  }

  /** It opened `url`: the pages it went through, oldest first, ending with `url`. */
  commit(url: string, now: number): string[] {
    // A page that opened without its start being seen (or another one's) is a chain of its own.
    if (this.urls[this.urls.length - 1] !== url) this.urls = [url];
    this.openUntil = now + CLIENT_REDIRECT_MS;
    return [...this.urls];
  }

  /** The page finished loading: it has a little longer to send the tab on by itself. */
  loaded(now: number): void {
    if (this.openUntil > 0) this.openUntil = Math.min(this.openUntil, now + CLIENT_REDIRECT_AFTER_LOAD_MS);
  }

  /** The person clicked or typed in the page: where it goes next is their doing, not a redirect. */
  interrupt(): void {
    this.openUntil = 0;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  // Skip the tag name itself ("<link", "<base").
  for (const m of tag.replace(/^<\s*[a-z]+/i, "").matchAll(ATTRIBUTE)) {
    const name = m[1]!.toLowerCase();
    if (!found.has(name)) found.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return found;
}

/** Longest stretch of a page read for its icons (they are named in its <head>). */
const MAX_HTML_SCANNED = 512 * 1024;

/**
 * The icons a page names (<link rel="icon">, "shortcut icon"), in its order, as absolute web or
 * data: addresses, resolved against its <base href> if it has one. Touch and mask icons are not
 * favicons, and links in comments or scripts do not count.
 */
export function pageIconLinks(html: string, pageUrl: string): string[] {
  const text = html
    .slice(0, MAX_HTML_SCANNED)
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/<(script|style|template)\b[\s\S]*?(<\/\1\s*>|$)/gi, "");
  let base = pageUrl;
  const baseTag = /<base\b[^>]*>/i.exec(text);
  const baseHref = baseTag ? attributes(baseTag[0]).get("href")?.trim() : undefined;
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      // An unusable <base>: links resolve against the page.
    }
  }
  const icons: string[] = [];
  for (const tag of text.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (!(attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("icon")) continue;
    const href = attrs.get("href")?.trim();
    if (!href) continue;
    let icon: string;
    try {
      icon = new URL(href, base).href;
    } catch {
      continue;
    }
    if (isFaviconUrl(icon) && !icons.includes(icon)) icons.push(icon);
  }
  return icons;
}
