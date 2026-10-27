import { describe, expect, it } from 'vitest';

import {
  PREF_KEYS,
  loadBrowserPrefs,
  offerDefaultBrowser,
  openRoute,
  pickBrowser,
  rememberedDefault,
  resolveBrowser,
  sortBrowsers,
  type BrowserApp,
  type PrefsStore,
} from '../src/lib/browser-choice';

const CHROME: BrowserApp = { packageName: 'com.android.chrome', label: 'Chrome' };
const FIREFOX: BrowserApp = { packageName: 'org.mozilla.firefox', label: 'Firefox' };
const BRAVE: BrowserApp = { packageName: 'com.brave.browser', label: 'Brave' };
const CORVUS = 'com.parendum.corvus.mobile';

function memoryStore(initial: Record<string, string> = {}): PrefsStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
  };
}

describe('the browser that opens pages', () => {
  const installed = [CHROME, FIREFOX, BRAVE];

  it('is the one picked in Settings while it is installed', () => {
    expect(pickBrowser(installed, { chosen: FIREFOX.packageName, previousDefault: CHROME.packageName }, CORVUS)).toEqual(FIREFOX);
    expect(pickBrowser([CHROME, BRAVE], { chosen: FIREFOX.packageName, previousDefault: BRAVE.packageName }, CORVUS)).toEqual(BRAVE);
  });

  it('is by default the one that was the default browser before Corvus', () => {
    expect(pickBrowser(installed, { chosen: null, previousDefault: BRAVE.packageName }, CORVUS)).toEqual(BRAVE);
  });

  it('is the current default when Corvus is not it, else the first one found', () => {
    expect(pickBrowser(installed, { chosen: null, previousDefault: null }, FIREFOX.packageName)).toEqual(FIREFOX);
    expect(pickBrowser(installed, { chosen: null, previousDefault: null }, CORVUS)).toEqual(CHROME);
    expect(pickBrowser(installed, { chosen: null, previousDefault: null }, null)).toEqual(CHROME);
    expect(pickBrowser([], { chosen: CHROME.packageName, previousDefault: null }, null)).toBeNull();
  });

  it('remembers the system default only while it is a real browser', () => {
    expect(rememberedDefault(null, CHROME.packageName, installed)).toBe(CHROME.packageName);
    expect(rememberedDefault(CHROME.packageName, FIREFOX.packageName, installed)).toBe(FIREFOX.packageName);
    expect(rememberedDefault(CHROME.packageName, CORVUS, installed)).toBe(CHROME.packageName);
    expect(rememberedDefault(CHROME.packageName, null, installed)).toBe(CHROME.packageName);
    expect(rememberedDefault(null, null, installed)).toBeNull();
  });

  it('lists browsers by name, each package once', () => {
    expect(sortBrowsers([FIREFOX, CHROME, BRAVE, CHROME, { packageName: '', label: 'Broken' }]).map((b) => b.label)).toEqual(['Brave', 'Chrome', 'Firefox']);
  });
});

describe('browser choices kept on the phone', () => {
  it('reads nothing as no choice yet', async () => {
    expect(await loadBrowserPrefs(memoryStore())).toEqual({ chosen: null, previousDefault: null, offerDismissed: false });
    expect((await loadBrowserPrefs(memoryStore({ [PREF_KEYS.offerDismissed]: '1' }))).offerDismissed).toBe(true);
  });

  it('remembers the default browser before Corvus takes its place, and opens pages there afterwards', async () => {
    const store = memoryStore();
    const before = await resolveBrowser(store, [CHROME, FIREFOX], FIREFOX.packageName);
    expect(before.browser).toEqual(FIREFOX);
    expect(store.data.get(PREF_KEYS.previousDefault)).toBe(FIREFOX.packageName);

    const after = await resolveBrowser(store, [CHROME, FIREFOX], CORVUS);
    expect(after.browser).toEqual(FIREFOX);
    expect(store.data.get(PREF_KEYS.previousDefault)).toBe(FIREFOX.packageName);
  });

  it('keeps the browser picked in Settings over the remembered default', async () => {
    const store = memoryStore({ [PREF_KEYS.chosen]: CHROME.packageName, [PREF_KEYS.previousDefault]: FIREFOX.packageName });
    expect((await resolveBrowser(store, [CHROME, FIREFOX], CORVUS)).browser).toEqual(CHROME);
  });

  it('does not write when nothing changed', async () => {
    const store = memoryStore({ [PREF_KEYS.previousDefault]: CHROME.packageName });
    let writes = 0;
    const counting: PrefsStore = { getItem: store.getItem, setItem: async (k, v) => void (writes++, await store.setItem(k, v)) };
    await resolveBrowser(counting, [CHROME], CHROME.packageName);
    await resolveBrowser(counting, [CHROME], CORVUS);
    expect(writes).toBe(0);
  });
});

describe('how a page leaves the app', () => {
  it('opens a tab in the web build and goes to the system on iOS', () => {
    expect(openRoute('web', true, CHROME)).toEqual({ via: 'window' });
    expect(openRoute('ios', true, CHROME)).toEqual({ via: 'system' });
  });

  it('goes to the system on Android while Corvus is not the default browser', () => {
    expect(openRoute('android', false, CHROME)).toEqual({ via: 'system' });
  });

  it('goes straight to the picked browser when it could come back to Corvus', () => {
    expect(openRoute('android', true, FIREFOX)).toEqual({ via: 'package', packageName: FIREFOX.packageName });
    expect(openRoute('android', true, null)).toEqual({ via: 'none' });
  });
});

describe("Home's offer to become the default browser", () => {
  const base = { platform: 'android', paired: true, canAsk: true, isDefault: false, dismissed: false };

  it('shows on a paired Android phone where Corvus is not the default yet', () => {
    expect(offerDefaultBrowser(base)).toBe(true);
  });

  it('never shows again once dismissed, nor elsewhere', () => {
    expect(offerDefaultBrowser({ ...base, dismissed: true })).toBe(false);
    expect(offerDefaultBrowser({ ...base, isDefault: true })).toBe(false);
    expect(offerDefaultBrowser({ ...base, paired: false })).toBe(false);
    expect(offerDefaultBrowser({ ...base, canAsk: false })).toBe(false);
    expect(offerDefaultBrowser({ ...base, platform: 'ios' })).toBe(false);
    expect(offerDefaultBrowser({ ...base, platform: 'web' })).toBe(false);
  });
});
