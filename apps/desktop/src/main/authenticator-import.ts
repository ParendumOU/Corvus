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
  planImport,
  rowsToImport,
  sameTotp,
  type AuthenticatorImportResult,
  type AuthenticatorPick,
  type AuthenticatorPreview,
  type ImportAccount,
  type PhotoReport,
  type PhotoStatus,
  type PlanLogin,
} from "../shared/authenticator-import";
import type { CredentialVault } from "./credential-store";
import { parseEntryUrl } from "./keepass-entries";
import type { EntryTotp } from "./keepass-format";
import { KEEPASS_ID_PREFIX, type KeePassStore } from "./keepass-store";
import { tr } from "./menu-i18n";
import { paths } from "./paths";
import { isHeif, readHeifQr } from "./heic";
import { decodeQrBitmap, scanPhoto, type QrEffort } from "./qr-decode";
import type { BrowserWindowCtl } from "./window";

const PHOTO_EXTENSIONS = ["png", "jpg", "jpeg", "heic", "heif"];
const MAX_PHOTOS = 100;
const MAX_PHOTO_BYTES = 64 * 1024 * 1024;
/** An import left open this long is dropped, with its secrets. */
const SESSION_IDLE_MS = 30 * 60_000;
const DECODE_TIMEOUT_MS = 60_000;
/** A HEIC photo is decoded and scanned at every size in one go. */
const HEIF_TIMEOUT_MS = 120_000;
/** Photos of a screen: blur, glare and tilt are worth more retries than a screenshot. */
const PHOTO_EFFORT: QrEffort = { effort: 4, timeLimit: 3000 };

type HeifFound = { text: string } | { status: "unreadable" | "none" };

/** What the decoder process answers: the text found (or null), or for a HEIC photo why there is none. */
interface WorkerReply {
  id: number;
  text?: string | null;
  status?: string;
}

/**
 * Finds QR codes in bitmaps, and in HEIC photos (decoded there too), one at a time, in a utility
 * process; in this process if it cannot run.
 */
class QrDecoder {
  private child: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private broken = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (reply: WorkerReply) => void; reject: (err: Error) => void }>();

  async decode(data: Buffer, width: number, height: number): Promise<string | null> {
    if (!this.broken) {
      try {
        const reply = await this.inChild({ kind: "bitmap", data, width, height, effort: PHOTO_EFFORT }, DECODE_TIMEOUT_MS);
        return typeof reply.text === "string" ? reply.text : null;
      } catch (err) {
        this.giveUp(err as Error);
      }
    }
    return decodeQrBitmap(data, width, height, "BGRA", PHOTO_EFFORT).catch(() => null);
  }

  async decodeHeif(file: string): Promise<HeifFound> {
    if (!this.broken) {
      try {
        const reply = await this.inChild({ kind: "heif", file, effort: PHOTO_EFFORT }, HEIF_TIMEOUT_MS);
        if (typeof reply.text === "string") return { text: reply.text };
        return { status: reply.status === "none" ? "none" : "unreadable" };
      } catch (err) {
        this.giveUp(err as Error);
      }
    }
    const bytes = await fs.promises.readFile(file).catch(() => null);
    return bytes ? readHeifQr(bytes, PHOTO_EFFORT) : { status: "unreadable" };
  }

  private giveUp(err: Error): void {
    this.broken = true;
    this.close();
    console.warn(`[corvus] QR decoder process unavailable, decoding in the main process: ${err.message}`);
  }

  private async inChild(request: Record<string, unknown>, timeoutMs: number): Promise<WorkerReply> {
    const child = this.start();
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.postMessage({ id, ...request });
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
    child.on("message", (msg: WorkerReply) => {
      const waiting = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      waiting?.resolve(msg);
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

/** The first bytes of a file (empty when it cannot be read). */
async function fileHead(file: string): Promise<Uint8Array> {
  const handle = await fs.promises.open(file, "r").catch(() => null);
  if (!handle) return new Uint8Array();
  try {
    const head = Buffer.alloc(64);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } catch {
    return new Uint8Array();
  } finally {
    await handle.close();
  }
}

/** The text of the QR code in a photo, trying a few sizes; or why there is none. */
async function readPhotoQr(file: string, decoder: QrDecoder): Promise<{ text: string } | { status: PhotoStatus }> {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile()) return { status: { kind: "unreadable" } };
  if (stat.size > MAX_PHOTO_BYTES) return { status: { kind: "too-large" } };
  // By content, not name: a HEIC photo saved as .jpg is read too.
  if (isHeif(await fileHead(file))) {
    const found = await decoder.decodeHeif(file);
    return "text" in found ? found : { status: { kind: found.status } };
  }
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return { status: { kind: "unreadable" } };
  const { width, height } = image.getSize();
  const long = Math.max(width, height);
  const text = await scanPhoto(
    long,
    (size) => {
      const scaled = size === long ? image : image.resize(width >= height ? { width: size, quality: "good" } : { height: size, quality: "good" });
      const { width: w, height: h } = scaled.getSize();
      return { data: scaled.toBitmap(), width: w, height: h };
    },
    (bitmap) => decoder.decode(bitmap.data as Buffer, bitmap.width, bitmap.height),
  );
  return text ? { text } : { status: { kind: "none" } };
}

interface Session {
  profileId: string;
  files: string[];
  reports: Array<PhotoReport | undefined>;
  collector: AuthenticatorCollector;
  decoder: QrDecoder;
  /** Where each row went in the last preview the page got (row id to target). */
  shown?: Map<string, string>;
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
  const found = await readPhotoQr(file, current.decoder);
  const report: PhotoReport = { name: path.basename(file), status: "text" in found ? current.collector.add(found.text) : found.status };
  current.reports[index] = report;
  if (current.reports.filter(Boolean).length === current.files.length) current.decoder.close();
  return report;
}

/** Where an import finds logins and writes 2FA: the built-in vault and the profile's KeePass databases. */
export interface ImportLogins {
  vault: CredentialVault;
  keepass?: Pick<KeePassStore, "importEntries" | "setTotps" | "databases">;
}

/** A KeePass entry URL as an origin ("example.com" is https), or null when it is not a site. */
function entryOrigin(url: string): string | null {
  const parsed = parseEntryUrl(url);
  return parsed ? `${parsed.scheme ?? "https:"}//${parsed.host}${parsed.port ? `:${parsed.port}` : ""}` : null;
}

/** Every login the plan can use (with their 2FA, which never leaves this process). Entries with no site are left out. */
function planLogins({ vault, keepass }: ImportLogins): PlanLogin[] {
  const builtIn = vault.all().map((c): PlanLogin => ({ id: c.id, origin: c.origin, username: c.username, hasPassword: c.password !== "", updatedAt: c.updatedAt, ...(c.totp ? { totp: c.totp } : {}) }));
  const entries = (keepass?.importEntries() ?? []).flatMap((e): PlanLogin[] => {
    const origins = [...new Set(e.urls.map(entryOrigin).filter((o): o is string => o !== null))];
    if (origins.length === 0) return [];
    return [
      {
        id: e.id,
        origin: origins[0]!,
        ...(origins.length > 1 ? { alsoAt: origins.slice(1) } : {}),
        username: e.username,
        hasPassword: e.hasPassword,
        updatedAt: e.modified,
        ...(e.totp ? { totp: e.totp } : {}),
        keepass: { db: e.dbName, title: e.title, readOnly: e.readOnly },
      },
    ];
  });
  return [...builtIn, ...entries];
}

export function authenticatorPreview(profileId: string, importId: string, logins: ImportLogins, sites: Record<string, string>): AuthenticatorPreview {
  const current = session(profileId, importId);
  const { collector } = current;
  const rows = planImport(collector.accounts, planLogins(logins), sites);
  current.shown = new Map(rows.map((r) => [r.id, r.target]));
  const lockedDatabases = (logins.keepass?.databases() ?? []).filter((d) => d.status === "locked").map((d) => d.name);
  return { rows, skipped: collector.skipped, missing: collector.missing(), exportCount: collector.exportCount, lockedDatabases };
}

/**
 * Imports the chosen rows in one go: matched logins get the 2FA, the others become new logins that
 * hold only the 2FA, and logins an earlier import made for a 2FA alone are fixed or removed. The plan
 * is made again here from the stored accounts, so the page only ever sends row ids and the sites typed
 * for them. A login is only removed while it still has no password and holds the secret that moved.
 * Ends the session, unless a chosen row would now go elsewhere than the preview said.
 */
export async function applyAuthenticatorImport(profileId: string, importId: string, logins: ImportLogins, sites: Record<string, string>, selected: string[]): Promise<AuthenticatorImportResult> {
  const { collector, shown } = session(profileId, importId);
  const result = await importAccounts(logins, collector.accounts, sites, selected, shown);
  discardAuthenticatorImport(importId);
  return result;
}

/**
 * Writes the chosen rows of the plan for these accounts (see applyAuthenticatorImport): the vault in
 * one batch, then each KeePass database in one write (with its .bak copy and conflict check). A
 * database that cannot be written is reported, the rest is imported. `shown` (row id to target, as
 * the preview showed them) makes the import refuse, before writing anything, when a chosen row now
 * goes to or away from a KeePass entry other than the one shown: a database was locked, unlocked or
 * changed meanwhile, and a KeePass file is only ever written for the row the person saw and ticked.
 */
export async function importAccounts(
  logins: ImportLogins,
  list: readonly ImportAccount[],
  sites: Record<string, string>,
  selected: string[],
  shown?: ReadonlyMap<string, string>,
): Promise<AuthenticatorImportResult> {
  const { vault, keepass } = logins;
  const accounts = new Map(list.map((a) => [a.id, a]));
  const rows = rowsToImport(planImport(list, planLogins(logins), sites), new Set(selected));
  const inKeePass = (target: string | undefined): boolean => target?.startsWith(`login:${KEEPASS_ID_PREFIX}`) === true;
  if (shown && rows.some((r) => shown.get(r.id) !== r.target && (inKeePass(shown.get(r.id)) || inKeePass(r.target)))) {
    throw new Error(tr("Some accounts would now go to a different login than the list shows (a KeePass database was locked or changed). Check the list and import again."));
  }
  const targets = new Set(rows.flatMap((r) => (r.login ? [r.login.id] : [])));
  const entries = new Map((keepass?.importEntries() ?? []).map((e) => [e.id, e]));
  const perDb = new Map<string, { name: string; changes: EntryTotp[] }>();
  const result: AuthenticatorImportResult = { attached: 0, created: 0, repaired: 0, keepass: 0, keepassFailed: [] };
  vault.batch(() => {
    for (const row of rows) {
      const account = accounts.get(row.id)!;
      const entry = row.login?.keepass ? entries.get(row.login.id) : undefined;
      if (entry) {
        if (entry.totp && sameTotp(entry.totp, account.config)) continue;
        const db = perDb.get(entry.dbId) ?? { name: entry.dbName, changes: [] };
        db.changes.push({ uuid: entry.uuid, totp: account.config });
        perDb.set(entry.dbId, db);
        continue;
      }
      if (row.login?.keepass) continue;
      if (row.action === "fix" && row.login) {
        vault.update(row.login.id, { username: account.account });
        result.repaired++;
      } else if (row.login) {
        const has = vault.get(row.login.id)?.totp;
        if (!has || !sameTotp(has, account.config)) {
          vault.update(row.login.id, { totp: account.config });
          result.attached++;
        }
      } else {
        vault.add({ origin: row.site, username: account.account, password: "", totp: account.config });
        result.created++;
      }
      let removed = false;
      for (const old of row.removes) {
        const current = vault.get(old.id);
        if (!current || current.password !== "" || !current.totp || !sameTotp(current.totp, account.config) || targets.has(old.id)) continue;
        vault.remove(old.id);
        removed = true;
      }
      if (removed && row.action !== "fix") result.repaired++;
    }
  });
  vault.flush();
  for (const [dbId, { name, changes }] of perDb) {
    try {
      await keepass!.setTotps(dbId, changes);
      result.keepass += changes.length;
    } catch (err) {
      result.keepassFailed.push({ db: name, entries: changes.length, error: (err as Error).message });
    }
  }
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
