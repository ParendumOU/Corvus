/**
 * The passwords another browser saved for this user, read once when the person presses Import: its
 * databases from private copies (main/browser-import.ts withDatabase, deleted afterwards whatever
 * happens), its key from the system (browser-keys.ts), each value with password-decrypt.ts. What
 * cannot be read is listed by site and username with the reason; a password never appears in a
 * result, an error or a log. Counting reads rows and version prefixes only, nothing is decrypted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromiumTime, MAX_PASSWORD_NOTES, type PasswordImportSummary, type PasswordNote, type PasswordNoteReason } from "../shared/browser-import";
import { originKeyOf } from "../shared/credentials";
import type { ImportTally, IncomingLogin } from "../shared/password-merge";
import type { DatabaseSync } from "node:sqlite";
import { chromiumKeyNames, type KeyProviders } from "./browser-keys";
import { LINUX_V10_SECRET, chromiumCbcKey, decryptChromiumValue, decryptFirefoxField, dpapiWrappedKey, firefoxLoginKey, type ChromiumKeys, type Key4Rows } from "./password-decrypt";

type WithDatabase = <T>(file: string, read: (db: DatabaseSync) => T) => Promise<T>;

/** Logins read from one browser profile, and the ones that could not come in as they are. */
export interface BrowserPasswords {
  logins: IncomingLogin[];
  protected: PasswordNote[];
  skipped: PasswordNote[];
}

/** Chromium keeps the profile's logins in "Login Data" and the Google account's in "Login Data For Account". */
const CHROMIUM_LOGIN_FILES = ["Login Data", "Login Data For Account"];

const exists = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

export const hasChromiumPasswords = (dir: string): boolean => CHROMIUM_LOGIN_FILES.some((f) => exists(path.join(dir, f)));
export const hasFirefoxPasswords = (dir: string): boolean => exists(path.join(dir, "logins.json"));

/** What a person reads as a login's site: host (and port), or an Android app's package. */
export function siteOf(origin: string): string {
  const app = /^android:\/\/[^@]*@([^/]+)/i.exec(origin);
  if (app) return app[1]!;
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin.slice(0, 200);
  }
}

interface ChromiumRow {
  origin_url: string;
  username_value: string | null;
  password_value: Uint8Array | null;
  blacklisted_by_user: bigint | number;
  federation_url: string | null;
  date_password_modified: bigint | number;
  date_last_used: bigint | number;
  date_created: bigint | number;
}

/** Why a row is skipped before any decryption, or null to read it. */
function chromiumSkip(r: Pick<ChromiumRow, "origin_url" | "blacklisted_by_user" | "federation_url">, valueLength: number): PasswordNoteReason | null {
  if (Number(r.blacklisted_by_user) !== 0) return "never-save";
  if (/^android:/i.test(r.origin_url)) return "android";
  if (!originKeyOf(r.origin_url)) return "not-web";
  if (r.federation_url) return "federated";
  if (valueLength === 0) return "no-password";
  return null;
}

const chromiumMs = (value: bigint | number): number => (Number(value) > 0 ? chromiumTime(value) : 0);

/** Logins (rows) a Chromium profile holds, and how many the browser protects itself, without decrypting. */
export async function countChromiumPasswords(dir: string, withDatabase: WithDatabase): Promise<{ total: number; protected: number }> {
  const seen = new Set<string>();
  let isProtected = 0;
  for (const name of CHROMIUM_LOGIN_FILES) {
    const file = path.join(dir, name);
    if (!exists(file)) continue;
    const rows = await withDatabase(file, (db) =>
      db
        .prepare("SELECT origin_url, username_value, blacklisted_by_user, federation_url, CAST(substr(password_value, 1, 3) AS TEXT) AS prefix, length(password_value) AS len FROM logins")
        .all() as Array<Pick<ChromiumRow, "origin_url" | "username_value" | "blacklisted_by_user" | "federation_url"> & { prefix: string | null; len: number | bigint | null }>,
    );
    for (const r of rows) {
      if (chromiumSkip(r, Number(r.len ?? 0))) continue;
      const key = `${originKeyOf(r.origin_url)}\n${r.username_value ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (/^v\d\d$/.test(r.prefix ?? "") && r.prefix !== "v10" && r.prefix !== "v11") isProtected++;
    }
  }
  return { total: seen.size, protected: isProtected };
}

/**
 * The key Chromium's values on this system open with. `localState` is the browser's Local State text
 * (Windows keeps the wrapped key there). Call `dispose` once the reading is over.
 */
export async function chromiumKeys(sourceId: string, platform: string, localState: string | null, providers: KeyProviders): Promise<{ keys: ChromiumKeys; dispose: () => void }> {
  const keys: ChromiumKeys = {};
  const names = chromiumKeyNames(sourceId);
  if (platform === "win32") {
    const wrapped = dpapiWrappedKey(localState);
    const key = wrapped && providers.dpapi ? providers.dpapi(wrapped) : null;
    if (key && key.length === 32) keys.v10 = { kind: "gcm", key };
    if (providers.dpapi) keys.dpapi = providers.dpapi;
  } else if (platform === "darwin") {
    const secret = providers.keychain ? await providers.keychain(names.service, names.account) : null;
    if (secret) keys.v10 = { kind: "cbc", key: chromiumCbcKey(secret, 1003) };
  } else {
    keys.v10 = { kind: "cbc", key: chromiumCbcKey(LINUX_V10_SECRET, 1) };
    const secret = providers.secretService ? await providers.secretService(names.application) : null;
    if (secret) keys.v11 = { kind: "cbc", key: chromiumCbcKey(secret, 1) };
  }
  return {
    keys,
    dispose: () => {
      for (const k of [keys.v10, keys.v11]) k?.key.fill(0);
      delete keys.v10;
      delete keys.v11;
      delete keys.dpapi;
    },
  };
}

/** Adds a login, keeping one per site and username: the most recently changed. */
function keepNewest(into: Map<string, IncomingLogin>, login: IncomingLogin): void {
  const key = `${login.origin}\n${login.username}`;
  const prev = into.get(key);
  if (!prev || (login.changedAt ?? 0) > (prev.changedAt ?? 0)) into.set(key, login);
}

/** Every login of a Chromium profile, read with `keys`. */
export async function readChromiumPasswords(dir: string, keys: ChromiumKeys, withDatabase: WithDatabase): Promise<BrowserPasswords> {
  const found = new Map<string, IncomingLogin>();
  const out: BrowserPasswords = { logins: [], protected: [], skipped: [] };
  const noted = new Set<string>();
  const note = (list: PasswordNote[], origin: string, username: string, reason: PasswordNoteReason): void => {
    const key = `${reason}\n${origin}\n${username}`;
    if (noted.has(key)) return;
    noted.add(key);
    list.push({ site: siteOf(origin), username, reason });
  };
  for (const name of CHROMIUM_LOGIN_FILES) {
    const file = path.join(dir, name);
    if (!exists(file)) continue;
    const rows = await withDatabase(file, (db) => {
      const statement = db.prepare("SELECT origin_url, username_value, password_value, blacklisted_by_user, federation_url, date_password_modified, date_last_used, date_created FROM logins");
      statement.setReadBigInts(true);
      return statement.all() as unknown as ChromiumRow[];
    });
    for (const r of rows) {
      const username = r.username_value ?? "";
      const value = r.password_value ?? new Uint8Array();
      const skip = chromiumSkip(r, value.length);
      if (skip) {
        note(out.skipped, r.origin_url, username, skip);
        continue;
      }
      const origin = originKeyOf(r.origin_url);
      const result = decryptChromiumValue(value, keys);
      if (!result.ok) {
        if (result.reason === "unreadable") note(out.skipped, origin, username, "unreadable");
        else note(out.protected, origin, username, result.reason === "app-bound" ? "app-bound" : "keyring");
        continue;
      }
      if (result.password === "") {
        note(out.skipped, origin, username, "no-password");
        continue;
      }
      // The browser's own change date; when it left it empty, the last use, then the creation.
      const changedAt = chromiumMs(r.date_password_modified) || chromiumMs(r.date_last_used) || chromiumMs(r.date_created);
      keepNewest(found, { origin, username, password: result.password, ...(changedAt ? { changedAt } : {}) });
    }
  }
  out.logins = [...found.values()];
  return out;
}

interface FirefoxLoginEntry {
  hostname?: unknown;
  encryptedUsername?: unknown;
  encryptedPassword?: unknown;
  timePasswordChanged?: unknown;
  timeLastUsed?: unknown;
  timeCreated?: unknown;
}

function firefoxEntries(dir: string): FirefoxLoginEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "logins.json"), "utf8")) as { logins?: unknown };
    return Array.isArray(parsed.logins) ? (parsed.logins as FirefoxLoginEntry[]) : [];
  } catch {
    return [];
  }
}

/** Logins a Firefox profile holds (its sites are not encrypted), without decrypting anything. */
export function countFirefoxPasswords(dir: string): number {
  return firefoxEntries(dir).filter((e) => typeof e.hostname === "string" && originKeyOf(e.hostname)).length;
}

const ms = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Every login of a Firefox profile (no primary password; with one, all are protected). */
export async function readFirefoxPasswords(dir: string, withDatabase: WithDatabase): Promise<BrowserPasswords> {
  const out: BrowserPasswords = { logins: [], protected: [], skipped: [] };
  const entries = firefoxEntries(dir);
  if (entries.length === 0) return out;
  const rows = await withDatabase(path.join(dir, "key4.db"), (db): Key4Rows => {
    const meta = db.prepare("SELECT item1, item2 FROM metaData WHERE id = 'password'").get() as { item1: Uint8Array; item2: Uint8Array } | undefined;
    if (!meta) throw new Error("Firefox's key database has no key");
    const keys = db.prepare("SELECT a11, a102 FROM nssPrivate").all() as Array<{ a11: Uint8Array | null; a102: Uint8Array | null }>;
    const loginKeyId = Buffer.from("f8000000000000000000000000000001", "hex");
    const ordered = [...keys.filter((k) => k.a102 && Buffer.from(k.a102).equals(loginKeyId)), ...keys.filter((k) => !(k.a102 && Buffer.from(k.a102).equals(loginKeyId)))];
    return { globalSalt: Buffer.from(meta.item1), check: Buffer.from(meta.item2), privateKeys: ordered.flatMap((k) => (k.a11 ? [Buffer.from(k.a11)] : [])) };
  });
  const key = firefoxLoginKey(rows);
  const found = new Map<string, IncomingLogin>();
  try {
    for (const e of entries) {
      const origin = typeof e.hostname === "string" ? originKeyOf(e.hostname) : "";
      if (!origin || typeof e.encryptedUsername !== "string" || typeof e.encryptedPassword !== "string") {
        out.skipped.push({ site: typeof e.hostname === "string" ? siteOf(e.hostname) : "", username: "", reason: "not-web" });
        continue;
      }
      if (key === "primary-password") {
        out.protected.push({ site: siteOf(origin), username: "", reason: "primary-password" });
        continue;
      }
      let username: string;
      let password: string;
      try {
        username = decryptFirefoxField(e.encryptedUsername, key);
        password = decryptFirefoxField(e.encryptedPassword, key);
      } catch {
        out.skipped.push({ site: siteOf(origin), username: "", reason: "unreadable" });
        continue;
      }
      if (!password) {
        out.skipped.push({ site: siteOf(origin), username, reason: "no-password" });
        continue;
      }
      const changedAt = ms(e.timePasswordChanged) || ms(e.timeLastUsed) || ms(e.timeCreated);
      keepNewest(found, { origin, username, password, ...(changedAt ? { changedAt } : {}) });
    }
  } finally {
    if (Buffer.isBuffer(key)) key.fill(0);
  }
  out.logins = [...found.values()];
  return out;
}

/** The result the person reads, from the vault's tally and the logins that did not come in as they are. */
export function passwordSummary(
  tally: ImportTally,
  review: ReadonlyArray<{ origin: string; username: string }>,
  read: Pick<BrowserPasswords, "protected" | "skipped">,
  merged: { older: PasswordNote[]; deleted: PasswordNote[] },
  extra: { reviewToken?: string; browser?: string } = {},
): PasswordImportSummary {
  const reviewNotes = review.map((r): PasswordNote => ({ site: siteOf(r.origin), username: r.username, reason: "review" }));
  return {
    added: tally.added,
    updated: tally.updated,
    alreadySaved: tally.alreadySaved,
    olderLeftAlone: tally.olderLeftAlone,
    deletedLeftOut: tally.deletedLeftOut,
    protected: read.protected.length,
    skipped: read.skipped.length,
    review: review.map((r) => ({ site: siteOf(r.origin), username: r.username })),
    ...(extra.reviewToken ? { reviewToken: extra.reviewToken } : {}),
    notes: [...read.protected, ...reviewNotes, ...merged.older, ...merged.deleted, ...read.skipped].slice(0, MAX_PASSWORD_NOTES),
    ...(extra.browser ? { browser: extra.browser } : {}),
  };
}

/**
 * Undated differences waiting for the person's Update / Update all, with their passwords, kept in the
 * main process only (the page gets a token and site + username). Expire after half an hour.
 */
export class PasswordReviews {
  private readonly pending = new Map<string, { profileId: string; items: Array<{ origin: string; username: string; password: string } | null>; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  add(profileId: string, items: Array<{ origin: string; username: string; password: string }>): string | undefined {
    this.prune();
    if (items.length === 0) return undefined;
    const token = crypto.randomUUID();
    this.pending.set(token, { profileId, items: [...items], expires: this.now() + 30 * 60_000 });
    return token;
  }

  /** Takes the chosen items (by index; all when `which` is "all"), each once. */
  take(profileId: string, token: string, which: number[] | "all"): Array<{ origin: string; username: string; password: string }> {
    this.prune();
    const entry = this.pending.get(token);
    if (!entry || entry.profileId !== profileId) return [];
    const indexes = which === "all" ? entry.items.map((_, i) => i) : which.filter((i) => Number.isInteger(i) && i >= 0 && i < entry.items.length);
    const out: Array<{ origin: string; username: string; password: string }> = [];
    for (const i of indexes) {
      const item = entry.items[i];
      if (item) out.push(item);
      entry.items[i] = null;
    }
    if (entry.items.every((i) => i === null)) this.pending.delete(token);
    return out;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.pending) if (entry.expires < now) this.pending.delete(token);
  }
}
