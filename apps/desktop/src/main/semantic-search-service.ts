import type { EmbeddingConfig } from "@corvus/ai-engine";
import type { SemanticHit, SemanticSearchResponse, SemanticSearchStatus } from "../shared/semantic-search-ipc";
import {
  type IndexDoc,
  type ScoredDoc,
  bm25Rank,
  blendScores,
  cosineSimilarity,
  snippetAround,
  CANDIDATE_LIMIT,
} from "../shared/semantic-search";
import { isHistoryWorthy } from "../shared/internal-urls";
import type { AppContext } from "./context";
import { loadOptionalModule } from "./module-loader";
import type { ProfileRuntime } from "./profiles";
import { type CapturedPage, SEMANTIC_WORLD_ID, capturePageTextScript } from "./semantic-scripts";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface AiEngineModule {
  embedTexts?: (cfg: EmbeddingConfig, texts: string[]) => Promise<number[][]>;
}

interface CachedVector {
  hash: number;
  model: string;
  vec: number[];
}

const DEFAULT_RESULT_LIMIT = 8;
const CAPTURE_TIMEOUT_MS = 4000;
const EMBED_CACHE_MAX = 3000;
/** Skip embedding tiny/vague queries — keyword is enough and the round-trip isn't worth it. */
const MIN_QUERY_LEN = 3;

function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function embedText(doc: IndexDoc): string {
  return `${doc.title}\n${doc.text}`.slice(0, 1200);
}

/**
 * Local "find in my stuff" search over history, bookmarks and reading. BM25 keyword always; an
 * optional embedding re-rank when the user turned it on and a local endpoint answers. Cross-profile:
 * each ProfileRuntime owns its own SemanticIndexStore, which this service fills and queries.
 */
export class SemanticSearchService {
  private readonly embedCache = new Map<string, CachedVector>();

  constructor(private readonly ctx: AppContext) {}

  /** Backfill one profile's index from its existing data and keep it in sync with the sources. */
  attach(runtime: ProfileRuntime): void {
    this.syncBookmarks(runtime);
    this.syncReading(runtime);
    this.backfillHistory(runtime);
    runtime.bookmarks.changes.on(() => this.syncBookmarks(runtime));
    runtime.reading.onChange(() => this.syncReading(runtime));
    runtime.history.onRemove((urls) => {
      if (urls === "all") runtime.semanticIndex.clear();
      else for (const url of urls) runtime.semanticIndex.removeUrl(url);
    });
  }

  private indexingEnabled(): boolean {
    return this.ctx.settings.get().semanticSearch.indexPages;
  }

  private syncBookmarks(runtime: ProfileRuntime): void {
    const docs = runtime.bookmarks
      .list()
      .filter((b) => b.kind === "bookmark" && b.url)
      .map((b) => ({ url: b.url as string, title: b.title || (b.url as string), text: "", ts: b.updatedAt }));
    runtime.semanticIndex.replaceKind("bookmark", docs);
  }

  private syncReading(runtime: ProfileRuntime): void {
    const docs = runtime.reading.list().map((item) => ({
      url: item.url,
      title: item.title || item.url,
      text: `${item.excerpt} ${item.keyPoints.join(" ")}`,
      ts: item.savedAt,
    }));
    runtime.semanticIndex.replaceKind("reading", docs);
  }

  private backfillHistory(runtime: ProfileRuntime): void {
    const existing = new Set(runtime.semanticIndex.all().filter((d) => d.kind === "history").map((d) => d.url));
    for (const entry of runtime.history.all()) {
      if (!existing.has(entry.url)) runtime.semanticIndex.addVisit(entry.url, entry.title, "", entry.visitedAt);
    }
  }

  /** Capture readable page text on load and index it under the visited URL. Best-effort, never throws. */
  async capturePage(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
    if (!this.indexingEnabled() || win.isPrivate) return;
    const url = tab.url;
    if (!isHistoryWorthy(url)) return;
    const wc = tab.view.webContents;
    try {
      const captured = (await Promise.race([
        wc.executeJavaScriptInIsolatedWorld(SEMANTIC_WORLD_ID, [{ code: capturePageTextScript() }]) as Promise<CapturedPage>,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS)),
      ])) as CapturedPage | null;
      if (!captured || !captured.text) return;
      win.profile.semanticIndex.addVisit(url, captured.title || tab.title, captured.text);
    } catch {
      // Page closed, navigated away, or script blocked — leave the title-only history doc as-is.
    }
  }

  status(runtime: ProfileRuntime): SemanticSearchStatus {
    const s = this.ctx.settings.get().semanticSearch;
    return { indexed: runtime.semanticIndex.size(), embeddingsEnabled: s.useEmbeddings, embeddingModel: s.embeddingModel };
  }

  async query(runtime: ProfileRuntime, rawQuery: string, limit = DEFAULT_RESULT_LIMIT): Promise<SemanticSearchResponse> {
    const query = rawQuery.trim();
    const indexed = runtime.semanticIndex.size();
    if (!query) return { hits: [], indexed, usedEmbeddings: false };

    const candidates = bm25Rank(runtime.semanticIndex.all(), query, CANDIDATE_LIMIT);
    if (candidates.length === 0) return { hits: [], indexed, usedEmbeddings: false };

    let semantic: number[] = [];
    let usedEmbeddings = false;
    let embeddingError: string | undefined;
    if (this.shouldEmbed(query)) {
      try {
        semantic = await this.semanticScores(query, candidates);
        usedEmbeddings = semantic.length === candidates.length;
      } catch (err) {
        embeddingError = err instanceof Error ? err.message : String(err);
      }
    }

    const ranked = blendScores(candidates, usedEmbeddings ? semantic : []);
    const hits: SemanticHit[] = ranked.slice(0, limit).map((r) => ({
      id: r.doc.id,
      kind: r.doc.kind,
      url: r.doc.url,
      title: r.doc.title,
      snippet: snippetAround(r.doc.text, query),
      ts: r.doc.ts,
      score: r.score,
      semantic: r.semanticScore !== undefined,
    }));
    return { hits, indexed, usedEmbeddings, ...(embeddingError ? { embeddingError } : {}) };
  }

  private shouldEmbed(query: string): boolean {
    return this.ctx.settings.get().semanticSearch.useEmbeddings && query.length >= MIN_QUERY_LEN;
  }

  private embedConfig(): EmbeddingConfig {
    const ai = this.ctx.settings.get().ai;
    return {
      api: ai.localApi,
      baseUrl: ai.localBaseUrl || undefined,
      model: this.ctx.settings.get().semanticSearch.embeddingModel,
    };
  }

  /** Cosine of each candidate vs the query. Throws (caught by query) when the endpoint is unavailable. */
  private async semanticScores(query: string, candidates: ScoredDoc[]): Promise<number[]> {
    const mod = await loadOptionalModule<AiEngineModule>("@corvus/ai-engine", "ai-engine");
    if (!mod?.embedTexts) throw new Error("Embedding engine unavailable");
    const cfg = this.embedConfig();

    const misses: { index: number; text: string }[] = [];
    const cachedVecs = new Array<number[] | null>(candidates.length).fill(null);
    for (let i = 0; i < candidates.length; i++) {
      const doc = candidates[i]!.doc;
      const text = embedText(doc);
      const hash = cyrb53(text);
      const cached = this.embedCache.get(doc.id);
      if (cached && cached.hash === hash && cached.model === cfg.model) cachedVecs[i] = cached.vec;
      else misses.push({ index: i, text });
    }

    const toEmbed = [query, ...misses.map((m) => m.text)];
    const vectors = await mod.embedTexts(cfg, toEmbed);
    if (vectors.length !== toEmbed.length) throw new Error("Embedding count mismatch");
    const queryVec = vectors[0]!;
    misses.forEach((m, j) => {
      const vec = vectors[j + 1]!;
      cachedVecs[m.index] = vec;
      const doc = candidates[m.index]!.doc;
      this.cacheVector(doc.id, { hash: cyrb53(m.text), model: cfg.model, vec });
    });

    return cachedVecs.map((vec) => (vec ? cosineSimilarity(queryVec, vec) : 0));
  }

  private cacheVector(id: string, entry: CachedVector): void {
    this.embedCache.set(id, entry);
    if (this.embedCache.size > EMBED_CACHE_MAX) {
      const oldest = this.embedCache.keys().next().value;
      if (oldest !== undefined) this.embedCache.delete(oldest);
    }
  }
}
