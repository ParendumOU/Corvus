/**
 * Pure helpers for KeePass entries: reading a 2FA generator from the fields KeePassXC and KeePass 2
 * use, and matching an entry's URL fields to a page. No kdbxweb import, so it unit-tests cheaply.
 */
import {
  base32Decode,
  isValidTotpConfig,
  normalizeBase32,
  parseOtpauthUri,
  parseTotpAlgorithm,
  totpConfigFromBytes,
  type TotpAlgorithm,
  type TotpConfig,
} from "../shared/totp";

/** One login read from a KeePass database (decrypted; lives in main-process memory while unlocked). */
export interface KeePassEntry {
  /** Entry UUID as stored in the database (base64). */
  uuid: string;
  title: string;
  username: string;
  password: string;
  /** The URL field first, then additional URLs (KP2A_URL, KP2A_URL_1, ...). */
  urls: string[];
  notes: string;
  totp?: TotpConfig;
  /** Group path for display, e.g. "Personal / Shopping". */
  group: string;
  /** Last modification time, epoch ms. */
  modified: number;
}

/** Reads a field by name; returns "" when it is absent. */
export type FieldReader = (name: string) => string;

function toInt(raw: string, fallback: number): number {
  const n = Number(raw.trim());
  return raw.trim() && Number.isInteger(n) ? n : fallback;
}

function fromBase64(raw: string): Uint8Array {
  return Uint8Array.from(Buffer.from(raw.trim(), "base64"));
}

function fromHex(raw: string): Uint8Array {
  const clean = raw.replace(/\s/g, "");
  if (!/^([0-9a-f]{2})+$/i.test(clean)) throw new Error("bad hex");
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

function safe(build: () => TotpConfig): TotpConfig | undefined {
  try {
    const config = build();
    return isValidTotpConfig(config) ? config : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The entry's 2FA generator, from (in order): KeePassXC's `otp` field (an otpauth:// URI, or the older
 * `key=...&step=...&size=...` form), KeePass 2.47+ `TimeOtp-*` fields, or KeePassXC's legacy
 * `TOTP Seed` / `TOTP Settings` pair. Anything unsupported (HOTP, Steam codes) is ignored.
 */
export function totpFromFields(field: FieldReader): TotpConfig | undefined {
  const otp = field("otp").trim();
  if (/^otpauth:/i.test(otp)) return safe(() => parseOtpauthUri(otp).config);
  if (otp && /(^|&)key=/i.test(otp)) {
    const params = new URLSearchParams(otp);
    const algorithm = parseTotpAlgorithm(params.get("otpHashMode"));
    return safe(() => ({
      secret: normalizeBase32(params.get("key") ?? ""),
      algorithm: algorithm ?? ("" as TotpAlgorithm),
      digits: toInt(params.get("size") ?? "", 6),
      period: toInt(params.get("step") ?? "", 30),
    }));
  }

  const algorithmRaw = field("TimeOtp-Algorithm");
  const algorithm = parseTotpAlgorithm(algorithmRaw || null);
  const opts = { digits: toInt(field("TimeOtp-Length"), 6), period: toInt(field("TimeOtp-Period"), 30) };
  const secrets: Array<[string, () => Uint8Array]> = [
    ["TimeOtp-Secret-Base32", () => base32Decode(field("TimeOtp-Secret-Base32"))],
    ["TimeOtp-Secret-Hex", () => fromHex(field("TimeOtp-Secret-Hex"))],
    ["TimeOtp-Secret-Base64", () => fromBase64(field("TimeOtp-Secret-Base64"))],
    ["TimeOtp-Secret", () => new TextEncoder().encode(field("TimeOtp-Secret"))],
  ];
  for (const [name, bytes] of secrets) {
    if (!field(name).trim()) continue;
    if (!algorithm) return undefined;
    return safe(() => totpConfigFromBytes(bytes(), { algorithm, ...opts }));
  }

  const seed = field("TOTP Seed").trim();
  if (seed) {
    const [period, size] = field("TOTP Settings").split(";");
    if (size === "S") return undefined; // Steam Guard codes use a different alphabet.
    return safe(() => ({ secret: normalizeBase32(seed), algorithm: "SHA1", digits: toInt(size ?? "", 6), period: toInt(period ?? "", 30) }));
  }
  return undefined;
}

/** KeePass 2 / KeePassXC additional URL fields, in order: KP2A_URL, KP2A_URL_1, KP2A_URL_2, ... */
export function additionalUrlFields(names: Iterable<string>): string[] {
  const order = (n: string): number => (n === "KP2A_URL" ? 0 : Number(n.slice("KP2A_URL_".length)) + 1);
  return [...names].filter((n) => n === "KP2A_URL" || /^KP2A_URL_\d+$/.test(n)).sort((a, b) => order(a) - order(b));
}

export interface EntryUrl {
  /** "http:" or "https:" when the entry says so; null when it is a bare host. */
  scheme: "http:" | "https:" | null;
  host: string;
  /** Explicit port, or "" for the scheme default. */
  port: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Parses an entry URL field. Bare hosts ("example.com", "login.example.com/path") are accepted;
 * placeholders ({REF:...}), app URLs and single-label hosts other than localhost are not.
 */
export function parseEntryUrl(raw: string): EntryUrl | null {
  const value = raw.trim();
  if (!value || value.includes("{")) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  let url: URL;
  try {
    url = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || (!host.includes(".") && host !== "localhost" && !host.startsWith("["))) return null;
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  return { scheme: hasScheme ? (url.protocol as "http:" | "https:") : null, host, port: url.port && url.port !== defaultPort ? url.port : "" };
}

/**
 * How well an entry URL fits a page: 3 same scheme + host + port, 2 same host, 1 a subdomain of the
 * entry host, 0 no match. Never sends an https entry to an http page, and only matches subdomains of
 * a real domain (not of an IP address).
 */
export function urlMatchScore(entryUrl: string, pageUrl: string): number {
  const entry = parseEntryUrl(entryUrl);
  if (!entry) return 0;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return 0;
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") return 0;
  if (entry.scheme === "https:" && page.protocol === "http:") return 0;
  const pageHost = page.hostname.toLowerCase();
  const pagePort = page.port && page.port !== (page.protocol === "https:" ? "443" : "80") ? page.port : "";
  if (entry.port !== pagePort) return 0;
  if (pageHost === entry.host) return entry.scheme === page.protocol ? 3 : 2;
  if (!IPV4.test(entry.host) && entry.host !== "localhost" && pageHost.endsWith(`.${entry.host}`)) return 1;
  return 0;
}

/** Best score over all of an entry's URLs. */
export function entryMatchScore(entry: Pick<KeePassEntry, "urls">, pageUrl: string): number {
  let best = 0;
  for (const url of entry.urls) best = Math.max(best, urlMatchScore(url, pageUrl));
  return best;
}

/** A host to show for an entry (first parseable URL), or its title. */
export function entrySite(entry: Pick<KeePassEntry, "urls" | "title">): string {
  for (const url of entry.urls) {
    const parsed = parseEntryUrl(url);
    if (parsed) return parsed.host;
  }
  return entry.title;
}
