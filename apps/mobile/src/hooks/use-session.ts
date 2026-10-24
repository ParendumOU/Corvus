import type { DeviceInfo, PairingInfo, SentTab, SentTabRecord } from '@corvus/shared';
import { useEffect, useSyncExternalStore } from 'react';

import type { ComputerTabs } from '@/lib/replica';
import { cachedView, cancelSent, loadPairing, pair, refreshView, sendPage, unpair, type Pairing } from '@/lib/session';

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
  /** False until the first refresh since the app started has finished (or failed). */
  refreshed: boolean;
  refreshing: boolean;
  error: string | null;
}

const EMPTY: Omit<SessionState, 'status' | 'pairing'> = { devices: [], self: null, tabs: [], outbox: [], refreshed: false, refreshing: false, error: null };
let state: SessionState = { status: 'loading', pairing: null, ...EMPTY };
const listeners = new Set<() => void>();

function set(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    } catch (err) {
      set({ refreshed: true, refreshing: false, error: `Could not reach the sync server: ${message(err)}` });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
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
  const pairing = state.pairing;
  if (!pairing) throw new Error('This phone is not paired with a computer.');
  const sent = await sendPage(pairing, page);
  if (state.pairing === pairing) set({ outbox: [...state.outbox, sent] });
}

/** Takes back a page that is still waiting. */
export async function cancelSending(id: string): Promise<void> {
  const pairing = state.pairing;
  if (!pairing) return;
  await cancelSent(pairing, id);
  if (state.pairing === pairing) set({ outbox: state.outbox.filter((p) => p.id !== id) });
}

let loaded = false;
async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const pairing = await loadPairing().catch(() => null);
  set({ status: pairing ? 'paired' : 'unpaired', pairing });
  if (!pairing) return;
  const cached = await cachedView(pairing).catch(() => null);
  if (cached && !state.refreshed) set({ self: cached.self, tabs: cached.tabs, outbox: cached.outbox });
  await refreshSession();
}

/** The phone's pairing, the chain's devices and their open tabs, shared by every screen. */
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
