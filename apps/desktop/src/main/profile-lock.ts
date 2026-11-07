/**
 * A profile's lock (lock.json in the profile folder) and the lock key it guards. Electron-free.
 *
 * With a lock, the keys of the profile's secrets (the vault key of its logins and 2FA, the keys of
 * its cards and addresses, its kept KeePass master passwords, its proxy passwords and its sync
 * phrase) are sealed again under a random lock key before the system keychain wraps them (see
 * `cipher`). The lock key is in memory only while the profile is unlocked; locked, every read and
 * write of those secrets throws ProfileLockedError, so nothing can mistake a locked profile for an
 * empty one (a sync would delete, a write would wipe).
 *
 * Each way to unlock keeps its own copy of the lock key: under the PIN or password (scrypt with a
 * keychain-held pepper), under a security key's or Windows Hello's PRF output, or, for an
 * authenticator app's code and authenticators without PRF, under the system keychain only (the
 * method then gates the key rather than holding it).
 */
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { base32Decode, base32Encode, totpAt } from "../shared/totp";
import {
  lockBackoffMs,
  lockSecretProblem,
  type LockKind,
  type LockMethodType,
  type LockMethodView,
  type UnlockResult,
} from "../shared/profile-lock";
import { JsonFile } from "./json-file";
import { tr } from "./menu-i18n";
import {
  LOCK_SCRYPT,
  b64url,
  isSealed,
  open,
  prfKek,
  randomKey,
  seal,
  secretKek,
  verifyAssertion,
  type AssertionResult,
  type Expected,
  type Sealed,
  type ScryptParams,
} from "./profile-lock-crypto";
import type { SecretCipher } from "./settings-store";

export class ProfileLockedError extends Error {
  constructor() {
    super(tr("This profile is locked."));
    this.name = "ProfileLockedError";
  }
}

export const isProfileLocked = (err: unknown): boolean => err instanceof ProfileLockedError;

/** Throws, in the UI's language, when a PIN or password cannot be the lock's. */
export function checkLockSecret(kind: LockKind, secret: string): void {
  switch (lockSecretProblem(kind, secret)) {
    case "too-long":
      throw new Error(tr("That is too long."));
    case "pin":
      throw new Error(tr("A PIN has at least 6 digits, and only digits."));
    case "password":
      throw new Error(tr("A password has at least 8 characters."));
    case null:
      return;
  }
}

/** A store of a profile's secrets the lock key layer is added to or taken off. */
export interface LockWrapped {
  /** Writes its wrapped secrets again with the profile cipher as it is now. */
  rewrap(): void;
  /** Whether what is on disk now opens with the profile cipher as it is now. */
  verify(): boolean;
  /** Reads its file again (put back as it was), dropping what it holds in memory. */
  reread(): void;
}

/**
 * Writes every store's secrets again with the profile cipher as it is now (a lock added or removed)
 * and checks each file reads back. The files are copied aside first; when any store fails, they are
 * put back as they were, the stores read them again, and this throws: nothing is lost either way.
 */
export function rewrapAll(dir: string, files: readonly string[], stores: readonly LockWrapped[]): void {
  const backup = path.join(dir, `lock-backup-${Date.now()}`);
  fs.mkdirSync(backup, { recursive: true });
  const saved = files.filter((name) => fs.existsSync(path.join(dir, name)));
  for (const name of saved) fs.copyFileSync(path.join(dir, name), path.join(backup, name));
  let ok = false;
  try {
    for (const store of stores) store.rewrap();
    ok = stores.every((store) => store.verify());
  } catch (err) {
    console.warn("[corvus] could not seal the profile's secrets again:", (err as Error).message);
  }
  if (!ok) {
    for (const name of saved) fs.copyFileSync(path.join(backup, name), path.join(dir, name));
    for (const store of stores) store.reread();
    fs.rmSync(backup, { recursive: true, force: true });
    throw new Error(tr("The profile's secrets could not be sealed again. Nothing was changed."));
  }
  fs.rmSync(backup, { recursive: true, force: true });
}

/**
 * Whether the keychain-wrapped values `blobsOf` finds in a file on disk all open with `cipher`, and
 * there are `expected` of them: checked after they were wrapped again, before the old copy goes.
 */
export function blobsReadBack(filePath: string, cipher: SecretCipher, blobsOf: (raw: unknown) => string[], expected: number): boolean {
  // A store that never wrote its file has nothing sealed to read back.
  if (expected === 0 && !fs.existsSync(filePath)) return true;
  try {
    const blobs = blobsOf(JSON.parse(fs.readFileSync(filePath, "utf8")));
    if (blobs.length !== expected) return false;
    for (const blob of blobs) cipher.decryptString(Buffer.from(blob, "base64"));
    return true;
  } catch {
    return false;
  }
}

/** Every keychain-wrapped value of `values` wrapped again with `cipher` as it is now. */
export function rewrapBlobs<K extends string>(values: Record<K, string>, cipher: SecretCipher): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const [k, blob] of Object.entries(values) as Array<[K, string]>) out[k] = cipher.encryptString(cipher.decryptString(Buffer.from(blob, "base64"))).toString("base64");
  return out;
}

/**
 * Whether a file of sealed entries under a wrapped key (`{ key: { data }, entries }`, as the
 * credential vault and sealed records write it) opens from disk with `cipher` to `key`, with
 * `entries` entries: checked after its key was wrapped again, before the old copy goes.
 */
export function verifyWrappedFile(filePath: string, cipher: SecretCipher, key: Uint8Array, entries: number): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { key?: { data?: unknown }; entries?: unknown };
    if (typeof raw.key?.data !== "string" || !Array.isArray(raw.entries) || raw.entries.length !== entries) return false;
    const onDisk = Buffer.from(cipher.decryptString(Buffer.from(raw.key.data, "base64")), "base64");
    return onDisk.length === key.length && crypto.timingSafeEqual(onDisk, Buffer.from(key));
  } catch {
    return false;
  }
}

interface TotpMethod {
  id: string;
  type: "totp";
  label: string;
  addedAt: number;
  /** The app's TOTP secret, keychain-wrapped: it must be read while the profile is locked. */
  secret: string;
  /** The lock key, keychain-wrapped (a 6-digit code cannot protect a key). */
  lk: string;
  /** The last time step a code was used for (a code works once). */
  lastStep: number;
}

interface WebAuthnMethod {
  id: string;
  type: "hello" | "fido2";
  label: string;
  addedAt: number;
  credentialId: string;
  /** SPKI DER, base64url. */
  publicKey: string;
  algorithm: number;
  signCount: number;
  /** PRF input: with one, the lock key is sealed under the authenticator's PRF output. */
  prfSalt?: string;
  lk: { prf: Sealed } | { keychain: string };
}

type StoredMethod = TotpMethod | WebAuthnMethod;

interface LockFile {
  v: 1;
  kind: LockKind;
  /** Random bytes mixed into the PIN or password's key, keychain-wrapped. */
  pepper: string;
  secret: { salt: string; N: number; r: number; p: number; sealed: Sealed };
  methods: StoredMethod[];
  /** The profile's secrets are still to be sealed under the lock key (Corvus stopped while adding the lock). */
  pending?: boolean;
  failures: number;
  retryAt: number;
}

function reviveFile(raw: unknown): LockFile | null {
  const r = raw as Partial<LockFile> | null;
  if (!r || (r.kind !== "pin" && r.kind !== "password") || typeof r.pepper !== "string" || !r.secret || !isSealed(r.secret.sealed)) return null;
  const s = r.secret;
  if (typeof s.salt !== "string" || ![s.N, s.r, s.p].every((n) => Number.isInteger(n) && n > 0)) return null;
  const methods = Array.isArray(r.methods)
    ? r.methods.filter((m): m is StoredMethod => {
        if (typeof m?.id !== "string" || typeof m.label !== "string") return false;
        if (m.type === "totp") return typeof m.secret === "string" && typeof m.lk === "string";
        if (m.type === "hello" || m.type === "fido2") return typeof m.credentialId === "string" && typeof m.publicKey === "string" && typeof m.lk === "object" && m.lk !== null;
        return false;
      })
    : [];
  return {
    v: 1,
    kind: r.kind,
    pepper: r.pepper,
    secret: { salt: s.salt, N: s.N, r: s.r, p: s.p, sealed: s.sealed },
    methods,
    ...(r.pending === true ? { pending: true } : {}),
    failures: typeof r.failures === "number" && r.failures >= 0 ? r.failures : 0,
    retryAt: typeof r.retryAt === "number" ? r.retryAt : 0,
  };
}

/** What the lock key layer prepends to a secret before the keychain wraps it. */
const LAYER = "corvus-lk1:";
const LAYER_AAD = "corvus profile lock layer v1";
const keyAad = (methodId: string): string => `corvus profile lock key v1:${methodId}`;
const SECRET_METHOD = "secret";

/** Codes from the step before and after count too (clocks drift, people type slowly). */
const TOTP_WINDOW = 1;
const TOTP_PERIOD = 30;

export class ProfileLock {
  private readonly filePath: string;
  private file: JsonFile<LockFile> | null;
  private lk: Buffer | null = null;
  /** The lock is being removed: secrets are written without the lock key layer again. */
  private removing = false;
  private readonly listeners = new Set<() => void>();
  readonly cipher: SecretCipher;

  constructor(
    dir: string,
    private readonly keychain: SecretCipher,
    private readonly now: () => number = Date.now,
  ) {
    this.filePath = path.join(dir, "lock.json");
    this.file = this.load();
    const lock = this;
    this.cipher = {
      isEncryptionAvailable: () => keychain.isEncryptionAvailable(),
      encryptString(plain: string): Buffer {
        const key = lock.layerKey();
        if (!key) return keychain.encryptString(plain);
        const sealed = seal(key, Buffer.from(plain, "utf8"), LAYER_AAD);
        return keychain.encryptString(`${LAYER}${sealed.iv}.${sealed.tag}.${sealed.data}`);
      },
      decryptString(encrypted: Buffer): string {
        if (lock.locked) throw new ProfileLockedError();
        const inner = keychain.decryptString(encrypted);
        if (!inner.startsWith(LAYER)) return inner;
        const [iv = "", tag = "", data = ""] = inner.slice(LAYER.length).split(".");
        return open(lock.key(), { iv, tag, data }, LAYER_AAD).toString("utf8");
      },
    };
  }

  /** Whether the profile in `dir` has a lock (without loading it). */
  static isConfigured(dir: string): boolean {
    return fs.existsSync(path.join(dir, "lock.json"));
  }

  private load(): JsonFile<LockFile> | null {
    if (!fs.existsSync(this.filePath)) return null;
    const file = JsonFile.load<LockFile | null>(this.filePath, () => null, reviveFile, 0);
    // An unreadable lock file is kept aside by JsonFile; the profile then has no lock it could open.
    return file.get() ? (file as JsonFile<LockFile>) : null;
  }

  private get config(): LockFile | null {
    return this.file?.get() ?? null;
  }

  private update(fn: (f: LockFile) => LockFile): void {
    if (!this.file) throw new Error(tr("This profile has no lock."));
    this.file.update(fn);
  }

  /** The key secrets are sealed under on write: none without a lock (or while it is being removed). */
  private layerKey(): Buffer | null {
    if (!this.config || this.removing) return null;
    return this.key();
  }

  get kind(): LockKind | null {
    return this.config?.kind ?? null;
  }

  get configured(): boolean {
    return this.config !== null;
  }

  /** A lock is set and its key is not in memory: nothing of the profile's secrets can be read. */
  get locked(): boolean {
    return this.config !== null && this.lk === null;
  }

  /** Secrets still to be sealed under the lock key (see LockFile.pending). */
  get pending(): boolean {
    return this.config?.pending === true;
  }

  /** The lock key; throws ProfileLockedError while locked. */
  key(): Buffer {
    if (!this.lk) throw new ProfileLockedError();
    return this.lk;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  methods(): LockMethodView[] {
    return (this.config?.methods ?? []).map((m) => ({
      id: m.id,
      type: m.type,
      label: m.label,
      addedAt: m.addedAt,
      keyBound: m.type !== "totp" && "prf" in m.lk,
    }));
  }

  hasMethod(type: LockMethodType): boolean {
    return this.methods().some((m) => m.type === type);
  }

  /** The credentials of one kind of authenticator, to ask for an assertion from any of them. */
  credentials(type: "hello" | "fido2"): Array<{ credentialId: string; prfSalt?: string }> {
    return (this.config?.methods ?? []).flatMap((m) => (m.type === type ? [{ credentialId: m.credentialId, ...(m.prfSalt ? { prfSalt: m.prfSalt } : {}) }] : []));
  }

  /** When the next attempt may be made, after wrong ones; null: now. */
  retryAt(): number | null {
    const at = this.config?.retryAt ?? 0;
    return at > this.now() ? at : null;
  }

  /** Locks: the lock key leaves memory (the caller drops what was opened with it). */
  lock(): void {
    if (!this.config || !this.lk) return;
    this.lk.fill(0);
    this.lk = null;
    this.emit();
  }

  private wait(): UnlockResult | null {
    const retryAt = this.retryAt();
    return retryAt ? { ok: false, error: tr("Too many wrong attempts. Try again in a moment."), retryAt } : null;
  }

  private failed(error: string): UnlockResult {
    if (!this.file) return { ok: false, error, retryAt: null };
    const failures = this.config!.failures + 1;
    const delay = lockBackoffMs(failures);
    this.update((f) => ({ ...f, failures, retryAt: delay > 0 ? this.now() + delay : 0 }));
    return { ok: false, error, retryAt: this.retryAt() };
  }

  private opened(lk: Buffer): UnlockResult {
    this.lk = lk;
    if (this.config!.failures > 0 || this.config!.retryAt > 0) this.update((f) => ({ ...f, failures: 0, retryAt: 0 }));
    this.emit();
    return { ok: true };
  }

  private async keyFromSecret(secret: string): Promise<Buffer | null> {
    const config = this.config;
    if (!config) return null;
    const pepper = Buffer.from(this.keychain.decryptString(Buffer.from(config.pepper, "base64")), "base64");
    const kek = await secretKek(secret, Buffer.from(config.secret.salt, "base64"), config.secret, pepper);
    try {
      return open(kek, config.secret.sealed, keyAad(SECRET_METHOD));
    } catch {
      return null;
    } finally {
      kek.fill(0);
      pepper.fill(0);
    }
  }

  async unlockWithSecret(secret: string): Promise<UnlockResult> {
    if (!this.locked) return { ok: true };
    const waiting = this.wait();
    if (waiting) return waiting;
    const lk = await this.keyFromSecret(secret);
    if (!this.locked) {
      lk?.fill(0);
      return { ok: true };
    }
    return lk ? this.opened(lk) : this.failed(this.kind === "pin" ? tr("Wrong PIN.") : tr("Wrong password."));
  }

  /** The PIN or password is the lock's (Settings asks for it before changing the lock); counts as an attempt. */
  async checkSecret(secret: string): Promise<UnlockResult> {
    const waiting = this.wait();
    if (waiting) return waiting;
    const lk = await this.keyFromSecret(secret);
    if (!lk) return this.failed(this.kind === "pin" ? tr("Wrong PIN.") : tr("Wrong password."));
    lk.fill(0);
    if (this.config!.failures > 0) this.update((f) => ({ ...f, failures: 0, retryAt: 0 }));
    return { ok: true };
  }

  async unlockWithTotp(code: string): Promise<UnlockResult> {
    if (!this.locked) return { ok: true };
    const waiting = this.wait();
    if (waiting) return waiting;
    const digits = code.replace(/\s+/g, "");
    const now = Math.floor(this.now() / 1000);
    for (const method of this.config!.methods) {
      if (method.type !== "totp") continue;
      const step = await this.matchingStep(method, digits, now);
      if (step === null) continue;
      this.update((f) => ({ ...f, methods: f.methods.map((m) => (m.id === method.id ? { ...m, lastStep: step } : m)) }));
      return this.opened(Buffer.from(this.keychain.decryptString(Buffer.from(method.lk, "base64")), "base64"));
    }
    return this.failed(tr("Wrong code."));
  }

  private async matchingStep(method: TotpMethod, code: string, nowSeconds: number): Promise<number | null> {
    if (!/^\d{6}$/.test(code)) return null;
    const key = base32Decode(this.keychain.decryptString(Buffer.from(method.secret, "base64")));
    const current = Math.floor(nowSeconds / TOTP_PERIOD);
    for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
      if (step <= method.lastStep) continue;
      if ((await totpAt(key, step * TOTP_PERIOD)) === code) return step;
    }
    return null;
  }

  /** A checked Windows Hello or security key assertion opens the profile (its PRF output, or the keychain copy). */
  unlockWithAssertion(result: AssertionResult, expected: Expected): UnlockResult {
    if (!this.locked) return { ok: true };
    const waiting = this.wait();
    if (waiting) return waiting;
    const method = this.config!.methods.find((m): m is WebAuthnMethod => m.type !== "totp" && m.credentialId === result.credentialId);
    if (!method) return this.failed(tr("That authenticator is not one of this profile's."));
    let signCount: number;
    try {
      signCount = verifyAssertion(result, method, expected, method.type === "hello");
    } catch (err) {
      return this.failed((err as Error).message);
    }
    let lk: Buffer;
    try {
      lk = this.webauthnKey(method, result.prf);
    } catch {
      return this.failed(tr("The authenticator could not open this profile."));
    }
    this.update((f) => ({ ...f, methods: f.methods.map((m) => (m.id === method.id ? { ...m, signCount } : m)) }));
    return this.opened(lk);
  }

  private webauthnKey(method: WebAuthnMethod, prf: string | undefined): Buffer {
    if ("keychain" in method.lk) return Buffer.from(this.keychain.decryptString(Buffer.from(method.lk.keychain, "base64")), "base64");
    if (!prf || !method.prfSalt) throw new Error("no PRF output");
    const kek = prfKek(Buffer.from(prf, "base64url"), Buffer.from(method.prfSalt, "base64url"));
    try {
      return open(kek, method.lk.prf, keyAad(method.id));
    } finally {
      kek.fill(0);
    }
  }

  // ------------------------------------------------------------------ setting the lock up

  private async sealSecret(kind: LockKind, secret: string, lk: Buffer, pepper: Buffer, params: ScryptParams = LOCK_SCRYPT): Promise<LockFile["secret"]> {
    checkLockSecret(kind, secret);
    const salt = crypto.randomBytes(16);
    const kek = await secretKek(secret, salt, params, pepper);
    try {
      return { salt: salt.toString("base64"), ...params, sealed: seal(kek, lk, keyAad(SECRET_METHOD)) };
    } finally {
      kek.fill(0);
    }
  }

  private wrap(bytes: Buffer): string {
    return this.keychain.encryptString(bytes.toString("base64")).toString("base64");
  }

  /**
   * Adds a lock to a profile that has none: a new lock key, sealed under the PIN or password. The
   * profile stays unlocked and `pending` until its secrets were sealed again (completeMigration).
   */
  async create(kind: LockKind, secret: string, params: ScryptParams = LOCK_SCRYPT): Promise<void> {
    if (this.config) throw new Error(tr("This profile already has a lock."));
    if (!this.keychain.isEncryptionAvailable()) throw new Error(tr("A lock needs the system keychain, which is not available."));
    const lk = randomKey();
    const pepper = randomKey();
    const sealedSecret = await this.sealSecret(kind, secret, lk, pepper, params);
    const file = new JsonFile<LockFile>(this.filePath, { v: 1, kind, pepper: this.wrap(pepper), secret: sealedSecret, methods: [], pending: true, failures: 0, retryAt: 0 }, 0);
    pepper.fill(0);
    file.set(file.get());
    this.file = file;
    this.lk = lk;
    this.emit();
  }

  completeMigration(): void {
    if (this.config?.pending) this.update(({ pending: _done, ...rest }) => rest);
  }

  /** A new PIN or password (the lock key stays: nothing else has to be sealed again). */
  async changeSecret(kind: LockKind, secret: string, params: ScryptParams = LOCK_SCRYPT): Promise<void> {
    const config = this.config;
    if (!config) throw new Error(tr("This profile has no lock."));
    const pepper = Buffer.from(this.keychain.decryptString(Buffer.from(config.pepper, "base64")), "base64");
    try {
      const sealedSecret = await this.sealSecret(kind, secret, this.key(), pepper, params);
      this.update((f) => ({ ...f, kind, secret: sealedSecret }));
    } finally {
      pepper.fill(0);
    }
    this.emit();
  }

  /** Secrets are written without the lock key from now on (the caller writes them all again). */
  beginRemove(): void {
    this.key();
    this.removing = true;
  }

  abortRemove(): void {
    this.removing = false;
  }

  /** The lock is gone: its file and its key. */
  finishRemove(): void {
    if (!this.removing) throw new Error("The lock is not being removed.");
    fs.rmSync(this.filePath, { force: true });
    this.file = null;
    this.removing = false;
    this.lk?.fill(0);
    this.lk = null;
    this.emit();
  }

  // ------------------------------------------------------------------ unlock methods

  /** A new authenticator app secret (20 random bytes, base32), not saved until confirmed. */
  static newTotpSecret(): string {
    return base32Encode(crypto.randomBytes(20));
  }

  /** Adds the authenticator app once the person typed a code it shows (proof they scanned it). */
  async addTotp(secret: string, code: string, label: string): Promise<boolean> {
    const lk = this.key();
    const method: TotpMethod = {
      id: crypto.randomUUID(),
      type: "totp",
      label: label.trim().slice(0, 60) || "Authenticator app",
      addedAt: this.now(),
      secret: this.keychain.encryptString(secret).toString("base64"),
      lk: this.wrap(lk),
      lastStep: 0,
    };
    const step = await this.matchingStep(method, code.replace(/\s+/g, ""), Math.floor(this.now() / 1000));
    if (step === null) return false;
    this.update((f) => ({ ...f, methods: [...f.methods, { ...method, lastStep: step }] }));
    this.emit();
    return true;
  }

  /** Adds a registered Windows Hello or security key credential; with a PRF output, it seals the key. */
  addCredential(input: { type: "hello" | "fido2"; label: string; credentialId: string; publicKey: string; algorithm: number; signCount: number; prfSalt?: Buffer; prfOutput?: Buffer }): LockMethodView {
    const lk = this.key();
    const id = crypto.randomUUID();
    let sealedKey: WebAuthnMethod["lk"];
    if (input.prfOutput && input.prfSalt) {
      const kek = prfKek(input.prfOutput, input.prfSalt);
      sealedKey = { prf: seal(kek, lk, keyAad(id)) };
      kek.fill(0);
    } else sealedKey = { keychain: this.wrap(lk) };
    const method: WebAuthnMethod = {
      id,
      type: input.type,
      label: input.label.trim().slice(0, 60) || (input.type === "hello" ? "Windows Hello" : "Security key"),
      addedAt: this.now(),
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      algorithm: input.algorithm,
      signCount: input.signCount,
      ...("prf" in sealedKey && input.prfSalt ? { prfSalt: b64url(input.prfSalt) } : {}),
      lk: sealedKey,
    };
    this.update((f) => ({ ...f, methods: [...f.methods, method] }));
    this.emit();
    return this.methods().find((m) => m.id === id)!;
  }

  removeMethod(id: string): void {
    this.key();
    this.update((f) => ({ ...f, methods: f.methods.filter((m) => m.id !== id) }));
    this.emit();
  }
}
