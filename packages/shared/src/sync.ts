/**
 * Sync protocol (Brave-Sync-like, end-to-end encrypted).
 *
 * - A "sync chain" is created on one device and identified by a 24-word BIP39 recovery phrase.
 * - From the phrase we derive (HKDF-SHA256): an auth key pair (Ed25519) and a data key (XChaCha20-Poly1305).
 * - The server only sees chainId (= hash of auth public key), device ids, record ids, timestamps and ciphertext.
 * - Records are last-writer-wins by (version, deviceId); deletes are tombstones.
 */

export type SyncCollection =
  | "bookmarks"
  | "history"
  | "settings"
  | "open_tabs"
  | "profiles"
  | "extensions"
  | "credentials"
  | "reading"
  | "watches"
  | "workspaces"
  | "annotations"
  | "workflows"
  | "site_memory"
  | "sent_tabs"
  | "watch_status"
  | "asks"
  | "command_history"
  | "assist_history"
  | "chain_server";

export interface EncryptedRecord {
  id: string; // random, opaque
  collection: SyncCollection;
  version: number; // monotonic per record (Lamport)
  deviceId: string;
  deleted: boolean;
  /**
   * base64(nonce || ciphertext) of JSON payload. Tombstones also carry an (encrypted) envelope so the
   * deleted flag is authenticated and the server cannot forge deletes.
   */
  ciphertext: string;
  updatedAt: number; // server-assigned ms timestamp
}

export interface SyncPushRequest { records: EncryptedRecord[] }
export interface SyncPushResponse { accepted: string[]; conflicts: EncryptedRecord[]; serverTime: number }
export interface SyncPullResponse { records: EncryptedRecord[]; cursor: number; hasMore: boolean }

export interface DeviceInfo { id: string; name: string; platform: string; lastSeen: number }

/** POST /v1/chains body. publicKey = base64 Ed25519 auth public key; chainId must equal hex(sha256(publicKey))[0..32]. */
export interface SyncRegisterChainRequest { chainId: string; publicKey: string }
/** POST /v1/chains/:chainId/devices body. id must equal the `device` field of the auth header. */
export interface SyncRegisterDeviceRequest { id: string; name: string; platform: string }
/** GET /v1/chains/:chainId/devices response (removed devices are not listed). `serverTime`: the server's clock when it answered (newer servers), so clients put `lastSeen` on their own clock. */
export interface SyncDeviceListResponse { devices: DeviceInfo[]; serverTime?: number }
/** Body of every non-2xx response. `error` is a stable machine-readable code. */
export interface SyncErrorResponse { error: string; message: string }

/**
 * HTTP API (all routes under /v1; auth via signed requests):
 *   POST /v1/chains                 register chain {chainId, publicKey}
 *   POST /v1/chains/:chainId/devices register device
 *   GET  /v1/chains/:chainId/devices
 *   DELETE /v1/chains/:chainId/devices/:deviceId
 *   POST /v1/chains/:chainId/records       SyncPushRequest -> SyncPushResponse
 *   GET  /v1/chains/:chainId/records?since=<cursor>&collection=<c> -> SyncPullResponse
 *   DELETE /v1/chains/:chainId             wipe chain
 * Auth header: `Corvus-Sig chain=<chainId>,device=<deviceId>,ts=<ms>,nonce=<hex16>,sig=<base64 ed25519(method\npath\nts\nnonce\nsha256(body))>`
 * Server rejects |now - ts| > 5 min and replayed signatures.
 * Clarifications: `path` is relative to the API root and includes the query string (e.g. `/v1/chains/x/records?since=0`);
 * sha256(body) is lowercase hex, of the empty byte string when there is no body; `nonce` is 16 random bytes in hex,
 * so identical requests sent within the same millisecond still have distinct signatures.
 */
export const SYNC_API_VERSION = "v1";
