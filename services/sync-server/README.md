# @corvus/sync-server

Self-hostable sync server for Corvus. Fastify + SQLite (WAL). It stores only what clients send: opaque record ids,
versions and XChaCha20-Poly1305 ciphertext. It never has, and cannot derive, any decryption key. See
[`@corvus/sync-core`](../../packages/sync-core/README.md) for the crypto scheme.

## Run

```sh
docker compose build sync-server && docker compose up -d sync-server   # http://localhost:8787
curl http://localhost:8787/healthz                                       # {"ok":true}
```

The image is multi-stage (build on `node:22-bookworm`, run on `node:22-bookworm-slim`), runs as user `node`,
keeps the database in the `/data` volume and has a `HEALTHCHECK` on `/healthz`.

| Env | Default | |
| --- | --- | --- |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `CORVUS_SYNC_DB` | `./data/sync.db` (`/data/sync.db` in Docker) | SQLite file |
| `CORVUS_SYNC_MAX_RECORDS` | `50000` | records per chain (tombstones included) |
| `CORVUS_SYNC_MAX_BYTES` | `52428800` | ciphertext bytes per chain |
| `CORVUS_SYNC_MAX_DEVICES` | `50` | active devices per chain |
| `CORVUS_SYNC_RATE_IP` | `600` | requests per minute per IP |
| `CORVUS_SYNC_RATE_CHAIN` | `1200` | authenticated requests per minute per chain |
| `CORVUS_SYNC_TRUST_PROXY` | `0` | `1` to take the client IP from `X-Forwarded-For` |
| `LOG_LEVEL` | `info` | |

Put it behind TLS (reverse proxy) for anything beyond localhost. Smoke test against a running instance:
`docker compose run --rm dev sh -c "pnpm -r build && pnpm --filter @corvus/sync-server smoke"`
(uses `CORVUS_SYNC_URL`, which the dev container sets to `http://sync-server:8787`).

## API (`/v1`, see `packages/shared/src/sync.ts`)

| Route | Auth | |
| --- | --- | --- |
| `POST /v1/chains` `{chainId, publicKey}` | signed with the key in the body | `201` created, `200` exists. `chainId` must equal `hex(sha256(publicKey))[0..32]`. |
| `POST /v1/chains/:id/devices` `{id, name, platform}` | chain key; device need not exist | `201`/`200`. `id` must equal the header `device`. Removed ids are refused. |
| `GET /v1/chains/:id/devices` | registered device | `{devices: DeviceInfo[]}` |
| `DELETE /v1/chains/:id/devices/:deviceId` | registered device | `204`; the id stays revoked. |
| `POST /v1/chains/:id/records` `SyncPushRequest` | registered device | `SyncPushResponse`. Max 1000 records; each record's `deviceId` must be the signing device. |
| `GET /v1/chains/:id/records?since=&collection=` | registered device | `SyncPullResponse`, 500 per page, ordered by server sequence. |
| `DELETE /v1/chains/:id` | registered device | `204`; deletes chain, devices and records. |
| `GET /healthz` | none | `{ok: true}` |

Errors are `{error, message}` with stable codes: `unauthorized`, `clock_skew`, `bad_signature`, `replayed`,
`chain_mismatch`, `chain_not_found`, `device_not_registered`, `device_removed`, `invalid_request`, `invalid_chain`,
`quota_exceeded` (413), `payload_too_large` (413), `rate_limited` (429 + `Retry-After`).

### Request authentication

Every `/v1` request carries `Authorization: Corvus-Sig chain=..,device=..,ts=..,nonce=..,sig=..`. The server:

1. rejects `|now - ts| > 5 min`;
2. verifies the Ed25519 signature over `METHOD\npath?query\nts\nnonce\nhex(sha256(raw body))` with the chain's
   registered public key (or, for chain creation, the key in the body after checking it hashes to `chainId`);
3. rejects any signature seen in the last 10 minutes (replay cache; the nonce keeps legitimate identical requests
   distinct);
4. requires the device to be registered and not removed (except chain creation and device registration);
5. applies per-IP (before auth) and per-chain (after auth) fixed-window rate limits. Bodies over 2 MB get `413`.

### Storage and conflict rules

Tables `chains`, `devices`, `records` (PK `(chain_id, collection, id)`), and a global `seq` counter; each accepted
write gets the next sequence number, which is the pull cursor. Migrations are versioned with `PRAGMA user_version`.

A pushed record replaces the stored one iff `version` is higher, or equal with a higher `deviceId`. An exact re-push
of the stored revision is accepted idempotently. Anything else is returned in `conflicts` with the stored record.
A push that would grow a chain past its quota is rolled back as a whole.

The server never logs ciphertext, request bodies or auth headers: request logs contain method, URL (chain id, cursor),
status and remote address only.

## Threat model

What the operator can and cannot see is described in the
[sync-core README](../../packages/sync-core/README.md#threat-model). In short: metadata (ids, sizes, timing, device
names, IPs) is visible; content is not, and cannot be modified undetected. The operator can delete or withhold data.
The server holds no keys: **if a user loses their recovery phrase, their synced data is unrecoverable**.

Replay cache and rate limits are in memory, so run a single instance per database.
