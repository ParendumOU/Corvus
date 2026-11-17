import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialVault } from "../src/main/credential-store";
import { SealedRecords, type SealedRecord } from "../src/main/sealed-records";
import type { SecretCipher } from "../src/main/settings-store";

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-unreadable-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Entries = { entries: Array<{ id: string; sealed: string }> };
const readFile = (file: string): Entries => JSON.parse(fs.readFileSync(file, "utf8")) as Entries;

/** Breaks the sealed bytes of entry `id` on disk (the key stays good: only that entry fails to open). */
function corrupt(file: string, id: string): string {
  const raw = readFile(file);
  const entry = raw.entries.find((e) => e.id === id)!;
  entry.sealed = `${entry.sealed.slice(0, -4)}${entry.sealed.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
  fs.writeFileSync(file, JSON.stringify(raw));
  return entry.sealed;
}

describe("a vault entry that does not open", () => {
  it("stays in credentials.json through later writes instead of being dropped", () => {
    const dir = tmp();
    const file = path.join(dir, "credentials.json");
    const first = new CredentialVault(dir, keychain);
    const broken = first.add({ origin: "https://a.example.com", username: "ann", password: "pw-a" });
    first.add({ origin: "https://b.example.com", username: "bob", password: "pw-b" });
    first.flush();
    const sealed = corrupt(file, broken.id);

    const vault = new CredentialVault(dir, keychain);
    expect(vault.all().map((c) => c.username)).toEqual(["bob"]);
    expect(vault.isUnreadable(broken.id)).toBe(true);
    vault.add({ origin: "https://c.example.com", username: "cat", password: "pw-c" });
    vault.flush();
    expect(readFile(file).entries.find((e) => e.id === broken.id)?.sealed).toBe(sealed);
    expect(vault.verify()).toBe(true);

    // Sync deleting it removes it for good.
    vault.applyRemote([{ id: broken.id, cred: null }]);
    expect(vault.isUnreadable(broken.id)).toBe(false);
    expect(readFile(file).entries.some((e) => e.id === broken.id)).toBe(false);
  });
});

interface Note extends SealedRecord {
  text: string;
}
const isNote = (v: unknown): v is Note => typeof (v as Note).text === "string";

describe("a sealed record that does not open", () => {
  it("stays in its file through later writes, until it is removed", () => {
    const dir = tmp();
    const file = path.join(dir, "notes.json");
    const first = new SealedRecords<Note>(dir, "notes.json", keychain, isNote);
    first.put([
      { id: "n1", record: { id: "n1", createdAt: 1, updatedAt: 1, text: "one" } },
      { id: "n2", record: { id: "n2", createdAt: 1, updatedAt: 1, text: "two" } },
    ]);
    first.flush();
    const sealed = corrupt(file, "n1");

    const records = new SealedRecords<Note>(dir, "notes.json", keychain, isNote);
    expect(records.all().map((n) => n.id)).toEqual(["n2"]);
    expect(records.isUnreadable("n1")).toBe(true);
    records.put([{ id: "n3", record: { id: "n3", createdAt: 2, updatedAt: 2, text: "three" } }]);
    records.flush();
    expect(readFile(file).entries.find((e) => e.id === "n1")?.sealed).toBe(sealed);
    expect(records.verify()).toBe(true);

    records.put([{ id: "n1", record: null }]);
    records.flush();
    expect(records.isUnreadable("n1")).toBe(false);
    expect(readFile(file).entries.map((e) => e.id).sort()).toEqual(["n2", "n3"]);
  });
});

describe("a deleted-login memory that does not open", () => {
  it("stays in credentials.json until sync removes it", () => {
    const dir = tmp();
    const file = path.join(dir, "credentials.json");
    const first = new CredentialVault(dir, keychain);
    first.add({ origin: "https://b.example.com", username: "bob", password: "pw-b" });
    first.remove(first.add({ origin: "https://a.example.com", username: "ann", password: "pw-a" }).id);
    first.flush();
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { deletions: Array<{ key: string; sealed: string }> };
    const memory = raw.deletions[0]!;
    memory.sealed = `${memory.sealed.slice(0, -4)}${memory.sealed.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    fs.writeFileSync(file, JSON.stringify(raw));

    const vault = new CredentialVault(dir, keychain);
    expect(vault.deletionItems()).toEqual([]);
    expect(vault.isUnreadableDeletion(memory.key)).toBe(true);
    vault.add({ origin: "https://c.example.com", username: "cat", password: "pw-c" });
    vault.flush();
    const deletionsOnDisk = (): Array<{ key: string; sealed: string }> => (JSON.parse(fs.readFileSync(file, "utf8")) as typeof raw).deletions;
    expect(deletionsOnDisk()).toEqual([expect.objectContaining({ key: memory.key, sealed: memory.sealed })]);

    vault.applyRemoteDeletions([{ id: memory.key, memory: null }]);
    expect(vault.isUnreadableDeletion(memory.key)).toBe(false);
    expect(deletionsOnDisk()).toEqual([]);
  });
});
