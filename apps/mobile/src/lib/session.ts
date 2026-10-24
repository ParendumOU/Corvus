/**
 * The phone's pairing with a sync chain: the recovery phrase lives in the OS's secure storage
 * (Keychain / Keystore), the sync client's own state (device id, cursor) in app storage. On the
 * web build, used only for automated checks, both are in local storage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  OTHER_FOLDER_ID,
  isReadingItem,
  isSyncedWatch,
  linkOnlyReadingItem,
  withReadState,
  type Bookmark,
  type DeviceInfo,
  type PairingInfo,
  type ReadingItem,
  type SentTab,
  type SentTabRecord,
  type SyncCollection,
  type SyncedHistoryEntry,
  type SyncStateStorage,
} from '@corvus/shared';
import { createSyncClient, type CorvusSyncClient } from '@corvus/sync-core';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { dataStore } from '@/lib/data-store';
import { historyList } from '@/lib/history';
import { bookmarkList, nextPosition, readingList } from '@/lib/library';
import { watchFor, watchList, type WatchView } from '@/lib/watches';
import { Replica, computerTabs, type ComputerTabs } from '@/lib/replica';
import { outbox } from '@/lib/send';

const PAIRING_KEY = 'corvus.pairing';
const SYNC_STATE_PREFIX = 'corvus-sync/';

export interface Pairing extends PairingInfo {
  chainId: string;
  deviceName: string;
  pairedAt: number;
}

const secrets =
  Platform.OS === 'web'
    ? {
        get: (key: string) => AsyncStorage.getItem(key),
        set: (key: string, value: string) => AsyncStorage.setItem(key, value),
        remove: (key: string) => AsyncStorage.removeItem(key),
      }
    : {
        get: (key: string) => SecureStore.getItemAsync(key),
        set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
        remove: (key: string) => SecureStore.deleteItemAsync(key),
      };

const syncState: SyncStateStorage = {
  get: async (key) => (await AsyncStorage.getItem(key)) ?? undefined,
  set: (key, value) => AsyncStorage.setItem(key, value),
};

// One client and one replica per chain, so pulls and pushes share the known record versions.
const clients = new Map<string, CorvusSyncClient>();
const replicas = new Map<string, Replica>();

export function clientFor(pairing: Pairing): CorvusSyncClient {
  let client = clients.get(pairing.chainId);
  if (!client) {
    client = createSyncClient({
      serverUrl: pairing.serverUrl,
      phrase: pairing.phrase,
      deviceName: pairing.deviceName,
      platform: Platform.OS,
      storage: syncState,
    });
    clients.set(pairing.chainId, client);
  }
  return client;
}

/** The synced data kept on the phone for this chain (removed with the rest when unpairing). */
export function replicaFor(pairing: Pairing): Replica {
  let replica = replicas.get(pairing.chainId);
  if (!replica) {
    replica = new Replica(dataStore, `${pairing.chainId}/`);
    replicas.set(pairing.chainId, replica);
  }
  return replica;
}

/** Version 0.1.0 kept the replica in AsyncStorage; it now lives in files (fetched again once). */
export async function dropLegacyReplica(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => /^corvus-sync\/[^/]+\/data\//.test(k));
  if (keys.length > 0) await AsyncStorage.multiRemove(keys);
}

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await secrets.get(PAIRING_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pairing;
  } catch {
    return null;
  }
}

/** Joins the chain as this phone (the server lists it among the chain's devices), then remembers it. */
export async function pair(info: PairingInfo, chainId: string, deviceName: string): Promise<Pairing> {
  const pairing: Pairing = { ...info, chainId, deviceName, pairedAt: Date.now() };
  await clientFor(pairing).register();
  await secrets.set(PAIRING_KEY, JSON.stringify(pairing));
  return pairing;
}

export interface ChainView {
  devices: DeviceInfo[];
  /** This phone's device id on the chain. */
  self: string;
  tabs: ComputerTabs[];
  /** Pages sent from this phone that are still waiting to be opened. */
  outbox: SentTabRecord[];
  bookmarks: Bookmark[];
  reading: ReadingItem[];
  /** History of every device, most recent first. */
  history: SyncedHistoryEntry[];
  /** Watched pages, with what the computers last saw. */
  watches: WatchView[];
}

async function view(pairing: Pairing, devices: DeviceInfo[]): Promise<ChainView> {
  const replica = replicaFor(pairing);
  const self = await clientFor(pairing).getDeviceId();
  return {
    devices,
    self,
    tabs: computerTabs(await replica.records('open_tabs'), devices, self),
    outbox: outbox(await replica.records('sent_tabs'), self),
    bookmarks: bookmarkList(await replica.records('bookmarks')),
    reading: readingList(await replica.records('reading')),
    history: historyList(await replica.records('history')),
    watches: watchList(await replica.records('watches'), await replica.records('watch_status'), devices),
  };
}

/** Pushes one change of this phone and keeps it in the replica. */
async function change(pairing: Pairing, collection: SyncCollection, id: string, payload: unknown): Promise<void> {
  const client = clientFor(pairing);
  const { conflicts } = await client.push([{ collection, id, payload, deleted: payload === null }]);
  // Another device changed the same record first: theirs wins, and the phone shows it.
  const remote = conflicts.find((c) => c.collection === collection && c.id === id);
  await replicaFor(pairing).put(collection, id, remote ? (remote.deleted ? null : remote.payload) : payload);
}

/** Saves a link to the reading list; a computer with Corvus fetches the article. */
export async function saveForLater(pairing: Pairing, url: string, title: string): Promise<void> {
  const existing = (await replicaFor(pairing).records('reading'))[url];
  if (isReadingItem(existing)) return;
  await change(pairing, 'reading', url, linkOnlyReadingItem(Crypto.randomUUID(), url, title, Date.now()));
}

/** Marks a reading list entry read or unread on every device. */
export async function markRead(pairing: Pairing, item: ReadingItem, read: boolean): Promise<void> {
  const current = (await replicaFor(pairing).records('reading'))[item.url];
  await change(pairing, 'reading', item.url, withReadState(isReadingItem(current) ? current : item, read ? Date.now() : null));
}

/** Watches a page (or changes how an existing watch checks it); the computers monitor it. */
export async function watchPage(pairing: Pairing, url: string, title: string, intervalMinutes: number, condition: string): Promise<void> {
  const existing = (await replicaFor(pairing).records('watches'))[url];
  await change(pairing, 'watches', url, watchFor(url, title, intervalMinutes, condition, Date.now(), isSyncedWatch(existing) ? existing : undefined));
}

/** Adds a bookmark at the end of "Other bookmarks". */
export async function addBookmark(pairing: Pairing, url: string, title: string): Promise<void> {
  const bookmarks = bookmarkList(await replicaFor(pairing).records('bookmarks'));
  const now = Date.now();
  const bookmark: Bookmark = {
    id: Crypto.randomUUID(),
    parentId: OTHER_FOLDER_ID,
    kind: 'bookmark',
    title,
    url,
    position: nextPosition(bookmarks, OTHER_FOLDER_ID),
    createdAt: now,
    updatedAt: now,
  };
  await change(pairing, 'bookmarks', bookmark.id, bookmark);
}

/** What the phone already has, without the network (shown before the first refresh). */
export function cachedView(pairing: Pairing, devices: DeviceInfo[] = []): Promise<ChainView> {
  return view(pairing, devices);
}

/** Lists the chain's devices and pulls what changed since the last refresh. */
export async function refreshView(pairing: Pairing): Promise<ChainView> {
  const client = clientFor(pairing);
  const devices = await client.listDevices();
  await replicaFor(pairing).sync(client);
  return view(pairing, devices);
}

const OLD_SERVER = 'Your sync server does not support sending pages yet: update it to the latest Corvus sync server.';

/** Sends a page to one of the chain's computers, which opens it on its next sync. */
export async function sendPage(pairing: Pairing, page: Pick<SentTab, 'url' | 'title' | 'to'>): Promise<SentTabRecord> {
  const client = clientFor(pairing);
  const id = Crypto.randomUUID();
  const payload: SentTab = { ...page, fromId: await client.getDeviceId(), from: pairing.deviceName, sentAt: Date.now() };
  await client.push([{ collection: 'sent_tabs', id, payload, deleted: false }]);
  if (client.unsupported().has('sent_tabs')) throw new Error(OLD_SERVER);
  await replicaFor(pairing).put('sent_tabs', id, payload);
  return { id, ...payload };
}

/** Takes back a page its computer has not opened yet. */
export async function cancelSent(pairing: Pairing, id: string): Promise<void> {
  await clientFor(pairing).push([{ collection: 'sent_tabs', id, payload: null, deleted: true }]);
  await replicaFor(pairing).put('sent_tabs', id, null);
}

/** Leaves the chain (best effort when offline) and forgets everything about it on the phone. */
export async function unpair(pairing: Pairing): Promise<void> {
  try {
    const client = clientFor(pairing);
    await client.removeDevice(await client.getDeviceId());
  } catch {
    // Offline or already removed: the computer can remove this phone from its device list.
  }
  await secrets.remove(PAIRING_KEY);
  clients.delete(pairing.chainId);
  replicas.delete(pairing.chainId);
  await dataStore.clear();
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(SYNC_STATE_PREFIX));
  if (keys.length > 0) await AsyncStorage.multiRemove(keys);
}
