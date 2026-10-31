/**
 * Reading the passwords another browser on this computer saved for this user, once the key it keeps
 * them under is in hand (main/browser-keys.ts gets that key from the system). Pure functions over
 * buffers, unit-tested with fixture values made by node:crypto.
 *
 * Chromium values start with a version: "v10"/"v11" are read (AES-256-GCM on Windows, AES-128-CBC on
 * macOS and Linux). Newer versions such as "v20" (Chrome's app-bound encryption) are never attempted:
 * they are reported as protected by the browser, and the person uses the browser's own export.
 *
 * Firefox keeps a key in key4.db under the person's primary password (empty when none is set) and the
 * logins in logins.json encrypted with that key (NSS formats: PBES2 with PBKDF2 + AES-256-CBC, or the
 * older SHA-1 + 3DES form).
 */
import crypto from "node:crypto";

// ------------------------------------------------------------------------------------- Chromium

/** A key Chromium's values can be read with: AES-256-GCM (Windows) or AES-128-CBC (macOS, Linux). */
export type ChromiumKey = { kind: "gcm"; key: Buffer } | { kind: "cbc"; key: Buffer };

/** The keys for one browser: per version prefix, plus Windows' per-value DPAPI for values with none. */
export interface ChromiumKeys {
  v10?: ChromiumKey;
  v11?: ChromiumKey;
  /** Windows: unprotects a whole value as the current user (values saved before "v10"). */
  dpapi?: (blob: Buffer) => Buffer | null;
}

/** Why a value could not be read: protected by the browser (a newer version), key unavailable, or damaged. */
export type ValueFailure = "app-bound" | "locked" | "unreadable";
export type ValueResult = { ok: true; password: string } | { ok: false; reason: ValueFailure };

const CBC_IV = Buffer.alloc(16, 0x20);

/** The AES-128-CBC key macOS (1003 rounds of the Keychain secret) and Linux (1 round) derive. */
export function chromiumCbcKey(secret: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(secret, "saltysalt", iterations, 16, "sha1");
}

/** Linux's fixed "v10" secret, used when no keyring is available. */
export const LINUX_V10_SECRET = "peanuts";

/** One stored password_value. Never throws. */
export function decryptChromiumValue(value: Uint8Array, keys: ChromiumKeys): ValueResult {
  const v = Buffer.from(value);
  if (v.length === 0) return { ok: true, password: "" };
  const prefix = v.subarray(0, 3).toString("latin1");
  if (/^v\d\d$/.test(prefix)) {
    const key = prefix === "v10" ? keys.v10 : prefix === "v11" ? keys.v11 : undefined;
    // Any other version (v20 and later) is the browser's own protection: never attempted.
    if (prefix !== "v10" && prefix !== "v11") return { ok: false, reason: "app-bound" };
    if (!key) return { ok: false, reason: "locked" };
    try {
      if (key.kind === "gcm") {
        if (v.length < 3 + 12 + 16) return { ok: false, reason: "unreadable" };
        const decipher = crypto.createDecipheriv("aes-256-gcm", key.key, v.subarray(3, 15));
        decipher.setAuthTag(v.subarray(v.length - 16));
        return { ok: true, password: Buffer.concat([decipher.update(v.subarray(15, v.length - 16)), decipher.final()]).toString("utf8") };
      }
      const decipher = crypto.createDecipheriv("aes-128-cbc", key.key, CBC_IV);
      return { ok: true, password: Buffer.concat([decipher.update(v.subarray(3)), decipher.final()]).toString("utf8") };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  if (!keys.dpapi) return { ok: false, reason: "unreadable" };
  const plain = keys.dpapi(v);
  return plain ? { ok: true, password: plain.toString("utf8") } : { ok: false, reason: "locked" };
}

/** The DPAPI blob inside Local State's os_crypt.encrypted_key ("DPAPI" + blob), or null. */
export function dpapiWrappedKey(localState: string | null): Buffer | null {
  try {
    const encoded = (JSON.parse(localState ?? "{}") as { os_crypt?: { encrypted_key?: unknown } }).os_crypt?.encrypted_key;
    if (typeof encoded !== "string") return null;
    const raw = Buffer.from(encoded, "base64");
    return raw.subarray(0, 5).toString("latin1") === "DPAPI" ? raw.subarray(5) : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------- Firefox

/** A DER node: its tag, its content, and its children when constructed. */
interface Der {
  tag: number;
  body: Buffer;
  children: Der[];
}

function parseDer(buf: Buffer, start = 0, end = buf.length): Der[] {
  const nodes: Der[] = [];
  let at = start;
  while (at < end) {
    const tag = buf[at]!;
    let len = buf[at + 1]!;
    let head = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 4) throw new Error("bad DER length");
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i]!;
      head += n;
    }
    const bodyStart = at + head;
    const bodyEnd = bodyStart + len;
    if (bodyEnd > end) throw new Error("truncated DER");
    nodes.push({ tag, body: buf.subarray(bodyStart, bodyEnd), children: tag & 0x20 ? parseDer(buf, bodyStart, bodyEnd) : [] });
    at = bodyEnd;
  }
  return nodes;
}

function der(buf: Buffer): Der {
  const [node] = parseDer(buf);
  if (!node) throw new Error("empty DER");
  return node;
}

function oidOf(node: Der | undefined): string {
  if (!node || node.tag !== 0x06) return "";
  const b = node.body;
  const parts = [Math.floor(b[0]! / 40), b[0]! % 40];
  let value = 0;
  for (let i = 1; i < b.length; i++) {
    value = value * 128 + (b[i]! & 0x7f);
    if (!(b[i]! & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

const intOf = (node: Der | undefined): number => (node && node.tag === 0x02 ? node.body.reduce((n, byte) => n * 256 + byte, 0) : 0);

export const OID = {
  pbes2: "1.2.840.113549.1.5.13",
  pbkdf2: "1.2.840.113549.1.5.12",
  aes256cbc: "2.16.840.1.101.3.4.1.42",
  des3cbc: "1.2.840.113549.3.7",
  pbeSha1Des3: "1.2.840.113549.1.12.5.1.3",
} as const;

const sha1 = (...parts: Buffer[]): Buffer => crypto.createHash("sha1").update(Buffer.concat(parts)).digest();
const hmacSha1 = (key: Buffer, data: Buffer): Buffer => crypto.createHmac("sha1", key).update(data).digest();

function decipher(algorithm: string, key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const d = crypto.createDecipheriv(algorithm, key, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

/**
 * An NSS password-based value (key4.db's check value and key): SEQUENCE { algorithm, ciphertext }.
 * `password` is the primary password (empty when none is set). Throws when it is the wrong one.
 */
export function decryptNssPbe(encoded: Buffer, globalSalt: Buffer, password: string): Buffer {
  const [algorithm, ciphertext] = der(encoded).children;
  const oid = oidOf(algorithm?.children[0]);
  const pw = Buffer.from(password, "utf8");
  if (oid === OID.pbes2) {
    const [kdf, scheme] = algorithm!.children[1]!.children;
    if (oidOf(kdf?.children[0]) !== OID.pbkdf2) throw new Error("unsupported key derivation");
    const params = kdf!.children[1]!.children;
    const entrySalt = params[0]!.body;
    const ints = params.filter((p) => p.tag === 0x02);
    const iterations = intOf(ints[0]);
    const keyLength = intOf(ints[1]) || 32;
    if (oidOf(scheme?.children[0]) !== OID.aes256cbc) throw new Error("unsupported cipher");
    const rawIv = scheme!.children[1]!.body;
    // NSS keeps 14 IV bytes; the IV it uses is those behind their own DER header (04 0e).
    const iv = rawIv.length === 14 ? Buffer.concat([Buffer.from([0x04, 0x0e]), rawIv]) : rawIv;
    const key = crypto.pbkdf2Sync(sha1(globalSalt, pw), entrySalt, iterations, keyLength, "sha256");
    return decipher("aes-256-cbc", key, iv, ciphertext!.body);
  }
  if (oid === OID.pbeSha1Des3) {
    const entrySalt = algorithm!.children[1]!.children[0]!.body;
    const hp = sha1(globalSalt, pw);
    const pes = Buffer.concat([entrySalt, Buffer.alloc(Math.max(0, 20 - entrySalt.length))]);
    const chp = sha1(hp, entrySalt);
    const k1 = hmacSha1(chp, Buffer.concat([pes, entrySalt]));
    const tk = hmacSha1(chp, pes);
    const k2 = hmacSha1(chp, Buffer.concat([tk, entrySalt]));
    const k = Buffer.concat([k1, k2]);
    return decipher("des-ede3-cbc", k.subarray(0, 24), k.subarray(k.length - 8), ciphertext!.body);
  }
  throw new Error("unsupported algorithm");
}

/** key4.db's rows the key comes from. */
export interface Key4Rows {
  /** metaData id 'password': item1 = global salt, item2 = encrypted check value. */
  globalSalt: Buffer;
  check: Buffer;
  /** nssPrivate a11 values (the first one whose a102 is Firefox's login key id, else the first). */
  privateKeys: Buffer[];
}

/** Firefox's login key, or "primary-password" when one is set (the check fails with an empty one). */
export function firefoxLoginKey(rows: Key4Rows, password = ""): Buffer | "primary-password" {
  try {
    if (!decryptNssPbe(rows.check, rows.globalSalt, password).toString("latin1").startsWith("password-check")) return "primary-password";
  } catch {
    return "primary-password";
  }
  for (const encoded of rows.privateKeys) {
    try {
      return decryptNssPbe(encoded, rows.globalSalt, password);
    } catch {
      // Try the next one.
    }
  }
  throw new Error("no readable key");
}

/** One logins.json field: SEQUENCE { key id, SEQUENCE { cipher, iv }, ciphertext }, base64. */
export function decryptFirefoxField(base64: string, key: Buffer): string {
  const [, cipher, ciphertext] = der(Buffer.from(base64, "base64")).children;
  const oid = oidOf(cipher?.children[0]);
  const iv = cipher!.children[1]!.body;
  if (oid === OID.des3cbc) return decipher("des-ede3-cbc", key.subarray(0, 24), iv, ciphertext!.body).toString("utf8");
  if (oid === OID.aes256cbc) return decipher("aes-256-cbc", key.subarray(0, 32), iv, ciphertext!.body).toString("utf8");
  throw new Error("unsupported cipher");
}
