/**
 * Profile lock (Alt+L): what a profile's lock is made of and what the UI shows of it. Pure, so the
 * rules (PIN and password shape, the wait after wrong attempts) are tested without Electron.
 */

/** The secret every lock has: a numeric PIN or a password. */
export type LockKind = "pin" | "password";

/** Further ways to unlock: a code from an authenticator app, Windows Hello, a FIDO2 security key. */
export type LockMethodType = "totp" | "hello" | "fido2";

export const MIN_LOCK_PIN = 6;
export const MIN_LOCK_PASSWORD = 8;
export const MAX_LOCK_SECRET = 256;

/** Why a PIN or password cannot be the lock's: too long, not a PIN, or too short a password. */
export type LockSecretProblem = "too-long" | "pin" | "password";

export function lockSecretProblem(kind: LockKind, secret: string): LockSecretProblem | null {
  if (secret.length > MAX_LOCK_SECRET) return "too-long";
  if (kind === "pin") return /^\d+$/.test(secret) && secret.length >= MIN_LOCK_PIN ? null : "pin";
  return secret.length >= MIN_LOCK_PASSWORD ? null : "password";
}

/** Wrong attempts allowed before Corvus makes the person wait. */
export const FREE_LOCK_ATTEMPTS = 3;

/** How long to wait before the next try after `failures` wrong attempts in a row (0: try now). */
export function lockBackoffMs(failures: number): number {
  if (failures < FREE_LOCK_ATTEMPTS) return 0;
  const steps = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  return steps[Math.min(failures - FREE_LOCK_ATTEMPTS, steps.length - 1)]!;
}

export interface LockMethodView {
  id: string;
  type: LockMethodType;
  label: string;
  addedAt: number;
  /**
   * The method itself yields the key that opens the profile (a PIN or password, or a security key
   * or Windows Hello with the PRF extension). False: its copy of the key is only protected by the
   * system's keychain, and the method is a gate in front of it.
   */
  keyBound: boolean;
}

/** A profile's lock as Settings shows it. */
export interface ProfileLockView {
  kind: LockKind | null;
  methods: LockMethodView[];
  /** Windows Hello and security keys can be added on this system (Windows). */
  webauthn: boolean;
  /** The system keychain works: a lock needs it (secrets are written to disk only through it). */
  keychain: boolean;
  /** Locks too when the computer's session locks. */
  withComputer: boolean;
  /** This computer tells Corvus when it locks (Windows, macOS; Linux with D-Bus). */
  computerLock: boolean;
}

/** A profile as the lock screen lists it ("Switch profile"). */
export interface LockProfileChoice {
  id: string;
  name: string;
  avatar?: string;
  locked: boolean;
}

/** What a locked window shows: the form to unlock, and nothing of the profile's pages. */
export interface LockScreenView {
  profileId: string;
  name: string;
  avatar?: string;
  kind: LockKind;
  /** The extra ways to unlock this profile has (the form offers one button or field each). */
  methods: { totp: boolean; hello: boolean; fido2: boolean };
  /** Wrong attempts make the next one wait until then (epoch ms); null: try now. */
  retryAt: number | null;
  /** The other profiles, to switch to. */
  profiles: LockProfileChoice[];
}

export type UnlockAttempt =
  | { method: "secret"; secret: string }
  | { method: "totp"; code: string }
  | { method: "hello" }
  | { method: "fido2" };

export type UnlockResult = { ok: true } | { ok: false; error: string; retryAt: number | null };

/** A new profile's optional lock. */
export interface NewProfileLock {
  kind: LockKind;
  secret: string;
}

/** The authenticator app being added: shown once (QR code and text), confirmed with a code. */
export interface TotpLockSetup {
  setupId: string;
  secret: string;
  uri: string;
  qrSvg: string;
}

/** What a locked window's lock screen asks of the main process (its only calls while locked). */
export interface ProfileLockChromeRpc {
  "lock.unlock"(attempt: UnlockAttempt): UnlockResult;
  /** Opens or brings forward a window of another profile. */
  "lock.switchProfile"(profileId: string): void;
  /** Creates a profile (with its lock, if any) and opens a window of it. */
  "lock.newProfile"(name: string, lock: NewProfileLock | null): void;
}

/**
 * Settings > Lock, for the page's own profile. Every change asks the current PIN or password
 * (`current`) again: someone at an unlocked browser cannot change or add a way in.
 */
export interface ProfileLockInternalRpc {
  "profileLock.view"(): ProfileLockView;
  "profileLock.enable"(kind: LockKind, secret: string): ProfileLockView;
  "profileLock.change"(current: string, kind: LockKind, secret: string): ProfileLockView;
  "profileLock.remove"(current: string): ProfileLockView;
  "profileLock.lockNow"(): void;
  "profileLock.setWithComputer"(on: boolean): ProfileLockView;
  "profileLock.totpStart"(current: string): TotpLockSetup;
  "profileLock.totpConfirm"(setupId: string, code: string, label: string): ProfileLockView;
  "profileLock.addAuthenticator"(type: "hello" | "fido2", current: string, label: string): ProfileLockView;
  "profileLock.removeMethod"(current: string, id: string): ProfileLockView;
}
