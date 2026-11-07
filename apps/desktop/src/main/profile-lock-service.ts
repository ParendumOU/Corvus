/**
 * The profile lock across the app (see profile-lock.ts for the lock itself): Alt+H and the menus
 * lock a profile, its windows show the lock screen and unlock it, Settings adds, changes and
 * removes the lock and its ways to unlock. Locking drops every secret the profile decrypted and
 * stops what works with its data in the background (sync, scheduled agents, agent runs, recorded
 * flows; the page monitor and live history wait while it is locked).
 */
import crypto from "node:crypto";
import { buildOtpauthUri } from "../shared/totp";
import {
  type LockKind,
  type LockScreenView,
  type NewProfileLock,
  type ProfileLockView,
  type TotpLockSetup,
  type UnlockAttempt,
  type UnlockResult,
} from "../shared/profile-lock";
import type { Profile } from "@corvus/shared";
import type { AppContext } from "./context";
import { tr } from "./menu-i18n";
import { ProfileLock, checkLockSecret, rewrapAll } from "./profile-lock";
import type { ProfileRuntime } from "./profiles";
import { assertAuthenticator, registerAuthenticator, webauthnSupported } from "./webauthn-lock";
import type { BrowserWindowCtl } from "./window";

/** An authenticator app being added: shown once, kept until confirmed (or a few minutes). */
interface TotpSetup {
  profileId: string;
  secret: string;
  expires: number;
}

const TOTP_SETUP_MS = 10 * 60_000;

export class ProfileLockService {
  private readonly totpSetups = new Map<string, TotpSetup>();

  constructor(private readonly ctx: AppContext) {}

  /** Called once per profile runtime as it is created. */
  attach(runtime: ProfileRuntime): void {
    runtime.lock.onChange(() => {
      // Profile lists (lock screens, Settings, the profile menu) show who is locked.
      this.ctx.windows.broadcastState();
      for (const win of this.ctx.windows.all()) win.notifyInternalPages({ type: "profile-lock-changed" }, ["settings"]);
    });
  }

  /** What a locked window of `runtime` shows. */
  screen(runtime: ProfileRuntime): LockScreenView {
    const lock = runtime.lock;
    return {
      profileId: runtime.profile.id,
      name: runtime.profile.name,
      ...(runtime.profile.avatar ? { avatar: runtime.profile.avatar } : {}),
      kind: lock.kind ?? "password",
      methods: { totp: lock.hasMethod("totp"), hello: webauthnSupported() && lock.hasMethod("hello"), fido2: webauthnSupported() && lock.hasMethod("fido2") },
      retryAt: lock.retryAt(),
      profiles: this.ctx.profiles
        .list()
        .filter((p) => p.id !== runtime.profile.id)
        .map((p) => ({ id: p.id, name: p.name, ...(p.avatar ? { avatar: p.avatar } : {}), locked: this.isLocked(p.id) })),
    };
  }

  /** Whether a profile is locked now (a profile not loaded yet is, when it has a lock). */
  isLocked(profileId: string): boolean {
    const loaded = this.ctx.profiles.loaded().find((r) => r.profile.id === profileId);
    return loaded ? loaded.locked : this.ctx.profiles.list().some((p) => p.id === profileId) && ProfileLock.isConfigured(this.ctx.profiles.manager.dataDir(profileId));
  }

  /** Alt+H and the menus: locks the window's profile, or, without a lock yet, shows where to add one. */
  lockFrom(win: BrowserWindowCtl): void {
    if (!win.profile.lock.configured) {
      win.openSingleton("corvus://settings/#profile-lock");
      return;
    }
    this.lock(win.profile);
  }

  lock(runtime: ProfileRuntime): void {
    if (!runtime.lock.configured || runtime.locked) return;
    runtime.lock.lock();
    runtime.dropSecrets();
    this.ctx.sync.pause(runtime);
    this.ctx.scheduledAgents.pauseProfile(runtime.profile.id);
    this.ctx.flows.pauseProfile(runtime);
    for (const win of this.ctx.windows.forProfile(runtime.profile.id)) {
      for (const run of this.ctx.agentRunner.liveRuns(win)) this.ctx.agentRunner.stopRun(win, run.id);
      win.applyLock();
    }
  }

  /** The lock screen's form: one attempt with one of the profile's ways in. */
  async unlock(win: BrowserWindowCtl, attempt: UnlockAttempt): Promise<UnlockResult> {
    const runtime = win.profile;
    const lock = runtime.lock;
    let result: UnlockResult;
    try {
      if (attempt.method === "secret") result = await lock.unlockWithSecret(attempt.secret);
      else if (attempt.method === "totp") result = await lock.unlockWithTotp(attempt.code);
      else {
        const { result: assertion, expected } = await assertAuthenticator(win, attempt.method, lock.credentials(attempt.method));
        result = lock.unlockWithAssertion(assertion, expected);
      }
    } catch (err) {
      result = { ok: false, error: (err as Error).message, retryAt: lock.retryAt() };
    }
    if (result.ok) this.opened(runtime);
    else win.pushState();
    return result;
  }

  /** Unlocked: the windows come back, kept KeePass databases open, sync starts again. */
  private opened(runtime: ProfileRuntime): void {
    if (runtime.lock.pending) {
      // Corvus stopped while this lock was being added: its secrets are sealed now.
      try {
        this.reseal(runtime);
        runtime.lock.completeMigration();
      } catch (err) {
        console.warn("[corvus] could not finish sealing the profile's secrets:", (err as Error).message);
      }
    }
    for (const win of this.ctx.windows.forProfile(runtime.profile.id)) win.applyLock();
    if (runtime.keepass.configured) void runtime.keepass.restoreRemembered();
    this.ctx.sync.resume();
  }

  private reseal(runtime: ProfileRuntime): void {
    const { files, stores } = runtime.sealedStores([this.ctx.sync.lockWrapped(runtime)]);
    rewrapAll(runtime.dataDir, files, stores);
  }

  /** "Switch profile" on the lock screen: a window of that profile, in front. */
  switchTo(profileId: string): void {
    const open = this.ctx.windows.forProfile(profileId).filter((w) => !w.isPrivate);
    const win = open[open.length - 1];
    if (win) win.present();
    else this.ctx.windows.open(profileId);
  }

  /** A new profile, with its lock when the person chose one (checked before the profile exists). */
  async createProfile(name: string, lock: NewProfileLock | null): Promise<Profile> {
    if (lock) checkLockSecret(lock.kind, lock.secret);
    const profile = this.ctx.profiles.create(name);
    if (lock) await this.enable(this.ctx.profiles.get(profile.id), lock.kind, lock.secret);
    this.ctx.windows.broadcastState();
    return profile;
  }

  // ------------------------------------------------------------------ Settings > Lock

  view(runtime: ProfileRuntime): ProfileLockView {
    return { kind: runtime.lock.kind, methods: runtime.lock.methods(), webauthn: webauthnSupported(), keychain: runtime.cipher.isEncryptionAvailable() };
  }

  /** The current PIN or password, asked again before any change (wrong ones count as attempts). */
  private async confirm(runtime: ProfileRuntime, current: string): Promise<void> {
    const checked = await runtime.lock.checkSecret(current);
    if (!checked.ok) throw new Error(checked.error);
  }

  /** Adds a lock: the profile's secrets are sealed under its new lock key (all or nothing). */
  async enable(runtime: ProfileRuntime, kind: LockKind, secret: string): Promise<ProfileLockView> {
    checkLockSecret(kind, secret);
    await runtime.lock.create(kind, secret);
    try {
      this.reseal(runtime);
    } catch (err) {
      runtime.lock.beginRemove();
      runtime.lock.finishRemove();
      throw err;
    }
    runtime.lock.completeMigration();
    return this.view(runtime);
  }

  async change(runtime: ProfileRuntime, current: string, kind: LockKind, secret: string): Promise<ProfileLockView> {
    await this.confirm(runtime, current);
    checkLockSecret(kind, secret);
    await runtime.lock.changeSecret(kind, secret);
    return this.view(runtime);
  }

  /** Removes the lock: the secrets are sealed by the system keychain alone again (all or nothing). */
  async remove(runtime: ProfileRuntime, current: string): Promise<ProfileLockView> {
    await this.confirm(runtime, current);
    runtime.lock.beginRemove();
    try {
      this.reseal(runtime);
    } catch (err) {
      runtime.lock.abortRemove();
      throw err;
    }
    runtime.lock.finishRemove();
    return this.view(runtime);
  }

  async totpStart(runtime: ProfileRuntime, current: string): Promise<TotpLockSetup> {
    await this.confirm(runtime, current);
    const now = Date.now();
    for (const [id, s] of this.totpSetups) if (s.expires < now) this.totpSetups.delete(id);
    const setupId = crypto.randomUUID();
    const secret = ProfileLock.newTotpSecret();
    this.totpSetups.set(setupId, { profileId: runtime.profile.id, secret, expires: now + TOTP_SETUP_MS });
    const uri = buildOtpauthUri({ secret, algorithm: "SHA1", digits: 6, period: 30 }, { issuer: "Corvus lock", account: runtime.profile.name });
    const { encodeQR } = await import("qr");
    return { setupId, secret, uri, qrSvg: encodeQR(uri, "svg", { border: 2 }) };
  }

  async totpConfirm(runtime: ProfileRuntime, setupId: string, code: string, label: string): Promise<ProfileLockView> {
    const setup = this.totpSetups.get(setupId);
    if (!setup || setup.profileId !== runtime.profile.id || setup.expires < Date.now()) throw new Error(tr("This setup expired. Start again."));
    if (!(await runtime.lock.addTotp(setup.secret, code, label))) throw new Error(tr("Wrong code."));
    this.totpSetups.delete(setupId);
    return this.view(runtime);
  }

  async addAuthenticator(win: BrowserWindowCtl, runtime: ProfileRuntime, type: "hello" | "fido2", current: string, label: string): Promise<ProfileLockView> {
    await this.confirm(runtime, current);
    const registration = await registerAuthenticator(win, type, runtime.profile.name);
    runtime.lock.addCredential({ type, label, ...registration });
    return this.view(runtime);
  }

  async removeMethod(runtime: ProfileRuntime, current: string, id: string): Promise<ProfileLockView> {
    await this.confirm(runtime, current);
    runtime.lock.removeMethod(id);
    return this.view(runtime);
  }
}
