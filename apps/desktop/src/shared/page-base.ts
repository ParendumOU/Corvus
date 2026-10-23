import { isInternalUrl } from "./internal-urls";

export const PAGE_BASE = { light: "#ffffff", dark: "#202124" } as const;

/**
 * Color painted behind a page that sets no background of its own. Web content always gets an
 * opaque white base, like Chrome does whatever the UI theme: a transparent page (boe.es sets no
 * background on html/body) would otherwise show a dark base through and render dark text on dark.
 * Only Corvus' own pages follow the theme, which also keeps a new tab's blank pre-paint dark.
 * Sites with real dark CSS still go dark: their own background (or `color-scheme: dark`) wins.
 */
export function pageBaseColor(url: string, dark: boolean): string {
  return dark && isInternalUrl(url) ? PAGE_BASE.dark : PAGE_BASE.light;
}
