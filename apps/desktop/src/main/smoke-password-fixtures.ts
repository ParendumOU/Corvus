// Fake password stores in real formats, for the password import tests and smoke: Chromium "Login Data"
// databases with Linux "v10" values (the fixed key Chromium uses without a keyring), a "v20" value
// (app-bound: must stay unread), a "v11" value (needs the keyring) and rows that are skipped; and a
// Firefox profile's key4.db + logins.json (no primary password). Made-up logins on example domains only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LINUX_V10_SECRET, OID, chromiumCbcKey, type ChromiumKey } from "./password-decrypt";

/** Chromium time: microseconds since 1601-01-01. */
const chromium = (ms: number): number => (ms === 0 ? 0 : (ms + 11_644_473_600_000) * 1000);

/** A Chromium password_value under `key` with a version prefix. */
export function chromiumValue(password: string, key: ChromiumKey, prefix = "v10"): Buffer {
  if (key.kind === "gcm") {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key.key, nonce);
    const body = Buffer.concat([c.update(password, "utf8"), c.final()]);
    return Buffer.concat([Buffer.from(prefix, "latin1"), nonce, body, c.getAuthTag()]);
  }
  const c = crypto.createCipheriv("aes-128-cbc", key.key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(prefix, "latin1"), c.update(password, "utf8"), c.final()]);
}

export interface ChromiumLoginRow {
  origin: string;
  username: string;
  value: Buffer;
  blacklisted?: boolean;
  federation?: string;
  /** ms; 0 when the browser left it empty. */
  modified?: number;
  lastUsed?: number;
  created?: number;
}

/** A Login Data database with a logins table holding `rows` (the columns the import reads). */
export function writeChromiumLogins(file: string, rows: readonly ChromiumLoginRow[]): void {
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE logins (origin_url VARCHAR NOT NULL, action_url VARCHAR, username_element VARCHAR, username_value VARCHAR, password_element VARCHAR, password_value BLOB, signon_realm VARCHAR NOT NULL, date_created INTEGER NOT NULL, blacklisted_by_user INTEGER NOT NULL, scheme INTEGER NOT NULL, federation_url VARCHAR, date_last_used INTEGER NOT NULL DEFAULT 0, date_password_modified INTEGER NOT NULL DEFAULT 0)",
  );
  const add = db.prepare(
    "INSERT INTO logins (origin_url, action_url, username_value, password_value, signon_realm, date_created, blacklisted_by_user, scheme, federation_url, date_last_used, date_password_modified) VALUES (?, '', ?, ?, ?, ?, ?, 0, ?, ?, ?)",
  );
  for (const r of rows) {
    add.run(r.origin, r.username, r.value, r.origin, chromium(r.created ?? 0), r.blacklisted ? 1 : 0, r.federation ?? "", chromium(r.lastUsed ?? 0), chromium(r.modified ?? 0));
  }
  db.close();
}

// ----------------------------------------------------------------------------- DER for Firefox

function node(tag: number, body: Buffer): Buffer {
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...items: Buffer[]): Buffer => node(0x30, Buffer.concat(items));
const octet = (b: Buffer): Buffer => node(0x04, b);
function int(n: number): Buffer {
  const bytes: number[] = [];
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return node(0x02, Buffer.from(bytes));
}
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = Math.floor(value / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return node(0x06, Buffer.from(out));
}

const sha1 = (...parts: Buffer[]): Buffer => crypto.createHash("sha1").update(Buffer.concat(parts)).digest();
const hmacSha1 = (key: Buffer, data: Buffer): Buffer => crypto.createHmac("sha1", key).update(data).digest();
const encrypt = (algorithm: string, key: Buffer, iv: Buffer, plain: Buffer): Buffer => {
  const c = crypto.createCipheriv(algorithm, key, iv);
  return Buffer.concat([c.update(plain), c.final()]);
};

/** An NSS password-based value: PBES2 (PBKDF2-SHA256 + AES-256-CBC) or the older SHA-1 + 3DES form. */
export function nssPbe(plain: Buffer, globalSalt: Buffer, password: string, legacy = false): Buffer {
  const pw = Buffer.from(password, "utf8");
  if (legacy) {
    const entrySalt = crypto.randomBytes(20);
    const hp = sha1(globalSalt, pw);
    const chp = sha1(hp, entrySalt);
    const k = Buffer.concat([hmacSha1(chp, Buffer.concat([entrySalt, entrySalt])), hmacSha1(chp, Buffer.concat([hmacSha1(chp, entrySalt), entrySalt]))]);
    const ct = encrypt("des-ede3-cbc", k.subarray(0, 24), k.subarray(k.length - 8), plain);
    return seq(seq(oid(OID.pbeSha1Des3), seq(octet(entrySalt), int(1))), octet(ct));
  }
  const entrySalt = crypto.randomBytes(32);
  const iv14 = crypto.randomBytes(14);
  const iterations = 1000;
  const key = crypto.pbkdf2Sync(sha1(globalSalt, pw), entrySalt, iterations, 32, "sha256");
  const ct = encrypt("aes-256-cbc", key, Buffer.concat([Buffer.from([0x04, 0x0e]), iv14]), plain);
  const kdf = seq(oid(OID.pbkdf2), seq(octet(entrySalt), int(iterations), int(32), seq(oid("1.2.840.113549.2.9"), Buffer.from([0x05, 0x00]))));
  return seq(seq(oid(OID.pbes2), seq(kdf, seq(oid(OID.aes256cbc), octet(iv14)))), octet(ct));
}

const LOGIN_KEY_ID = Buffer.from("f8000000000000000000000000000001", "hex");

/** A logins.json field under the login key (3DES for a 24-byte key, AES-256-CBC for 32). */
export function firefoxField(text: string, key: Buffer): string {
  if (key.length === 24) {
    const iv = crypto.randomBytes(8);
    return seq(octet(LOGIN_KEY_ID), seq(oid(OID.des3cbc), octet(iv)), octet(encrypt("des-ede3-cbc", key, iv, Buffer.from(text, "utf8")))).toString("base64");
  }
  const iv = crypto.randomBytes(16);
  return seq(octet(LOGIN_KEY_ID), seq(oid(OID.aes256cbc), octet(iv)), octet(encrypt("aes-256-cbc", key.subarray(0, 32), iv, Buffer.from(text, "utf8")))).toString("base64");
}

export interface FirefoxLoginRow {
  hostname: string;
  username: string;
  password: string;
  /** ms */
  changed: number;
}

/** key4.db + logins.json in `profileDir`. */
export function writeFirefoxLogins(profileDir: string, rows: readonly FirefoxLoginRow[], opts: { primaryPassword?: string; legacy?: boolean; aesLogins?: boolean } = {}): void {
  const password = opts.primaryPassword ?? "";
  const globalSalt = crypto.randomBytes(20);
  const loginKey = crypto.randomBytes(opts.aesLogins ? 32 : 24);
  const db = new DatabaseSync(path.join(profileDir, "key4.db"));
  db.exec("CREATE TABLE metaData (id PRIMARY KEY UNIQUE ON CONFLICT REPLACE, item1, item2); CREATE TABLE nssPrivate (id INTEGER PRIMARY KEY, a11 BLOB, a102 BLOB)");
  db.prepare("INSERT INTO metaData (id, item1, item2) VALUES ('password', ?, ?)").run(globalSalt, nssPbe(Buffer.from("password-check"), globalSalt, password, opts.legacy));
  db.prepare("INSERT INTO nssPrivate (a11, a102) VALUES (?, ?)").run(nssPbe(loginKey, globalSalt, password, opts.legacy), LOGIN_KEY_ID);
  db.close();
  const logins = rows.map((r, i) => ({
    id: i + 1,
    hostname: r.hostname,
    httpRealm: null,
    formSubmitURL: r.hostname,
    usernameField: "user",
    passwordField: "pass",
    encryptedUsername: firefoxField(r.username, loginKey),
    encryptedPassword: firefoxField(r.password, loginKey),
    guid: `{fixture-${i}}`,
    encType: 1,
    timeCreated: r.changed,
    timeLastUsed: r.changed,
    timePasswordChanged: r.changed,
    timesUsed: 1,
  }));
  fs.writeFileSync(path.join(profileDir, "logins.json"), JSON.stringify({ nextId: logins.length + 1, logins, version: 3 }));
}

/** The made-up logins the import fixtures hold, as the person should see them after importing. */
export const FIXTURE_PASSWORDS = {
  chromeMail: { origin: "https://mail.example.com", username: "ana@example.com", password: "fixture-mail-pw" },
  chromeShop: { origin: "https://shop.example.org", username: "bob", password: "fixture-shop-pw" },
  chromeAccount: { origin: "https://account.example.com", username: "ana@example.com", password: "fixture-account-pw" },
  firefoxForum: { origin: "https://forum.example.org", username: "fox@example.org", password: "fixture-forum-pw" },
} as const;

/** Every made-up secret above, so a test can check none of them reached a log. */
export const FIXTURE_SECRETS = [...Object.values(FIXTURE_PASSWORDS).map((l) => l.password), "fixture-keyring-pw", "fixture-app-pw", "fixture-sync-token"];

/**
 * Password stores for the browser fixtures (smoke-import-fixtures.ts): Chrome's Default profile on
 * Linux and the Firefox profile. `now` stamps the dates.
 */
export function writePasswordFixtures(chromeProfile: string, firefoxProfile: string, now: number): void {
  const v10 = { kind: "cbc", key: chromiumCbcKey(LINUX_V10_SECRET, 1) } as const;
  const day = 86_400_000;
  const { chromeMail, chromeShop, chromeAccount, firefoxForum } = FIXTURE_PASSWORDS;
  writeChromiumLogins(path.join(chromeProfile, "Login Data"), [
    { origin: `${chromeMail.origin}/`, username: chromeMail.username, value: chromiumValue(chromeMail.password, v10), modified: now - 10 * day, created: now - 30 * day },
    // No change date: the import falls back to the last use.
    { origin: `${chromeShop.origin}/login`, username: chromeShop.username, value: chromiumValue(chromeShop.password, v10), modified: 0, lastUsed: now - 5 * day, created: now - 40 * day },
    // App-bound (Chrome's own protection): counted, never read.
    { origin: "https://bank.example.com/", username: "ana@example.com", value: Buffer.concat([Buffer.from("v20", "latin1"), crypto.randomBytes(48)]), modified: now - day },
    // Needs the system keyring, which the smoke has not.
    { origin: "https://keyring.example.com/", username: "ana@example.com", value: chromiumValue("fixture-keyring-pw", { kind: "cbc", key: chromiumCbcKey("fixture-keyring-secret", 1) }, "v11"), modified: now - day },
    { origin: "android://AAAA@app.example.org/", username: "ana@example.com", value: chromiumValue("fixture-app-pw", v10), modified: now - day },
    { origin: "https://never.example.com/", username: "", value: Buffer.alloc(0), blacklisted: true },
    { origin: "https://social.example.com/", username: "ana@example.com", value: Buffer.alloc(0), federation: "https://accounts.example.com" },
  ]);
  // Google account store: one login twice (deduplicated), one of its own.
  writeChromiumLogins(path.join(chromeProfile, "Login Data For Account"), [
    { origin: `${chromeMail.origin}/`, username: chromeMail.username, value: chromiumValue(chromeMail.password, v10), modified: now - 10 * day },
    { origin: `${chromeAccount.origin}/`, username: chromeAccount.username, value: chromiumValue(chromeAccount.password, v10), modified: now - 2 * day },
  ]);
  writeFirefoxLogins(firefoxProfile, [
    { hostname: firefoxForum.origin, username: firefoxForum.username, password: firefoxForum.password, changed: now - 3 * day },
    { hostname: chromeMail.origin, username: chromeMail.username, password: chromeMail.password, changed: now - 10 * day },
    { hostname: "chrome://FirefoxAccounts", username: "fox@example.org", password: "fixture-sync-token", changed: now - day },
  ]);
}
