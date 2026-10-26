import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKdbx, openKdbx, saveKdbxEntry, type ExportEntry } from "../src/main/keepass-format";
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
});
