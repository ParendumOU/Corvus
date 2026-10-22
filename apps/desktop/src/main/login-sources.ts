/**
 * One view over every place a profile's logins come from: the built-in vault and, when configured
 * and unlocked, KeePass databases. Autofill, the 2FA code fill and agent sign-in all go through here,
 * so every source gets the same matching, the same opt-in gates and the same fill-by-reference.
 * Records carry secrets and never leave the main process; callers hand renderers `CredentialMatch`.
 */
import { matchCredentials, type CredentialMatch, type CredentialSource } from "../shared/credentials";
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

export interface LoginProvider {
  /** Records that match a page URL, best first. */
  matches(url: string): LoginRecord[];
  get(id: string): LoginRecord | undefined;
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
    get: (id) => {
      const c = vault.get(id);
      return c ? toRecord(c) : undefined;
    },
  };
}

export function toMatch(r: LoginRecord): CredentialMatch {
  return {
    id: r.id,
    username: r.username,
    hasTotp: Boolean(r.totp),
    source: r.source,
    ...(r.sourceName ? { sourceName: r.sourceName } : {}),
  };
}

export class LoginSources {
  constructor(private readonly providers: () => LoginProvider[]) {}

  /** Every record matching the page, built-in vault first, then KeePass, each newest first. */
  records(url: string): LoginRecord[] {
    return this.providers().flatMap((p) => p.matches(url));
  }

  matchesFor(url: string): CredentialMatch[] {
    return this.records(url).map(toMatch);
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
