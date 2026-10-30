/**
 * What the autofill remembers per site, kept with the profile's site settings (local, never synced,
 * no secrets): the account filled last on a site, so a page with several accounts offers it first,
 * and the hosts where the person chose "Never for this site" in the save-password prompt.
 */
import { loginDomainOf } from "./credentials";

/** Sites whose last filled account is remembered; the oldest is forgotten past this. */
export const MAX_LAST_LOGINS = 500;
/** Hosts on the "Never saved" list; the oldest is forgotten past this. */
export const MAX_NEVER_SAVE = 1000;

/** Per site: the id of a login of the account filled last there, and when. */
export type LastLogins = Record<string, { id: string; at: number }>;

/**
 * The site an account was filled for: the registrable domain the page's accounts are shared across
 * (a two-step sign-in may ask for the code on another host of it), else the host itself. "" for a
 * page that is not a web page.
 */
export function autofillSiteOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return loginDomainOf(u.hostname) || u.host.toLowerCase();
  } catch {
    return "";
  }
}

/** The exact host (and port) of a page or origin, as the "Never saved" list keeps it; "" when it has none. */
export function neverSaveHostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host.toLowerCase() : "";
  } catch {
    return "";
  }
}

const isHost = (value: unknown): value is string => typeof value === "string" && value.length <= 260 && /^(\[[0-9a-f:.]+\]|[a-z0-9_-]+(\.[a-z0-9_-]+)*)(:\d{1,5})?$/.test(value);

/** The remembered last logins from disk: well-formed entries only, at most MAX_LAST_LOGINS, newest kept. */
export function reviveLastLogins(raw: unknown): LastLogins {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).flatMap(([site, value]) => {
    const v = value as { id?: unknown; at?: unknown } | null;
    return site && site.length <= 260 && typeof v?.id === "string" && v.id.length > 0 && v.id.length <= 256 && typeof v.at === "number" && Number.isFinite(v.at)
      ? [[site, { id: v.id, at: v.at }] as const]
      : [];
  });
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_LAST_LOGINS));
}

/** Notes the account filled on a site; past MAX_LAST_LOGINS sites the one used longest ago is forgotten. */
export function noteLastLogin(map: LastLogins, site: string, id: string, at: number): LastLogins {
  if (!site || !id) return map;
  const next: LastLogins = { ...map, [site]: { id, at } };
  const sites = Object.keys(next);
  if (sites.length <= MAX_LAST_LOGINS) return next;
  const oldest = sites.reduce((a, b) => ((next[a]?.at ?? 0) <= (next[b]?.at ?? 0) ? a : b));
  delete next[oldest];
  return next;
}

/** The "Never saved" list from disk: valid hosts, lowercased, each once, at most MAX_NEVER_SAVE. */
export function reviveNeverSave(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((h) => (typeof h === "string" ? h.trim().toLowerCase() : "")).filter(isHost))].slice(-MAX_NEVER_SAVE);
}

/** The list with `host` added (last), unless it is already on it; the oldest goes past MAX_NEVER_SAVE. */
export function addNeverSave(list: readonly string[], host: string): string[] {
  const h = host.trim().toLowerCase();
  if (!isHost(h) || list.includes(h)) return [...list];
  return [...list, h].slice(-MAX_NEVER_SAVE);
}
