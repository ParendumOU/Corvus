import path from "node:path";
import {
  type IndexDoc,
  type IndexDocKind,
  capByKind,
  docId,
  makeSnippet,
  removeDocUrl,
  upsertDoc,
} from "../shared/semantic-search";
import { JsonFile } from "./json-file";

type Listener = () => void;

const KINDS: ReadonlySet<string> = new Set<IndexDocKind>(["history", "bookmark", "reading"]);

function isIndexDoc(value: unknown): value is IndexDoc {
  const v = value as Partial<IndexDoc> | null;
  return (
    typeof v?.id === "string" &&
    typeof v.url === "string" &&
    typeof v.title === "string" &&
    typeof v.text === "string" &&
    typeof v.ts === "number" &&
    typeof v.kind === "string" &&
    KINDS.has(v.kind)
  );
}

/**
 * Per-profile local search index (semantic-index.json), same JsonFile pattern as bookmarks/history/
 * reading. Holds title + captured snippet per visited/bookmarked/saved page, bounded per kind.
 */
export class SemanticIndexStore {
  private readonly file: JsonFile<IndexDoc[]>;
  private readonly listeners = new Set<Listener>();

  constructor(dir: string) {
    this.file = JsonFile.load(
      path.join(dir, "semantic-index.json"),
      () => [],
      (raw) => capByKind(Array.isArray(raw) ? raw.filter(isIndexDoc) : []),
    );
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  all(): IndexDoc[] {
    return this.file.get();
  }

  size(): number {
    return this.file.get().length;
  }

  private put(kind: IndexDocKind, url: string, title: string, text: string, ts: number): void {
    const existing = this.file.get().find((d) => d.id === docId(kind, url));
    const doc: IndexDoc = {
      id: docId(kind, url),
      kind,
      url,
      title: (title || existing?.title || url).slice(0, 400),
      // Keep an earlier captured snippet if this update has none (e.g. a title-only history ping).
      text: text ? makeSnippet(text) : existing?.text ?? "",
      ts,
    };
    this.file.set(upsertDoc(this.file.get(), doc));
    this.emit();
  }

  addVisit(url: string, title: string, text: string, now = Date.now()): void {
    this.put("history", url, title, text, now);
  }

  addBookmark(url: string, title: string, now = Date.now()): void {
    this.put("bookmark", url, title, "", now);
  }

  addReading(url: string, title: string, text: string, savedAt: number): void {
    this.put("reading", url, title, text, savedAt);
  }

  /** Drop every doc of a URL across all kinds (history removed / bookmark deleted). */
  removeUrl(url: string): void {
    const next = removeDocUrl(this.file.get(), url);
    if (next.length !== this.file.get().length) {
      this.file.set(next);
      this.emit();
    }
  }

  /** Replace all docs of one kind (used to resync bookmarks / reading from the source of truth). */
  replaceKind(kind: IndexDocKind, docs: Array<{ url: string; title: string; text: string; ts: number }>): void {
    const others = this.file.get().filter((d) => d.kind !== kind);
    const next = docs.map((d) => ({
      id: docId(kind, d.url),
      kind,
      url: d.url,
      title: (d.title || d.url).slice(0, 400),
      text: makeSnippet(d.text),
      ts: d.ts,
    }));
    this.file.set(capByKind([...others, ...next]));
    this.emit();
  }

  clear(): void {
    this.file.set([]);
    this.emit();
  }

  flush(): void {
    this.file.flush();
  }
}
