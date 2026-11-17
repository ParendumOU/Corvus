/** Addresses from synced lists open only when they are web pages (lib/open-url.ts). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
const prefs = { openIn: 'corvus' as 'corvus' | 'other' };

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, Alert: { alert: () => undefined }, Linking: { openURL: async (url: string) => void opened.push(`system:${url}`) } }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: async (url: string) => void opened.push(`custom-tab:${url}`) }));
vi.mock('../modules/default-browser', () => ({ DefaultBrowser: null }));
vi.mock('../src/lib/browser-nav', () => ({ openInCorvus: (url: string) => void opened.push(`corvus:${url}`) }));
vi.mock('../src/lib/browser-store', () => ({ loadBrowser: async () => undefined, browserState: () => ({ prefs }) }));
vi.mock('../src/lib/default-browser', () => ({ defaultBrowserState: async () => ({ isDefault: false, browser: null }) }));

const { openInApp, openInBrowser } = await import('../src/lib/open-url');

beforeEach(() => {
  opened.length = 0;
  prefs.openIn = 'corvus';
});

describe('opening a synced address', () => {
  it('opens a web page in Corvus or in the browser app', async () => {
    await openInApp('https://example.com/a');
    await openInBrowser('http://example.org/');
    expect(opened).toEqual(['corvus:https://example.com/a', 'system:http://example.org/']);
  });

  it('never opens another kind of address (a bookmarklet, a file, another app)', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///sdcard/a', 'intent://x#Intent;scheme=x;end']) {
      await openInApp(url);
      await openInBrowser(url);
      prefs.openIn = 'other';
      await openInApp(url);
      prefs.openIn = 'corvus';
    }
    expect(opened).toEqual([]);
  });
});
