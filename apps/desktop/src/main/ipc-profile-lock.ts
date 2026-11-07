import type { InternalPage } from "../shared/internal-urls";
import { MAX_LOCK_SECRET, type LockKind, type NewProfileLock, type ProfileLockChromeRpc, type ProfileLockInternalRpc, type UnlockAttempt } from "../shared/profile-lock";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

const str = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};

const secret = (value: unknown): string => str(value, "secret", MAX_LOCK_SECRET + 1);

function lockKind(value: unknown): LockKind {
  if (value !== "pin" && value !== "password") throw new IpcError("Invalid lock kind");
  return value;
}

function attempt(raw: unknown): UnlockAttempt {
  const v = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (v.method === "secret") return { method: "secret", secret: secret(v.secret) };
  if (v.method === "totp") return { method: "totp", code: str(v.code, "code", 20) };
  if (v.method === "hello" || v.method === "fido2") return { method: v.method };
  throw new IpcError("Invalid unlock attempt");
}

export function newProfileLock(raw: unknown): NewProfileLock | null {
  if (raw === undefined || raw === null) return null;
  const v = (typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { kind: lockKind(v.kind), secret: secret(v.secret) };
}

type ChromeHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (w: BrowserWindowCtl, ...args: A) => R | Promise<Awaited<R>> : never;
};

/** The chrome UI calls a locked window may make (see LOCKED_CHROME_METHODS in ipc.ts). */
export function profileLockChromeHandlers(ctx: AppContext): ChromeHandlers<ProfileLockChromeRpc> {
  return {
    "lock.unlock": (w, raw) => ctx.profileLocks.unlock(w, attempt(raw)),
    "lock.switchProfile": (w, id) => {
      const profileId = str(id, "profile", 64);
      if (profileId === w.profile.profile.id || !ctx.profiles.list().some((p) => p.id === profileId)) throw new IpcError("Unknown profile");
      ctx.profileLocks.switchTo(profileId);
    },
    "lock.newProfile": async (_w, name, lock) => {
      const profile = await ctx.profileLocks.createProfile(str(name, "name", 200), newProfileLock(lock));
      ctx.windows.open(profile.id);
    },
  };
}

interface InternalContext {
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

type InternalHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (c: InternalContext, ...args: A) => R | Promise<Awaited<R>> : never;
};

export const PROFILE_LOCK_INTERNAL_PERMISSIONS: Record<keyof ProfileLockInternalRpc, readonly InternalPage[]> = {
  "profileLock.view": ["settings"],
  "profileLock.enable": ["settings"],
  "profileLock.change": ["settings"],
  "profileLock.remove": ["settings"],
  "profileLock.lockNow": ["settings"],
  "profileLock.setWithComputer": ["settings"],
  "profileLock.totpStart": ["settings"],
  "profileLock.totpConfirm": ["settings"],
  "profileLock.addAuthenticator": ["settings"],
  "profileLock.removeMethod": ["settings"],
};

export function profileLockInternalHandlers(ctx: AppContext): InternalHandlers<ProfileLockInternalRpc> {
  const locks = ctx.profileLocks;
  return {
    "profileLock.view": (c) => locks.view(c.profile),
    "profileLock.enable": (c, kind, value) => locks.enable(c.profile, lockKind(kind), secret(value)),
    "profileLock.change": (c, current, kind, value) => locks.change(c.profile, secret(current), lockKind(kind), secret(value)),
    "profileLock.remove": (c, current) => locks.remove(c.profile, secret(current)),
    "profileLock.lockNow": (c) => locks.lock(c.profile),
    "profileLock.setWithComputer": (c, on) => {
      if (typeof on !== "boolean") throw new IpcError("Invalid setting");
      return locks.setWithComputer(c.profile, on);
    },
    "profileLock.totpStart": (c, current) => locks.totpStart(c.profile, secret(current)),
    "profileLock.totpConfirm": (c, setupId, code, label) => locks.totpConfirm(c.profile, str(setupId, "setup", 64), str(code, "code", 20), str(label, "label", 200)),
    "profileLock.addAuthenticator": (c, type, current, label) => {
      if (type !== "hello" && type !== "fido2") throw new IpcError("Invalid authenticator");
      if (!c.window) throw new IpcError("No window");
      return locks.addAuthenticator(c.window, c.profile, type, secret(current), str(label, "label", 200));
    },
    "profileLock.removeMethod": (c, current, id) => locks.removeMethod(c.profile, secret(current), str(id, "method", 64)),
  };
}
