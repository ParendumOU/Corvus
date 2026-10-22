import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RetrieverKind, SearchCategory, SearchInsights, SearchResult } from "@corvus/shared";

export interface CachedAnswer {
  results: SearchResult[];
  retriever: RetrieverKind;
  /** Absent when the search ran without an AI provider. */
  answer?: { text: string; citations: number[]; model: string; insights?: SearchInsights };
}

export interface CacheKeyParts {
  query: string;
  lang: string;
  depth: "quick" | "deep";
  retriever: RetrieverKind;
  maxResults: number;
  category?: SearchCategory;
}

/** Bumped when the cached answer format changes, so older entries are simply missed. */
export const CACHE_FORMAT = 2;

export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function cacheKey(parts: CacheKeyParts): string {
  return [
    `v${CACHE_FORMAT}`,
    normalizeQuery(parts.query),
    parts.lang.toLowerCase(),
    parts.depth,
    parts.retriever,
    parts.maxResults,
    parts.category ?? "general",
  ].join(
    "\u0000",
  );
}

interface Stored {
  key: string;
  expiresAt: number;
  value: CachedAnswer;
}

export interface SearchCacheOptions {
  dir?: string;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** In-memory LRU with an optional write-through JSON file per entry in `dir`. */
export class SearchCache {
  private readonly memory = new Map<string, Stored>();
  private readonly dir: string | undefined;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private dirReady: Promise<void> | undefined;

  constructor(opts: SearchCacheOptions = {}) {
    this.dir = opts.dir;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? 200;
    this.now = opts.now ?? Date.now;
  }

  private file(key: string): string {
    return join(this.dir!, `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  private remember(entry: Stored): void {
    this.memory.delete(entry.key);
    this.memory.set(entry.key, entry);
    while (this.memory.size > this.maxEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  async get(key: string): Promise<CachedAnswer | undefined> {
    const hit = this.memory.get(key);
    if (hit) {
      if (hit.expiresAt > this.now()) {
        this.remember(hit);
        return hit.value;
      }
      this.memory.delete(key);
    }
    if (!this.dir) return undefined;
    try {
      const stored = JSON.parse(await readFile(this.file(key), "utf8")) as Stored;
      if (stored.key !== key) return undefined;
      if (stored.expiresAt <= this.now()) {
        await rm(this.file(key), { force: true });
        return undefined;
      }
      this.remember(stored);
      return stored.value;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: CachedAnswer, ttlMs = this.ttlMs): Promise<void> {
    const entry: Stored = { key, expiresAt: this.now() + ttlMs, value };
    this.remember(entry);
    if (!this.dir) return;
    try {
      this.dirReady ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
      await this.dirReady;
      const target = this.file(key);
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify(entry), "utf8");
      await rename(tmp, target);
    } catch {
      // Disk cache is an optimization; the in-memory entry still serves this session.
      this.dirReady = undefined;
    }
  }

  clearMemory(): void {
    this.memory.clear();
  }
}
