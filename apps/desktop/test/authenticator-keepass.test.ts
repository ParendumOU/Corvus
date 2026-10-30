import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportAccount } from "../src/shared/authenticator-import";
import { base32Encode, parseOtpauthUri, type TotpConfig } from "../src/shared/totp";
import { importAccounts, type ImportLogins } from "../src/main/authenticator-import";
import { CredentialVault } from "../src/main/credential-store";
import { createKdbx, loadKdbxweb, openKdbx } from "../src/main/keepass-format";
import { KeePassStore, dbIdOf, type KeePassImportEntry } from "../src/main/keepass-store";
import type { SecretCipher } from "../src/main/settings-store";

vi.mock("electron", () => ({}));

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};
const FAST = { memoryKiB: 1024, iterations: 1 };

/** A made-up 20-byte secret per seed. */
const config = (seed: number, algorithm: TotpConfig["algorithm"] = "SHA1"): TotpConfig => ({ secret: base32Encode(Uint8Array.from({ length: 20 }, (_, i) => (seed * 43 + i * 17 + 9) & 0xff)), algorithm, digits: 6, period: 30 });
const account = (id: string, issuer: string, name: string, seed: number): ImportAccount => ({ id, issuer, account: name, config: config(seed) });

const dirs: string[] = [];
const stores: KeePassStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-ga-kp-"));
  dirs.push(dir);
  return dir;
}

/** A vault with one login, and an unlocked database: a GitHub entry without 2FA and one with KeePass 2's 2FA fields. */
async function setup(): Promise<{ logins: ImportLogins; vault: CredentialVault; store: KeePassStore; file: string; dbId: string; vaultLogin: string }> {
  const vault = new CredentialVault(tmp(), keychain);
  const vaultLogin = vault.add({ origin: "https://example.com", username: "alice", password: "pw-alice" }).id;
  const file = path.join(tmp(), "Personal.kdbx");
  const bytes = await createKdbx(
    [
      { title: "GitHub", username: "octocat", password: "kp-github", url: "https://github.com" },
      { title: "Legacy portal", username: "old-user", password: "kp-legacy", url: "legacy.example.org", totp: config(50) },
    ],
    "master",
    { ...FAST, totpFields: "keepass2" },
  );
  fs.writeFileSync(file, bytes);
  const store = new KeePassStore(tmp(), keychain, { watch: false });
  stores.push(store);
  store.addSources([file], "file");
  const dbId = dbIdOf(file);
  expect(await store.unlock(dbId, "master", null, false)).toEqual({ ok: true });
  return { logins: { vault, keepass: store }, vault, store, file, dbId, vaultLogin };
}

/** The raw fields of an entry, as KeePassXC and KeePass read them. */
async function rawFields(file: string, title: string): Promise<Record<string, string>> {
  const kdbxweb = await loadKdbxweb();
  const data = fs.readFileSync(file);
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("master"));
  await credentials.ready;
  const db = await kdbxweb.Kdbx.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, credentials);
  const found = [...db.getDefaultGroup().allEntries()].find((e) => e.fields.get("Title") === title)!;
  return Object.fromEntries([...found.fields.entries()].map(([k, v]) => [k, typeof v === "string" ? v : v.getText()]));
}

describe("importing 2FA into KeePass entries", () => {
  it("writes the ticked entries' 2FA as KeePassXC does, keeps a .bak copy, and fills the vault in the same import", async () => {
    const { logins, vault, store, file, vaultLogin } = await setup();
    const original = fs.readFileSync(file);
    const accounts = [account("a1", "GitHub", "octocat", 1), account("a2", "example.com", "alice", 2), account("a3", "Legacy", "old-user", 3)];
    const result = await importAccounts(logins, accounts, { a3: "legacy.example.org" }, ["a1", "a2", "a3"]);
    expect(result).toEqual({ attached: 1, created: 0, repaired: 0, keepass: 2, keepassFailed: [] });

    expect(vault.get(vaultLogin)?.totp).toEqual(config(2));
    expect(fs.readFileSync(`${file}.bak`).equals(original)).toBe(true);
    const opened = await openKdbx(fs.readFileSync(file), "master", null);
    expect(opened.entries.find((e) => e.title === "GitHub")).toMatchObject({ password: "kp-github", totp: config(1) });
    expect(opened.entries.find((e) => e.title === "Legacy portal")?.totp).toEqual(config(3));

    const github = await rawFields(file, "GitHub");
    expect(parseOtpauthUri(github.otp!)).toMatchObject({ issuer: "GitHub", account: "octocat", config: config(1) });
    expect(Object.keys(github).some((k) => k.startsWith("TimeOtp-"))).toBe(false);
    // The conflict ticked by hand: KeePass 2's fields change with the otp field, so both apps agree.
    const legacy = await rawFields(file, "Legacy portal");
    expect(parseOtpauthUri(legacy.otp!).config).toEqual(config(3));
    expect(legacy).toMatchObject({ "TimeOtp-Secret-Base32": config(3).secret, "TimeOtp-Algorithm": "HMAC-SHA-1", "TimeOtp-Length": "6", "TimeOtp-Period": "30" });

    // The store reloaded the file: autofill sees the new 2FA.
    const records = store.records();
    expect(records.find((r) => r.username === "octocat")?.totp).toEqual(config(1));
  });

  it("never writes a database file for rows that are not ticked", async () => {
    const { logins, file } = await setup();
    const before = fs.readFileSync(file);
    const result = await importAccounts(logins, [account("a1", "GitHub", "octocat", 1)], {}, []);
    expect(result).toEqual({ attached: 0, created: 0, repaired: 0, keepass: 0, keepassFailed: [] });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it("refuses before writing anything when a chosen row now goes elsewhere (the database was locked)", async () => {
    const { logins, vault, store, file, dbId } = await setup();
    const github = store.importEntries().find((e) => e.username === "octocat")!;
    const before = fs.readFileSync(file);
    const shown = new Map([["a1", `login:${github.id}`]]);
    store.lock(dbId);
    await expect(importAccounts(logins, [account("a1", "GitHub", "octocat", 1)], {}, ["a1"], shown)).rejects.toThrow(/different login than the list shows/);
    expect(vault.all()).toHaveLength(1);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("never writes to a KeePass entry the list did not show (a database unlocked after the preview)", async () => {
    const { logins, file } = await setup();
    const before = fs.readFileSync(file);
    const shown = new Map([["a1", "new:https://github.com octocat"]]);
    await expect(importAccounts(logins, [account("a1", "GitHub", "octocat", 1)], {}, ["a1"], shown)).rejects.toThrow(/different login than the list shows/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // A site typed just before the import, with no KeePass entry involved, still imports.
    const typed = await importAccounts(logins, [account("a2", "", "carol", 4)], { a2: "carol.example.net" }, ["a2"], new Map([["a2", "new:https://carol.example.org carol"]]));
    expect(typed).toMatchObject({ created: 1, keepass: 0 });
  });

  it("reports a database it could not write and imports the rest", async () => {
    const vault = new CredentialVault(tmp(), keychain);
    const entry: KeePassImportEntry = { id: "kp:db1:u1", dbId: "db1", uuid: "u1", dbName: "Work", title: "GitHub", username: "octocat", hasPassword: true, urls: ["https://github.com"], modified: 1, readOnly: false };
    const keepass = { importEntries: () => [entry], databases: () => [], setTotps: async () => Promise.reject(new Error("The database changed on disk")) };
    const result = await importAccounts({ vault, keepass }, [account("a1", "GitHub", "octocat", 1), account("a2", "Proton", "me@example.org", 2)], {}, ["a1", "a2"]);
    expect(result).toEqual({ attached: 0, created: 1, repaired: 0, keepass: 0, keepassFailed: [{ db: "Work", entries: 1, error: "The database changed on disk" }] });
  });

  it("lists the entries of unlocked databases only, with whether the file can be written", async () => {
    const { store, dbId } = await setup();
    expect(store.importEntries().map((e) => [e.dbName, e.title, e.username, e.readOnly])).toEqual([
      ["Personal", "GitHub", "octocat", false],
      ["Personal", "Legacy portal", "old-user", false],
    ]);
    store.lock(dbId);
    expect(store.importEntries()).toEqual([]);
  });
});
