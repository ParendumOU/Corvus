import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ipcMain, net, webContents as allWebContents, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents } from "electron";
import { ElectronBlocker, Request, adsAndTrackingLists, fromElectronDetails } from "@ghostery/adblocker-electron";
import {
  ADBLOCK_RESOURCE_SCHEME,
  ADBLOCK_SCRIPTLETS_CHANNEL,
  BlockedCounts,
  DEFAULT_ADBLOCK_SETTINGS,
  bundleScriptlets,
  decodeDataUrl,
  addAllowed,
  hostFromUrl,
  isBlockablePageUrl,
  isHostAllowed,
  isNeverBlockedUrl,
  removeAllowed,
  reviveAdblockSettings,
  shouldBlockPage,
  type AdblockBarState,
  type AdblockListSource,
  type AdblockListsInfo,
  type AdblockSettings,
  type AdblockView,
} from "../shared/adblock";
import { FALLBACK_FILTERS } from "./adblock-fallback";
import { JsonFile } from "./json-file";
import { paths } from "./paths";

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

const ENGINE_CONFIG = { enableMutationObserver: true, guessRequestTypeFromUrl: true } as const;
/**
 * The lists Brave and uBlock Origin block with: EasyList and EasyPrivacy plus uBlock Origin's own
 * filters (with its quick fixes, where sites like YouTube are kept ad-free) and Peter Lowe's list,
 * as Ghostery mirrors them. A cached engine built from another set is rebuilt.
 */
const LIST_URLS = adsAndTrackingLists;
const LIST_SET = "ghostery-ads-and-tracking-1";
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const STATS_THROTTLE_MS = 500;
const STAND_IN_TTL_MS = 60_000;

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
}

interface ListMeta {
  updatedAt: number | null;
  source: AdblockListSource;
  filterCount: number;
  /** Which list set the cached engine was built from. */
  lists?: string;
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
        return { version: 1, enabled: s.enabled, allowed: s.allowed };
      },
      300,
    );
  }

  settings(): AdblockSettings {
    const f = this.file.get();
    return { enabled: f.enabled, allowed: f.allowed };
  }

  view(lists: AdblockListsInfo): AdblockView {
    const f = this.file.get();
    return { enabled: f.enabled, allowedSites: f.allowed, lists };
  }

  onChange(listener: () => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  onStats(listener: () => void): () => void {
    this.emitter.on("stats", listener);
    return () => this.emitter.off("stats", listener);
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
  private blocker: ElectronBlocker;
  private meta: ListMeta;
  private updating = false;
  private readonly attachments: Attachment[] = [];
  private readonly cacheDir: string;
  private readonly enginePath: string;
  private readonly metaPath: string;
  private readonly cosmeticPreload = resolveCosmeticPreload();
  /** $redirect stand-ins waiting to be loaded, by one-time token (oldest first). */
  private readonly standIns = new Map<string, { type: string; bytes: Uint8Array; at: number }>();

  constructor(
    userDataDir: string,
    private readonly onProfileChange: (profileId: string) => void,
  ) {
    this.cacheDir = path.join(userDataDir, "adblock");
    this.enginePath = path.join(this.cacheDir, "engine.bin");
    this.metaPath = path.join(this.cacheDir, "meta.json");
    const loaded = this.loadFromCache() ?? this.buildFallback();
    this.blocker = loaded.blocker;
    this.meta = loaded.meta;
    this.registerCosmeticHandlers();
    this.scheduleRefresh();
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
      if (details.resourceType === "mainFrame" || isNeverBlockedUrl(details.url)) {
        callback({});
        return;
      }
      const tabId = details.webContentsId ?? 0;
      if (!this.pageBlocks(controller, tabId, details.referrer)) {
        callback({});
        return;
      }
      const request = fromElectronDetails(details);
      if (request.type === "other") request.guessTypeOfRequest();
      const { match, redirect } = this.blocker.match(request);
      const standIn = redirect ? this.standInUrl(redirect.dataUrl) : null;
      if (standIn) {
        controller.recordBlocked(tabId);
        callback({ redirectURL: standIn });
      } else if (match || redirect) {
        controller.recordBlocked(tabId);
        callback({ cancel: true });
      } else {
        callback({});
      }
    });

    session.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
      if (!this.pageBlocks(controller, details.webContentsId ?? 0, details.referrer)) {
        callback({});
        return;
      }
      this.blocker.onHeadersReceived(details, callback);
    });
    attachment.registered = true;
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
    return { ...this.meta, updating: this.updating };
  }

  /** Forces a fresh fetch of the filter lists now. */
  async updateNow(): Promise<AdblockListsInfo> {
    await this.refresh(true);
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

  /** Whether blocking runs for this request's top page (web page, enabled, not allow-listed). */
  private pageBlocks(controller: AdblockController, webContentsId: number, referrer: string): boolean {
    const pageUrl = this.pageUrl(webContentsId, referrer);
    if (!isBlockablePageUrl(pageUrl)) return false;
    return shouldBlockPage(controller.settings(), hostFromUrl(pageUrl) ?? "");
  }

  private registerCosmeticHandlers(): void {
    ipcMain.handle(COSMETIC_INJECT_CHANNEL, (event, url: unknown, msg?: unknown) => {
      const controller = this.controllerFor(event.sender.session);
      if (!controller || typeof url !== "string") return undefined;
      if (!isBlockablePageUrl(url) || !shouldBlockPage(controller.settings(), hostFromUrl(url) ?? "")) return undefined;
      this.injectStyles(event, url, msg);
      return undefined;
    });
    ipcMain.handle(COSMETIC_MUTATION_CHANNEL, (event) => this.blocker.onIsMutationObserverEnabled(event));
    ipcMain.on(ADBLOCK_SCRIPTLETS_CHANNEL, (event, url: unknown) => {
      event.returnValue = this.scriptletsFor(event, url);
    });
  }

  /**
   * Element hiding for a page: site and generic rules when it starts, then rules for the ids and
   * classes it adds. Scriptlets are not run from here: the scriptlets preload runs them earlier.
   */
  private injectStyles(event: IpcMainInvokeEvent, url: string, msg: unknown): void {
    const update = msg && typeof msg === "object" ? (msg as CosmeticUpdate) : undefined;
    const first = update === undefined;
    const { hostname, domain } = Request.fromRawDetails({ url });
    const { active, styles } = this.blocker.getCosmeticsFilters({
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

  /** Scriptlets for a frame that is starting, answered synchronously; [] when nothing should run. */
  private scriptletsFor(event: IpcMainEvent, url: unknown): string[] {
    try {
      if (typeof url !== "string" || !isBlockablePageUrl(url)) return [];
      const controller = this.controllerFor(event.sender.session);
      if (!controller) return [];
      // The site allow list goes by the tab's page; a subframe asks with its own address.
      const isTop = event.senderFrame?.parent === null;
      const page = isTop ? url : event.sender.getURL() || url;
      if (!isBlockablePageUrl(page) || !shouldBlockPage(controller.settings(), hostFromUrl(page) ?? "")) return [];
      const { hostname, domain } = Request.fromRawDetails({ url });
      const { active, scripts } = this.blocker.getCosmeticsFilters({
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
      return active && scripts.length > 0 ? [bundleScriptlets(scripts)] : [];
    } catch {
      return [];
    }
  }

  private controllerFor(session: Session): AdblockController | undefined {
    return this.attachments.find((a) => a.session === session)?.controller;
  }

  private buildFallback(): { blocker: ElectronBlocker; meta: ListMeta } {
    const blocker = ElectronBlocker.parse(FALLBACK_FILTERS, ENGINE_CONFIG);
    return { blocker, meta: { updatedAt: null, source: "bundled", filterCount: this.countFilters(blocker) } };
  }

  private loadFromCache(): { blocker: ElectronBlocker; meta: ListMeta } | null {
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath, "utf8")) as ListMeta;
      const bytes = fs.readFileSync(this.enginePath);
      const blocker = ElectronBlocker.deserialize(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return {
        blocker,
        meta: {
          updatedAt: meta.updatedAt ?? null,
          source: "cache",
          filterCount: meta.filterCount ?? this.countFilters(blocker),
          ...(typeof meta.lists === "string" ? { lists: meta.lists } : {}),
        },
      };
    } catch {
      return null;
    }
  }

  private countFilters(blocker: ElectronBlocker): number {
    const f = blocker.getFilters();
    return f.networkFilters.length + f.cosmeticFilters.length;
  }

  /** Whether the engine in use is a cached one, built from today's list set, less than a week ago. */
  private fresh(): boolean {
    return this.meta.source === "cache" && this.meta.lists === LIST_SET && this.meta.updatedAt !== null && Date.now() - this.meta.updatedAt <= REFRESH_MS;
  }

  private scheduleRefresh(): void {
    if (!this.fresh()) setTimeout(() => void this.refresh(false), 4000).unref();
    setInterval(() => void this.refresh(false), REFRESH_MS).unref();
  }

  private async refresh(force: boolean): Promise<void> {
    if (this.updating) return;
    if (!force && this.fresh()) return;
    this.updating = true;
    this.notifyAll();
    try {
      const blocker = await ElectronBlocker.fromLists((url) => net.fetch(url), LIST_URLS, ENGINE_CONFIG);
      this.blocker = blocker;
      this.meta = { updatedAt: Date.now(), source: "network", filterCount: this.countFilters(blocker), lists: LIST_SET };
      this.writeCache(blocker);
    } catch (err) {
      console.warn(`[corvus] adblock list refresh failed: ${(err as Error).message}`);
    } finally {
      this.updating = false;
      this.notifyAll();
    }
  }

  private notifyAll(): void {
    for (const { profileId } of this.attachments) this.onProfileChange(profileId);
  }

  private writeCache(blocker: ElectronBlocker): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(this.enginePath, Buffer.from(blocker.serialize()));
      fs.writeFileSync(this.metaPath, JSON.stringify({ updatedAt: this.meta.updatedAt, filterCount: this.meta.filterCount, lists: this.meta.lists }), "utf8");
    } catch (err) {
      console.warn(`[corvus] adblock cache write failed: ${(err as Error).message}`);
    }
  }
}
