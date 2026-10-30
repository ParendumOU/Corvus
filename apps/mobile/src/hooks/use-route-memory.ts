import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigationContainerRef } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { isRestoreLink, parsePlace, placeOf, placeToRestore, serializePlace, tabPath, tabUnder, type Place } from '@/lib/route-memory';

const KEY = 'corvus.route';
const READY_TRIES = 20;
const READY_WAIT_MS = 100;

/** Where the person is, in this run of the app (null until the first screen showed). */
let current: Place | null = null;
/** The tab to put back under a screen brought back, once the navigator is there. */
let tabToRestore: string | null = null;

// Kept on the phone when the app leaves the screen: Android may end it in the background.
AppState.addEventListener('change', (next) => {
  if (next === 'background' && current) void AsyncStorage.setItem(KEY, serializePlace({ ...current, leftAt: Date.now() })).catch(() => undefined);
});

/**
 * Whether the app is starting on a screen Android built again (src/app/+native-intent.ts): the activity
 * starts with the restore link then, and while the app still runs any new start of its screen is one
 * (React Native may still read the link of the activity going away).
 */
export function rebuilding(initialPath: string): boolean {
  return isRestoreLink(initialPath) || current !== null;
}

/** The path to open on a screen Android built again: where the person was, or Home (lib/route-memory.ts says when). */
export async function restoredPath(): Promise<string> {
  const sameRun = current !== null;
  const saved = current ?? parsePlace(await AsyncStorage.getItem(KEY).catch(() => null));
  const place = placeToRestore(saved, sameRun, Date.now());
  tabToRestore = place && place.path !== tabPath(place.tab) ? place.tab : null;
  return place?.path ?? '/';
}

/** Follows where the person is, and puts the tab back under a screen brought back. */
export function useRouteMemory(): void {
  const navigation = useNavigationContainerRef();
  useEffect(() => {
    const remember = (): void => {
      current = placeOf(navigation.getRootState()) ?? current;
    };
    const unsubscribe = navigation.addListener('state', remember);
    let tries = READY_TRIES;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = (): void => {
      if (!navigation.isReady()) {
        if (tries-- > 0) timer = setTimeout(start, READY_WAIT_MS);
        else tabToRestore = null;
        return;
      }
      remember();
      const tab = tabToRestore;
      tabToRestore = null;
      const jump = tab ? tabUnder(navigation.getRootState(), tab) : null;
      // Synchronous: a queued action waits for the root navigator, which mounts after this screen.
      if (jump) navigation.dispatchSync(jump);
    };
    start();
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [navigation]);
}
