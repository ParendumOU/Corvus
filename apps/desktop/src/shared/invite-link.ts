import type { UiLanguage } from "./settings";

/** The Corvus download site, which offers the installer for the visitor's system. */
export const DOWNLOAD_SITE = "https://corvus.parendum.com";

/** The link to send someone so they can install Corvus, on the download site in Corvus's language. */
export function inviteLink(language: UiLanguage): string {
  return language === "es" ? `${DOWNLOAD_SITE}/es` : `${DOWNLOAD_SITE}/`;
}
