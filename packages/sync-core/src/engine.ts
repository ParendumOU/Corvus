import type { SyncCollection, SyncItem, SyncStateStorage } from "@corvus/shared";
import { sha256 } from "@noble/hashes/sha2.js";
import type { CorvusSyncClient } from "./client.js";
import { SYNC_COLLECTIONS, bytesToHex, stableStringify, utf8ToBytes } from "./encoding.js";

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
  /**
   * Called before this collection first takes part on the chain from this device: a fresh chain,
   * a collection added by an upgrade, or a category turned back on. Lets the adapter drop state
   * that only meant something relative to the chain (e.g. deletion markers recorded while it was
   * not syncing), so joining is a plain merge.
   */
  join?(): Promise<void> | void;
  /**
   * For a previously synced id that is no longer in list(): true when it was only dropped locally
   * (evicted by a local cap) and must stay on the chain. The engine then forgets it instead of
   * pushing a deletion.
   */
  retain?(id: string): boolean;
}

/**
 * A change this device made to an already synced record that a remote change replaced before it was
 * pushed: the remote change wins (it is applied), and this is what was lost here.
 */
export interface SyncConflict<T = unknown> {
  collection: SyncCollection;
  id: string;
  /** This device's version that lost; null when this device had deleted the record. */
  local: T | null;
  /** The version now applied; null when another device deleted the record. */
  remote: T | null;
}

export interface SyncEngineOptions {
  client: CorvusSyncClient;
  storage: SyncStateStorage;
  adapters: Partial<Record<SyncCollection, SyncAdapter<any>>>;
  /** Told about each local change a remote change replaced, in `conflictCollections` only. */
  onConflict?: (conflict: SyncConflict) => void | Promise<void>;
  /** Collections watched for conflicts (each applied page reads their local items once). */
  conflictCollections?: readonly SyncCollection[];
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
 * One sync cycle = join new collections -> pull (apply remote changes page by page) -> diff local
 * state against the last synced fingerprints -> push dirty items and tombstones -> apply conflicts
 * (remote wins). A local change to a synced record that a remote change replaces is reported to
 * onConflict (for the collections it watches), so the person can bring it back.
 *
 * Collections join and leave independently: a collection with an adapter that has not synced on
 * this chain yet (added by an upgrade, or turned back on) first pulls all of its records (filtered
 * by collection, the main cursor untouched) so nothing an older version skipped is missed; a
 * collection whose adapter went away (turned off) forgets what it synced, so turning it on again is
 * a fresh merge. Collections the server does not know (an older server) are skipped quietly.
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
    for (const collection of this.collections()) {
      await this.opts.storage.set(this.key(collection), "{}");
      await this.opts.storage.set(this.joinKey(collection), "0");
    }
    await this.opts.client.resetLocalState();
  }

  private async cycle(): Promise<SyncCycleResult> {
    const result: SyncCycleResult = { applied: 0, pushed: 0, deleted: 0, conflicts: 0 };
    const client = this.opts.client;

    for (const collection of SYNC_COLLECTIONS) {
      if (!this.opts.adapters[collection] && (await this.joined(collection))) await this.detach(collection);
    }
    const joining: SyncCollection[] = [];
    for (const collection of this.collections()) {
      if (!client.unsupported().has(collection) && !(await this.joined(collection))) joining.push(collection);
    }
    if (joining.length > 0) {
      // A device that never pulled gets everything from the main pull below; otherwise the joining
      // collection catches up on its own (an older version may have skipped its records).
      const fresh = (await client.cursor()) === 0;
      for (const collection of joining) {
        await this.opts.storage.set(this.joinKey(collection), "0");
        await this.opts.adapters[collection]!.join?.();
        if (fresh) continue;
        await client.forgetCollection(collection);
        await client.pullCollection(collection, async (items) => {
          result.applied += await this.applyRemote(items);
        });
      }
    }

    await client.pullPages(async (items) => {
      result.applied += await this.applyRemote(items);
    });

    const outgoing: SyncItem[] = [];
    for (const collection of this.collections()) {
      if (client.unsupported().has(collection)) continue;
      const adapter = this.opts.adapters[collection]!;
      const known = await this.load(collection);
      const live = new Set<string>();
      let forgot = false;
      for (const item of await adapter.list()) {
        live.add(item.id);
        if (known[item.id] !== fingerprint(item.payload)) {
          outgoing.push({ collection, id: item.id, payload: item.payload, deleted: false });
        }
      }
      for (const id of Object.keys(known)) {
        if (live.has(id)) continue;
        if (adapter.retain?.(id)) {
          delete known[id];
          forgot = true;
        } else outgoing.push({ collection, id, payload: null, deleted: true });
      }
      if (forgot) await this.save(collection);
    }

    if (outgoing.length > 0) await this.push(outgoing, result);
    for (const collection of joining) {
      if (client.unsupported().has(collection)) continue;
      await this.save(collection);
      await this.opts.storage.set(this.joinKey(collection), "1");
    }
    return result;
  }

  private async push(outgoing: SyncItem[], result: SyncCycleResult): Promise<void> {
    const { conflicts } = await this.opts.client.push(outgoing);
    const unsupported = this.opts.client.unsupported();
    const lost = new Set(conflicts.map((c) => `${c.collection}|${c.id}`));
    const touched = new Set<SyncCollection>();
    for (const item of outgoing) {
      if (unsupported.has(item.collection) || lost.has(`${item.collection}|${item.id}`)) continue;
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
  }

  /**
   * Whether this collection already takes part on the chain. State written before collections
   * joined independently has no join flag: a collection with recorded fingerprints counts as joined.
   */
  private async joined(collection: SyncCollection): Promise<boolean> {
    const flag = await this.opts.storage.get(this.joinKey(collection));
    if (flag !== undefined) return flag === "1";
    return Boolean(await this.opts.storage.get(this.key(collection)));
  }

  /** The collection stopped syncing here: forget its fingerprints and versions, keep local data. */
  private async detach(collection: SyncCollection): Promise<void> {
    this.fingerprints.delete(collection);
    await this.opts.storage.set(this.key(collection), "");
    await this.opts.storage.set(this.joinKey(collection), "0");
    await this.opts.client.forgetCollection(collection);
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
      const candidates = await this.overwritten(collection, adapter, group);
      await adapter.apply(group);
      const lost = candidates.length > 0 ? await this.stillLost(adapter, candidates) : [];
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
      for (const conflict of lost) {
        try {
          await this.opts.onConflict?.(conflict);
        } catch {
          // Reporting a conflict never stops a sync.
        }
      }
    }
    return applied;
  }

  /**
   * Local changes the remote items may replace: records synced before (a known fingerprint) that
   * this device changed or deleted since, where the remote version differs. Records never synced
   * from here (a fresh join, a new local item) are a merge, not a conflict.
   */
  private async overwritten(collection: SyncCollection, adapter: SyncAdapter, group: SyncItem[]): Promise<SyncConflict[]> {
    if (!this.opts.onConflict || !this.opts.conflictCollections?.includes(collection)) return [];
    const known = await this.load(collection);
    if (!group.some((item) => known[item.id] !== undefined)) return [];
    const local = new Map((await adapter.list()).map((item) => [item.id, item.payload] as const));
    const lost: SyncConflict[] = [];
    for (const item of group) {
      const synced = known[item.id];
      if (synced === undefined) continue;
      const here = local.has(item.id) ? local.get(item.id) : undefined;
      const remote = item.deleted ? null : item.payload;
      if (here === undefined) {
        // Deleted here since the last sync: a remote deletion agrees, a remote edit brings it back.
        if (remote !== null) lost.push({ collection, id: item.id, local: null, remote });
        continue;
      }
      const mine = fingerprint(here);
      if (mine === synced) continue;
      if (remote !== null && fingerprint(remote) === mine) continue;
      lost.push({ collection, id: item.id, local: here, remote });
    }
    return lost;
  }

  /**
   * The candidates whose local version is really gone once the adapter applied the remote items:
   * a store that keeps the newer edit (by its own timestamps) may have kept this device's change,
   * which then syncs as usual instead.
   */
  private async stillLost(adapter: SyncAdapter, candidates: SyncConflict[]): Promise<SyncConflict[]> {
    const after = new Map((await adapter.list()).map((item) => [item.id, fingerprint(item.payload)] as const));
    return candidates.filter((c) => (c.local === null ? after.has(c.id) : after.get(c.id) !== fingerprint(c.local)));
  }

  private collections(): SyncCollection[] {
    return (Object.keys(this.opts.adapters) as SyncCollection[]).filter((c) => this.opts.adapters[c]);
  }

  private key(collection: SyncCollection): string {
    return `corvus-sync/${this.opts.client.chainId}/engine/${collection}`;
  }

  private joinKey(collection: SyncCollection): string {
    return `corvus-sync/${this.opts.client.chainId}/engine-joined/${collection}`;
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
