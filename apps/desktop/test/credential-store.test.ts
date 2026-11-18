import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialVault } from "../src/main/credential-store";
import { LoginSources, vaultProvider } from "../src/main/login-sources";
import { isProfileLocked } from "../src/main/profile-lock";
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

const logins = (vault: CredentialVault): LoginSources => new LoginSources(() => [vaultProvider(vault)]);

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

  it("applies a batch of changes with one change event, and stores them", () => {
    const dir = tmp();
    const vault = new CredentialVault(dir, keychain);
    const first = vault.add({ origin: "https://github.com", username: "octocat", password: "pw" });
    let events = 0;
    vault.changes.on(() => events++);
    const totp = { secret: "JBSWY3DPEHPK3PXPJBSWY3DP", algorithm: "SHA1" as const, digits: 6, period: 30 };
    vault.batch(() => {
      vault.update(first.id, { totp });
      for (let i = 0; i < 50; i++) vault.add({ origin: "https://example.com", username: `user${i}`, password: "", totp });
    });
    expect(events).toBe(1);
    vault.flush();
    const reopened = new CredentialVault(dir, keychain);
    expect(reopened.all()).toHaveLength(51);
    expect(reopened.get(first.id)?.totp).toEqual(totp);
    expect(reopened.all().filter((c) => c.password === "" && c.totp?.secret === totp.secret)).toHaveLength(50);
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
    // The wrong key can't unseal the entries: the vault reads as locked, nothing leaks or is dropped.
    const before = fs.readFileSync(path.join(dir, "credentials.json"), "utf8");
    const reopened = new CredentialVault(dir, wrongKey);
    expect(() => reopened.all()).toThrow(/keychain/);
    expect(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")).toBe(before);
  });

  it("matches logins by origin for autofill", () => {
    const vault = new CredentialVault(tmp(), keychain);
    vault.add({ origin: "https://example.com", username: "alice", password: "pw" });
    vault.add({ origin: "https://other.com", username: "bob", password: "pw" });
    expect(logins(vault).matchesFor("https://example.com/login").map((m) => m.username)).toEqual(["alice"]);
    expect(logins(vault).matchesFor("https://nope.com")).toEqual([]);
    expect(logins(vault).matchesFor("https://example.com/login")[0]).not.toHaveProperty("password");
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

  it("never empties a vault the keychain cannot open: it reads as locked and the file stays", () => {
    const dir = tmp();
    const vault = new CredentialVault(dir, keychain);
    vault.add({ origin: "https://example.com", username: "alice", password: "pw" });
    vault.add({ origin: "https://example.org", username: "bob", password: "pw2" });
    vault.flush();
    const file = path.join(dir, "credentials.json");
    const before = fs.readFileSync(file, "utf8");
    const failing: SecretCipher = { ...keychain, decryptString: () => { throw new Error("keyring locked"); } };
    for (const cipher of [failing, noKeychain]) {
      const closed = new CredentialVault(dir, cipher);
      let error: unknown;
      try {
        closed.all();
      } catch (err) {
        error = err;
      }
      expect(isProfileLocked(error)).toBe(true);
      closed.flush();
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    }
    expect(new CredentialVault(dir, keychain).all().map((c) => c.username).sort()).toEqual(["alice", "bob"]);
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
    expect(logins(vault).matchesFor("https://example.com/")[0]).toMatchObject({ hasTotp: false, source: "corvus" });
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

describe("remembered usernames (a sign-in without a password)", () => {
  it("are kept once per site, whatever the case, and never next to a login of that name", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const first = vault.rememberUsername("https://example.com/signin", " ana@example.com ");
    expect(first).toMatchObject({ origin: "https://example.com", username: "ana@example.com", password: "" });
    expect(vault.rememberUsername("https://example.com/other", "ANA@example.com")).toBeNull();
    vault.add({ origin: "https://example.org", username: "bob@example.org", password: "pw" });
    expect(vault.rememberUsername("https://example.org", "bob@example.org")).toBeNull();
    expect(vault.rememberUsername("about:blank", "x@example.com")).toBeNull();
    expect(vault.rememberUsername("https://example.com", "  ")).toBeNull();
    expect(vault.all()).toHaveLength(2);
    // Nothing there to update: the save prompt treats a password for it as a new login.
    expect(vault.usernamesAt("https://example.com")).toEqual([]);
  });

  it("take the password saved for them later instead of making a second login", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const remembered = vault.rememberUsername("https://example.com", "ana@example.com")!;
    const saved = vault.saveOnSubmit("https://example.com/login", "Ana@example.com", "pw-1");
    expect(saved.id).toBe(remembered.id);
    expect(vault.all().map((c) => [c.username, c.password])).toEqual([["Ana@example.com", "pw-1"]]);
    expect(vault.usernamesAt("https://example.com")).toEqual(["Ana@example.com"]);
  });

  it("are offered on the site's pages like any login, without a password", () => {
    const vault = new CredentialVault(tmp(), keychain);
    vault.rememberUsername("https://example.com", "ana@example.com");
    const matches = logins(vault).matchesFor("https://example.com/login");
    expect(matches).toEqual([expect.objectContaining({ username: "ana@example.com", hasPassword: false, hasTotp: false })]);
    expect(vault.list()[0]).toMatchObject({ hasPassword: false, hasTotp: false });
  });

  it("survive a restart encrypted like the rest of the vault", () => {
    const dir = tmp();
    new CredentialVault(dir, keychain).rememberUsername("https://example.com", "ana@example.com");
    const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".json"))!), "utf8");
    expect(raw).not.toContain("ana@example.com");
    expect(new CredentialVault(dir, keychain).all().map((c) => c.username)).toEqual(["ana@example.com"]);
  });
});
