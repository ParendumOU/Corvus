import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FALLBACK_FILTERS,
  cosmeticScript,
  cosmeticSelectors,
  matchRequest,
  parseCompiled,
  parseFilters,
  ruleCount,
  serializeRules,
  siteAllowed,
  siteOf,
} from '../src/lib/blocklist';

// The same files the Android matcher's test reads (ContentBlockerTest), so both match alike.
const dir = fileURLToPath(new URL('../modules/browser-kit/android/src/test/resources/blocklist', import.meta.url));
const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
const rows = (name: string): string[][] =>
  read(name)
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.split('\t'));

const rules = parseFilters(read('filters.txt'));

describe('filter lists into rules', () => {
  it('keeps host rules, third-party host rules, paths, exceptions and per-site hiding', () => {
    expect([...rules.block].sort()).toEqual(['ads.example-news.com', 'adserver.co.uk', 'caps-host.com', 'doubleclick.net', 'pixel.example.org', 'tracker.io']);
    expect([...rules.thirdParty].sort()).toEqual(['analytics.example.net', 'cdn-widgets.com', 'sentry.io']);
    expect([...rules.allow]).toEqual(['safe.doubleclick.net']);
    expect(Object.fromEntries(rules.paths)).toEqual({ 'facebook.com': ['/tr^'], 'example-shop.com': ['/ads/'], 'news.example.com': ['/banners/'] });
    expect(Object.fromEntries(rules.cosmetic)).toEqual({ 'example-news.com': ['.sponsored', 'div[data-ad]'], 'www.example.org': ['.ad-slot'] });
  });

  it('writes the compiled file the Android side loads, and reads it back the same', () => {
    const text = serializeRules(rules);
    expect(text).toBe(read('compiled.txt'));
    const back = parseCompiled(text)!;
    expect(serializeRules(back)).toBe(text);
    expect(ruleCount(back)).toBe(ruleCount(rules));
    expect(parseCompiled('! corvus-blocklist 0\nb\tx.com\n')).toBeNull();
  });

  it('turns the bundled fallback into host rules', () => {
    const fallback = parseFilters(FALLBACK_FILTERS);
    expect(fallback.block.has('doubleclick.net')).toBe(true);
    expect(fallback.thirdParty.has('sentry.io')).toBe(true);
    expect(fallback.paths.get('facebook.com')).toEqual(['/tr^']);
    expect(ruleCount(fallback)).toBeGreaterThan(50);
  });
});

describe('matching requests', () => {
  const compiled = parseCompiled(read('compiled.txt'))!;
  it.each(rows('cases.tsv'))('%s %s on %s', (expected, url, page, main, allowed) => {
    const ctx = { pageUrl: page === 'unknown' ? null : page!, mainFrame: main === 'true', allowedSites: allowed ? allowed.split(',') : [] };
    expect(matchRequest(compiled, url!, ctx) ? 'block' : 'allow').toBe(expected);
  });

  it.each(rows('cosmetic.tsv'))('hides on %s', (page, selectors) => {
    expect(cosmeticSelectors(compiled, page!).join(' | ')).toBe(selectors ?? '');
  });

  it('knows a site from its host, country domains included', () => {
    expect(['a.b.example.com', 'news.bbc.co.uk', 'example.com', 'x.y.com.au', 'host'].map(siteOf)).toEqual(['example.com', 'bbc.co.uk', 'example.com', 'y.com.au', 'host']);
    expect(siteAllowed('www.example.com', ['example.com'])).toBe(true);
    expect(siteAllowed('notexample.com', ['example.com'])).toBe(false);
  });

  it('hides elements with one style sheet, one rule per selector', () => {
    expect(cosmeticScript([])).toBeNull();
    const script = cosmeticScript(['.a', 'div[x="1"]'])!;
    expect(script).toContain('corvus-hide');
    expect(script).toContain('.a{display:none!important}\\ndiv[x=\\"1\\"]{display:none!important}');
  });
});
