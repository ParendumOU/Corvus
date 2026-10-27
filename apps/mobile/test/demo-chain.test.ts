/**
 * The phone's refresh on the demo chain the store reviewers pair with (regression: Corvus for mobile
 * stayed on "Loading…" with the refresh spinner after pairing with it). The records are encrypted
 * with a real phrase and served by a fake sync server, then go through the app's own pull
 * (sync-core client, Replica, pullChain) and what every screen derives from them. Stalls in the
 * download or in saving must end the refresh with an error, never leave it waiting.
 */
import type { DeviceInfo, EncryptedRecord, SyncItem, SyncStateStorage } from '@corvus/shared';
import { SyncError, createSyncClient, deriveKeys, encryptRecord, generateRecoveryPhrase } from '@corvus/sync-core';
import { describe, expect, it } from 'vitest';

import { pullChain } from '../src/lib/chain-view';
import { groupByDay } from '../src/lib/history';
import { folderContents, folderPath, searchBookmarks } from '../src/lib/library';
import { pendingNotifications } from '../src/lib/notify-rules';
import { RefreshStalled, SingleFlight, describeStep, watchdog, type RefreshStep } from '../src/lib/refresh';
import { Replica, filterTabs } from '../src/lib/replica';
import { sendTargets } from '../src/lib/send';
import { changedRecently } from '../src/lib/watches';
import { DESKTOP, LAPTOP, demoRecords, welcomePages } from './fixtures/demo-chain';

const PHONE = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function memory(overrides: { stuckKeys?: RegExp } = {}): SyncStateStorage {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => {
      if (overrides.stuckKeys?.test(k)) return never<void>();
      map.set(k, v);
    },
  };
}

/** The sync server as the phone sees it: the chain's encrypted records in order, served in pages. */
class FakeServer {
  readonly phrase = generateRecoveryPhrase();
  private readonly keys = deriveKeys(this.phrase);
  private readonly rows: EncryptedRecord[] = [];
  readonly requests: string[] = [];
  /** 'body': the records' answer arrives but its body never finishes (a stalled fetch). */
  stall: 'none' | 'body' = 'none';

  constructor(private readonly pageSize = 25) {}

  write(deviceId: string, items: SyncItem[]): void {
    for (const it of items) {
      const rec = encryptRecord(this.keys, { collection: it.collection, naturalId: it.id, version: 1, deviceId, deleted: it.deleted, payload: it.payload });
      this.rows.push({ ...rec, updatedAt: this.rows.length + 1 });
    }
  }

  devices(now: number): DeviceInfo[] {
    return [
      { id: LAPTOP.id, name: LAPTOP.name, platform: LAPTOP.platform, lastSeen: now },
      { id: DESKTOP.id, name: DESKTOP.name, platform: DESKTOP.platform, lastSeen: now },
      { id: PHONE, name: 'Pixel 8', platform: 'android', lastSeen: now },
    ];
  }

  readonly fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    this.requests.push(url.pathname.replace(/^.*\/chains\/[^/]+/, '') + url.search);
    if (url.pathname.endsWith('/devices')) return Response.json({ devices: this.devices(Date.now()) });
    const since = Number(url.searchParams.get('since') ?? 0);
    const collection = url.searchParams.get('collection');
    const rows = this.rows.map((r, i) => ({ r, seq: i + 1 })).filter(({ r, seq }) => seq > since && (!collection || r.collection === collection));
    const page = rows.slice(0, this.pageSize);
    if (this.stall === 'body') return { ok: true, status: 200, json: () => never<unknown>() } as unknown as Response;
    return Response.json({ records: page.map(({ r }) => r), cursor: page.at(-1)?.seq ?? since, hasMore: rows.length > page.length });
  }) as typeof globalThis.fetch;

  client(storage: SyncStateStorage, requestTimeoutMs = 5_000) {
    void storage.set(`corvus-sync/${this.keys.chainId}/deviceId`, PHONE);
    return createSyncClient({ serverUrl: 'https://sync-demo.invalid', phrase: this.phrase, deviceName: 'Pixel 8', platform: 'android', storage, fetch: this.fetch, requestTimeoutMs });
  }
}

function demoServer(now: number): FakeServer {
  const server = new FakeServer();
  const records = demoRecords(now);
  server.write(LAPTOP.id, records.laptop);
  server.write(DESKTOP.id, records.desktop);
  return server;
}

describe('the demo chain on the phone', () => {
  it('pulls the whole chain in pages and shows every screen', async () => {
    const now = Date.now();
    const server = demoServer(now);
    const replica = new Replica(memory(), 'chain/');
    const steps: RefreshStep[] = [];
    const started = performance.now();
    const view = await watchdog((progress) => pullChain(server.client(memory()), replica, (s) => (steps.push(s), progress(s))), 2_000);
    expect(performance.now() - started).toBeLessThan(5_000);

    // 63 records (as on the demo server) in pages of 25: the cursor moves on until the server has no more.
    expect(server.requests).toEqual(['/devices', '/records?since=0', '/records?since=25', '/records?since=50']);
    expect(steps[0]).toEqual({ kind: 'devices' });
    expect(steps.at(-1)).toEqual({ kind: 'view' });
    expect(steps).toContainEqual({ kind: 'save', collection: 'bookmarks' });

    // Home: both computers' tabs, with pins and groups, the computer used last first.
    expect(view.tabs.map((c) => `${c.device}: ${c.tabs.length}`)).toEqual(['Demo laptop: 11', 'Work desktop: 5']);
    expect(view.tabs[0]!.tabs.filter((t) => t.pinned)).toHaveLength(2);
    expect(view.tabs[0]!.tabs.filter((t) => t.group?.title === 'Lisbon trip')).toHaveLength(3);
    expect(filterTabs(view.tabs, 'mdn').flatMap((c) => c.tabs)).toHaveLength(3);
    expect(sendTargets(view.devices, view.self, view.tabs).map((d) => d.name)).toEqual(['Demo laptop', 'Work desktop']);
    expect(view.watches).toHaveLength(3);
    expect(changedRecently(view.watches, now)).toBe(2);

    // Library: bookmarks in their folders, the reading list, history by day, conversations.
    expect(view.bookmarks).toHaveLength(21);
    expect(folderContents(view.bookmarks, 'bar').map((b) => b.title)).toEqual(['Wikipedia', 'MDN Web Docs', 'Travel', 'Recipes', 'Developer docs']);
    expect(folderContents(view.bookmarks, 'demo-folder-dev')).toHaveLength(5);
    expect(folderContents(view.bookmarks, 'other')).toHaveLength(2);
    expect(folderPath(view.bookmarks, 'demo-folder-travel').map((f) => f.title)).toEqual(['Bookmarks bar', 'Travel']);
    expect(searchBookmarks(view.bookmarks, 'wikipedia').length).toBeGreaterThan(3);
    expect(view.reading.map((r) => r.readAt === undefined)).toEqual([true, true, true, false, false]);
    expect(view.history).toHaveLength(29);
    const days = groupByDay(view.history, now);
    expect(days.length).toBeGreaterThanOrEqual(5);
    expect(days.flatMap((d) => d.entries)).toHaveLength(29);
    expect(view.conversations.map((c) => c.turns.length)).toEqual([2, 1]);
    expect(view.inbox).toEqual([]);
    expect(pendingNotifications(view.inbox, view.watches, null).notes).toEqual([]);
  });

  it('picks up the pages the demo laptop sends once the phone has paired', async () => {
    const now = Date.now();
    const server = demoServer(now);
    const storage = memory();
    const client = server.client(storage);
    const replica = new Replica(memory(), 'chain/');
    await pullChain(client, replica);
    server.write(LAPTOP.id, welcomePages(PHONE, now));
    server.requests.length = 0;
    const view = await watchdog((progress) => pullChain(client, replica, progress), 2_000);
    expect(server.requests).toEqual(['/devices', '/records?since=63']);
    expect(view.inbox.map((p) => p.title)).toEqual(['Sintra – Travel guide at Wikivoyage', 'Pastel de nata - Wikipedia']);
    expect(view.tabs).toHaveLength(2);
  });
});

describe('a refresh never hangs', () => {
  it('fails when the download never finishes (the fetch gives up), and the next refresh works', async () => {
    const server = demoServer(Date.now());
    server.stall = 'body';
    const replica = new Replica(memory(), 'chain/');
    const client = server.client(memory(), 50);
    const err = await watchdog((progress) => pullChain(client, replica, progress), 1_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).code).toBe('timeout');

    server.stall = 'none';
    const view = await watchdog((progress) => pullChain(client, replica, progress), 1_000);
    expect(view.tabs).toHaveLength(2);
  });

  it('fails with the step it was stuck on when saving never finishes', async () => {
    const server = demoServer(Date.now());
    const replica = new Replica(memory({ stuckKeys: /data\/bookmarks$/ }), 'chain/');
    const err = await watchdog((progress) => pullChain(server.client(memory()), replica, progress), 100).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefreshStalled);
    expect((err as RefreshStalled).step).toEqual({ kind: 'save', collection: 'bookmarks' });
    expect((err as RefreshStalled).message).toBe(`Refreshing stopped while ${describeStep({ kind: 'save', collection: 'bookmarks' })}. Pull down to try again.`);
  });

  it('gives a refresh that keeps moving all the time it needs', async () => {
    const result = await watchdog(async (progress) => {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 30));
        progress({ kind: 'download' });
      }
      return 'done';
    }, 60);
    expect(result).toBe('done');
  });

  it('runs one refresh at a time, and starts a new one once it has failed', async () => {
    const flight = new SingleFlight<string>();
    let runs = 0;
    const stuck = () => watchdog<string>(() => (runs++, never<string>()), 30);
    const a = flight.run(stuck);
    const b = flight.run(stuck);
    expect(b).toBe(a);
    expect(flight.running).toBe(true);
    await expect(a).rejects.toBeInstanceOf(RefreshStalled);
    expect(flight.running).toBe(false);
    await expect(flight.run(async () => 'fresh')).resolves.toBe('fresh');
    expect(runs).toBe(1);
  });
});
