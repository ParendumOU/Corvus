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

  /** The waiting changes as sync items, with what the replica holds now (gone from it: a deletion). */
  async items(source: OutboxSource): Promise<SyncItem[]> {
    const out: SyncItem[] = [];
    for (const key of await this.load()) {
      const [collection, id] = key.split(SEP) as [SyncCollection, string];
      const payload = (await source.records(collection))[id];
      out.push({ collection, id, payload: payload ?? null, deleted: payload === undefined || payload === null });
    }
    return out;
  }

  /** Forgets the changes that were pushed. */
  async done(items: readonly Pick<SyncItem, 'collection' | 'id'>[]): Promise<void> {
    const keys = await this.load();
    for (const item of items) keys.delete(`${item.collection}${SEP}${item.id}`);
    await this.save();
  }
}
