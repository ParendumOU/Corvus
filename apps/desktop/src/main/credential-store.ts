import crypto from "node:crypto";
import path from "node:path";
import { generateVaultKey, openSecret, sealSecret } from "@corvus/sync-core";
import {
  type Credential,
  type CredentialMatch,
  type CredentialSummary,
  credentialSummary,
  isValidCredential,
  matchCredentials,
  originKeyOf,
  searchCredentials,
} from "../shared/credentials";
import { isValidTotpConfig, type TotpConfig } from "../shared/totp";
import { JsonFile } from "./json-file";
import type { SecretCipher } from "./settings-store";

type Listener = () => void;

class Emitter {
  private readonly listeners = new Set<Listener>();
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(): void {
    for (const l of this.listeners) l();
  }
}

interface StoredEntry {
  id: string;
  origin: string;
  createdAt: number;
  updatedAt: number;
  /** sealSecret(vaultKey, JSON({ username, password, notes, totp, agentTotp, agentSignIn }), aad=id). */
  sealed: string;
}

interface VaultFile {
  v: 1;
  /** Vault key wrapped by the OS keychain (safeStorage). Null when no keychain is available. */
  key: { data: string } | null;
  entries: StoredEntry[];
}

interface Secret {
  username: string;
  password: string;
  notes?: string;
  totp?: TotpConfig;
  agentTotp?: boolean;
  agentSignIn?: boolean;
}

/** Fields a person can set on a login. `totp: null` removes the 2FA generator. */
export interface CredentialInput {
  origin: string;
  username: string;
  password: string;
  notes?: string;
  totp?: TotpConfig | null;
  agentTotp?: boolean;
  agentSignIn?: boolean;
}

export type CredentialPatch = Partial<CredentialInput>;

/** The optional secret extras of a credential, dropping anything malformed or switched off. */
function extras(c: { totp?: TotpConfig | null | undefined; agentTotp?: boolean | undefined; agentSignIn?: boolean | undefined }): Pick<Credential, "totp" | "agentTotp" | "agentSignIn"> {
  const totp = c.totp && isValidTotpConfig(c.totp) ? { ...c.totp } : undefined;
  return {
    ...(totp ? { totp } : {}),
    ...(totp && c.agentTotp === true ? { agentTotp: true } : {}),
    ...(c.agentSignIn === true ? { agentSignIn: true } : {}),
  };
}

const emptyFile = (): VaultFile => ({ v: 1, key: null, entries: [] });

function reviveFile(raw: unknown): VaultFile {
  if (typeof raw !== "object" || raw === null) return emptyFile();
  const r = raw as Partial<VaultFile>;
  const key = r.key && typeof (r.key as { data?: unknown }).data === "string" ? { data: (r.key as { data: string }).data } : null;
  const entries = Array.isArray(r.entries)
    ? r.entries.filter(
        (e): e is StoredEntry =>
          typeof e?.id === "string" &&
          typeof e.origin === "string" &&
          typeof e.sealed === "string" &&
          typeof e.createdAt === "number" &&
          typeof e.updatedAt === "number",
      )
    : [];
  return { v: 1, key, entries };
}

/**
 * Per-profile encrypted credential vault (credentials.json). Every login's secret fields are sealed
 * with XChaCha20-Poly1305 (sync-core's vault primitive) under a device-local 256-bit key; that key is
 * wrapped by the OS keychain (Electron safeStorage), so nothing secret is ever at rest in the clear.
 * When no keychain is available (e.g. headless Linux) the vault runs memory-only for the session and
 * never touches disk — matching how SettingsStore handles API keys. Cross-device sync is independent:
 * the sync engine re-encrypts each login with the phrase-derived key (see sync-adapters.ts).
 */
export class CredentialVault {
  private readonly file: JsonFile<VaultFile>;
  private readonly cache = new Map<string, Credential>();
  private key: Uint8Array;
  private readonly persisted: boolean;
  /** Fires on any local or remote change (drives the sync scheduler and page refreshes). */
  readonly changes = new Emitter();

  constructor(dir: string, private readonly cipher: SecretCipher) {
    this.file = JsonFile.load(path.join(dir, "credentials.json"), emptyFile, reviveFile, 0);
    const current = this.file.get();
    this.persisted = cipher.isEncryptionAvailable();

    let key: Uint8Array | null = null;
    if (this.persisted && current.key) {
      try {
        key = Buffer.from(cipher.decryptString(Buffer.from(current.key.data, "base64")), "base64");
        if (key.length !== 32) key = null;
      } catch (err) {
        console.warn("[corvus] could not unwrap the credential vault key; starting an empty vault:", (err as Error).message);
        key = null;
      }
    }
    if (key) {
      this.key = key;
      for (const entry of current.entries) {
        try {
          const secret = JSON.parse(openSecret(key, entry.sealed, entry.id)) as Secret;
          this.cache.set(entry.id, {
            id: entry.id,
            origin: entry.origin,
            username: secret.username,
            password: secret.password,
            ...(secret.notes ? { notes: secret.notes } : {}),
            ...extras(secret),
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          });
        } catch (err) {
          console.warn(`[corvus] dropped an unreadable credential ${entry.id}:`, (err as Error).message);
        }
      }
      if (this.cache.size !== current.entries.length) this.write();
    } else {
      this.key = generateVaultKey();
      // No key on disk (fresh vault, or keychain just became available): persist the wrapped key.
      if (this.persisted) this.write();
      else if (current.entries.length > 0) this.file.set(emptyFile()); // can't read old entries without a key
    }
  }

  /** Whether secrets are written to disk (true when the OS keychain is available). */
  get secretsPersisted(): boolean {
    return this.persisted;
  }

  private emit(): void {
    this.changes.emit();
  }

  list(query = ""): CredentialSummary[] {
    return searchCredentials([...this.cache.values()].map(credentialSummary), query);
  }

  all(): Credential[] {
    return [...this.cache.values()];
  }

  get(id: string): Credential | undefined {
    return this.cache.get(id);
  }

  /** Logins the autofill dropdown may offer for a page (no passwords in the result). */
  matchesFor(url: string): CredentialMatch[] {
    return matchCredentials(this.all(), url).map((c) => ({ id: c.id, username: c.username, hasTotp: Boolean(c.totp), source: "corvus" as const }));
  }

  hasMatch(url: string): boolean {
    return matchCredentials(this.all(), url).length > 0;
  }

  findByLogin(origin: string, username: string): Credential | undefined {
    return this.all().find((c) => c.origin === origin && c.username === username);
  }

  add(input: CredentialInput): Credential {
    const origin = originKeyOf(input.origin) || input.origin.trim();
    if (!origin) throw new Error("A valid site is required");
    const now = Date.now();
    const cred: Credential = {
      id: crypto.randomUUID(),
      origin,
      username: input.username,
      password: input.password,
      ...(input.notes && input.notes.trim() ? { notes: input.notes } : {}),
      ...extras(input),
      createdAt: now,
      updatedAt: now,
    };
    this.cache.set(cred.id, cred);
    this.write();
    this.emit();
    return cred;
  }

  update(id: string, patch: CredentialPatch): Credential | undefined {
    const existing = this.cache.get(id);
    if (!existing) return undefined;
    const origin = patch.origin !== undefined ? originKeyOf(patch.origin) || patch.origin.trim() : existing.origin;
    const notes = patch.notes !== undefined ? patch.notes : existing.notes;
    const { totp: _t, agentTotp: _a, agentSignIn: _s, ...base } = existing;
    const next: Credential = {
      ...base,
      origin: origin || existing.origin,
      username: patch.username ?? existing.username,
      password: patch.password ?? existing.password,
      ...(notes && notes.trim() ? { notes } : {}),
      ...extras({
        totp: patch.totp !== undefined ? patch.totp : existing.totp,
        agentTotp: patch.agentTotp ?? existing.agentTotp,
        agentSignIn: patch.agentSignIn ?? existing.agentSignIn,
      }),
      updatedAt: Date.now(),
    };
    if (!(notes && notes.trim())) delete next.notes;
    this.cache.set(id, next);
    this.write();
    this.emit();
    return next;
  }

  /** Autofill save-on-submit: update the password of an existing login, or create a new one. */
  saveOnSubmit(pageUrl: string, username: string, password: string): Credential {
    const origin = originKeyOf(pageUrl);
    if (!origin) throw new Error("Logins can only be saved for http(s) sites");
    const existing = this.findByLogin(origin, username);
    if (existing) {
      if (existing.password === password) return existing;
      return this.update(existing.id, { password })!;
    }
    return this.add({ origin, username, password });
  }

  remove(id: string): void {
    if (!this.cache.delete(id)) return;
    this.write();
    this.emit();
  }

  /** Apply changes from sync (keyed by credential id), then flush so the engine never loses a write. */
  applyRemote(changes: Array<{ id: string; cred: Credential | null }>): void {
    let changed = false;
    for (const { id, cred } of changes) {
      if (cred === null) {
        changed = this.cache.delete(id) || changed;
      } else if (isValidCredential(cred)) {
        this.cache.set(id, cred);
        changed = true;
      }
    }
    if (!changed) return;
    this.write();
    this.file.flush();
    this.emit();
  }

  private write(): void {
    if (!this.persisted) return;
    const entries: StoredEntry[] = [...this.cache.values()].map((c) => {
      const secret: Secret = { username: c.username, password: c.password, ...(c.notes ? { notes: c.notes } : {}), ...extras(c) };
      return { id: c.id, origin: c.origin, createdAt: c.createdAt, updatedAt: c.updatedAt, sealed: sealSecret(this.key, JSON.stringify(secret), c.id) };
    });
    const wrapped = this.cipher.encryptString(Buffer.from(this.key).toString("base64")).toString("base64");
    this.file.set({ v: 1, key: { data: wrapped }, entries });
  }

  flush(): void {
    this.file.flush();
  }
}
