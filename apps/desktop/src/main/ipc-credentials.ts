import { ipcMain, type IpcMainEvent } from "electron";
import { credentialSummary, generatePassword, type PasswordOptions } from "../shared/credentials";
import { AUTOFILL_CAPTURE_CHANNEL, type AutofillChromeRpc, type CapturedSubmit, type CredentialsRpc } from "../shared/credentials-ipc";
import type { InternalPage } from "../shared/internal-urls";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

const str = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};
const optStr = (value: unknown, name: string, max: number): string | undefined =>
  value === undefined || value === null ? undefined : str(value, name, max);
const bool = (value: unknown): boolean => value === true;

const MAX_FIELD = 4096;
const MAX_NOTES = 8192;

function passwordOptions(value: unknown): PasswordOptions {
  const v = (value ?? {}) as Record<string, unknown>;
  const length = typeof v.length === "number" && Number.isFinite(v.length) ? Math.max(4, Math.min(128, Math.floor(v.length))) : 20;
  return { length, lowercase: v.lowercase !== false, uppercase: v.uppercase !== false, digits: v.digits !== false, symbols: v.symbols === true };
}

interface InternalContext {
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

type InternalHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (c: InternalContext, ...args: A) => R | Promise<Awaited<R>> : never;
};

type ChromeHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (w: BrowserWindowCtl, ...args: A) => R | Promise<Awaited<R>> : never;
};

export const CREDENTIALS_INTERNAL_PERMISSIONS: Record<keyof CredentialsRpc, readonly InternalPage[]> = {
  "credentials.list": ["passwords"],
  "credentials.reveal": ["passwords"],
  "credentials.add": ["passwords"],
  "credentials.update": ["passwords"],
  "credentials.remove": ["passwords"],
  "credentials.generate": ["passwords"],
  "credentials.persisted": ["passwords"],
};

export function credentialsInternalHandlers(): InternalHandlers<CredentialsRpc> {
  return {
    "credentials.list": (c, query) => c.profile.credentials.list(str(query ?? "", "query", 512)),
    "credentials.reveal": (c, id) => {
      const cred = c.profile.credentials.get(str(id, "id", 128));
      if (!cred) throw new IpcError("No such login");
      return { origin: cred.origin, username: cred.username, password: cred.password, notes: cred.notes ?? "" };
    },
    "credentials.add": (c, input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      return credentialSummary(
        c.profile.credentials.add({
          origin: str(i.origin, "origin", MAX_FIELD),
          username: str(i.username ?? "", "username", MAX_FIELD),
          password: str(i.password ?? "", "password", MAX_FIELD),
          ...(optStr(i.notes, "notes", MAX_NOTES) !== undefined ? { notes: optStr(i.notes, "notes", MAX_NOTES) } : {}),
        }),
      );
    },
    "credentials.update": (c, id, patch) => {
      const p = (patch ?? {}) as Record<string, unknown>;
      const next = c.profile.credentials.update(str(id, "id", 128), {
        ...(optStr(p.origin, "origin", MAX_FIELD) !== undefined ? { origin: optStr(p.origin, "origin", MAX_FIELD) } : {}),
        ...(optStr(p.username, "username", MAX_FIELD) !== undefined ? { username: optStr(p.username, "username", MAX_FIELD) } : {}),
        ...(optStr(p.password, "password", MAX_FIELD) !== undefined ? { password: optStr(p.password, "password", MAX_FIELD) } : {}),
        ...(optStr(p.notes, "notes", MAX_NOTES) !== undefined ? { notes: optStr(p.notes, "notes", MAX_NOTES) } : {}),
      });
      if (!next) throw new IpcError("No such login");
      return credentialSummary(next);
    },
    "credentials.remove": (c, id) => c.profile.credentials.remove(str(id, "id", 128)),
    "credentials.generate": (_c, opts) => generatePassword(passwordOptions(opts)),
    "credentials.persisted": (c) => c.profile.credentials.secretsPersisted,
  };
}

export function autofillChromeHandlers(ctx: AppContext): ChromeHandlers<AutofillChromeRpc> {
  return {
    "autofill.suggestions": (w) => ctx.autofill.suggestions(w),
    "autofill.fill": (w, id) => ctx.autofill.fill(w, str(id, "id", 128)),
    "autofill.saveAccept": (w) => ctx.autofill.acceptSave(w),
    "autofill.saveDismiss": (w) => ctx.autofill.dismissSave(w),
    "autofill.openManager": (w) => w.openSingleton("corvus://passwords/"),
  };
}

function parseCapture(raw: unknown): CapturedSubmit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.origin !== "string" || typeof v.username !== "string" || typeof v.password !== "string") return null;
  if (v.origin.length > MAX_FIELD || v.username.length > MAX_FIELD || v.password.length > MAX_FIELD || !v.password) return null;
  return { origin: v.origin, username: v.username, password: v.password };
}

/** Receives submitted-login captures from tab preloads (one-way; sender is re-validated as a tab). */
export function registerAutofillCapture(ctx: AppContext): void {
  ipcMain.on(AUTOFILL_CAPTURE_CHANNEL, (event: IpcMainEvent, raw: unknown) => {
    const found = ctx.windows.byTabWebContents(event.sender);
    if (!found || event.senderFrame !== event.sender.mainFrame) return;
    const data = parseCapture(raw);
    if (data) ctx.autofill.onSubmitCaptured(found.window, found.tab, data);
  });
}
