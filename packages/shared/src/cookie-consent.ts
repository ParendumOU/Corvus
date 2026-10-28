/**
 * Cookie banner rejection and Global Privacy Control: the platform-neutral core shared by the desktop
 * browser and the mobile one. No DOM, Electron or React Native imports; each platform adds its own
 * bridge between DuckDuckGo Autoconsent's content script (`@duckduckgo/autoconsent`, MPL-2.0) and
 * the browser, and uses these pieces for the rest:
 *
 * - `consentConfig()`: the Autoconsent configuration Corvus runs with (reject, prehide, cosmetic
 *   hiding only as a fallback).
 * - `toConsentEvent()` / `parseConsentEvent()`: the few content-script messages the browser needs,
 *   reduced to plain fields and validated again on the trusted side.
 * - `isConsentSnippetId()`: main-world evals run only Autoconsent's own named snippets, never code
 *   that arrives in a message.
 * - `ConsentTabs`: what happened to the banner of each tab's page, and how many were dealt with.
 * - `siteListMatches()` and friends: the per-site "leave the cookie banner alone" list.
 * - GPC: the `Sec-GPC: 1` header and the page script that defines `navigator.globalPrivacyControl`.
 */

/** Autoconsent's `Config` (lib/types.ts), as far as Corvus sets it. */
export interface ConsentConfig {
  enabled: boolean;
  autoAction: "optOut";
  disabledCmps: string[];
  enablePrehide: boolean;
  enableCosmeticRules: boolean;
  enableGeneratedRules: boolean;
  enableHeuristicDetection: boolean;
  enablePopupMutationObserver: boolean;
  heuristicMode: "off";
  detectRetries: number;
  isMainWorld: boolean;
  prehideTimeout: number;
  visualTest: boolean;
  performanceLoggingEnabled: boolean;
  logs: {
    lifecycle: boolean;
    rulesteps: boolean;
    detectionsteps: boolean;
    evals: boolean;
    errors: boolean;
    messages: boolean;
    waits: boolean;
  };
}

/**
 * Reject everything: Autoconsent opts out on its own as soon as it finds a banner it has rules for
 * (clicking "reject all", or unticking every purpose and vendor and saving that). Known banners are
 * hidden from the first paint while that happens (prehide, undone after two seconds at most). Rules
 * that can only hide a banner run only when no rule can answer it. `mainWorld` is for platforms that
 * inject the content script into the page itself (Android's WebView) instead of an isolated world.
 */
export function consentConfig(options: { mainWorld?: boolean } = {}): ConsentConfig {
  return {
    enabled: true,
    autoAction: "optOut",
    disabledCmps: [],
    enablePrehide: true,
    enableCosmeticRules: true,
    enableGeneratedRules: true,
    enableHeuristicDetection: false,
    enablePopupMutationObserver: false,
    // Heuristics click buttons by their text on popups no rule knows; rules only.
    heuristicMode: "off",
    detectRetries: 20,
    isMainWorld: options.mainWorld === true,
    prehideTimeout: 2000,
    visualTest: false,
    performanceLoggingEnabled: false,
    // Quiet: page consoles are read by agents and developers, not filled by the browser.
    logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
  };
}

/** Only web pages get the content script (never internal pages, files or extension pages). */
export function isConsentPageUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** A host as stored in a site list: lower case, no trailing dot, no leading `www.`. */
export function normalizeSite(input: string): string {
  let host = input.trim().toLowerCase();
  if (host === "") return "";
  if (host.includes("://") || host.includes("/")) {
    try {
      host = new URL(host.includes("://") ? host : `http://${host}`).hostname;
    } catch {
      return "";
    }
  }
  host = host.replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

/** Whether `host` is one of the sites in `list` or under one of them. */
export function siteListMatches(host: string, list: readonly string[]): boolean {
  const h = normalizeSite(host);
  if (h === "") return false;
  return list.some((site) => h === site || h.endsWith(`.${site}`));
}

export function addSite(list: readonly string[], host: string): string[] {
  const h = normalizeSite(host);
  return h === "" ? [...list] : [...new Set([...list, h])].sort();
}

/** Removes `host` and every listed site it falls under (so the switch turns off for it). */
export function removeSite(list: readonly string[], host: string): string[] {
  const h = normalizeSite(host);
  return list.filter((site) => site !== h && !h.endsWith(`.${site}`));
}

/** Reads a stored site list back, dropping anything that is not a host. */
export function reviveSiteList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((h): h is string => typeof h === "string").map(normalizeSite).filter((h) => h !== "" && h.length <= 253))].sort();
}

/**
 * Whether the content script runs in a frame: the feature is on, the frame and its tab's page are web
 * pages, and the page's site is not one where the person chose to see the banner.
 */
export function shouldRunConsent(enabled: boolean, pageUrl: string, frameUrl: string, allowedSites: readonly string[]): boolean {
  if (!enabled || !isConsentPageUrl(pageUrl) || !isConsentPageUrl(frameUrl)) return false;
  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return false;
  }
  return host !== "" && !siteListMatches(host, allowedSites);
}

/** What the browser learns from a frame's content script. */
export type ConsentEvent =
  | { type: "popupFound"; cmp: string }
  | { type: "optOutResult"; cmp: string; result: boolean }
  | { type: "autoconsentDone"; cmp: string; isCosmetic: boolean }
  /** The frame's search is over (banner answered, none found or given up). Corvus's own. */
  | { type: "settled" };

const MAX_CMP_NAME = 80;

function cmpName(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CMP_NAME && !/[\u0000-\u001f]/.test(value) ? value : null;
}

/**
 * Validates a message on the trusted side (main process, native code): only the known types, with
 * exactly the expected fields. Anything else is null and dropped.
 */
export function parseConsentEvent(raw: unknown): ConsentEvent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case "settled":
      return { type: "settled" };
    case "popupFound": {
      const cmp = cmpName(msg.cmp);
      return cmp ? { type: "popupFound", cmp } : null;
    }
    case "optOutResult": {
      const cmp = cmpName(msg.cmp);
      return cmp && typeof msg.result === "boolean" ? { type: "optOutResult", cmp, result: msg.result } : null;
    }
    case "autoconsentDone": {
      const cmp = cmpName(msg.cmp);
      return cmp && typeof msg.isCosmetic === "boolean" ? { type: "autoconsentDone", cmp, isCosmetic: msg.isCosmetic } : null;
    }
    default:
      return null;
  }
}

/**
 * The part of an Autoconsent content-script message the browser is told about (in the content
 * script, before it crosses to the trusted side): page addresses, timings and internal state stay
 * behind. Null for the messages the browser does not need.
 */
export function toConsentEvent(message: unknown): ConsentEvent | null {
  if (typeof message !== "object" || message === null) return null;
  const msg = message as Record<string, unknown>;
  if (msg.type === "popupFound") return parseConsentEvent({ type: msg.type, cmp: msg.cmp });
  if (msg.type === "optOutResult") return parseConsentEvent({ type: msg.type, cmp: msg.cmp, result: msg.result });
  if (msg.type === "autoconsentDone") return parseConsentEvent({ type: msg.type, cmp: msg.cmp, isCosmetic: msg.isCosmetic });
  return null;
}

/**
 * Whether a report shows the frame's search is over: a banner was answered (or could not be), or no
 * consent platform turned up.
 */
export function isSettledLifecycle(lifecycle: unknown): boolean {
  return lifecycle === "nothingDetected" || lifecycle === "done" || lifecycle === "optOutSucceeded" || lifecycle === "optOutFailed";
}

/** Names of Autoconsent's main-world snippets (`evalSnippets` keys, such as EVAL_ONETRUST_1). */
export function isConsentSnippetId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && /^EVAL_[A-Z0-9_]+$/.test(value);
}

/** What happened to the banner on a tab's page. */
export type ConsentOutcome = "pending" | "rejected" | "hidden" | "failed";

export interface ConsentPageState {
  /** Autoconsent's rule name for the consent platform (see cmpDisplayName). */
  cmp: string;
  outcome: ConsentOutcome;
}

const FINAL: ReadonlySet<ConsentOutcome> = new Set(["rejected", "hidden"]);

/**
 * The banner state after an event, and whether the event dealt with a banner just now (so it counts
 * once per page, however many frames report it). A banner dealt with stays so.
 */
export function nextConsentState(prev: ConsentPageState | undefined, event: ConsentEvent): { state: ConsentPageState | undefined; handled: boolean } {
  if (prev && FINAL.has(prev.outcome)) return { state: prev, handled: false };
  switch (event.type) {
    case "popupFound":
      return { state: { cmp: event.cmp, outcome: "pending" }, handled: false };
    case "optOutResult":
      return event.result ? { state: prev ?? { cmp: event.cmp, outcome: "pending" }, handled: false } : { state: { cmp: event.cmp, outcome: "failed" }, handled: false };
    case "autoconsentDone":
      return { state: { cmp: event.cmp, outcome: event.isCosmetic ? "hidden" : "rejected" }, handled: true };
    default:
      return { state: prev, handled: false };
  }
}

/** Per-tab banner state, plus how many banners were dealt with this session (keyed by tab id). */
export class ConsentTabs {
  private readonly perTab = new Map<number, ConsentPageState>();
  private handledTotal = 0;

  /** Applies an event to a tab; true when it changed what the tab shows. */
  record(tabId: number, event: ConsentEvent): boolean {
    const prev = this.perTab.get(tabId);
    const { state, handled } = nextConsentState(prev, event);
    if (handled) this.handledTotal += 1;
    if (state === prev) return false;
    if (state) this.perTab.set(tabId, state);
    else this.perTab.delete(tabId);
    return true;
  }

  get(tabId: number): ConsentPageState | undefined {
    return this.perTab.get(tabId);
  }

  /** A new page in the tab. */
  reset(tabId: number): void {
    this.perTab.delete(tabId);
  }

  forget(tabId: number): void {
    this.perTab.delete(tabId);
  }

  total(): number {
    return this.handledTotal;
  }
}

const CMP_NAMES: Record<string, string> = {
  onetrust: "OneTrust",
  cybotcookiebot: "Cookiebot",
  "cookiebot.be": "Cookiebot",
  didomi: "Didomi",
  quantcast: "Quantcast",
  "sourcepoint-frame": "Sourcepoint",
  "sourcepoint-top": "Sourcepoint",
  "trustarc-top": "TrustArc",
  "trustarc-frame": "TrustArc",
  "trustarc-newcm": "TrustArc",
  "consentmanager.net": "consentmanager",
  "consentmanager-ncmp": "consentmanager",
  "usercentrics-api": "Usercentrics",
  "usercentrics-button": "Usercentrics",
  "funding-choices": "Google Funding Choices",
  "google-consent-standalone": "Google",
  iubenda: "iubenda",
  axeptio: "Axeptio",
  cookieyes: "CookieYes",
  "cookieyes-legacy": "CookieYes",
  "cookie-law-info": "CookieYes",
  complianz: "Complianz",
  borlabs: "Borlabs Cookie",
  osano: "Osano",
  ketch: "Ketch",
  termly: "Termly",
  klaro: "Klaro",
  evidon: "Evidon",
  admiral: "Admiral",
  sirdata: "Sirdata",
  "tarteaucitron.js": "tarteaucitron",
  "tarteaucitron deny": "tarteaucitron",
};

/** A readable name for a consent platform rule ("Onetrust" → "OneTrust", "Sourcepoint-frame" → "Sourcepoint"). */
export function cmpDisplayName(rule: string): string {
  const key = rule.trim().toLowerCase();
  if (CMP_NAMES[key]) return CMP_NAMES[key];
  if (key.startsWith("complianz")) return "Complianz";
  // Rules generated from crawls ("auto_DE_example.com_abc") name no platform.
  if (key.startsWith("auto_")) return "";
  if (key.startsWith("heuristic")) return "";
  return rule.trim();
}

/** Global Privacy Control (https://privacycg.github.io/gpc-spec/): the request header. */
export const GPC_HEADER = "Sec-GPC";
export const GPC_HEADER_VALUE = "1";

/** The request headers with `Sec-GPC: 1` added (any existing spelling of the header is replaced). */
export function withGpcHeader(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== "sec-gpc") out[name] = value;
  out[GPC_HEADER] = GPC_HEADER_VALUE;
  return out;
}

/**
 * Runs in each frame's page world before the page's own scripts: `navigator.globalPrivacyControl`
 * is true, as a getter on Navigator.prototype like the browsers that ship GPC natively. Leaves a
 * native implementation alone. Plain ES5 source, so it runs in any WebView as written.
 */
export const GPC_PAGE_SCRIPT = `(function () {
  try {
    if (typeof Navigator === 'undefined' || Object.getOwnPropertyDescriptor(Navigator.prototype, 'globalPrivacyControl')) return;
    var getter = Object.getOwnPropertyDescriptor({ get globalPrivacyControl() { return true; } }, 'globalPrivacyControl').get;
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: getter, configurable: true, enumerable: true });
  } catch (e) {}
})();`;
