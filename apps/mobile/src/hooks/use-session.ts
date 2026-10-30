import type { AskFollowUp, AskRecord, Bookmark, DeviceInfo, DeviceTabs, PairingInfo, ReadingItem, SentTab, SentTabRecord, SyncedHistoryEntry } from '@corvus/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { DEVICES_EVERY_MS, movedAt } from '@/lib/answer-follow';
import { notifyNew } from '@/lib/notifications';
import { openInApp } from '@/lib/open-url';
import type { ConversationView } from '@/lib/conversations';
import { isUnreachable } from '@/lib/reach';
import { RefreshStalled, SingleFlight, watchdog } from '@/lib/refresh';
import type { ComputerTabs } from '@/lib/replica';
import type { WatchView } from '@/lib/watches';
import {
  addBookmark,
  addVisit,
  askComputer,
  cachedView,
  clientFor,
  cancelSent,
  dropLegacyReplica,
  followAsks,
  followChain,
  loadPairing,
  otherAddress,
  markRead,
  pair,
  publishOpenTabs,
  pushVisits,
  refreshView,
  rejoin,
  removeBookmarksOf,
  retitleVisit,
  removeAsks,
  sameChain,
  stopAsk,
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
  /** When the phone last saw each question change, on its own clock (lib/answer-follow.ts). */
  askMoved: Record<string, number>;
  /** Corvus Assist conversations from the computers, newest first. */
  conversations: ConversationView[];
  /** The computers' home page setting (the browser's default search engine when the phone offers it). */
  homePage: unknown;
  /** False until the first refresh since the app started has finished (or failed). */
  refreshed: boolean;
  refreshing: boolean;
  error: string | null;
  /**
   * The sync server did not answer (the computer is off, or the phone is not on its network): a calm
   * note instead of an error (`unreachableNote` of this address, worded when shown, so it follows the
   * language). What the phone changes meanwhile waits and syncs once it answers.
   */
  unreachable: string | null;
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
  askMoved: {},
  conversations: [],
  homePage: undefined,
  refreshed: false,
  refreshing: false,
  error: null,
  unreachable: null,
};
let state: SessionState = { status: 'loading', pairing: null, ...EMPTY };
const listeners = new Set<() => void>();

function set(patch: Partial<SessionState>): void {
  if (patch.asks && patch.asks !== state.asks) patch = { ...patch, askMoved: movedAt(state.askMoved, state.asks, patch.asks, Date.now()) };
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

const refreshes = new SingleFlight<void>();

/** How often the phone tries again while its server does not answer (and the app is open). */
const RETRY_MS = 30_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function retryLater(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (state.unreachable && AppState.currentState === 'active') void refreshSession();
  }, RETRY_MS);
}

/** One refresh, following the chain when it moved, and joining again when the server lost this phone. */
async function refreshOnce(pairing: Pairing): Promise<{ pairing: Pairing; view: Awaited<ReturnType<typeof refreshView>> }> {
  let view;
  try {
    view = await watchdog((progress) => refreshView(pairing, progress));
  } catch (err) {
    if ((err as { code?: unknown }).code === 'device_not_registered') {
      await rejoin(pairing);
      return { pairing, view: await watchdog((progress) => refreshView(pairing, progress)) };
    }
    if (!isUnreachable(err)) throw err;
    // Another address of the same server (another network, Tailscale) may answer.
    const other = await otherAddress(pairing).catch(() => null);
    if (!other) throw err;
    return { pairing: other, view: await watchdog((progress) => refreshView(other, progress)) };
  }
  const moved = await followChain(pairing).catch(() => null);
  if (!moved) return { pairing, view };
  return { pairing: moved, view: await watchdog((progress) => refreshView(moved, progress)) };
}

/**
 * Lists the chain's devices and pulls what changed (pull to refresh). One refresh at a time, and
 * it always ends: a refresh that stops making progress fails with the step it was stuck on (see
 * lib/refresh.ts), so the spinner never stays on and the next pull starts a new one.
 */
export function refreshSession(): Promise<void> {
  const pairing = state.pairing;
  if (!pairing) return Promise.resolve();
  return refreshes.run(async () => {
    set({ refreshing: true, error: null });
    const edits = asksEdits;
    try {
      const { pairing: current, view: pulled } = await refreshOnce(pairing);
      // A question asked or stopped meanwhile stays as the phone has it until the next look.
      const view = edits === asksEdits ? pulled : { ...pulled, asks: state.asks };
      // The next quick look at the questions starts where this pull ended.
      asksCursor = null;
      devicesAt = Date.now();
      // Compared by chain: the pairing read back from storage is another object for the same chain.
      if (sameChain(state.pairing, pairing)) set({ ...view, pairing: current, refreshed: true, refreshing: false, unreachable: null });
      else set({ refreshing: false });
      // What the app shows does not need a notification later.
      void notifyNew(pulled, false).catch(() => undefined);
    } catch (err) {
      console.warn(`[corvus] refresh failed: ${message(err)}`);
      if (isUnreachable(err)) {
        set({ refreshed: true, refreshing: false, unreachable: pairing.serverUrl });
        retryLater();
        return;
      }
      const error = err instanceof RefreshStalled ? err.message : t('Sync did not work: {error}', { error: message(err) });
      set({ refreshed: true, refreshing: false, error, unreachable: null });
    }
  });
}

let asksCursor: { chain: string; cursor: number } | null = null;
let devicesAt = 0;
const answerLooks = new SingleFlight<void>();
/** Counts the phone's own changes to its questions: a look that began before one leaves the list be. */
let asksEdits = 0;

/**
 * A quick look for more of the answers being written: pulls the questions alone (and the device
 * list every few seconds, for who runs Corvus), never alongside a full refresh. The chat calls it
 * often while a question is open (lib/answer-follow.ts); a failed look is simply tried again.
 */
export function followAnswers(): Promise<void> {
  const pairing = state.pairing;
  if (!pairing || refreshes.running) return Promise.resolve();
  return answerLooks
    .run(async () => {
      const edits = asksEdits;
      const since = asksCursor?.chain === pairing.chainId ? asksCursor.cursor : null;
      const { cursor, asks } = await followAsks(pairing, since);
      asksCursor = { chain: pairing.chainId, cursor };
      const devices = Date.now() - devicesAt >= DEVICES_EVERY_MS ? await clientFor(pairing).listDevices() : null;
      if (devices) devicesAt = Date.now();
      if (!sameChain(state.pairing, pairing)) return;
      const changed = edits === asksEdits && JSON.stringify(asks) !== JSON.stringify(state.asks);
      if (changed || devices) set({ ...(changed ? { asks } : {}), ...(devices ? { devices } : {}) });
    })
    .catch((err: unknown) => console.warn(`[corvus] answer check failed: ${message(err)}`));
}

/** Shows what the replica holds after a change this phone made (no network). */
async function showLocal(pairing: Pairing): Promise<void> {
  const view = await cachedView(pairing, state.devices);
  if (sameChain(state.pairing, pairing)) set({ tabs: view.tabs, outbox: view.outbox, inbox: view.inbox, bookmarks: view.bookmarks, reading: view.reading, history: view.history, watches: view.watches, asks: view.asks, conversations: view.conversations, homePage: view.homePage });
}

export async function pairPhone(info: PairingInfo, chainId: string, deviceName: string): Promise<void> {
  const pairing = await pair(info, chainId, deviceName);
  set({ status: 'paired', pairing, ...EMPTY, refreshing: refreshes.running });
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
  if (sameChain(state.pairing, pairing)) set({ outbox: [...state.outbox, sent] });
}

/**
 * Asks a computer of the chain; its answer shows as the computer writes it (see the chat screen).
 * `follow` makes it a follow-up in a conversation. Returns the question as sent.
 */
export async function askQuestion(question: string, to: string, follow: AskFollowUp = {}): Promise<AskRecord> {
  const pairing = paired();
  const asked = await askComputer(pairing, question, to, follow);
  asksEdits++;
  if (sameChain(state.pairing, pairing)) set({ asks: [asked, ...state.asks.filter((a) => a.id !== asked.id)] });
  return asked;
}

/**
 * Stops the answer a computer is writing to `ask`, keeping what came of it (stopAsk in lib/session):
 * looks for its latest piece first. Returns what took its place, or the question as it is when its
 * answer was done meanwhile.
 */
export async function stopAnswer(ask: AskRecord): Promise<AskRecord> {
  const pairing = paired();
  await followAnswers();
  const latest = state.asks.find((a) => a.id === ask.id);
  if (!latest || (latest.state !== 'waiting' && latest.state !== 'answering')) return latest ?? ask;
  const stopped = await stopAsk(pairing, latest);
  asksEdits++;
  if (sameChain(state.pairing, pairing)) set({ asks: [stopped, ...state.asks.filter((a) => a.id !== latest.id)] });
  return stopped;
}

/** Removes a question and its answer from the list. */
export async function forgetAsk(id: string): Promise<void> {
  await forgetAsks([id]);
}

/** Removes several questions at once (a whole conversation); a computer still answering one stops. */
export async function forgetAsks(ids: readonly string[]): Promise<void> {
  const pairing = state.pairing;
  if (!pairing) return;
  await removeAsks(pairing, ids);
  asksEdits++;
  if (sameChain(state.pairing, pairing)) set({ asks: state.asks.filter((a) => !ids.includes(a.id)) });
}

/** Deletes a whole conversation of this phone (every question with this thread id). */
export async function forgetThread(thread: string): Promise<void> {
  await forgetAsks(state.asks.filter((a) => (a.thread ?? a.id) === thread).map((a) => a.id));
}

/** Asks a question that failed again, in the same place of its conversation, instead of it. */
export async function retryAsk(ask: AskRecord, to: string = ask.to): Promise<AskRecord> {
  const asked = await askQuestion(ask.question, to, { thread: ask.thread ?? ask.id, context: ask.context, origin: ask.origin });
  await forgetAsks([ask.id]).catch(() => undefined);
  return asked;
}

/** Opens a page a computer sent to this phone; it then leaves the inbox on every device. */
export async function openReceived(id: string, url?: string): Promise<void> {
  const page = state.inbox.find((p) => p.id === id);
  const target = page?.url ?? url;
  if (target) await openInApp(target);
  const pairing = state.pairing;
  if (!pairing || !page) return;
  await cancelSent(pairing, id);
  if (sameChain(state.pairing, pairing)) set({ inbox: state.inbox.filter((p) => p.id !== id) });
}

/** Takes back a page that is still waiting. */
export async function cancelSending(id: string): Promise<void> {
  const pairing = state.pairing;
  if (!pairing) return;
  await cancelSent(pairing, id);
  if (sameChain(state.pairing, pairing)) set({ outbox: state.outbox.filter((p) => p.id !== id) });
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

/** Removes the page's bookmarks (the browser's star). */
export async function unbookmarkPage(url: string): Promise<void> {
  const pairing = paired();
  await removeBookmarksOf(pairing, url);
  await showLocal(pairing);
}

const VISIT_PUSH_MS = 4_000;
let visitTimer: ReturnType<typeof setTimeout> | null = null;
let shownTimer: ReturnType<typeof setTimeout> | null = null;

/** Pushes the browser's visits a few seconds after the last one, and shows them in the Library. */
function scheduleVisits(pairing: Pairing): void {
  if (!visitTimer) {
    visitTimer = setTimeout(() => {
      visitTimer = null;
      void pushVisits(pairing).catch((err) => console.warn(`[corvus] history push failed: ${message(err)}`));
    }, VISIT_PUSH_MS);
  }
  if (!shownTimer) {
    shownTimer = setTimeout(() => {
      shownTimer = null;
      void showLocal(pairing).catch(() => undefined);
    }, 1_500);
  }
}

/**
 * A page the phone's browser loaded, into the chain's history (with the computers' entries for the
 * same address). False when the phone is not paired: the browser keeps it on the phone instead.
 */
export async function recordVisit(url: string, title: string): Promise<boolean> {
  const pairing = state.pairing;
  if (!pairing) return false;
  await addVisit(pairing, { url, title }, Date.now());
  scheduleVisits(pairing);
  return true;
}

/** The title a page showed once loaded, on its history entry. */
export async function retitleVisitOf(url: string, title: string): Promise<void> {
  const pairing = state.pairing;
  if (!pairing) return;
  await retitleVisit(pairing, url, title);
  scheduleVisits(pairing);
}

/** Shows the phone's open tabs on the computers (nothing while it is not paired). */
export async function publishTabs(record: DeviceTabs): Promise<boolean> {
  const pairing = state.pairing;
  if (!pairing) return false;
  await publishOpenTabs(pairing, record);
  return true;
}

let loaded = false;
async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  // Back in the app while the server did not answer: try again at once.
  AppState.addEventListener('change', (next) => {
    if (next === 'active' && state.unreachable) void refreshSession();
  });
  await dropLegacyReplica().catch(() => undefined);
  const pairing = await loadPairing().catch(() => null);
  // Paired (or unpaired) meanwhile, from the pairing screen: that is the current state, keep it.
  if (state.status !== 'loading') return;
  set({ status: pairing ? 'paired' : 'unpaired', pairing });
  if (!pairing) return;
  // What the phone already has, shown before the first refresh; never allowed to hold up that refresh.
  const cached = await watchdog((progress) => cachedView(pairing, [], progress)).catch(() => null);
  if (cached && !state.refreshed && sameChain(state.pairing, pairing)) set({ self: cached.self, tabs: cached.tabs, outbox: cached.outbox, inbox: cached.inbox, bookmarks: cached.bookmarks, reading: cached.reading, history: cached.history, watches: cached.watches, asks: cached.asks, conversations: cached.conversations ?? [], homePage: cached.homePage });
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
