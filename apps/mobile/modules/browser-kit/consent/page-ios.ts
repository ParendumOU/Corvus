/**
 * The cookie banner script of Corvus's iOS browser: ConsentKit.swift adds it at document start in
 * every frame, in a content world of its own (WKContentWorld), bundled by scripts/consent-assets.mjs
 * with DuckDuckGo Autoconsent (MPL-2.0). The page's scripts share the DOM with it but not its
 * globals, so they can neither see nor change it, nor reach its message handler, which exists only
 * in this world:
 *
 * - It asks for the rules of this frame (`init`) and gets back only those that can apply there,
 *   picked natively (ConsentRules.swift). No answer means nothing to do here (the feature is off,
 *   the site keeps its banner, or no rule runs in this frame).
 * - Autoconsent runs here as in an extension's isolated world. When a rule needs the page's own
 *   JavaScript (a consent platform's API), it asks for one of Autoconsent's named snippets by its id;
 *   the module runs its own bundled copy of that snippet in the page, never code from a message.
 * - The app is only told the few results it shows (toConsentEvent); the module and the app validate
 *   them again.
 */
import AutoConsent, { type CompactCMPRuleset, type ContentScriptMessage } from '@duckduckgo/autoconsent';

import { consentConfig, isConsentSnippetId, toConsentEvent } from '../../../../../packages/shared/src/cookie-consent';

/** The message handler's name (ConsentKit.swift). */
const HANDLER = 'corvusConsent';

interface Handler {
  postMessage(message: string): Promise<unknown>;
}

function start(): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const handlers = (window as unknown as { webkit?: { messageHandlers?: Record<string, Handler | undefined> } }).webkit?.messageHandlers;
  const handler = handlers?.[HANDLER];
  if (!handler || typeof handler.postMessage !== 'function') return;
  const post = (message: object): Promise<unknown> => handler.postMessage(JSON.stringify(message));

  let consent: AutoConsent | null = null;
  const send = async (message: ContentScriptMessage): Promise<void> => {
    if (message.type === 'eval') {
      let result = false;
      if (isConsentSnippetId(message.snippetId)) {
        try {
          result = (await post({ type: 'eval', snippetId: message.snippetId })) === true;
        } catch {
          // The frame went away, or the snippet failed.
        }
      }
      void consent?.receiveMessageCallback({ type: 'evalResp', id: message.id, result });
      return;
    }
    const reported = toConsentEvent(message);
    if (reported) post(reported).catch(() => undefined);
  };
  post({ type: 'init', url: location.href })
    .then((rules) => {
      if (typeof rules !== 'string') return;
      const compact = JSON.parse(rules) as CompactCMPRuleset;
      // Configured once made (see page.ts): Autoconsent prehides before it has its DOM helpers otherwise.
      consent = new AutoConsent(send);
      consent.initialize(consentConfig(), { autoconsent: [], compact });
    })
    .catch(() => undefined);
}

try {
  start();
} catch {
  // A failure here must never break the page.
}
