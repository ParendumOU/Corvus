import path from "node:path";
import { generateVaultKey, openSecret, sealSecret } from "@corvus/sync-core";
import { JsonFile } from "./json-file";
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
export class SealedRecords<T extends SealedRecord> {
  private readonly file: JsonFile<RecordsFile>;
  private readonly cache = new Map<string, T>();
  private readonly key: Uint8Array;
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
    this.file = JsonFile.load(path.join(dir, fileName), emptyFile, reviveFile, 0);
    const current = this.file.get();
    this.persisted = cipher.isEncryptionAvailable();
    let key: Uint8Array | null = null;
    if (this.persisted && current.key) {
      try {
        key = Buffer.from(cipher.decryptString(Buffer.from(current.key.data, "base64")), "base64");
        if (key.length !== 32) key = null;
      } catch (err) {
        console.warn(`[corvus] could not unwrap the key of ${fileName}; starting empty:`, (err as Error).message);
        key = null;
      }
    }
    if (key) {
      this.key = key;
      for (const entry of current.entries) {
        try {
          const record: unknown = { ...JSON.parse(openSecret(key, entry.sealed, entry.id)), id: entry.id, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
          if (this.isValid(record)) this.cache.set(entry.id, record);
        } catch (err) {
          console.warn(`[corvus] dropped an unreadable record ${entry.id} of ${fileName}:`, (err as Error).message);
        }
      }
      if (this.cache.size !== current.entries.length) this.write();
    } else {
      this.key = generateVaultKey();
      if (this.persisted) this.write();
      else if (current.entries.length > 0) this.file.set(emptyFile());
    }
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
      if (record === null) changed = this.cache.delete(id) || changed;
      else if (this.isValid(record) && record.id === id) {
        this.cache.set(id, record);
        changed = true;
      }
    }
    if (!changed) return false;
    this.write();
    for (const l of this.listeners) l();
    return true;
  }

  private write(): void {
    if (!this.persisted) return;
    const entries: StoredRecord[] = [...this.cache.values()].map((r) => {
      const { id, createdAt, updatedAt, ...rest } = r;
      return { id, createdAt, updatedAt, sealed: sealSecret(this.key, JSON.stringify(rest), id) };
    });
    const wrapped = this.cipher.encryptString(Buffer.from(this.key).toString("base64")).toString("base64");
    this.file.set({ v: 1, key: { data: wrapped }, entries });
  }

  flush(): void {
    this.file.flush();
  }
}
