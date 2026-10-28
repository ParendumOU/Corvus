/**
 * The cookie banner script of Corvus's Android browser: BrowserKitModule injects it at document
 * start in every frame (WebViewCompat.addDocumentStartJavaScript), bundled by
 * scripts/consent-assets.mjs with DuckDuckGo Autoconsent (MPL-2.0). Android's WebView runs it in the
 * page's own world, so it holds nothing the page could misuse:
 *
 * - Its only link to the app is a WebMessageListener object whose name the module writes in place
 *   of PORT (random per app start). Before the page's own scripts run, the script hides it from
 *   enumeration and locks it in place, and listens to it with a listener the page cannot remove.
 * - It asks for the rules of this frame (`init`, with its address) and gets back only the rules
 *   that can apply there, picked natively from Autoconsent's compact rules (ConsentRules.kt), so a
 *   page or ad frame never parses the whole set. No answer means nothing to do here (the feature is
 *   off, the site keeps its banner, or no rule runs in this frame).
 * - Autoconsent runs as a main-world script (its CMP snippets run here, not through messages) and
 *   rejects the banner. The app is only told the few results it shows (toConsentEvent); the module
 *   and the app validate them again and never run anything that comes from a page.
 */
import AutoConsent, { type CompactCMPRuleset, type ContentScriptMessage } from '@duckduckgo/autoconsent';

import { consentConfig, toConsentEvent } from '../../../../../packages/shared/src/cookie-consent';

/** Replaced by the module with the listener object's name. */
const PORT = '__CORVUS_CONSENT_PORT__';

interface Port {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

function start(): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const port = (window as unknown as Record<string, unknown>)[PORT] as Port | undefined;
  if (!port || typeof port.postMessage !== 'function') return;
  // The WebView finds the port by its name to deliver the answer, so it stays on window: out of
  // sight of for…in and Object.keys, and not replaceable by the page.
  try {
    Object.defineProperty(window, PORT, { enumerable: false, writable: false, configurable: false });
  } catch {
    // Already locked: the module validates whatever arrives anyway.
  }
  const post = (message: object): void => {
    try {
      port.postMessage(JSON.stringify(message));
    } catch {
      // The page went away.
    }
  };
  let consent: AutoConsent | null = null;
  // A listener rather than onmessage, which the page could overwrite.
  port.addEventListener('message', (event) => {
    if (consent || typeof event.data !== 'string') return;
    let reply: { type?: unknown; rules?: unknown };
    try {
      reply = JSON.parse(event.data) as { type?: unknown; rules?: unknown };
    } catch {
      return;
    }
    if (reply.type !== 'rules' || typeof reply.rules !== 'object' || reply.rules === null) return;
    const send = async (message: ContentScriptMessage): Promise<void> => {
      const reported = toConsentEvent(message);
      if (reported) post(reported);
    };
    // Configured once made, as by an extension's init answer: given the config in the constructor
    // once the page has a document element, Autoconsent prehides before it has made its DOM
    // helpers, and throws.
    consent = new AutoConsent(send);
    consent.initialize(consentConfig({ mainWorld: true }), { autoconsent: [], compact: reply.rules as CompactCMPRuleset });
  });
  post({ type: 'init', url: location.href });
}

try {
  start();
} catch {
  // A failure here must never break the page.
}
