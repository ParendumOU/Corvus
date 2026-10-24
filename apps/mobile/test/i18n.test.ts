import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { languageFor, setUiLanguage, t } from '../src/lib/i18n';
import { ES } from '../src/lib/i18n-es';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(f) ? [path] : [];
  });
}

/** Every t('…') / t("…") text in the app's code. */
function texts(): string[] {
  const found = new Set<string>();
  for (const file of sources(SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g)) found.add(m[1]!.slice(1, -1).replace(/\\'/g, "'"));
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

  it('has a Spanish text for everything the app shows, with the same placeholders', () => {
    const missing = texts().filter((text) => !(text in ES));
    expect(missing).toEqual([]);
    const mismatched = Object.entries(ES).filter(([en, es]) => placeholders(en).join() !== placeholders(es).join());
    expect(mismatched).toEqual([]);
  });
});
