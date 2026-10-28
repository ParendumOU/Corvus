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
  newAsk,
  parseSyncedHistory,
  withReadState,
  type AskFollowUp,
  type AskRecord,
  type Bookmark,
  type DeviceInfo,
  type DeviceTabs,
  type PairingInfo,
  type ReadingItem,
  type SentTab,
  type SentTabRecord,
  type SyncCollection,
  type SyncStateStorage,
  type SyncedHistoryEntry,
} from '@corvus/shared';
import { createSyncClient, type CorvusSyncClient } from '@corvus/sync-core';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { chainView, pullChain, type ChainView } from '@/lib/chain-view';
import { dataStore } from '@/lib/data-store';
import { bookmarkList, nextPosition } from '@/lib/library';
import type { Progress } from '@/lib/refresh';
import { Replica } from '@/lib/replica';
import { mergeVisit, retitled } from '@/lib/visits';
import { watchFor } from '@/lib/watches';
import { t } from './i18n';

export type { ChainView } from '@/lib/chain-view';

const PAIRING_KEY = 'corvus.pairing';
/**
 * A request (reading its answer included) that takes longer fails: the phone's fetch never gives up
 * by itself, and a pull stuck on one would keep the home screen loading forever.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
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
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onInvalidRecord: (record, err) => console.warn(`[corvus] skipped sync record ${record.collection}/${record.id}: ${err instanceof Error ? err.message : String(err)}`),
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

/** True when both are the same chain (the stored pairing reads back as a new object). */
export function sameChain(a: Pairing | null, b: Pairing | null): boolean {
  return a !== null && b !== null && a.chainId === b.chainId;
}

async function view(pairing: Pairing, devices: DeviceInfo[], progress: Progress): Promise<ChainView> {
  progress({ kind: 'view' });
  return chainView(replicaFor(pairing), devices, await clientFor(pairing).getDeviceId());
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

/**
 * Adds a visit of the phone's browser to the chain's history (one record per address, merged with
 * what the computers recorded): kept in the replica at once, pushed with the next `pushVisits`.
 * Returns the entry as it now stands.
 */
export async function addVisit(pairing: Pairing, visit: { url: string; title: string }, now: number): Promise<SyncedHistoryEntry> {
  const replica = replicaFor(pairing);
  const entry = mergeVisit((await replica.records('history'))[visit.url], visit, now);
  await replica.putSoon('history', visit.url, entry);
  pendingVisits(pairing).add(visit.url);
  return entry;
}

/** The title a page showed once it loaded, on its history entry (pushed with the next `pushVisits`). */
export async function retitleVisit(pairing: Pairing, url: string, title: string): Promise<void> {
  const replica = replicaFor(pairing);
  const entry = retitled((await replica.records('history'))[url], title);
  if (!entry) return;
  await replica.putSoon('history', url, entry);
  pendingVisits(pairing).add(url);
}

const visitQueues = new Map<string, Set<string>>();
const pendingVisits = (pairing: Pairing): Set<string> => {
  let queue = visitQueues.get(pairing.chainId);
  if (!queue) visitQueues.set(pairing.chainId, (queue = new Set()));
  return queue;
};

/**
 * Pushes the visits recorded since the last push. A computer that changed the same entry meanwhile
 * wins the record, and the phone's visit is counted on top of it; what fails waits for the next push.
 */
export async function pushVisits(pairing: Pairing): Promise<void> {
  const queue = pendingVisits(pairing);
  if (queue.size === 0) return;
  const urls = [...queue];
  queue.clear();
  const replica = replicaFor(pairing);
  await replica.flush();
  try {
    const records = await replica.records('history');
    const items = urls.filter((url) => records[url]).map((url) => ({ collection: 'history' as const, id: url, payload: records[url], deleted: false }));
    const { conflicts } = await clientFor(pairing).push(items);
    const retry = [];
    for (const remote of conflicts) {
      if (remote.collection !== 'history' || remote.deleted) continue;
      const mine = parseSyncedHistory(records[remote.id]);
      const theirs = parseSyncedHistory(remote.payload);
      if (!mine || !theirs) continue;
      const merged: SyncedHistoryEntry = { ...theirs, title: mine.title || theirs.title, visitedAt: Math.max(mine.visitedAt, theirs.visitedAt), visitCount: theirs.visitCount + 1 };
      await replica.put('history', remote.id, merged);
      retry.push({ collection: 'history' as const, id: remote.id, payload: merged, deleted: false });
    }
    if (retry.length > 0) await clientFor(pairing).push(retry);
  } catch (err) {
    for (const url of urls) queue.add(url);
    throw err;
  }
}

/**
 * Shows the phone's open tabs on the computers: this phone's `open_tabs` record (keyed by its device
 * id, as every device publishes its own), or none once no tab is open.
 */
export async function publishOpenTabs(pairing: Pairing, record: DeviceTabs): Promise<void> {
  const client = clientFor(pairing);
  const id = await client.getDeviceId();
  const empty = record.tabs.length === 0;
  await client.push([{ collection: 'open_tabs', id, payload: empty ? null : record, deleted: empty }]);
}

/** Removes every bookmark of a page (the browser's star), on every device. */
export async function removeBookmarksOf(pairing: Pairing, url: string): Promise<void> {
  const records = await replicaFor(pairing).records('bookmarks');
  const ids = bookmarkList(records)
    .filter((b) => b.kind === 'bookmark' && b.url === url)
    .map((b) => b.id);
  if (ids.length === 0) return;
  await clientFor(pairing).push(ids.map((id) => ({ collection: 'bookmarks' as const, id, payload: null, deleted: true })));
  for (const id of ids) await replicaFor(pairing).put('bookmarks', id, null);
}

/** What the phone already has, without the network (shown before the first refresh). */
export function cachedView(pairing: Pairing, devices: DeviceInfo[] = [], progress: Progress = () => undefined): Promise<ChainView> {
  return view(pairing, devices, progress);
}

/** Lists the chain's devices and pulls what changed since the last refresh; `progress` hears each step. */
export function refreshView(pairing: Pairing, progress: Progress = () => undefined): Promise<ChainView> {
  return pullChain(clientFor(pairing), replicaFor(pairing), progress);
}

const oldServer = (): string => t('Your sync server does not support sending pages yet: update it to the latest Corvus sync server.');

/** Sends a page to one of the chain's computers, which opens it on its next sync. */
export async function sendPage(pairing: Pairing, page: Pick<SentTab, 'url' | 'title' | 'to'>): Promise<SentTabRecord> {
  const client = clientFor(pairing);
  const id = Crypto.randomUUID();
  const payload: SentTab = { ...page, fromId: await client.getDeviceId(), from: pairing.deviceName, sentAt: Date.now() };
  await client.push([{ collection: 'sent_tabs', id, payload, deleted: false }]);
  if (client.unsupported().has('sent_tabs')) throw new Error(oldServer());
  await replicaFor(pairing).put('sent_tabs', id, payload);
  return { id, ...payload };
}

const oldServerAsks = (): string => t('Your sync server does not support questions yet: update it to the latest Corvus sync server.');

/** Asks one of the chain's computers a question; it answers with its AI search while Corvus runs there. */
export async function askComputer(pairing: Pairing, question: string, to: string, follow: AskFollowUp = {}): Promise<AskRecord> {
  const client = clientFor(pairing);
  const id = Crypto.randomUUID();
  const payload = newAsk(question, to, await client.getDeviceId(), pairing.deviceName, Date.now(), follow);
  await client.push([{ collection: 'asks', id, payload, deleted: false }]);
  if (client.unsupported().has('asks')) throw new Error(oldServerAsks());
  await replicaFor(pairing).put('asks', id, payload);
  return { id, ...payload };
}

/** Takes a question off the list (and stops its answer if a computer is still writing it). */
export async function removeAsk(pairing: Pairing, id: string): Promise<void> {
  await removeAsks(pairing, [id]);
}

/** Takes several questions off the list at once (a whole conversation). */
export async function removeAsks(pairing: Pairing, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await clientFor(pairing).push(ids.map((id) => ({ collection: 'asks' as const, id, payload: null, deleted: true })));
  for (const id of ids) await replicaFor(pairing).put('asks', id, null);
}

/** Takes back a page its computer has not opened yet, or drops one sent here once it is opened. */
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
