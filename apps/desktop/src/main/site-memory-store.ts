import path from "node:path";
import {
  MAX_HOSTS,
  evictHosts,
  extractLessons,
  hintCount,
  mergeLessons,
  noteTargetFailure,
  removeHint,
  reviveEntry,
  type MemoryHintKind,
  type SiteMemoryEntry,
  type TrailEvent,
} from "../shared/site-memory";
import { JsonFile } from "./json-file";

type Listener = () => void;

function revive(raw: unknown): SiteMemoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const seen = new Set<string>();
  const out: SiteMemoryEntry[] = [];
  for (const r of raw) {
    const e = reviveEntry(r, now);
    if (!e || seen.has(e.host)) continue;
    seen.add(e.host);
    out.push(e);
  }
  return evictHosts(out, MAX_HOSTS);
}

/**
 * What Corvus learned about sites, for one profile (`site-memory.json`). Local only: it is not part
 * of device sync. Bounded: MAX_ENTRY_BYTES per host (compacted on every merge) and MAX_HOSTS hosts,
 * least recently seen evicted first.
 */
export class SiteMemoryStore {
  private readonly file: JsonFile<SiteMemoryEntry[]>;
  private readonly listeners = new Set<Listener>();

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "site-memory.json"), () => [], revive, 500);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(list: SiteMemoryEntry[]): void {
    this.file.set(evictHosts(list, MAX_HOSTS));
    for (const l of this.listeners) l();
  }

  /** Newest first. */
  list(): SiteMemoryEntry[] {
    return [...this.file.get()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  get(host: string): SiteMemoryEntry | undefined {
    return this.file.get().find((e) => e.host === host);
  }

  get size(): number {
    return this.file.get().length;
  }

  /**
   * Fold a finished run into memory. A successful run adds what worked; any run counts its failed
   * targets against remembered ones. A failed run never creates a new host entry. Returns the hosts
   * that changed.
   */
  learn(trail: readonly TrailEvent[], runOk: boolean, now = Date.now()): string[] {
    const lessons = extractLessons(trail);
    if (lessons.length === 0) return [];
    const list = [...this.file.get()];
    const changed: string[] = [];
    for (const l of lessons) {
      const idx = list.findIndex((e) => e.host === l.host);
      const existing = idx >= 0 ? list[idx] : undefined;
      const hasKnowledge = l.targets.length + l.urls.length + l.obstacles.length > 0;
      if (!existing && (!runOk || !hasKnowledge)) continue;
      if (existing && !runOk && l.failures.length === 0) continue;
      const merged = mergeLessons(existing, l, runOk, now);
      if (!existing && hintCount(merged) === 0) continue;
      if (idx >= 0) list[idx] = merged;
      else list.push(merged);
      changed.push(l.host);
    }
    if (changed.length) this.commit(list);
    return changed;
  }

  /** A remembered target failed outside a run (e.g. a workflow step broke on it). */
  noteFailure(host: string, role: string, name: string, now = Date.now()): void {
    const list = this.file.get();
    const e = list.find((x) => x.host === host);
    if (!e || !e.targets.some((t) => t.role === role && t.name === name)) return;
    this.commit(list.map((x) => (x.host === host ? noteTargetFailure(x, role, name, now) : x)));
  }

  removeHint(host: string, kind: MemoryHintKind, key: string): void {
    const list = this.file.get();
    if (!list.some((e) => e.host === host)) return;
    this.commit(list.map((e) => (e.host === host ? removeHint(e, kind, key) : e)));
  }

  /** "Forget this site". */
  forget(host: string): void {
    this.commit(this.file.get().filter((e) => e.host !== host));
  }

  /** "Forget everything". */
  forgetAll(): void {
    this.commit([]);
  }

  flush(): void {
    this.file.flush();
  }
}
