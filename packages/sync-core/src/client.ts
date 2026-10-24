import type {
  DeviceInfo,
  EncryptedRecord,
  SyncClient,
  SyncClientOptions,
  SyncCollection,
  SyncDeviceListResponse,
  SyncErrorResponse,
  SyncItem,
  SyncPullResponse,
  SyncPushResponse,
  SyncRegisterChainRequest,
  SyncRegisterDeviceRequest,
} from "@corvus/shared";
import { randomBytes } from "@noble/hashes/utils.js";
import { SYNC_COLLECTIONS, bytesToHex, toBase64, utf8ToBytes } from "./encoding.js";
import { deriveKeys, type SyncKeys } from "./keys.js";
import { decryptRecord, encryptRecord, recordIdFor } from "./records.js";
import { signRequest } from "./signing.js";

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export interface CorvusSyncClientOptions extends SyncClientOptions {
  /** Called for remote records that fail authentication/decryption; they are skipped. */
  onInvalidRecord?: (record: EncryptedRecord, error: unknown) => void;
}

export interface CorvusSyncClient extends SyncClient {
  getDeviceId(): Promise<string>;
  /** Change this device's display name on the chain (re-registers the device with the new name). */
  renameDevice(name: string): Promise<void>;
  /**
   * Pull with at-least-once delivery: each decrypted page is handed to `onPage` and the cursor and
   * known versions are persisted only after it resolves. Returns the number of items delivered.
   */
  pullPages(onPage: (items: SyncItem[]) => Promise<void> | void): Promise<number>;
  /** Forget cursor and known record versions (next pull starts from scratch). Keeps the device id. */
  resetLocalState(): Promise<void>;
  /** Persisted pull cursor; 0 means this device has not pulled anything from the chain yet. */
  cursor(): Promise<number>;
  /**
   * Collections the server rejected as unknown (an older server). They are left out of pushes and
   * collection pulls for the rest of this client's life; a restart tries again.
   */
  unsupported(): ReadonlySet<SyncCollection>;
  /** Forget the known record versions of one collection, so its next pull re-delivers every record. */
  forgetCollection(collection: SyncCollection): Promise<void>;
  /**
   * Pull every record of one collection from the start (server-side filter), without moving the
   * main cursor. Used when a collection joins an existing chain on this device. At-least-once like
   * pullPages. Resolves to 0 without throwing when the server does not know the collection.
   */
  pullCollection(collection: SyncCollection, onPage: (items: SyncItem[]) => Promise<void> | void): Promise<number>;
  /**
   * Whether the chain has records of `collection` newer than this device's cursor that it has not
   * seen. Moves nothing: a cheap check before a full sync (e.g. for pages sent to this device).
   * False when the server does not know the collection.
   */
  hasNew(collection: SyncCollection): Promise<boolean>;
}

/** [version, deviceId] of the newest revision this device knows for a record. */
type KnownVersion = [number, string];

const MAX_BATCH_RECORDS = 500;
const MAX_BATCH_BYTES = 1_500_000;

/**
 * The collection an older server refused in a push batch. Its zod validation answers 400
 * `invalid_request` with the path of the first bad field, e.g. `records.3.collection: Invalid enum`.
 */
function rejectedCollection(err: unknown, batch: readonly EncryptedRecord[]): SyncCollection | null {
  if (!(err instanceof SyncError) || err.status !== 400 || err.code !== "invalid_request") return null;
  const match = /^records\.(\d+)\.collection\b/.exec(err.message);
  return match ? (batch[Number(match[1])]?.collection ?? null) : null;
}

/** A pull filtered by a collection the server does not know (`collection: Invalid enum ...`). */
function rejectedCollectionFilter(err: unknown): boolean {
  return err instanceof SyncError && err.status === 400 && err.code === "invalid_request" && /^collection\b/.test(err.message);
}

/** LWW order: higher version wins; equal versions fall back to the higher deviceId. */
export function isNewer(version: number, deviceId: string, than: KnownVersion | undefined): boolean {
  if (!than) return true;
  return version > than[0] || (version === than[0] && deviceId > than[1]);
}

export function createSyncClient(opts: CorvusSyncClientOptions): CorvusSyncClient {
  const keys: SyncKeys = deriveKeys(opts.phrase);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const baseUrl = opts.serverUrl.replace(/\/+$/, "");
  const chainPath = `/v1/chains/${keys.chainId}`;
  const storageKey = (suffix: string) => `corvus-sync/${keys.chainId}/${suffix}`;

  let deviceIdPromise: Promise<string> | undefined;
  const versionCache = new Map<SyncCollection, Map<string, KnownVersion>>();
  const unsupported = new Set<SyncCollection>();

  function getDeviceId(): Promise<string> {
    deviceIdPromise ??= (async () => {
      const stored = await opts.storage.get(storageKey("deviceId"));
      if (stored) return stored;
      const id = bytesToHex(randomBytes(16));
      await opts.storage.set(storageKey("deviceId"), id);
      return id;
    })();
    return deviceIdPromise;
  }

  async function versions(collection: SyncCollection): Promise<Map<string, KnownVersion>> {
    let map = versionCache.get(collection);
    if (!map) {
      const raw = await opts.storage.get(storageKey(`versions/${collection}`));
      map = new Map(raw ? (Object.entries(JSON.parse(raw)) as [string, KnownVersion][]) : []);
      versionCache.set(collection, map);
    }
    return map;
  }

  async function saveVersions(collections: Iterable<SyncCollection>): Promise<void> {
    for (const collection of new Set(collections)) {
      const map = await versions(collection);
      await opts.storage.set(storageKey(`versions/${collection}`), JSON.stringify(Object.fromEntries(map)));
    }
  }

  async function request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const deviceId = await getDeviceId();
    const body = payload === undefined ? undefined : utf8ToBytes(JSON.stringify(payload));
    const headers: Record<string, string> = {
      authorization: signRequest(keys, deviceId, { method, path, body }),
    };
    if (body) headers["content-type"] = "application/json";
    const res = await fetchImpl(baseUrl + path, { method, headers, body });
    if (!res.ok) {
      let err: Partial<SyncErrorResponse> = {};
      try {
        err = (await res.json()) as SyncErrorResponse;
      } catch {
        // non-JSON error body (proxy page etc.)
      }
      throw new SyncError(err.message ?? `Sync request failed with HTTP ${res.status}`, res.status, err.error ?? "http_error");
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  function tryDecrypt(record: EncryptedRecord): SyncItem | undefined {
    try {
      return decryptRecord(keys, record);
    } catch (error) {
      opts.onInvalidRecord?.(record, error);
      return undefined;
    }
  }

  async function register(): Promise<void> {
    const deviceId = await getDeviceId();
    const chain: SyncRegisterChainRequest = { chainId: keys.chainId, publicKey: toBase64(keys.authPublicKey) };
    await request("POST", "/v1/chains", chain);
    const device: SyncRegisterDeviceRequest = { id: deviceId, name: opts.deviceName, platform: opts.platform };
    await request("POST", `${chainPath}/devices`, device);
  }

  async function push(items: SyncItem[]): Promise<{ conflicts: SyncItem[] }> {
    const deviceId = await getDeviceId();
    const pending = new Map<string, EncryptedRecord>();
    for (const item of items) {
      if (unsupported.has(item.collection)) continue;
      const id = recordIdFor(keys, item.collection, item.id);
      const known = (await versions(item.collection)).get(id);
      pending.set(
        id,
        encryptRecord(keys, {
          collection: item.collection,
          naturalId: item.id,
          version: (known?.[0] ?? 0) + 1,
          deviceId,
          deleted: item.deleted,
          payload: item.payload,
        }),
      );
    }

    const conflicts: SyncItem[] = [];
    for (let batch of batches([...pending.values()])) {
      let res: SyncPushResponse | undefined;
      // An older server rejects a whole batch over one collection it does not know: leave that
      // collection out (the caller sees it in unsupported()) and send the rest.
      while (!res) {
        batch = batch.filter((r) => !unsupported.has(r.collection));
        if (batch.length === 0) break;
        try {
          res = await request<SyncPushResponse>("POST", `${chainPath}/records`, { records: batch });
        } catch (err) {
          const rejected = rejectedCollection(err, batch);
          if (!rejected || unsupported.has(rejected)) throw err;
          unsupported.add(rejected);
        }
      }
      if (!res) continue;
      const byId = new Map(batch.map((r) => [r.id, r]));
      for (const id of res.accepted) {
        const rec = byId.get(id);
        if (rec) (await versions(rec.collection)).set(id, [rec.version, rec.deviceId]);
      }
      for (const remote of res.conflicts) {
        const map = await versions(remote.collection);
        if (isNewer(remote.version, remote.deviceId, map.get(remote.id))) map.set(remote.id, [remote.version, remote.deviceId]);
        const item = tryDecrypt(remote);
        if (item) conflicts.push(item);
      }
      await saveVersions(batch.map((r) => r.collection));
    }
    return { conflicts };
  }

  async function pullPages(onPage: (items: SyncItem[]) => Promise<void> | void): Promise<number> {
    let cursor = Number((await opts.storage.get(storageKey("cursor"))) ?? 0) || 0;
    let delivered = 0;
    for (;;) {
      const res = await request<SyncPullResponse>("GET", `${chainPath}/records?since=${cursor}`);
      const fresh: { record: EncryptedRecord; item: SyncItem }[] = [];
      for (const record of res.records) {
        if (!isNewer(record.version, record.deviceId, (await versions(record.collection)).get(record.id))) continue;
        const item = tryDecrypt(record);
        if (item) fresh.push({ record, item });
      }
      if (fresh.length > 0) await onPage(fresh.map((f) => f.item));
      for (const { record } of fresh) (await versions(record.collection)).set(record.id, [record.version, record.deviceId]);
      await saveVersions(fresh.map((f) => f.record.collection));
      delivered += fresh.length;
      cursor = res.cursor;
      await opts.storage.set(storageKey("cursor"), String(cursor));
      if (!res.hasMore) return delivered;
    }
  }

  async function pullCollection(collection: SyncCollection, onPage: (items: SyncItem[]) => Promise<void> | void): Promise<number> {
    if (unsupported.has(collection)) return 0;
    let since = 0;
    let delivered = 0;
    for (;;) {
      let res: SyncPullResponse;
      try {
        res = await request<SyncPullResponse>("GET", `${chainPath}/records?since=${since}&collection=${collection}`);
      } catch (err) {
        if (!rejectedCollectionFilter(err)) throw err;
        unsupported.add(collection);
        return delivered;
      }
      const map = await versions(collection);
      const fresh: { record: EncryptedRecord; item: SyncItem }[] = [];
      for (const record of res.records) {
        if (record.collection !== collection || !isNewer(record.version, record.deviceId, map.get(record.id))) continue;
        const item = tryDecrypt(record);
        if (item) fresh.push({ record, item });
      }
      if (fresh.length > 0) await onPage(fresh.map((f) => f.item));
      for (const { record } of fresh) map.set(record.id, [record.version, record.deviceId]);
      if (fresh.length > 0) await saveVersions([collection]);
      delivered += fresh.length;
      since = res.cursor;
      if (!res.hasMore) return delivered;
    }
  }

  async function hasNew(collection: SyncCollection): Promise<boolean> {
    if (unsupported.has(collection)) return false;
    const cursor = Number((await opts.storage.get(storageKey("cursor"))) ?? 0) || 0;
    let res: SyncPullResponse;
    try {
      res = await request<SyncPullResponse>("GET", `${chainPath}/records?since=${cursor}&collection=${collection}`);
    } catch (err) {
      if (!rejectedCollectionFilter(err)) throw err;
      unsupported.add(collection);
      return false;
    }
    const map = await versions(collection);
    return res.records.some((r) => r.collection === collection && isNewer(r.version, r.deviceId, map.get(r.id)));
  }

  async function forgetCollection(collection: SyncCollection): Promise<void> {
    versionCache.set(collection, new Map());
    await opts.storage.set(storageKey(`versions/${collection}`), "{}");
  }

  async function pull(): Promise<SyncItem[]> {
    const latest = new Map<string, SyncItem>();
    await pullPages((items) => {
      for (const item of items) latest.set(`${item.collection}|${item.id}`, item);
    });
    return [...latest.values()];
  }

  async function resetLocalState(): Promise<void> {
    versionCache.clear();
    await opts.storage.set(storageKey("cursor"), "0");
    for (const collection of SYNC_COLLECTIONS) await opts.storage.set(storageKey(`versions/${collection}`), "{}");
  }

  return {
    chainId: keys.chainId,
    getDeviceId,
    register,
    push,
    pull,
    pullPages,
    pullCollection,
    hasNew,
    forgetCollection,
    resetLocalState,
    async cursor(): Promise<number> {
      return Number((await opts.storage.get(storageKey("cursor"))) ?? 0) || 0;
    },
    unsupported: () => unsupported,
    async renameDevice(name: string): Promise<void> {
      const deviceId = await getDeviceId();
      const device: SyncRegisterDeviceRequest = { id: deviceId, name, platform: opts.platform };
      await request("POST", `${chainPath}/devices`, device);
    },
    async listDevices(): Promise<DeviceInfo[]> {
      return (await request<SyncDeviceListResponse>("GET", `${chainPath}/devices`)).devices;
    },
    async removeDevice(deviceId: string): Promise<void> {
      await request("DELETE", `${chainPath}/devices/${encodeURIComponent(deviceId)}`);
    },
    async wipeChain(): Promise<void> {
      await request("DELETE", chainPath);
      await resetLocalState();
    },
  };
}

function* batches(records: EncryptedRecord[]): Generator<EncryptedRecord[]> {
  let batch: EncryptedRecord[] = [];
  let bytes = 0;
  for (const record of records) {
    const size = record.ciphertext.length + 256;
    if (batch.length > 0 && (batch.length >= MAX_BATCH_RECORDS || bytes + size > MAX_BATCH_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(record);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}
