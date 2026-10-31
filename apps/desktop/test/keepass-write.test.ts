import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKdbx, deleteKdbxEntry, loadKdbxweb, openKdbx, saveKdbxEntry, type ExportEntry } from "../src/main/keepass-format";
import { KeePassStore, dbIdOf } from "../src/main/keepass-store";
import type { SecretCipher } from "../src/main/settings-store";

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(Buffer.from(plain).map((b) => b ^ 0x5a)),
  decryptString: (enc) => Buffer.from(enc.map((b) => b ^ 0x5a)).toString(),
};
const FAST = { memoryKiB: 1024, iterations: 1, aesRounds: 1000 };
const ENTRIES: ExportEntry[] = [{ title: "Example", username: "alice", password: "kp-pass-1", url: "https://example.com" }];

const dirs: string[] = [];
const stores: KeePassStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-kpw-"));
  dirs.push(dir);
  return dir;
}

const TOTP = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };
const storeDirs = new Map<KeePassStore, string>();

/** A store (in its own folder) with the database at `file` added. */
function unlockedStore(file: string): KeePassStore {
  const dir = tmp();
  const s = new KeePassStore(dir, keychain, { watch: false });
  stores.push(s);
  storeDirs.set(s, dir);
  s.addSources([file], "file");
  return s;
}

/** Opens a database with kdbxweb itself, to look at what Corvus wrote. */
async function rawDb(data: Uint8Array) {
  const kdbxweb = await loadKdbxweb();
  return kdbxweb.Kdbx.load(new Uint8Array(data).buffer, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("master")));
}

/** An entry's fields as text, read straight from the file. */
async function kdbxFields(data: Uint8Array, uuid: string): Promise<Map<string, string>> {
  const db = await rawDb(data);
  const entry = [...db.getDefaultGroup().allEntries()].find((e) => e.uuid.id === uuid)!;
  return new Map([...entry.fields].map(([k, v]) => [k, typeof v === "string" ? v : v.getText()]));
}

describe("writing KeePass entries", () => {
  it("adds an entry and edits one, keeping the password when none is typed", async () => {
    const bytes = await createKdbx(ENTRIES, "master", FAST);
    const added = await saveKdbxEntry(bytes, "master", null, { group: "", title: "Bank", username: "carol", password: "s3cret", url: "https://bank.test", notes: "" });
    let db = await openKdbx(added.data, "master", null);
    expect(db.entries.map((e) => e.title).sort()).toEqual(["Bank", "Example"]);
    const example = db.entries.find((e) => e.title === "Example")!;
    const edited = await saveKdbxEntry(added.data, "master", null, { uuid: example.uuid, group: example.group, title: "Example renamed", username: "alice2", url: "https://example.com", notes: "n" });
    db = await openKdbx(edited.data, "master", null);
    const after = db.entries.find((e) => e.uuid === example.uuid)!;
    expect(after).toMatchObject({ title: "Example renamed", username: "alice2", password: "kp-pass-1", notes: "n" });
    await expect(saveKdbxEntry(edited.data, "wrong", null, { group: "", title: "x", username: "", url: "", notes: "" })).rejects.toThrow(/Wrong master password/);
  });

  it("keeps a .bak copy, writes the file, and refuses when another app changed it", async () => {
    const dir = tmp();
    const file = path.join(dir, "Vault.kdbx");
    fs.writeFileSync(file, await createKdbx(ENTRIES, "master", FAST));
    const original = fs.readFileSync(file);
    const s = new KeePassStore(tmp(), keychain, { watch: false });
    stores.push(s);
    s.addSources([file], "file");
    await s.refresh();
    const id = dbIdOf(file);
    expect(await s.unlock(id, "master", null, false)).toEqual({ ok: true });

    const entryId = await s.saveEntry(id, { group: "", title: "Bank", username: "carol", password: "s3cret", url: "https://bank.test", notes: "" });
    expect(entryId.startsWith("kp:")).toBe(true);
    expect(fs.readFileSync(`${file}.bak`).equals(original)).toBe(true);
    expect(s.entries().map((e) => e.title).sort()).toEqual(["Bank", "Example"]);
    expect(s.details(entryId)).toMatchObject({ title: "Bank", username: "carol", url: "https://bank.test" });

    // Another app saves the file: Corvus does not write over it.
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, await createKdbx([...ENTRIES, { title: "From KeePassXC", username: "", password: "x", url: "" }], "master", FAST));
    await expect(s.saveEntry(id, { group: "", title: "Lost?", username: "", url: "", notes: "" })).rejects.toThrow(/changed on disk/);
    expect((await openKdbx(fs.readFileSync(file), "master", null)).entries.some((e) => e.title === "From KeePassXC")).toBe(true);
  });

  it("overwrites an entry's 2FA from the edit form, keeping it when none is typed, in every field set it uses", async () => {
    const bytes = await createKdbx([{ ...ENTRIES[0]!, totp: TOTP }], "master", FAST);
    const [entry] = (await openKdbx(bytes, "master", null)).entries;
    const kept = await saveKdbxEntry(bytes, "master", null, { uuid: entry!.uuid, group: "", title: "Example", username: "alice@example.com", url: "https://login.example.com", notes: "" });
    expect((await openKdbx(kept.data, "master", null)).entries[0]).toMatchObject({ username: "alice@example.com", urls: ["https://login.example.com"], totp: TOTP });

    const next = { ...TOTP, secret: "KRSXG5CTMVRXEZLU", digits: 8 };
    const changed = await saveKdbxEntry(kept.data, "master", null, { uuid: entry!.uuid, group: "", title: "Example", username: "alice@example.com", url: "https://login.example.com", notes: "", totp: next });
    const fields = await kdbxFields(changed.data, entry!.uuid);
    expect((await openKdbx(changed.data, "master", null)).entries[0]!.totp).toEqual(next);
    // createKdbx writes KeePassXC's otp field and KeePass 2's TimeOtp-* fields: both now hold the new secret.
    expect(fields.get("otp")).toContain(`secret=${next.secret}`);
    expect(fields.get("TimeOtp-Secret-Base32")).toBe(next.secret);
    expect(fields.get("TimeOtp-Length")).toBe("8");
  });

  it("removes an entry's 2FA and keeps its password, with the old version in its history", async () => {
    const dir = tmp();
    const file = path.join(dir, "Vault.kdbx");
    fs.writeFileSync(file, await createKdbx([{ ...ENTRIES[0]!, totp: TOTP }], "master", FAST));
    const s = unlockedStore(file);
    await s.refresh();
    expect(await s.unlock(dbIdOf(file), "master", null, false)).toEqual({ ok: true });
    const [summary] = s.entries();
    await s.removeTotp(summary!.id);
    expect(s.entries()[0]).toMatchObject({ id: summary!.id, hasTotp: false, hasPassword: true });
    expect(s.get(summary!.id)?.password).toBe("kp-pass-1");
    const stored = [...(await rawDb(fs.readFileSync(file))).getDefaultGroup().allEntries()][0]!;
    expect([...stored.fields.keys()].filter((f) => f === "otp" || f.startsWith("TimeOtp-"))).toEqual([]);
    expect(stored.history.length).toBe(1);
    expect([...stored.history[0]!.fields.keys()]).toContain("otp");
  });

  it("keeps an entry's AI options in Corvus: setting them leaves the database file as it was", async () => {
    const dir = tmp();
    const file = path.join(dir, "Vault.kdbx");
    fs.writeFileSync(file, await createKdbx([{ ...ENTRIES[0]!, totp: TOTP }], "master", FAST));
    const s = unlockedStore(file);
    await s.refresh();
    expect(await s.unlock(dbIdOf(file), "master", null, false)).toEqual({ ok: true });
    const bytes = fs.readFileSync(file);
    const { mtimeMs } = fs.statSync(file);
    const [summary] = s.entries();

    expect(s.setOptIn(summary!.id, { signIn: true, totp: true })).toMatchObject({ agentSignIn: true, agentTotp: true });

    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeMs);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
    const [stored] = [...(await rawDb(bytes)).getDefaultGroup().allEntries()];
    expect(stored!.history).toEqual([]);
    s.flush();
    expect(Object.values(JSON.parse(fs.readFileSync(path.join(storeDirs.get(s)!, "keepass.json"), "utf8")).optIns)).toEqual([{ signIn: true, totp: true }]);
  });

  it("deletes an entry into the Recycle Bin, as KeePass does, after a .bak copy, and forgets its opt-ins", async () => {
    const dir = tmp();
    const file = path.join(dir, "Vault.kdbx");
    fs.writeFileSync(file, await createKdbx([...ENTRIES, { title: "Shop", username: "bob", password: "kp-pass-2", url: "https://shop.example.org" }], "master", FAST));
    const original = fs.readFileSync(file);
    const s = unlockedStore(file);
    await s.refresh();
    expect(await s.unlock(dbIdOf(file), "master", null, false)).toEqual({ ok: true });
    const example = s.entries().find((e) => e.title === "Example")!;
    s.setOptIn(example.id, { signIn: true });
    expect(await s.deleteEntry(example.id)).toBe(true);
    expect(fs.readFileSync(`${file}.bak`).equals(original)).toBe(true);
    expect(s.entries().map((e) => e.title)).toEqual(["Shop"]);
    expect(s.get(example.id)).toBeUndefined();
    const db = await rawDb(fs.readFileSync(file));
    const bin = db.getGroup(db.meta.recycleBinUuid!)!;
    expect([...bin.entries].map((e) => e.fields.get("Title"))).toEqual(["Example"]);
    s.flush();
    expect(JSON.parse(fs.readFileSync(path.join(storeDirs.get(s)!, "keepass.json"), "utf8")).optIns).toEqual({});
    await expect(s.deleteEntry(example.id)).rejects.toThrow(/no longer in the database/);
  });

  it("deletes an entry for good when the database has the Recycle Bin turned off", async () => {
    const noBin = await rawDb(await createKdbx(ENTRIES, "master", FAST));
    noBin.meta.recycleBinEnabled = false;
    const bytes = new Uint8Array(await noBin.save());
    const [entry] = (await openKdbx(bytes, "master", null)).entries;
    const done = await deleteKdbxEntry(bytes, "master", null, entry!.uuid);
    expect(done.recycled).toBe(false);
    const after = await rawDb(done.data);
    expect([...after.getDefaultGroup().allEntries()]).toEqual([]);
    expect(after.deletedObjects.map((d) => d.uuid?.id)).toContain(entry!.uuid);
  });
});
