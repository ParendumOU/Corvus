/**
 * Changes made on the phone while its sync server was not reachable. The change itself is already in
 * the replica (the phone shows it); the outbox only remembers which records still have to be pushed,
 * and the next refresh pushes them with what the replica then holds. Pure, so it unit-tests in Node.
 */
import type { SyncCollection, SyncItem, SyncStateStorage } from '@corvus/shared';
import { isSyncCollection } from '@corvus/sync-core';

const SEP = '\u0000';

export interface OutboxSource {
  records(collection: SyncCollection): Promise<Record<string, unknown>>;
  /** True when the saved copy of `collection` could not be read: a record missing from it is not a deletion. */
  unreadable(collection: SyncCollection): Promise<boolean>;
}

export interface OutboxTarget {
  put(collection: SyncCollection, id: string, payload: unknown): Promise<void>;
}

export class Outbox {
  private keys: Set<string> | null = null;

  /** `key`: where the list is kept, e.g. `corvus-sync/<chain id>/outbox`. */
  constructor(
    private readonly storage: SyncStateStorage,
    private readonly key: string,
  ) {}

  private async load(): Promise<Set<string>> {
    if (!this.keys) {
      let list: unknown = [];
      try {
        list = JSON.parse((await this.storage.get(this.key)) ?? '[]');
      } catch {
        list = [];
      }
      this.keys = new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string' && isSyncCollection(k.split(SEP)[0] ?? '')) : []);
    }
    return this.keys;
  }

  private async save(): Promise<void> {
    await this.storage.set(this.key, JSON.stringify([...(await this.load())]));
  }

  async add(collection: SyncCollection, id: string): Promise<void> {
    (await this.load()).add(`${collection}${SEP}${id}`);
    await this.save();
  }

  async size(): Promise<number> {
    return (await this.load()).size;
  }

  /**
   * The waiting changes as sync items, with what the replica holds now (gone from it: a deletion).
   * A change in a collection whose saved copy could not be read is left out: it waits until the
   * collection was fetched again, else every change there would go out as a deletion.
   */
  async items(source: OutboxSource): Promise<SyncItem[]> {
    const out: SyncItem[] = [];
    for (const { collection, id } of await this.entries()) {
      if (await source.unreadable(collection)) continue;
      const payload = (await source.records(collection))[id];
      out.push({ collection, id, payload: payload ?? null, deleted: payload === undefined || payload === null });
    }
    return out;
  }

  /** The records that wait, without their changes. */
  async entries(): Promise<Pick<SyncItem, 'collection' | 'id'>[]> {
    return [...(await this.load())].map((key) => {
      const [collection, id] = key.split(SEP) as [SyncCollection, string];
      return { collection, id };
    });
  }

  /** Forgets the changes that were pushed. */
  async done(items: readonly Pick<SyncItem, 'collection' | 'id'>[]): Promise<void> {
    const keys = await this.load();
    for (const item of items) keys.delete(`${item.collection}${SEP}${item.id}`);
    await this.save();
  }
}

/**
 * Starts the phone's copy over (`reset` empties it and returns the new one) while changes still wait
 * to be pushed: they are put back into the new copy, so the next push sends them as they were, never
 * as deletions of records the empty copy no longer holds (a reading list entry marked read offline
 * would otherwise be deleted on every device).
 */
export async function startOver(outbox: Outbox, from: OutboxSource, reset: () => Promise<OutboxTarget>): Promise<void> {
  const known = await outbox.items(from);
  // Changes whose record could not be read are dropped: the empty copy would push them as deletions.
  const unknown = (await outbox.entries()).filter((e) => !known.some((k) => k.collection === e.collection && k.id === e.id));
  if (unknown.length > 0) await outbox.done(unknown);
  const waiting = known.filter((item) => !item.deleted);
  const fresh = await reset();
  for (const item of waiting) await fresh.put(item.collection, item.id, item.payload);
}
