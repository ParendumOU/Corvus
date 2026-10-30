import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKdbx, createKeyFile, loadKdbxweb, openKdbx, vaultExportEntries, type ExportEntry } from "../src/main/keepass-format";
import { KeePassStore, dbIdOf } from "../src/main/keepass-store";
import { LoginSources } from "../src/main/login-sources";
import type { SecretCipher } from "../src/main/settings-store";
import type { Credential } from "../src/shared/credentials";

/** A keychain stand-in that really transforms the data (so plain text never shows up on disk). */
const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(Buffer.from(plain).map((b) => b ^ 0x5a)),
  decryptString: (enc) => Buffer.from(enc.map((b) => b ^ 0x5a)).toString(),
};
const noKeychain: SecretCipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("unavailable");
  },
  decryptString: () => {
    throw new Error("unavailable");
  },
};

const FAST = { memoryKiB: 1024, iterations: 1, aesRounds: 1000 };
const TOTP = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };
const ENTRIES: ExportEntry[] = [
  { title: "Example", username: "alice", password: "kp-pass-1", url: "https://example.com", totp: TOTP },
  { title: "Shop", username: "bob", password: "kp-pass-2", url: "shop.test", notes: "note" },
];

const dirs: string[] = [];
const stores: KeePassStore[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-kp-"));
  dirs.push(dir);
  return dir;
}
function store(dir: string, cipher = keychain, watch = false): KeePassStore {
  const s = new KeePassStore(dir, cipher, { watch, debounceMs: 50 });
  stores.push(s);
  return s;
}
async function writeDb(file: string, entries: ExportEntry[], password: string, opts: Parameters<typeof createKdbx>[2] = {}): Promise<string> {
  fs.writeFileSync(file, await createKdbx(entries, password, { ...FAST, ...opts }));
  return file;
}
const sha = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("openKdbx / createKdbx", () => {
  it("reads KDBX 4 (Argon2id) with the KeePassXC otp field", async () => {
    const db = await openKdbx(await createKdbx(ENTRIES, "master", { ...FAST, totpFields: "keepassxc" }), "master", null);
    expect(db.entries.map((e) => [e.title, e.username, e.password])).toEqual([
      ["Example", "alice", "kp-pass-1"],
      ["Shop", "bob", "kp-pass-2"],
    ]);
    expect(db.entries[0]!.totp).toEqual(TOTP);
    expect(db.entries[1]!.totp).toBeUndefined();
    expect(db.entries[1]!.notes).toBe("note");
  });

  it("reads KDBX 4 with Argon2d and KeePass 2 TimeOtp fields", async () => {
    const db = await openKdbx(await createKdbx(ENTRIES, "master", { ...FAST, kdf: "argon2d", totpFields: "keepass2" }), "master", null);
    expect(db.entries[0]!.totp).toEqual(TOTP);
  });

  it("reads KDBX 3.1 (AES-KDF)", async () => {
    const bytes = await createKdbx(ENTRIES, "master", { ...FAST, version: 3 });
    expect(bytes[10]).toBe(3); // major version byte of the KDBX header
    const db = await openKdbx(bytes, "master", null);
    expect(db.entries.map((e) => e.password)).toEqual(["kp-pass-1", "kp-pass-2"]);
    expect(db.entries[0]!.totp).toEqual(TOTP);
  });

  it("uses a key file with or without a password (KDBX 3.1 and 4)", async () => {
    const keyFile = await createKeyFile();
    for (const version of [3, 4] as const) {
      const both = await createKdbx(ENTRIES, "master", { ...FAST, version, keyFile });
      expect((await openKdbx(both, "master", keyFile)).entries).toHaveLength(2);
      await expect(openKdbx(both, "master", null)).rejects.toThrow("Wrong master password or key file.");
      const keyOnly = await createKdbx(ENTRIES, "", { ...FAST, version, keyFile });
      expect((await openKdbx(keyOnly, "", keyFile)).entries).toHaveLength(2);
    }
  });

  it("explains a wrong password and a file that is not a database", async () => {
    const bytes = await createKdbx(ENTRIES, "master", FAST);
    await expect(openKdbx(bytes, "nope", null)).rejects.toThrow("Wrong master password or key file.");
    await expect(openKdbx(new TextEncoder().encode("This is a plain text file, not a password database."), "x", null)).rejects.toThrow(/not a KeePass database/);
    await expect(openKdbx(new TextEncoder().encode("hi"), "x", null)).rejects.toThrow(/damaged/);
    await expect(openKdbx(bytes, "", null)).rejects.toThrow(/master password or choose the key file/);
  });

  it("skips entries in the Recycle Bin", async () => {
    const kdbxweb = await loadKdbxweb();
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("m")), "T");
    db.header.kdfParameters!.set("M", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1024 * 1024));
    db.header.kdfParameters!.set("I", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1));
    const live = db.createEntry(db.getDefaultGroup());
    live.fields.set("Title", "Live");
    db.createRecycleBin();
    const bin = db.getGroup(db.meta.recycleBinUuid!)!;
    db.createEntry(bin).fields.set("Title", "Deleted");
    const opened = await openKdbx(new Uint8Array(await db.save()), "m", null);
    expect(opened.entries.map((e) => e.title)).toEqual(["Live"]);
  });
});

describe("KeePassStore", () => {
  it("is off until a database is added, then unlocks and serves logins by URL", async () => {
    const dir = tmp();
    const file = await writeDb(path.join(dir, "Personal.kdbx"), ENTRIES, "master");
    const kp = store(dir);
    expect(kp.configured).toBe(false);
    kp.addSources([file], "file");
    expect(kp.databases()).toMatchObject([{ name: "Personal", status: "locked", entryCount: 0 }]);
    const id = dbIdOf(file);

    expect(await kp.unlock(id, "wrong", null, false)).toEqual({ ok: false, error: "Wrong master password or key file." });
    expect(kp.databases()[0]).toMatchObject({ status: "locked", error: "Wrong master password or key file." });
    expect(await kp.unlock(id, "master", null, false)).toEqual({ ok: true });
    expect(kp.databases()[0]).toMatchObject({ status: "unlocked", entryCount: 2, error: null, remembered: false });

    const logins = new LoginSources(() => [kp.provider()]);
    const matches = logins.matchesFor("https://example.com/login");
    expect(matches).toEqual([{ id: `kp:${id}:${matches[0]!.id.split(":")[2]}`, username: "alice", site: "example.com", hasPassword: true, hasTotp: true, source: "keepass", sourceName: "Personal", fit: "exact" }]);
    expect(logins.matchesFor("https://www.shop.test/")[0]?.username).toBe("bob");
    expect(logins.matchesFor("https://other.test/")).toEqual([]);
    expect(logins.get(matches[0]!.id)?.password).toBe("kp-pass-1");
    expect(logins.forPage(matches[0]!.id, "https://shop.test/")).toBeUndefined();
    expect(kp.entries("shop").map((e) => e.title)).toEqual(["Shop"]);
    expect(JSON.stringify(kp.entries(""))).not.toContain("kp-pass");
  });

  it("locking drops the decrypted entries", async () => {
    const dir = tmp();
    const file = await writeDb(path.join(dir, "a.kdbx"), ENTRIES, "master");
    const kp = store(dir);
    kp.addSources([file], "file");
    await kp.unlock(dbIdOf(file), "master", null, false);
    const id = kp.provider().matches("https://example.com/")[0]!.id;
    kp.lock(null);
    expect(kp.databases()[0]).toMatchObject({ status: "locked", entryCount: 0 });
    expect(kp.provider().matches("https://example.com/")).toEqual([]);
    expect(kp.get(id)).toBeUndefined();
    expect(kp.entries()).toEqual([]);
  });

  it("unlocks with a key file read from disk", async () => {
    const dir = tmp();
    const keyFile = await createKeyFile();
    const keyPath = path.join(dir, "db.keyx");
    fs.writeFileSync(keyPath, keyFile);
    const file = await writeDb(path.join(dir, "k.kdbx"), ENTRIES, "master", { keyFile, version: 3 });
    const kp = store(dir);
    kp.addSources([file], "file");
    expect(await kp.unlock(dbIdOf(file), "master", null, false)).toMatchObject({ ok: false });
    expect(await kp.unlock(dbIdOf(file), "master", path.join(dir, "missing.keyx"), false)).toEqual({ ok: false, error: "Could not read the key file." });
    expect(await kp.unlock(dbIdOf(file), "master", keyPath, false)).toEqual({ ok: true });
  });

  it("keeps a database unlocked across restarts with the keychain, never in plain text", async () => {
    const dir = tmp();
    const keyPath = path.join(dir, "secret-key-file.keyx");
    const keyFile = await createKeyFile();
    fs.writeFileSync(keyPath, keyFile);
    const file = await writeDb(path.join(dir, "kept.kdbx"), ENTRIES, "very-secret-master", { keyFile });
    const first = store(dir);
    first.addSources([file], "file");
    expect(await first.unlock(dbIdOf(file), "very-secret-master", keyPath, true)).toEqual({ ok: true });
    expect(first.databases()[0]!.remembered).toBe(true);
    first.flush();
    const config = fs.readFileSync(path.join(dir, "keepass.json"), "utf8");
    expect(config).not.toContain("very-secret-master");
    expect(config).not.toContain("secret-key-file");
    first.dispose();

    const second = store(dir);
    expect(second.databases()[0]!.status).toBe("locked");
    await second.restoreRemembered();
    expect(second.databases()[0]).toMatchObject({ status: "unlocked", remembered: true });

    // Locking by hand forgets the kept password.
    second.lock(dbIdOf(file));
    second.flush();
    expect(second.databases()[0]!.remembered).toBe(false);
    const third = store(dir);
    await third.restoreRemembered();
    expect(third.databases()[0]!.status).toBe("locked");
  });

  it("refuses to keep a password without an OS keychain", async () => {
    const dir = tmp();
    const file = await writeDb(path.join(dir, "x.kdbx"), ENTRIES, "master");
    const kp = store(dir, noKeychain);
    kp.addSources([file], "file");
    expect(kp.canRemember).toBe(false);
    expect(await kp.unlock(dbIdOf(file), "master", null, true)).toMatchObject({ ok: false });
    expect(await kp.unlock(dbIdOf(file), "master", null, false)).toEqual({ ok: true });
  });

  it("auto-locks after the idle time, except databases kept unlocked", async () => {
    const dir = tmp();
    const a = await writeDb(path.join(dir, "a.kdbx"), ENTRIES, "master");
    const b = await writeDb(path.join(dir, "b.kdbx"), ENTRIES, "master");
    const kp = store(dir);
    kp.addSources([a, b], "file");
    await kp.unlock(dbIdOf(a), "master", null, false);
    await kp.unlock(dbIdOf(b), "master", null, true);
    expect(kp.autoLock(60, 0)).toBe(0); // 0 = never
    expect(kp.autoLock(14 * 60, 15)).toBe(0); // not idle long enough
    expect(kp.autoLock(15 * 60, 15)).toBe(1);
    const status = Object.fromEntries(kp.databases().map((d) => [d.name, d.status]));
    expect(status).toEqual({ a: "locked", b: "unlocked" });
  });

  it("scans a folder for .kdbx files and picks up new ones", async () => {
    const dir = tmp();
    const vaults = path.join(dir, "vaults");
    fs.mkdirSync(vaults);
    await writeDb(path.join(vaults, "one.kdbx"), ENTRIES, "m");
    fs.writeFileSync(path.join(vaults, "notes.txt"), "not a database");
    const kp = store(dir);
    kp.addSources([vaults], "folder");
    expect(kp.databases().map((d) => d.name)).toEqual(["one"]);
    expect(kp.sources()).toMatchObject([{ kind: "folder", databases: 1 }]);
    await writeDb(path.join(vaults, "two.KDBX"), ENTRIES, "m");
    await kp.refresh();
    expect(kp.databases().map((d) => d.name).sort()).toEqual(["one", "two"]);
    kp.removeSource(kp.sources()[0]!.id);
    expect(kp.databases()).toEqual([]);
  });

  it("re-reads an unlocked database when its file changes, and never writes to it", async () => {
    const dir = tmp();
    const file = await writeDb(path.join(dir, "live.kdbx"), ENTRIES, "master");
    const kp = store(dir, keychain, true);
    kp.addSources([file], "file");
    await kp.unlock(dbIdOf(file), "master", null, false);
    const before = sha(file);
    await kp.refresh();
    expect(sha(file)).toBe(before);

    // Saved elsewhere (e.g. KeePassXC): temp file + rename, like real editors do.
    const tmpFile = path.join(dir, "live.kdbx.tmp");
    await writeDb(tmpFile, [...ENTRIES, { title: "New", username: "carol", password: "kp-pass-3", url: "https://new.test" }], "master");
    fs.renameSync(tmpFile, file);
    expect(await until(() => kp.databases()[0]!.entryCount === 3)).toBe(true);
    expect(kp.provider().matches("https://new.test/")[0]?.username).toBe("carol");
  });

  it("locks with a message when the changed file no longer opens with the key", async () => {
    const dir = tmp();
    const file = await writeDb(path.join(dir, "rekeyed.kdbx"), ENTRIES, "master");
    const kp = store(dir);
    kp.addSources([file], "file");
    await kp.unlock(dbIdOf(file), "master", null, false);
    await writeDb(file, ENTRIES, "new-master");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await kp.refresh();
    expect(kp.databases()[0]).toMatchObject({ status: "locked" });
    expect(kp.databases()[0]!.error).toMatch(/changed on disk/);
  });

  it("keeps agent opt-ins per entry in Corvus; the 2FA opt-in needs a 2FA secret", async () => {
    const dir = tmp();
    const file = await writeDb(path.join(dir, "o.kdbx"), ENTRIES, "master");
    const kp = store(dir);
    kp.addSources([file], "file");
    await kp.unlock(dbIdOf(file), "master", null, false);
    const [alice, bob] = kp.entries();
    expect(kp.setOptIn(alice!.id, { totp: true, signIn: true })).toMatchObject({ agentTotp: true, agentSignIn: true });
    expect(kp.setOptIn(bob!.id, { totp: true })).toMatchObject({ agentTotp: false, agentSignIn: false });
    expect(kp.get(alice!.id)).toMatchObject({ agentTotp: true, agentSignIn: true });
    kp.flush();
    const reopened = store(dir);
    await reopened.unlock(dbIdOf(file), "master", null, false);
    expect(reopened.get(alice!.id)).toMatchObject({ agentTotp: true, agentSignIn: true });
    reopened.setOptIn(alice!.id, { totp: false, signIn: false });
    expect(reopened.get(alice!.id)).toMatchObject({ agentTotp: false, agentSignIn: false });
  });
});

describe("export of the built-in vault", () => {
  it("round-trips logins and 2FA through a new .kdbx with the default (strong) settings", async () => {
    const creds: Credential[] = [
      { id: "1", origin: "https://example.com", username: "alice", password: "vault-pw", notes: "hi", totp: TOTP, createdAt: 1, updatedAt: 2 },
      { id: "2", origin: "http://localhost:8080", username: "", password: "pw2", createdAt: 1, updatedAt: 2 },
    ];
    const entries = vaultExportEntries(creds);
    expect(entries.map((e) => e.title)).toEqual(["example.com", "localhost:8080"]);
    const bytes = await createKdbx(entries, "export-master");
    const db = await openKdbx(bytes, "export-master", null);
    expect(db.entries.map((e) => [e.title, e.username, e.password, e.urls[0], e.notes])).toEqual([
      ["example.com", "alice", "vault-pw", "https://example.com", "hi"],
      ["localhost:8080", "", "pw2", "http://localhost:8080", ""],
    ]);
    expect(db.entries[0]!.totp).toEqual(TOTP);
    await expect(openKdbx(bytes, "wrong", null)).rejects.toThrow("Wrong master password");
  }, 30_000);
});
