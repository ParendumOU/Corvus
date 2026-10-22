/**
 * Pure, unit-tested helpers for the password manager: the stored credential shape, origin
 * normalization used for autofill matching, list search and the password generator. No Node or
 * Electron imports so this runs in the main process, the renderer and tests alike.
 */
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
  hasTotp: boolean;
  agentTotp: boolean;
  agentSignIn: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Where a login comes from: the built-in vault or a KeePass database. */
export type CredentialSource = "corvus" | "keepass";

/** A single login the autofill dropdown offers for the current page (no secrets). */
export interface CredentialMatch {
  id: string;
  username: string;
  /** The login has a 2FA generator, so its current code can be filled. */
  hasTotp: boolean;
  source: CredentialSource;
  /** KeePass database name for KeePass logins. */
  sourceName?: string;
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
