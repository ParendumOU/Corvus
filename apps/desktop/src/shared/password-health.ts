/**
 * Password checkup for corvus://passwords: which saved passwords appear in known data breaches
 * (Have I Been Pwned's range API, k-anonymity: only the first 5 hex characters of a password's
 * SHA-1 leave the device), which are reused across logins and which are easy to guess.
 * Pure rules here; main/password-checkup.ts does the hashing and the requests.
 */

/** Health of one saved login (vault or KeePass id). */
export interface PasswordHealth {
  id: string;
  /** Times the password appears in known breaches: 0 = not found, null = not checked yet. */
  breaches: number | null;
  /** Other saved logins with the same password. */
  reusedWith: number;
  weak: boolean;
}

export interface PasswordCheckupView {
  /** When the last breach check finished (this session), or null before the first one. */
  checkedAt: number | null;
  running: boolean;
  /** The last check could not reach the breach service. */
  error: string | null;
  items: PasswordHealth[];
}

/** The count for `suffix` (35 upper-case hex characters) in a range response; padding lines count 0. */
export function breachCount(body: string, suffix: string): number {
  const want = suffix.toUpperCase();
  for (const line of body.split(/\r?\n/)) {
    const [hash, count] = line.trim().split(":");
    if (hash?.toUpperCase() === want) {
      const n = Number.parseInt(count ?? "", 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
  }
  return 0;
}

/** The most used passwords and keyboard walks, as the base a guessable password is built on. */
const COMMON_BASES = new Set([
  "password", "passw0rd", "qwerty", "qwertyuiop", "asdfgh", "azerty", "letmein", "welcome", "admin", "administrator",
  "iloveyou", "monkey", "dragon", "football", "baseball", "sunshine", "princess", "master", "shadow", "superman",
  "trustno1", "abc", "abcd", "abcdef", "login", "secret", "changeme", "default", "user", "test", "contraseña", "hola",
]);

/**
 * Whether a password is easy to guess: short, made of few distinct characters, a sequence, a
 * common password with digits or symbols around it, or too little variety for its length.
 */
export function isWeakPassword(password: string): boolean {
  if (password.length < 8) return true;
  if (new Set(password).size < 4) return true;
  if (/^\d+$/.test(password) && password.length < 12) return true;
  const base = password.toLowerCase().replace(/^[\d\W_]+|[\d\W_]+$/g, "");
  if (base === "" || COMMON_BASES.has(base)) return true;
  if (isSequence(password.toLowerCase())) return true;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[^a-zA-Z\d]/.test(password)) pool += 33;
  return password.length * Math.log2(Math.max(pool, 2)) < 40;
}

/** "abcdefgh", "12345678", "87654321": each character one step from the last. */
function isSequence(s: string): boolean {
  if (s.length < 4) return false;
  const step = s.charCodeAt(1) - s.charCodeAt(0);
  if (Math.abs(step) !== 1) return false;
  for (let i = 2; i < s.length; i += 1) if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== step) return false;
  return true;
}

/** For each login, how many other logins share its password (empty passwords never count). */
export function reuseCounts(entries: ReadonlyArray<{ id: string; password: string }>): Map<string, number> {
  const byPassword = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.password) continue;
    byPassword.set(e.password, [...(byPassword.get(e.password) ?? []), e.id]);
  }
  const out = new Map<string, number>();
  for (const ids of byPassword.values()) for (const id of ids) out.set(id, ids.length - 1);
  return out;
}

/** Logins with something to fix: breached first, then reused, then weak. */
export function checkupSummary(items: readonly PasswordHealth[]): { breached: number; reused: number; weak: number } {
  return {
    breached: items.filter((i) => (i.breaches ?? 0) > 0).length,
    reused: items.filter((i) => i.reusedWith > 0).length,
    weak: items.filter((i) => i.weak).length,
  };
}
