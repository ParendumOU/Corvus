/**
 * The scripts the phone injects to fill a saved address or card into the page on screen (page menu,
 * "Fill address" and "Fill card"): form-fill-page.ts with the desktop's kits, as text (see there why).
 * Each evaluates to the fields written, 0 when the page has no empty field of that kind, -1 when the
 * page is no longer the site it was picked for.
 */
import { addressFields, type AddressFields } from './autofill-addresses';
import { cardFields, type CardFields } from './autofill-cards';
import { ADDRESS_ADAPTER_SOURCE, ADDRESS_KIT_SOURCE, CARD_ADAPTER_SOURCE, CARD_KIT_SOURCE, FILL_PAGE_SOURCE } from './form-fill-source';

/** The origin (scheme://host[:port]) of a web page's address, or "" for anything else. */
export function pageOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a card may be filled into a page of `origin`: https:, or http: on the phone itself (what
 * browsers call a secure context), so the number never goes over the network in clear.
 */
export function cardFillAllowed(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

function fillScript(adapter: string, origin: string): string {
  return `(function () {
  try {
    return (${FILL_PAGE_SOURCE})(${adapter}, ${JSON.stringify(origin)}, window);
  } catch (e) {
    return 0;
  }
})()`;
}

export function fillAddressScript(address: AddressFields, origin: string): string {
  return fillScript(`(${ADDRESS_ADAPTER_SOURCE})(${ADDRESS_KIT_SOURCE}, ${JSON.stringify(addressFields(address))})`, origin);
}

/** The CVV is written into the script only: the caller injects it once and lets it go. */
export function fillCardScript(card: CardFields, cvv: string, origin: string): string {
  const code = /^\d{3,4}$/.test(cvv) ? cvv : '';
  return fillScript(`(${CARD_ADAPTER_SOURCE})(${CARD_KIT_SOURCE}, ${JSON.stringify(cardFields(card))}, ${JSON.stringify(code)})`, origin);
}
