/**
 * Per-profile KeePass support (keepass.json in the profile folder). Off until the person adds a
 * database file or a folder of them. Strictly read-only: databases are only ever read with
 * fs.readFile, and a directory watcher re-reads an unlocked database when its file changes.
 *
 * Unlock takes the master password (and optional key file) once. "Keep unlocked" stores the master
 * password and key file path wrapped by the OS keychain (Electron safeStorage); never in plain text,
 * never synced, unavailable without a keychain. Kept databases unlock on start and are exempt from
 * the idle auto-lock; locking one by hand forgets its kept password. Locking drops the decrypted
 * entries and wipes the key file bytes (JavaScript strings cannot be wiped; they become garbage).
 *
 * Unlocked entries feed autofill, 2FA codes and agent sign-in through `provider()`, with agent
 * opt-ins stored here (per entry) because the database itself is never modified.
 */
import crypto from "node:crypto";
import { tr } from "./menu-i18n";
import fs from "node:fs";
import path from "node:path";
import type { KeePassDbStatus, KeePassDbView, KeePassEntrySummary, KeePassSourceKind, KeePassSourceView, KeePassUnlockResult } from "../shared/keepass-ipc";
import { JsonFile } from "./json-file";
import { entryFit, entryMatchScore, entrySite, type KeePassEntry } from "./keepass-entries";
import { openKdbx, saveKdbxEntry, type EntryInput } from "./keepass-format";
import type { LoginCandidate, LoginProvider, LoginRecord } from "./login-sources";
import type { SecretCipher } from "./settings-store";

type Listener = () => void;

interface StoredSource {
  id: string;
  kind: KeePassSourceKind;
  path: string;
}

interface OptIn {
  signIn?: boolean;
  totp?: boolean;
}

interface ConfigFile {
  v: 1;
  sources: StoredSource[];
  /** safeStorage-wrapped JSON { password, keyFile } per database id. */
  remembered: Record<string, { data: string }>;
  /** Agent opt-ins per "<dbId>:<entry uuid>". */
  optIns: Record<string, OptIn>;
}

interface DbKey {
  password: string;
  keyFile: Uint8Array | null;
  keyFilePath: string | null;
}

interface Db {
  id: string;
  sourceId: string;
  path: string;
  name: string;
  status: KeePassDbStatus;
  error: string | null;
  entries: KeePassEntry[];
  groups: string[];
  byUuid: Map<string, KeePassEntry>;
  key: DbKey | null;
  stamp: string;
}

const emptyConfig = (): ConfigFile => ({ v: 1, sources: [], remembered: {}, optIns: {} });

function reviveConfig(raw: unknown): ConfigFile {
  if (typeof raw !== "object" || raw === null) return emptyConfig();
  const r = raw as Partial<ConfigFile>;
  const sources = Array.isArray(r.sources)
    ? r.sources.filter((s): s is StoredSource => typeof s?.id === "string" && (s.kind === "file" || s.kind === "folder") && typeof s.path === "string")
    : [];
  const remembered: ConfigFile["remembered"] = {};
  for (const [id, v] of Object.entries(r.remembered ?? {})) if (typeof (v as { data?: unknown })?.data === "string") remembered[id] = { data: (v as { data: string }).data };
  const optIns: ConfigFile["optIns"] = {};
  for (const [id, v] of Object.entries(r.optIns ?? {})) {
    const o = v as OptIn;
    if (o?.signIn === true || o?.totp === true) optIns[id] = { ...(o.signIn === true ? { signIn: true } : {}), ...(o.totp === true ? { totp: true } : {}) };
  }
  return { v: 1, sources, remembered, optIns };
}

export const KEEPASS_ID_PREFIX = "kp:";

/** Stable id of a database file (hash of its absolute path). */
export function dbIdOf(file: string): string {
  return crypto.createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 12);
}

function parseEntryId(id: string): { dbId: string; uuid: string } | null {
  if (!id.startsWith(KEEPASS_ID_PREFIX)) return null;
  const rest = id.slice(KEEPASS_ID_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  return { dbId: rest.slice(0, colon), uuid: rest.slice(colon + 1) };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface KeePassStoreOptions {
  /** Watch database folders and re-read on change (off in some tests). Default true. */
  watch?: boolean;
  /** Debounce for file change events, ms. */
  debounceMs?: number;
}

export class KeePassStore {
  private readonly file: JsonFile<ConfigFile>;
  private readonly dbs = new Map<string, Db>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly listeners = new Set<Listener>();
  /** Database files this run already kept a .bak copy of. */
  private readonly backedUp = new Set<string>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> = Promise.resolve();
  private readonly watch: boolean;
  private readonly debounceMs: number;
  private disposed = false;

  constructor(
    dir: string,
    private readonly cipher: SecretCipher,
    opts: KeePassStoreOptions = {},
  ) {
    this.file = JsonFile.load(path.join(dir, "keepass.json"), emptyConfig, reviveConfig, 0);
    this.watch = opts.watch !== false;
    this.debounceMs = opts.debounceMs ?? 400;
    this.rescan();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** True once the person added at least one database or folder. */
  get configured(): boolean {
    return this.file.get().sources.length > 0;
  }

  get canRemember(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  // ------------------------------------------------------------------ sources

  addSources(paths: string[], kind: KeePassSourceKind): void {
    const config = this.file.get();
    const known = new Set(config.sources.map((s) => `${s.kind}:${path.resolve(s.path)}`));
    const added: StoredSource[] = [];
    for (const p of paths) {
      const resolved = path.resolve(p);
      if (known.has(`${kind}:${resolved}`)) continue;
      known.add(`${kind}:${resolved}`);
      added.push({ id: crypto.randomUUID(), kind, path: resolved });
    }
    if (added.length === 0) return;
    this.file.set({ ...config, sources: [...config.sources, ...added] });
    this.rescan();
    this.emit();
  }

  removeSource(id: string): void {
    const config = this.file.get();
    if (!config.sources.some((s) => s.id === id)) return;
    this.file.set({ ...config, sources: config.sources.filter((s) => s.id !== id) });
    this.rescan();
    this.emit();
  }

  sources(): KeePassSourceView[] {
    return this.file.get().sources.map((s) => ({ id: s.id, kind: s.kind, path: s.path, databases: [...this.dbs.values()].filter((d) => d.sourceId === s.id).length }));
  }

  databases(): KeePassDbView[] {
    const remembered = this.file.get().remembered;
    return [...this.dbs.values()].map((d) => ({
      id: d.id,
      sourceId: d.sourceId,
      name: d.name,
      path: d.path,
      status: d.status,
      error: d.error,
      entryCount: d.status === "unlocked" ? d.entries.length : 0,
      remembered: Boolean(remembered[d.id]),
    }));
  }

  private listFolder(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.kdbx$/i.test(e.name))
        .map((e) => path.join(dir, e.name))
        .sort();
    } catch {
      return [];
    }
  }

  /** Recomputes the database list from the sources; keeps the state of databases still present. */
  private rescan(): void {
    const wanted = new Map<string, { file: string; sourceId: string }>();
    for (const source of this.file.get().sources) {
      const files = source.kind === "file" ? [source.path] : this.listFolder(source.path);
      for (const file of files) {
        const id = dbIdOf(file);
        if (!wanted.has(id)) wanted.set(id, { file: path.resolve(file), sourceId: source.id });
      }
    }
    for (const [id, db] of this.dbs) {
      if (!wanted.has(id)) {
        this.wipe(db);
        this.dbs.delete(id);
      }
    }
    for (const [id, { file, sourceId }] of wanted) {
      const existing = this.dbs.get(id);
      const exists = fs.existsSync(file);
      if (existing) {
        existing.sourceId = sourceId;
        if (!exists && existing.status !== "missing") {
          this.wipe(existing);
          existing.status = "missing";
        } else if (exists && existing.status === "missing") {
          existing.status = "locked";
        }
        continue;
      }
      this.dbs.set(id, {
        id,
        sourceId,
        path: file,
        name: path.basename(file).replace(/\.kdbx$/i, ""),
        status: exists ? "locked" : "missing",
        error: null,
        entries: [],
        groups: [],
        byUuid: new Map(),
        key: null,
        stamp: "",
      });
    }
    // Forget kept passwords and opt-ins of databases no longer configured.
    const config = this.file.get();
    const remembered = Object.fromEntries(Object.entries(config.remembered).filter(([id]) => this.dbs.has(id)));
    const optIns = Object.fromEntries(Object.entries(config.optIns).filter(([key]) => this.dbs.has(key.split(":")[0]!)));
    if (Object.keys(remembered).length !== Object.keys(config.remembered).length || Object.keys(optIns).length !== Object.keys(config.optIns).length) {
      this.file.set({ ...config, remembered, optIns });
    }
    this.syncWatchers();
  }

  // ------------------------------------------------------------------ watching

  private syncWatchers(): void {
    if (!this.watch || this.disposed) return;
    const dirs = new Set<string>();
    for (const source of this.file.get().sources) dirs.add(source.kind === "folder" ? source.path : path.dirname(source.path));
    for (const [dir, watcher] of this.watchers) {
      if (!dirs.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { persistent: false }, () => this.scheduleRefresh());
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // Folder missing or not watchable: the database shows as missing until it comes back.
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, this.debounceMs);
  }

  /** Rescans folders and re-reads unlocked databases whose file changed. Serialized. */
  refresh(): Promise<void> {
    this.refreshing = this.refreshing.then(async () => {
      if (this.disposed) return;
      this.rescan();
      for (const db of this.dbs.values()) {
        if (db.status !== "unlocked" || !db.key) continue;
        const stamp = await this.stampOf(db.path);
        if (!stamp || stamp === db.stamp) continue;
        try {
          await this.load(db, db.key);
        } catch (err) {
          this.wipe(db);
          db.status = "locked";
          db.error = `The database changed on disk and could not be reopened: ${errorText(err)}`;
        }
      }
      this.emit();
    });
    return this.refreshing;
  }

  private async stampOf(file: string): Promise<string> {
    try {
      const st = await fs.promises.stat(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "";
    }
  }

  // ------------------------------------------------------------------ lock / unlock

  private async load(db: Db, key: DbKey): Promise<void> {
    const stamp = await this.stampOf(db.path);
    const data = await fs.promises.readFile(db.path);
    const opened = await openKdbx(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), key.password, key.keyFile);
    db.entries = opened.entries;
    db.groups = opened.groups;
    db.byUuid = new Map(opened.entries.map((e) => [e.uuid, e]));
    db.key = key;
    db.stamp = stamp;
    db.status = "unlocked";
    db.error = null;
  }

  async unlock(dbId: string, password: string, keyFilePath: string | null, keepUnlocked: boolean): Promise<KeePassUnlockResult> {
    const db = this.dbs.get(dbId);
    if (!db) return { ok: false, error: "That database is no longer configured." };
    if (db.status === "unlocking") return { ok: false, error: "The database is already being unlocked." };
    if (db.status === "missing") return { ok: false, error: "The database file was not found." };
    if (keepUnlocked && !this.canRemember) return { ok: false, error: "No system keychain is available, so the master password cannot be kept." };
    db.status = "unlocking";
    db.error = null;
    this.emit();
    let keyFile = null as Uint8Array | null;
    try {
      if (keyFilePath) {
        try {
          keyFile = new Uint8Array(await fs.promises.readFile(keyFilePath));
        } catch {
          throw new Error("Could not read the key file.");
        }
      }
      await this.load(db, { password, keyFile, keyFilePath });
      if (keepUnlocked) this.remember(db.id, password, keyFilePath);
      else this.forget(db.id);
      return { ok: true };
    } catch (err) {
      keyFile?.fill(0);
      this.wipe(db);
      db.status = "locked";
      db.error = errorText(err);
      return { ok: false, error: db.error };
    } finally {
      this.emit();
    }
  }

  /** Locks a database by hand: drops decrypted data and forgets a kept master password. */
  lock(dbId: string | null): void {
    for (const db of this.dbs.values()) {
      if (dbId !== null && db.id !== dbId) continue;
      this.wipe(db);
      if (db.status === "unlocked" || db.status === "unlocking") db.status = "locked";
      db.error = null;
      this.forget(db.id);
    }
    this.emit();
  }

  /**
   * Idle auto-lock: once the machine has been idle `minutes` (0 = never), locks every unlocked
   * database except the ones kept unlocked. Returns how many were locked.
   */
  autoLock(idleSeconds: number, minutes: number): number {
    if (minutes <= 0 || idleSeconds < minutes * 60) return 0;
    return this.lockTransient();
  }

  /** Locks everything not kept unlocked (screen lock, suspend, idle). */
  lockTransient(): number {
    const remembered = this.file.get().remembered;
    let locked = 0;
    for (const db of this.dbs.values()) {
      if (db.status !== "unlocked" || remembered[db.id]) continue;
      this.wipe(db);
      db.status = "locked";
      locked += 1;
    }
    if (locked) this.emit();
    return locked;
  }

  /** Unlocks the databases whose master password was kept. Failures are shown per database. */
  async restoreRemembered(): Promise<void> {
    const remembered = this.file.get().remembered;
    for (const [id, blob] of Object.entries(remembered)) {
      const db = this.dbs.get(id);
      if (!db || db.status !== "locked" || !this.canRemember) continue;
      let saved: { password: string; keyFile: string | null };
      try {
        saved = JSON.parse(this.cipher.decryptString(Buffer.from(blob.data, "base64"))) as { password: string; keyFile: string | null };
      } catch {
        db.error = "The kept master password could not be read. Unlock the database again.";
        this.forget(id);
        continue;
      }
      const result = await this.unlock(id, saved.password, saved.keyFile, true);
      if (!result.ok) db.error = `${result.error} Unlock it again to keep it unlocked.`;
    }
    this.emit();
  }

  private remember(dbId: string, password: string, keyFilePath: string | null): void {
    const data = this.cipher.encryptString(JSON.stringify({ password, keyFile: keyFilePath })).toString("base64");
    const config = this.file.get();
    this.file.set({ ...config, remembered: { ...config.remembered, [dbId]: { data } } });
  }

  private forget(dbId: string): void {
    const config = this.file.get();
    if (!config.remembered[dbId]) return;
    const { [dbId]: _gone, ...rest } = config.remembered;
    this.file.set({ ...config, remembered: rest });
  }

  /** Drops decrypted entries and wipes the key file bytes. */
  private wipe(db: Db): void {
    db.key?.keyFile?.fill(0);
    db.key = null;
    db.entries = [];
    db.byUuid = new Map();
    db.groups = [];
    db.stamp = "";
  }

  // ------------------------------------------------------------------ entries

  private optInKey(dbId: string, uuid: string): string {
    return `${dbId}:${uuid}`;
  }

  private record(db: Db, e: KeePassEntry): LoginRecord {
    const optIn = this.file.get().optIns[this.optInKey(db.id, e.uuid)] ?? {};
    return {
      id: `${KEEPASS_ID_PREFIX}${db.id}:${e.uuid}`,
      source: "keepass",
      sourceName: db.name,
      site: e.urls[0] ?? "",
      username: e.username,
      password: e.password,
      ...(e.totp ? { totp: e.totp } : {}),
      agentTotp: optIn.totp === true && Boolean(e.totp),
      agentSignIn: optIn.signIn === true,
      updatedAt: e.modified,
    };
  }

  private find(id: string): { db: Db; entry: KeePassEntry } | null {
    const parsed = parseEntryId(id);
    if (!parsed) return null;
    const db = this.dbs.get(parsed.dbId);
    if (!db || db.status !== "unlocked") return null;
    const entry = db.byUuid.get(parsed.uuid);
    return entry ? { db, entry } : null;
  }

  /** Unlocked entries as a login source (autofill, 2FA, agent sign-in). */
  provider(): LoginProvider {
    return {
      matches: (url) => {
        const scored: Array<{ record: LoginRecord; score: number }> = [];
        for (const db of this.dbs.values()) {
          if (db.status !== "unlocked") continue;
          for (const e of db.entries) {
            const score = entryMatchScore(e, url);
            if (score > 0) scored.push({ record: this.record(db, e), score });
          }
        }
        return scored.sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt).map((s) => s.record);
      },
      candidates: (url) => {
        const found: LoginCandidate[] = [];
        for (const db of this.dbs.values()) {
          if (db.status !== "unlocked") continue;
          for (const e of db.entries) {
            const fit = entryFit(e, url);
            if (fit) found.push({ record: this.record(db, e), ...fit });
          }
        }
        return found;
      },
      get: (id) => {
        const found = this.find(id);
        return found ? this.record(found.db, found.entry) : undefined;
      },
    };
  }

  get(id: string): LoginRecord | undefined {
    const found = this.find(id);
    return found ? this.record(found.db, found.entry) : undefined;
  }

  private summary(db: Db, e: KeePassEntry): KeePassEntrySummary {
    const optIn = this.file.get().optIns[this.optInKey(db.id, e.uuid)] ?? {};
    return {
      id: `${KEEPASS_ID_PREFIX}${db.id}:${e.uuid}`,
      dbId: db.id,
      dbName: db.name,
      title: e.title,
      username: e.username,
      site: entrySite(e) === e.title ? "" : entrySite(e),
      group: e.group,
      hasPassword: e.password !== "",
      hasTotp: Boolean(e.totp),
      agentTotp: optIn.totp === true && Boolean(e.totp),
      agentSignIn: optIn.signIn === true,
    };
  }

  /** The groups of an unlocked database, for the entry form ("" is the root). */
  groups(dbId: string): string[] {
    const db = this.dbs.get(dbId);
    return db?.status === "unlocked" ? db.groups : [];
  }

  /** An entry's fields for the edit form (its password only on reveal). */
  details(id: string): { title: string; username: string; url: string; notes: string; group: string } | null {
    const found = this.find(id);
    if (!found) return null;
    const e = found.entry;
    return { title: e.title, username: e.username, url: e.urls[0] ?? "", notes: e.notes, group: e.group };
  }

  /**
   * Adds or changes an entry in an unlocked database file. The file must not have changed since
   * Corvus read it (another app editing it): then Corvus reloads it and asks to try again. The first
   * write of a run keeps the file as it was in "<file>.bak"; the new file replaces the old in one step.
   */
  async saveEntry(dbId: string, input: EntryInput): Promise<string> {
    const db = this.dbs.get(dbId);
    if (!db || db.status !== "unlocked" || !db.key) throw new Error(tr("Unlock the database first."));
    if ((await this.stampOf(db.path)) !== db.stamp) {
      await this.refresh();
      throw new Error(tr("The database changed on disk since Corvus read it (another app saved it). It has been reloaded: try again."));
    }
    const data = await fs.promises.readFile(db.path);
    const saved = await saveKdbxEntry(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), db.key.password, db.key.keyFile, input);
    if (!this.backedUp.has(db.path)) {
      await fs.promises.copyFile(db.path, `${db.path}.bak`);
      this.backedUp.add(db.path);
    }
    const temp = `${db.path}.corvus-tmp`;
    await fs.promises.writeFile(temp, saved.data);
    await fs.promises.rename(temp, db.path);
    await this.load(db, db.key);
    this.emit();
    return `${KEEPASS_ID_PREFIX}${db.id}:${saved.uuid}`;
  }

  /** Every entry of the unlocked databases, with its password (the password checkup only). */
  records(): LoginRecord[] {
    return [...this.dbs.values()].filter((db) => db.status === "unlocked").flatMap((db) => db.entries.map((e) => this.record(db, e)));
  }

  /** Entries of unlocked databases for the passwords page (no secrets), filtered by a query. */
  entries(query = ""): KeePassEntrySummary[] {
    const q = query.trim().toLowerCase();
    const out: KeePassEntrySummary[] = [];
    for (const db of this.dbs.values()) {
      if (db.status !== "unlocked") continue;
      for (const e of db.entries) {
        const s = this.summary(db, e);
        if (q && ![s.title, s.username, s.site, s.group, ...e.urls].some((v) => v.toLowerCase().includes(q))) continue;
        out.push(s);
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title) || a.username.localeCompare(b.username));
  }

  setOptIn(id: string, patch: OptIn): KeePassEntrySummary | null {
    const found = this.find(id);
    if (!found) return null;
    const key = this.optInKey(found.db.id, found.entry.uuid);
    const config = this.file.get();
    const next: OptIn = { ...(config.optIns[key] ?? {}), ...patch };
    const clean: OptIn = { ...(next.signIn === true ? { signIn: true } : {}), ...(next.totp === true && found.entry.totp ? { totp: true } : {}) };
    const optIns = { ...config.optIns };
    if (clean.signIn || clean.totp) optIns[key] = clean;
    else delete optIns[key];
    this.file.set({ ...config, optIns });
    this.emit();
    return this.summary(found.db, found.entry);
  }

  flush(): void {
    this.file.flush();
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const db of this.dbs.values()) this.wipe(db);
  }
}
