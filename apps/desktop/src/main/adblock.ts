import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { ipcMain, webContents as allWebContents, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents } from "electron";
import { ElectronBlocker, Request, fromElectronDetails } from "@ghostery/adblocker-electron";
import {
  ADBLOCK_RESOURCE_SCHEME,
  ADBLOCK_SCRIPTLETS_CHANNEL,
  ADBLOCK_YOUTUBE_LOOP_CHANNEL,
  BlockedCounts,
  DEFAULT_ADBLOCK_OPTIONS,
  DEFAULT_ADBLOCK_SETTINGS,
  stripTrackingParams,
  type AdblockOptions,
  YOUTUBE_AD_SKIPPER,
  bundleScriptlets,
  decodeDataUrl,
  isYouTubeHost,
  normalizeUserFilters,
  addAllowed,
  hostFromUrl,
  isBlockablePageUrl,
  isHostAllowed,
  isNeverBlockedUrl,
  removeAllowed,
  reviveAdblockSettings,
  shouldBlockPage,
  type AdblockBarState,
  type AdblockListsInfo,
  type AdblockSettings,
  type AdblockView,
  type ScriptletsAnswer,
} from "../shared/adblock";
import { farblingScript, fingerprintSeed, siteMatches } from "../shared/privacy";
import { FALLBACK_FILTERS } from "./adblock-fallback";
import { ENGINE_CONFIG } from "./adblock-engine";
import { FilterSet, adsAndTrackingSpec, annoyancesSpec } from "./adblock-lists";
import { elementPickerScript, pickedFilter } from "./adblock-picker";
import { JsonFile } from "./json-file";
import { paths } from "./paths";
import type { BrowserWindowCtl, TabRuntime } from "./window";

/** Isolated world of the "Hide this element" picker. */
const PICKER_WORLD_ID = 1998;

const require_ = createRequire(import.meta.url);

/**
 * The library's content-script preload, registered per profile session for cosmetic filtering.
 * It is a dependency of `@ghostery/adblocker-electron`, so (under pnpm) it is only reachable from that
 * package's own module scope, not from the app. Resolution never throws: without it, network blocking
 * still works and only cosmetic filtering is skipped.
 */
function resolveCosmeticPreload(): string | null {
  try {
    return createRequire(require_.resolve("@ghostery/adblocker-electron")).resolve("@ghostery/adblocker-electron-preload");
  } catch {
    try {
      return require_.resolve("@ghostery/adblocker-electron-preload");
    } catch {
      return null;
    }
  }
}

const COSMETIC_INJECT_CHANNEL = "@ghostery/adblocker/inject-cosmetic-filters";
const COSMETIC_MUTATION_CHANNEL = "@ghostery/adblocker/is-mutation-observer-enabled";

const STATS_THROTTLE_MS = 500;
const STAND_IN_TTL_MS = 60_000;
/** How long YouTube stays in the fallback before the lists get another try. */
const YOUTUBE_FALLBACK_MS = 24 * 3_600_000;

/** DOM features the cosmetic preload reports as a page changes (only these are read). */
interface CosmeticUpdate {
  classes?: string[];
  hrefs?: string[];
  ids?: string[];
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 4096) : undefined;
}

interface AdblockFile {
  version: 1;
  enabled: boolean;
  allowed: string[];
  /** Until when YouTube pages are in the fallback (see AdblockService.inYouTubeFallback); kept across restarts. */
  youtubeFallbackUntil?: number;
  annoyances?: boolean;
  cleanUrls?: boolean;
  userFilters?: string[];
  fingerprinting?: boolean;
  /** Sites forgotten (cookies and data deleted) when their last tab closes. */
  forgetOnClose?: string[];
}

interface Attachment {
  session: Session;
  controller: AdblockController;
  profileId: string;
  /** Whether the webRequest listeners are currently installed on this session. */
  registered: boolean;
}

/** Per-profile blocker state: preferences (persisted) and the live per-tab blocked counter. */
export class AdblockController {
  private readonly file: JsonFile<AdblockFile>;
  private readonly counts = new BlockedCounts();
  private readonly emitter = new EventEmitter();
  private statsTimer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    this.file = JsonFile.load(
      path.join(dir, "adblock.json"),
      () => ({ version: 1, ...DEFAULT_ADBLOCK_SETTINGS }),
      (raw) => {
        const s = reviveAdblockSettings(raw);
        const data = (raw ?? {}) as {
          youtubeFallbackUntil?: unknown;
          annoyances?: unknown;
          cleanUrls?: unknown;
          userFilters?: unknown;
          fingerprinting?: unknown;
          forgetOnClose?: unknown;
        };
        const until = data.youtubeFallbackUntil;
        return {
          version: 1,
          enabled: s.enabled,
          allowed: s.allowed,
          annoyances: data.annoyances !== false,
          cleanUrls: data.cleanUrls !== false,
          fingerprinting: data.fingerprinting !== false,
          userFilters: Array.isArray(data.userFilters) ? normalizeUserFilters(data.userFilters.filter((l): l is string => typeof l === "string")) : [],
          forgetOnClose: reviveAdblockSettings({ allowed: data.forgetOnClose }).allowed,
          ...(typeof until === "number" && until > Date.now() ? { youtubeFallbackUntil: until } : {}),
        };
      },
      300,
    );
  }

  settings(): AdblockSettings {
    const f = this.file.get();
    return { enabled: f.enabled, allowed: f.allowed };
  }

  options(): AdblockOptions {
    const f = this.file.get();
    return {
      annoyances: f.annoyances ?? DEFAULT_ADBLOCK_OPTIONS.annoyances,
      cleanUrls: f.cleanUrls ?? DEFAULT_ADBLOCK_OPTIONS.cleanUrls,
      fingerprinting: f.fingerprinting ?? DEFAULT_ADBLOCK_OPTIONS.fingerprinting,
    };
  }

  setOptions(patch: Partial<AdblockOptions>): void {
    this.file.update((f) => ({
      ...f,
      ...(typeof patch.annoyances === "boolean" ? { annoyances: patch.annoyances } : {}),
      ...(typeof patch.cleanUrls === "boolean" ? { cleanUrls: patch.cleanUrls } : {}),
      ...(typeof patch.fingerprinting === "boolean" ? { fingerprinting: patch.fingerprinting } : {}),
    }));
    this.emitter.emit("change");
  }

  view(lists: AdblockListsInfo): AdblockView {
    const f = this.file.get();
    return { enabled: f.enabled, allowedSites: f.allowed, lists, ...this.options(), userFilters: this.userFilters(), forgetSites: this.forgetSites() };
  }

  /** Sites whose cookies and data go when their last tab closes. */
  forgetSites(): string[] {
    return this.file.get().forgetOnClose ?? [];
  }

  /** The forget-on-close site `host` falls under, if any. */
  forgetSiteFor(host: string): string | undefined {
    return this.forgetSites().find((site) => siteMatches(host, site));
  }

  setForgetOnClose(host: string, forget: boolean): void {
    this.file.update((f) => {
      const list = f.forgetOnClose ?? [];
      return { ...f, forgetOnClose: forget ? addAllowed(list, host) : list.filter((site) => !siteMatches(host, site)) };
    });
    this.emitter.emit("change");
  }

  userFilters(): string[] {
    return this.file.get().userFilters ?? [];
  }

  setUserFilters(lines: readonly string[] | string): void {
    this.file.update((f) => ({ ...f, userFilters: normalizeUserFilters(lines) }));
    this.emitter.emit("change");
  }

  addUserFilter(filter: string): void {
    this.setUserFilters([...this.userFilters(), filter]);
  }

  onChange(listener: () => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  onStats(listener: () => void): () => void {
    this.emitter.on("stats", listener);
    return () => this.emitter.off("stats", listener);
  }

  youtubeFallbackUntil(): number {
    return this.file.get().youtubeFallbackUntil ?? 0;
  }

  setYouTubeFallbackUntil(until: number): void {
    this.file.update((f) => ({ ...f, youtubeFallbackUntil: until }));
  }

  setEnabled(enabled: boolean): void {
    if (this.file.get().enabled === enabled) return;
    this.file.update((f) => ({ ...f, enabled }));
    this.emitter.emit("change");
  }

  setSiteAllowed(host: string, allowed: boolean): void {
    this.file.update((f) => ({ ...f, allowed: allowed ? addAllowed(f.allowed, host) : removeAllowed(f.allowed, host) }));
    this.emitter.emit("change");
  }

  removeAllowed(host: string): void {
    this.file.update((f) => ({ ...f, allowed: removeAllowed(f.allowed, host) }));
    this.emitter.emit("change");
  }

  recordBlocked(tabId: number): void {
    this.counts.record(tabId);
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.emitter.emit("stats");
    }, STATS_THROTTLE_MS);
  }

  resetTab(tabId: number): void {
    this.counts.reset(tabId);
  }

  forgetTab(tabId: number): void {
    this.counts.forget(tabId);
  }

  /** Shield state for the active tab. */
  barState(wc: WebContents | null): AdblockBarState {
    const settings = this.settings();
    const url = wc && !wc.isDestroyed() ? wc.getURL() : "";
    const host = hostFromUrl(url) ?? "";
    const blockable = isBlockablePageUrl(url);
    const allowedHere = blockable && settings.enabled && isHostAllowed(host, settings.allowed);
    return {
      enabled: settings.enabled,
      allowed: allowedHere,
      blocked: wc && !wc.isDestroyed() ? this.counts.get(wc.id) : 0,
      total: this.counts.total(),
      host,
      active: settings.enabled && blockable && !allowedHere,
      ...(settings.enabled && !allowedHere && isYouTubeHost(host) && this.youtubeFallbackUntil() > Date.now() ? { skippingYouTubeAds: true } : {}),
      ...(blockable && host && this.forgetSiteFor(host) ? { forgetOnClose: true } : {}),
    };
  }

  flush(): void {
    this.file.flush();
  }
}

/**
 * Owns the shared Ghostery filter engine and attaches it to each profile session. Filter lists are
 * loaded from a cache (refreshed weekly), fetched fresh on first run, and fall back to a bundled list
 * when offline. Blocking respects the per-profile toggle and per-site allow list, never blocks
 * corvus:// or loopback, and counts blocked requests per tab via each profile's AdblockController.
 */
export class AdblockService {
  /** Ads and trackers: always on while the blocker is. */
  private readonly ads: FilterSet;
  /** Cookie notices and other annoyances: per profile (on by default). */
  private readonly annoyances: FilterSet;
  private readonly attachments: Attachment[] = [];
  private readonly cosmeticPreload = resolveCosmeticPreload();
  /** Fingerprinting noise changes every run: a site sees the same values all session, never across sessions. */
  private readonly sessionKey = randomUUID();
  /** Each profile's own rules as an engine, with the text it was built from. */
  private readonly userEngines = new WeakMap<AdblockController, { text: string; engine: ElectronBlocker | null }>();
  /** $redirect stand-ins waiting to be loaded, by one-time token (oldest first). */
  private readonly standIns = new Map<string, { type: string; bytes: Uint8Array; at: number }>();

  constructor(
    userDataDir: string,
    private readonly onProfileChange: (profileId: string) => void,
  ) {
    const cacheDir = path.join(userDataDir, "adblock");
    this.ads = new FilterSet(cacheDir, adsAndTrackingSpec(FALLBACK_FILTERS), () => this.notifyAll());
    this.annoyances = new FilterSet(cacheDir, annoyancesSpec(), () => this.notifyAll());
    this.registerCosmeticHandlers();
    // One download at a time: ads first, annoyances after.
    this.ads.scheduleRefresh(4000);
    this.annoyances.scheduleRefresh(20_000);
  }

  /** The engines that apply to a profile: ads and trackers, plus annoyances when it wants them. */
  private enginesFor(controller: AdblockController): ElectronBlocker[] {
    const engines = controller.options().annoyances ? [this.ads.blocker, this.annoyances.blocker] : [this.ads.blocker];
    const own = this.userEngine(controller);
    return own ? [...engines, own] : engines;
  }

  /** The profile's own rules as an engine, rebuilt when they change (they are few: parsing is quick). */
  private userEngine(controller: AdblockController): ElectronBlocker | null {
    const text = controller.userFilters().join("\n");
    const cached = this.userEngines.get(controller);
    if (cached?.text === text) return cached.engine;
    let engine: ElectronBlocker | null = null;
    try {
      engine = text ? ElectronBlocker.parse(text, ENGINE_CONFIG) : null;
    } catch {
      engine = null;
    }
    this.userEngines.set(controller, { text, engine });
    return engine;
  }

  /**
   * "Hide this element": runs the picker in the tab's page (starting at a right-clicked point when
   * given), saves the chosen element as this site's rule in the profile's filters and hides it at
   * once. Resolves with the rule, or null when the picker was cancelled.
   */
  async pickElement(win: BrowserWindowCtl, tab: TabRuntime, at?: { x: number; y: number }): Promise<string | null> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return null;
    const url = wc.getURL();
    const host = hostFromUrl(url) ?? "";
    const controller = this.controllerFor(wc.session);
    if (!controller || !isBlockablePageUrl(url) || !host) return null;
    win.activate(tab.id);
    wc.focus();
    const picked = (await wc.executeJavaScriptInIsolatedWorld(PICKER_WORLD_ID, [{ code: elementPickerScript(at ?? {}) }], true).catch(() => null)) as {
      selector?: unknown;
    } | null;
    const filter = pickedFilter(host, picked?.selector);
    if (!filter || wc.isDestroyed()) return null;
    controller.addUserFilter(filter);
    const selector = filter.slice(filter.indexOf("##") + 2);
    await wc.insertCSS(`${selector} { display: none !important; }`, { cssOrigin: "user" }).catch(() => undefined);
    return filter;
  }

  /** Binds blocking to a profile's session and wires its controller's counters. */
  attach(session: Session, controller: AdblockController, profileId: string): void {
    const attachment: Attachment = { session, controller, profileId, registered: false };
    this.attachments.push(attachment);
    if (this.cosmeticPreload) session.registerPreloadScript({ id: "corvus-adblock-cosmetic", type: "frame", filePath: this.cosmeticPreload });
    session.registerPreloadScript({ id: "corvus-adblock-scriptlets", type: "frame", filePath: paths.adblockScriptletsPreload });
    session.protocol.handle(ADBLOCK_RESOURCE_SCHEME, (req) => this.serveStandIn(req.url));

    // Keep the webRequest listeners installed only while this profile's blocker is enabled.
    // Registering any webRequest listener disables Chromium's extension request proxy on the
    // session, so when the built-in blocker is off we remove ours and let extensions filter.
    this.syncListeners(attachment);
    controller.onChange(() => {
      this.syncListeners(attachment);
      this.onProfileChange(profileId);
    });
    controller.onStats(() => this.onProfileChange(profileId));
  }

  /** Installs or removes the session's blocking listeners to match the controller's enabled flag. */
  private syncListeners(attachment: Attachment): void {
    const { session, controller } = attachment;
    const enabled = controller.settings().enabled;
    if (enabled === attachment.registered) return;
    if (!enabled) {
      session.webRequest.onBeforeRequest(null);
      session.webRequest.onHeadersReceived(null);
      attachment.registered = false;
      return;
    }
    session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      if (isNeverBlockedUrl(details.url)) {
        callback({});
        return;
      }
      // Pages themselves are never blocked; their address only loses its tracking parameters.
      if (details.resourceType === "mainFrame" || details.resourceType === "subFrame") {
        const cleaned = this.cleanedNavigation(controller, details);
        if (cleaned || details.resourceType === "mainFrame") {
          callback(cleaned ? { redirectURL: cleaned } : {});
          return;
        }
      }
      const tabId = details.webContentsId ?? 0;
      if (!this.pageBlocks(controller, tabId, details.referrer)) {
        callback({});
        return;
      }
      const request = fromElectronDetails(details);
      if (request.type === "other") request.guessTypeOfRequest();
      for (const engine of this.enginesFor(controller)) {
        const { match, redirect } = engine.match(request);
        const standIn = redirect ? this.standInUrl(redirect.dataUrl) : null;
        if (standIn) {
          controller.recordBlocked(tabId);
          callback({ redirectURL: standIn });
          return;
        }
        if (match || redirect) {
          controller.recordBlocked(tabId);
          callback({ cancel: true });
          return;
        }
      }
      callback({});
    });

    session.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
      if (!this.pageBlocks(controller, details.webContentsId ?? 0, details.referrer)) {
        callback({});
        return;
      }
      this.ads.blocker.onHeadersReceived(details, callback);
    });
    attachment.registered = true;
  }

  /**
   * The address a page or frame navigation should load instead, without its tracking parameters;
   * null to load it as asked (cleaning off, a site you allowed, a form post, nothing to remove).
   */
  private cleanedNavigation(controller: AdblockController, details: Electron.OnBeforeRequestListenerDetails): string | null {
    if (details.method !== "GET" || !controller.options().cleanUrls) return null;
    const blocking =
      details.resourceType === "mainFrame"
        ? shouldBlockPage(controller.settings(), hostFromUrl(details.url) ?? "")
        : this.pageBlocks(controller, details.webContentsId ?? 0, details.referrer);
    return blocking ? stripTrackingParams(details.url) : null;
  }

  /**
   * A one-time address for a $redirect stand-in. The token keeps pages from loading stand-ins on
   * their own (as a CSP bypass, or to detect the blocker); it expires once used or after a minute.
   */
  private standInUrl(dataUrl: string): string | null {
    const resource = decodeDataUrl(dataUrl);
    if (!resource) return null;
    const now = Date.now();
    for (const [token, entry] of this.standIns) {
      if (now - entry.at <= STAND_IN_TTL_MS && this.standIns.size <= 500) break;
      this.standIns.delete(token);
    }
    const token = randomUUID();
    this.standIns.set(token, { ...resource, at: now });
    return `${ADBLOCK_RESOURCE_SCHEME}://r/${token}`;
  }

  private serveStandIn(url: string): Response {
    const token = /^[a-z-]+:\/\/r\/([0-9a-f-]{36})/i.exec(url)?.[1];
    const entry = token ? this.standIns.get(token) : undefined;
    if (!token || !entry || Date.now() - entry.at > STAND_IN_TTL_MS) return new Response(null, { status: 404 });
    this.standIns.delete(token);
    return new Response(entry.bytes, { headers: { "content-type": entry.type, "access-control-allow-origin": "*", "cache-control": "no-store" } });
  }

  listsInfo(): AdblockListsInfo {
    const { updatedAt, source } = this.ads.meta;
    return {
      updatedAt,
      source,
      filterCount: this.ads.meta.filterCount + this.annoyances.meta.filterCount,
      updating: this.ads.updating || this.annoyances.updating,
    };
  }

  /** Forces a fresh fetch of the filter lists now. */
  async updateNow(): Promise<AdblockListsInfo> {
    await this.ads.refresh(true);
    await this.annoyances.refresh(true);
    return this.listsInfo();
  }

  /** Top document URL for a request's tab, falling back to its referrer. */
  private pageUrl(webContentsId: number, referrer: string): string {
    const wc = webContentsId ? allWebContents.fromId(webContentsId) : null;
    if (wc && !wc.isDestroyed()) {
      const url = wc.getURL();
      if (url) return url;
    }
    return referrer;
  }

  /**
   * Whether blocking runs for this request's top page (web page, enabled, not allow-listed). YouTube
   * pages in the fallback get no request blocking: their ads must load to be played (and skipped).
   */
  private pageBlocks(controller: AdblockController, webContentsId: number, referrer: string): boolean {
    const pageUrl = this.pageUrl(webContentsId, referrer);
    if (!isBlockablePageUrl(pageUrl)) return false;
    const host = hostFromUrl(pageUrl) ?? "";
    return shouldBlockPage(controller.settings(), host) && !this.inYouTubeFallback(controller, host);
  }

  /**
   * Whether YouTube pages of this session are in the fallback: YouTube caught a player in its
   * ad-blocker loop (it plays nothing until it gets its ads), so for a while its ads load and the
   * ad skipper gets past them instead of the lists removing them.
   */
  private inYouTubeFallback(controller: AdblockController, host: string): boolean {
    return isYouTubeHost(host) && controller.youtubeFallbackUntil() > Date.now();
  }

  private onYouTubeLoop(event: IpcMainInvokeEvent): boolean {
    const controller = this.controllerFor(event.sender.session);
    const url = event.sender.getURL();
    const host = hostFromUrl(url) ?? "";
    if (!controller || !isYouTubeHost(host) || !shouldBlockPage(controller.settings(), host)) return false;
    if (this.inYouTubeFallback(controller, host)) return false;
    controller.setYouTubeFallbackUntil(Date.now() + YOUTUBE_FALLBACK_MS);
    console.warn(`[corvus] adblock: YouTube refused to play without its ads; skipping them instead for ${YOUTUBE_FALLBACK_MS / 3_600_000} h`);
    return true;
  }

  private registerCosmeticHandlers(): void {
    ipcMain.handle(COSMETIC_INJECT_CHANNEL, (event, url: unknown, msg?: unknown) => {
      const controller = this.controllerFor(event.sender.session);
      if (!controller || typeof url !== "string") return undefined;
      if (!isBlockablePageUrl(url) || !shouldBlockPage(controller.settings(), hostFromUrl(url) ?? "")) return undefined;
      this.injectStyles(event, controller, url, msg);
      return undefined;
    });
    ipcMain.handle(COSMETIC_MUTATION_CHANNEL, (event) => this.ads.blocker.onIsMutationObserverEnabled(event));
    ipcMain.on(ADBLOCK_SCRIPTLETS_CHANNEL, (event, url: unknown) => {
      event.returnValue = this.scriptletsFor(event, url);
    });
    ipcMain.handle(ADBLOCK_YOUTUBE_LOOP_CHANNEL, (event) => this.onYouTubeLoop(event));
  }

  /**
   * Element hiding for a page: site and generic rules when it starts, then rules for the ids and
   * classes it adds. Scriptlets are not run from here: the scriptlets preload runs them earlier.
   */
  private injectStyles(event: IpcMainInvokeEvent, controller: AdblockController, url: string, msg: unknown): void {
    const update = msg && typeof msg === "object" ? (msg as CosmeticUpdate) : undefined;
    const first = update === undefined;
    const { hostname, domain } = Request.fromRawDetails({ url });
    for (const engine of this.enginesFor(controller)) {
      const { active, styles } = engine.getCosmeticsFilters({
        url,
        hostname,
        domain,
        classes: stringList(update?.classes),
        hrefs: stringList(update?.hrefs),
        ids: stringList(update?.ids),
        getBaseRules: first,
        getInjectionRules: false,
        getExtendedRules: false,
        getRulesFromHostname: first,
        getRulesFromDOM: !first,
        callerContext: { frameId: event.frameId, processId: event.processId },
      });
      if (active && styles.length > 0) void event.sender.insertCSS(styles, { cssOrigin: "user" }).catch(() => undefined);
    }
  }

  /** Scripts for a frame that is starting, answered synchronously (nothing when blocking is off). */
  private scriptletsFor(event: IpcMainEvent, url: unknown): ScriptletsAnswer {
    const none: ScriptletsAnswer = { scripts: [], watchYouTube: false };
    try {
      if (typeof url !== "string" || !isBlockablePageUrl(url)) return none;
      const controller = this.controllerFor(event.sender.session);
      if (!controller) return none;
      // The site allow list goes by the tab's page; a subframe asks with its own address.
      const isTop = event.senderFrame?.parent === null;
      const page = isTop ? url : event.sender.getURL() || url;
      const pageHost = hostFromUrl(page) ?? "";
      if (!isBlockablePageUrl(page) || pageHost === "") return none;
      const settings = controller.settings();
      const blocking = shouldBlockPage(settings, pageHost);
      // Fingerprinting protection has its own switch; a site you allowed is left alone entirely.
      const farbling = controller.options().fingerprinting && !isHostAllowed(pageHost, settings.allowed);
      const first = farbling ? [farblingScript(fingerprintSeed(this.sessionKey, Request.fromRawDetails({ url: page }).domain || pageHost))] : [];
      if (!blocking) return { scripts: first, watchYouTube: false };
      const { hostname, domain } = Request.fromRawDetails({ url });
      const youtube = isYouTubeHost(hostname);
      if (this.inYouTubeFallback(controller, pageHost)) return { scripts: [...first, ...(youtube ? [YOUTUBE_AD_SKIPPER] : [])], watchYouTube: false };
      const scripts: string[] = [];
      for (const engine of this.enginesFor(controller)) {
        const found = engine.getCosmeticsFilters({
          url,
          hostname,
          domain,
          getBaseRules: false,
          getInjectionRules: true,
          getExtendedRules: false,
          getRulesFromHostname: true,
          getRulesFromDOM: false,
          callerContext: { frameId: event.frameId, processId: event.processId },
        });
        if (found.active) scripts.push(...found.scripts);
      }
      // One bundle for every engine's scriptlets: they share the page's original built-ins.
      const out = [...first, ...(scripts.length > 0 ? [bundleScriptlets(scripts)] : [])];
      if (youtube) out.push(YOUTUBE_AD_SKIPPER);
      return { scripts: out, watchYouTube: youtube && isTop };
    } catch {
      return none;
    }
  }

  private controllerFor(session: Session): AdblockController | undefined {
    return this.attachments.find((a) => a.session === session)?.controller;
  }

  /** The registrable site of `url` ("mail.google.com" → "google.com"), or its host. */
  siteOf(url: string): string {
    const host = hostFromUrl(url) ?? "";
    try {
      return Request.fromRawDetails({ url }).domain || host;
    } catch {
      return host;
    }
  }

  /**
   * A tab closed: when its site is one to forget and no other open tab of the profile shows it,
   * the site's cookies and stored data (local storage, IndexedDB, caches, service workers) go.
   */
  async onTabClosed(session: Session, url: string, openUrls: readonly string[]): Promise<boolean> {
    const controller = this.controllerFor(session);
    const host = hostFromUrl(url) ?? "";
    const site = controller && host ? controller.forgetSiteFor(host) : undefined;
    if (!site || openUrls.some((u) => siteMatches(hostFromUrl(u) ?? "", site))) return false;
    const cookies = await session.cookies.get({}).catch(() => []);
    await Promise.all(
      cookies
        .filter((c) => c.domain && siteMatches(c.domain.replace(/^\./, ""), site))
        .map((c) => session.cookies.remove(`http${c.secure ? "s" : ""}://${c.domain!.replace(/^\./, "")}${c.path ?? "/"}`, c.name).catch(() => undefined)),
    );
    let pageOrigin = "";
    try {
      pageOrigin = new URL(url).origin;
    } catch {
      // No origin of its own to clear.
    }
    const origins = new Set([pageOrigin, `https://${site}`, `http://${site}`, `https://www.${site}`, `http://www.${site}`].filter(Boolean));
    for (const origin of origins) {
      await session
        .clearStorageData({ origin, storages: ["localstorage", "indexdb", "serviceworkers", "cachestorage", "filesystem", "shadercache"] })
        .catch(() => undefined);
    }
    return true;
  }

  private notifyAll(): void {
    for (const { profileId } of this.attachments) this.onProfileChange(profileId);
  }
}
