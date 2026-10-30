/**
 * Google Authenticator's "Transfer accounts" export: each QR code holds an
 * `otpauth-migration://offline?data=<base64>` link whose data is a MigrationPayload protobuf with a
 * batch of accounts. Decoded here by hand (a few wire types are all it needs), so no protobuf
 * library ships. Pure, no Node or Electron imports; secrets come back as TotpConfig and only the main
 * process ever calls this with real codes.
 */
import { base32Encode, DEFAULT_TOTP_PERIOD, isValidTotpConfig, type TotpAlgorithm, type TotpConfig } from "./totp";

/** Why an account in an export cannot become a 2FA generator in Corvus. */
export type MigrationSkipReason = "hotp" | "md5" | "invalid";

export interface MigrationAccount {
  issuer: string;
  account: string;
  config: TotpConfig;
}

export interface MigrationSkipped {
  issuer: string;
  account: string;
  reason: MigrationSkipReason;
}

/** One QR code of an export: its place in the batch and its accounts. */
export interface MigrationBatch {
  version: number;
  /** How many QR codes the export has (1 when the field is missing). */
  batchSize: number;
  /** 0-based position of this QR code in the export. */
  batchIndex: number;
  /** Same for every QR code of one export. */
  batchId: number;
  accounts: MigrationAccount[];
  skipped: MigrationSkipped[];
}

const MIGRATION_PREFIX = /^otpauth-migration:\/\/offline\/?\?/i;

export function isMigrationUri(text: string): boolean {
  return MIGRATION_PREFIX.test(text.trim());
}

// ------------------------------------------------------------------ protobuf wire format

class Reader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  /** A varint as a number; values past 2^53 lose precision, which no field here needs. */
  varint(): number {
    let result = 0;
    let factor = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.bytes.length) throw new Error("truncated varint");
      const byte = this.bytes[this.pos++]!;
      result += (byte & 0x7f) * factor;
      if ((byte & 0x80) === 0) return result;
      factor *= 128;
    }
    throw new Error("varint too long");
  }

  /** An int32 varint: negative values are sent sign-extended to 10 bytes; the low 32 bits are the value. */
  int32(): number {
    let result = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.bytes.length) throw new Error("truncated varint");
      const byte = this.bytes[this.pos++]!;
      if (i < 5) result |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) return result | 0;
    }
    throw new Error("varint too long");
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.pos + length > this.bytes.length) throw new Error("truncated field");
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.take(8);
    else if (wireType === 2) this.take(this.varint());
    else if (wireType === 5) this.take(4);
    else throw new Error(`unsupported wire type ${wireType}`);
  }

  /** Every field as [number, wire type], leaving the reader on its value. */
  *fields(): Generator<[number, number]> {
    while (!this.done) {
      const key = this.varint();
      yield [Math.floor(key / 8), key % 8];
    }
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

interface RawOtp {
  secret: Uint8Array;
  name: string;
  issuer: string;
  algorithm: number;
  digits: number;
  type: number;
}

function readOtp(bytes: Uint8Array): RawOtp {
  const r = new Reader(bytes);
  const otp: RawOtp = { secret: new Uint8Array(0), name: "", issuer: "", algorithm: 0, digits: 0, type: 0 };
  for (const [field, wire] of r.fields()) {
    if (field === 1 && wire === 2) otp.secret = r.take(r.varint()).slice();
    else if (field === 2 && wire === 2) otp.name = utf8.decode(r.take(r.varint()));
    else if (field === 3 && wire === 2) otp.issuer = utf8.decode(r.take(r.varint()));
    else if (field === 4 && wire === 0) otp.algorithm = r.varint();
    else if (field === 5 && wire === 0) otp.digits = r.varint();
    else if (field === 6 && wire === 0) otp.type = r.varint();
    else r.skip(wire);
  }
  return otp;
}

const ALGORITHMS: Record<number, TotpAlgorithm | "MD5"> = { 0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512", 4: "MD5" };
const DIGITS: Record<number, number> = { 0: 6, 1: 6, 2: 8 };
const TYPE_HOTP = 1;

/** Where a label is cut in two: " - ", " / ", "|", a middle dot, a bullet, en and em dashes, ":". */
const LABEL_SEPARATOR = /\s+[-/]\s+|\s*[|:\u00b7\u2022\u2013\u2014]\s*/g;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sameName = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/** Every way to cut a label in two at a separator, or around a trailing "(...)": [left, right]. */
function labelCuts(label: string): Array<[string, string]> {
  const cuts: Array<[string, string]> = [];
  for (const m of label.matchAll(LABEL_SEPARATOR)) {
    const at = m.index ?? 0;
    const left = label.slice(0, at).trim();
    const right = label.slice(at + m[0].length).trim();
    if (left && right) cuts.push([left, right]);
  }
  const paren = /^(.*?)\s*\(([^()]*)\)$/.exec(label);
  if (paren?.[1]?.trim() && paren[2]?.trim()) cuts.push([paren[1].trim(), paren[2].trim()]);
  return cuts;
}

/**
 * Splits the stored name into issuer and account. Google Authenticator keeps "Issuer:account" when the
 * setup link had a prefix: the prefix is dropped when it repeats the issuer, and becomes the issuer when
 * there is none. Sites also write "Issuer - account" (or with "|", "/", a middle dot, dashes),
 * "Issuer (account)" and "account (Issuer)": the part that repeats the issuer is dropped. Else, when one
 * part is an e-mail address and the other is not, the address is the account (logins are found by it)
 * and the other part is the issuer when there is none.
 */
export function splitAccountName(name: string, issuer: string): { issuer: string; account: string } {
  let cleanIssuer = issuer.trim();
  let account = name.trim();
  const colon = account.indexOf(":");
  if (colon > 0 && !account.startsWith("//", colon + 1)) {
    const prefix = account.slice(0, colon).trim();
    const rest = account.slice(colon + 1).trim();
    if (!cleanIssuer || sameName(prefix, cleanIssuer)) {
      cleanIssuer ||= prefix;
      account = rest;
    }
  }
  const cuts = labelCuts(account);
  for (const [left, right] of cuts) {
    if (cleanIssuer && sameName(left, cleanIssuer)) return { issuer: cleanIssuer, account: right };
    if (cleanIssuer && sameName(right, cleanIssuer)) return { issuer: cleanIssuer, account: left };
  }
  for (const [left, right] of cuts) {
    if (EMAIL.test(right) && !left.includes("@")) return { issuer: cleanIssuer || left, account: right };
    if (EMAIL.test(left) && !right.includes("@")) return { issuer: cleanIssuer || right, account: left };
  }
  return { issuer: cleanIssuer, account };
}

function toAccount(otp: RawOtp): { ok: MigrationAccount } | { skipped: MigrationSkipped } {
  const label = splitAccountName(otp.name, otp.issuer);
  const algorithm = ALGORITHMS[otp.algorithm];
  const digits = DIGITS[otp.digits];
  if (otp.type === TYPE_HOTP) return { skipped: { ...label, reason: "hotp" } };
  if (algorithm === "MD5") return { skipped: { ...label, reason: "md5" } };
  const config: TotpConfig = { secret: base32Encode(otp.secret), algorithm: algorithm ?? "SHA1", digits: digits ?? 6, period: DEFAULT_TOTP_PERIOD };
  if (!algorithm || !digits || otp.type > 2 || otp.secret.length === 0 || !isValidTotpConfig(config)) return { skipped: { ...label, reason: "invalid" } };
  return { ok: { ...label, config } };
}

/** Decodes a MigrationPayload. Throws when the bytes are not one. */
export function decodeMigrationPayload(bytes: Uint8Array): MigrationBatch {
  const r = new Reader(bytes);
  const batch: MigrationBatch = { version: 0, batchSize: 1, batchIndex: 0, batchId: 0, accounts: [], skipped: [] };
  let sawOtp = false;
  for (const [field, wire] of r.fields()) {
    if (field === 1 && wire === 2) {
      sawOtp = true;
      const result = toAccount(readOtp(r.take(r.varint())));
      if ("ok" in result) batch.accounts.push(result.ok);
      else batch.skipped.push(result.skipped);
    } else if (field === 2 && wire === 0) batch.version = r.varint();
    else if (field === 3 && wire === 0) batch.batchSize = Math.max(1, r.varint());
    else if (field === 4 && wire === 0) batch.batchIndex = r.varint();
    else if (field === 5 && wire === 0) batch.batchId = r.int32();
    else r.skip(wire);
  }
  if (!sawOtp && batch.version === 0) throw new Error("No accounts in the export data.");
  if (batch.batchIndex >= batch.batchSize) batch.batchSize = batch.batchIndex + 1;
  return batch;
}

/** Standard or URL-safe base64, with or without padding; spaces count as "+" (a decoded query). */
function base64Bytes(text: string): Uint8Array {
  const clean = text.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) throw new Error("bad base64");
  const binary = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Parses an `otpauth-migration://offline?data=...` link. Throws with a readable message. */
export function parseMigrationUri(uri: string): MigrationBatch {
  const text = uri.trim();
  if (!isMigrationUri(text)) throw new Error("Not a Google Authenticator export code.");
  const match = /[?&]data=([^&#]*)/i.exec(text);
  if (!match?.[1]) throw new Error("The export code has no data.");
  let data: string;
  try {
    data = decodeURIComponent(match[1]);
  } catch {
    throw new Error("The export code is damaged.");
  }
  try {
    return decodeMigrationPayload(base64Bytes(data));
  } catch {
    throw new Error("The export code is damaged.");
  }
}

// ------------------------------------------------------------------ encoder (test codes)

export interface MigrationOtpInput {
  secret: Uint8Array;
  name: string;
  issuer?: string;
  /** Wire values: 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5. */
  algorithm?: number;
  /** Wire values: 1 six digits, 2 eight digits. */
  digits?: number;
  /** Wire values: 1 HOTP, 2 TOTP. */
  type?: number;
  counter?: number;
}

/** Varint bytes; negative values sign-extended to 64 bits, as protobuf sends int32 and int64. */
function varintBytes(value: number): number[] {
  let n = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  while (n >= 128n) {
    out.push(Number(n & 127n) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
}

const textBytes = new TextEncoder();

function lengthDelimited(field: number, bytes: Uint8Array | number[]): number[] {
  return [...varintBytes(field * 8 + 2), ...varintBytes(bytes.length), ...bytes];
}

const varintField = (field: number, value: number): number[] => [...varintBytes(field * 8), ...varintBytes(value)];

/**
 * The inverse of decodeMigrationPayload, as Google Authenticator writes it. Builds the export codes
 * the unit tests and the smoke test import (with made-up secrets).
 */
export function encodeMigrationPayload(otps: MigrationOtpInput[], batch: { batchSize?: number; batchIndex?: number; batchId?: number } = {}): Uint8Array {
  const out: number[] = [];
  for (const otp of otps) {
    const body = [
      ...lengthDelimited(1, otp.secret),
      ...lengthDelimited(2, [...textBytes.encode(otp.name)]),
      ...(otp.issuer ? lengthDelimited(3, [...textBytes.encode(otp.issuer)]) : []),
      ...varintField(4, otp.algorithm ?? 1),
      ...varintField(5, otp.digits ?? 1),
      ...varintField(6, otp.type ?? 2),
      ...(otp.counter ? varintField(7, otp.counter) : []),
    ];
    out.push(...lengthDelimited(1, body));
  }
  out.push(...varintField(2, 1), ...varintField(3, batch.batchSize ?? 1), ...varintField(4, batch.batchIndex ?? 0), ...varintField(5, batch.batchId ?? 0));
  return Uint8Array.from(out);
}

export function migrationUri(payload: Uint8Array): string {
  let binary = "";
  for (const byte of payload) binary += String.fromCharCode(byte);
  return `otpauth-migration://offline?data=${encodeURIComponent(btoa(binary))}`;
}
