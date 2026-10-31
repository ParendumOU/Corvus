import crypto from "node:crypto";
import path from "node:path";
import { generateVaultKey, openSecret, sealSecret } from "@corvus/sync-core";
import {
  type Credential,
  type CredentialSummary,
  type DeletedLoginMemory,
  type PasswordHistoryEntry,
  MAX_DELETED_LOGINS,
  credentialSummary,
  isDeletedLoginMemory,
  isValidCredential,
  originKeyOf,
  passwordChangedAtOf,
  searchCredentials,
} from "../shared/credentials";
import {
  type ImportReviewItem,
  type ImportTally,
  type IncomingLogin,
  type MergeLogin,
  emptyTally,
  planImport,
} from "../shared/password-merge";
import { historyMatches, mergeHistory, retire } from "./password-history";
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
  /** ms the password last changed (see Credential.passwordChangedAt). */
  passwordChangedAt?: number;
  /** sealSecret(vaultKey, JSON({ username, password, notes, totp, agentTotp, agentSignIn, passwordHistory }), aad=id). */
  sealed: string;
}

/** A deleted-login memory kept behind the vault (keyed hashes only). */
interface StoredDeletion {
  /** `${origin}\n${username}` - the stable natural id this memory syncs under. */
  key: string;
  origin: string;
  at: number;
  /** sealSecret(vaultKey, JSON({ username, hashes }), aad=key). */
  sealed: string;
}

interface VaultFile {
  v: 1;
  /** Vault key wrapped by the OS keychain (safeStorage). Null when no keychain is available. */
  key: { data: string } | null;
  entries: StoredEntry[];
  /** Logins deleted in Corvus, remembered so a re-import does not resurrect them (see merge rules). */
  deletions?: StoredDeletion[];
}

interface Secret {
  username: string;
  password: string;
  notes?: string;
  totp?: TotpConfig;
  agentTotp?: boolean;
  agentSignIn?: boolean;
  passwordHistory?: PasswordHistoryEntry[];
}

const deletionKey = (origin: string, username: string): string => `${origin}\n${username}`;

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
  const deletions = Array.isArray(r.deletions)
    ? r.deletions.filter(
        (d): d is StoredDeletion =>
          typeof d?.key === "string" && typeof d.origin === "string" && typeof d.sealed === "string" && typeof d.at === "number",
      )
    : [];
  return { v: 1, key, entries, deletions };
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
  /** Deleted-login memory, keyed by `${origin}\n${username}`. */
  private readonly deletions = new Map<string, DeletedLoginMemory>();
  private key: Uint8Array;
  private readonly persisted: boolean;
  /** Fires on any local or remote change (drives the sync scheduler and page refreshes). */
  readonly changes = new Emitter();
  private batchDepth = 0;
  private batchDirty = false;

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
            ...(Array.isArray(secret.passwordHistory) && secret.passwordHistory.length > 0 ? { passwordHistory: secret.passwordHistory } : {}),
            ...(typeof entry.passwordChangedAt === "number" ? { passwordChangedAt: entry.passwordChangedAt } : {}),
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          });
        } catch (err) {
          console.warn(`[corvus] dropped an unreadable credential ${entry.id}:`, (err as Error).message);
        }
      }
      for (const stored of current.deletions ?? []) {
        try {
          const body = JSON.parse(openSecret(key, stored.sealed, stored.key)) as { username: string; hashes: PasswordHistoryEntry[] };
          this.deletions.set(stored.key, { origin: stored.origin, username: body.username, hashes: body.hashes ?? [], at: stored.at });
        } catch {
          // A deletion memory we cannot read is dropped; it only ever blocks a re-import.
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

  /** Writes and announces a local change, once per batch. */
  private changed(): void {
    if (this.batchDepth > 0) {
      this.batchDirty = true;
      return;
    }
    this.write();
    this.emit();
  }

  /** Runs several changes as one: a single write and a single change event (bulk imports). */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      if (--this.batchDepth === 0 && this.batchDirty) {
        this.batchDirty = false;
        this.write();
        this.emit();
      }
    }
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

  findByLogin(origin: string, username: string): Credential | undefined {
    return this.all().find((c) => c.origin === origin && c.username === username);
  }

  /** Usernames of the logins saved for exactly this origin (no passwords). */
  usernamesAt(origin: string): string[] {
    return this.all().filter((c) => c.origin === origin).map((c) => c.username);
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
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.cache.set(cred.id, cred);
    this.changed();
    return cred;
  }

  update(id: string, patch: CredentialPatch): Credential | undefined {
    const existing = this.cache.get(id);
    if (!existing) return undefined;
    const origin = patch.origin !== undefined ? originKeyOf(patch.origin) || patch.origin.trim() : existing.origin;
    const notes = patch.notes !== undefined ? patch.notes : existing.notes;
    const now = Date.now();
    const password = patch.password ?? existing.password;
    const passwordChanged = patch.password !== undefined && patch.password !== existing.password;
    const { totp: _t, agentTotp: _a, agentSignIn: _s, ...base } = existing;
    const next: Credential = {
      ...base,
      origin: origin || existing.origin,
      username: patch.username ?? existing.username,
      password,
      ...(notes && notes.trim() ? { notes } : {}),
      ...extras({
        totp: patch.totp !== undefined ? patch.totp : existing.totp,
        agentTotp: patch.agentTotp ?? existing.agentTotp,
        agentSignIn: patch.agentSignIn ?? existing.agentSignIn,
      }),
      // A changed password retires the old one into history and stamps the change time.
      ...(passwordChanged ? { passwordHistory: retire(existing.passwordHistory ?? [], existing.password, now), passwordChangedAt: now } : {}),
      updatedAt: now,
    };
    if (!(notes && notes.trim())) delete next.notes;
    if (next.passwordHistory && next.passwordHistory.length === 0) delete next.passwordHistory;
    this.cache.set(id, next);
    this.changed();
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

  /**
   * Bring in logins read from a browser or a CSV through the one merge path (see password-merge.ts).
   * Everything but undated conflicts is applied here (as one write); the undated ones come back as a
   * review list for the person to confirm, with their passwords, which stay in the main process.
   */
  importLogins(logins: readonly IncomingLogin[]): {
    tally: ImportTally;
    review: Array<{ origin: string; username: string; password: string }>;
    /** The logins left as they were (an old or older password) and left out (deleted in Corvus): site + username. */
    leftAlone: Array<{ origin: string; username: string }>;
    leftOut: Array<{ origin: string; username: string }>;
  } {
    const tally = emptyTally();
    const review: Array<{ origin: string; username: string; password: string }> = [];
    const leftAlone: Array<{ origin: string; username: string }> = [];
    const leftOut: Array<{ origin: string; username: string }> = [];
    this.batch(() => {
      for (const incoming of logins) {
        if (incoming.password === "") continue;
        const loginsForOrigin: MergeLogin[] = this.all()
          .filter((c) => c.origin === incoming.origin)
          .map((c) => ({ id: c.id, origin: c.origin, username: c.username, password: c.password, changedAt: passwordChangedAtOf(c), ...(c.passwordHistory ? { passwordHistory: c.passwordHistory } : {}) }));
        const deletionsForOrigin = [...this.deletions.values()].filter((d) => d.origin === incoming.origin);
        const plan = planImport(incoming, { loginsForOrigin, deletionsForOrigin, hashMatches: historyMatches });
        const at = incoming.changedAt && incoming.changedAt > 0 ? incoming.changedAt : undefined;
        switch (plan.outcome) {
          case "new": {
            const c = this.add({ origin: incoming.origin, username: incoming.username, password: incoming.password });
            if (at) this.cache.set(c.id, { ...c, passwordChangedAt: at });
            tally.added++;
            break;
          }
          case "updated": {
            const u = this.update(plan.targetId!, { password: incoming.password })!;
            if (at) this.cache.set(u.id, { ...u, passwordChangedAt: at });
            tally.updated++;
            break;
          }
          case "older": {
            const ex = this.cache.get(plan.targetId!)!;
            this.cache.set(ex.id, { ...ex, passwordHistory: retire(ex.passwordHistory ?? [], incoming.password, at ?? Date.now()) });
            this.changed();
            tally.olderLeftAlone++;
            leftAlone.push({ origin: incoming.origin, username: incoming.username });
            break;
          }
          case "history":
            tally.olderLeftAlone++;
            leftAlone.push({ origin: incoming.origin, username: incoming.username });
            break;
          case "alreadySaved":
            tally.alreadySaved++;
            break;
          case "deletedLeftOut":
            tally.deletedLeftOut++;
            leftOut.push({ origin: incoming.origin, username: incoming.username });
            break;
          case "review":
            review.push({ origin: incoming.origin, username: incoming.username, password: incoming.password });
            break;
        }
      }
    });
    return { tally, review, leftAlone, leftOut };
  }

  /** Apply one reviewed overwrite the person confirmed (retiring the old password). */
  updatePasswordForLogin(origin: string, username: string, password: string): boolean {
    const existing = this.findByLogin(origin, username);
    if (!existing || existing.password === password) return false;
    this.update(existing.id, { password });
    return true;
  }

  remove(id: string): void {
    const existing = this.cache.get(id);
    if (!this.cache.delete(id)) return;
    if (existing) this.rememberDeletion(existing);
    this.changed();
  }

  /**
   * Record that a login was deleted here: its current and past passwords, as keyed hashes, so a
   * later re-import of the same password does not bring it back. A 2FA-only login (no password) is
   * not remembered - there is no password to recognise.
   */
  private rememberDeletion(c: Credential): void {
    if (c.password === "") return;
    const key = deletionKey(c.origin, c.username);
    const prev = this.deletions.get(key);
    const hashes = mergeHistory(prev?.hashes ?? [], retire(c.passwordHistory ?? [], c.password, Date.now()));
    this.deletions.set(key, { origin: c.origin, username: c.username, hashes, at: Date.now() });
    this.capDeletions();
  }

  private capDeletions(): void {
    if (this.deletions.size <= MAX_DELETED_LOGINS) return;
    const oldest = [...this.deletions.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of oldest.slice(0, this.deletions.size - MAX_DELETED_LOGINS)) this.deletions.delete(key);
  }

  /** Apply changes from sync (keyed by credential id), then flush so the engine never loses a write. */
  applyRemote(changes: Array<{ id: string; cred: Credential | null }>): void {
    let changed = false;
    for (const { id, cred } of changes) {
      if (cred === null) {
        changed = this.cache.delete(id) || changed;
      } else if (isValidCredential(cred)) {
        // Union the password history so no device forgets a password another one has seen.
        const local = this.cache.get(id);
        const merged = mergeHistory(cred.passwordHistory ?? [], local?.passwordHistory ?? []);
        const next = merged.length > 0 ? { ...cred, passwordHistory: merged } : { ...cred };
        if (merged.length === 0) delete next.passwordHistory;
        this.cache.set(id, next);
        changed = true;
      }
    }
    if (!changed) return;
    this.write();
    this.file.flush();
    this.emit();
  }

  // --- Deleted-login memory, synced as its own collection so it outlives the login ---

  /** Every remembered deletion, keyed by its stable natural id, for the sync adapter. */
  deletionItems(): Array<{ id: string; memory: DeletedLoginMemory }> {
    return [...this.deletions.entries()].map(([id, memory]) => ({ id, memory }));
  }

  /** Apply deletion-memory changes from sync (union of hashes, newest deletion time kept). */
  applyRemoteDeletions(changes: Array<{ id: string; memory: DeletedLoginMemory | null }>): void {
    let changed = false;
    for (const { id, memory } of changes) {
      if (memory === null) {
        changed = this.deletions.delete(id) || changed;
      } else if (isDeletedLoginMemory(memory)) {
        const prev = this.deletions.get(id);
        this.deletions.set(id, {
          origin: memory.origin,
          username: memory.username,
          hashes: mergeHistory(prev?.hashes ?? [], memory.hashes),
          at: Math.max(prev?.at ?? 0, memory.at),
        });
        changed = true;
      }
    }
    if (!changed) return;
    this.capDeletions();
    this.write();
    this.file.flush();
    this.emit();
  }

  private write(): void {
    if (!this.persisted) return;
    const entries: StoredEntry[] = [...this.cache.values()].map((c) => {
      const secret: Secret = {
        username: c.username,
        password: c.password,
        ...(c.notes ? { notes: c.notes } : {}),
        ...extras(c),
        ...(c.passwordHistory && c.passwordHistory.length > 0 ? { passwordHistory: c.passwordHistory } : {}),
      };
      return {
        id: c.id,
        origin: c.origin,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        ...(typeof c.passwordChangedAt === "number" ? { passwordChangedAt: c.passwordChangedAt } : {}),
        sealed: sealSecret(this.key, JSON.stringify(secret), c.id),
      };
    });
    const deletions: StoredDeletion[] = [...this.deletions.entries()].map(([key, d]) => ({
      key,
      origin: d.origin,
      at: d.at,
      sealed: sealSecret(this.key, JSON.stringify({ username: d.username, hashes: d.hashes }), key),
    }));
    const wrapped = this.cipher.encryptString(Buffer.from(this.key).toString("base64")).toString("base64");
    this.file.set({ v: 1, key: { data: wrapped }, entries, deletions });
  }

  flush(): void {
    this.file.flush();
  }
}
