/**
 * Ad and tracker blocking on the phone (Android): the filter lists the desktop uses, downloaded
 * from the same place once a week while blocking is on, compiled here (lib/blocklist.ts) into a
 * small file, and handed to the native blocker (modules/browser-kit). Until the first download, the
 * desktop's built-in fallback list blocks the best-known ad and tracker hosts. Nothing about the
 * pages opened leaves the phone: the lists are plain files fetched like any page.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import { BrowserKit, ConsentKit } from '../../modules/browser-kit';
import { COMPILED_VERSION, FALLBACK_FILTERS, FILTER_LISTS, LIST_REFRESH_MS, addFilterLines, addFilterList, emptyRules, parseFilters, ruleCount, serializeRules } from './blocklist';

export interface BlockingStatus {
  /** This phone can block (Android). */
  supported: boolean;
  /** Rules loaded in the blocker. */
  rules: number;
  /** When the lists were last downloaded; null while only the built-in list is used. */
  updatedAt: number | null;
  updating: boolean;
  error: string | null;
}

const META_KEY = 'corvus.blocklist.meta';
const dir = (): Directory => new Directory(Paths.document, 'corvus-blocklist');
const compiledFile = (): File => new File(dir(), 'compiled.txt');

let status: BlockingStatus = { supported: BrowserKit !== null, rules: 0, updatedAt: null, updating: false, error: null };
const listeners = new Set<() => void>();
function set(patch: Partial<BlockingStatus>): void {
  status = { ...status, ...patch };
  for (const listener of listeners) listener();
}

export function useBlockingStatus(): BlockingStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
    () => status,
  );
}

/** Blocking on or off, and the sites it is off for (the blocker reads them on every request). */
export function configureBlocking(enabled: boolean, allowedSites: readonly string[]): void {
  BrowserKit?.configure(enabled, [...allowedSites]);
}

/**
 * Cookie banners rejected (DuckDuckGo Autoconsent's rules) and Global Privacy Control sent (Android;
 * iOS sends it from the page itself), each on or off, and the sites that keep their banner. Pages
 * loaded from then on follow them.
 */
export function configurePrivacy(consent: boolean, gpc: boolean, consentAllowedSites: readonly string[]): void {
  ConsentKit?.configurePrivacy(consent, gpc, [...consentAllowedSites]);
}

let started = false;

/** Loads the rules (the downloaded ones, else the built-in list) and refreshes stale lists. */
export async function startBlocking(enabled: boolean, allowedSites: readonly string[]): Promise<void> {
  const native = BrowserKit;
  if (!native || started) return;
  started = true;
  configureBlocking(enabled, allowedSites);
  let updatedAt: number | null = null;
  try {
    const meta = JSON.parse((await AsyncStorage.getItem(META_KEY)) ?? 'null') as { version?: number; updatedAt?: number } | null;
    const file = compiledFile();
    if (meta?.version === COMPILED_VERSION && typeof meta.updatedAt === 'number' && file.exists) {
      set({ rules: await native.loadRulesFile(file.uri), updatedAt: meta.updatedAt });
      updatedAt = meta.updatedAt;
    }
  } catch (err) {
    console.warn(`[corvus] blocklist cache unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (updatedAt === null) set({ rules: await native.loadRules(serializeRules(parseFilters(FALLBACK_FILTERS))) });
  if (enabled && (updatedAt === null || Date.now() - updatedAt > LIST_REFRESH_MS)) void refreshLists();
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Downloads the filter lists and loads them; the rules in use stay if anything fails. */
export async function refreshLists(): Promise<void> {
  const native = BrowserKit;
  if (!native || status.updating) return;
  set({ updating: true, error: null });
  try {
    const rules = emptyRules();
    addFilterList(rules, FALLBACK_FILTERS);
    let fetched = 0;
    for (const url of FILTER_LISTS) {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) continue;
      const text = await res.text();
      fetched++;
      // In pieces, so the app stays responsive while a list is read.
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 3000) {
        addFilterLines(rules, lines.slice(i, i + 3000));
        await pause();
      }
    }
    if (fetched === 0) throw new Error('no list could be downloaded');
    for (const host of rules.thirdParty) if (rules.block.has(host)) rules.thirdParty.delete(host);
    const folder = dir();
    if (!folder.exists) folder.create({ intermediates: true });
    const file = compiledFile();
    if (file.exists) file.delete();
    file.create();
    await file.write(serializeRules(rules));
    const loaded = await native.loadRulesFile(file.uri);
    const updatedAt = Date.now();
    await AsyncStorage.setItem(META_KEY, JSON.stringify({ version: COMPILED_VERSION, updatedAt, rules: ruleCount(rules) }));
    set({ rules: loaded, updatedAt, updating: false });
  } catch (err) {
    set({ updating: false, error: err instanceof Error ? err.message : String(err) });
  }
}
