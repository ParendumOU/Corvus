import path from "node:path";
import { generateVaultKey, openSecret, sealSecret } from "@corvus/sync-core";
import { JsonFile } from "./json-file";
import { isProfileLocked, KeychainUnavailableError, unwrapStoreKey, verifyWrappedFile } from "./profile-lock";
import type { SecretCipher } from "./settings-store";

/** What every sealed record has in the clear: its id and when it was made and last changed. */
export interface SealedRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** sealSecret(key, JSON(the whole record), aad = id). */
  sealed: string;
}

interface RecordsFile {
  v: 1;
  /** The file's key wrapped by the OS keychain (safeStorage). Null when no keychain is available. */
  key: { data: string } | null;
  entries: StoredRecord[];
}

const emptyFile = (): RecordsFile => ({ v: 1, key: null, entries: [] });

function reviveFile(raw: unknown): RecordsFile {
  if (typeof raw !== "object" || raw === null) return emptyFile();
  const r = raw as Partial<RecordsFile>;
  const key = r.key && typeof (r.key as { data?: unknown }).data === "string" ? { data: (r.key as { data: string }).data } : null;
  const entries = Array.isArray(r.entries)
    ? r.entries.filter((e): e is StoredRecord => typeof e?.id === "string" && typeof e.sealed === "string" && typeof e.createdAt === "number" && typeof e.updatedAt === "number")
    : [];
  return { v: 1, key, entries };
}

type Listener = () => void;

/**
 * A per-profile file of records sealed one by one (XChaCha20-Poly1305, sync-core's vault primitive)
 * under a random key of its own wrapped by the OS keychain, as the credential vault does: nothing but
 * ids and timestamps is ever at rest in the clear. Without a keychain it runs memory-only for the
 * session and never touches disk. Records that do not pass `isValid` are dropped on load and refused.
 */
interface Opened<T> {
  file: JsonFile<RecordsFile>;
  key: Uint8Array;
  cache: Map<string, T>;
  /** Entries that did not open (corrupt): kept in the file as they are, never dropped by a write. */
  unreadable: StoredRecord[];
}

export class SealedRecords<T extends SealedRecord> {
  private readonly filePath: string;
  /** Null until first used, and again once the profile locks (see unload). */
  private opened: Opened<T> | null = null;
  private readonly persisted: boolean;
  private readonly listeners = new Set<Listener>();
  /** Fires on any local or remote change (drives the sync scheduler and page refreshes). */
  readonly changes = {
    on: (listener: Listener): (() => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  constructor(
    dir: string,
    fileName: string,
    private readonly cipher: SecretCipher,
    private readonly isValid: (v: unknown) => v is T,
  ) {
    this.filePath = path.join(dir, fileName);
    this.persisted = cipher.isEncryptionAvailable();
    try {
      this.open();
    } catch (err) {
      // A locked profile's records open on first use after unlocking.
      if (!isProfileLocked(err)) throw err;
    }
  }

  private get file(): JsonFile<RecordsFile> {
    return this.open().file;
  }

  private get cache(): Map<string, T> {
    return this.open().cache;
  }

  private get key(): Uint8Array {
    return this.open().key;
  }

  /** Reads and decrypts the file (once); throws ProfileLockedError while the profile is locked. */
  private open(): Opened<T> {
    if (this.opened) return this.opened;
    const fileName = path.basename(this.filePath);
    const file = JsonFile.load(this.filePath, emptyFile, reviveFile, 0);
    const current = file.get();
    const cache = new Map<string, T>();
    const key = unwrapStoreKey(this.cipher, this.persisted, current.key?.data, current.entries.length > 0, fileName);
    if (key) {
      const unreadable: StoredRecord[] = [];
      for (const entry of current.entries) {
        try {
          const record: unknown = { ...JSON.parse(openSecret(key, entry.sealed, entry.id)), id: entry.id, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
          if (this.isValid(record)) cache.set(entry.id, record);
        } catch (err) {
          unreadable.push(entry);
          console.warn(`[corvus] kept an unreadable record ${entry.id} of ${fileName}:`, (err as Error).message);
        }
      }
      // Not one record opens: the key is not this file's, so it stays as it is.
      if (unreadable.length > 0 && unreadable.length === current.entries.length) throw new KeychainUnavailableError();
      this.opened = { file, key, cache, unreadable };
      // Records that fail isValid are dropped; an unreadable one stays in the file.
      if (cache.size + unreadable.length !== current.entries.length) this.write();
    } else {
      this.opened = { file, key: generateVaultKey(), cache, unreadable: [] };
      if (this.persisted) this.write();
    }
    return this.opened;
  }

  /** The profile locked: the decrypted records and the key leave memory until opened again. */
  unload(): void {
    const opened = this.opened;
    if (!opened) return;
    this.opened = null;
    opened.file.flush();
    opened.key.fill(0);
    opened.cache.clear();
    opened.unreadable = [];
  }

  /** Entry `id` is in the file but did not open (corrupt): all() leaves it out, yet it is not deleted. */
  isUnreadable(id: string): boolean {
    return this.open().unreadable.some((e) => e.id === id);
  }

  /** Writes the wrapped key again with the cipher as it is now (a lock added or removed). */
  rewrap(): void {
    this.write();
    this.file.flush();
  }

  /** Whether the file on disk opens with the cipher as it is now, to the key and records in memory. */
  verify(): boolean {
    return verifyWrappedFile(this.filePath, this.cipher, this.key, this.cache.size + this.open().unreadable.length);
  }

  /** Whether records are written to disk (true when the OS keychain is available). */
  get secretsPersisted(): boolean {
    return this.persisted;
  }

  all(): T[] {
    return [...this.cache.values()];
  }

  get(id: string): T | null {
    return this.cache.get(id) ?? null;
  }

  /** Puts or replaces records and removes others (null), with one write and one change event. */
  put(changes: Array<{ id: string; record: T | null }>): boolean {
    let changed = false;
    for (const { id, record } of changes) {
      if (record === null) changed = this.forget(id) || changed;
      else if (this.isValid(record) && record.id === id) {
        this.forget(id);
        this.cache.set(id, record);
        changed = true;
      }
    }
    if (!changed) return false;
    this.write();
    for (const l of this.listeners) l();
    return true;
  }

  /** Removes a record, readable or not. */
  private forget(id: string): boolean {
    const opened = this.open();
    const before = opened.unreadable.length;
    opened.unreadable = opened.unreadable.filter((e) => e.id !== id);
    return opened.cache.delete(id) || opened.unreadable.length !== before;
  }

  private write(): void {
    if (!this.persisted) return;
    const entries: StoredRecord[] = [...this.cache.values()].map((r) => {
      const { id, createdAt, updatedAt, ...rest } = r;
      return { id, createdAt, updatedAt, sealed: sealSecret(this.key, JSON.stringify(rest), id) };
    });
    for (const entry of this.open().unreadable) if (!this.cache.has(entry.id)) entries.push(entry);
    const wrapped = this.cipher.encryptString(Buffer.from(this.key).toString("base64")).toString("base64");
    this.file.set({ v: 1, key: { data: wrapped }, entries });
  }

  flush(): void {
    this.opened?.file.flush();
  }

  /** The store's file was missing or unreadable at load (see JsonFile.fresh). */
  get loadedFresh(): boolean {
    return this.file.fresh;
  }
}
