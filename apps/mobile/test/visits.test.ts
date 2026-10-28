import { describe, expect, it } from 'vitest';

import { SAME_VISIT_MS, addLocalVisit, isNewVisit, mergeVisit, retitled } from '../src/lib/visits';

describe('history the browser records', () => {
  it('records web pages, once per load, not a reload or the same page again right away', () => {
    expect(isNewVisit('https://a.com/', undefined, 0)).toBe(true);
    expect(isNewVisit('about:blank', undefined, 0)).toBe(false);
    expect(isNewVisit('data:text/html,x', undefined, 0)).toBe(false);
    expect(isNewVisit(`https://a.com/${'x'.repeat(3000)}`, undefined, 0)).toBe(false);
    const last = { url: 'https://a.com/page#top', at: 1000 };
    expect(isNewVisit('https://a.com/page', last, 2000)).toBe(false);
    expect(isNewVisit('https://a.com/page#comments', last, 2000)).toBe(false);
    expect(isNewVisit('https://a.com/page', last, 1000 + SAME_VISIT_MS + 1)).toBe(true);
    expect(isNewVisit('https://a.com/other', last, 2000)).toBe(true);
  });

  it('adds a visit to the entry the chain has: counted, dated, titled', () => {
    expect(mergeVisit(undefined, { url: 'https://a.com/', title: ' A ' }, 5)).toEqual({ url: 'https://a.com/', title: 'A', visitedAt: 5, visitCount: 1 });
    const desktop = { url: 'https://a.com/', title: 'From the desktop', visitedAt: 3, visitCount: 4, faviconUrl: 'https://a.com/favicon.ico' };
    expect(mergeVisit(desktop, { url: 'https://a.com/', title: '' }, 9)).toEqual({ ...desktop, visitedAt: 9, visitCount: 5 });
    expect(mergeVisit(desktop, { url: 'https://a.com/', title: 'New' }, 9).title).toBe('New');
    expect(mergeVisit({ ...desktop, visitedAt: 20 }, { url: 'https://a.com/', title: '' }, 9).visitedAt).toBe(20);
    expect(mergeVisit({ junk: true }, { url: 'https://a.com/', title: 'A' }, 5).visitCount).toBe(1);
  });

  it('takes the title the page shows once loaded', () => {
    const entry = { url: 'https://a.com/', title: '', visitedAt: 1, visitCount: 1 };
    expect(retitled(entry, ' Title ')).toEqual({ ...entry, title: 'Title' });
    expect(retitled({ ...entry, title: 'Title' }, 'Title')).toBeNull();
    expect(retitled(entry, '')).toBeNull();
    expect(retitled(null, 'x')).toBeNull();
  });

  it('keeps the unpaired phone its own short history, newest first', () => {
    const e = (url: string, visitedAt: number) => ({ url, title: '', visitedAt, visitCount: 1 });
    const list = [e('https://b.com/', 2), e('https://a.com/', 1)];
    expect(addLocalVisit(list, e('https://a.com/', 3), 10).map((x) => x.url)).toEqual(['https://a.com/', 'https://b.com/']);
    expect(addLocalVisit(list, e('https://c.com/', 3), 2).map((x) => x.url)).toEqual(['https://c.com/', 'https://b.com/']);
  });
});
