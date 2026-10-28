/**
 * The browser's tabs: a pure reducer (open, close, switch, a page loaded), which of them keep a live
 * page, what is saved to reopen them after a restart, and the record that shows them on the
 * computers (sync collection `open_tabs`). Pure, so it is tested as is; lib/browser-store.ts holds
 * the state.
 */
import { MAX_SYNCED_TABS, MAX_TAB_TITLE, isSyncableTabUrl, type DeviceTabs } from '@corvus/shared';

export interface BrowserTab {
  id: string;
  /** The page's address; '' for a new tab that has not loaded anything. */
  url: string;
  title: string;
  createdAt: number;
  /** When it was last the tab on screen (which tabs keep a live page). */
  lastActiveAt: number;
  /** Opened for a link another app handed Corvus: going back from its first page returns to that app. */
  external?: boolean;
  /** The tab it was opened from (a link that opens a new window): closing it goes back there. */
  openerId?: string;
  /** Asks sites for their desktop version. */
  desktop?: boolean;
}

export interface TabsState {
  tabs: BrowserTab[];
  activeId: string | null;
}

export const EMPTY_TABS: TabsState = { tabs: [], activeId: null };

/** Pages kept loaded at once (the tab on screen and the last ones seen); the others reload when opened. */
export const LIVE_TABS = 3;
/** Tabs kept at most; opening one more closes the one unseen for the longest. */
export const MAX_TABS = 100;

export type TabsAction =
  | { type: 'open'; id: string; url: string; now: number; background?: boolean; external?: boolean; openerId?: string }
  | { type: 'close'; id: string }
  | { type: 'closeAll' }
  | { type: 'activate'; id: string; now: number }
  | { type: 'navigated'; id: string; url: string; title?: string }
  | { type: 'title'; id: string; title: string }
  | { type: 'desktop'; id: string; on: boolean }
  /** The tab's first page was left: going back no longer returns to the other app. */
  | { type: 'settled'; id: string }
  | { type: 'restore'; state: TabsState };

function patch(state: TabsState, id: string, change: (tab: BrowserTab) => BrowserTab): TabsState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab;
    const next = change(tab);
    if (next !== tab) changed = true;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

/** The tab to show when the active one closes: its opener, else the next one, else the previous one. */
function successor(tabs: readonly BrowserTab[], closing: BrowserTab): string | null {
  if (closing.openerId && tabs.some((t) => t.id === closing.openerId)) return closing.openerId;
  const i = tabs.findIndex((t) => t.id === closing.id);
  return tabs[i + 1]?.id ?? tabs[i - 1]?.id ?? null;
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'open': {
      if (state.tabs.some((t) => t.id === action.id)) return state;
      const tab: BrowserTab = {
        id: action.id,
        url: action.url,
        title: '',
        createdAt: action.now,
        lastActiveAt: action.background ? 0 : action.now,
        ...(action.external ? { external: true } : {}),
        ...(action.openerId ? { openerId: action.openerId } : {}),
      };
      // A tab opened from another one goes right after it (and after the others it opened); others at the end.
      let tabs = [...state.tabs];
      const opener = action.openerId ? tabs.findIndex((t) => t.id === action.openerId) : -1;
      if (opener === -1) tabs.push(tab);
      else {
        let at = opener + 1;
        while (tabs[at]?.openerId === action.openerId) at++;
        tabs.splice(at, 0, tab);
      }
      if (tabs.length > MAX_TABS) {
        const oldest = tabs.filter((t) => t.id !== tab.id && t.id !== state.activeId).sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
        if (oldest) tabs = tabs.filter((t) => t.id !== oldest.id);
      }
      return { tabs, activeId: action.background ? (state.activeId ?? tab.id) : tab.id };
    }
    case 'close': {
      const closing = state.tabs.find((t) => t.id === action.id);
      if (!closing) return state;
      // The tabs it opened forget it (closing them later shows their neighbour instead).
      const tabs = state.tabs.filter((t) => t.id !== action.id).map((t) => (t.openerId === action.id ? (({ openerId: _o, ...rest }) => rest)(t) : t));
      const activeId = state.activeId === action.id ? successor(state.tabs, closing) : state.activeId;
      return { tabs, activeId };
    }
    case 'closeAll':
      return EMPTY_TABS;
    case 'activate': {
      if (!state.tabs.some((t) => t.id === action.id)) return state;
      const next = patch(state, action.id, (t) => ({ ...t, lastActiveAt: action.now }));
      return { ...next, activeId: action.id };
    }
    case 'navigated':
      return patch(state, action.id, (t) => {
        const title = action.title ?? (t.url === action.url ? t.title : '');
        return t.url === action.url && t.title === title ? t : { ...t, url: action.url, title };
      });
    case 'title':
      return patch(state, action.id, (t) => (t.title === action.title || !action.title ? t : { ...t, title: action.title }));
    case 'desktop':
      return patch(state, action.id, (t) => (!!t.desktop === action.on ? t : action.on ? { ...t, desktop: true } : (({ desktop: _d, ...rest }) => rest)(t)));
    case 'settled':
      return patch(state, action.id, (t) => (t.external ? (({ external: _e, ...rest }) => rest)(t) : t));
    case 'restore':
      return action.state;
  }
}

export function activeTab(state: TabsState): BrowserTab | null {
  return state.tabs.find((t) => t.id === state.activeId) ?? null;
}

/** The tabs that keep a live page: the one on screen and the ones seen last, `max` in all. */
export function liveTabIds(state: TabsState, max: number = LIVE_TABS): string[] {
  const seen = state.tabs.filter((t) => t.id !== state.activeId && t.lastActiveAt > 0).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const ids = state.activeId ? [state.activeId] : [];
  for (const tab of seen) {
    if (ids.length >= max) break;
    ids.push(tab.id);
  }
  return ids;
}

/** What is saved to reopen the tabs after a restart (a link from another app reopens as a plain tab). */
export function serializeTabs(state: TabsState): string {
  return JSON.stringify({
    v: 1,
    activeId: state.activeId,
    tabs: state.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, createdAt: t.createdAt, lastActiveAt: t.lastActiveAt, ...(t.desktop ? { desktop: true } : {}) })),
  });
}

/** The saved tabs, checked; an unreadable save gives no tabs. */
export function restoreTabs(raw: string | null): TabsState {
  if (!raw) return EMPTY_TABS;
  try {
    const value = JSON.parse(raw) as { v?: unknown; activeId?: unknown; tabs?: unknown };
    if (value.v !== 1 || !Array.isArray(value.tabs)) return EMPTY_TABS;
    const tabs: BrowserTab[] = [];
    for (const t of value.tabs as Array<Record<string, unknown>>) {
      if (typeof t?.id !== 'string' || typeof t.url !== 'string' || tabs.some((x) => x.id === t.id)) continue;
      if (t.url !== '' && !/^https?:\/\//i.test(t.url)) continue;
      tabs.push({
        id: t.id,
        url: t.url,
        title: typeof t.title === 'string' ? t.title.slice(0, 500) : '',
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
        lastActiveAt: typeof t.lastActiveAt === 'number' ? t.lastActiveAt : 0,
        ...(t.desktop === true ? { desktop: true } : {}),
      });
    }
    const activeId = typeof value.activeId === 'string' && tabs.some((t) => t.id === value.activeId) ? value.activeId : (tabs[tabs.length - 1]?.id ?? null);
    return { tabs: tabs.slice(-MAX_TABS), activeId };
  } catch {
    return EMPTY_TABS;
  }
}

/** The phone's open tabs as the computers show them (its `open_tabs` record); web pages only. */
export function openTabsRecord(state: TabsState, device: string, platform: string, updatedAt: number): DeviceTabs {
  return {
    device: device.slice(0, 64),
    platform,
    updatedAt,
    tabs: state.tabs
      .filter((t) => isSyncableTabUrl(t.url))
      .slice(0, MAX_SYNCED_TABS)
      .map((t) => ({ url: t.url, title: t.title.slice(0, MAX_TAB_TITLE), pinned: false })),
  };
}

/** A key that changes when what the computers see of the tabs changes (addresses, titles, order). */
export function openTabsKey(state: TabsState): string {
  return JSON.stringify(state.tabs.filter((t) => isSyncableTabUrl(t.url)).map((t) => [t.url, t.title]));
}
