import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { DeviceInfo, EncryptedRecord, SyncCollection } from "@corvus/shared";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE chains (
    id          TEXT PRIMARY KEY,
    public_key  BLOB NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE devices (
    chain_id    TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    name        TEXT NOT NULL,
    platform    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    removed_at  INTEGER,
    PRIMARY KEY (chain_id, id)
  );
  CREATE TABLE records (
    chain_id    TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    collection  TEXT NOT NULL,
    id          TEXT NOT NULL,
    version     INTEGER NOT NULL,
    device_id   TEXT NOT NULL,
    deleted     INTEGER NOT NULL,
    ciphertext  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    seq         INTEGER NOT NULL,
    PRIMARY KEY (chain_id, collection, id)
  );
  CREATE UNIQUE INDEX records_chain_seq ON records (chain_id, seq);
  CREATE INDEX records_chain_collection_seq ON records (chain_id, collection, seq);
  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT INTO counters (name, value) VALUES ('seq', 0);
  `,
];

interface RecordRow {
  collection: SyncCollection;
  id: string;
  version: number;
  device_id: string;
  deleted: number;
  ciphertext: string;
  updated_at: number;
  seq: number;
}

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  last_seen: number;
  removed_at: number | null;
}

export interface Quotas {
  maxRecords: number;
  maxBytes: number;
}

export class QuotaExceededError extends Error {}

const toRecord = (r: RecordRow): EncryptedRecord => ({
  id: r.id,
  collection: r.collection,
  version: r.version,
  deviceId: r.device_id,
  deleted: r.deleted === 1,
  ciphertext: r.ciphertext,
  updatedAt: r.updated_at,
});

/** node:sqlite, loaded at run time: some bundlers and test runners do not know the module yet. */
function loadSqlite(): typeof import("node:sqlite") {
  return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
}

/**
 * Opens (and migrates) the database with Node's built-in SQLite, so the server needs no native
 * module: the same code runs in Docker and inside the Corvus desktop app (Electron's Node).
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new (loadSqlite().DatabaseSync)(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

/** Runs fn in a transaction: committed when it returns, rolled back when it throws. */
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** A prepared statement typed by its parameters and row shape. */
interface Stmt<P extends unknown[], R = unknown> {
  get(...params: P): R | undefined;
  all(...params: P): R[];
  run(...params: P): { changes: number | bigint };
}

function prepare<P extends unknown[], R = unknown>(db: DatabaseSync, sql: string): Stmt<P, R> {
  return db.prepare(sql) as unknown as Stmt<P, R>;
}

export class SyncStore {
  private readonly stmt;

  constructor(private readonly db: DatabaseSync) {
    this.stmt = {
      getChain: prepare<[string], { public_key: Uint8Array }>(db, "SELECT public_key FROM chains WHERE id = ?"),
      createChain: prepare<unknown[]>(db, "INSERT INTO chains (id, public_key, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING"),
      deleteChain: prepare<unknown[]>(db, "DELETE FROM chains WHERE id = ?"),
      getDevice: prepare<[string, string], DeviceRow>(
        db,
        "SELECT id, name, platform, last_seen, removed_at FROM devices WHERE chain_id = ? AND id = ?",
      ),
      countDevices: prepare<[string], { n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM devices WHERE chain_id = ? AND removed_at IS NULL",
      ),
      upsertDevice: prepare<unknown[]>(
        db,
        `INSERT INTO devices (chain_id, id, name, platform, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (chain_id, id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen = excluded.last_seen`,
      ),
      listDevices: prepare<[string], DeviceRow>(
        db,
        "SELECT id, name, platform, last_seen, removed_at FROM devices WHERE chain_id = ? AND removed_at IS NULL ORDER BY created_at, id",
      ),
      removeDevice: prepare<unknown[]>(db, "UPDATE devices SET removed_at = ? WHERE chain_id = ? AND id = ? AND removed_at IS NULL"),
      touchDevice: prepare<unknown[]>(db, "UPDATE devices SET last_seen = ? WHERE chain_id = ? AND id = ?"),
      usage: prepare<[string], { n: number; bytes: number }>(
        db,
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(ciphertext)), 0) AS bytes FROM records WHERE chain_id = ?",
      ),
      getRecord: prepare<[string, string, string], RecordRow>(
        db,
        "SELECT collection, id, version, device_id, deleted, ciphertext, updated_at, seq FROM records WHERE chain_id = ? AND collection = ? AND id = ?",
      ),
      upsertRecord: prepare<unknown[]>(
        db,
        `INSERT INTO records (chain_id, collection, id, version, device_id, deleted, ciphertext, updated_at, seq)
         VALUES (@chainId, @collection, @id, @version, @deviceId, @deleted, @ciphertext, @updatedAt, @seq)
         ON CONFLICT (chain_id, collection, id) DO UPDATE SET version = excluded.version, device_id = excluded.device_id,
           deleted = excluded.deleted, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, seq = excluded.seq`,
      ),
      nextSeq: prepare<[], { value: number }>(db, "UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value"),
      pullAll: prepare<[string, number, number], RecordRow>(
        db,
        "SELECT collection, id, version, device_id, deleted, ciphertext, updated_at, seq FROM records WHERE chain_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      ),
      pullCollection: prepare<[string, string, number, number], RecordRow>(
        db,
        "SELECT collection, id, version, device_id, deleted, ciphertext, updated_at, seq FROM records WHERE chain_id = ? AND collection = ? AND seq > ? ORDER BY seq LIMIT ?",
      ),
    };
  }

  getChainKey(chainId: string): Uint8Array | undefined {
    const row = this.stmt.getChain.get(chainId);
    return row ? new Uint8Array(row.public_key) : undefined;
  }

  /** Returns false if the chain already existed. */
  createChain(chainId: string, publicKey: Uint8Array, now: number): boolean {
    return Number(this.stmt.createChain.run(chainId, publicKey, now).changes) === 1;
  }

  deleteChain(chainId: string): void {
    this.stmt.deleteChain.run(chainId);
  }

  getDevice(chainId: string, deviceId: string): { removed: boolean } | undefined {
    const row = this.stmt.getDevice.get(chainId, deviceId);
    return row ? { removed: row.removed_at !== null } : undefined;
  }

  countActiveDevices(chainId: string): number {
    return this.stmt.countDevices.get(chainId)!.n;
  }

  upsertDevice(chainId: string, device: { id: string; name: string; platform: string }, now: number): DeviceInfo {
    this.stmt.upsertDevice.run(chainId, device.id, device.name, device.platform, now, now);
    return { ...device, lastSeen: now };
  }

  listDevices(chainId: string): DeviceInfo[] {
    return this.stmt.listDevices.all(chainId).map((d) => ({ id: d.id, name: d.name, platform: d.platform, lastSeen: d.last_seen }));
  }

  /** Marks the device removed (kept as a revocation entry so the id cannot be reused). */
  removeDevice(chainId: string, deviceId: string, now: number): boolean {
    return Number(this.stmt.removeDevice.run(now, chainId, deviceId).changes) === 1;
  }

  touchDevice(chainId: string, deviceId: string, now: number): void {
    this.stmt.touchDevice.run(now, chainId, deviceId);
  }

  /**
   * LWW push. A record replaces the stored one iff (version, deviceId) is strictly greater;
   * an exact re-push of the stored revision is accepted idempotently; anything else is a conflict
   * answered with the stored record. The whole batch rolls back if it pushes the chain over quota.
   */
  push(chainId: string, records: EncryptedRecord[], now: number, quotas: Quotas): { accepted: string[]; conflicts: EncryptedRecord[] } {
    return transaction(this.db, () => {
      const before = this.stmt.usage.get(chainId)!;
      const accepted: string[] = [];
      const conflicts: EncryptedRecord[] = [];
      for (const rec of records) {
        const stored = this.stmt.getRecord.get(chainId, rec.collection, rec.id);
        const wins =
          !stored || rec.version > stored.version || (rec.version === stored.version && rec.deviceId > stored.device_id);
        if (wins) {
          this.stmt.upsertRecord.run({
            chainId,
            collection: rec.collection,
            id: rec.id,
            version: rec.version,
            deviceId: rec.deviceId,
            deleted: rec.deleted ? 1 : 0,
            ciphertext: rec.ciphertext,
            updatedAt: now,
            seq: this.stmt.nextSeq.get()!.value,
          });
          accepted.push(rec.id);
        } else if (
          rec.version === stored.version &&
          rec.deviceId === stored.device_id &&
          rec.ciphertext === stored.ciphertext &&
          rec.deleted === (stored.deleted === 1)
        ) {
          accepted.push(rec.id);
        } else {
          conflicts.push(toRecord(stored));
        }
      }
      const after = this.stmt.usage.get(chainId)!;
      if (
        (after.n > quotas.maxRecords && after.n > before.n) ||
        (after.bytes > quotas.maxBytes && after.bytes > before.bytes)
      ) {
        throw new QuotaExceededError(`Chain quota exceeded (${quotas.maxRecords} records / ${quotas.maxBytes} bytes)`);
      }
      return { accepted, conflicts };
    });
  }

  pull(chainId: string, since: number, collection: SyncCollection | undefined, pageSize: number) {
    const rows = collection
      ? this.stmt.pullCollection.all(chainId, collection, since, pageSize + 1)
      : this.stmt.pullAll.all(chainId, since, pageSize + 1);
    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    return { records: page.map(toRecord), cursor: page.length > 0 ? page[page.length - 1]!.seq : since, hasMore };
  }
}
