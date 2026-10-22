import path from "node:path";
import { type ReadingItem, type ReadingSummary, isReadingItem, readingSummary, searchReadingItems } from "../shared/reading";
import { JsonFile } from "./json-file";

type Listener = () => void;

/** Per-profile library of saved reader-mode articles (reading.json), same JSON-store pattern as bookmarks/history. */
export class ReadingStore {
  private readonly file: JsonFile<ReadingItem[]>;
  private readonly listeners = new Set<Listener>();

  constructor(dir: string) {
    this.file = JsonFile.load(
      path.join(dir, "reading.json"),
      () => [],
      (raw) => (Array.isArray(raw) ? raw.filter(isReadingItem) : []),
    );
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Summaries (no Markdown body), filtered and sorted newest first. */
  list(query = ""): ReadingSummary[] {
    return searchReadingItems(this.file.get().map(readingSummary), query);
  }

  get(id: string): ReadingItem | undefined {
    return this.file.get().find((item) => item.id === id);
  }

  /** Full items (with Markdown body) for sync. Keyed by URL across devices (the store dedupes by URL). */
  allItems(): ReadingItem[] {
    return this.file.get();
  }

  /** Whether a URL is already saved (so the reader can show "Saved"). */
  hasUrl(url: string): boolean {
    return this.file.get().some((item) => item.url === url);
  }

  /** Inserts, or replaces an earlier save of the same URL. */
  save(item: ReadingItem): void {
    const rest = this.file.get().filter((existing) => existing.url !== item.url);
    this.file.set([item, ...rest]);
    this.emit();
  }

  remove(id: string): void {
    const next = this.file.get().filter((item) => item.id !== id);
    if (next.length !== this.file.get().length) {
      this.file.set(next);
      this.emit();
    }
  }

  /**
   * Apply changes from sync. Items are keyed by URL across devices (matching save()'s dedupe), so an
   * upsert replaces any earlier save of the same URL and a tombstone drops it. Flushed before
   * returning so the engine never records a change a crash could lose and re-push as a deletion.
   */
  applyRemote(changes: Array<{ url: string; item: ReadingItem | null }>): void {
    const before = this.file.get();
    const byUrl = new Map(before.map((i) => [i.url, i]));
    let dirty = false;
    for (const { url, item } of changes) {
      if (item === null) {
        if (byUrl.delete(url)) dirty = true;
      } else {
        const existing = byUrl.get(url);
        if (!existing || existing.savedAt !== item.savedAt || existing.id !== item.id) {
          byUrl.set(url, item);
          dirty = true;
        }
      }
    }
    if (!dirty) return;
    this.file.set([...byUrl.values()].sort((a, b) => b.savedAt - a.savedAt));
    this.file.flush();
    this.emit();
  }

  flush(): void {
    this.file.flush();
  }
}
