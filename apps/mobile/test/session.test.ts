/**
 * The pairing's lifecycle in lib/session.ts against in-memory storage and a fake sync client: what a
 * refresh that began before unpairing may still do, and what starting over keeps.
 */
import { CHAIN_SERVER_ID, linkOnlyReadingItem } from '@corvus/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStorage = new Map<string, string>();
const files = new Map<string, string>();
const keychain = new Map<string, string>();
const pushes: { collection: string; id: string; deleted: boolean }[][] = [];

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => void asyncStorage.set(key, value),
    getAllKeys: async () => [...asyncStorage.keys()],
    multiRemove: async (keys: string[]) => keys.forEach((k) => asyncStorage.delete(k)),
  },
}));
vi.mock('../src/lib/data-store', () => ({
  dataStore: {
    get: async (key: string) => files.get(key),
    set: async (key: string, value: string) => void files.set(key, value),
    clear: async () => files.clear(),
  },
}));
vi.mock('../src/lib/secrets', () => ({
  secrets: {
    get: async (key: string) => keychain.get(key) ?? null,
    set: async (key: string, value: string) => void keychain.set(key, value),
    remove: async (key: string) => void keychain.delete(key),
  },
}));
let offline = false;
vi.mock('@corvus/sync-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@corvus/sync-core')>()),
  createSyncClient: () => ({
    getDeviceId: async () => 'phone',
    register: async () => undefined,
    resetLocalState: async () => undefined,
    removeDevice: async () => undefined,
    push: async (items: { collection: string; id: string; deleted: boolean }[]) => {
      if (offline) throw new TypeError('Network request failed');
      pushes.push(items.map(({ collection, id, deleted }) => ({ collection, id, deleted })));
      return { conflicts: [] };
    },
  }),
}));

const session = await import('../src/lib/session');

const PHRASE = 'abandon '.repeat(23) + 'art';
const SERVER = 'http://192.0.2.10:8797';
const OTHER = 'http://192.0.2.20:8797';
const pairingOf = (chainId: string) => session.pair({ serverUrl: SERVER, phrase: PHRASE }, chainId, 'Phone');
const ITEM = linkOnlyReadingItem('r1', 'https://example.com/a', 'A', 1);

beforeEach(() => {
  asyncStorage.clear();
  files.clear();
  keychain.clear();
  pushes.length = 0;
  offline = false;
  vi.unstubAllGlobals();
});

describe('a refresh that outlives its pairing', () => {
  it('does not write an unpaired chain back when another address of its server answers', async () => {
    const a = await pairingOf('chain-a');
    await session.replicaFor(a).put('chain_server', CHAIN_SERVER_ID, { urls: [SERVER, OTHER], at: 1, from: 'laptop' });
    // Unpaired while the other address was being asked.
    vi.stubGlobal('fetch', async () => {
      await session.unpair(a);
      return { ok: true };
    });

    expect(await session.otherAddress(a)).toBeNull();
    expect(await session.loadPairing()).toBeNull();
  });

  it('does not take the place of the chain paired since', async () => {
    const a = await pairingOf('chain-a');
    await session.replicaFor(a).put('chain_server', CHAIN_SERVER_ID, { urls: [SERVER, OTHER], at: 1, from: 'laptop' });
    vi.stubGlobal('fetch', async () => {
      await session.unpair(a);
      await pairingOf('chain-b');
      return { ok: true };
    });

    expect(await session.otherAddress(a)).toBeNull();
    expect((await session.loadPairing())?.chainId).toBe('chain-b');
  });

  it('does not follow an unpaired chain to its new server, nor clear what the phone keeps since', async () => {
    const a = await pairingOf('chain-a');
    await session.replicaFor(a).put('chain_server', CHAIN_SERVER_ID, { urls: [OTHER], at: 1, from: 'laptop' });
    vi.stubGlobal('fetch', async () => {
      await session.unpair(a);
      const b = await pairingOf('chain-b');
      await session.replicaFor(b).put('bookmarks', 'k', { id: 'k' });
      return { ok: true };
    });

    expect(await session.followChain(a)).toBeNull();
    expect((await session.loadPairing())?.chainId).toBe('chain-b');
    expect(files.get('chain-b/data/bookmarks')).toContain('"k"');
  });

  it('does not join again nor clear the new chain once unpaired', async () => {
    const a = await pairingOf('chain-a');
    await session.unpair(a);
    const b = await pairingOf('chain-b');
    await session.replicaFor(b).put('bookmarks', 'k', { id: 'k' });

    await expect(session.rejoin(a)).rejects.toThrow();
    expect(files.get('chain-b/data/bookmarks')).toContain('"k"');
  });

  it('follows another address while still paired', async () => {
    const a = await pairingOf('chain-a');
    await session.replicaFor(a).put('chain_server', CHAIN_SERVER_ID, { urls: [SERVER, OTHER], at: 1, from: 'laptop' });
    vi.stubGlobal('fetch', async () => ({ ok: true }));

    expect((await session.otherAddress(a))?.serverUrl).toBe(OTHER);
    expect((await session.loadPairing())?.serverUrl).toBe(OTHER);
  });
});

describe('joining again', () => {
  it('pushes a change made offline as it was, not as a deletion', async () => {
    const a = await pairingOf('chain-a');
    await session.replicaFor(a).put('reading', ITEM.url, ITEM);
    offline = true;
    await session.markRead(a, ITEM, true);
    offline = false;

    await session.rejoin(a);
    await session.refreshView(a).catch(() => undefined);

    expect(pushes[0]).toEqual([{ collection: 'reading', id: ITEM.url, deleted: false }]);
  });
});
