/**
 * The phone's copy of the synced collections it shows (decrypted records, keyed by their id).
 * Each refresh pulls what changed since the last one. A collection that a newer version of the
 * app starts showing is fetched in full once, since earlier pulls skipped it.
 */
import { parseDeviceTabs, type DeviceInfo, type DeviceTabs, type SyncCollection, type SyncItem, type SyncStateStorage } from '@corvus/shared';
import type { CorvusSyncClient } from '@corvus/sync-core';

import type { Progress } from './refresh';

export type ReplicaClient = Pick<CorvusSyncClient, 'cursor' | 'pullPages' | 'pullCollection' | 'forgetCollection'>;

/** What the phone shows, in the order it was added to the app. */
export const PHONE_COLLECTIONS: readonly SyncCollection[] = ['open_tabs', 'sent_tabs', 'bookmarks', 'reading', 'history', 'watches', 'watch_status', 'asks', 'assist_history', 'settings', 'chain_server'];

export class Replica {
  private readonly cache = new Map<SyncCollection, Record<string, unknown>>();
  private readonly unsaved = new Set<SyncCollection>();

  /** `prefix` scopes the data to one chain, e.g. `corvus-sync/<chain id>/` (cleared on unpair). */
  constructor(
    private readonly storage: SyncStateStorage,
    private readonly prefix: string,
    readonly collections: readonly SyncCollection[] = PHONE_COLLECTIONS,
  ) {}

  async records(collection: SyncCollection): Promise<Record<string, unknown>> {
    let records = this.cache.get(collection);
    if (!records) {
      records = parse(await this.storage.get(`${this.prefix}data/${collection}`));
      this.cache.set(collection, records);
    }
    return records;
  }

  /**
   * Pulls the chain's changes into the replica; returns how many records changed. `progress` hears
   * each step (a download, saving a collection), so a refresh that stops moving can be told apart.
   */
  async sync(client: ReplicaClient, progress: Progress = () => undefined): Promise<number> {
    progress({ kind: 'download' });
    const joined = new Set(parseList(await this.storage.get(`${this.prefix}data/joined`)));
    let count = 0;
    const apply = async (items: SyncItem[]): Promise<void> => {
      const changed = new Set<SyncCollection>();
      for (const item of items) {
        if (!this.collections.includes(item.collection)) continue;
        const records = await this.records(item.collection);
        if (item.deleted || item.payload === null) delete records[item.id];
        else records[item.id] = item.payload;
        changed.add(item.collection);
        count++;
      }
      for (const collection of changed) {
        progress({ kind: 'save', collection });
        await this.save(collection);
      }
      // The client asks for the next page (or saves its cursor) next.
      progress({ kind: 'download' });
    };

    // Before the first pull the main cursor starts at 0 and brings every collection.
    if ((await client.cursor()) > 0) {
      for (const collection of this.collections) {
        if (joined.has(collection)) continue;
        await client.forgetCollection(collection);
        await client.pullCollection(collection, apply);
      }
    }
    await client.pullPages(apply);
    progress({ kind: 'finish' });
    await this.storage.set(`${this.prefix}data/joined`, JSON.stringify([...this.collections]));
    return count;
  }

  /** Records a change this phone pushed itself (null removes the record). */
  async put(collection: SyncCollection, id: string, payload: unknown): Promise<void> {
    const records = await this.records(collection);
    if (payload === null) delete records[id];
    else records[id] = payload;
    await this.save(collection);
  }

  /**
   * Records a change in memory only, saved with the collection's next save or `flush()`: the
   * browser's visits, which would otherwise write the whole history on every page.
   */
  async putSoon(collection: SyncCollection, id: string, payload: unknown): Promise<void> {
    const records = await this.records(collection);
    if (payload === null) delete records[id];
    else records[id] = payload;
    this.unsaved.add(collection);
  }

  /** Saves what `putSoon` changed. */
  async flush(): Promise<void> {
    for (const collection of [...this.unsaved]) await this.save(collection);
  }

  private async save(collection: SyncCollection): Promise<void> {
    this.unsaved.delete(collection);
    await this.storage.set(`${this.prefix}data/${collection}`, JSON.stringify(await this.records(collection)));
  }
}

export interface ComputerTabs extends DeviceTabs {
  deviceId: string;
}

/**
 * The tabs each other device of the chain has open, most recently changed first. Devices that left
 * the chain are dropped (their last record can outlive them), and so are devices with no tabs.
 */
export function computerTabs(records: Record<string, unknown>, devices: readonly DeviceInfo[], self: string | null): ComputerTabs[] {
  const known = new Set(devices.map((d) => d.id));
  const out: ComputerTabs[] = [];
  for (const [deviceId, raw] of Object.entries(records)) {
    if (deviceId === self || (devices.length > 0 && !known.has(deviceId))) continue;
    const tabs = parseDeviceTabs(raw);
    if (tabs && tabs.tabs.length > 0) out.push({ ...tabs, deviceId });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Tabs whose title or address contains every word of `query`; computers left with none are dropped. */
export function filterTabs(computers: readonly ComputerTabs[], query: string): ComputerTabs[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...computers];
  return computers
    .map((c) => ({ ...c, tabs: c.tabs.filter((t) => words.every((w) => `${t.title} ${t.url}`.toLowerCase().includes(w))) }))
    .filter((c) => c.tabs.length > 0);
}

/** The host shown under a page's title ("example.com" for https://www.example.com/a); its tile's letter is the site's (lib/favicon.ts). */
export function tabHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function parse(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
