/**
 * The cryptography of the profile lock (see profile-lock.ts), Node only so it unit-tests freely.
 *
 * A locked profile's secrets are opened by a random 32-byte lock key. Each way to unlock keeps its own
 * copy of that key, sealed with AES-256-GCM under a key-encrypting key: from the PIN or password
 * (scrypt, mixed with a pepper the system keychain keeps, so guessing offline also needs the Windows
 * account), or from a security key's or Windows Hello's PRF output (HKDF). WebAuthn assertions are
 * checked here too: the signature over the authenticator data and the client data, the challenge,
 * the origin and the relying party.
 */
import crypto from "node:crypto";
import { promisify } from "node:util";
import { tr } from "./menu-i18n";

const scrypt = promisify(crypto.scrypt) as (password: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number, options: crypto.ScryptOptions) => Promise<Buffer>;

export const LOCK_KEY_BYTES = 32;

/** scrypt cost for a PIN or password: about a fifth of a second here, 64 MiB of memory. */
export const LOCK_SCRYPT = { N: 1 << 16, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export function randomKey(bytes = LOCK_KEY_BYTES): Buffer {
  return crypto.randomBytes(bytes);
}

export function seal(key: Buffer, plain: Buffer, aad: string): Sealed {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** Throws when the key is not the one it was sealed with (or anything was changed). */
export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]);
}

export function isSealed(value: unknown): value is Sealed {
  const v = value as Partial<Sealed> | null;
  return typeof v?.iv === "string" && typeof v.tag === "string" && typeof v.data === "string";
}

/** The key that seals the lock key's copy for a PIN or password. Runs off the main thread. */
export async function secretKek(secret: string, salt: Buffer, params: ScryptParams, pepper: Buffer): Promise<Buffer> {
  const stretched = await scrypt(secret.normalize("NFKC"), salt, 32, { ...params, maxmem: SCRYPT_MAXMEM });
  try {
    return crypto.createHmac("sha256", pepper).update(stretched).digest();
  } finally {
    stretched.fill(0);
  }
}

/** The key that seals the lock key's copy for an authenticator, from its PRF output. */
export function prfKek(prfOutput: Buffer, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", prfOutput, salt, Buffer.from("corvus profile lock prf v1", "utf8"), 32));
}

export function b64url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

/** What a WebAuthn ceremony returned, as the page hands it over (base64url fields). */
export interface AssertionResult {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  /** The PRF output for the salt asked, when the authenticator gave one. */
  prf?: string;
}

export interface Expected {
  challenge: Buffer;
  origin: string;
  rpId: string;
  type: "webauthn.get" | "webauthn.create";
}

/** Checks the client data of a ceremony: its type, challenge and origin. Throws on a mismatch. */
export function checkClientData(clientDataJSON: Buffer, expected: Expected): void {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(clientDataJSON.toString("utf8")) as typeof data;
  } catch {
    throw new Error(tr("The authenticator's answer could not be read."));
  }
  if (data.type !== expected.type) throw new Error(tr("The authenticator answered another request."));
  if (typeof data.challenge !== "string" || !crypto.timingSafeEqual(fromB64url(data.challenge), expected.challenge)) {
    throw new Error(tr("The authenticator answered another request."));
  }
  if (data.origin !== expected.origin || data.crossOrigin === true) throw new Error(tr("The authenticator answered another site."));
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/** The authenticator data's relying party, flags and signature counter. Throws when it is not ours. */
export function checkAuthenticatorData(authData: Buffer, rpId: string, requireVerified: boolean): { signCount: number } {
  if (authData.length < 37) throw new Error(tr("The authenticator's answer could not be read."));
  const rpIdHash = crypto.createHash("sha256").update(rpId, "utf8").digest();
  if (!crypto.timingSafeEqual(authData.subarray(0, 32), rpIdHash)) throw new Error(tr("The authenticator answered another site."));
  const flags = authData[32]!;
  if (!(flags & FLAG_USER_PRESENT)) throw new Error(tr("The authenticator was not touched."));
  if (requireVerified && !(flags & FLAG_USER_VERIFIED)) throw new Error(tr("The authenticator did not check it is you."));
  return { signCount: authData.readUInt32BE(33) };
}

/** COSE algorithm ids WebAuthn credentials use, and how Node checks their signatures. */
export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const COSE_RS256 = -257;
export const SUPPORTED_COSE = [COSE_ES256, COSE_EDDSA, COSE_RS256] as const;

/** Verifies an assertion's signature with the credential's public key (SPKI DER, base64url). */
export function verifySignature(publicKey: string, algorithm: number, authData: Buffer, clientDataJSON: Buffer, signature: Buffer): boolean {
  const key = crypto.createPublicKey({ key: fromB64url(publicKey), format: "der", type: "spki" });
  const signed = Buffer.concat([authData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
  switch (algorithm) {
    case COSE_ES256:
      return crypto.verify("sha256", signed, { key, dsaEncoding: "der" }, signature);
    case COSE_RS256:
      return crypto.verify("sha256", signed, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
    case COSE_EDDSA:
      return crypto.verify(null, signed, key, signature);
    default:
      return false;
  }
}

export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
}

/**
 * Checks a whole assertion against a stored credential: client data, authenticator data and
 * signature, and a signature counter that went forward (a cloned key would repeat it). Returns the
 * new counter. Throws with a message for the person on any mismatch.
 */
export function verifyAssertion(result: AssertionResult, credential: StoredCredential, expected: Expected, requireVerified: boolean): number {
  if (result.credentialId !== credential.credentialId) throw new Error(tr("That authenticator is not one of this profile's."));
  const clientData = fromB64url(result.clientDataJSON);
  const authData = fromB64url(result.authenticatorData);
  checkClientData(clientData, expected);
  const { signCount } = checkAuthenticatorData(authData, expected.rpId, requireVerified);
  if (!verifySignature(credential.publicKey, credential.algorithm, authData, clientData, fromB64url(result.signature))) {
    throw new Error(tr("The authenticator's signature is not valid."));
  }
  if (signCount !== 0 && credential.signCount !== 0 && signCount <= credential.signCount) throw new Error(tr("That authenticator may have been copied."));
  return signCount;
}
