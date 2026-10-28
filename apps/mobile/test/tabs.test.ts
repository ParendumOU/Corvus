import { describe, expect, it } from 'vitest';

import { EMPTY_TABS, MAX_TABS, activeTab, liveTabIds, openTabsKey, openTabsRecord, restoreTabs, serializeTabs, tabsReducer, type TabsAction, type TabsState } from '../src/lib/tabs';

const run = (actions: TabsAction[], from: TabsState = EMPTY_TABS): TabsState => actions.reduce(tabsReducer, from);
const ids = (s: TabsState): string[] => s.tabs.map((t) => t.id);

describe('browser tabs', () => {
  it('opens tabs at the end and shows the new one, unless it opens in the background', () => {
    const s = run([
      { type: 'open', id: 'a', url: 'https://a.com/', now: 1 },
      { type: 'open', id: 'b', url: 'https://b.com/', now: 2 },
      { type: 'open', id: 'c', url: 'https://c.com/', now: 3, background: true },
    ]);
    expect(ids(s)).toEqual(['a', 'b', 'c']);
    expect(s.activeId).toBe('b');
    expect(activeTab(s)?.url).toBe('https://b.com/');
    expect(run([{ type: 'open', id: 'a', url: 'x', now: 9 }], s)).toBe(s);
  });

  it('puts a tab a page opened right after it, and goes back there when it closes', () => {
    const s = run([
      { type: 'open', id: 'a', url: 'https://a.com/', now: 1 },
      { type: 'open', id: 'b', url: 'https://b.com/', now: 2 },
      { type: 'activate', id: 'a', now: 3 },
      { type: 'open', id: 'a1', url: 'https://a.com/1', now: 4, openerId: 'a' },
      { type: 'activate', id: 'a', now: 5 },
      { type: 'open', id: 'a2', url: 'https://a.com/2', now: 6, openerId: 'a' },
    ]);
    expect(ids(s)).toEqual(['a', 'a1', 'a2', 'b']);
    const closed = run([{ type: 'close', id: 'a2' }], s);
    expect(closed.activeId).toBe('a');
  });

  it('shows the next tab, else the previous one, when the one on screen closes', () => {
    const s = run([
      { type: 'open', id: 'a', url: '', now: 1 },
      { type: 'open', id: 'b', url: '', now: 2 },
      { type: 'open', id: 'c', url: '', now: 3 },
      { type: 'activate', id: 'b', now: 4 },
    ]);
    expect(run([{ type: 'close', id: 'b' }], s).activeId).toBe('c');
    expect(run([{ type: 'activate', id: 'c', now: 5 }, { type: 'close', id: 'c' }], s).activeId).toBe('b');
    expect(run([{ type: 'close', id: 'a' }], s).activeId).toBe('b');
    expect(run([{ type: 'close', id: 'a' }, { type: 'close', id: 'b' }, { type: 'close', id: 'c' }], s)).toEqual({ tabs: [], activeId: null });
    expect(run([{ type: 'close', id: 'zzz' }], s)).toBe(s);
    expect(run([{ type: 'closeAll' }], s)).toEqual(EMPTY_TABS);
  });

  it('forgets a closed opener', () => {
    const s = run([
      { type: 'open', id: 'a', url: '', now: 1 },
      { type: 'open', id: 'b', url: '', now: 2, openerId: 'a' },
      { type: 'close', id: 'a' },
    ]);
    expect(s.tabs[0]).not.toHaveProperty('openerId');
  });

  it('follows the page loaded in a tab, its title and the desktop version', () => {
    let s = run([{ type: 'open', id: 'a', url: 'https://a.com/', now: 1, external: true }]);
    s = tabsReducer(s, { type: 'title', id: 'a', title: 'A' });
    expect(activeTab(s)?.title).toBe('A');
    expect(tabsReducer(s, { type: 'title', id: 'a', title: '' })).toBe(s);
    s = tabsReducer(s, { type: 'navigated', id: 'a', url: 'https://a.com/next' });
    expect(activeTab(s)).toMatchObject({ url: 'https://a.com/next', title: '' });
    s = tabsReducer(s, { type: 'navigated', id: 'a', url: 'https://a.com/next', title: 'Next' });
    expect(activeTab(s)?.title).toBe('Next');
    expect(tabsReducer(s, { type: 'navigated', id: 'a', url: 'https://a.com/next' })).toBe(s);
    s = tabsReducer(s, { type: 'desktop', id: 'a', on: true });
    expect(activeTab(s)?.desktop).toBe(true);
    expect(activeTab(tabsReducer(s, { type: 'desktop', id: 'a', on: false }))).not.toHaveProperty('desktop');
    expect(activeTab(s)?.external).toBe(true);
    expect(activeTab(tabsReducer(s, { type: 'settled', id: 'a' }))).not.toHaveProperty('external');
  });

  it('keeps a live page for the tab on screen and the last ones seen', () => {
    const s = run([
      { type: 'open', id: 'a', url: '', now: 1 },
      { type: 'open', id: 'b', url: '', now: 2 },
      { type: 'open', id: 'c', url: '', now: 3 },
      { type: 'open', id: 'd', url: '', now: 4 },
      { type: 'open', id: 'e', url: '', now: 5, background: true },
      { type: 'activate', id: 'b', now: 6 },
    ]);
    expect(liveTabIds(s)).toEqual(['b', 'd', 'c']);
    expect(liveTabIds(s, 1)).toEqual(['b']);
    expect(liveTabIds(EMPTY_TABS)).toEqual([]);
  });

  it(`keeps ${MAX_TABS} tabs at most, closing the one unseen for the longest`, () => {
    let s = EMPTY_TABS;
    for (let i = 0; i < MAX_TABS; i++) s = tabsReducer(s, { type: 'open', id: `t${i}`, url: '', now: 10 + i });
    s = tabsReducer(s, { type: 'activate', id: 't0', now: 1000 });
    s = tabsReducer(s, { type: 'open', id: 'new', url: '', now: 1001 });
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(ids(s)).not.toContain('t1');
    expect(ids(s)).toContain('t0');
  });

  it('saves the tabs and reopens them after a restart', () => {
    const s = run([
      { type: 'open', id: 'a', url: 'https://a.com/', now: 1, external: true },
      { type: 'open', id: 'b', url: 'https://b.com/', now: 2 },
      { type: 'title', id: 'b', title: 'B' },
      { type: 'desktop', id: 'b', on: true },
      { type: 'activate', id: 'a', now: 3 },
    ]);
    const back = restoreTabs(serializeTabs(s));
    expect(back.activeId).toBe('a');
    expect(back.tabs).toEqual([
      { id: 'a', url: 'https://a.com/', title: '', createdAt: 1, lastActiveAt: 3 },
      { id: 'b', url: 'https://b.com/', title: 'B', createdAt: 2, lastActiveAt: 2, desktop: true },
    ]);
    expect(restoreTabs(null)).toEqual(EMPTY_TABS);
    expect(restoreTabs('{')).toEqual(EMPTY_TABS);
    expect(restoreTabs('{"v":2,"tabs":[]}')).toEqual(EMPTY_TABS);
    const odd = restoreTabs(JSON.stringify({ v: 1, activeId: 'gone', tabs: [{ id: 'x', url: 'javascript:alert(1)' }, { id: 'y', url: 'https://y.com/' }, { id: 'y', url: 'https://z.com/' }, { url: 'https://n.com/' }] }));
    expect(odd).toEqual({ tabs: [{ id: 'y', url: 'https://y.com/', title: '', createdAt: 0, lastActiveAt: 0 }], activeId: 'y' });
  });

  it('shows the computers the web pages open on the phone', () => {
    const s = run([
      { type: 'open', id: 'a', url: 'https://a.com/', now: 1 },
      { type: 'open', id: 'n', url: '', now: 2 },
      { type: 'open', id: 'b', url: 'https://b.com/', now: 3 },
      { type: 'title', id: 'b', title: 'B'.repeat(400) },
    ]);
    const record = openTabsRecord(s, 'Pixel 8', 'android', 42);
    expect(record).toMatchObject({ device: 'Pixel 8', platform: 'android', updatedAt: 42 });
    expect(record.tabs.map((t) => t.url)).toEqual(['https://a.com/', 'https://b.com/']);
    expect(record.tabs[1]!.title).toHaveLength(300);
    expect(record.tabs.every((t) => t.pinned === false)).toBe(true);
    expect(openTabsKey(tabsReducer(s, { type: 'activate', id: 'a', now: 9 }))).toBe(openTabsKey(s));
    expect(openTabsKey(tabsReducer(s, { type: 'title', id: 'a', title: 'A' }))).not.toBe(openTabsKey(s));
  });
});
