import fs from "node:fs";
import { clipboard, dialog, ipcMain, nativeImage, type IpcMainEvent } from "electron";
import { credentialSummary, generatePassword, type PasswordOptions } from "../shared/credentials";
import {
  AUTOFILL_CAPTURE_CHANNEL,
  AUTOFILL_FIELD_CHANNEL,
  type AutofillChromeRpc,
  type CapturedSubmit,
  type LoginFieldBox,
  type CredentialsRpc,
  type TotpQrImport,
} from "../shared/credentials-ipc";
import type { InternalPage } from "../shared/internal-urls";
import type { KeePassExportResult, KeePassRpc, KeePassState } from "../shared/keepass-ipc";
import { buildOtpauthUri, parseTotpInput, totpCode, type TotpConfig } from "../shared/totp";
import type { AppContext } from "./context";
import type { CredentialPatch } from "./credential-store";
import { createKdbx, vaultExportEntries } from "./keepass-format";
import type { ProfileRuntime } from "./profiles";
import { decodeQrBitmap, totpFromQrText } from "./qr-decode";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

const str = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};
const optStr = (value: unknown, name: string, max: number): string | undefined =>
  value === undefined || value === null ? undefined : str(value, name, max);
const optBool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const bool = (value: unknown): boolean => value === true;

const MAX_FIELD = 4096;
const MAX_NOTES = 8192;
const MAX_TOTP_INPUT = 2048;
const MAX_QR_IMAGE_PIXELS = 4096 * 4096;

function passwordOptions(value: unknown): PasswordOptions {
  const v = (value ?? {}) as Record<string, unknown>;
  const length = typeof v.length === "number" && Number.isFinite(v.length) ? Math.max(4, Math.min(128, Math.floor(v.length))) : 20;
  return { length, lowercase: v.lowercase !== false, uppercase: v.uppercase !== false, digits: v.digits !== false, symbols: v.symbols === true };
}

/** The 2FA field as typed: "" means none (or "remove" on update); anything else must parse. */
function totpField(value: unknown): TotpConfig | null | undefined {
  const raw = optStr(value, "2FA secret", MAX_TOTP_INPUT);
  if (raw === undefined) return undefined;
  if (!raw.trim()) return null;
  try {
    return parseTotpInput(raw);
  } catch (err) {
    throw new IpcError((err as Error).message);
  }
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
  "credentials.totpCode": ["passwords"],
  "credentials.copyTotp": ["passwords"],
  "credentials.importTotpQr": ["passwords"],
  "credentials.agentAccess": ["passwords"],
  "credentials.autoSignInIds": ["passwords"],
  "credentials.setAutoSignIn": ["passwords"],
  "credentials.checkup": ["passwords"],
  "credentials.runCheckup": ["passwords"],
};

/** Decodes a 2FA QR code from an image file, locally. Exported for the smoke test (no dialog). */
export async function decodeTotpQrFile(file: string): Promise<TotpQrImport> {
  try {
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) return { ok: false, error: "Could not read that image. Use a PNG or JPEG file." };
    const { width, height } = image.getSize();
    if (width * height > MAX_QR_IMAGE_PIXELS) return { ok: false, error: "That image is too large. Crop it to the QR code and try again." };
    const text = await decodeQrBitmap(image.toBitmap(), width, height, "BGRA");
    return { ok: true, ...totpFromQrText(text) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Lets the person pick an image, then decodes the QR code in it. Null when the dialog is cancelled. */
async function importTotpQr(window: BrowserWindowCtl | undefined): Promise<TotpQrImport> {
  const options: Electron.OpenDialogOptions = {
    title: "Import a 2FA QR code",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
  };
  const parent = window?.win;
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const file = result.filePaths[0];
  if (result.canceled || !file) return null;
  return decodeTotpQrFile(file);
}

export function credentialsInternalHandlers(ctx: AppContext): InternalHandlers<CredentialsRpc> {
  return {
    "credentials.list": (c, query) => c.profile.credentials.list(str(query ?? "", "query", 512)),
    "credentials.reveal": (c, id) => {
      const cred = c.profile.credentials.get(str(id, "id", 128));
      if (!cred) throw new IpcError("No such login");
      return {
        origin: cred.origin,
        username: cred.username,
        password: cred.password,
        notes: cred.notes ?? "",
        totp: cred.totp ? buildOtpauthUri(cred.totp, { account: cred.username }) : "",
        agentTotp: cred.agentTotp === true,
        agentSignIn: cred.agentSignIn === true,
      };
    },
    "credentials.add": (c, input) => {
      const i = (input ?? {}) as unknown as Record<string, unknown>;
      const totp = totpField(i.totp);
      const notes = optStr(i.notes, "notes", MAX_NOTES);
      return credentialSummary(
        c.profile.credentials.add({
          origin: str(i.origin, "origin", MAX_FIELD),
          username: str(i.username ?? "", "username", MAX_FIELD),
          password: str(i.password ?? "", "password", MAX_FIELD),
          ...(notes !== undefined ? { notes } : {}),
          ...(totp ? { totp } : {}),
          agentTotp: bool(i.agentTotp),
          agentSignIn: bool(i.agentSignIn),
        }),
      );
    },
    "credentials.update": (c, id, patch) => {
      const p = (patch ?? {}) as unknown as Record<string, unknown>;
      const origin = optStr(p.origin, "origin", MAX_FIELD);
      const username = optStr(p.username, "username", MAX_FIELD);
      const password = optStr(p.password, "password", MAX_FIELD);
      const notes = optStr(p.notes, "notes", MAX_NOTES);
      const totp = totpField(p.totp);
      const agentTotp = optBool(p.agentTotp);
      const agentSignIn = optBool(p.agentSignIn);
      const update: CredentialPatch = {
        ...(origin !== undefined ? { origin } : {}),
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(totp !== undefined ? { totp } : {}),
        ...(agentTotp !== undefined ? { agentTotp } : {}),
        ...(agentSignIn !== undefined ? { agentSignIn } : {}),
      };
      const next = c.profile.credentials.update(str(id, "id", 128), update);
      if (!next) throw new IpcError("No such login");
      return credentialSummary(next);
    },
    "credentials.remove": (c, id) => c.profile.credentials.remove(str(id, "id", 128)),
    "credentials.generate": (_c, opts) => generatePassword(passwordOptions(opts)),
    "credentials.persisted": (c) => c.profile.credentials.secretsPersisted,
    "credentials.totpCode": async (c, id) => {
      const config = c.profile.credentials.get(str(id, "id", 128))?.totp;
      return config ? totpCode(config) : null;
    },
    "credentials.copyTotp": async (c, id) => {
      const config = c.profile.credentials.get(str(id, "id", 128))?.totp;
      if (!config) throw new IpcError("This login has no 2FA code");
      clipboard.writeText((await totpCode(config)).code);
    },
    "credentials.importTotpQr": (c) => importTotpQr(c.window),
    "credentials.agentAccess": () => ctx.settings.get().passwords.agentAccess,
    "credentials.autoSignInIds": (c) => [...c.profile.autoSignIn.ids()],
    "credentials.checkup": (c) => ctx.passwordCheckup.view(c.profile),
    "credentials.runCheckup": (c) => ctx.passwordCheckup.run(c.profile),
    "credentials.setAutoSignIn": (c, id, on) => {
      const loginId = str(id, "id", 256);
      if (on === true && !c.profile.logins.get(loginId)) throw new IpcError("No such login");
      return c.profile.autoSignIn.set(loginId, on === true);
    },
  };
}

export function autofillChromeHandlers(ctx: AppContext): ChromeHandlers<AutofillChromeRpc> {
  return {
    "autofill.suggestions": (w) => ctx.autofill.suggestions(w),
    "autofill.fill": (w, id) => ctx.autofill.fill(w, str(id, "id", 128)),
    "autofill.fillTotp": (w, id) => ctx.autofill.fillTotp(w, str(id, "id", 128)),
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
  ipcMain.on(AUTOFILL_FIELD_CHANNEL, (event: IpcMainEvent, raw: unknown) => {
    const found = ctx.windows.byTabWebContents(event.sender);
    if (!found || event.senderFrame !== event.sender.mainFrame) return;
    const box = parseFieldBox(raw);
    if (box) ctx.autofill.onLoginFieldClicked(found.window, found.tab, box);
  });
}

const MAX_COORD = 100_000;

function parseFieldBox(raw: unknown): LoginFieldBox | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= MAX_COORD;
  if (!num(v.x) || !num(v.y) || !num(v.width) || !num(v.height)) return null;
  return { x: v.x, y: v.y, width: v.width, height: v.height };
}

// ------------------------------------------------------------------------- KeePass

export const KEEPASS_INTERNAL_PERMISSIONS: Record<keyof KeePassRpc, readonly InternalPage[]> = {
  "keepass.state": ["passwords"],
  "keepass.addFiles": ["passwords"],
  "keepass.addFolder": ["passwords"],
  "keepass.removeSource": ["passwords"],
  "keepass.pickKeyFile": ["passwords"],
  "keepass.unlock": ["passwords"],
  "keepass.lock": ["passwords"],
  "keepass.entries": ["passwords"],
  "keepass.reveal": ["passwords"],
  "keepass.copyPassword": ["passwords"],
  "keepass.totpCode": ["passwords"],
  "keepass.copyTotp": ["passwords"],
  "keepass.setAgentOptIn": ["passwords"],
  "keepass.export": ["passwords"],
};

const MIN_EXPORT_PASSWORD = 8;

function keepassState(ctx: AppContext, profile: ProfileRuntime): KeePassState {
  const kp = profile.keepass;
  return { sources: kp.sources(), databases: kp.databases(), canRemember: kp.canRemember, autoLockMinutes: ctx.settings.get().passwords.keepassAutoLockMinutes };
}

async function pickPaths(window: BrowserWindowCtl | undefined, options: Electron.OpenDialogOptions): Promise<string[]> {
  const parent = window?.win;
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

/**
 * Writes the profile's built-in saved logins (and their 2FA) to a new .kdbx at `file`, protected by
 * `password`. Refuses to overwrite anything: the export only ever creates a new file.
 */
export async function exportVaultToKdbx(profile: ProfileRuntime, file: string, password: string): Promise<KeePassExportResult> {
  if (password.length < MIN_EXPORT_PASSWORD) return { ok: false, error: `Choose a master password of at least ${MIN_EXPORT_PASSWORD} characters.` };
  const target = /\.kdbx$/i.test(file) ? file : `${file}.kdbx`;
  if (fs.existsSync(target)) return { ok: false, error: "That file already exists. Corvus only exports to a new file and never overwrites a database." };
  const creds = profile.credentials.all();
  if (creds.length === 0) return { ok: false, error: "There are no saved logins to export." };
  try {
    const bytes = await createKdbx(vaultExportEntries(creds), password, { name: "Corvus" });
    await fs.promises.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    return { ok: true, path: target, count: creds.length };
  } catch (err) {
    return { ok: false, error: `Could not write the file: ${(err as Error).message}` };
  }
}

export function keepassInternalHandlers(ctx: AppContext): InternalHandlers<KeePassRpc> {
  const entry = (c: InternalContext, id: unknown) => {
    const record = c.profile.keepass.get(str(id, "id", 256));
    if (!record) throw new IpcError("That entry is not available. Its database may be locked.");
    return record;
  };
  return {
    "keepass.state": (c) => keepassState(ctx, c.profile),
    "keepass.addFiles": async (c) => {
      const files = await pickPaths(c.window, {
        title: "Add KeePass databases",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "KeePass databases", extensions: ["kdbx"] }],
      });
      if (files.length) c.profile.keepass.addSources(files, "file");
      return keepassState(ctx, c.profile);
    },
    "keepass.addFolder": async (c) => {
      const [dir] = await pickPaths(c.window, { title: "Add a folder of KeePass databases", properties: ["openDirectory"] });
      if (dir) c.profile.keepass.addSources([dir], "folder");
      return keepassState(ctx, c.profile);
    },
    "keepass.removeSource": (c, id) => {
      c.profile.keepass.removeSource(str(id, "id", 64));
      return keepassState(ctx, c.profile);
    },
    "keepass.pickKeyFile": async (c) => (await pickPaths(c.window, { title: "Choose the key file", properties: ["openFile"] }))[0] ?? null,
    "keepass.unlock": (c, dbId, password, keyFilePath, keep) =>
      c.profile.keepass.unlock(
        str(dbId, "database", 64),
        str(password ?? "", "password", MAX_FIELD),
        keyFilePath === null || keyFilePath === undefined || keyFilePath === "" ? null : str(keyFilePath, "key file", 4096),
        bool(keep),
      ),
    "keepass.lock": (c, dbId) => {
      c.profile.keepass.lock(dbId === null || dbId === undefined ? null : str(dbId, "database", 64));
      return keepassState(ctx, c.profile);
    },
    "keepass.entries": (c, query) => c.profile.keepass.entries(str(query ?? "", "query", 512)),
    "keepass.reveal": (c, id) => entry(c, id).password,
    "keepass.copyPassword": (c, id) => clipboard.writeText(entry(c, id).password),
    "keepass.totpCode": async (c, id) => {
      const totp = entry(c, id).totp;
      return totp ? totpCode(totp) : null;
    },
    "keepass.copyTotp": async (c, id) => {
      const totp = entry(c, id).totp;
      if (!totp) throw new IpcError("This entry has no 2FA code");
      clipboard.writeText((await totpCode(totp)).code);
    },
    "keepass.setAgentOptIn": (c, id, optIn) => {
      const o = (optIn ?? {}) as Record<string, unknown>;
      const signIn = optBool(o.signIn);
      const totp = optBool(o.totp);
      return c.profile.keepass.setOptIn(str(id, "id", 256), { ...(signIn !== undefined ? { signIn } : {}), ...(totp !== undefined ? { totp } : {}) });
    },
    "keepass.export": async (c, password) => {
      const pw = str(password ?? "", "password", MAX_FIELD);
      if (pw.length < MIN_EXPORT_PASSWORD) return { ok: false, error: `Choose a master password of at least ${MIN_EXPORT_PASSWORD} characters.` };
      const options: Electron.SaveDialogOptions = {
        title: "Export saved logins to a new KeePass database",
        defaultPath: "Corvus passwords.kdbx",
        filters: [{ name: "KeePass database", extensions: ["kdbx"] }],
      };
      const parent = c.window?.win;
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      return exportVaultToKdbx(c.profile, result.filePath, pw);
    },
  };
}
