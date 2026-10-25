import crypto from "node:crypto";
import type { SyncConflict } from "@corvus/sync-core";
import { isConflictCollection, type StoredConflict } from "../shared/sync-conflicts";
import { JsonFile } from "./json-file";

/** Kept: the newest conflicts up to this many, from the last MAX_AGE_MS. */
const MAX_CONFLICTS = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function revive(raw: unknown): StoredConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is StoredConflict =>
      !!c &&
      typeof c === "object" &&
      typeof (c as StoredConflict).id === "string" &&
      typeof (c as StoredConflict).recordId === "string" &&
      typeof (c as StoredConflict).at === "number" &&
      isConflictCollection(String((c as StoredConflict).collection)),
  );
}

/**
 * A profile's local changes that a newer change from another device replaced (sync-conflicts.json in
 * the profile folder), until the person brings one back or keeps the other. A newer conflict on the
 * same record replaces the older one.
 */
export class SyncConflictStore {
  private readonly file: JsonFile<StoredConflict[]>;
  private readonly listeners = new Set<() => void>();

  constructor(
    filePath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = JsonFile.load(filePath, () => [], revive, 0);
  }

  add(conflict: SyncConflict): void {
    if (!isConflictCollection(conflict.collection)) return;
    const collection = conflict.collection;
    const cutoff = this.now() - MAX_AGE_MS;
    const entry: StoredConflict = {
      id: crypto.randomUUID(),
      collection,
      recordId: conflict.id,
      local: conflict.local ?? null,
      remote: conflict.remote ?? null,
      at: this.now(),
    };
    this.file.update((list) =>
      [entry, ...list.filter((c) => c.at >= cutoff && !(c.collection === collection && c.recordId === conflict.id))].slice(0, MAX_CONFLICTS),
    );
    for (const l of this.listeners) l();
  }

  /** Newest first, without the expired ones. */
  list(): StoredConflict[] {
    const cutoff = this.now() - MAX_AGE_MS;
    return this.file.get().filter((c) => c.at >= cutoff);
  }

  /** Removes a conflict and returns it (null when it is gone). */
  take(id: string): StoredConflict | null {
    const found = this.file.get().find((c) => c.id === id) ?? null;
    if (found) {
      this.file.update((list) => list.filter((c) => c.id !== id));
      for (const l of this.listeners) l();
    }
    return found;
  }

  clear(): void {
    this.file.set([]);
    for (const l of this.listeners) l();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
