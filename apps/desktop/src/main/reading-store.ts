import path from "node:path";
import {
  type ReadingItem,
  type ReadingSummary,
  isLinkOnly,
  isReadingItem,
  readingSummary,
  searchReadingItems,
  withReadState,
} from "../shared/reading";
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

  /** Marks an item read or unread (synced to the other devices). */
  setRead(id: string, read: boolean, now: number = Date.now()): void {
    const items = this.file.get();
    const item = items.find((i) => i.id === id);
    if (!item || (item.readAt !== undefined) === read) return;
    this.file.set(items.map((i) => (i === item ? withReadState(i, read ? now : null) : i)));
    this.emit();
  }

  /** Articles saved as a link only (from the phone), waiting for a computer to fill them in. */
  linkOnly(): ReadingItem[] {
    return this.file.get().filter(isLinkOnly);
  }

  /** Fills in the article of a link-only item, unless it changed meanwhile. */
  fill(id: string, article: Pick<ReadingItem, "title" | "siteName" | "byline" | "excerpt" | "markdown" | "wordCount" | "readingMinutes">): boolean {
    const items = this.file.get();
    const item = items.find((i) => i.id === id);
    if (!item || !isLinkOnly(item)) return false;
    const filled: ReadingItem = { ...item, ...article, title: article.title || item.title };
    this.file.set(items.map((i) => (i === item ? filled : i)));
    this.emit();
    return true;
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
        // A device that only has the link (the phone marking it read before the article reached it)
        // must not wipe the article: keep it and take the read state. The merged item syncs back.
        const next = existing && existing.id === item.id && isLinkOnly(item) && !isLinkOnly(existing) ? withReadState(existing, item.readAt ?? null) : item;
        if (!existing || JSON.stringify(existing) !== JSON.stringify(next)) {
          byUrl.set(url, next);
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
