/**
 * One view over every place a profile's logins come from: the built-in vault and, when configured
 * and unlocked, KeePass databases. Autofill, the 2FA code fill and agent sign-in all go through here,
 * so every source gets the same matching, the same opt-in gates and the same fill-by-reference.
 * Records carry secrets and never leave the main process; callers hand renderers `CredentialMatch`.
 *
 * Two views of a page: the person's autofill offers accounts (`accounts`, `matchesFor`, `accountFor`):
 * the logins of the page's whole site (its own origin first, then the other hosts of its registrable
 * domain) merged by username, so a login with a password and a 2FA-only login of the same user are one
 * account. Agents and auto sign-in keep the page's own logins (`records`, `forPage`): their opt-ins
 * are per login, and a wider match must not widen what they may use.
 */
import { loginFit, matchCredentials, type CredentialMatch, type CredentialSource } from "../shared/credentials";
import type { TotpConfig } from "../shared/totp";
import type { CredentialVault } from "./credential-store";

export interface LoginRecord {
  id: string;
  source: CredentialSource;
  /** KeePass database name; empty for the built-in vault. */
  sourceName: string;
  /** Site shown to people (origin for the vault, the entry URL for KeePass). */
  site: string;
  username: string;
  password: string;
  totp?: TotpConfig;
  /** Opt-in: AI agents may fill this login's 2FA code. */
  agentTotp: boolean;
  /** Opt-in: AI agents may sign in with this login. */
  agentSignIn: boolean;
  updatedAt: number;
}

/** A login saved for the page's site. */
export interface LoginCandidate {
  record: LoginRecord;
  /** "exact": saved for the page's own origin; "domain": for another host of the same registrable domain. */
  fit: "exact" | "domain";
  /** Host (and port) it is saved for, without the protocol. */
  host: string;
}

export interface LoginProvider {
  /** Records that match a page URL, best first: the page's own logins. */
  matches(url: string): LoginRecord[];
  /** Logins saved for the page's site: its own origin and the other hosts of its registrable domain. */
  candidates(url: string): LoginCandidate[];
  get(id: string): LoginRecord | undefined;
}

/** A saved origin ("https://example.com:8443") as loginFit takes it. */
function originEntry(origin: string): { scheme: "http:" | "https:"; host: string; port: string } | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { scheme: url.protocol, host: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return null;
  }
}

/** The built-in vault as a login provider. */
export function vaultProvider(vault: CredentialVault): LoginProvider {
  const toRecord = (c: ReturnType<CredentialVault["all"]>[number]): LoginRecord => ({
    id: c.id,
    source: "corvus",
    sourceName: "",
    site: c.origin,
    username: c.username,
    password: c.password,
    ...(c.totp ? { totp: c.totp } : {}),
    agentTotp: c.agentTotp === true && Boolean(c.totp),
    agentSignIn: c.agentSignIn === true,
    updatedAt: c.updatedAt,
  });
  return {
    matches: (url) => matchCredentials(vault.all(), url).map(toRecord),
    candidates: (url) =>
      vault.all().flatMap((c) => {
        const entry = originEntry(c.origin);
        const fit = entry ? loginFit(entry, url) : null;
        return entry && fit ? [{ record: toRecord(c), fit, host: entry.port ? `${entry.host}:${entry.port}` : entry.host }] : [];
      }),
    get: (id) => {
      const c = vault.get(id);
      return c ? toRecord(c) : undefined;
    },
  };
}

/** The logins of one username on a page's site, merged into what the autofill offers. */
export interface LoginAccount {
  /** Opaque id for the renderer: the id of the primary login. */
  id: string;
  username: string;
  /** Where the password comes from: the best login of the account that has one. */
  password?: LoginCandidate;
  /** Where the 2FA comes from: the password's login when it has one, else the best that has one. */
  totp?: LoginCandidate;
  /** The login the account is shown as: the password's, else the 2FA's, else the best. */
  primary: LoginCandidate;
  /** Every login of the account, best first. */
  entries: LoginCandidate[];
}

/** Best first: the page's own origin, then the most recently updated. */
const byFit = (a: LoginCandidate, b: LoginCandidate): number => Number(b.fit === "exact") - Number(a.fit === "exact") || b.record.updatedAt - a.record.updatedAt;

/**
 * Groups a page's logins by account: the same username, case-insensitive and trimmed, whatever its
 * source. Accounts come in the order of their best login.
 */
export function groupAccounts(candidates: readonly LoginCandidate[]): LoginAccount[] {
  const groups = new Map<string, LoginCandidate[]>();
  for (const c of [...candidates].sort(byFit)) {
    const key = c.record.username.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()].map((entries) => {
    const password = entries.find((e) => e.record.password !== "");
    const totp = password?.record.totp ? password : entries.find((e) => e.record.totp);
    const primary = password ?? totp ?? entries[0]!;
    return { id: primary.record.id, username: primary.record.username, ...(password ? { password } : {}), ...(totp ? { totp } : {}), primary, entries };
  });
}

export function toMatch(account: LoginAccount): CredentialMatch {
  const r = account.primary.record;
  return {
    id: account.id,
    username: account.username,
    site: account.primary.host,
    hasPassword: Boolean(account.password),
    hasTotp: Boolean(account.totp),
    source: r.source,
    ...(r.sourceName ? { sourceName: r.sourceName } : {}),
    fit: account.entries.some((e) => e.fit === "exact") ? "exact" : "domain",
  };
}

export class LoginSources {
  constructor(private readonly providers: () => LoginProvider[]) {}

  /** Every record matching the page, built-in vault first, then KeePass, each newest first. */
  records(url: string): LoginRecord[] {
    return this.providers().flatMap((p) => p.matches(url));
  }

  /** The accounts the autofill offers on a page, best first. */
  accounts(url: string): LoginAccount[] {
    return groupAccounts(this.providers().flatMap((p) => p.candidates(url)));
  }

  matchesFor(url: string): CredentialMatch[] {
    return this.accounts(url).map(toMatch);
  }

  /** The account an id (of any of its logins) names, only if it belongs to the page. */
  accountFor(id: string, url: string): LoginAccount | undefined {
    return this.accounts(url).find((a) => a.entries.some((e) => e.record.id === id));
  }

  get(id: string): LoginRecord | undefined {
    for (const p of this.providers()) {
      const found = p.get(id);
      if (found) return found;
    }
    return undefined;
  }

  /** The record, only if it belongs to the page (so a fill can never cross sites). */
  forPage(id: string, url: string): LoginRecord | undefined {
    return this.records(url).find((r) => r.id === id);
  }
}
