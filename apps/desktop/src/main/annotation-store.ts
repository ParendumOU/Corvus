import path from "node:path";
import {
  type Annotation,
  type AnnotationAnchor,
  type AnnotationColor,
  MAX_ANNOTATIONS,
  MAX_ANNOTATIONS_PER_PAGE,
  MAX_QUOTE_CHARS,
  clampNote,
  isAnnotation,
  normalizePageUrl,
  searchAnnotations,
} from "../shared/annotations";
import { JsonFile } from "./json-file";

type Listener = () => void;

export interface AnnotationInput {
  url: string;
  pageTitle: string;
  color: AnnotationColor;
  note: string;
  anchor: AnnotationAnchor;
}

/** Per-profile store of page annotations (annotations.json), same JSON-store pattern as reading/bookmarks. */
export class AnnotationStore {
  private readonly file: JsonFile<Annotation[]>;
  private readonly listeners = new Set<Listener>();

  constructor(dir: string) {
    this.file = JsonFile.load(
      path.join(dir, "annotations.json"),
      () => [],
      (raw) => (Array.isArray(raw) ? raw.filter(isAnnotation) : []),
    );
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** All annotations, newest first; optionally filtered by a text query (manager list). */
  list(query = ""): Annotation[] {
    return searchAnnotations(this.file.get(), query);
  }

  /** Annotations for one page (fragment-insensitive), oldest first so re-application is stable. */
  forUrl(url: string): Annotation[] {
    const key = normalizePageUrl(url);
    return this.file
      .get()
      .filter((a) => a.url === key)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Annotation | undefined {
    return this.file.get().find((a) => a.id === id);
  }

  /** All annotations, for sync. Keyed by their stable id across devices. */
  all(): Annotation[] {
    return this.file.get();
  }

  /** Inserts a new annotation, or null when a cap is hit or the quote is too long. */
  add(input: AnnotationInput): Annotation | null {
    if (input.anchor.quote.length === 0 || input.anchor.quote.length > MAX_QUOTE_CHARS) return null;
    const url = normalizePageUrl(input.url);
    const current = this.file.get();
    if (current.length >= MAX_ANNOTATIONS) return null;
    if (current.filter((a) => a.url === url).length >= MAX_ANNOTATIONS_PER_PAGE) return null;
    const now = Date.now();
    const annotation: Annotation = {
      id: crypto.randomUUID(),
      url,
      pageTitle: input.pageTitle.slice(0, 500),
      color: input.color,
      note: clampNote(input.note),
      anchor: {
        quote: input.anchor.quote.slice(0, MAX_QUOTE_CHARS),
        prefix: input.anchor.prefix,
        suffix: input.anchor.suffix,
      },
      createdAt: now,
      updatedAt: now,
    };
    this.file.set([annotation, ...current]);
    this.emit();
    return annotation;
  }

  update(id: string, patch: { note?: string; color?: AnnotationColor }): Annotation | undefined {
    let updated: Annotation | undefined;
    const next = this.file.get().map((a) => {
      if (a.id !== id) return a;
      updated = {
        ...a,
        ...(patch.note !== undefined ? { note: clampNote(patch.note) } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        updatedAt: Date.now(),
      };
      return updated;
    });
    if (updated) {
      this.file.set(next);
      this.emit();
    }
    return updated;
  }

  remove(id: string): Annotation | undefined {
    const current = this.file.get();
    const found = current.find((a) => a.id === id);
    if (!found) return undefined;
    this.file.set(current.filter((a) => a.id !== id));
    this.emit();
    return found;
  }

  clear(): void {
    if (this.file.get().length === 0) return;
    this.file.set([]);
    this.emit();
  }

  /**
   * Apply changes from sync. Annotations are keyed by their stable id (distinct across devices, like
   * workspaces). Flushed before returning so the engine never records a change a crash could lose.
   */
  applyRemote(changes: Array<{ id: string; annotation: Annotation | null }>): void {
    const before = this.file.get();
    const byId = new Map(before.map((a) => [a.id, a]));
    let dirty = false;
    for (const { id, annotation } of changes) {
      if (annotation === null) {
        if (byId.delete(id)) dirty = true;
      } else {
        const existing = byId.get(id);
        if (!existing || existing.updatedAt !== annotation.updatedAt) {
          byId.set(id, annotation);
          dirty = true;
        }
      }
    }
    if (!dirty) return;
    this.file.set([...byId.values()].sort((a, b) => b.createdAt - a.createdAt));
    this.file.flush();
    this.emit();
  }

  flush(): void {
    this.file.flush();
  }
}
