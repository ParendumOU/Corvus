import type { UiLanguage } from "../shared/settings";
import { translate } from "../shared/i18n-es";

let menuLanguage = (): UiLanguage => "en";

/** Where native menus get their language from: the same setting as Corvus's own pages. */
export function setMenuLanguage(language: () => UiLanguage): void {
  menuLanguage = language;
}

/** A menu label in Corvus's language (see shared/i18n-es.ts). */
export function tr(text: string, vars?: Record<string, string | number>): string {
  return translate(menuLanguage(), text, vars);
}

/** The language Corvus's UI is in now (for views that draw their own text, like the field dropdown). */
export function uiLanguage(): UiLanguage {
  return menuLanguage();
}
