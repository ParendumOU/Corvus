import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { faviconOrigin, sniffImageType } from "../shared/favicon";
import { faviconPageKey, pageIconLinks, redirectIcons } from "../shared/favicon-redirects";
import { JsonFile } from "./json-file";

export interface CachedIcon {
  type: string;
  body: Buffer;
}

/** Largest icon kept: real favicons are a few KB; anything bigger is not one. */
const MAX_ICON_BYTES = 100 * 1024;
/** An icon remembered from a page is fetched again after this long. */
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** A site whose icon could not be found is asked again after this long (within one run). */
const MISS_RETRY_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
/** Most pages remembered as leading to another site; the least recently seen go first. */
const MAX_REDIRECTS = 5000;
/** Bookmark pages fetched at the same time to see where they lead. */
const PAGES_AT_ONCE = 4;
/** Icons a fetched page names that are tried before its site's /favicon.ico. */
const PAGE_ICONS_TRIED = 3;

export type IconFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A page fetched for its icon: the address it ended on after its redirects, and the start of its HTML. */
export interface ProbedPage {
  url: string;
  html: string | null;
}

export type PageProbe = (url: string) => Promise<ProbedPage | null>;

export interface FaviconCacheOptions {
  /** Fetches a page, following its redirects, through the profile's session and without cookies. */
  probe?: PageProbe;
  /** The pages worth that fetch (bookmarks), never just any address the UI shows an icon for. */
  probes?: (pageUrl: string) => boolean;
}

/** A page seen leading to another site (`to`, an origin), and when. */
interface Redirect {
  to: string;
  at: number;
}

function reviveRedirects(raw: unknown): Record<string, Redirect> {
  const out: Record<string, Redirect> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const r = value as Partial<Redirect> | null;
    if (/^[0-9a-f]{40}$/.test(id) && typeof r?.to === "string" && faviconOrigin(r.to) === r.to && typeof r.at === "number") out[id] = { to: r.to, at: r.at };
  }
  return out;
}

const sha1 = (text: string): string => crypto.createHash("sha1").update(text).digest("hex");

/**
 * Favicons of one profile, by site (origin), kept on disk: the icon of each page the person opens
 * in a tab, and on demand the icon of a bookmark never opened in Corvus. Fetched through the
 * profile's own session (its proxy and settings), and served to Corvus's UI as corvus://favicon/...
 * (main/protocol.ts), so the UI never reaches out to sites itself.
 *
 * A bookmark that leads to another site (an old domain, a short link) shows the icon of the page it
 * ends on: a tab that goes through it records where it led (navigated), and a bookmark never opened
 * is fetched, following its redirects, to find out. Those pages are kept as hashes in
 * redirects.json, each with the site it leads to.
 */
export class FaviconCache {
  private readonly memory = new Map<string, CachedIcon>();
  private readonly misses = new Map<string, number>();
  private readonly pending = new Map<string, Promise<CachedIcon | null>>();
  /** When each site's icon was last saved or read back, so a page load does not touch the disk. */
  private readonly fresh = new Map<string, number>();
  /** Sites a bookmark asked for in vain: once one has an icon, the UI asks again. */
  private readonly wanted = new Set<string>();
  private redirectFile: JsonFile<Record<string, Redirect>> | null = null;
  private readonly listeners = new Set<() => void>();
  private fetchingPages = 0;
  private readonly waitingPages: Array<() => void> = [];
  /** Goes up whenever a bookmark may show another icon than it did; the UI then asks again. */
  revision = 0;

  constructor(
    private readonly dir: string,
    private readonly fetcher: IconFetch,
    private readonly options: FaviconCacheOptions = {},
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  private file(origin: string): string {
    return path.join(this.dir, sha1(origin));
  }

  private async download(url: string, fetcher: IconFetch = this.fetcher): Promise<CachedIcon | null> {
    if (url.startsWith("data:")) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
      if (!m) return null;
      let body: Buffer;
      try {
        body = m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!), "utf8");
      } catch {
        return null;
      }
      const type = sniffImageType(body);
      return type && body.length <= MAX_ICON_BYTES ? { type, body } : null;
    }
    if (!/^https?:/i.test(url)) return null;
    try {
      // No cookies: an icon is the same for everyone.
      const res = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), credentials: "omit" });
      if (!res.ok) return null;
      const body = Buffer.from(await res.arrayBuffer());
      const type = sniffImageType(body);
      return type && body.length > 0 && body.length <= MAX_ICON_BYTES ? { type, body } : null;
    } catch {
      return null;
    }
  }

  private store(origin: string, icon: CachedIcon): void {
    this.memory.set(origin, icon);
    this.misses.delete(origin);
    this.fresh.set(origin, Date.now());
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file(origin), Buffer.concat([Buffer.from(`${icon.type}\n`), icon.body]));
    } catch {
      // A read-only or full disk: the icon stays in memory for this run.
    }
    if (this.wanted.delete(origin)) this.changed();
  }

  private fromDisk(origin: string): { icon: CachedIcon; at: number } | null {
    try {
      const file = this.file(origin);
      const raw = fs.readFileSync(file);
      const nl = raw.indexOf(10);
      if (nl <= 0) return null;
      return { icon: { type: raw.subarray(0, nl).toString("utf8"), body: raw.subarray(nl + 1) }, at: fs.statSync(file).mtimeMs };
    } catch {
      return null;
    }
  }

  /** The icon kept for a site, from memory or disk. */
  private known(origin: string): CachedIcon | null {
    const kept = this.memory.get(origin);
    if (kept) return kept;
    const disk = this.fromDisk(origin);
    if (!disk) return null;
    this.memory.set(origin, disk.icon);
    this.fresh.set(origin, disk.at);
    return disk.icon;
  }

  /** The first of `urls` that is an icon, kept for `origin`. */
  private async fetchIcon(origin: string, urls: readonly string[]): Promise<CachedIcon | null> {
    for (const url of urls) {
      const icon = await this.download(url);
      if (icon) {
        this.store(origin, icon);
        return icon;
      }
    }
    return null;
  }

  private redirects(): JsonFile<Record<string, Redirect>> {
    // Written at once: it changes rarely (a bookmark found to lead elsewhere), and must survive a quit.
    this.redirectFile ??= JsonFile.load(path.join(this.dir, "redirects.json"), () => ({}), reviveRedirects, 0);
    return this.redirectFile;
  }

  /** The site a page leads to, when it was seen leading to another one. */
  private redirectOf(pageKey: string): string | undefined {
    return this.redirects().get()[sha1(pageKey)]?.to;
  }

  private setRedirect(pageKey: string, to: string): boolean {
    const id = sha1(pageKey);
    const file = this.redirects();
    const current = file.get();
    if (current[id]?.to === to) return false;
    let next: Record<string, Redirect> = { ...current, [id]: { to, at: Date.now() } };
    const ids = Object.keys(next);
    if (ids.length > MAX_REDIRECTS) {
      const keep = new Set(ids.sort((a, b) => next[b]!.at - next[a]!.at).slice(0, MAX_REDIRECTS));
      next = Object.fromEntries(Object.entries(next).filter(([k]) => keep.has(k)));
    }
    try {
      file.set(next);
    } catch {
      // A read-only or full disk: it stays in memory for this run.
    }
    return true;
  }

  private dropRedirect(pageKey: string): boolean {
    const id = sha1(pageKey);
    const file = this.redirects();
    const current = file.get();
    if (!current[id]) return false;
    try {
      file.set(Object.fromEntries(Object.entries(current).filter(([k]) => k !== id)));
    } catch {
      // As above.
    }
    return true;
  }

  /**
   * A tab's navigation went through `chain` (oldest first) and opened its last page. The pages of it
   * on other sites that `remembers` (bookmarks, by faviconPageKey) show the icon of the final page's
   * site from now on; pages on that site, the final one included, show their own site's again.
   */
  navigated(chain: readonly string[], remembers: (pageKey: string) => boolean): void {
    const plan = redirectIcons(chain);
    if (!plan) return;
    let changed = false;
    for (const key of plan.same) if (this.dropRedirect(key)) changed = true;
    for (const key of plan.from) if (remembers(key) && this.setRedirect(key, plan.to)) changed = true;
    if (changed) this.changed();
  }

  /**
   * A page showed this icon: keep it for its site (unless kept recently). `fetcher` is the tab's own
   * session (a container's or a private window's proxy), which also has the icon in its cache.
   */
  remember(pageUrl: string, iconUrl: string, fetcher: IconFetch = this.fetcher): void {
    const origin = faviconOrigin(pageUrl);
    if (!origin || this.pending.has(origin)) return;
    if (!this.fresh.has(origin)) {
      const disk = this.fromDisk(origin);
      if (disk) {
        this.memory.set(origin, disk.icon);
        this.fresh.set(origin, disk.at);
      } else this.fresh.set(origin, 0);
    }
    if (Date.now() - (this.fresh.get(origin) ?? 0) < REFRESH_MS) return;
    const job = this.download(iconUrl, fetcher).then((icon) => {
      if (icon) this.store(origin, icon);
      return icon;
    });
    this.pending.set(origin, job);
    void job.finally(() => this.pending.delete(origin));
  }

  /**
   * The icon to show for `pageUrl`: its site's, or that of the site it leads to. Not kept yet, it is
   * fetched: a bookmark's page, following its redirects, for the icon its final page names (else that
   * site's /favicon.ico); any other address, its site's /favicon.ico.
   */
  async icon(pageUrl: string): Promise<CachedIcon | null> {
    const key = faviconPageKey(pageUrl);
    const redirected = key ? this.redirectOf(key) : undefined;
    const origin = redirected ?? faviconOrigin(pageUrl);
    if (!origin) return null;
    const known = this.known(origin);
    if (known) return known;
    const bookmark = this.options.probes?.(pageUrl) === true;
    const probe = !redirected && key && bookmark ? this.options.probe : undefined;
    const job = probe && key ? `page ${key}` : origin;
    // An icon on its way (a page just showed it) beats an earlier miss.
    const running = this.pending.get(job);
    if (running) return running;
    const missed = this.misses.get(job);
    if (missed !== undefined && Date.now() - missed < MISS_RETRY_MS) {
      if (bookmark) this.wanted.add(origin);
      return null;
    }
    const work = probe && key ? this.fromPage(pageUrl, key, origin, probe) : this.fetchIcon(origin, [`${origin}/favicon.ico`]).then((icon) => ({ icon, site: origin }));
    const done = work.then(({ icon, site }) => {
      if (!icon) {
        this.misses.set(job, Date.now());
        // The site the page led to was asked too: not again for a while.
        this.misses.set(site, Date.now());
        if (bookmark) this.wanted.add(site);
      }
      return icon;
    });
    this.pending.set(job, done);
    void done.finally(() => this.pending.delete(job));
    return done;
  }

  /**
   * A bookmark never opened (or not since it started to redirect): its page, fetched and followed to
   * where it ends, gives the site and the icon. If it cannot be fetched, its own site's /favicon.ico.
   */
  private async fromPage(pageUrl: string, key: string, origin: string, probe: PageProbe): Promise<{ icon: CachedIcon | null; site: string }> {
    const page = await this.onePageAtATime(() => probe(pageUrl).catch(() => null));
    if (!page) return { icon: await this.fetchIcon(origin, [`${origin}/favicon.ico`]), site: origin };
    const site = faviconOrigin(page.url) ?? origin;
    // No need to tell the UI: whoever asks gets this lookup's answer.
    if (site !== origin) this.setRedirect(key, site);
    const known = this.known(site);
    if (known) return { icon: known, site };
    const named = page.html ? pageIconLinks(page.html, page.url).slice(0, PAGE_ICONS_TRIED) : [];
    return { icon: await this.fetchIcon(site, [...named, `${site}/favicon.ico`]), site };
  }

  /** Runs a page fetch once fewer than PAGES_AT_ONCE are under way (a large bookmarks folder opening). */
  private async onePageAtATime<T>(run: () => Promise<T>): Promise<T> {
    while (this.fetchingPages >= PAGES_AT_ONCE) await new Promise<void>((resolve) => this.waitingPages.push(resolve));
    this.fetchingPages++;
    try {
      return await run();
    } finally {
      this.fetchingPages--;
      this.waitingPages.shift()?.();
    }
  }
}
