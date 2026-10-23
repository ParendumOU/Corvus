import type { UiLanguage } from "../../shared/settings";
import { ES } from "./i18n-es";

/**
 * Translations for Corvus's own pages. English text is the key: `t("Show bookmarks bar")` returns
 * the Spanish string when the page is in Spanish, and the English text otherwise (or when a string
 * has no translation yet). `{name}` placeholders are filled from `vars`.
 *
 * The page language comes from <html lang>, which Corvus writes when it serves the page, so the
 * first render is already translated; the settings page switches it live with setUiLanguage.
 */

// Read through globalThis so unit tests (Node, no DOM types) can import this module too.
const page = (globalThis as { document?: { documentElement: { lang: string } } }).document?.documentElement ?? null;
let language: UiLanguage = page?.lang === "es" ? "es" : "en";

export function uiLanguage(): UiLanguage {
  return language;
}

export function setUiLanguage(next: UiLanguage): void {
  language = next;
  if (page) page.lang = next;
}

export function t(text: string, vars?: Record<string, string | number>): string {
  const out = language === "es" ? (ES[text] ?? text) : text;
  return vars ? out.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match)) : out;
}
