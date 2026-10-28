// Preload for every web frame of a profile session: answers cookie banners with DuckDuckGo
// Autoconsent and sets navigator.globalPrivacyControl. Autoconsent runs here, in the preload's
// isolated world: it reads and clicks the page's DOM, while the page sees none of it. What it asks
// the browser for is answered here too, and only plain, validated reports reach the main process
// (see AdblockService.onConsentEvent). The page world only ever runs two things: the GPC getter and
// Autoconsent's own named snippets (a CMP's JavaScript API), never code taken from a message.
import { ipcRenderer, webFrame } from "electron";
import AutoConsent, { evalSnippets, filterCompactRules, type ContentScriptMessage, type IndexedCMPRuleset } from "@duckduckgo/autoconsent";
import compactRules from "@duckduckgo/autoconsent/rules/compact-rules.json?raw";
import { GPC_PAGE_SCRIPT, consentConfig, isConsentSnippetId, isSettledLifecycle, toConsentEvent, type ConsentEvent } from "@corvus/shared";
import { CONSENT_EVENT_CHANNEL, CONSENT_INIT_CHANNEL, type ConsentInitAnswer } from "../shared/adblock";

// Type-checked with the Node project (no DOM lib); declare the globals it reads.
declare const location: { href: string; protocol: string };
declare const window: { top: unknown; addEventListener(type: string, listener: () => void, options?: { once: boolean }): void };
declare const document: { readyState: string };

/** With no banner showing this long after the page loaded, the annoyance lists may hide what they hide. */
const SETTLE_WITHOUT_POPUP_MS = 4000;

function report(event: ConsentEvent): void {
  ipcRenderer.send(CONSENT_EVENT_CHANNEL, event);
}

function runAutoconsent(mainFrame: boolean): void {
  let settled = false;
  let popupShown = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    report({ type: "settled" });
  };
  const afterLoad = (): void => {
    setTimeout(() => {
      if (!popupShown) settle();
    }, SETTLE_WITHOUT_POPUP_MS);
  };
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", afterLoad, { once: true });
  else afterLoad();

  const runSnippet = async (snippetId: unknown): Promise<boolean> => {
    const snippet = isConsentSnippetId(snippetId) ? (evalSnippets as Record<string, unknown>)[snippetId] : undefined;
    if (typeof snippet !== "function") return false;
    try {
      return Boolean(await webFrame.executeJavaScript(`(${String(snippet)})()`));
    } catch {
      return false;
    }
  };

  let consent: AutoConsent | null = null;
  const send = async (message: ContentScriptMessage): Promise<void> => {
    if (message.type === "eval") {
      const result = await runSnippet(message.snippetId);
      void consent?.receiveMessageCallback({ type: "evalResp", id: message.id, result });
      return;
    }
    if (message.type === "report") {
      if (isSettledLifecycle(message.state.lifecycle)) settle();
      return;
    }
    if (message.type === "popupFound") popupShown = true;
    const event = toConsentEvent(message);
    if (event) report(event);
  };
  const rules = filterCompactRules(JSON.parse(compactRules) as IndexedCMPRuleset, { url: location.href, mainFrame });
  consent = new AutoConsent(send, consentConfig(), { autoconsent: [], compact: rules });
}

if (location.protocol === "http:" || location.protocol === "https:") {
  let answer: Partial<ConsentInitAnswer> | null = null;
  try {
    answer = ipcRenderer.sendSync(CONSENT_INIT_CHANNEL, location.href) as Partial<ConsentInitAnswer> | null;
  } catch {
    // No answer: the page loads as it is.
  }
  if (answer?.gpc === true) void webFrame.executeJavaScript(GPC_PAGE_SCRIPT).catch(() => undefined);
  if (answer?.consent === true) {
    try {
      runAutoconsent(window.top === window);
    } catch {
      // A failure here must never break the page.
    }
  }
}
