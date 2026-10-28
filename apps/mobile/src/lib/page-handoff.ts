/**
 * The page "Ask Corvus about this page" hands to a new chat (its address, title and text, read on
 * the phone), kept in memory until the first question goes with it.
 */
import type { PageInfo, PageText } from './page-ask';

export interface HandedPage extends PageInfo {
  text: PageText | null;
}

let pending: HandedPage | null = null;

export function handOffPage(page: HandedPage): void {
  pending = page;
}

/** The page handed off for this address, if any. */
export function handedPage(url: string | undefined): HandedPage | null {
  return url && pending?.url === url ? pending : null;
}

export function clearHandedPage(): void {
  pending = null;
}
