/**
 * The Passwords page's two tabs (the logins, and their 2FA codes): which tab a link opens, paging, the
 * 2FA codes list built from the login summaries, and what deleting a login offers. Pure, no secrets:
 * the codes themselves are fetched one by one from the main process for the rows on screen.
 */
import type { CredentialSummary, CredentialSource } from "./credentials";
import type { KeePassEntryDetails, KeePassEntrySummary } from "./keepass-ipc";

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

/**
 * Whether the KeePass entry form holds anything to write to the database file: a changed field, a new
 * password or a new 2FA. An entry's AI options live in Corvus, so they never count.
 */
export function keepassEntryChanged(loaded: KeePassEntryDetails, form: KeePassEntryDetails, password: string, totp: string): boolean {
  return password !== "" || totp.trim() !== "" || (["title", "username", "url", "notes", "group"] as const).some((field) => loaded[field] !== form[field]);
}

/** Sort key of a site: its host without "www.", lower case. */
const siteKey = (site: string): string => site.replace(/^www\./, "").toLowerCase();

/** The saved logins as the Passwords tab lists them: by site, then username (the columns they show). */
export function sortLogins<T extends { origin: string; username: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => siteKey(hostOf(a.origin)).localeCompare(siteKey(hostOf(b.origin))) || a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
}

/** The logins of the vault and of unlocked KeePass databases that have a 2FA, by site then username. */
export function twoFactorItems(vault: readonly CredentialSummary[], keepass: readonly KeePassEntrySummary[]): TwoFactorItem[] {
  const items: TwoFactorItem[] = [
    ...vault.filter((c) => c.hasTotp).map((c) => ({ id: c.id, source: "corvus" as const, sourceName: "", site: hostOf(c.origin), url: c.origin, username: c.username, title: "", hasPassword: c.hasPassword })),
    ...keepass
      .filter((e) => e.hasTotp)
      .map((e) => ({ id: e.id, source: "keepass" as const, sourceName: e.dbName, site: e.site, url: e.site ? `https://${e.site}` : "", username: e.username, title: e.title, hasPassword: e.hasPassword })),
  ];
  const key = (i: TwoFactorItem): string => siteKey(i.site || i.title);
  return items.sort((a, b) => key(a).localeCompare(key(b)) || a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
}

/** What a delete removes: only the 2FA (the password stays), or the whole login. */
export type DeleteChoice = "totp" | "login";

/** A login to delete, from either tab: what the confirmation names and what it can remove. */
export interface DeleteTarget {
  id: string;
  source: CredentialSource;
  /** KeePass database name; "" for the built-in vault. */
  sourceName: string;
  /** Host, or a KeePass entry's title when it has no address. */
  site: string;
  username: string;
  hasPassword: boolean;
  hasTotp: boolean;
}

export const deleteTargetOf = {
  twoFactor: (i: TwoFactorItem): DeleteTarget => ({ id: i.id, source: i.source, sourceName: i.sourceName, site: i.site || i.title, username: i.username, hasPassword: i.hasPassword, hasTotp: true }),
  login: (c: CredentialSummary): DeleteTarget => ({ id: c.id, source: "corvus", sourceName: "", site: hostOf(c.origin), username: c.username, hasPassword: c.hasPassword, hasTotp: c.hasTotp }),
  keepass: (e: KeePassEntrySummary): DeleteTarget => ({ id: e.id, source: "keepass", sourceName: e.dbName, site: e.site || e.title, username: e.username, hasPassword: e.hasPassword, hasTotp: e.hasTotp }),
};

/**
 * What a delete offers: a login with a password and a 2FA can lose only its 2FA or go whole; any other
 * login only goes whole (a 2FA-only login without its 2FA would be empty).
 */
export function deleteChoices(target: Pick<DeleteTarget, "hasPassword" | "hasTotp">): DeleteChoice[] {
  return target.hasPassword && target.hasTotp ? ["totp", "login"] : ["login"];
}

/** The choice a delete starts on: the one the row is about (its 2FA in the 2FA codes tab), if offered. */
export function initialDeleteChoice(target: Pick<DeleteTarget, "hasPassword" | "hasTotp">, tab: PasswordsTab): DeleteChoice {
  return tab === "2fa" && deleteChoices(target).includes("totp") ? "totp" : "login";
}

/** How long the final "Delete for good" button stays off after it shows, so a double click cannot reach it. */
export const DELETE_ARM_MS = 700;

/** Case-insensitive search over the site, the username, the issuer (entry title) and the database. */
export function searchTwoFactor(items: readonly TwoFactorItem[], query: string): TwoFactorItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((i) => [i.site, i.username, i.title, i.sourceName].some((v) => v.toLowerCase().includes(q)));
}
