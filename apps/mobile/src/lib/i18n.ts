/**
 * The app's language: Spanish on a phone set to Spanish, English otherwise (the texts are written in
 * English and looked up in lib/i18n-es.ts). {name} placeholders are filled from `vars`.
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

export function uiLanguage(): Language {
  return language;
}

/** For tests. */
export function setUiLanguage(next: Language): void {
  language = next;
}

export function t(text: string, vars?: Record<string, string | number>): string {
  const translated = language === 'es' ? (ES[text] ?? text) : text;
  return vars ? translated.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m)) : translated;
}
