/**
 * One-time codes for two-factor sign-in: RFC 4226 (HOTP) and RFC 6238 (TOTP), RFC 4648 base32 and
 * `otpauth://totp/...` URIs. Pure Web Crypto with no Node or Electron imports, so it runs in the main
 * process, the renderer and tests alike. Codes are only ever generated in the main process for real
 * secrets; the renderer receives the current code, never the secret.
 */

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";
export const TOTP_ALGORITHMS: readonly TotpAlgorithm[] = ["SHA1", "SHA256", "SHA512"];

/** A time-based one-time password generator. */
export interface TotpConfig {
  /** Shared secret in base32 (RFC 4648), uppercase, without spaces or padding. */
  secret: string;
  algorithm: TotpAlgorithm;
  /** Code length, 6 to 8. */
  digits: number;
  /** Time step in seconds (30 for almost every service). */
  period: number;
}

/** The current code and when it stops being valid. */
export interface TotpCode {
  code: string;
  period: number;
  /** Epoch milliseconds at which the next code takes over. */
  expiresAt: number;
}

export const DEFAULT_TOTP_PERIOD = 30;
export const MIN_TOTP_DIGITS = 6;
export const MAX_TOTP_DIGITS = 8;
export const MAX_TOTP_PERIOD = 3600;
/** Smallest secret accepted from manual entry: 80 bits, what the shortest common secrets use. */
export const MIN_MANUAL_SECRET_BYTES = 10;
const MAX_SECRET_BYTES = 256;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const HASH: Record<TotpAlgorithm, string> = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

/** Uppercases and strips whitespace, dashes and `=` padding, the forms secrets are usually shown in. */
export function normalizeBase32(input: string): string {
  return input.replace(/[\s\-=]/g, "").toUpperCase();
}

/** Decodes RFC 4648 base32 (case and padding tolerant). Throws on any other character. */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = normalizeBase32(input);
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of clean) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new Error("The secret is not valid base32 (letters A-Z and digits 2-7).");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

/** Encodes bytes as RFC 4648 base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/** RFC 4226 HOTP for a raw key and counter (counter up to 2^53). */
export async function hotp(key: Uint8Array, counter: number, opts: { algorithm?: TotpAlgorithm; digits?: number } = {}): Promise<string> {
  const algorithm = opts.algorithm ?? "SHA1";
  const digits = opts.digits ?? MIN_TOTP_DIGITS;
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Invalid HOTP counter");
  if (!Number.isInteger(digits) || digits < 1 || digits > 10) throw new Error("Invalid code length");
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const cryptoKey = await crypto.subtle.importKey("raw", copyBytes(key), { name: "HMAC", hash: { name: HASH[algorithm] } }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 TOTP for a raw key at a Unix time in seconds (T0 = 0). */
export function totpAt(key: Uint8Array, unixSeconds: number, opts: { algorithm?: TotpAlgorithm; digits?: number; period?: number } = {}): Promise<string> {
  const period = opts.period ?? DEFAULT_TOTP_PERIOD;
  return hotp(key, Math.floor(unixSeconds / period), opts);
}

/** The code valid at `now` (epoch ms) for a stored config, with its expiry. */
export async function totpCode(config: TotpConfig, now = Date.now()): Promise<TotpCode> {
  const seconds = Math.floor(now / 1000);
  const step = Math.floor(seconds / config.period);
  const code = await hotp(base32Decode(config.secret), step, { algorithm: config.algorithm, digits: config.digits });
  return { code, period: config.period, expiresAt: (step + 1) * config.period * 1000 };
}

/** Groups a code for reading: "123 456", "1234 5678", "123 4567". */
export function formatTotpCode(code: string): string {
  if (code.length < 6) return code;
  const half = Math.floor(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

function validSecret(secret: string, minBytes: number): boolean {
  if (!/^[A-Z2-7]+$/.test(secret)) return false;
  const bytes = Math.floor((secret.length * 5) / 8);
  return bytes >= minBytes && bytes <= MAX_SECRET_BYTES;
}

export function isValidTotpConfig(value: unknown): value is TotpConfig {
  const v = value as Partial<TotpConfig> | null;
  return (
    typeof v?.secret === "string" &&
    validSecret(v.secret, 1) &&
    typeof v.algorithm === "string" &&
    TOTP_ALGORITHMS.includes(v.algorithm) &&
    typeof v.digits === "number" &&
    Number.isInteger(v.digits) &&
    v.digits >= MIN_TOTP_DIGITS &&
    v.digits <= MAX_TOTP_DIGITS &&
    typeof v.period === "number" &&
    Number.isInteger(v.period) &&
    v.period >= 1 &&
    v.period <= MAX_TOTP_PERIOD
  );
}

/** Builds a config from raw secret bytes (e.g. a KeePass hex or UTF-8 secret). */
export function totpConfigFromBytes(bytes: Uint8Array, opts: { algorithm?: TotpAlgorithm; digits?: number; period?: number } = {}): TotpConfig {
  const config: TotpConfig = {
    secret: base32Encode(bytes),
    algorithm: opts.algorithm ?? "SHA1",
    digits: opts.digits ?? MIN_TOTP_DIGITS,
    period: opts.period ?? DEFAULT_TOTP_PERIOD,
  };
  if (!isValidTotpConfig(config)) throw new Error("Unsupported one-time code settings");
  return config;
}

/** Maps the algorithm spellings seen in otpauth URIs and KeePass fields ("sha256", "HMAC-SHA-256"). */
export function parseTotpAlgorithm(raw: string | null | undefined): TotpAlgorithm | null {
  if (!raw) return "SHA1";
  const key = raw.toUpperCase().replace(/^HMAC-?/, "").replace(/-/g, "");
  return key === "SHA1" || key === "SHA256" || key === "SHA512" ? key : null;
}

export interface OtpauthLabel {
  issuer: string;
  account: string;
}

/**
 * Parses `otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=...&digits=...&period=...`.
 * Counter-based (`hotp`) URIs are rejected: they need a stored counter and are rare for web sign-in.
 */
export function parseOtpauthUri(uri: string): { config: TotpConfig } & OtpauthLabel {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new Error("Not a valid otpauth:// link.");
  }
  if (url.protocol !== "otpauth:") throw new Error("Not a valid otpauth:// link.");
  const type = url.hostname.toLowerCase();
  if (type === "hotp") throw new Error("Counter-based (HOTP) codes are not supported. Use a time-based (TOTP) secret.");
  if (type !== "totp") throw new Error("Only otpauth://totp links are supported.");

  const params = url.searchParams;
  const secret = normalizeBase32(params.get("secret") ?? "");
  if (!secret) throw new Error("The link has no secret.");
  if (!validSecret(secret, 1)) throw new Error("The secret in the link is not valid base32.");

  const algorithm = parseTotpAlgorithm(params.get("algorithm"));
  if (!algorithm) throw new Error("Unsupported algorithm. Corvus supports SHA1, SHA256 and SHA512.");

  const digitsRaw = params.get("digits");
  const digits = digitsRaw === null ? MIN_TOTP_DIGITS : Number(digitsRaw);
  if (!Number.isInteger(digits) || digits < MIN_TOTP_DIGITS || digits > MAX_TOTP_DIGITS) throw new Error("Codes must have 6 to 8 digits.");

  const periodRaw = params.get("period");
  const period = periodRaw === null ? DEFAULT_TOTP_PERIOD : Number(periodRaw);
  if (!Number.isInteger(period) || period < 1 || period > MAX_TOTP_PERIOD) throw new Error("Invalid code period.");

  let label = "";
  try {
    label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    label = url.pathname.replace(/^\/+/, "");
  }
  const colon = label.indexOf(":");
  const labelIssuer = colon >= 0 ? label.slice(0, colon).trim() : "";
  const account = (colon >= 0 ? label.slice(colon + 1) : label).trim();
  const issuer = (params.get("issuer") ?? labelIssuer).trim();
  return { config: { secret, algorithm, digits, period }, issuer, account };
}

/** Builds a standard otpauth URI (used for KeePassXC's `otp` field and for editing). */
export function buildOtpauthUri(config: TotpConfig, label: Partial<OtpauthLabel> = {}): string {
  const issuer = (label.issuer ?? "").trim();
  const account = (label.account ?? "").trim();
  const path = issuer ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` : encodeURIComponent(account);
  const params = new URLSearchParams({ secret: config.secret });
  if (issuer) params.set("issuer", issuer);
  params.set("algorithm", config.algorithm);
  params.set("digits", String(config.digits));
  params.set("period", String(config.period));
  return `otpauth://totp/${path}?${params.toString()}`;
}

/**
 * What a person pastes in the 2FA field: an otpauth:// link or a bare base32 secret (spaces and
 * lowercase allowed). A bare secret uses the defaults every authenticator app assumes.
 */
export function parseTotpInput(input: string): TotpConfig {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a 2FA secret or an otpauth:// link.");
  if (/^otpauth:/i.test(trimmed)) return parseOtpauthUri(trimmed).config;
  const secret = normalizeBase32(trimmed);
  if (!/^[A-Z2-7]+$/.test(secret)) throw new Error("The secret is not valid base32 (letters A-Z and digits 2-7).");
  if (!validSecret(secret, MIN_MANUAL_SECRET_BYTES)) throw new Error("The secret is too short. 2FA secrets are at least 16 characters.");
  return { secret, algorithm: "SHA1", digits: MIN_TOTP_DIGITS, period: DEFAULT_TOTP_PERIOD };
}
