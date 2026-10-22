import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, fromBase64, toBase64, utf8ToBytes } from "./encoding.js";
import type { SyncKeys } from "./keys.js";

export const AUTH_SCHEME = "Corvus-Sig";

export const CHAIN_ID_RE = /^[0-9a-f]{32}$/;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const TS_RE = /^\d{1,16}$/;

export interface AuthHeader {
  chain: string;
  device: string;
  ts: number;
  nonce: string;
  sig: Uint8Array;
}

/**
 * Canonical string covered by the signature:
 *   METHOD \n path-with-query \n ts \n nonce \n hex(sha256(body))
 * The nonce makes otherwise identical requests in the same millisecond distinguishable,
 * so the server can reject any repeated signature as a replay.
 */
export function signingMessage(method: string, path: string, ts: number, nonce: string, body: Uint8Array): Uint8Array {
  return utf8ToBytes(`${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bytesToHex(sha256(body))}`);
}

export interface SignRequestInput {
  method: string;
  /** Path relative to the API root, including the query string, e.g. `/v1/chains/x/records?since=0`. */
  path: string;
  body?: Uint8Array;
  ts?: number;
  nonce?: string;
}

export function signRequest(keys: SyncKeys, deviceId: string, input: SignRequestInput): string {
  const ts = input.ts ?? Date.now();
  const nonce = input.nonce ?? bytesToHex(randomBytes(16));
  const message = signingMessage(input.method, input.path, ts, nonce, input.body ?? new Uint8Array());
  const sig = toBase64(ed25519.sign(message, keys.authSecretKey));
  return `${AUTH_SCHEME} chain=${keys.chainId},device=${deviceId},ts=${ts},nonce=${nonce},sig=${sig}`;
}

export function parseAuthHeader(header: string): AuthHeader | null {
  const prefix = `${AUTH_SCHEME} `;
  if (!header.startsWith(prefix) || header.length > 512) return null;
  const fields = new Map<string, string>();
  for (const part of header.slice(prefix.length).split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim();
    if (fields.has(key)) return null;
    fields.set(key, part.slice(eq + 1).trim());
  }
  const chain = fields.get("chain");
  const device = fields.get("device");
  const ts = fields.get("ts");
  const nonce = fields.get("nonce");
  const sig = fields.get("sig");
  if (fields.size !== 5 || !chain || !device || !ts || !nonce || !sig) return null;
  if (!CHAIN_ID_RE.test(chain) || !DEVICE_ID_RE.test(device) || !TS_RE.test(ts) || !NONCE_RE.test(nonce)) return null;
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64(sig);
  } catch {
    return null;
  }
  if (sigBytes.length !== 64) return null;
  return { chain, device, ts: Number(ts), nonce, sig: sigBytes };
}

export function verifyRequestSignature(
  publicKey: Uint8Array,
  auth: AuthHeader,
  method: string,
  path: string,
  body: Uint8Array,
): boolean {
  try {
    return ed25519.verify(auth.sig, signingMessage(method, path, auth.ts, auth.nonce, body), publicKey);
  } catch {
    return false;
  }
}
