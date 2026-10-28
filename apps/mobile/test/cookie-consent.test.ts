import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GPC_PAGE_SCRIPT, isConsentSnippetId, parseConsentEvent } from '@corvus/shared';
import { evalSnippets, filterCompactRules, type IndexedCMPRuleset } from '@duckduckgo/autoconsent';
import compact from '@duckduckgo/autoconsent/rules/compact-rules.json';
import { describe, expect, it } from 'vitest';

import { PORT_PLACEHOLDER, RULES_HEADER, buildConsentAssets, canonicalRuleset, packRules, ruleStringIds, snippetSources } from '../scripts/consent-assets.mjs';

const rules = compact as unknown as IndexedCMPRuleset;

describe("the module accepts what the app accepts from a page's banner script", () => {
  // The same cases ConsentMessagesTest (Kotlin) reads.
  const file = fileURLToPath(new URL('../modules/browser-kit/android/src/test/resources/consent/messages.tsv', import.meta.url));
  const cases = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.split('\t') as [string, string]);

  it('has the cases', () => {
    expect(cases.length).toBeGreaterThan(25);
  });

  it.each(cases)('%s', (raw, expected) => {
    expect(JSON.stringify(parseConsentEvent(JSON.parse(raw))) ?? 'null').toBe(expected);
  });
});

describe('packed rules (what ConsentRules.kt reads)', () => {
  const lines = packRules(rules).split('\n');

  it('keeps every string, pattern and rule as Autoconsent has them', () => {
    expect(lines[0]).toBe(RULES_HEADER);
    expect(Number(lines[1])).toBe(rules.v);
    const ranges = lines[2]!.split(' ').map(Number);
    expect(ranges).toEqual([...rules.index.genericRuleRange, ...rules.index.frameRuleRange, ...rules.index.specificRuleRange, rules.index.genericStringEnd, rules.index.frameStringEnd]);
    expect(Number(lines[3])).toBe(rules.s.length);
    let at = 4;
    for (const s of rules.s) expect(JSON.parse(lines[at++]!)).toBe(s);
    expect(Number(lines[at++])).toBe(rules.r.length);
    for (const rule of rules.r) {
      expect(lines[at++]).toBe(rule[3] ?? '');
      const [context, ids, json] = lines[at++]!.split('\t');
      expect(Number(context)).toBe(rule[4]);
      expect(ids ? ids.split(',').map(Number) : []).toEqual(ruleStringIds(rule));
      expect(JSON.parse(json!)).toEqual(rule);
    }
  });

  it('names the strings Autoconsent keeps for a set of rules', () => {
    const subset = filterCompactRules(rules, { url: 'https://www.bbc.com/', mainFrame: true });
    expect(subset.r.length).toBeGreaterThan(rules.index.genericRuleRange[1] - rules.index.genericRuleRange[0]);
    const used = new Set(subset.r.flatMap((rule) => ruleStringIds(rule)));
    subset.s.forEach((s, i) => expect(s).toBe(used.has(i) ? rules.s[i] : ''));
    expect(subset.s.length).toBe(Math.max(...used) + 1);
  });

  it('writes a ruleset as JSON.stringify does', () => {
    for (const [url, mainFrame] of [
      ['https://example.com/', true],
      ['https://www.bbc.com/', true],
      ['https://ads.example/frame', false],
    ] as const) {
      const subset = filterCompactRules(rules, { url, mainFrame });
      expect(JSON.parse(canonicalRuleset(subset))).toEqual({ v: subset.v, s: subset.s, r: subset.r });
    }
  });

  it('gives a page far less than the whole set, and most frames almost nothing', () => {
    const whole = JSON.stringify(rules).length;
    const page = canonicalRuleset(filterCompactRules(rules, { url: 'https://example.com/', mainFrame: true })).length;
    const frame = canonicalRuleset(filterCompactRules(rules, { url: 'https://ads.example/frame', mainFrame: false })).length;
    expect(page).toBeLessThan(whole / 2);
    expect(frame).toBeLessThan(whole / 50);
  });
});

describe('the Android assets', () => {
  it('builds the banner script, the GPC script, the packed rules and the Kotlin cases', async () => {
    const out = mkdtempSync(join(tmpdir(), 'corvus-consent-'));
    try {
      await buildConsentAssets(out);
      const read = (name: string): string => readFileSync(join(out, name), 'utf8');
      const page = read('assets/corvus-consent/page.js');
      expect(page.split(PORT_PLACEHOLDER)).toHaveLength(2);
      expect(page).toContain('DuckDuckGo Autoconsent');
      expect(read('assets/corvus-consent/gpc.js')).toBe(GPC_PAGE_SCRIPT);
      expect(read('assets/corvus-consent/rules.txt')).toBe(packRules(rules));
      expect(read('assets/corvus-consent/LICENSE-autoconsent.txt')).toContain('Mozilla Public License');
      const cases = read('test/corvus-consent/cases.tsv').trim().split('\n');
      expect(cases.length).toBeGreaterThan(500);
      expect(cases.find((c) => c.startsWith('main\thttps://example.com/\t'))).toMatch(/\t\d+\t[0-9a-f]{64}$/);
      expect(cases.some((c) => c.startsWith('frame\t'))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the iOS assets', () => {
  it('builds the isolated-world script, the snippets by id, the packed rules and the Swift cases', async () => {
    const out = mkdtempSync(join(tmpdir(), 'corvus-consent-ios-'));
    try {
      await buildConsentAssets(out, { ios: true });
      const read = (name: string): string => readFileSync(join(out, name), 'utf8');
      const page = read('assets/corvus-consent/page.js');
      expect(page).toContain('DuckDuckGo Autoconsent');
      expect(page).toContain('corvusConsent');
      expect(page).not.toContain(PORT_PLACEHOLDER);
      const snippets = JSON.parse(read('assets/corvus-consent/snippets.json')) as Record<string, string>;
      expect(Object.keys(snippets).length).toBeGreaterThan(20);
      for (const [id, source] of Object.entries(snippets)) {
        expect(isConsentSnippetId(id)).toBe(true);
        expect(source).toBe(String((evalSnippets as Record<string, unknown>)[id]));
      }
      expect(read('assets/corvus-consent/rules.txt')).toBe(packRules(rules));
      expect(read('test/corvus-consent/cases.tsv').trim().split('\n').length).toBeGreaterThan(500);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps only snippet functions, and refuses an odd id', () => {
    expect(snippetSources({ EVAL_A_1: () => true, EVAL_B: 'text' })).toEqual({ EVAL_A_1: '() => true' });
    expect(() => snippetSources({ 'alert(1)': () => true })).toThrow();
  });
});
