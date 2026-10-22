import type { SearchCategory, SearchResult } from "@corvus/shared";
import { fetchWithTimeout } from "../http.js";
import { cleanText, truncate } from "../text.js";
import { domainOf, stripTracking } from "../url.js";
import {
  DEFAULT_RETRIEVER_TIMEOUT_MS,
  type RawHit,
  type RetrieveOptions,
  type Retriever,
  RetrieverError,
  type RetrieverHttpOptions,
  toResults,
} from "./types.js";

interface SearxngHit {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string | null;
  metadata?: string | null;
  author?: string | null;
  source?: string | null;
  thumbnail?: string | null;
  thumbnail_src?: string | null;
  img_src?: string | null;
  resolution?: string | null;
  img_format?: string | null;
  length?: string | number | null;
}

interface SearxngResponse {
  results?: SearxngHit[];
}

const VERTICALS: readonly SearchCategory[] = ["news", "images", "videos"];

function httpUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const fixed = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const url = new URL(fixed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function isoDate(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** "10:21", "00:15", 6802 (seconds) or "PT4M13S" -> "m:ss" / "h:mm:ss". */
export function formatDuration(raw: string | number | null | undefined): string | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  let seconds: number | undefined;
  if (typeof raw === "number") seconds = raw;
  else if (/^\d+$/.test(raw)) seconds = Number(raw);
  else if (/^\d{1,2}(:\d{2}){1,2}$/.test(raw.trim())) {
    seconds = raw
      .trim()
      .split(":")
      .reduce((acc, part) => acc * 60 + Number(part), 0);
  } else {
    const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(raw.trim());
    if (iso) seconds = Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
  }
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** SearXNG news metadata is "13 hours ago | The Atlantic". */
function splitMetadata(raw: string | null | undefined): { age?: string; publisher?: string } {
  const parts = cleanText(raw).split(" | ").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return {};
  const looksLikeAge = (s: string) => /\d/.test(s) && s.length <= 30;
  if (parts.length >= 2 && looksLikeAge(parts[0]!)) return { age: parts[0], publisher: parts[1] };
  return { publisher: parts[0] };
}

function parseResolution(raw: string | null | undefined): { width?: number; height?: number } {
  const m = /(\d+)\s*[x×]\s*(\d+)/i.exec(raw ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
}

function withExtras(results: SearchResult[], hits: SearxngHit[], category: SearchCategory): SearchResult[] {
  const byUrl = new Map<string, SearxngHit>();
  for (const hit of hits) {
    if (hit.url && /^https?:\/\//i.test(hit.url)) {
      const key = stripTracking(hit.url);
      if (!byUrl.has(key)) byUrl.set(key, hit);
    }
  }
  return results.map((r) => {
    const hit = byUrl.get(r.url);
    if (!hit) return r;
    const out: SearchResult = { ...r };
    const publishedAt = isoDate(hit.publishedDate);
    if (publishedAt) out.publishedAt = publishedAt;
    const thumbnail = httpUrl(hit.thumbnail) ?? (category === "news" ? httpUrl(hit.img_src) : undefined);
    if (thumbnail) out.thumbnail = thumbnail;
    if (category === "news") {
      const meta = splitMetadata(hit.metadata);
      if (meta.age) out.age = meta.age;
      if (meta.publisher) out.publisher = meta.publisher;
    } else if (category === "videos") {
      const duration = formatDuration(hit.length);
      if (duration) out.duration = duration;
      const publisher = cleanText(hit.author) || splitMetadata(hit.metadata).publisher;
      if (publisher) out.publisher = truncate(publisher, 60);
    }
    return out;
  });
}

/** Image results are deduplicated by image, not by page (one page can carry several images). */
function parseImages(hits: SearxngHit[], maxResults: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const hit of hits) {
    const src = httpUrl(hit.img_src);
    const page = hit.url && /^https?:\/\//i.test(hit.url) ? stripTracking(hit.url) : undefined;
    if (!src || !page || seen.has(src)) continue;
    const source = domainOf(page);
    if (!source) continue;
    seen.add(src);
    const title = truncate(cleanText(hit.title) || source, 160);
    out.push({
      url: page,
      title,
      snippet: "",
      source,
      rank: out.length + 1,
      thumbnail: httpUrl(hit.thumbnail_src) ?? src,
      image: { src, ...parseResolution(hit.resolution), ...(hit.img_format ? { format: cleanText(hit.img_format) } : {}) },
      ...(cleanText(hit.source) ? { publisher: truncate(cleanText(hit.source), 60) } : {}),
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

export function parseSearxng(body: unknown, maxResults: number, category: SearchCategory = "general"): SearchResult[] {
  const results = (body as SearxngResponse | null)?.results;
  if (!Array.isArray(results)) throw new RetrieverError("searxng", "unexpected response shape");
  if (category === "images") return parseImages(results, maxResults);
  const hits: RawHit[] = results.map((r) => ({ url: r.url, title: r.title, snippet: r.content }));
  const mapped = toResults(hits, maxResults);
  return category === "general" ? mapped : withExtras(mapped, results, category);
}

export function createSearxngRetriever(baseUrl: string, http: RetrieverHttpOptions = {}): Retriever {
  const fetchImpl = http.fetch ?? fetch;
  const timeoutMs = http.timeoutMs ?? DEFAULT_RETRIEVER_TIMEOUT_MS;
  const endpoint = new URL("search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return {
    kind: "searxng",
    categories: VERTICALS,
    async search(query: string, opts: RetrieveOptions) {
      const category = opts.category ?? "general";
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("language", opts.lang);
      url.searchParams.set("safesearch", "1");
      if (category !== "general") url.searchParams.set("categories", category);
      const res = await fetchWithTimeout(
        fetchImpl,
        url.toString(),
        { headers: { Accept: "application/json", "Accept-Language": opts.lang } },
        timeoutMs,
        opts.signal,
      );
      if (!res.ok) throw new RetrieverError("searxng", `HTTP ${res.status}`);
      return parseSearxng(await res.json(), opts.maxResults, category);
    },
  };
}
