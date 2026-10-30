/**
 * The app's language: Spanish on a phone set to Spanish (or with Corvus's own language set to Spanish,
 * Android 13+), English otherwise (the texts are written in English and looked up in lib/i18n-es.ts).
 * It follows a change while the app runs (hooks/use-language.ts). {name} placeholders are filled from `vars`.
 */
import { ES } from './i18n-es';

export type Language = 'en' | 'es';

/** The language for a BCP 47 locale ("es-ES" → Spanish). */
export function languageFor(locale: string): Language {
  return /^es\b/i.test(locale) ? 'es' : 'en';
}

function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en';
  }
}

let language: Language = languageFor(systemLocale());
const listeners = new Set<() => void>();

export function uiLanguage(): Language {
  return language;
}

/** Changes the language (the phone's changed, hooks/use-language.ts) and tells the subscribers. */
export function setUiLanguage(next: Language): void {
  if (next === language) return;
  language = next;
  for (const listener of listeners) listener();
}

/** Calls `listener` after each change of the language; returns the unsubscribe. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function t(text: string, vars?: Record<string, string | number>): string {
  const translated = language === 'es' ? (ES[text] ?? text) : text;
  return vars ? translated.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m)) : translated;
}

/**
 * A count in words: `one` for 1 ("1 tab"), `other` for any other number ("{n} tabs"), with {n} and
 * `vars` filled in. English and Spanish both keep the singular for 1 alone.
 */
export function tn(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  return t(n === 1 ? one : other, { ...vars, n });
}
