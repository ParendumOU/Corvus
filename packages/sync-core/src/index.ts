export { generateRecoveryPhrase, validateRecoveryPhrase, normalizeRecoveryPhrase, RECOVERY_PHRASE_WORDS } from "./phrase.js";
export {
  deriveKeys,
  deriveKeysFromSeed,
  chainIdFromPublicKey,
  HKDF_INFO_AUTH,
  HKDF_INFO_DATA,
  HKDF_INFO_RECORD_ID,
  type SyncKeys,
} from "./keys.js";
export { encryptRecord, decryptRecord, recordIdFor, recordAad, NONCE_LENGTH, type PlainRecord } from "./records.js";
export {
  AUTH_SCHEME,
  CHAIN_ID_RE,
  DEVICE_ID_RE,
  signRequest,
  signingMessage,
  parseAuthHeader,
  verifyRequestSignature,
  type AuthHeader,
  type SignRequestInput,
} from "./signing.js";
export {
  createSyncClient,
  isNewer,
  SyncError,
  type CorvusSyncClient,
  type CorvusSyncClientOptions,
} from "./client.js";
export { SyncEngine, fingerprint, type SyncAdapter, type SyncEngineOptions, type SyncCycleResult, type LocalItem } from "./engine.js";
export { SYNC_COLLECTIONS, isSyncCollection, isBase64, toBase64, fromBase64 } from "./encoding.js";
export { generateVaultKey, sealSecret, openSecret, VAULT_KEY_LENGTH } from "./vault.js";
