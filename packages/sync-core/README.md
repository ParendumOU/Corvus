# @corvus/sync-core

End-to-end encrypted sync client for Corvus. Runs in Node / the Electron main process.
All key material is derived from a 24-word BIP39 recovery phrase; the sync server only ever
receives ciphertext and opaque identifiers.

```ts
import { createSyncClient, generateRecoveryPhrase, SyncEngine } from "@corvus/sync-core";

const phrase = generateRecoveryPhrase(); // show once, user writes it down
const client = createSyncClient({ serverUrl, phrase, deviceName: "Laptop", platform: "win32", storage });
await client.register(); // creates the chain if new, registers this device (idempotent)

const engine = new SyncEngine({ client, storage, adapters: { bookmarks: bookmarkAdapter } });
await engine.sync(); // pull -> apply -> push dirty items and deletions
```

## Crypto scheme

| Step | Construction |
| --- | --- |
| Phrase | 256 bits CSPRNG entropy -> 24 English BIP39 words (`@scure/bip39`). Input is normalized (NFKD, lower case, single spaces) and must be exactly 24 words with a valid checksum. |
| Seed | `seed = BIP39 mnemonicToSeed(phrase, passphrase = "")` (PBKDF2-HMAC-SHA512, 2048 rounds, 64 bytes). |
| Auth key | `authSeed = HKDF-SHA256(ikm = seed, salt = none, info = "corvus-sync-auth-v1", L = 32)`; Ed25519 key pair from `authSeed`. |
| Data key | `dataKey = HKDF-SHA256(seed, info = "corvus-sync-data-v1", L = 32)`; XChaCha20-Poly1305 key. |
| Record-id key | `recordIdKey = HKDF-SHA256(seed, info = "corvus-sync-record-id-v1", L = 32)`; a separate HMAC key so the AEAD key is never reused in another primitive. |
| Chain id | `chainId = hex(sha256(authPublicKey))[0..32]` (128 bits). |
| Record id | `hex(HMAC-SHA256(recordIdKey, collection + "|" + naturalKey))`. Applied to every collection, so URLs, bookmark GUIDs and setting names never reach the server. |
| Record body | `base64(nonce24 || XChaCha20-Poly1305(dataKey, nonce24, AAD, plaintext))`, fresh random nonce per encryption. `AAD = chainId|collection|recordId|version`. |
| Plaintext | JSON envelope `{v:1, id: naturalKey, dev: deviceId, del: deleted, p: payload}`. Tombstones are encrypted too, so the server cannot forge deletes. On decrypt the client also checks that `del`/`dev` match the record metadata and that `recordId` re-derives from `id`. |
| Requests | Header `Authorization: Corvus-Sig chain=<chainId>,device=<deviceId>,ts=<ms>,nonce=<hex16>,sig=<base64>`; `sig = Ed25519(authKey, METHOD\npath?query\nts\nnonce\nhex(sha256(body)))`. `path` is relative to the API root (`/v1/...`), so a reverse proxy may mount the server under a prefix as long as it strips it. |

Libraries: `@noble/hashes` (SHA-256, HKDF, HMAC), `@noble/ciphers` (XChaCha20-Poly1305), `@noble/curves`
(Ed25519), `@scure/bip39`. No primitive is implemented here. `test/crypto.test.ts` pins a test vector for the
phrase `abandon x23 art` and cross-checks the derivation (PBKDF2, HKDF, Ed25519) against `node:crypto`.

## Sync semantics

- Every record carries a per-record Lamport `version`: a local write uses `knownVersion + 1`, where the known
  version is the highest seen locally (own pushes, pulls, conflicts). Persisted per collection in `storage`.
- Last-writer-wins: higher `version` wins, equal versions fall back to the higher `deviceId`. The server enforces the
  same order; a rejected write comes back as a conflict carrying the stored (winning) record, which `push()`
  decrypts and returns so the caller can apply it.
- `pull()` pages until `hasMore === false` and persists the server cursor after each page. `pullPages(onPage)`
  persists only after `onPage` resolves (at-least-once delivery); `SyncEngine` uses it.
- Remote records that fail authentication are skipped and reported through `onInvalidRecord`.
- `wipeChain()` deletes everything server-side and resets the local cursor/versions. Call `engine.reset()` too.

### SyncEngine

Adapters expose `list()` (all live local items) and `apply(items)` (upserts + tombstones; must tolerate tombstones
for ids it does not have). The engine stores a fingerprint (sha256 of canonical JSON) of the last synced payload per
item; items whose fingerprint changed are pushed, items that disappeared from `list()` are pushed as tombstones.
Remote changes are applied before local changes are diffed, so a remote edit that is newer by version overwrites an
unsynced local edit of the same item (LWW).

After `apply()` the engine calls `list()` once more: a remote upsert the adapter declined to keep (failed validation,
fell outside a local cap, a setting this version does not know) is forgotten rather than recorded as synced, so it is
never pushed back as a deletion and other devices keep it. If the adapter keeps a different payload than the remote
one (e.g. a local edit with a newer timestamp, or a merge), the local payload is pushed on the next diff.

### Storage keys

All keys are namespaced `corvus-sync/<chainId>/...`: `deviceId`, `cursor`, `versions/<collection>` (JSON),
`engine/<collection>` (JSON fingerprints). Switching phrases therefore never mixes state.

## Threat model

The server (or anyone who dumps its database or sniffs TLS-terminated traffic) **can see**: chain ids, device ids,
device names and platforms (sent in clear for the device list), record ids (keyed HMACs, stable per item), collection
names, record versions, ciphertext sizes, tombstone flags, timestamps, request IPs and access patterns.

It **cannot**: read payloads (titles, URLs, settings, history), learn natural keys behind record ids, forge or modify
records undetected (AEAD + AAD binding, authenticated tombstones), move ciphertext between records/chains/versions,
or sign requests for a chain (needs the phrase).

It **can still**: withhold, delay or delete data, serve a stale snapshot (rollback to older versions is ignored by
clients that already saw newer ones, but a fresh device would accept it), and refuse service.

Anyone holding the phrase is a full member of the chain: removing a device revokes that device id, but a holder of
the phrase can register again under a new id. To truly revoke, create a new chain with a new phrase and wipe the old one.

**The phrase is the only key. If it is lost, the synced data cannot be recovered by anyone, including the server
operator.** Devices that are still signed in keep their local copy and can start a new chain.
