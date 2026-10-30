import { describe, expect, it } from 'vitest';

import { RESTORE_WITHIN_MS, isRestoreLink, parsePlace, placeOf, placeToRestore, routePath, serializePlace, tabUnder, type RouteLike, type StateLike } from '../src/lib/route-memory';

/** The navigation container's state as expo-router builds it: its slot route holds the root stack. */
function root(stackRoutes: RouteLike[], index = stackRoutes.length - 1): StateLike {
  return { key: 'root', index: 0, routes: [{ name: '__root', key: '__root-1', state: { key: 'stack-1', index, routes: stackRoutes } }] };
}

const tabs = (focus: string): RouteLike => ({
  name: '(tabs)',
  key: '(tabs)-1',
  state: { key: 'tabs-1', index: ['index', 'assist', 'library', 'settings'].indexOf(focus), routeNames: ['index', 'assist', 'library', 'settings'], routes: ['index', 'assist', 'library', 'settings'].map((name) => ({ name, key: `${name}-1` })) },
});

describe('where the person is', () => {
  it('is the tab on screen', () => {
    expect(placeOf(root([tabs('library')]))).toEqual({ path: '/library', tab: 'library' });
    expect(placeOf(root([tabs('index')]))).toEqual({ path: '/', tab: 'index' });
  });

  it('is the screen on top of the tabs, with the tab under it', () => {
    expect(placeOf(root([tabs('assist'), { name: 'chat/[id]', key: 'c', params: { id: 'q 1', assist: '1' } }]))).toEqual({ path: '/chat/q%201?assist=1', tab: 'assist' });
    expect(placeOf(root([tabs('settings'), { name: 'licenses', key: 'l' }]))).toEqual({ path: '/licenses', tab: 'settings' });
  });

  it('keeps no one-shot params: the browser shows its own tabs again', () => {
    expect(placeOf(root([tabs('library'), { name: 'browser', key: 'b', params: { open: 'https://example.com', incoming: '1' } }]))).toEqual({ path: '/browser', tab: 'library' });
  });

  it("drops the router's own params and keeps a screen's", () => {
    expect(routePath('open', { url: 'https://example.com/a?b=1', from: 'browser', __internal_expo_router_no_animation: 'true' })).toBe(
      `/open?url=${encodeURIComponent('https://example.com/a?b=1')}&from=browser`,
    );
    expect(routePath('chat/[id]', { id: 'new', page: 'https://example.com', screen: 'x' })).toBe(`/chat/new?page=${encodeURIComponent('https://example.com')}`);
    expect(routePath('watches', { anything: '1' })).toBe('/watches');
  });

  it('is unknown before the root stack has a state', () => {
    expect(placeOf(undefined)).toBeNull();
    expect(placeOf({ index: 0, routes: [{ name: '+not-found' }] })).toBeNull();
  });

  it('assumes Home under a screen when the tabs have no state yet', () => {
    expect(placeOf(root([{ name: '(tabs)', key: 't' }, { name: 'watches', key: 'w' }]))).toEqual({ path: '/watches', tab: 'index' });
  });
});

describe('coming back after Android built the screen again', () => {
  const now = 1_000_000_000;
  const saved = { path: '/browser', tab: 'library', leftAt: now - 5 * 60_000 };

  it('always comes back while the app still runs', () => {
    expect(placeToRestore({ path: '/library', tab: 'library' }, true, now)).toEqual({ path: '/library', tab: 'library' });
    expect(placeToRestore({ ...saved, leftAt: now - 10 * RESTORE_WITHIN_MS }, true, now)?.path).toBe('/browser');
  });

  it('comes back after Android ended the app when it left less than 30 minutes ago', () => {
    expect(placeToRestore(saved, false, now)).toEqual(saved);
    expect(placeToRestore({ ...saved, leftAt: now - RESTORE_WITHIN_MS + 1 }, false, now)).not.toBeNull();
    expect(placeToRestore({ ...saved, leftAt: now - RESTORE_WITHIN_MS }, false, now)).toBeNull();
  });

  it('starts on Home when nothing was kept, the app ended while on screen, or the clock went back', () => {
    expect(placeToRestore(null, false, now)).toBeNull();
    expect(placeToRestore({ path: '/browser', tab: 'index' }, false, now)).toBeNull();
    expect(placeToRestore({ ...saved, leftAt: now + 60_000 }, false, now)).toBeNull();
  });

  it('knows the link the activity starts with then', () => {
    expect(['corvus://restore', 'corvus://restore/', ' CORVUS://restore '].every(isRestoreLink)).toBe(true);
    expect(['corvus://restore/x', 'corvus:///', 'https://restore', '/restore'].some(isRestoreLink)).toBe(false);
  });

  it('reads back only a place it wrote', () => {
    expect(parsePlace(serializePlace(saved))).toEqual(saved);
    expect(parsePlace(serializePlace({ path: '/', tab: 'index' }))).toEqual({ path: '/', tab: 'index' });
    for (const raw of [null, '', 'nope', '{}', '{"path":"browser","tab":"index"}', '{"path":"/","tab":"elsewhere"}', '{"path":"/","tab":"index","leftAt":"soon"}']) {
      expect(parsePlace(raw)?.leftAt).toBeUndefined();
    }
    expect(parsePlace('{"path":"/","tab":"elsewhere"}')).toBeNull();
  });

  it('puts the tab back under the screen brought back', () => {
    expect(tabUnder(root([tabs('index'), { name: 'browser', key: 'b' }]), 'library')).toEqual({ type: 'JUMP_TO', payload: { name: 'library' }, target: 'tabs-1' });
    expect(tabUnder(root([tabs('library'), { name: 'browser', key: 'b' }]), 'library')).toBeNull();
    expect(tabUnder(root([tabs('index')]), 'library')).toBeNull();
    expect(tabUnder(root([tabs('index'), { name: 'browser', key: 'b' }]), 'nowhere')).toBeNull();
    expect(tabUnder(root([{ name: 'browser', key: 'b' }]), 'library')).toBeNull();
  });
});
