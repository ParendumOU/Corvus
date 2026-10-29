import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { languageFor, setUiLanguage, t, tn } from '../src/lib/i18n';
import { ES } from '../src/lib/i18n-es';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(f) ? [path] : [];
  });
}

const T_CALL = /\bt\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
/** tn(count, 'one', 'other'): the count may hold one call, as in Math.round(minutes / 60). */
const TN_CALL = /\btn\(\s*[^,()]+(?:\([^()]*\))?[^,()]*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const unquote = (s: string): string => s.slice(1, -1).replace(/\\'/g, "'");

/** Every t('…') / t("…") text in the app's code, and both texts of every tn(n, '…', '…'). */
function texts(): string[] {
  const found = new Set<string>();
  for (const file of sources(SRC)) {
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(T_CALL)) found.add(unquote(m[1]!));
    const counts = [...code.matchAll(TN_CALL)];
    // A call this pattern cannot read would leave its texts unchecked.
    expect(counts.length, file).toBe(code.match(/\btn\((?!n: number)/g)?.length ?? 0);
    for (const m of counts) {
      found.add(unquote(m[1]!));
      found.add(unquote(m[2]!));
    }
  }
  return [...found];
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('app language', () => {
  afterEach(() => setUiLanguage('en'));

  it('is Spanish for a Spanish locale, English otherwise', () => {
    expect(['es-ES', 'es', 'es-419', 'en-US', 'estonian', 'de'].map(languageFor)).toEqual(['es', 'es', 'es', 'en', 'en', 'en']);
  });

  it('fills placeholders, in English and in Spanish', () => {
    expect(t('Ask {computer}', { computer: 'Desk' })).toBe('Ask Desk');
    setUiLanguage('es');
    expect(t('Ask {computer}', { computer: 'Desk' })).toBe('Preguntar a Desk');
    expect(t('Not in the dictionary')).toBe('Not in the dictionary');
  });

  it('says a count in the singular for 1 alone, in English and in Spanish', () => {
    const blocked = (n: number): string => tn(n, '1 ad or tracker blocked on this page', '{n} ads and trackers blocked on this page');
    expect([0, 1, 2, 25].map(blocked)).toEqual([
      '0 ads and trackers blocked on this page',
      '1 ad or tracker blocked on this page',
      '2 ads and trackers blocked on this page',
      '25 ads and trackers blocked on this page',
    ]);
    setUiLanguage('es');
    expect([0, 1, 2].map(blocked)).toEqual([
      '0 anuncios y rastreadores bloqueados en esta página',
      '1 anuncio o rastreador bloqueado en esta página',
      '2 anuncios y rastreadores bloqueados en esta página',
    ]);
    expect([1, 3].map((n) => tn(n, 'every hour', 'every {n} hours'))).toEqual(['cada hora', 'cada 3 horas']);
  });

  it('fills other placeholders of a count', () => {
    expect(tn(1, '1 tab', '{n} tabs on {computer}', { computer: 'Desk' })).toBe('1 tab');
    expect(tn(4, '1 tab', '{n} tabs on {computer}', { computer: 'Desk' })).toBe('4 tabs on Desk');
  });

  it('has a Spanish text for everything the app shows, with the same placeholders', () => {
    const all = texts();
    expect(all).toContain('1 ad or tracker blocked on this page');
    const missing = all.filter((text) => !(text in ES));
    expect(missing).toEqual([]);
    const mismatched = Object.entries(ES).filter(([en, es]) => placeholders(en).join() !== placeholders(es).join());
    expect(mismatched).toEqual([]);
    // Reads every source file: on a busy Docker bind mount (validation runs the smoke test alongside) it can pass 5 s.
  }, 30_000);
});
