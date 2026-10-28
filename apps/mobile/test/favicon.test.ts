import { describe, expect, it } from 'vitest';

import { FaviconMemo, faviconCandidates, faviconUserAgent, pageSite, siteDomain, siteInitial } from '../src/lib/favicon';

describe('the site a host belongs to', () => {
  it('drops language, mobile and www subdomains', () => {
    expect(siteDomain('en.wikipedia.org')).toBe('wikipedia.org');
    expect(siteDomain('es.m.wikipedia.org')).toBe('wikipedia.org');
    expect(siteDomain('en.wikivoyage.org')).toBe('wikivoyage.org');
    expect(siteDomain('www.example.com')).toBe('example.com');
    expect(siteDomain('mobile.twitter.com')).toBe('twitter.com');
    expect(siteDomain('developer.mozilla.org')).toBe('mozilla.org');
    expect(siteDomain('example.com')).toBe('example.com');
  });

  it("keeps a country's second level (co.uk, com.au, ne.jp) as part of the suffix", () => {
    expect(siteDomain('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteDomain('www.abc.net.au')).toBe('abc.net.au');
    expect(siteDomain('www.example.com.au')).toBe('example.com.au');
    expect(siteDomain('www.nhk.or.jp')).toBe('nhk.or.jp');
    expect(siteDomain('www.boe.gob.es')).toBe('boe.gob.es');
    expect(siteDomain('bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteDomain('co.uk')).toBe('co.uk');
  });

  it('does not take an ordinary name under a country domain for a suffix', () => {
    expect(siteDomain('www.elmundo.es')).toBe('elmundo.es');
    expect(siteDomain('mail.web.de')).toBe('web.de');
    expect(siteDomain('www.spiegel.de')).toBe('spiegel.de');
  });

  it('treats each site on a hosting suffix as its own', () => {
    expect(siteDomain('alice.github.io')).toBe('alice.github.io');
    expect(siteDomain('docs.alice.github.io')).toBe('alice.github.io');
    expect(siteDomain('myapp.vercel.app')).toBe('myapp.vercel.app');
    expect(siteDomain('github.io')).toBe('github.io');
  });

  it('leaves IP addresses, single labels and odd input alone', () => {
    expect(siteDomain('192.168.1.20')).toBe('192.168.1.20');
    expect(siteDomain('[::1]')).toBe('[::1]');
    expect(siteDomain('localhost')).toBe('localhost');
    expect(siteDomain('WWW.Example.COM.')).toBe('example.com');
    expect(siteDomain('')).toBe('');
  });
});

describe("the letter on a page's tile", () => {
  it("is the site name's first letter, not a subdomain's", () => {
    expect(siteInitial('https://en.wikipedia.org/wiki/Corvus')).toBe('W');
    expect(siteInitial('https://en.wikivoyage.org/wiki/Spain')).toBe('W');
    expect(siteInitial('https://es.m.wikipedia.org/')).toBe('W');
    expect(siteInitial('https://www.python.org/')).toBe('P');
    expect(siteInitial('https://m.youtube.com/watch?v=1')).toBe('Y');
    expect(siteInitial('https://www.bbc.co.uk/news')).toBe('B');
    expect(siteInitial('https://alice.github.io/blog')).toBe('A');
  });

  it('falls back sensibly for hosts without a name and for non-web addresses', () => {
    expect(siteInitial('http://192.168.1.20:8080/')).toBe('1');
    expect(siteInitial('http://[::1]:3000/')).toBe('1');
    expect(siteInitial('http://localhost:8787/')).toBe('L');
    expect(siteInitial('about:blank')).toBe('?');
    expect(siteInitial('not a url')).toBe('?');
    expect(siteInitial('')).toBe('?');
  });

  it("names the site the tile's color comes from, the same for every language edition", () => {
    expect(pageSite('https://en.wikipedia.org/wiki/A')).toBe(pageSite('https://de.wikipedia.org/wiki/B'));
    expect(pageSite('https://en.wikipedia.org/wiki/A')).toBe('wikipedia.org');
    expect(pageSite('about:blank')).toBe('');
  });
});

describe('the icon addresses tried for a page', () => {
  it("tries the site's own fixed icon paths, then the main domain's icon for a subdomain", () => {
    expect(faviconCandidates('https://en.wikipedia.org/wiki/Corvus?x=1#top')).toEqual([
      'https://en.wikipedia.org/favicon.ico',
      'https://en.wikipedia.org/apple-touch-icon.png',
      'https://en.wikipedia.org/favicon.png',
      'https://wikipedia.org/favicon.ico',
    ]);
    expect(faviconCandidates('https://www.booking.com/hotel/es/x.html')).toEqual([
      'https://www.booking.com/favicon.ico',
      'https://www.booking.com/apple-touch-icon.png',
      'https://www.booking.com/favicon.png',
      'https://booking.com/favicon.ico',
    ]);
  });

  it('stays on the page origin when it is the site itself, keeping scheme and port', () => {
    expect(faviconCandidates('https://github.com/a/b')).toEqual(['https://github.com/favicon.ico', 'https://github.com/apple-touch-icon.png', 'https://github.com/favicon.png']);
    expect(faviconCandidates('http://192.168.1.20:8080/x')).toEqual([
      'http://192.168.1.20:8080/favicon.ico',
      'http://192.168.1.20:8080/apple-touch-icon.png',
      'http://192.168.1.20:8080/favicon.png',
    ]);
    expect(faviconCandidates('https://alice.github.io/blog')).toHaveLength(3);
  });

  it('never asks another site, nor for addresses that are not web pages', () => {
    for (const url of ['https://en.wikipedia.org/wiki/A', 'https://news.bbc.co.uk/', 'https://docs.alice.github.io/']) {
      const site = pageSite(url);
      for (const candidate of faviconCandidates(url)) expect(new URL(candidate).hostname.endsWith(site)).toBe(true);
    }
    expect(faviconCandidates('about:blank')).toEqual([]);
    expect(faviconCandidates('file:///sdcard/a.html')).toEqual([]);
    expect(faviconCandidates('javascript:alert(1)')).toEqual([]);
    expect(faviconCandidates('not a url')).toEqual([]);
  });
});

describe('the User-Agent of icon requests on Android', () => {
  it('names Corvus and its version, never a bare HTTP library', () => {
    expect(faviconUserAgent('0.6.0')).toBe('Mozilla/5.0 (Linux; Android) Corvus/0.6.0');
    expect(faviconUserAgent('')).toBe('Mozilla/5.0 (Linux; Android) Corvus');
    expect(faviconUserAgent('1.0 beta\r\nX: y')).toBe('Mozilla/5.0 (Linux; Android) Corvus/1.0betaXy');
    expect(faviconUserAgent('0.6.0')).not.toMatch(/okhttp/i);
  });
});

describe('remembering which icon works for a site', () => {
  const site = 'https://www.booking.com/favicon.ico';

  it('moves on from a failed candidate and starts later tiles at the one that loaded', () => {
    const memo = new FaviconMemo();
    expect(memo.first(site, 4)).toBe(0);
    expect(memo.failed(site, 0, 4)).toBe(1);
    memo.loaded(site, 1);
    expect(memo.first(site, 4)).toBe(1);
    expect(memo.first('https://github.com/favicon.ico', 3)).toBe(0);
  });

  it('shows the letter once every candidate failed, and asks the site again later', () => {
    const memo = new FaviconMemo(60_000);
    let index = 0;
    while (index < 3) index = memo.failed(site, index, 3, 1000);
    expect(index).toBe(3);
    expect(memo.first(site, 3, 30_000)).toBe(3);
    expect(memo.first(site, 3, 61_000)).toBe(0);
  });

  it('lets a tile that started early catch up with what another tile learned', () => {
    const memo = new FaviconMemo();
    memo.loaded(site, 2);
    expect(memo.failed(site, 0, 4)).toBe(2);
    const other = new FaviconMemo();
    other.failed(site, 0, 4);
    other.failed(site, 1, 4);
    expect(other.failed(site, 0, 4)).toBe(2);
  });

  it('moves on when the icon that loaded before fails now', () => {
    const memo = new FaviconMemo();
    memo.loaded(site, 0);
    expect(memo.failed(site, 0, 4)).toBe(1);
    expect(memo.first(site, 4)).toBe(1);
  });

  it('keeps at most `limit` sites, forgetting the oldest', () => {
    const memo = new FaviconMemo(60_000, 2);
    memo.loaded('a', 1);
    memo.loaded('b', 1);
    memo.loaded('c', 1);
    expect(memo.first('a', 3)).toBe(0);
    expect(memo.first('b', 3)).toBe(1);
    expect(memo.first('c', 3)).toBe(1);
  });
});
