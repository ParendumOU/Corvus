/**
 * Symmetric vault sealing, used by the desktop credential vault to keep secrets encrypted at rest.
 * Reuses the exact AEAD primitive the sync records use (XChaCha20-Poly1305, 24-byte random nonce
 * prepended to the ciphertext) so there is a single encryption construction in the codebase. The key
 * here is a device-local random key (wrapped by the OS keychain), independent of the phrase-derived
 * sync data key: at-rest protection and cross-device sync are separate concerns.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { fromBase64, toBase64 } from "./encoding.js";

export const VAULT_KEY_LENGTH = 32;
const VAULT_NONCE_LENGTH = 24;

/** A fresh random 256-bit vault key. */
export function generateVaultKey(): Uint8Array {
  return randomBytes(VAULT_KEY_LENGTH);
}

/**
 * Seal a UTF-8 string. Returns base64(nonce || ciphertext). `aad` (e.g. a record id) is authenticated
 * but not encrypted, so a sealed blob cannot be moved to a different id without the open failing.
 */
export function sealSecret(key: Uint8Array, plaintext: string, aad?: string): string {
  if (key.length !== VAULT_KEY_LENGTH) throw new Error("Invalid vault key length");
  const nonce = randomBytes(VAULT_NONCE_LENGTH);
  const extra = aad === undefined ? undefined : new TextEncoder().encode(aad);
  const sealed = xchacha20poly1305(key, nonce, extra).encrypt(new TextEncoder().encode(plaintext));
  const out = new Uint8Array(VAULT_NONCE_LENGTH + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, VAULT_NONCE_LENGTH);
  return toBase64(out);
}

/** Open a blob produced by {@link sealSecret}. Throws if the key, aad or ciphertext do not match. */
export function openSecret(key: Uint8Array, sealed: string, aad?: string): string {
  if (key.length !== VAULT_KEY_LENGTH) throw new Error("Invalid vault key length");
  const raw = fromBase64(sealed);
  if (raw.length <= VAULT_NONCE_LENGTH) throw new Error("Vault ciphertext too short");
  const extra = aad === undefined ? undefined : new TextEncoder().encode(aad);
  const plain = xchacha20poly1305(key, raw.subarray(0, VAULT_NONCE_LENGTH), extra).decrypt(raw.subarray(VAULT_NONCE_LENGTH));
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}
