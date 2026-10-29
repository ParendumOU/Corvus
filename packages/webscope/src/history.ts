import type { HistoryCursor, HistoryEntry, HistoryFilter, HistoryPage, HistorySummary } from "./types.js";

function bodyLength(entry: HistoryEntry): number {
  const r = entry.response;
  if (!r) return 0;
  if (r.size !== undefined) return r.size;
  if (!r.body) return 0;
  return r.bodyBase64 ? Buffer.from(r.body, "base64").length : Buffer.byteLength(r.body, "utf8");
}

export function summarize(entry: HistoryEntry): HistorySummary {
  return {
    id: entry.id,
    method: entry.request.method,
    host: entry.host,
    path: entry.path,
    status: entry.response?.status ?? null,
    type: entry.type,
    length: bodyLength(entry),
    durationMs: entry.durationMs ?? null,
    startedAt: entry.startedAt,
    inScope: entry.inScope,
    source: entry.source,
    ...(entry.response?.mimeType ? { mimeType: entry.response.mimeType } : {}),
    ...(entry.aiHidden ? { aiHidden: true } : {}),
  };
}

function haystack(entry: HistoryEntry): string {
  const parts = [entry.request.method, entry.request.url];
  for (const h of entry.request.headers) parts.push(h.name, h.value);
  if (entry.request.body && !entry.request.bodyBase64) parts.push(entry.request.body);
  if (entry.response) {
    for (const h of entry.response.headers) parts.push(h.name, h.value);
    if (entry.response.body && !entry.response.bodyBase64) parts.push(entry.response.body);
  }
  return parts.join("\n").toLowerCase();
}

export function matchesFilter(entry: HistoryEntry, filter: HistoryFilter): boolean {
  if (filter.host && !entry.host.toLowerCase().includes(filter.host.toLowerCase())) return false;
  if (filter.method && entry.request.method.toUpperCase() !== filter.method.toUpperCase()) return false;
  if (filter.type && entry.type !== filter.type) return false;
  if (filter.source && entry.source !== filter.source) return false;
  if (filter.onlyInScope && !entry.inScope) return false;
  if (filter.statusClass !== undefined) {
    const status = entry.response?.status;
    if (status === undefined || Math.floor(status / 100) !== filter.statusClass) return false;
  }
  if (filter.search && !haystack(entry).includes(filter.search.toLowerCase())) return false;
  return true;
}

/**
 * Fixed-capacity, in-memory ring buffer of captured exchanges. Oldest entries are evicted once the
 * capacity is reached, so long browsing sessions never exhaust memory. Every add or update gets the
 * next sequence number, so a live view can ask for just what changed since it last looked.
 */
export class HistoryBuffer {
  private entries: HistoryEntry[] = [];
  private readonly index = new Map<string, HistoryEntry>();
  private readonly seqs = new WeakMap<HistoryEntry, number>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private epoch = 0;

  constructor(private readonly capacity = 5000) {}

  add(entry: HistoryEntry): void {
    const existing = this.index.get(entry.id);
    if (existing) {
      Object.assign(existing, entry);
      this.seqs.set(existing, ++this.seq);
      this.emit();
      return;
    }
    this.entries.push(entry);
    this.index.set(entry.id, entry);
    this.seqs.set(entry, ++this.seq);
    while (this.entries.length > this.capacity) {
      const evicted = this.entries.shift();
      if (evicted) this.index.delete(evicted.id);
    }
    this.emit();
  }

  get(id: string): HistoryEntry | undefined {
    return this.index.get(id);
  }

  /**
   * Newest first, optionally filtered and capped. `view` maps each entry before it is matched and
   * summarized (the AI view redacts hidden requests, so a search cannot probe their bodies).
   */
  query(filter: HistoryFilter = {}, limit = 200, view: (entry: HistoryEntry) => HistoryEntry = (e) => e): HistorySummary[] {
    return this.collect(filter, limit, view, 0);
  }

  /**
   * The rows added or updated since `since`, matched and capped like `query`. Without a cursor, or
   * when the history was cleared since, it is every row with `reset` set.
   */
  querySince(filter: HistoryFilter, since: HistoryCursor | null, limit = 200, view: (entry: HistoryEntry) => HistoryEntry = (e) => e): HistoryPage {
    const cursor = this.cursor();
    const reset = !since || since.epoch !== this.epoch || since.seq > this.seq;
    return { rows: this.collect(filter, limit, view, reset ? 0 : since.seq), cursor, reset };
  }

  private collect(filter: HistoryFilter, limit: number, view: (entry: HistoryEntry) => HistoryEntry, afterSeq: number): HistorySummary[] {
    const out: HistorySummary[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const raw = this.entries[i];
      if (!raw || (afterSeq > 0 && (this.seqs.get(raw) ?? 0) <= afterSeq)) continue;
      const entry = view(raw);
      if (matchesFilter(entry, filter)) out.push(summarize(entry));
    }
    return out;
  }

  cursor(): HistoryCursor {
    return { epoch: this.epoch, seq: this.seq };
  }

  /** Called after every add, update and clear. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener never gets to break capture.
      }
    }
  }

  all(): HistoryEntry[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.index.clear();
    this.epoch++;
    this.emit();
  }
}
