import type { SyncCollection, SyncItem, SyncStateStorage } from "@corvus/shared";
import { sha256 } from "@noble/hashes/sha2.js";
import type { CorvusSyncClient } from "./client.js";
import { bytesToHex, stableStringify, utf8ToBytes } from "./encoding.js";

export interface LocalItem<T = unknown> {
  id: string;
  payload: T;
}

/** Bridges one local store (bookmarks, history, ...) to the sync engine. */
export interface SyncAdapter<T = unknown> {
  /**
   * Every live local item of this collection. A previously synced item that disappears from the
   * list is pushed as a deletion.
   */
  list(): Promise<LocalItem<T>[]> | LocalItem<T>[];
  /**
   * Apply remote changes (upserts and tombstones) to the local store. Upserts may be declined
   * (left out of the next list()): the engine then forgets them instead of deleting them remotely.
   */
  apply(items: SyncItem<T>[]): Promise<void> | void;
}

export interface SyncEngineOptions {
  client: CorvusSyncClient;
  storage: SyncStateStorage;
  adapters: Partial<Record<SyncCollection, SyncAdapter<any>>>;
}

export interface SyncCycleResult {
  /** Remote changes applied to local adapters (pulled + push conflicts). */
  applied: number;
  /** Local upserts accepted by the server. */
  pushed: number;
  /** Local deletions (tombstones) accepted by the server. */
  deleted: number;
  /** Local changes rejected because the server held a newer version (remote won). */
  conflicts: number;
}

type Fingerprints = Record<string, string>;

export function fingerprint(payload: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(stableStringify(payload)))).slice(0, 32);
}

/**
 * One sync cycle = pull (apply remote changes page by page) -> diff local state against the last
 * synced fingerprints -> push dirty items and tombstones -> apply conflicts (remote wins).
 */
export class SyncEngine {
  private running: Promise<SyncCycleResult> | undefined;
  private readonly fingerprints = new Map<SyncCollection, Fingerprints>();

  constructor(private readonly opts: SyncEngineOptions) {}

  sync(): Promise<SyncCycleResult> {
    this.running ??= this.cycle().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Forget what was synced (e.g. after wipeChain or switching chains). */
  async reset(): Promise<void> {
    this.fingerprints.clear();
    for (const collection of this.collections()) await this.opts.storage.set(this.key(collection), "{}");
    await this.opts.client.resetLocalState();
  }

  private async cycle(): Promise<SyncCycleResult> {
    const result: SyncCycleResult = { applied: 0, pushed: 0, deleted: 0, conflicts: 0 };

    await this.opts.client.pullPages(async (items) => {
      result.applied += await this.applyRemote(items);
    });

    const outgoing: SyncItem[] = [];
    for (const collection of this.collections()) {
      const adapter = this.opts.adapters[collection]!;
      const known = await this.load(collection);
      const live = new Set<string>();
      for (const item of await adapter.list()) {
        live.add(item.id);
        if (known[item.id] !== fingerprint(item.payload)) {
          outgoing.push({ collection, id: item.id, payload: item.payload, deleted: false });
        }
      }
      for (const id of Object.keys(known)) {
        if (!live.has(id)) outgoing.push({ collection, id, payload: null, deleted: true });
      }
    }
    if (outgoing.length === 0) return result;

    const { conflicts } = await this.opts.client.push(outgoing);
    const lost = new Set(conflicts.map((c) => `${c.collection}|${c.id}`));
    const touched = new Set<SyncCollection>();
    for (const item of outgoing) {
      if (lost.has(`${item.collection}|${item.id}`)) continue;
      const known = await this.load(item.collection);
      if (item.deleted) {
        delete known[item.id];
        result.deleted++;
      } else {
        known[item.id] = fingerprint(item.payload);
        result.pushed++;
      }
      touched.add(item.collection);
    }
    for (const collection of touched) await this.save(collection);

    result.conflicts = conflicts.length;
    result.applied += await this.applyRemote(conflicts);
    return result;
  }

  private async applyRemote(items: SyncItem[]): Promise<number> {
    let applied = 0;
    const groups = new Map<SyncCollection, SyncItem[]>();
    for (const item of items) {
      if (!this.opts.adapters[item.collection]) continue;
      const group = groups.get(item.collection) ?? [];
      group.push(item);
      groups.set(item.collection, group);
    }
    for (const [collection, group] of groups) {
      const adapter = this.opts.adapters[collection]!;
      await adapter.apply(group);
      const known = await this.load(collection);
      const present = group.some((i) => !i.deleted) ? new Set((await adapter.list()).map((i) => i.id)) : new Set<string>();
      for (const item of group) {
        // An upsert the adapter did not keep (invalid, over a local cap, unknown to this version)
        // is forgotten instead of recorded; recording it would turn its absence from list() into a
        // tombstone that deletes it on every other device.
        if (item.deleted || !present.has(item.id)) delete known[item.id];
        else known[item.id] = fingerprint(item.payload);
      }
      await this.save(collection);
      applied += group.length;
    }
    return applied;
  }

  private collections(): SyncCollection[] {
    return (Object.keys(this.opts.adapters) as SyncCollection[]).filter((c) => this.opts.adapters[c]);
  }

  private key(collection: SyncCollection): string {
    return `corvus-sync/${this.opts.client.chainId}/engine/${collection}`;
  }

  private async load(collection: SyncCollection): Promise<Fingerprints> {
    let fps = this.fingerprints.get(collection);
    if (!fps) {
      const raw = await this.opts.storage.get(this.key(collection));
      fps = raw ? (JSON.parse(raw) as Fingerprints) : {};
      this.fingerprints.set(collection, fps);
    }
    return fps;
  }

  private async save(collection: SyncCollection): Promise<void> {
    await this.opts.storage.set(this.key(collection), JSON.stringify(await this.load(collection)));
  }
}
