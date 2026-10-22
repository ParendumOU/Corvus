import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialVault } from "../src/main/credential-store";
import type { SecretCipher } from "../src/main/settings-store";

/** Reversible stand-in for the OS keychain (same shape the sync e2e test uses). */
const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
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

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-vault-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("CredentialVault", () => {
  it("stores and lists logins", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const a = vault.add({ origin: "https://example.com/login", username: "alice", password: "pw1" });
    vault.add({ origin: "https://github.com", username: "dev", password: "pw2", notes: "work" });
    expect(a.origin).toBe("https://example.com");
    expect(vault.list().map((c) => c.username).sort()).toEqual(["alice", "dev"]);
    expect(vault.get(a.id)?.password).toBe("pw1");
    expect(vault.list("github")[0]?.hasNotes).toBe(true);
  });

  it("keeps no plaintext secret at rest and reloads", () => {
    const dir = tmp();
    const vault = new CredentialVault(dir, keychain);
    vault.add({ origin: "https://example.com", username: "alice", password: "sup3rsecret", notes: "my note" });
    vault.flush();

    const onDisk = fs.readFileSync(path.join(dir, "credentials.json"), "utf8");
    expect(onDisk).not.toContain("sup3rsecret");
    expect(onDisk).not.toContain("alice");
    expect(onDisk).not.toContain("my note");

    const reopened = new CredentialVault(dir, keychain);
    const got = reopened.all()[0];
    expect(got?.username).toBe("alice");
    expect(got?.password).toBe("sup3rsecret");
    expect(got?.notes).toBe("my note");
  });

  it("cannot be unsealed with a different key", () => {
    const dir = tmp();
    // A keychain that recovers a valid-length but wrong key (e.g. a different OS user/profile).
    const wrongKey: SecretCipher = {
      isEncryptionAvailable: () => true,
      encryptString: (p) => Buffer.from(`enc:${p}`),
      decryptString: () => Buffer.alloc(32, 7).toString("base64"),
    };
    const vault = new CredentialVault(dir, keychain);
    vault.add({ origin: "https://example.com", username: "alice", password: "pw" });
    vault.flush();
    // The wrong key can't unseal the entries, so they are dropped instead of leaking.
    const reopened = new CredentialVault(dir, wrongKey);
    expect(reopened.all()).toEqual([]);
  });

  it("matches logins by origin for autofill", () => {
    const vault = new CredentialVault(tmp(), keychain);
    vault.add({ origin: "https://example.com", username: "alice", password: "pw" });
    vault.add({ origin: "https://other.com", username: "bob", password: "pw" });
    expect(vault.matchesFor("https://example.com/login").map((m) => m.username)).toEqual(["alice"]);
    expect(vault.hasMatch("https://nope.com")).toBe(false);
    expect(vault.matchesFor("https://example.com/login")[0]).not.toHaveProperty("password");
  });

  it("saveOnSubmit creates, updates and dedupes", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const created = vault.saveOnSubmit("https://example.com/login", "alice", "pw1");
    const same = vault.saveOnSubmit("https://example.com/", "alice", "pw1");
    expect(same.id).toBe(created.id);
    expect(vault.all()).toHaveLength(1);
    const updated = vault.saveOnSubmit("https://example.com/", "alice", "pw2");
    expect(updated.id).toBe(created.id);
    expect(updated.password).toBe("pw2");
    vault.saveOnSubmit("https://example.com/", "bob", "pw3");
    expect(vault.all()).toHaveLength(2);
  });

  it("applies remote sync changes", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const now = Date.now();
    vault.applyRemote([
      { id: "r1", cred: { id: "r1", origin: "https://sync.example", username: "u", password: "p", createdAt: now, updatedAt: now } },
      { id: "bad", cred: { id: "bad", origin: "", username: "u", password: "p", createdAt: now, updatedAt: now } },
    ]);
    expect(vault.all().map((c) => c.id)).toEqual(["r1"]);
    vault.applyRemote([{ id: "r1", cred: null }]);
    expect(vault.all()).toEqual([]);
  });

  it("runs memory-only without a keychain and writes nothing to disk", () => {
    const dir = tmp();
    const vault = new CredentialVault(dir, noKeychain);
    expect(vault.secretsPersisted).toBe(false);
    vault.add({ origin: "https://example.com", username: "alice", password: "pw" });
    vault.flush();
    expect(vault.all()).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "credentials.json"))).toBe(false);
  });

  const TOTP = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };

  it("seals the 2FA secret and opt-ins at rest and reloads them", () => {
    const dir = tmp();
    const vault = new CredentialVault(dir, keychain);
    const c = vault.add({ origin: "https://example.com", username: "alice", password: "pw", totp: TOTP, agentTotp: true, agentSignIn: true });
    vault.flush();
    const onDisk = fs.readFileSync(path.join(dir, "credentials.json"), "utf8");
    expect(onDisk).not.toContain(TOTP.secret);
    expect(onDisk).not.toContain("agentTotp");
    const reopened = new CredentialVault(dir, keychain).get(c.id);
    expect(reopened?.totp).toEqual(TOTP);
    expect(reopened?.agentTotp).toBe(true);
    expect(reopened?.agentSignIn).toBe(true);
  });

  it("opt-ins default off and the 2FA opt-in needs a 2FA secret", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const plain = vault.add({ origin: "https://example.com", username: "a", password: "pw" });
    expect(plain.agentTotp).toBeUndefined();
    expect(plain.agentSignIn).toBeUndefined();
    const noSecret = vault.add({ origin: "https://example.com", username: "b", password: "pw", agentTotp: true });
    expect(noSecret.agentTotp).toBeUndefined();
    expect(vault.list().every((s) => !s.agentTotp && !s.agentSignIn)).toBe(true);
  });

  it("updates, keeps and removes the 2FA generator", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const c = vault.add({ origin: "https://example.com", username: "alice", password: "pw", totp: TOTP, agentTotp: true });
    const renamed = vault.update(c.id, { username: "alice2" });
    expect(renamed?.totp).toEqual(TOTP);
    expect(renamed?.agentTotp).toBe(true);
    const off = vault.update(c.id, { agentTotp: false });
    expect(off?.agentTotp).toBeUndefined();
    const removed = vault.update(c.id, { totp: null, agentTotp: true });
    expect(removed?.totp).toBeUndefined();
    expect(removed?.agentTotp).toBeUndefined();
    expect(vault.matchesFor("https://example.com/")[0]).toMatchObject({ hasTotp: false, source: "corvus" });
  });

  it("accepts synced logins with a 2FA generator and drops malformed ones", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const now = Date.now();
    vault.applyRemote([
      { id: "t1", cred: { id: "t1", origin: "https://sync.example", username: "u", password: "p", totp: TOTP, agentTotp: true, createdAt: now, updatedAt: now } },
      { id: "t2", cred: { id: "t2", origin: "https://sync.example", username: "v", password: "p", totp: { ...TOTP, algorithm: "MD5" as never }, createdAt: now, updatedAt: now } },
    ]);
    expect(vault.all().map((c) => c.id)).toEqual(["t1"]);
    expect(vault.get("t1")?.totp).toEqual(TOTP);
  });
});
