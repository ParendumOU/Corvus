/**
 * The browser's state, shared by its screen, Home and Settings: the tabs (lib/tabs.ts, saved so
 * they reopen after a restart), what each tab's page is doing (loading, back and forward, requests
 * blocked, the cookie banner answered), the address each tab was asked to load, and the browser's
 * settings (search engine, ad and tracker blocking, cookie banners, Global Privacy Control, where
 * links open). Visits go to history and the tabs to the computers from
 * here (hooks/use-session.ts).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { addSite, nextConsentState, removeSite, reviveSiteList, type ConsentEvent, type ConsentPageState, type SyncedHistoryEntry } from '@corvus/shared';
import * as Crypto from 'expo-crypto';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import { publishTabs, recordVisit, retitleVisitOf } from '@/hooks/use-session';
import { pickEngine, type SearchEngineId } from './address';
import { configurePrivacy } from './content-blocking';
import { EMPTY_TABS, activeTab, openTabsKey, openTabsRecord, restoreTabs, serializeTabs, tabsReducer, type BrowserTab, type TabsAction, type TabsState } from './tabs';
import { addLocalVisit, isNewVisit, mergeVisit, type LastVisit } from './visits';

/** What a tab's page is doing now (not saved). */
export interface TabRuntime {
  loading: boolean;
  /** 0 to 1. */
  progress: number;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Requests blocked on the page since it loaded. */
  blocked: number;
  /** The native view of the tab's WebView (Android), once it reported an event. */
  viewTag: number | null;
  /** What happened to the page's cookie banner (Android), once the banner script found one. */
  cookieBanner: ConsentPageState | null;
}

/** An address the app asked a tab to load (`n` tells two requests of the same address apart). */
export interface LoadRequest {
  url: string;
  n: number;
}

export type OpenIn = 'corvus' | 'other';

export interface BrowserPrefs {
  /** The search engine picked in Settings; null follows the computers' (else DuckDuckGo). */
  engine: SearchEngineId | null;
  /** Ad and tracker blocking (Android). */
  blocking: boolean;
  /** Sites blocking is off for (hosts without "www."). */
  allowedSites: string[];
  /** Cookie banners answered with a rejection (Android). */
  cookieConsent: boolean;
  /** Global Privacy Control sent to sites. */
  gpc: boolean;
  /** Sites that keep their cookie banner (hosts without "www."). */
  consentAllowedSites: string[];
  /** Where web links open: Corvus's browser, or another browser app (Android, as before 0.7). */
  openIn: OpenIn;
}

export interface BrowserState {
  loaded: boolean;
  tabs: TabsState;
  runtime: Record<string, TabRuntime>;
  requests: Record<string, LoadRequest>;
  prefs: BrowserPrefs;
  /** The phone's own history while it is not paired (for the address bar), newest first. */
  localHistory: SyncedHistoryEntry[];
  /** Cookie banners rejected or hidden since the app started. */
  bannersHandled: number;
}

const KEYS = {
  tabs: 'corvus.browser.tabs',
  engine: 'corvus.browser.engine',
  blocking: 'corvus.browser.blocking',
  allowedSites: 'corvus.browser.allowedSites',
  cookieConsent: 'corvus.browser.cookieConsent',
  gpc: 'corvus.browser.gpc',
  consentAllowedSites: 'corvus.browser.consentAllowedSites',
  openIn: 'corvus.browser.openIn',
  localHistory: 'corvus.browser.localHistory',
} as const;

const LOCAL_HISTORY_MAX = 500;

export const DEFAULT_PREFS: BrowserPrefs = { engine: null, blocking: true, allowedSites: [], cookieConsent: true, gpc: true, consentAllowedSites: [], openIn: 'corvus' };

const IDLE: TabRuntime = { loading: false, progress: 0, canGoBack: false, canGoForward: false, blocked: 0, viewTag: null, cookieBanner: null };

let state: BrowserState = { loaded: false, tabs: EMPTY_TABS, runtime: {}, requests: {}, prefs: DEFAULT_PREFS, localHistory: [], bannersHandled: 0 };
const listeners = new Set<() => void>();

function set(patch: Partial<BrowserState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function browserState(): BrowserState {
  return state;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let publishTimer: ReturnType<typeof setTimeout> | null = null;
let publishedKey: string | null = null;
let tabsChangedAt = Date.now();

/** Saves the tabs now (the app is leaving: timers stop while it is in the background). */
export function saveTabsNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (state.loaded) void AsyncStorage.setItem(KEYS.tabs, serializeTabs(state.tabs)).catch(() => undefined);
  if (publishTimer) {
    clearTimeout(publishTimer);
    publishTimer = null;
    publishNow();
  }
}

AppState.addEventListener('change', (next) => {
  if (next !== 'active') saveTabsNow();
});

/** Saves the tabs soon, and shows them on the computers when what they see changed. */
function tabsChanged(): void {
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void AsyncStorage.setItem(KEYS.tabs, serializeTabs(state.tabs)).catch(() => undefined);
    }, 500);
  }
  const key = openTabsKey(state.tabs);
  if (key === publishedKey) return;
  tabsChangedAt = Date.now();
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publishNow();
  }, 3_000);
}

/** Publishes the phone's open tabs now (also once paired, and when the app comes back). */
export function publishNow(): void {
  const key = openTabsKey(state.tabs);
  const record = openTabsRecord(state.tabs, deviceLabel, Platform.OS, tabsChangedAt);
  void publishTabs(record).then(
    (published) => {
      if (published) publishedKey = key;
    },
    () => undefined,
  );
}

let deviceLabel = 'Phone';
/** The phone's name on the chain, as the computers list its tabs. */
export function setDeviceLabel(name: string): void {
  deviceLabel = name || deviceLabel;
}

function dispatch(action: TabsAction): void {
  const next = tabsReducer(state.tabs, action);
  if (next === state.tabs) return;
  const runtime = { ...state.runtime };
  const requests = { ...state.requests };
  for (const id of Object.keys(runtime)) if (!next.tabs.some((t) => t.id === id)) delete runtime[id];
  for (const id of Object.keys(requests)) if (!next.tabs.some((t) => t.id === id)) delete requests[id];
  set({ tabs: next, runtime, requests });
  tabsChanged();
}

let loading: Promise<void> | null = null;

/** Reads the saved tabs and settings once. */
export function loadBrowser(): Promise<void> {
  loading ??= (async () => {
    const [tabs, engine, blocking, allowed, openIn, local, consent, gpc, consentAllowed] = await Promise.all([
      AsyncStorage.getItem(KEYS.tabs),
      AsyncStorage.getItem(KEYS.engine),
      AsyncStorage.getItem(KEYS.blocking),
      AsyncStorage.getItem(KEYS.allowedSites),
      AsyncStorage.getItem(KEYS.openIn),
      AsyncStorage.getItem(KEYS.localHistory),
      AsyncStorage.getItem(KEYS.cookieConsent),
      AsyncStorage.getItem(KEYS.gpc),
      AsyncStorage.getItem(KEYS.consentAllowedSites),
    ]).catch(() => [null, null, null, null, null, null, null, null, null] as const);
    const restored = restoreTabs(tabs);
    // Tabs opened before the saved ones were read (a link that started the app) stay, after them.
    const merged: TabsState = state.tabs.tabs.length > 0 ? { tabs: [...restored.tabs, ...state.tabs.tabs.filter((t) => !restored.tabs.some((r) => r.id === t.id))], activeId: state.tabs.activeId } : restored;
    const requests = { ...state.requests };
    for (const tab of merged.tabs) requests[tab.id] ??= { url: tab.url, n: 0 };
    const prefs: BrowserPrefs = {
      engine: engine === 'duckduckgo' || engine === 'brave' || engine === 'google' || engine === 'startpage' ? engine : null,
      blocking: blocking !== '0',
      allowedSites: parseList(allowed),
      cookieConsent: consent !== '0',
      gpc: gpc !== '0',
      consentAllowedSites: reviveSiteList(parseList(consentAllowed)),
      openIn: openIn === 'other' ? 'other' : 'corvus',
    };
    // Before any page is shown: each WebView takes these as it is made.
    configurePrivacy(prefs.cookieConsent, prefs.gpc, prefs.consentAllowedSites);
    set({ loaded: true, tabs: merged, requests, prefs, localHistory: parseHistory(local) });
    publishedKey = null;
  })();
  return loading;
}

function parseList(raw: string | null): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseHistory(raw: string | null): SyncedHistoryEntry[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? (value as SyncedHistoryEntry[]).filter((e) => typeof e?.url === 'string' && typeof e.visitedAt === 'number').slice(0, LOCAL_HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

// Tabs

/** Opens a page in a new tab (on screen unless `background`); returns the tab's id. */
export function openTab(url: string, options: { background?: boolean; external?: boolean; openerId?: string } = {}): string {
  // A new tab nothing was typed in yet gives its place to the page.
  const blank = activeTab(state.tabs);
  if (url && !options.background && blank && blank.url === '') dispatch({ type: 'close', id: blank.id });
  const id = Crypto.randomUUID();
  set({ requests: { ...state.requests, [id]: { url, n: 0 } } });
  dispatch({ type: 'open', id, url, now: Date.now(), ...options });
  return id;
}

/** A new tab that has not loaded anything (the address bar takes the first address). */
export function newTab(): string {
  // An empty tab already open is reused rather than piling up.
  const blank = state.tabs.tabs.find((t) => t.url === '' && !state.runtime[t.id]?.loading);
  if (blank) {
    activateTab(blank.id);
    return blank.id;
  }
  return openTab('');
}

export function closeTab(id: string): void {
  dispatch({ type: 'close', id });
}

export function closeAllTabs(): void {
  dispatch({ type: 'closeAll' });
}

export function activateTab(id: string): void {
  dispatch({ type: 'activate', id, now: Date.now() });
}

/** Loads an address in a tab (the address bar, a suggestion, a link from elsewhere). */
export function loadInTab(id: string, url: string): void {
  const previous = state.requests[id];
  set({ requests: { ...state.requests, [id]: { url, n: (previous?.n ?? 0) + 1 } } });
  dispatch({ type: 'navigated', id, url });
  setRuntime(id, { loading: true, progress: 0.05 });
}

export function setDesktopSite(id: string, on: boolean): void {
  dispatch({ type: 'desktop', id, on });
}

export function currentTab(): BrowserTab | null {
  return activeTab(state.tabs);
}

export function runtimeOf(id: string): TabRuntime {
  return state.runtime[id] ?? IDLE;
}

export function setRuntime(id: string, patch: Partial<TabRuntime>): void {
  const current = state.runtime[id] ?? IDLE;
  if (Object.entries(patch).every(([k, v]) => current[k as keyof TabRuntime] === v)) return;
  set({ runtime: { ...state.runtime, [id]: { ...current, ...patch } } });
}

/** The tab a native view belongs to. */
export function tabOfView(viewTag: number): string | null {
  for (const [id, rt] of Object.entries(state.runtime)) if (rt.viewTag === viewTag) return id;
  return null;
}

// Pages

const lastVisits = new Map<string, LastVisit>();

/** A tab's page committed a new address (a link, a redirect, the page changing its own address). */
export function pageNavigated(id: string, url: string, title: string | undefined): void {
  const tab = state.tabs.tabs.find((t) => t.id === id);
  if (!tab) return;
  dispatch({ type: 'navigated', id, url, ...(title ? { title } : {}) });
}

/** A tab's page finished loading: a visit for history (once per page). */
export function pageLoaded(id: string, url: string, title: string): void {
  const now = Date.now();
  if (title) dispatch({ type: 'title', id, title });
  const last = lastVisits.get(id);
  if (!isNewVisit(url, last, now)) {
    // The same visit, perhaps with its title now.
    if (title && last && last.url === url) void retitleVisitOf(url, title).catch(() => undefined);
    return;
  }
  lastVisits.set(id, { url, at: now });
  void recordVisit(url, title)
    .then((synced) => {
      if (synced) return;
      const entry = mergeVisit(state.localHistory.find((e) => e.url === url), { url, title }, now);
      const localHistory = addLocalVisit(state.localHistory, entry, LOCAL_HISTORY_MAX);
      set({ localHistory });
      void AsyncStorage.setItem(KEYS.localHistory, JSON.stringify(localHistory)).catch(() => undefined);
    })
    .catch((err) => console.warn(`[corvus] could not record a visit: ${err instanceof Error ? err.message : String(err)}`));
}

export function pageTitled(id: string, title: string): void {
  if (title) dispatch({ type: 'title', id, title });
}

// Settings

export async function setBrowserPrefs(patch: Partial<BrowserPrefs>): Promise<void> {
  const prefs = { ...state.prefs, ...patch };
  set({ prefs });
  const writes: Array<Promise<void>> = [];
  if ('engine' in patch) writes.push(prefs.engine ? AsyncStorage.setItem(KEYS.engine, prefs.engine) : AsyncStorage.removeItem(KEYS.engine));
  if ('blocking' in patch) writes.push(AsyncStorage.setItem(KEYS.blocking, prefs.blocking ? '1' : '0'));
  if ('allowedSites' in patch) writes.push(AsyncStorage.setItem(KEYS.allowedSites, JSON.stringify(prefs.allowedSites)));
  if ('cookieConsent' in patch) writes.push(AsyncStorage.setItem(KEYS.cookieConsent, prefs.cookieConsent ? '1' : '0'));
  if ('gpc' in patch) writes.push(AsyncStorage.setItem(KEYS.gpc, prefs.gpc ? '1' : '0'));
  if ('consentAllowedSites' in patch) writes.push(AsyncStorage.setItem(KEYS.consentAllowedSites, JSON.stringify(prefs.consentAllowedSites)));
  if ('openIn' in patch) writes.push(AsyncStorage.setItem(KEYS.openIn, prefs.openIn));
  if ('cookieConsent' in patch || 'gpc' in patch || 'consentAllowedSites' in patch) configurePrivacy(prefs.cookieConsent, prefs.gpc, prefs.consentAllowedSites);
  await Promise.all(writes);
}

/** Turns blocking off (or back on) for a site. */
export async function allowSite(site: string, allowed: boolean): Promise<void> {
  const host = site.toLowerCase().replace(/^www\./, '');
  if (!host) return;
  const rest = state.prefs.allowedSites.filter((s) => s !== host);
  await setBrowserPrefs({ allowedSites: allowed ? [...rest, host].sort() : rest });
}

/** Lets a site keep its cookie banner (Corvus stops answering it there), or answers it again. */
export async function allowCookieBanner(site: string, allowed: boolean): Promise<void> {
  const list = state.prefs.consentAllowedSites;
  await setBrowserPrefs({ consentAllowedSites: allowed ? addSite(list, site) : removeSite(list, site) });
}

/** A page's cookie banner got an answer (validated); each banner dealt with counts once. */
export function recordConsent(id: string, event: ConsentEvent): void {
  const prev = runtimeOf(id).cookieBanner ?? undefined;
  const { state: banner, handled } = nextConsentState(prev, event);
  if (handled) set({ bannersHandled: state.bannersHandled + 1 });
  if (banner !== prev) setRuntime(id, { cookieBanner: banner ?? null });
}

/** The engine the address bar searches with now. */
export function searchEngineId(homePage: unknown): SearchEngineId {
  return pickEngine(state.prefs.engine, homePage);
}

/** Where web links open: read before the app has drawn anything (an incoming link). */
export async function openInPref(): Promise<OpenIn> {
  await loadBrowser().catch(() => undefined);
  return state.prefs.openIn;
}

/** Forgets the phone's own history (Settings). */
export async function clearLocalHistory(): Promise<void> {
  set({ localHistory: [] });
  await AsyncStorage.removeItem(KEYS.localHistory);
}

export function useBrowser(): BrowserState {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    void loadBrowser();
  }, []);
  return snapshot;
}
