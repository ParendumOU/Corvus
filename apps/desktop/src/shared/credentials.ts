/**
 * Pure, unit-tested helpers for the password manager: the stored credential shape, origin
 * normalization used for autofill matching, list search and the password generator. No Node or
 * Electron imports so this runs in the main process, the renderer and tests alike.
 */
import { siteOf } from "./tab-organizer";
import { isValidTotpConfig, type TotpConfig } from "./totp";

/** A stored login. Synced as the `credentials` collection; password/notes/totp are secret. */
export interface Credential {
  id: string;
  /** Normalized origin (scheme://host[:port]) the login belongs to. */
  origin: string;
  username: string;
  password: string;
  notes?: string;
  /** Optional 2FA generator. Keeping it next to the password turns two factors into one. */
  totp?: TotpConfig;
  /** Opt-in: AI agents may fill this login's current 2FA code (never shown to them). Default off. */
  agentTotp?: boolean;
  /** Opt-in: AI agents may sign in with this login (filled by reference, never shown to them). Default off. */
  agentSignIn?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** List/search view: never carries the password, notes body or 2FA secret. */
export interface CredentialSummary {
  id: string;
  origin: string;
  username: string;
  hasNotes: boolean;
  /** False for a login that holds only a 2FA (what an authenticator import makes when no login matched). */
  hasPassword: boolean;
  hasTotp: boolean;
  agentTotp: boolean;
  agentSignIn: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Where a login comes from: the built-in vault or a KeePass database. */
export type CredentialSource = "corvus" | "keepass";

/**
 * One account the autofill offers for the current page (no secrets): the saved logins of one username
 * on the page's site, merged. The id is opaque; the main process resolves it against the page again.
 */
export interface CredentialMatch {
  id: string;
  username: string;
  /** Host (and port) the password is saved for, without the protocol, e.g. "central.example.com". */
  site: string;
  /** Some login of the account has a password; false for an account that holds only a 2FA. */
  hasPassword: boolean;
  /** Some login of the account has a 2FA generator, so its current code can be filled. */
  hasTotp: boolean;
  /** Where the password comes from (or the 2FA, for an account without a password). */
  source: CredentialSource;
  /** KeePass database name for KeePass logins. */
  sourceName?: string;
  /** "exact": a login of the account is saved for the page's own host; "domain": only for other hosts of its domain. */
  fit: "exact" | "domain";
}

/** Between the parts of an account's label in menus. */
export const LABEL_SEPARATOR = "  \u00b7  ";

/**
 * What a menu shows next to an account's username: the site its password is saved for, its KeePass
 * database (unless the menu has a line of its own for it) and `twoFaOnly` when it has no password
 * ("" to leave that out).
 */
export function accountDetails(m: CredentialMatch, twoFaOnly: string, opts: { source?: boolean } = {}): string[] {
  const source = m.source === "keepass" && opts.source !== false ? [m.sourceName ? `KeePass: ${m.sourceName}` : "KeePass"] : [];
  return [...(m.site ? [m.site] : []), ...source, ...(m.hasPassword || !twoFaOnly ? [] : [twoFaOnly])];
}

/**
 * The accounts a page's menus list first, and the ones they keep apart ("Other example.com
 * accounts"): those saved for the page's own host come first, and the accounts of the domain's other
 * hosts wait in their own section; when the page's host has none, the domain's accounts come first.
 */
export function splitAccounts<T extends Pick<CredentialMatch, "fit">>(matches: readonly T[]): { first: T[]; others: T[] } {
  const first = matches.filter((m) => m.fit === "exact");
  return first.length > 0 ? { first, others: matches.filter((m) => m.fit !== "exact") } : { first: [...matches], others: [] };
}

/** A label cut to `max` characters in the middle, so both ends of a long e-mail address stay readable. */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  return `${text.slice(0, head)}\u2026${text.slice(text.length - (max - 1 - head))}`;
}

/**
 * Hosting suffixes where every subdomain belongs to someone else: logins saved on one never show on
 * another (each host keeps its own logins).
 */
const SHARED_HOSTING = [
  "herokuapp.com", "blogspot.com", "appspot.com", "firebaseapp.com", "web.app", "pages.dev", "workers.dev", "azurewebsites.net",
  "azurestaticapps.net", "cloudapp.net", "cloudfront.net", "amazonaws.com", "amplifyapp.com", "onrender.com", "fly.dev", "glitch.me",
  "ngrok.io", "ngrok-free.app", "ngrok.app", "trycloudflare.com", "duckdns.org", "no-ip.org", "myshopify.com", "wixsite.com",
  "bitbucket.io", "readthedocs.io", "surge.sh", "replit.dev", "repl.co", "deno.dev", "supabase.co", "neocities.org",
  "github.io", "gitlab.io", "vercel.app", "netlify.app",
];

/**
 * The domain a login is shared across: "central.example.com" and "example.com" give "example.com". ""
 * for hosts whose logins stay on the host itself: IP addresses, localhost and other single labels, and
 * shared hosting suffixes.
 */
export function loginDomainOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return "";
  if (SHARED_HOSTING.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))) return "";
  const site = siteOf(`https://${h}`);
  return site.includes(".") ? site : "";
}

/**
 * How a login saved for `entry` (scheme, host, port; scheme null for a bare host) fits a page: "exact"
 * for the page's own origin (or host, for a bare host), "domain" for another host of the same
 * registrable domain (see loginDomainOf), else null. A login saved for https never fits an http page.
 */
export function loginFit(entry: { scheme: "http:" | "https:" | null; host: string; port: string }, pageUrl: string): "exact" | "domain" | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") return null;
  if (entry.scheme === "https:" && page.protocol === "http:") return null;
  const host = page.hostname.toLowerCase();
  const port = page.port && page.port !== (page.protocol === "https:" ? "443" : "80") ? page.port : "";
  if (host === entry.host && port === entry.port && (entry.scheme === null || entry.scheme === page.protocol)) return "exact";
  const domain = loginDomainOf(host);
  return domain && domain === loginDomainOf(entry.host) ? "domain" : null;
}

/**
 * Normalize a URL or origin to `scheme://host[:port]` for matching, lowercasing the host and dropping
 * the default port. Returns "" for anything that is not http(s) (so internal pages never match).
 */
export function originKeyOf(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
}

/** A credential is complete enough to store/sync. */
export function isValidCredential(value: unknown): value is Credential {
  const v = value as Partial<Credential> | null;
  return (
    typeof v?.id === "string" &&
    typeof v.origin === "string" &&
    v.origin.length > 0 &&
    typeof v.username === "string" &&
    typeof v.password === "string" &&
    (v.notes === undefined || typeof v.notes === "string") &&
    (v.totp === undefined || isValidTotpConfig(v.totp)) &&
    (v.agentTotp === undefined || typeof v.agentTotp === "boolean") &&
    (v.agentSignIn === undefined || typeof v.agentSignIn === "boolean") &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}

export function credentialSummary(c: Credential): CredentialSummary {
  return {
    id: c.id,
    origin: c.origin,
    username: c.username,
    hasNotes: Boolean(c.notes && c.notes.trim()),
    hasPassword: c.password !== "",
    hasTotp: Boolean(c.totp),
    agentTotp: c.agentTotp === true,
    agentSignIn: c.agentSignIn === true,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** Logins whose origin matches the given page URL/origin, newest-used first. */
export function matchCredentials(list: Credential[], pageUrl: string): Credential[] {
  const origin = originKeyOf(pageUrl);
  if (!origin) return [];
  return list.filter((c) => c.origin === origin).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Case-insensitive search over origin, host and username; newest-updated first. */
export function searchCredentials(list: CredentialSummary[], query: string): CredentialSummary[] {
  const q = query.trim().toLowerCase();
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!q) return sorted;
  return sorted.filter((c) => c.origin.toLowerCase().includes(q) || hostOf(c.origin).includes(q) || c.username.toLowerCase().includes(q));
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
}

export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = { length: 20, lowercase: true, uppercase: true, digits: true, symbols: true };

const CHARSETS = {
  lowercase: "abcdefghijkmnpqrstuvwxyz",
  uppercase: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*-_=+?",
} as const;

/** One uniformly random index in [0, max) using rejection sampling over Web Crypto bytes. */
function randomIndex(max: number): number {
  const limit = 256 - (256 % max);
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
}

/**
 * A random password from the selected character classes, guaranteeing at least one character from each
 * enabled class. Ambiguous characters (0/O, 1/l/I) are excluded from the pools.
 */
export function generatePassword(opts: PasswordOptions): string {
  const pools: string[] = [];
  if (opts.lowercase) pools.push(CHARSETS.lowercase);
  if (opts.uppercase) pools.push(CHARSETS.uppercase);
  if (opts.digits) pools.push(CHARSETS.digits);
  if (opts.symbols) pools.push(CHARSETS.symbols);
  if (pools.length === 0) pools.push(CHARSETS.lowercase);

  const length = Math.max(pools.length, Math.min(128, Math.floor(opts.length) || 0));
  const all = pools.join("");
  const chars: string[] = pools.map((pool) => pool[randomIndex(pool.length)]!);
  for (let i = chars.length; i < length; i++) chars.push(all[randomIndex(all.length)]!);

  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}
