/**
 * Import from Google Authenticator: photos of its export QR codes (and plain setup codes) are read on
 * this device, one photo per call so the Passwords page can show progress, with the QR search in a
 * utility process so the browser never stalls. The accounts and their secrets stay here, in an
 * import session that the page refers to by id; the page only gets photo results and preview rows.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dialog, nativeImage, utilityProcess, type UtilityProcess } from "electron";
import {
  AuthenticatorCollector,
  photoScales,
  planImport,
  rowsToImport,
  type AuthenticatorImportResult,
  type AuthenticatorPick,
  type AuthenticatorPreview,
  type PhotoReport,
  type PhotoStatus,
  type PlanLogin,
} from "../shared/authenticator-import";
import type { CredentialVault } from "./credential-store";
import { tr } from "./menu-i18n";
import { paths } from "./paths";
import { decodeQrBitmap, invertBitmap, type QrEffort } from "./qr-decode";
import type { BrowserWindowCtl } from "./window";

const PHOTO_EXTENSIONS = ["png", "jpg", "jpeg"];
const MAX_PHOTOS = 100;
const MAX_PHOTO_BYTES = 64 * 1024 * 1024;
/** An import left open this long is dropped, with its secrets. */
const SESSION_IDLE_MS = 30 * 60_000;
const DECODE_TIMEOUT_MS = 60_000;
/** Photos of a screen: blur, glare and tilt are worth more retries than a screenshot. */
const PHOTO_EFFORT: QrEffort = { effort: 4, timeLimit: 3000 };

/** Finds QR codes in bitmaps, one at a time, in a utility process; in this process if it cannot run. */
class QrDecoder {
  private child: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private broken = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (text: string | null) => void; reject: (err: Error) => void }>();

  async decode(data: Buffer, width: number, height: number): Promise<string | null> {
    if (!this.broken) {
      try {
        return await this.inChild(data, width, height);
      } catch (err) {
        this.broken = true;
        this.close();
        console.warn(`[corvus] QR decoder process unavailable, decoding in the main process: ${(err as Error).message}`);
      }
    }
    return decodeQrBitmap(data, width, height, "BGRA", PHOTO_EFFORT).catch(() => null);
  }

  private async inChild(data: Buffer, width: number, height: number): Promise<string | null> {
    const child = this.start();
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timed out"));
      }, DECODE_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.postMessage({ id, data, width, height, effort: PHOTO_EFFORT });
    });
  }

  private start(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(paths.qrWorker, [], { serviceName: "Corvus QR decoder", stdio: "ignore" });
    this.ready = new Promise((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("exit", (code) => reject(new Error(`exited with code ${code}`)));
    });
    this.ready.catch(() => {});
    child.on("message", (msg: { id: number; text: string | null }) => {
      const waiting = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      waiting?.resolve(typeof msg.text === "string" ? msg.text : null);
    });
    child.once("exit", (code) => {
      if (this.child === child) this.child = null;
      for (const waiting of this.pending.values()) waiting.reject(new Error(`exited with code ${code}`));
      this.pending.clear();
    });
    this.child = child;
    return child;
  }

  close(): void {
    this.child?.kill();
    this.child = null;
  }
}

/** The text of the QR code in a photo, trying a few sizes; or why there is none. */
async function readPhotoQr(file: string, decode: (data: Buffer, width: number, height: number) => Promise<string | null>): Promise<{ text: string } | { status: PhotoStatus }> {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile()) return { status: { kind: "unreadable" } };
  if (stat.size > MAX_PHOTO_BYTES) return { status: { kind: "too-large" } };
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return { status: { kind: "unreadable" } };
  const { width, height } = image.getSize();
  const long = Math.max(width, height);
  const sizes = photoScales(long);
  // Dark on light at every size, then light on dark (a code shown in a dark theme) at the likeliest two.
  const tries = [...sizes.map((size) => ({ size, invert: false })), ...sizes.slice(0, 2).map((size) => ({ size, invert: true }))];
  for (const { size, invert } of tries) {
    const scaled = size === long ? image : image.resize(width >= height ? { width: size, quality: "good" } : { height: size, quality: "good" });
    const { width: w, height: h } = scaled.getSize();
    const bitmap = scaled.toBitmap();
    if (bitmap.length !== w * h * 4) continue;
    if (invert) invertBitmap(bitmap);
    const text = await decode(bitmap, w, h);
    if (text) return { text };
  }
  return { status: { kind: "none" } };
}

interface Session {
  profileId: string;
  files: string[];
  reports: Array<PhotoReport | undefined>;
  collector: AuthenticatorCollector;
  decoder: QrDecoder;
  timer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();

function touch(id: string, current: Session): void {
  clearTimeout(current.timer);
  current.timer = setTimeout(() => discardAuthenticatorImport(id), SESSION_IDLE_MS);
  current.timer.unref();
}

function session(profileId: string, id: string): Session {
  const found = sessions.get(id);
  if (!found || found.profileId !== profileId) throw new Error(tr("This import has ended. Choose the photos again."));
  touch(id, found);
  return found;
}

const isPhoto = (file: string): boolean => PHOTO_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase());

/** The photos directly in a folder, in name order ("IMG_2" before "IMG_10"). */
async function photosInFolder(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && isPhoto(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((name) => path.join(dir, name));
}

/** Lets the person choose photos, or a folder of them. Null when cancelled. */
export async function pickPhotos(window: BrowserWindowCtl | undefined, kind: "files" | "folder"): Promise<string[] | null> {
  const options: Electron.OpenDialogOptions =
    kind === "folder"
      ? { title: tr("Choose the folder with the photos of the QR codes"), properties: ["openDirectory"] }
      : { title: tr("Choose the photos of the QR codes"), properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: PHOTO_EXTENSIONS }] };
  const parent = window?.win;
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return kind === "folder" ? photosInFolder(result.filePaths[0]!) : result.filePaths.filter(isPhoto);
}

/** Starts an import with these photos, or adds them to one (a photo already in it is left out). */
export function addPhotos(profileId: string, importId: string | null, files: string[]): AuthenticatorPick {
  let id = importId;
  let current = id ? session(profileId, id) : undefined;
  if (!current) {
    id = crypto.randomUUID();
    current = { profileId, files: [], reports: [], collector: new AuthenticatorCollector(), decoder: new QrDecoder() };
    sessions.set(id, current);
    touch(id, current);
  }
  const known = new Set(current.files.map((f) => path.resolve(f)));
  const fresh = [...new Set(files.map((f) => path.resolve(f)))].filter((f) => !known.has(f)).slice(0, Math.max(0, MAX_PHOTOS - current.files.length));
  current.files.push(...fresh);
  return { importId: id!, names: current.files.map((f) => path.basename(f)), added: fresh.length };
}

/** Reads one photo of the import (once: reading it again returns the first result). */
export async function readAuthenticatorPhoto(profileId: string, importId: string, index: number): Promise<PhotoReport> {
  const current = session(profileId, importId);
  const file = current.files[index];
  if (file === undefined) throw new Error("No such photo");
  const known = current.reports[index];
  if (known) return known;
  const found = await readPhotoQr(file, (data, w, h) => current.decoder.decode(data, w, h));
  const report: PhotoReport = { name: path.basename(file), status: "text" in found ? current.collector.add(found.text) : found.status };
  current.reports[index] = report;
  if (current.reports.filter(Boolean).length === current.files.length) current.decoder.close();
  return report;
}

/** The vault's logins as the plan needs them (with their 2FA, which never leaves this process). */
function planLogins(vault: CredentialVault): PlanLogin[] {
  return vault.all().map((c) => ({ id: c.id, origin: c.origin, username: c.username, updatedAt: c.updatedAt, ...(c.totp ? { totp: c.totp } : {}) }));
}

export function authenticatorPreview(profileId: string, importId: string, vault: CredentialVault, sites: Record<string, string>): AuthenticatorPreview {
  const { collector } = session(profileId, importId);
  return { rows: planImport(collector.accounts, planLogins(vault), sites), skipped: collector.skipped, missing: collector.missing(), exportCount: collector.exportCount };
}

/**
 * Imports the chosen rows in one go: matched logins get the 2FA, the others become new logins that
 * hold only the 2FA. The plan is made again here from the stored accounts, so the page only ever
 * sends row ids and the sites typed for them. Ends the session.
 */
export function applyAuthenticatorImport(profileId: string, importId: string, vault: CredentialVault, sites: Record<string, string>, selected: string[]): AuthenticatorImportResult {
  const { collector } = session(profileId, importId);
  const accounts = new Map(collector.accounts.map((a) => [a.id, a]));
  const rows = rowsToImport(planImport(collector.accounts, planLogins(vault), sites), new Set(selected));
  const result: AuthenticatorImportResult = { attached: 0, created: 0 };
  vault.batch(() => {
    for (const row of rows) {
      const account = accounts.get(row.id)!;
      if (row.login) {
        vault.update(row.login.id, { totp: account.config });
        result.attached++;
      } else {
        vault.add({ origin: row.site, username: account.account, password: "", totp: account.config });
        result.created++;
      }
    }
  });
  vault.flush();
  discardAuthenticatorImport(importId);
  return result;
}

/** Ends an import and forgets its accounts. */
export function discardAuthenticatorImport(importId: string): void {
  const current = sessions.get(importId);
  if (!current) return;
  clearTimeout(current.timer);
  current.decoder.close();
  sessions.delete(importId);
}
