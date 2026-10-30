/**
 * The Passwords page's two tabs (the logins, and their 2FA codes): which tab a link opens, paging, and
 * the 2FA codes list built from the login summaries. Pure, no secrets: the codes themselves are
 * fetched one by one from the main process for the rows on screen.
 */
import type { CredentialSummary, CredentialSource } from "./credentials";
import type { KeePassEntrySummary } from "./keepass-ipc";

export type PasswordsTab = "passwords" | "2fa";

/** Rows per page in both tabs. */
export const PAGE_SIZE = 25;

/** The localStorage key of the tab last chosen. */
export const TAB_STORAGE_KEY = "corvus.passwords.tab";

/**
 * The tab the page opens on: the link's hash first ("#2fa", "#passwords", or "#keepass", which is in
 * the passwords tab), else the tab chosen last time, else the passwords.
 */
export function initialTab(hash: string, remembered: string | null): PasswordsTab {
  const h = hash.replace(/^#/, "").toLowerCase();
  if (h === "2fa") return "2fa";
  if (h === "passwords" || h === "keepass") return "passwords";
  return remembered === "2fa" ? "2fa" : "passwords";
}

export const tabHash = (tab: PasswordsTab): string => (tab === "2fa" ? "#2fa" : "#passwords");

/** One page of a list, the page clamped to the ones there are (a list that shrank shows its last page). */
export function pageSlice<T>(items: readonly T[], page: number, size = PAGE_SIZE): { items: T[]; page: number } {
  const last = Math.max(0, Math.ceil(items.length / size) - 1);
  const at = Math.min(Math.max(0, Math.floor(page)), last);
  return { items: items.slice(at * size, at * size + size), page: at };
}

/** A login with a 2FA generator, as the 2FA codes tab lists it. */
export interface TwoFactorItem {
  id: string;
  source: CredentialSource;
  /** KeePass database name; "" for the built-in vault. */
  sourceName: string;
  /** Host without the protocol ("" when a KeePass entry has no address). */
  site: string;
  /** Address for the favicon. */
  url: string;
  username: string;
  /** KeePass entry title (often the issuer); "" for the vault. */
  title: string;
  /** False for a login that holds only the 2FA. */
  hasPassword: boolean;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The logins of the vault and of unlocked KeePass databases that have a 2FA, by site then username. */
export function twoFactorItems(vault: readonly CredentialSummary[], keepass: readonly KeePassEntrySummary[]): TwoFactorItem[] {
  const items: TwoFactorItem[] = [
    ...vault.filter((c) => c.hasTotp).map((c) => ({ id: c.id, source: "corvus" as const, sourceName: "", site: hostOf(c.origin), url: c.origin, username: c.username, title: "", hasPassword: c.hasPassword })),
    ...keepass
      .filter((e) => e.hasTotp)
      .map((e) => ({ id: e.id, source: "keepass" as const, sourceName: e.dbName, site: e.site, url: e.site ? `https://${e.site}` : "", username: e.username, title: e.title, hasPassword: e.hasPassword })),
  ];
  const key = (i: TwoFactorItem): string => (i.site || i.title).replace(/^www\./, "").toLowerCase();
  return items.sort((a, b) => key(a).localeCompare(key(b)) || a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
}

/** Case-insensitive search over the site, the username, the issuer (entry title) and the database. */
export function searchTwoFactor(items: readonly TwoFactorItem[], query: string): TwoFactorItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((i) => [i.site, i.username, i.title, i.sourceName].some((v) => v.toLowerCase().includes(q)));
}
