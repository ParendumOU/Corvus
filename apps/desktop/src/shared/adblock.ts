/**
 * Pure ad/tracker-blocker logic shared by the main process, the chrome UI and corvus://settings.
 * No Electron imports: the per-site/global decision and the per-tab blocked counter are unit tested
 * here; the engine wiring lives in main/adblock.ts.
 */

export type AdblockListSource = "bundled" | "cache" | "network";

/** Sync IPC a starting web frame uses to fetch its scriptlets (they must run before the page's scripts). */
export const ADBLOCK_SCRIPTLETS_CHANNEL = "corvus:adblock-scriptlets";

/** What a starting frame gets: the scripts to run, and whether to watch YouTube's player for the loop. */
export interface ScriptletsAnswer {
  scripts: string[];
  watchYouTube: boolean;
}

/** Sync IPC a starting web frame uses to learn whether to answer cookie banners and send GPC. */
export const CONSENT_INIT_CHANNEL = "corvus:consent-init";
/** A frame's content script reports what it did with a cookie banner (see @corvus/shared ConsentEvent). */
export const CONSENT_EVENT_CHANNEL = "corvus:consent-event";

/** What a starting frame gets: whether to run Autoconsent, and whether to set navigator.globalPrivacyControl. */
export interface ConsentInitAnswer {
  consent: boolean;
  gpc: boolean;
}

/** A YouTube page reports that its player is caught in YouTube's ad-blocker loop. */
export const ADBLOCK_YOUTUBE_LOOP_CHANNEL = "corvus:adblock-youtube-loop";

export function isYouTubeHost(host: string): boolean {
  return /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(host);
}

/** How long YouTube stays in the skip-ads fallback before the lists get another try. */
export const YOUTUBE_FALLBACK_MS = 2 * 3_600_000;

/**
 * A stored fallback end that still applies, or null: in the future, and no longer than one fallback
 * (earlier versions set 24 h, with a detector that also fired on previews and Shorts).
 */
export function liveYouTubeFallback(until: unknown, now: number): number | null {
  return typeof until === "number" && until > now && until - now <= YOUTUBE_FALLBACK_MS ? until : null;
}

/**
 * Recognizes the loop YouTube puts a player in when it insists on the ads an ad blocker removed:
 * the watch page's player restarts the same video (a new media source each time) about once a
 * second without ever playing a second of it, while "Experiencing interruptions?" shows. Fed one
 * sample per second with the video being watched (its `v=` id, or "" off a watch page). Previews
 * on the home page and Shorts swiping start many videos quickly, but never the same one: they do
 * not count, and neither does a person skipping between videos.
 */
export class PlaybackLoopDetector {
  private readonly starts: Array<{ src: string; at: number }> = [];
  private videoId = "";

  constructor(
    private readonly restarts = 6,
    private readonly windowMs = 15_000,
  ) {}

  sample(videoId: string, src: string, currentTime: number, now: number): boolean {
    if (!videoId || videoId !== this.videoId || currentTime >= 1) {
      this.videoId = videoId;
      this.starts.length = 0;
      if (!videoId || currentTime >= 1) return false;
    }
    if (src && this.starts[this.starts.length - 1]?.src !== src) this.starts.push({ src, at: now });
    while (this.starts.length > 0 && now - this.starts[0]!.at > this.windowMs) this.starts.shift();
    return this.starts.length >= this.restarts;
  }
}

/**
 * Runs in YouTube pages: an ad that still reaches the player plays muted, at top speed, jumps to
 * its end and is skipped, then the video's own volume and speed come back. The only defence when
 * YouTube refuses to play without its ads, and a safety net when the lists miss one. Plain ES5
 * source (not a bundled function) so it runs in the page as written.
 */
export const YOUTUBE_AD_SKIPPER = `(function () {
  var saved = new WeakMap();
  var SKIP = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button, .ytp-skip-ad button, button[id^="skip-button"], .ytp-ad-skip-button-container button';
  function tick() {
    var player = document.getElementById('movie_player');
    if (!player) return;
    var video = player.querySelector('video.html5-main-video');
    if (!video) return;
    var ad = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
    if (ad) {
      if (!saved.has(video)) saved.set(video, { muted: video.muted, rate: video.playbackRate });
      video.muted = true;
      try { if (video.playbackRate !== 16) video.playbackRate = 16; } catch (e) {}
      if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.25) {
        try { video.currentTime = video.duration - 0.1; } catch (e) {}
      }
      var buttons = player.querySelectorAll(SKIP);
      for (var i = 0; i < buttons.length; i++) buttons[i].click();
    } else if (saved.has(video)) {
      var before = saved.get(video);
      saved.delete(video);
      video.muted = before.muted;
      video.playbackRate = before.rate || 1;
    }
  }
  setInterval(tick, 250);
})();`;

/**
 * Scheme of the harmless stand-ins ($redirect resources: noop scripts, empty images, player stubs)
 * the blocker serves instead of a blocked script. Chromium refuses a redirect to a data: URL
 * (ERR_UNSAFE_REDIRECT), which turns the stand-in into a failed request that breaks players and
 * gives the blocker away.
 */
export const ADBLOCK_RESOURCE_SCHEME = "corvus-resource";

/** The content type and bytes of a data: URL (base64 or plain), or null when it is not one. */
export function decodeDataUrl(url: string): { type: string; bytes: Uint8Array } | null {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma === -1) return null;
  const meta = url.slice(5, comma);
  const data = url.slice(comma + 1);
  const base64 = /;base64$/i.test(meta);
  const type = meta.replace(/;base64$/i, "") || "text/plain";
  if (!base64) return { type, bytes: new TextEncoder().encode(data) };
  const raw = atob(data);
  return { type, bytes: Uint8Array.from(raw, (c) => c.charCodeAt(0)) };
}

/**
 * One program for a page's scriptlets, the way uBlock Origin runs them. Each scriptlet arrives with
 * its helpers inlined as top-level declarations: run side by side in one global scope they clash
 * ("Identifier 'JSONPath' has already been declared"). Here each runs in its own function, a failing
 * one does not stop the rest, and all share one private `scriptletGlobals`, so every scriptlet works
 * with the page's original built-ins even after an earlier one wrapped them.
 */
export function bundleScriptlets(scripts: readonly string[]): string {
  if (scripts.length === 0) return "";
  const parts = scripts.map((s) => `try { (function (scriptletGlobals) {\n${s}\n})(scriptletGlobals); } catch (e) {}`);
  return `(function () {\nvar scriptletGlobals = {};\n${parts.join("\n")}\n})();`;
}

/** Per-profile blocker preferences (stored in the profile data dir, never synced). */
export interface AdblockSettings {
  enabled: boolean;
  /** Hosts the user chose not to block on ("don't block on this site"). */
  allowed: string[];
}

export interface AdblockListsInfo {
  updatedAt: number | null;
  source: AdblockListSource;
  filterCount: number;
  updating: boolean;
}

/** Shown on corvus://settings. */
export interface AdblockView {
  enabled: boolean;
  allowedSites: string[];
  lists: AdblockListsInfo;
  /** Hide cookie notices and other annoyances (their own lists, on top of ads and trackers). */
  annoyances: boolean;
  /** Remove tracking parameters (utm_*, fbclid, gclid, ...) from the addresses you open. */
  cleanUrls: boolean;
  /** Your own rules (uBlock Origin syntax), including elements hidden with "Hide this element". */
  userFilters: string[];
  /** Fingerprinting protection (see AdblockOptions). */
  fingerprinting: boolean;
  /** Sites whose cookies and data are deleted when their last tab closes. */
  forgetSites: string[];
  /** Reject cookie banners automatically (see AdblockOptions). */
  cookieConsent: boolean;
  /** Global Privacy Control (see AdblockOptions). */
  gpc: boolean;
  /** Sites whose cookie banners are left for you to answer. */
  consentAllowedSites: string[];
}

export const MAX_USER_FILTERS = 2000;

/** Your filter list as stored: one rule per line, trimmed, no blanks or repeats, capped. */
export function normalizeUserFilters(lines: readonly string[] | string): string[] {
  const list = typeof lines === "string" ? lines.split(/\r?\n/) : lines;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const line = typeof raw === "string" ? raw.trim() : "";
    if (!line || line.length > 1000 || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_USER_FILTERS) break;
  }
  return out;
}

/** The blocker's per-profile switches beyond on/off and the allow list. */
export interface AdblockOptions {
  annoyances: boolean;
  cleanUrls: boolean;
  /** Fingerprinting protection: canvas, WebGL, audio and device readbacks get per-site noise. */
  fingerprinting: boolean;
  /** Cookie banners are rejected automatically (or hidden when they cannot be), with DuckDuckGo Autoconsent. */
  cookieConsent: boolean;
  /** Global Privacy Control: `Sec-GPC: 1` on requests and `navigator.globalPrivacyControl` in pages. */
  gpc: boolean;
}

export const DEFAULT_ADBLOCK_OPTIONS: AdblockOptions = { annoyances: true, cleanUrls: true, fingerprinting: true, cookieConsent: true, gpc: true };

/**
 * Query parameters that only identify a click, a campaign or a mailing for trackers, never what a
 * page shows: Brave's query filter list plus the utm_ campaign tags.
 */
const TRACKING_PARAMS = new Set([
  "__hsfp", "__hssc", "__hstc", "__s", "_hsenc", "_hsmi", "_openstat", "ck_subscriber_id", "dclid", "fbclid", "gbraid", "gclid",
  "gclsrc", "hsctatracking", "igsh", "igshid", "mc_cid", "mc_eid", "mkt_tok", "ml_subscriber", "ml_subscriber_hash", "msclkid", "oft_c",
  "oft_ck", "oft_d", "oft_id", "oft_ids", "oft_k", "oft_lk", "oft_sk", "oly_anon_id", "oly_enc_id", "rb_clickid", "s_cid", "srsltid",
  "ttclid", "twclid", "vero_conv", "vero_id", "wbraid", "wickedid", "yclid",
]);

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  return TRACKING_PARAMS.has(key) || key.startsWith("utm_");
}

/** The address without its tracking parameters, or null when it has none (or is not a web address). */
export function stripTrackingParams(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.search === "") return null;
  // Pair by pair on the raw query, so the parameters that stay keep their exact encoding (signed
  // addresses break when a parser re-encodes them).
  const pairs = parsed.search.slice(1).split("&");
  const kept = pairs.filter((pair) => {
    const raw = pair.split("=")[0] ?? "";
    let name = raw;
    try {
      name = decodeURIComponent(raw.replace(/\+/g, " "));
    } catch {
      // Malformed escape: judge the raw name.
    }
    return !isTrackingParam(name);
  });
  if (kept.length === pairs.length) return null;
  parsed.search = kept.length > 0 ? `?${kept.join("&")}` : "";
  return parsed.href;
}

/** Pushed to the chrome UI for the active tab's shield button and popover. */
export interface AdblockBarState {
  enabled: boolean;
  /** This site is on the allow list (blocking is paused here). */
  allowed: boolean;
  /** Requests blocked in the active tab since its last navigation. */
  blocked: number;
  /** Requests blocked across the profile this session. */
  total: number;
  /** Active tab host (empty for internal / non-web pages). */
  host: string;
  /** Blocking is actually in effect for the active page. */
  active: boolean;
  /** YouTube refused to play with its ads removed, so its ads are skipped instead for a while. */
  skippingYouTubeAds?: boolean;
  /** This site's cookies and data are deleted when its last tab closes. */
  forgetOnClose?: boolean;
  /** Cookie banners are answered automatically (the feature is on). */
  cookieConsent: boolean;
  /** This site's cookie banner is left for you to answer. */
  consentAllowed: boolean;
  /** The active page's cookie banner: its platform's name (may be empty) and what Corvus did. */
  cookieBanner?: { cmp: string; outcome: "rejected" | "hidden" };
  /** Cookie banners rejected or hidden across the profile this session. */
  bannersHandled: number;
}

export const DEFAULT_ADBLOCK_SETTINGS: AdblockSettings = { enabled: true, allowed: [] };

export function reviveAdblockSettings(raw: unknown): AdblockSettings {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<AdblockSettings>;
  const allowed = Array.isArray(data.allowed)
    ? [...new Set(data.allowed.filter((h): h is string => typeof h === "string").map(normalizeHost).filter((h) => h !== ""))].sort()
    : [];
  return { enabled: data.enabled !== false, allowed };
}

/** Lower-cases a host, drops a trailing dot and a single leading `www.` so the allow list is forgiving. */
export function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase();
  if (host === "") return "";
  if (host.includes("://") || host.includes("/")) {
    const parsed = hostFromUrl(host.includes("://") ? host : `http://${host}`);
    host = parsed ?? "";
  }
  host = host.replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

export function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Loopback hosts (this computer: `localhost`, 127.x.x.x, ::1) are never blocked: apps such as Autofirma serve pages there. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(h) || h === "::1" || h === "[::1]";
}

/** Request destinations Corvus must never block regardless of filters: corvus://, loopback, non-web. */
export function isNeverBlockedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  return isLoopbackHost(parsed.hostname);
}

/**
 * Whether a page is one where blocking can run at all: only real http(s) documents. This excludes
 * corvus:// internal pages and other schemes (so Corvus never filters its own UI), but a page served
 * from a loopback dev server is still blockable — "never block localhost" is about request targets.
 */
export function isBlockablePageUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function isHostAllowed(pageHost: string, allowed: readonly string[]): boolean {
  const host = normalizeHost(pageHost);
  if (host === "") return false;
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function addAllowed(allowed: readonly string[], host: string): string[] {
  const h = normalizeHost(host);
  if (h === "") return [...allowed];
  return [...new Set([...allowed, h])].sort();
}

export function removeAllowed(allowed: readonly string[], host: string): string[] {
  const h = normalizeHost(host);
  return allowed.filter((entry) => entry !== h);
}

/**
 * Whether blocking should run for a page at `pageHost`: the profile toggle is on, the host is known
 * and the site is not on the allow list. The caller is responsible for excluding non-web pages
 * (corvus://) via `isBlockablePageUrl` and never-blocked request targets via `isNeverBlockedUrl`.
 */
export function shouldBlockPage(settings: AdblockSettings, pageHost: string): boolean {
  const host = normalizeHost(pageHost);
  if (host === "") return false;
  if (!settings.enabled) return false;
  return !isHostAllowed(host, settings.allowed);
}

/** Per-tab blocked-request counter plus a profile-wide running total (keyed by webContents id). */
export class BlockedCounts {
  private readonly perTab = new Map<number, number>();
  private totalBlocked = 0;

  record(tabId: number): number {
    const next = (this.perTab.get(tabId) ?? 0) + 1;
    this.perTab.set(tabId, next);
    this.totalBlocked += 1;
    return next;
  }

  get(tabId: number): number {
    return this.perTab.get(tabId) ?? 0;
  }

  /** New navigation in a tab: clear its running count (the profile total is kept). */
  reset(tabId: number): void {
    this.perTab.delete(tabId);
  }

  /** Tab closed: drop its entry. */
  forget(tabId: number): void {
    this.perTab.delete(tabId);
  }

  total(): number {
    return this.totalBlocked;
  }
}
