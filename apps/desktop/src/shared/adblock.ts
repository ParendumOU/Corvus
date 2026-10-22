/**
 * Pure ad/tracker-blocker logic shared by the main process, the chrome UI and corvus://settings.
 * No Electron imports: the per-site/global decision and the per-tab blocked counter are unit tested
 * here; the engine wiring lives in main/adblock.ts.
 */

export type AdblockListSource = "bundled" | "cache" | "network";

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

/** Loopback / `.localhost` hosts are never blocked. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1" || h === "[::1]";
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
