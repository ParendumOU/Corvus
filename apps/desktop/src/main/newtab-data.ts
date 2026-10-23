/**
 * Network reads for the New Tab page, in the main process: the "fetch" and "feed" data sources of
 * custom widgets and the daily wallpapers. No cookies are sent, only public http(s) addresses are
 * fetched, responses are capped and cached.
 */
import { defaultLookup, resolvesToPublic } from "@corvus/ai-engine";
import type { WallpaperSource } from "../shared/newtab";
import type { FeedItem, WallpaperView } from "../shared/newtab-ipc";

const UA = "Corvus/0.4 (+https://corvus.parendum.com)";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;

type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

/** Fetches a public http(s) address and returns its body as text (capped), or throws. */
export async function fetchPublicText(url: string, fetcher: Fetcher = fetch, lookup = defaultLookup): Promise<{ text: string; type: string }> {
  if (!(await resolvesToPublic(url, lookup))) throw new Error("Only public http(s) addresses can be read.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await (fetcher as (u: string, i: RequestInit) => Promise<Response>)(url, {
      headers: { "user-agent": UA, accept: "application/json, application/xml, text/xml, text/plain, */*" },
      signal: controller.signal,
      credentials: "omit",
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) return { text: await res.text(), type: res.headers.get("content-type") ?? "" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error("Response too large");
      }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString("utf8"), type: res.headers.get("content-type") ?? "" };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, fetcher?: Fetcher): Promise<unknown> {
  return JSON.parse((await fetchPublicText(url, fetcher)).text);
}

// ------------------------------------------------------------------------------- small cache

const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}

// ------------------------------------------------------------------------------- feeds

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeText(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const value = cdata ? cdata[1]! : raw;
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? m[1]! : null;
}

/** Items of an RSS 2.0, RSS 1.0 or Atom document, newest first as the feed lists them. */
export function parseFeed(xml: string, feedUrl: string): FeedItem[] {
  const channelTitle = decodeText(tag(xml.replace(/<(item|entry)[\s>][\s\S]*$/i, ""), "title") ?? "") || new URL(feedUrl).hostname;
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = decodeText(tag(block, "title") ?? "");
    const href = /<link[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(block)?.[1] ?? decodeText(tag(block, "link") ?? "");
    if (!href) continue;
    let url: string;
    try {
      url = new URL(href, feedUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(url) || !title) continue;
    const date = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated") ?? tag(block, "dc:date");
    const at = date ? Date.parse(decodeText(date)) : NaN;
    items.push({ title, url, source: channelTitle, at: Number.isFinite(at) ? at : null });
  }
  return items;
}

/** A feed source: its newest 50 items. */
export async function feedSource(url: string, everyMinutes: number, fetcher?: Fetcher): Promise<FeedItem[]> {
  return cached(`feed:${url}`, Math.max(1, everyMinutes) * 60_000, async () => parseFeed((await fetchPublicText(url, fetcher)).text, url).slice(0, 50));
}

// ------------------------------------------------------------------------------- wallpapers

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * NASA's Image of the Day feed. The APOD API is no source any more: since APOD moved to
 * science.nasa.gov it answers errors for today and the NASA logo for earlier days.
 */
const NASA_FEED = "https://www.nasa.gov/feeds/iotd-feed/";

/** The newest picture of NASA's Image of the Day feed, at a wallpaper size. */
export function nasaImageOfTheDay(xml: string): WallpaperView | null {
  for (const block of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []) {
    const enclosure = /<enclosure\b[^>]*>/i.exec(block)?.[0] ?? "";
    const src = /\burl=["']([^"']+)["']/i.exec(enclosure)?.[1];
    if (!src || !/\btype=["']image\//i.test(enclosure)) continue;
    let url: URL;
    try {
      url = new URL(decodeText(src));
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    // nasa.gov serves resized copies; the originals run to several megabytes.
    if (/(^|\.)nasa\.gov$/.test(url.hostname)) url.searchParams.set("w", "2560");
    const link = decodeText(tag(block, "link") ?? "");
    return { url: url.href, credit: decodeText(tag(block, "title") ?? "") || "NASA Image of the Day", link: /^https:\/\//.test(link) ? link : "https://www.nasa.gov/image-of-the-day/" };
  }
  return null;
}

// A source that fails is asked again after a while, not on every New Tab page.
const failedWallpapers = new Map<string, number>();
const RETRY_FAILED_MS = 15 * 60_000;

export async function wallpaper(source: WallpaperSource, fetcher?: Fetcher): Promise<WallpaperView | null> {
  const key = `wp:${source}:${today()}`;
  if (Date.now() - (failedWallpapers.get(key) ?? 0) < RETRY_FAILED_MS) return null;
  try {
    return await cached(key, 6 * 3600_000, async (): Promise<WallpaperView> => {
      if (source === "bing") {
        const json = (await fetchJson("https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US", fetcher)) as {
          images?: Array<{ url: string; copyright?: string; copyrightlink?: string }>;
        };
        const img = json.images?.[0];
        if (!img) throw new Error("No image");
        return { url: new URL(img.url, "https://www.bing.com").href, credit: img.copyright ?? "Bing", link: img.copyrightlink ?? "https://www.bing.com/" };
      }
      if (source === "wikimedia") {
        const [y, m, d] = today().split("-");
        const json = (await fetchJson(`https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${y}/${m}/${d}`, fetcher)) as {
          image?: { image?: { source: string }; artist?: { text?: string }; description?: { text?: string }; file_page?: string };
        };
        const img = json.image;
        if (!img?.image?.source) throw new Error("No image");
        return { url: img.image.source, credit: [img.description?.text, img.artist?.text].filter(Boolean).join(" · ") || "Wikimedia Commons", link: img.file_page ?? "https://commons.wikimedia.org/" };
      }
      if (source === "nasa") {
        const image = nasaImageOfTheDay((await fetchPublicText(NASA_FEED, fetcher)).text);
        if (!image) throw new Error("No image");
        return image;
      }
      return { url: `https://picsum.photos/seed/${today()}/2560/1440`, credit: "Lorem Picsum (Unsplash photographers)", link: "https://picsum.photos/" };
    });
  } catch {
    failedWallpapers.set(key, Date.now());
    return null;
  }
}

// ------------------------------------------------------------------------------- AI widget data

/** A fetch source: JSON when it parses, otherwise text. */
export async function fetchSource(url: string, everyMinutes: number, fetcher?: Fetcher): Promise<unknown> {
  return cached(`cw:${url}`, Math.max(1, everyMinutes) * 60_000, async () => {
    const { text, type } = await fetchPublicText(url, fetcher);
    if (/json/i.test(type) || /^\s*[[{]/.test(text)) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // Fall through to text.
      }
    }
    return text.slice(0, 200_000);
  });
}

/** For tests: forget cached responses. */
export function clearNewTabCache(): void {
  cache.clear();
  failedWallpapers.clear();
}
