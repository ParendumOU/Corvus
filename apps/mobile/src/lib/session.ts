/**
 * The phone's pairing with a sync chain: the recovery phrase lives in the OS's secure storage
 * (Keychain / Keystore), the sync client's own state (device id, cursor) in app storage. On the
 * web build, used only for automated checks, both are in local storage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DeviceInfo, PairingInfo, SentTab, SentTabRecord, SyncStateStorage } from '@corvus/shared';
import { createSyncClient, type CorvusSyncClient } from '@corvus/sync-core';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

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
    replica = new Replica(syncState, `${SYNC_STATE_PREFIX}${pairing.chainId}/`);
    replicas.set(pairing.chainId, replica);
  }
  return replica;
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
}

async function view(pairing: Pairing, devices: DeviceInfo[]): Promise<ChainView> {
  const replica = replicaFor(pairing);
  const self = await clientFor(pairing).getDeviceId();
  return {
    devices,
    self,
    tabs: computerTabs(await replica.records('open_tabs'), devices, self),
    outbox: outbox(await replica.records('sent_tabs'), self),
  };
}

/** What the phone already has, without the network (shown before the first refresh). */
export function cachedView(pairing: Pairing): Promise<ChainView> {
  return view(pairing, []);
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
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(SYNC_STATE_PREFIX));
  if (keys.length > 0) await AsyncStorage.multiRemove(keys);
}
