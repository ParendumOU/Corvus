import type { AskRecord, Bookmark, DeviceInfo, PairingInfo, ReadingItem, SentTab, SentTabRecord, SyncedHistoryEntry } from '@corvus/shared';
import { useEffect, useSyncExternalStore } from 'react';

import { notifyNew } from '@/lib/notifications';
import { openInApp } from '@/lib/open-url';
import type { ConversationView } from '@/lib/conversations';
import type { ComputerTabs } from '@/lib/replica';
import type { WatchView } from '@/lib/watches';
import {
  addBookmark,
  askComputer,
  cachedView,
  cancelSent,
  dropLegacyReplica,
  loadPairing,
  markRead,
  pair,
  refreshView,
  removeAsk,
  saveForLater,
  watchPage,
  sendPage,
  unpair,
  type Pairing,
} from '@/lib/session';
import { t } from '@/lib/i18n';

export interface SessionState {
  status: 'loading' | 'unpaired' | 'paired';
  pairing: Pairing | null;
  devices: DeviceInfo[];
  /** This phone's device id on the chain. */
  self: string | null;
  /** Open tabs of the chain's other devices, from the last refresh. */
  tabs: ComputerTabs[];
  /** Pages sent from this phone that their computer has not opened yet. */
  outbox: SentTabRecord[];
  /** Pages a computer sent to this phone, not opened yet. */
  inbox: SentTabRecord[];
  bookmarks: Bookmark[];
  /** The reading list, unread first. */
  reading: ReadingItem[];
  /** History of every device, most recent first. */
  history: SyncedHistoryEntry[];
  /** Watched pages, with what the computers last saw. */
  watches: WatchView[];
  /** Questions this phone asked, newest first. */
  asks: AskRecord[];
  /** Corvus Assist conversations from the computers, newest first. */
  conversations: ConversationView[];
  /** False until the first refresh since the app started has finished (or failed). */
  refreshed: boolean;
  refreshing: boolean;
  error: string | null;
}

const EMPTY: Omit<SessionState, 'status' | 'pairing'> = {
  devices: [],
  self: null,
  tabs: [],
  outbox: [],
  inbox: [],
  bookmarks: [],
  reading: [],
  history: [],
  watches: [],
  asks: [],
  conversations: [],
  refreshed: false,
  refreshing: false,
  error: null,
};
let state: SessionState = { status: 'loading', pairing: null, ...EMPTY };
const listeners = new Set<() => void>();

function set(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function paired(): Pairing {
  if (!state.pairing) throw new Error(t('This phone is not paired with a computer.'));
  return state.pairing;
}

let inFlight: Promise<void> | null = null;

/** Lists the chain's devices and pulls what changed (pull to refresh). One refresh at a time. */
export function refreshSession(): Promise<void> {
  const pairing = state.pairing;
  if (!pairing) return Promise.resolve();
  inFlight ??= (async () => {
    set({ refreshing: true, error: null });
    try {
      const view = await refreshView(pairing);
      if (state.pairing === pairing) set({ ...view, refreshed: true, refreshing: false });
      // What the app shows does not need a notification later.
      void notifyNew(view, false).catch(() => undefined);
    } catch (err) {
      set({ refreshed: true, refreshing: false, error: t('Could not reach the sync server: {error}', { error: message(err) }) });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Shows what the replica holds after a change this phone made (no network). */
async function showLocal(pairing: Pairing): Promise<void> {
  const view = await cachedView(pairing, state.devices);
  if (state.pairing === pairing) set({ tabs: view.tabs, outbox: view.outbox, inbox: view.inbox, bookmarks: view.bookmarks, reading: view.reading, history: view.history, watches: view.watches, asks: view.asks, conversations: view.conversations });
}

export async function pairPhone(info: PairingInfo, chainId: string, deviceName: string): Promise<void> {
  const pairing = await pair(info, chainId, deviceName);
  set({ status: 'paired', pairing, ...EMPTY });
  // The first pull can take a while on a big chain: the home screen shows it loading.
  void refreshSession();
}

export async function unpairPhone(): Promise<void> {
  if (state.pairing) await unpair(state.pairing);
  set({ status: 'unpaired', pairing: null, ...EMPTY });
}

/** Sends a page to a computer of the chain; it waits in the outbox until the computer opens it. */
export async function sendToComputer(page: Pick<SentTab, 'url' | 'title' | 'to'>): Promise<void> {
  const pairing = paired();
  const sent = await sendPage(pairing, page);
  if (state.pairing === pairing) set({ outbox: [...state.outbox, sent] });
}

/** Asks a computer of the chain; its answer shows as the computer writes it (see the Ask screen). */
export async function askQuestion(question: string, to: string): Promise<void> {
  const pairing = paired();
  const asked = await askComputer(pairing, question, to);
  if (state.pairing === pairing) set({ asks: [asked, ...state.asks.filter((a) => a.id !== asked.id)] });
}

/** Removes a question and its answer from the list. */
export async function forgetAsk(id: string): Promise<void> {
  const pairing = state.pairing;
  if (!pairing) return;
  await removeAsk(pairing, id);
  if (state.pairing === pairing) set({ asks: state.asks.filter((a) => a.id !== id) });
}

/** Opens a page a computer sent to this phone; it then leaves the inbox on every device. */
export async function openReceived(id: string, url?: string): Promise<void> {
  const page = state.inbox.find((p) => p.id === id);
  const target = page?.url ?? url;
  if (target) await openInApp(target);
  const pairing = state.pairing;
  if (!pairing || !page) return;
  await cancelSent(pairing, id);
  if (state.pairing === pairing) set({ inbox: state.inbox.filter((p) => p.id !== id) });
}

/** Takes back a page that is still waiting. */
export async function cancelSending(id: string): Promise<void> {
  const pairing = state.pairing;
  if (!pairing) return;
  await cancelSent(pairing, id);
  if (state.pairing === pairing) set({ outbox: state.outbox.filter((p) => p.id !== id) });
}

/** Saves a link to the reading list (a computer fetches the article). */
export async function saveToReadingList(url: string, title: string): Promise<void> {
  const pairing = paired();
  await saveForLater(pairing, url, title);
  await showLocal(pairing);
}

export async function setRead(item: ReadingItem, read: boolean): Promise<void> {
  const pairing = paired();
  await markRead(pairing, item, read);
  await showLocal(pairing);
}

/** Bookmarks a page (in "Other bookmarks"). */
export async function bookmarkPage(url: string, title: string): Promise<void> {
  const pairing = paired();
  await addBookmark(pairing, url, title);
  await showLocal(pairing);
}

/** Watches a page; the computers of the chain monitor it. */
export async function watch(url: string, title: string, intervalMinutes: number, condition: string): Promise<void> {
  const pairing = paired();
  await watchPage(pairing, url, title, intervalMinutes, condition);
  await showLocal(pairing);
}

let loaded = false;
async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  await dropLegacyReplica().catch(() => undefined);
  const pairing = await loadPairing().catch(() => null);
  set({ status: pairing ? 'paired' : 'unpaired', pairing });
  if (!pairing) return;
  const cached = await cachedView(pairing).catch(() => null);
  if (cached && !state.refreshed) set({ self: cached.self, tabs: cached.tabs, outbox: cached.outbox, inbox: cached.inbox, bookmarks: cached.bookmarks, reading: cached.reading, history: cached.history, watches: cached.watches, asks: cached.asks, conversations: cached.conversations ?? [] });
  await refreshSession();
}

/** The phone's pairing and what it shows from the chain, shared by every screen. */
export function useSession(): SessionState {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    void load();
  }, []);
  return snapshot;
}
