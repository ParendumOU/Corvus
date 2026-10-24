import crypto from "node:crypto";
import path from "node:path";
import { clampInterval, cleanCondition, toSyncedWatch, type SyncedWatch, type Watch, type WatchResult } from "../shared/page-watch";
import type { WatchView } from "../shared/watch-ipc";
import { JsonFile } from "./json-file";

type Listener = () => void;

function isWatch(v: unknown): v is Watch {
  const w = v as Partial<Watch> | null;
  return typeof w?.id === "string" && typeof w.url === "string" && typeof w.intervalMinutes === "number";
}

function revive(raw: unknown): Watch[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isWatch).map((w) => ({
    id: w.id,
    url: w.url,
    title: typeof w.title === "string" ? w.title : w.url,
    ...(typeof w.faviconUrl === "string" ? { faviconUrl: w.faviconUrl } : {}),
    intervalMinutes: clampInterval(w.intervalMinutes),
    createdAt: typeof w.createdAt === "number" ? w.createdAt : Date.now(),
    paused: w.paused === true,
    lastCheckedAt: typeof w.lastCheckedAt === "number" ? w.lastCheckedAt : null,
    lastChangedAt: typeof w.lastChangedAt === "number" ? w.lastChangedAt : null,
    lastResult: (["pending", "ok", "changed", "error"] as WatchResult[]).includes(w.lastResult as WatchResult) ? (w.lastResult as WatchResult) : "pending",
    ...(typeof w.lastError === "string" ? { lastError: w.lastError } : {}),
    fingerprint: typeof w.fingerprint === "string" ? w.fingerprint : null,
    baseline: typeof w.baseline === "string" ? w.baseline : "",
    changeSummary: typeof w.changeSummary === "string" ? w.changeSummary : "",
    unseen: w.unseen === true,
    ...(cleanCondition(w.condition) ? { condition: cleanCondition(w.condition) } : {}),
    ...(typeof w.conditionMet === "boolean" ? { conditionMet: w.conditionMet } : {}),
    ...(typeof w.conditionDetail === "string" ? { conditionDetail: w.conditionDetail.slice(0, 200) } : {}),
  }));
}

/**
 * Watched pages for one profile. Durable fields are persisted; `checking` is a transient in-memory
 * flag set by the monitor while a fetch is in flight.
 */
export class WatchStore {
  private readonly file: JsonFile<Watch[]>;
  private readonly checking = new Set<string>();
  private readonly listeners = new Set<Listener>();

  constructor(
    dir: string,
    private readonly maxWatches: () => number,
  ) {
    this.file = JsonFile.load(path.join(dir, "watches.json"), () => [], revive, 0);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  list(): Watch[] {
    return this.file.get();
  }

  get(id: string): Watch | undefined {
    return this.file.get().find((w) => w.id === id);
  }

  views(): WatchView[] {
    return this.file.get().map((w) => ({
      id: w.id,
      url: w.url,
      title: w.title,
      ...(w.faviconUrl ? { faviconUrl: w.faviconUrl } : {}),
      intervalMinutes: w.intervalMinutes,
      paused: w.paused,
      checking: this.checking.has(w.id),
      lastCheckedAt: w.lastCheckedAt,
      lastChangedAt: w.lastChangedAt,
      lastResult: w.lastResult,
      ...(w.lastError ? { lastError: w.lastError } : {}),
      changeSummary: w.changeSummary,
      unseen: w.unseen,
      ...(w.condition ? { condition: w.condition } : {}),
      ...(typeof w.conditionMet === "boolean" ? { conditionMet: w.conditionMet } : {}),
      ...(w.conditionDetail ? { conditionDetail: w.conditionDetail } : {}),
    }));
  }

  unseenCount(): number {
    return this.file.get().filter((w) => w.unseen).length;
  }

  private commit(list: Watch[]): void {
    this.file.set(list);
    this.emit();
  }

  /** Add a watch (deduped by URL). Returns null when the per-profile cap is reached. */
  add(input: { url: string; title: string; faviconUrl?: string; intervalMinutes: number }): Watch | null {
    const list = this.file.get();
    const existing = list.find((w) => w.url === input.url);
    if (existing) return existing;
    if (list.length >= this.maxWatches()) return null;
    const watch: Watch = {
      id: crypto.randomUUID(),
      url: input.url,
      title: input.title || input.url,
      ...(input.faviconUrl ? { faviconUrl: input.faviconUrl } : {}),
      intervalMinutes: clampInterval(input.intervalMinutes),
      createdAt: Date.now(),
      paused: false,
      lastCheckedAt: null,
      lastChangedAt: null,
      lastResult: "pending",
      fingerprint: null,
      baseline: "",
      changeSummary: "",
      unseen: false,
    };
    this.commit([...list, watch]);
    return watch;
  }

  remove(id: string): void {
    this.checking.delete(id);
    this.commit(this.file.get().filter((w) => w.id !== id));
  }

  update(id: string, patch: Partial<Watch>): void {
    const list = this.file.get();
    if (!list.some((w) => w.id === id)) return;
    this.commit(list.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }

  pause(id: string, paused: boolean): void {
    this.update(id, { paused });
  }

  setInterval(id: string, minutes: number): void {
    this.update(id, { intervalMinutes: clampInterval(minutes) });
  }

  /** Sets or clears ("") the "Notify me when…" condition; its state starts over. */
  setCondition(id: string, condition: string): void {
    const list = this.file.get();
    const clean = cleanCondition(condition);
    this.commit(
      list.map((w) => {
        if (w.id !== id) return w;
        const { condition: _c, conditionMet: _m, conditionDetail: _d, ...rest } = w;
        return clean ? { ...rest, condition: clean } : rest;
      }),
    );
  }

  acknowledge(id?: string): void {
    const list = this.file.get();
    this.commit(list.map((w) => (w.unseen && (id === undefined || w.id === id) ? { ...w, unseen: false } : w)));
  }

  setChecking(id: string, checking: boolean): void {
    if (checking) this.checking.add(id);
    else this.checking.delete(id);
    this.emit();
  }

  /** The syncable definition of every watch (URL-keyed), without this device's monitoring state. */
  syncList(): SyncedWatch[] {
    return this.file.get().map(toSyncedWatch);
  }

  /**
   * Apply definitions from sync, keyed by URL. An upsert updates an existing watch's definition
   * fields (keeping this device's monitoring state) or creates a fresh one; a tombstone removes the
   * watch. New watches respect the per-profile cap: a declined one is simply left out of syncList()
   * so the engine forgets it instead of deleting it on other devices. Flushed before returning.
   */
  applyRemote(changes: Array<{ url: string; def: SyncedWatch | null }>): void {
    const before = this.file.get();
    const byUrl = new Map(before.map((w) => [w.url, w]));
    let dirty = false;
    for (const { url, def } of changes) {
      if (def === null) {
        const existing = byUrl.get(url);
        if (existing) {
          byUrl.delete(url);
          this.checking.delete(existing.id);
          dirty = true;
        }
        continue;
      }
      const existing = byUrl.get(url);
      if (existing) {
        const condition = cleanCondition(def.condition);
        const { condition: before, conditionMet, conditionDetail, ...rest } = existing;
        // A condition changed on another device starts over here.
        const same = (before ?? "") === condition;
        const next: Watch = {
          ...rest,
          title: def.title,
          ...(def.faviconUrl ? { faviconUrl: def.faviconUrl } : {}),
          intervalMinutes: clampInterval(def.intervalMinutes),
          paused: def.paused,
          ...(condition ? { condition } : {}),
          ...(condition && same && conditionMet !== undefined ? { conditionMet } : {}),
          ...(condition && same && conditionDetail ? { conditionDetail } : {}),
        };
        if (JSON.stringify(next) !== JSON.stringify(existing)) {
          byUrl.set(url, next);
          dirty = true;
        }
      } else if (byUrl.size < this.maxWatches()) {
        byUrl.set(url, {
          id: crypto.randomUUID(),
          url: def.url,
          title: def.title || def.url,
          ...(def.faviconUrl ? { faviconUrl: def.faviconUrl } : {}),
          intervalMinutes: clampInterval(def.intervalMinutes),
          createdAt: def.createdAt,
          paused: def.paused,
          lastCheckedAt: null,
          lastChangedAt: null,
          lastResult: "pending",
          fingerprint: null,
          baseline: "",
          changeSummary: "",
          unseen: false,
          ...(cleanCondition(def.condition) ? { condition: cleanCondition(def.condition) } : {}),
        });
        dirty = true;
      }
    }
    if (!dirty) return;
    this.file.set([...byUrl.values()]);
    this.file.flush();
    this.emit();
  }

  isChecking(id: string): boolean {
    return this.checking.has(id);
  }

  flush(): void {
    this.file.flush();
  }
}
