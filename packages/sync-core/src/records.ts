import type { EncryptedRecord, SyncCollection, SyncItem } from "@corvus/shared";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, bytesToUtf8, fromBase64, toBase64, utf8ToBytes } from "./encoding.js";
import type { SyncKeys } from "./keys.js";

export const NONCE_LENGTH = 24;

/**
 * Plaintext sealed inside every record, tombstones included. The deleted flag, author device and
 * natural key are authenticated here so the server cannot forge deletes or move payloads between ids.
 */
interface RecordEnvelope {
  v: 1;
  id: string;
  dev: string;
  del: boolean;
  p: unknown;
}

/** Opaque record id: hex(HMAC-SHA256(recordIdKey, collection|naturalKey)). Hides URLs etc. from the server. */
export function recordIdFor(keys: SyncKeys, collection: SyncCollection, naturalKey: string): string {
  return bytesToHex(hmac(sha256, keys.recordIdKey, utf8ToBytes(`${collection}|${naturalKey}`)));
}

export function recordAad(chainId: string, collection: SyncCollection, recordId: string, version: number): Uint8Array {
  return utf8ToBytes(`${chainId}|${collection}|${recordId}|${version}`);
}

export interface PlainRecord {
  collection: SyncCollection;
  /** Natural key known only to clients (bookmark guid, URL, setting name...). */
  naturalId: string;
  version: number;
  deviceId: string;
  deleted: boolean;
  payload: unknown;
}

export function encryptRecord(keys: SyncKeys, record: PlainRecord): EncryptedRecord {
  const id = recordIdFor(keys, record.collection, record.naturalId);
  const envelope: RecordEnvelope = {
    v: 1,
    id: record.naturalId,
    dev: record.deviceId,
    del: record.deleted,
    p: record.deleted ? null : (record.payload ?? null),
  };
  const nonce = randomBytes(NONCE_LENGTH);
  const aad = recordAad(keys.chainId, record.collection, id, record.version);
  const sealed = xchacha20poly1305(keys.dataKey, nonce, aad).encrypt(utf8ToBytes(JSON.stringify(envelope)));
  const ciphertext = new Uint8Array(NONCE_LENGTH + sealed.length);
  ciphertext.set(nonce, 0);
  ciphertext.set(sealed, NONCE_LENGTH);
  return {
    id,
    collection: record.collection,
    version: record.version,
    deviceId: record.deviceId,
    deleted: record.deleted,
    ciphertext: toBase64(ciphertext),
    updatedAt: 0,
  };
}

/** Throws if the ciphertext was tampered with, belongs to another chain, or its metadata was altered. */
export function decryptRecord(keys: SyncKeys, record: EncryptedRecord): SyncItem {
  const raw = fromBase64(record.ciphertext);
  if (raw.length <= NONCE_LENGTH) throw new Error("Ciphertext too short");
  const aad = recordAad(keys.chainId, record.collection, record.id, record.version);
  const plain = xchacha20poly1305(keys.dataKey, raw.subarray(0, NONCE_LENGTH), aad).decrypt(raw.subarray(NONCE_LENGTH));
  const env = JSON.parse(bytesToUtf8(plain)) as RecordEnvelope;
  if (env.v !== 1 || typeof env.id !== "string" || typeof env.dev !== "string" || typeof env.del !== "boolean") {
    throw new Error("Malformed record envelope");
  }
  if (env.del !== record.deleted || env.dev !== record.deviceId) throw new Error("Record metadata mismatch");
  if (recordIdFor(keys, record.collection, env.id) !== record.id) throw new Error("Record id mismatch");
  return { collection: record.collection, id: env.id, payload: env.del ? null : env.p, deleted: env.del };
}
