/**
 * The browser's Android side (android/…/BrowserKitModule.kt), on top of react-native-webview's
 * WebView: ad and tracker blocking, cookie banners and Global Privacy Control, links to other apps,
 * the pages' camera and microphone requests, find in page and reading a page's text. On iOS and in
 * the web build that module does not exist and `BrowserKit` is null: pages load without blocking,
 * and those features are left out. Cookie banners are answered on iOS too, by the iOS side
 * (ios/ConsentKitModule.swift): `ConsentKit` is whichever module does it (null in the web build).
 */
import { requireOptionalNativeModule, type EventSubscription } from 'expo';

export interface BlockedEvent {
  viewTag: number;
  /** Requests blocked on the page since it loaded. */
  count: number;
  pageUrl: string | null;
}

export interface ExternalLinkEvent {
  viewTag: number;
  url: string;
}

export interface PermissionRequestEvent {
  viewTag: number;
  origin: string;
  /** "camera", "microphone", "protected-media", "midi" or the WebView's own name. */
  kinds: string[];
}

/** What a frame's cookie banner script reported, validated natively (the app checks it again with parseConsentEvent). */
export interface ConsentNativeEvent {
  viewTag: number;
  type: string;
  cmp?: string;
  result?: boolean;
  isCosmetic?: boolean;
  mainFrame: boolean;
}

export interface FindResultEvent {
  viewTag: number;
  /** The match on screen, from 0. */
  active: number;
  total: number;
  done: boolean;
}

interface BrowserKitEvents {
  onBlocked(event: BlockedEvent): void;
  onExternalLink(event: ExternalLinkEvent): void;
  onPermissionRequest(event: PermissionRequestEvent): void;
  onFindResult(event: FindResultEvent): void;
  onConsent(event: ConsentNativeEvent): void;
}

interface BrowserKitNative {
  /** The user agents to browse with: as a phone (the system WebView's, unmarked) and as a computer. */
  userAgents(): { mobile: string; desktop: string };
  /** Blocking on or off, and the sites it is off for. */
  configure(enabled: boolean, allowedSites: string[]): void;
  /**
   * Cookie banners rejected (DuckDuckGo Autoconsent) and Global Privacy Control sent, each on or off,
   * and the sites that keep their cookie banner. Pages loaded from then on follow them.
   */
  configurePrivacy(consent: boolean, gpc: boolean, consentAllowedSites: string[]): void;
  /** The compiled rules (lib/blocklist.ts); resolves how many rules were loaded. */
  loadRules(text: string): Promise<number>;
  loadRulesFile(path: string): Promise<number>;
  /** The CSS selectors to hide on a page (none while blocking is off there). */
  cosmeticSelectors(pageUrl: string): Promise<string[]>;
  blockedCount(viewTag: number): Promise<number>;
  /** Runs a script in the page; resolves its value JSON-encoded, or null. */
  evaluate(viewTag: number, script: string): Promise<string | null>;
  find(viewTag: number, text: string): Promise<boolean>;
  findNext(viewTag: number, forward: boolean): Promise<boolean>;
  clearFind(viewTag: number): Promise<boolean>;
  /** Forgets cookies, site storage and the cache of every site. */
  clearBrowsingData(): Promise<boolean>;
  /** "opened", "web:<address>" (load that in the tab instead) or "none". */
  openExternal(url: string): Promise<string>;
  addListener<K extends keyof BrowserKitEvents>(event: K, listener: BrowserKitEvents[K]): EventSubscription;
}

export const BrowserKit = requireOptionalNativeModule<BrowserKitNative>('CorvusBrowserKit');

/** Cookie banners (configurePrivacy, onConsent) and clearing the sites' data, the same on Android and iOS. */
export interface ConsentKitNative {
  configurePrivacy(consent: boolean, gpc: boolean, consentAllowedSites: string[]): void;
  /** Forgets cookies, site storage and the cache of every site. */
  clearBrowsingData(): Promise<boolean>;
  addListener(event: 'onConsent', listener: BrowserKitEvents['onConsent']): EventSubscription;
}

export const ConsentKit: ConsentKitNative | null = BrowserKit ?? requireOptionalNativeModule<ConsentKitNative>('CorvusConsentKit');
