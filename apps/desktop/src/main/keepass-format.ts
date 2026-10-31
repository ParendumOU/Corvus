/**
 * KDBX 3.1 and 4 reading and writing through kdbxweb (MIT), with Argon2d/Argon2id from hash-wasm
 * (MIT, WebAssembly, no native build). Both load lazily, so they cost nothing until KeePass is used.
 *
 * Corvus writes to a person's database only to add, edit or delete an entry they asked for on the
 * passwords page (`saveKdbxEntry`, `deleteKdbxEntry`; the store keeps a .bak copy of the file first).
 * `createKdbx` writes a brand-new file for the export of the built-in vault (and builds fixtures in
 * tests).
 */
import type * as Kdbxweb from "kdbxweb";
import { tr } from "./menu-i18n";
import type { Credential } from "../shared/credentials";
import { buildOtpauthUri, type TotpConfig } from "../shared/totp";
import { additionalUrlFields, totpFromFields, type KeePassEntry } from "./keepass-entries";

type KdbxwebModule = typeof Kdbxweb;

let loading: Promise<KdbxwebModule> | null = null;

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** kdbxweb with its Argon2 hook wired to hash-wasm. Loaded once, on first use. */
export function loadKdbxweb(): Promise<KdbxwebModule> {
  loading ??= (async () => {
    const mod = (await import("kdbxweb")) as KdbxwebModule & { default?: KdbxwebModule };
    const kdbxweb = mod.default ?? mod;
    const { argon2d, argon2id } = await import("hash-wasm");
    kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
      if (version !== 0x13) throw new Error("This database uses Argon2 version 1.0, which Corvus does not support.");
      const options = {
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        memorySize: memory,
        iterations,
        parallelism,
        hashLength: length,
        outputType: "binary" as const,
      };
      const hash = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? await argon2id(options) : await argon2d(options);
      return arrayBufferOf(hash);
    });
    return kdbxweb;
  })();
  return loading;
}

export interface OpenedDatabase {
  /** Database name from its metadata (may be empty). */
  name: string;
  entries: KeePassEntry[];
  /** Paths of its groups ("Banking / Cards"), Recycle Bin excluded; "" is the root. */
  groups: string[];
}

/** An entry to add (no uuid) or to change (its uuid); a password or 2FA left out stays as it is. */
export interface EntryInput {
  uuid?: string;
  group: string;
  title: string;
  username: string;
  password?: string;
  /** A new 2FA for the entry; null removes it. */
  totp?: TotpConfig | null;
  url: string;
  notes: string;
}

/** Turns kdbxweb errors into messages a person can act on (never echoing key material). */
function openError(err: unknown, kdbxweb: KdbxwebModule): Error {
  const code = err instanceof kdbxweb.KdbxError ? err.code : "";
  const codes = kdbxweb.Consts.ErrorCodes;
  if (code === codes.InvalidKey) return new Error("Wrong master password or key file.");
  if (code === codes.BadSignature || code === codes.InvalidVersion) return new Error("This is not a KeePass database, or its version is not supported.");
  if (code === codes.Unsupported) return new Error("This database uses a feature Corvus does not support.");
  if (code === codes.FileCorrupt) return new Error("The database file is damaged.");
  const message = err instanceof Error ? err.message : String(err);
  return new Error(/argon2/i.test(message) ? message : "Could not open the database.");
}

async function credentialsFor(kdbxweb: KdbxwebModule, password: string, keyFile: Uint8Array | null): Promise<Kdbxweb.KdbxCredentials> {
  if (!password && !keyFile) throw new Error("Enter the master password or choose the key file.");
  const credentials = new kdbxweb.Credentials(password ? kdbxweb.ProtectedValue.fromString(password) : null, keyFile ? arrayBufferOf(keyFile) : null);
  await credentials.ready;
  return credentials;
}

function text(value: Kdbxweb.KdbxEntryField | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.getText();
}

function groupPath(group: Kdbxweb.KdbxGroup | undefined): string {
  const names: string[] = [];
  for (let g = group; g?.parentGroup; g = g.parentGroup) names.unshift(g.name ?? "");
  return names.filter(Boolean).join(" / ");
}

/** Decrypts a database file in memory. */
async function loadDb(kdbxweb: KdbxwebModule, data: Uint8Array, password: string, keyFile: Uint8Array | null): Promise<Kdbxweb.Kdbx> {
  const credentials = await credentialsFor(kdbxweb, password, keyFile);
  try {
    return await kdbxweb.Kdbx.load(arrayBufferOf(data), credentials);
  } catch (err) {
    throw openError(err, kdbxweb);
  }
}

/** Whether a group is the database's Recycle Bin or inside it (what is there counts as deleted). */
function inRecycleBin(db: Kdbxweb.Kdbx, group: Kdbxweb.KdbxGroup | undefined): boolean {
  const recycleBin = db.meta.recycleBinEnabled !== false ? db.meta.recycleBinUuid : undefined;
  if (!recycleBin || recycleBin.empty) return false;
  for (let g = group; g; g = g.parentGroup) if (g.uuid.equals(recycleBin)) return true;
  return false;
}

/** Decrypts a database and returns its logins (Recycle Bin excluded). */
export async function openKdbx(data: Uint8Array, password: string, keyFile: Uint8Array | null): Promise<OpenedDatabase> {
  const kdbxweb = await loadKdbxweb();
  const db = await loadDb(kdbxweb, data, password, keyFile);
  const entries: KeePassEntry[] = [];
  for (const root of db.groups) {
    for (const entry of root.allEntries()) {
      if (inRecycleBin(db, entry.parentGroup)) continue;
      const field = (name: string): string => text(entry.fields.get(name));
      const urls = [field("URL"), ...additionalUrlFields(entry.fields.keys()).map(field)].map((u) => u.trim()).filter(Boolean);
      const totp = totpFromFields(field);
      entries.push({
        uuid: entry.uuid.id,
        title: field("Title"),
        username: field("UserName"),
        password: field("Password"),
        urls,
        notes: field("Notes"),
        ...(totp ? { totp } : {}),
        group: groupPath(entry.parentGroup),
        modified: entry.times.lastModTime?.getTime() ?? 0,
      });
    }
  }
  const groups: string[] = [""];
  for (const root of db.groups) {
    for (const group of root.allGroups()) {
      if (group === root || inRecycleBin(db, group)) continue;
      const p = groupPath(group);
      if (p) groups.push(p);
    }
  }
  return { name: db.meta.name ?? "", entries, groups: [...new Set(groups)].sort((a, b) => a.localeCompare(b)) };
}

/**
 * Opens a database, adds or changes one entry (an edit keeps the previous version in the entry's
 * history, as KeePass does) and returns the file to write.
 */
export async function saveKdbxEntry(data: Uint8Array, password: string, keyFile: Uint8Array | null, input: EntryInput): Promise<{ data: Uint8Array; uuid: string }> {
  const kdbxweb = await loadKdbxweb();
  const db = await loadDb(kdbxweb, data, password, keyFile);
  const root = db.getDefaultGroup();
  let entry: Kdbxweb.KdbxEntry | undefined;
  if (input.uuid) {
    for (const e of root.allEntries()) if (e.uuid.id === input.uuid) entry = e;
    if (!entry) throw new Error(tr("The entry is no longer in the database."));
    entry.pushHistory();
  } else {
    let group = root;
    for (const g of root.allGroups()) if (groupPath(g) === input.group) group = g;
    entry = db.createEntry(group);
  }
  entry.fields.set("Title", input.title);
  entry.fields.set("UserName", input.username);
  entry.fields.set("URL", input.url);
  entry.fields.set("Notes", input.notes);
  if (input.password !== undefined) entry.fields.set("Password", kdbxweb.ProtectedValue.fromString(input.password));
  if (input.totp !== undefined) writeTotp(kdbxweb, entry, input.totp);
  entry.times.update();
  const saved = await db.save();
  return { data: new Uint8Array(saved), uuid: entry.uuid.id };
}

/**
 * Opens a database and deletes one entry as KeePass does: into the database's Recycle Bin (made if it
 * has none yet), or for good when the database has the Recycle Bin turned off. Returns the file to
 * write and whether the entry went to the Recycle Bin.
 */
export async function deleteKdbxEntry(data: Uint8Array, password: string, keyFile: Uint8Array | null, uuid: string): Promise<{ data: Uint8Array; recycled: boolean }> {
  const kdbxweb = await loadKdbxweb();
  const db = await loadDb(kdbxweb, data, password, keyFile);
  const entry = [...db.getDefaultGroup().allEntries()].find((e) => e.uuid.id === uuid && !inRecycleBin(db, e.parentGroup));
  if (!entry) throw new Error(tr("The entry is no longer in the database."));
  const recycled = db.meta.recycleBinEnabled !== false;
  if (recycled) {
    db.createRecycleBin();
    db.move(entry, db.getGroup(db.meta.recycleBinUuid!));
  } else {
    db.move(entry, null);
  }
  return { data: new Uint8Array(await db.save()), recycled };
}

/** A 2FA for an entry of a database, by the entry's uuid; null removes the entry's 2FA. */
export interface EntryTotp {
  uuid: string;
  totp: TotpConfig | null;
}

/**
 * Gives an entry its 2FA, or removes it (null). Written as KeePassXC does, an otpauth:// link in the
 * "otp" field named after the entry's title and username; an entry that also keeps the 2FA in KeePass
 * 2's TimeOtp-* fields or KeePassXC's older "TOTP Seed" pair gets those changed too, so every app that
 * opens it shows the same code (or none).
 */
function writeTotp(kdbxweb: KdbxwebModule, entry: Kdbxweb.KdbxEntry, totp: TotpConfig | null): void {
  const fields = [...entry.fields.keys()];
  if (!totp) {
    for (const f of fields) if (f === "otp" || f === "TOTP Seed" || f === "TOTP Settings" || f.startsWith("TimeOtp-")) entry.fields.delete(f);
    return;
  }
  const uri = buildOtpauthUri(totp, { issuer: text(entry.fields.get("Title")), account: text(entry.fields.get("UserName")) });
  entry.fields.set("otp", kdbxweb.ProtectedValue.fromString(uri));
  if (fields.some((f) => f.startsWith("TimeOtp-Secret"))) {
    for (const f of fields) if (f.startsWith("TimeOtp-Secret")) entry.fields.delete(f);
    setTimeOtp(kdbxweb, entry, totp);
  }
  if (fields.includes("TOTP Seed")) {
    entry.fields.set("TOTP Seed", kdbxweb.ProtectedValue.fromString(totp.secret));
    entry.fields.set("TOTP Settings", `${totp.period};${totp.digits}`);
  }
}

/**
 * Opens a database, gives entries their 2FA or removes it (see writeTotp; each edit keeps the previous
 * version in the entry's history) and returns the file to write.
 */
export async function setKdbxTotps(data: Uint8Array, password: string, keyFile: Uint8Array | null, changes: readonly EntryTotp[]): Promise<Uint8Array> {
  const kdbxweb = await loadKdbxweb();
  const db = await loadDb(kdbxweb, data, password, keyFile);
  const wanted = new Map(changes.map((c) => [c.uuid, c.totp]));
  const done = new Set<string>();
  for (const entry of db.getDefaultGroup().allEntries()) {
    const totp = wanted.get(entry.uuid.id);
    if (totp === undefined || done.has(entry.uuid.id)) continue;
    done.add(entry.uuid.id);
    entry.pushHistory();
    writeTotp(kdbxweb, entry, totp);
    entry.times.update();
  }
  if (done.size !== wanted.size) throw new Error(tr("The entry is no longer in the database."));
  return new Uint8Array(await db.save());
}

export interface ExportEntry {
  title: string;
  username: string;
  password: string;
  url: string;
  notes?: string;
  totp?: TotpConfig;
}

export interface CreateKdbxOptions {
  name?: string;
  /** 4 (default, Argon2) or 3 (KDBX 3.1, AES-KDF). */
  version?: 3 | 4;
  /** KDBX 4 key derivation. Default Argon2id. */
  kdf?: "argon2id" | "argon2d";
  /** Argon2 memory in KiB (default 64 MiB) and passes (default 3). Tests pass small values. */
  memoryKiB?: number;
  iterations?: number;
  /** KDBX 3.1 AES-KDF rounds (default kdbxweb's 300000). */
  aesRounds?: number;
  keyFile?: Uint8Array | null;
  /** Which 2FA fields to write: both (default), KeePassXC `otp` only, or KeePass 2 `TimeOtp-*` only. */
  totpFields?: "both" | "keepassxc" | "keepass2";
}

/** Built-in saved logins as KeePass entries (title = host, URL = origin), sorted by title. */
export function vaultExportEntries(creds: Credential[]): ExportEntry[] {
  const title = (origin: string): string => {
    try {
      return new URL(origin).host || origin;
    } catch {
      return origin;
    }
  };
  return creds
    .map((c) => ({
      title: title(c.origin),
      username: c.username,
      password: c.password,
      url: c.origin,
      ...(c.notes ? { notes: c.notes } : {}),
      ...(c.totp ? { totp: c.totp } : {}),
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.username.localeCompare(b.username));
}

const TIMEOTP_ALGORITHM: Record<TotpConfig["algorithm"], string> = { SHA1: "HMAC-SHA-1", SHA256: "HMAC-SHA-256", SHA512: "HMAC-SHA-512" };

/** KeePass 2.47+ 2FA fields. */
function setTimeOtp(kdbxweb: KdbxwebModule, entry: Kdbxweb.KdbxEntry, totp: TotpConfig): void {
  entry.fields.set("TimeOtp-Secret-Base32", kdbxweb.ProtectedValue.fromString(totp.secret));
  entry.fields.set("TimeOtp-Algorithm", TIMEOTP_ALGORITHM[totp.algorithm]);
  entry.fields.set("TimeOtp-Length", String(totp.digits));
  entry.fields.set("TimeOtp-Period", String(totp.period));
}

/** Builds a new database in memory. Used by the vault export and by tests; never for user databases. */
export async function createKdbx(entries: ExportEntry[], password: string, opts: CreateKdbxOptions = {}): Promise<Uint8Array> {
  const kdbxweb = await loadKdbxweb();
  const credentials = await credentialsFor(kdbxweb, password, opts.keyFile ?? null);
  const db = kdbxweb.Kdbx.create(credentials, opts.name ?? "Corvus");
  if (opts.version === 3) {
    db.setVersion(3);
    if (opts.aesRounds) db.header.keyEncryptionRounds = opts.aesRounds;
  } else {
    db.setKdf(opts.kdf === "argon2d" ? kdbxweb.Consts.KdfId.Argon2d : kdbxweb.Consts.KdfId.Argon2id);
    const params = db.header.kdfParameters!;
    params.set("M", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from((opts.memoryKiB ?? 64 * 1024) * 1024));
    params.set("I", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(opts.iterations ?? 3));
    params.set("P", kdbxweb.VarDictionary.ValueType.UInt32, 1);
  }
  const group = db.getDefaultGroup();
  const fields = opts.totpFields ?? "both";
  for (const item of entries) {
    const entry = db.createEntry(group);
    entry.fields.set("Title", item.title);
    entry.fields.set("UserName", item.username);
    entry.fields.set("Password", kdbxweb.ProtectedValue.fromString(item.password));
    entry.fields.set("URL", item.url);
    if (item.notes) entry.fields.set("Notes", item.notes);
    if (item.totp) {
      if (fields !== "keepass2") {
        const uri = buildOtpauthUri(item.totp, { issuer: item.title, account: item.username });
        entry.fields.set("otp", kdbxweb.ProtectedValue.fromString(uri));
      }
      if (fields !== "keepassxc") setTimeOtp(kdbxweb, entry, item.totp);
    }
    entry.times.update();
  }
  return new Uint8Array(await db.save());
}

/** A random KeePass XML key file (version 2.0), for tests. */
export async function createKeyFile(): Promise<Uint8Array> {
  const kdbxweb = await loadKdbxweb();
  return kdbxweb.Credentials.createRandomKeyFile(2);
}
