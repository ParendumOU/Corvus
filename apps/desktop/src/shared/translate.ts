/**
 * Page translation as a browser feature: the address bar offers to translate a page written in
 * another language, translates all of it in place (batch by batch, as you watch) and puts the
 * original back on demand. Pure rules here; main/translate-service.ts drives the page and the AI.
 */

export type TranslateState = "offer" | "translating" | "translated" | "error";

/** Pushed to the chrome UI for the active tab's translate button. */
export interface TranslateBarState {
  state: TranslateState;
  /** The page's language as it declares it ("" when it does not). */
  pageLang: string;
  /** The language the page is (or would be) translated into. */
  target: string;
  /** Text pieces translated so far. */
  translated: number;
  error?: string;
}

/** "en-US" → "en"; "" for anything that is not a language tag. */
export function primaryLanguage(tag: string): string {
  const m = /^\s*([a-z]{2,3})(?:[-_][A-Za-z0-9]{2,8})*\s*$/i.exec(tag);
  return m ? m[1]!.toLowerCase() : "";
}

/** The language pages are translated into: the setting, else the Corvus language, else the system's. */
export function translationTarget(setting: string, uiLanguage: string, systemLocale: string): string {
  return primaryLanguage(setting) || primaryLanguage(uiLanguage) || primaryLanguage(systemLocale) || "en";
}

/** Offer to translate when the page declares a language other than the target. */
export function shouldOfferTranslation(pageLang: string, target: string): boolean {
  const page = primaryLanguage(pageLang);
  return page !== "" && page !== primaryLanguage(target);
}

/** A language's name in `displayIn` ("es" in "en" → "Spanish"), falling back to the code. */
export function languageName(code: string, displayIn: string): string {
  const lang = primaryLanguage(code);
  if (!lang) return code;
  try {
    const name = new Intl.DisplayNames([primaryLanguage(displayIn) || "en"], { type: "language" }).of(lang);
    return name ? name.charAt(0).toLocaleUpperCase() + name.slice(1) : lang;
  } catch {
    return lang;
  }
}

/** Languages offered as translation targets in Settings. */
export const TRANSLATE_TARGETS = ["en", "es", "fr", "de", "it", "pt", "nl", "ca", "eu", "gl", "pl", "ru", "uk", "ja", "zh", "ko", "ar", "tr", "hi"] as const;
