/**
 * Everything the phone's screens show from a chain, derived from the replica's records. Pure (no
 * React Native), so tests run the app's own derivation on whole chains.
 */
import type { AskRecord, Bookmark, DeviceInfo, ReadingItem, SentTabRecord, SyncedHistoryEntry } from '@corvus/shared';
import type { CorvusSyncClient } from '@corvus/sync-core';

import { myAsks } from './asks';
import { conversationList, type ConversationView } from './conversations';
import { historyList } from './history';
import { bookmarkList, readingList } from './library';
import type { Progress } from './refresh';
import { computerTabs, type ComputerTabs, type Replica, type ReplicaClient } from './replica';
import { inbox, outbox } from './send';
import { watchList, type WatchView } from './watches';

export interface ChainView {
  devices: DeviceInfo[];
  /** This phone's device id on the chain. */
  self: string;
  tabs: ComputerTabs[];
  /** Pages sent from this phone that are still waiting to be opened. */
  outbox: SentTabRecord[];
  /** Pages a computer sent to this phone, not opened yet. */
  inbox: SentTabRecord[];
  bookmarks: Bookmark[];
  reading: ReadingItem[];
  /** History of every device, most recent first. */
  history: SyncedHistoryEntry[];
  /** Watched pages, with what the computers last saw. */
  watches: WatchView[];
  /** Questions this phone asked, newest first, with what their computer answered so far. */
  asks: AskRecord[];
  /** Corvus Assist conversations from the computers, newest first. */
  conversations: ConversationView[];
  /** The computers' home page setting (synced `appearance.homePage`): the browser's default search engine when it is one the phone offers. */
  homePage: unknown;
}

/** A refresh: lists the chain's devices, pulls what changed into the replica, and derives the view. */
export async function pullChain(
  client: ReplicaClient & Pick<CorvusSyncClient, 'listDevices' | 'getDeviceId'>,
  replica: Replica,
  progress: Progress = () => undefined,
): Promise<ChainView> {
  progress({ kind: 'devices' });
  const devices = await client.listDevices();
  await replica.sync(client, progress);
  progress({ kind: 'view' });
  return chainView(replica, devices, await client.getDeviceId());
}

/** A setting the computers sync (collection `settings`, one record per key holding {v}). */
export function syncedSetting(records: Record<string, unknown>, key: string): unknown {
  const record = records[key];
  return typeof record === 'object' && record !== null && 'v' in record ? (record as { v: unknown }).v : undefined;
}

export async function chainView(replica: Pick<Replica, 'records'>, devices: DeviceInfo[], self: string): Promise<ChainView> {
  const sent = await replica.records('sent_tabs');
  return {
    devices,
    self,
    tabs: computerTabs(await replica.records('open_tabs'), devices, self),
    outbox: outbox(sent, self),
    inbox: inbox(sent, self),
    bookmarks: bookmarkList(await replica.records('bookmarks')),
    reading: readingList(await replica.records('reading')),
    history: historyList(await replica.records('history')),
    watches: watchList(await replica.records('watches'), await replica.records('watch_status'), devices),
    asks: myAsks(await replica.records('asks'), self),
    conversations: conversationList(await replica.records('assist_history')),
    homePage: syncedSetting(await replica.records('settings'), 'appearance.homePage'),
  };
}
