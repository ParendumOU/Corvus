/**
 * Corvus as the phone's default browser (Android): what the system says, the browser app that opens
 * pages, and the choices kept on the phone. Shared by Settings, Home and the Open screen; on iOS and
 * on the web `supported` stays false.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { DefaultBrowser, type DefaultBrowserRequest } from '../../modules/default-browser';
import { PREF_KEYS, resolveBrowser, sortBrowsers, type BrowserApp } from './browser-choice';

export interface DefaultBrowserState {
  /** This phone can make Corvus its default browser (Android). */
  supported: boolean;
  /** False until the first check has finished. */
  loaded: boolean;
  isDefault: boolean;
  /** The system has the "Set as default browser" dialog (Android 10 and later). */
  roleAvailable: boolean;
  /** Browser apps on the phone, Corvus left out, by name. */
  browsers: BrowserApp[];
  /** The one that opens pages. */
  browser: BrowserApp | null;
  /** The person said "Not now" to the offer on Home. */
  offerDismissed: boolean;
}

let state: DefaultBrowserState = {
  supported: DefaultBrowser !== null,
  loaded: DefaultBrowser === null,
  isDefault: false,
  roleAvailable: false,
  browsers: [],
  browser: null,
  offerDismissed: false,
};
const listeners = new Set<() => void>();

function set(patch: Partial<DefaultBrowserState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

let inFlight: Promise<DefaultBrowserState> | null = null;

/** Asks the system again (after the person comes back from its settings, for one). */
export function refreshDefaultBrowser(): Promise<DefaultBrowserState> {
  const native = DefaultBrowser;
  if (!native) return Promise.resolve(state);
  inFlight ??= (async () => {
    try {
      const [status, found] = await Promise.all([native.getStatusAsync(), native.getBrowsersAsync()]);
      const browsers = sortBrowsers(found);
      const { browser, prefs } = await resolveBrowser(AsyncStorage, browsers, status.systemDefault);
      set({ loaded: true, isDefault: status.isDefault, roleAvailable: status.roleAvailable, browsers, browser, offerDismissed: prefs.offerDismissed });
    } catch {
      set({ loaded: true });
    } finally {
      inFlight = null;
    }
    return state;
  })();
  return inFlight;
}

/** The current state, checked once first. */
export async function defaultBrowserState(): Promise<DefaultBrowserState> {
  return state.loaded ? state : refreshDefaultBrowser();
}

/** Settings → Default browser → Open pages in. */
export async function chooseBrowser(packageName: string): Promise<void> {
  const browser = state.browsers.find((b) => b.packageName === packageName);
  if (!browser) return;
  await AsyncStorage.setItem(PREF_KEYS.chosen, packageName);
  set({ browser });
}

/** Shows the system's "Set as default browser" dialog (or its Default apps settings). */
export async function requestDefaultBrowser(): Promise<DefaultBrowserRequest> {
  if (!DefaultBrowser) return 'unavailable';
  // Remember the browser that is the default now, before Corvus may take its place.
  await refreshDefaultBrowser();
  const result = await DefaultBrowser.requestDefaultAsync();
  await refreshDefaultBrowser();
  return result;
}

export async function openDefaultAppsSettings(): Promise<void> {
  await DefaultBrowser?.openDefaultAppsSettingsAsync();
}

/** "Not now" on Home's offer: it does not come back. */
export async function dismissDefaultBrowserOffer(): Promise<void> {
  set({ offerDismissed: true });
  await AsyncStorage.setItem(PREF_KEYS.offerDismissed, '1');
}

/** Steps back to the app Corvus was opened from (Android); false where it cannot. */
export async function leaveApp(): Promise<boolean> {
  return (await DefaultBrowser?.leaveAsync().catch(() => false)) ?? false;
}

let watching = false;
function watchAppState(): void {
  if (watching || !DefaultBrowser) return;
  watching = true;
  // The person may have changed the default browser, or installed one, while away.
  AppState.addEventListener('change', (next) => {
    if (next === 'active') void refreshDefaultBrowser();
  });
}

export function useDefaultBrowser(): DefaultBrowserState {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    watchAppState();
    if (!state.loaded) void refreshDefaultBrowser();
  }, []);
  return snapshot;
}
