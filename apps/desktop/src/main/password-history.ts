/**
 * Keyed hashes of retired passwords, so a login can remember the passwords it used to have without
 * ever keeping one in the clear. Each entry has its own random salt and holds HMAC-SHA256(salt,
 * password); matching re-derives the HMAC and compares in constant time. Histories from several
 * devices merge by union (every entry verifies with its own salt), newest kept, capped.
 *
 * Deterministic except for the salt of a new entry, so the matching and merging are unit-tested.
 */
import crypto from "node:crypto";
import { MAX_PASSWORD_HISTORY, type PasswordHistoryEntry } from "../shared/credentials";

const SALT_BYTES = 16;

/** HMAC-SHA256(salt, password) as base64. */
export function hashPassword(password: string, salt: Buffer): string {
  return crypto.createHmac("sha256", salt).update(password, "utf8").digest("base64");
}

/** A fresh keyed-hash entry for `password`, stamped `at` (ms). */
export function historyEntry(password: string, at: number): PasswordHistoryEntry {
  const salt = crypto.randomBytes(SALT_BYTES);
  return { salt: salt.toString("base64"), hash: hashPassword(password, salt), at };
}

/** True when `password` is the one behind any of the entries. */
export function historyMatches(entries: readonly PasswordHistoryEntry[], password: string): boolean {
  for (const entry of entries) {
    let salt: Buffer;
    try {
      salt = Buffer.from(entry.salt, "base64");
    } catch {
      continue;
    }
    const expected = Buffer.from(entry.hash, "base64");
    const actual = Buffer.from(hashPassword(password, salt), "base64");
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return true;
  }
  return false;
}

/** Newest-first, de-duplicated by (salt, hash), capped to `max`. */
function trim(entries: readonly PasswordHistoryEntry[], max: number): PasswordHistoryEntry[] {
  const seen = new Set<string>();
  const out: PasswordHistoryEntry[] = [];
  for (const e of [...entries].sort((a, b) => b.at - a.at)) {
    const key = `${e.salt}|${e.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * `history` with `password` filed as retired at `at`, unless a matching keyed hash is already there.
 * Capped (oldest dropped).
 */
export function retire(history: readonly PasswordHistoryEntry[], password: string, at: number, max = MAX_PASSWORD_HISTORY): PasswordHistoryEntry[] {
  if (password === "" || historyMatches(history, password)) return trim(history, max);
  return trim([historyEntry(password, at), ...history], max);
}

/** The union of two histories (dropping malformed entries), newest kept, capped. */
export function mergeHistory(a: readonly PasswordHistoryEntry[] = [], b: readonly PasswordHistoryEntry[] = [], max = MAX_PASSWORD_HISTORY): PasswordHistoryEntry[] {
  return trim([...a, ...b].filter((e) => typeof e?.salt === "string" && typeof e.hash === "string" && Number.isFinite(e?.at)), max);
}
