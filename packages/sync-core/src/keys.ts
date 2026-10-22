import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "./encoding.js";
import { recoveryPhraseToSeed } from "./phrase.js";

export const HKDF_INFO_AUTH = "corvus-sync-auth-v1";
export const HKDF_INFO_DATA = "corvus-sync-data-v1";
export const HKDF_INFO_RECORD_ID = "corvus-sync-record-id-v1";

export interface SyncKeys {
  chainId: string;
  /** Ed25519 32-byte secret seed. */
  authSecretKey: Uint8Array;
  authPublicKey: Uint8Array;
  /** XChaCha20-Poly1305 key for record payloads. */
  dataKey: Uint8Array;
  /** HMAC-SHA256 key for opaque record ids. */
  recordIdKey: Uint8Array;
}

export function chainIdFromPublicKey(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey)).slice(0, 32);
}

export function deriveKeysFromSeed(seed: Uint8Array): SyncKeys {
  const derive = (info: string) => hkdf(sha256, seed, undefined, utf8ToBytes(info), 32);
  const authSecretKey = derive(HKDF_INFO_AUTH);
  const authPublicKey = ed25519.getPublicKey(authSecretKey);
  return {
    chainId: chainIdFromPublicKey(authPublicKey),
    authSecretKey,
    authPublicKey,
    dataKey: derive(HKDF_INFO_DATA),
    recordIdKey: derive(HKDF_INFO_RECORD_ID),
  };
}

export function deriveKeys(phrase: string): SyncKeys {
  return deriveKeysFromSeed(recoveryPhraseToSeed(phrase));
}
