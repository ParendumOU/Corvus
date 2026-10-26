import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { faviconOrigin, sniffImageType } from "../shared/favicon";

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

export type IconFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Favicons of one profile, by site (origin), kept on disk: the icon of each page the person opens
 * in a tab, and on demand the site's /favicon.ico for a bookmark never opened in Corvus. Fetched
 * through the profile's own session (its proxy and settings), and served to Corvus's UI as
 * corvus://favicon/... (main/protocol.ts), so the UI never reaches out to sites itself.
 */
export class FaviconCache {
  private readonly memory = new Map<string, CachedIcon>();
  private readonly misses = new Map<string, number>();
  private readonly pending = new Map<string, Promise<CachedIcon | null>>();
  /** When each site's icon was last saved or read back, so a page load does not touch the disk. */
  private readonly fresh = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly fetcher: IconFetch,
  ) {}

  private file(origin: string): string {
    return path.join(this.dir, crypto.createHash("sha1").update(origin).digest("hex"));
  }

  private async download(url: string, fetcher: IconFetch = this.fetcher): Promise<CachedIcon | null> {
    if (url.startsWith("data:")) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
      if (!m) return null;
      const body = m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!), "utf8");
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

  /** The icon of the site `pageUrl` is on: kept, or fetched from the site's /favicon.ico. */
  async icon(pageUrl: string): Promise<CachedIcon | null> {
    const origin = faviconOrigin(pageUrl);
    if (!origin) return null;
    const known = this.memory.get(origin);
    if (known) return known;
    const disk = this.fromDisk(origin);
    if (disk) {
      this.memory.set(origin, disk.icon);
      this.fresh.set(origin, disk.at);
      return disk.icon;
    }
    const missed = this.misses.get(origin);
    if (missed !== undefined && Date.now() - missed < MISS_RETRY_MS) return null;
    const running = this.pending.get(origin);
    if (running) return running;
    const job = this.download(`${origin}/favicon.ico`).then((icon) => {
      if (icon) this.store(origin, icon);
      else this.misses.set(origin, Date.now());
      return icon;
    });
    this.pending.set(origin, job);
    void job.finally(() => this.pending.delete(origin));
    return job;
  }
}
