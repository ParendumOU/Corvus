import crypto from "node:crypto";
import path from "node:path";
import type { Bookmark } from "@corvus/shared";
import { JsonFile } from "./json-file";
import {
  BAR_FOLDER_ID,
  ROOT_IDS,
  addNode,
  defaultTree,
  ensureRoots,
  findByUrl,
  getNode,
  moveNode,
  removeNode,
  updateNode,
  upsertNode,
  type NewNode,
} from "../shared/bookmark-tree";
import {
  applySyncedHistory,
  queryHistory,
  recordVisit,
  removeEntries,
  topSites,
  updateEntry,
  type HistoryRecord,
  type SyncedHistoryEntry,
} from "../shared/history-ops";

type Listener = () => void;

class Emitter {
  private readonly listeners = new Set<Listener>();
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(): void {
    for (const l of this.listeners) l();
  }
}

function isBookmark(b: unknown): b is Bookmark {
  const v = b as Partial<Bookmark> | null;
  return (
    typeof v?.id === "string" &&
    (v.parentId === null || typeof v.parentId === "string") &&
    (v.kind === "folder" || v.kind === "bookmark") &&
    typeof v.title === "string" &&
    typeof v.position === "number"
  );
}

function reviveBookmarks(raw: unknown): Bookmark[] {
  return ensureRoots(Array.isArray(raw) ? raw.filter(isBookmark) : [], Date.now());
}

export class BookmarkStore {
  private readonly file: JsonFile<Bookmark[]>;
  readonly changes = new Emitter();

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "bookmarks.json"), () => defaultTree(Date.now()), reviveBookmarks);
  }

  list(): Bookmark[] {
    return this.file.get();
  }

  get(id: string): Bookmark | undefined {
    return getNode(this.file.get(), id);
  }

  private commit(list: Bookmark[]): void {
    this.file.set(list);
    this.changes.emit();
  }

  create(node: NewNode): Bookmark {
    const res = addNode(this.file.get(), node, crypto.randomUUID(), Date.now());
    this.commit(res.list);
    return res.node;
  }

  update(id: string, patch: { title?: string; url?: string }): void {
    this.commit(updateNode(this.file.get(), id, patch, Date.now()));
  }

  move(id: string, parentId: string, index?: number): void {
    this.commit(moveNode(this.file.get(), id, parentId, index, Date.now()));
  }

  remove(id: string): void {
    const res = removeNode(this.file.get(), id, Date.now());
    if (res.removed.length > 0) this.commit(res.list);
  }

  isBookmarked(url: string): boolean {
    return findByUrl(this.file.get(), url).length > 0;
  }

  /** Star button: bookmark the page on the bar, or remove every bookmark of that URL. */
  toggle(url: string, title: string): boolean {
    const existing = findByUrl(this.file.get(), url);
    if (existing.length > 0) {
      let list = this.file.get();
      for (const b of existing) list = removeNode(list, b.id, Date.now()).list;
      this.commit(list);
      return false;
    }
    this.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: title || url, url });
    return true;
  }

  /**
   * Apply changes from sync in order. Root folders are fixed on every device and never change.
   * The file is flushed before returning so the sync engine never records a change that a crash
   * could lose (it would otherwise be pushed back as a deletion).
   */
  applyRemote(changes: Array<{ id: string; node: Bookmark | null }>): void {
    const before = this.file.get();
    let list = before;
    for (const { id, node } of changes) {
      if (ROOT_IDS.has(id)) continue;
      list = node ? upsertNode(list, { ...node, id }) : removeNode(list, id, Date.now()).list;
    }
    if (list === before) return;
    this.file.set(list);
    this.file.flush();
    this.changes.emit();
  }

  flush(): void {
    this.file.flush();
  }
}

export class HistoryStore {
  private readonly file: JsonFile<HistoryRecord[]>;
  readonly changes = new Emitter();
  private readonly visitListeners = new Set<(entry: HistoryRecord) => void>();
  private readonly removeListeners = new Set<(urls: string[] | "all") => void>();

  /** Called with the updated entry after every recorded visit (chrome.history.onVisited). */
  onVisit(listener: (entry: HistoryRecord) => void): () => void {
    this.visitListeners.add(listener);
    return () => this.visitListeners.delete(listener);
  }

  /** Called with the removed URLs, or "all" after clear() (chrome.history.onVisitRemoved). */
  onRemove(listener: (urls: string[] | "all") => void): () => void {
    this.removeListeners.add(listener);
    return () => this.removeListeners.delete(listener);
  }

  constructor(dir: string) {
    this.file = JsonFile.load(
      path.join(dir, "history.json"),
      () => [],
      (raw) => (Array.isArray(raw) ? raw.filter((e): e is HistoryRecord => typeof e?.url === "string" && typeof e?.id === "string") : []),
      1000,
    );
  }

  all(): HistoryRecord[] {
    return this.file.get();
  }

  recordVisit(url: string, title: string): void {
    const next = recordVisit(this.file.get(), { url, title }, crypto.randomUUID(), Date.now());
    this.file.set(next);
    this.changes.emit();
    const entry = next[0];
    if (entry) for (const l of this.visitListeners) l(entry);
  }

  update(url: string, patch: { title?: string; faviconUrl?: string }): void {
    const list = this.file.get();
    const next = updateEntry(list, url, patch);
    if (next !== list) this.file.set(next);
  }

  query(q: string, offset: number, limit: number): { entries: HistoryRecord[]; total: number } {
    return queryHistory(this.file.get(), q, offset, limit);
  }

  remove(ids: string[]): void {
    const gone = new Set(ids);
    const urls = this.file.get().filter((e) => gone.has(e.id)).map((e) => e.url);
    this.file.set(removeEntries(this.file.get(), ids));
    this.changes.emit();
    if (urls.length > 0) for (const l of this.removeListeners) l(urls);
  }

  clear(): void {
    this.file.set([]);
    this.changes.emit();
    for (const l of this.removeListeners) l("all");
  }

  top(limit: number): HistoryRecord[] {
    return topSites(this.file.get(), limit);
  }

  /** Apply changes from sync (entries are keyed by URL across devices), then flush. */
  applyRemote(changes: Array<{ url: string; entry: SyncedHistoryEntry | null }>): void {
    const before = this.file.get();
    const next = applySyncedHistory(before, changes, () => crypto.randomUUID());
    if (next === before) return;
    this.file.set(next);
    this.file.flush();
    this.changes.emit();
  }

  flush(): void {
    this.file.flush();
  }
}
