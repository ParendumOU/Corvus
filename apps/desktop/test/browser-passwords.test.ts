import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserImport } from "../src/main/browser-import";
import type { KeyProviders } from "../src/main/browser-keys";
import { PasswordReviews } from "../src/main/browser-passwords";
import { CredentialVault } from "../src/main/credential-store";
import type { ProfileRuntime } from "../src/main/profiles";
import type { SecretCipher } from "../src/main/settings-store";
import { writeBrowserFixtures } from "../src/main/smoke-import-fixtures";
import { FIXTURE_PASSWORDS, FIXTURE_SECRETS, FIXTURE_WINDOWS_PASSWORDS, fakeDpapi, writeWindowsFixtures } from "../src/main/smoke-password-fixtures";

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-browser-passwords-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const service = new BrowserImport();
  service.setTestRoots(writeBrowserFixtures(tempDir()));
  // No keyring: only Linux's fixed "v10" key opens values (the "v11" one stays locked).
  service.setTestKeyProviders({});
  let bigChanges = 0;
  const vault = new CredentialVault(tempDir(), keychain);
  const runtime = { credentials: vault, backup: { noteBigChange: () => bigChanges++ }, profile: { id: "p1" } } as unknown as ProfileRuntime;
  return { service, vault, runtime, bigChanges: () => bigChanges };
}

const { chromeMail, chromeShop, chromeAccount, firefoxForum } = FIXTURE_PASSWORDS;

// Each test copies real databases: seconds on a busy machine.
describe("passwords from other browsers", { timeout: 20_000 }, () => {
  it("counts rows without decrypting, and the ones the browser protects", async () => {
    const { service } = setup();
    const scan = await service.scan();
    const chrome = scan.sources.find((s) => s.id === "chrome")!.profiles.find((p) => p.dir === "Default")!;
    expect(chrome.counts.passwords).toBe(5);
    expect(chrome.protectedPasswords).toBe(1);
    expect(scan.sources.find((s) => s.id === "firefox")!.profiles[0]!.counts.passwords).toBe(2);
  });

  it("imports a Chromium profile: readable logins in, protected and skipped ones listed by site and username", async () => {
    const { service, vault, runtime } = setup();
    const result = await service.run(runtime, "chrome", "Default", ["passwords"]);
    const p = result.passwords!;
    expect({ added: p.added, updated: p.updated, alreadySaved: p.alreadySaved, protected: p.protected, skipped: p.skipped }).toEqual({ added: 3, updated: 0, alreadySaved: 0, protected: 2, skipped: 3 });
    for (const l of [chromeMail, chromeShop, chromeAccount]) expect(vault.findByLogin(l.origin, l.username)?.password).toBe(l.password);
    expect(p.notes.filter((n) => n.reason === "app-bound")).toEqual([{ site: "bank.example.com", username: "ana@example.com", reason: "app-bound" }]);
    expect(p.notes.filter((n) => n.reason === "keyring").map((n) => n.site)).toEqual(["keyring.example.com"]);
    expect(p.notes.filter((n) => ["android", "never-save", "federated"].includes(n.reason)).map((n) => n.reason).sort()).toEqual(["android", "federated", "never-save"]);
    expect(p.browser).toBe("Google Chrome");
    // No password reaches the result.
    const text = JSON.stringify(result);
    for (const secret of FIXTURE_SECRETS) expect(text).not.toContain(secret);
    // The browser's own change date is kept (the shop row had none: its last use stands in).
    expect(vault.findByLogin(chromeShop.origin, chromeShop.username)!.passwordChangedAt).toBeLessThan(Date.now() - 86_400_000);
  });

  it("imports Firefox (key4.db, no primary password) through the same merge", async () => {
    const { service, vault, runtime } = setup();
    await service.run(runtime, "chrome", "Default", ["passwords"]);
    const p = (await service.run(runtime, "firefox", "abcd1234.default-release", ["passwords"])).passwords!;
    expect({ added: p.added, alreadySaved: p.alreadySaved, skipped: p.skipped }).toEqual({ added: 1, alreadySaved: 1, skipped: 1 });
    expect(vault.findByLogin(firefoxForum.origin, firefoxForum.username)?.password).toBe(firefoxForum.password);
  });

  it("re-importing adds nothing and changes nothing", async () => {
    const { service, vault, runtime } = setup();
    await service.run(runtime, "chrome", "Default", ["passwords"]);
    const before = JSON.stringify(vault.all());
    const again = (await service.run(runtime, "chrome", "Default", ["passwords"])).passwords!;
    expect({ added: again.added, updated: again.updated, alreadySaved: again.alreadySaved }).toEqual({ added: 0, updated: 0, alreadySaved: 3 });
    expect(JSON.stringify(vault.all())).toBe(before);
  });

  it("a login deleted in Corvus, or changed there since, does not come back or get overwritten", async () => {
    const { service, vault, runtime } = setup();
    await service.run(runtime, "chrome", "Default", ["passwords"]);
    vault.remove(vault.findByLogin(chromeMail.origin, chromeMail.username)!.id);
    const account = vault.findByLogin(chromeAccount.origin, chromeAccount.username)!;
    vault.update(account.id, { password: "changed-in-corvus" });
    const p = (await service.run(runtime, "chrome", "Default", ["passwords"])).passwords!;
    expect({ added: p.added, deletedLeftOut: p.deletedLeftOut, olderLeftAlone: p.olderLeftAlone }).toEqual({ added: 0, deletedLeftOut: 1, olderLeftAlone: 1 });
    expect(vault.findByLogin(chromeMail.origin, chromeMail.username)).toBeUndefined();
    expect(vault.findByLogin(chromeAccount.origin, chromeAccount.username)!.password).toBe("changed-in-corvus");
    expect(p.notes.filter((n) => n.reason === "deleted" || n.reason === "older").map((n) => n.reason).sort()).toEqual(["deleted", "older"]);
  });
});

describe("review of undated differences", () => {
  it("keeps the passwords in the main process and hands each out once, for its own profile", () => {
    let now = 0;
    const reviews = new PasswordReviews(() => now);
    const token = reviews.add("p1", [
      { origin: "https://a.example.com", username: "a", password: "pa" },
      { origin: "https://b.example.com", username: "b", password: "pb" },
    ])!;
    expect(reviews.take("other", token, "all")).toEqual([]);
    expect(reviews.take("p1", token, [1]).map((i) => i.username)).toEqual(["b"]);
    expect(reviews.take("p1", token, [1])).toEqual([]);
    now = 31 * 60_000;
    expect(reviews.take("p1", token, "all")).toEqual([]);
    expect(reviews.add("p1", [])).toBeUndefined();
  });
});

describe("passwords on Windows, through the DPAPI worker", () => {
  function windows(dpapi: KeyProviders["dpapi"]) {
    const root = tempDir();
    const service = new BrowserImport();
    service.setTestRoots(writeWindowsFixtures(root, Date.now()));
    let closed = 0;
    service.setTestKeyProviders({ ...(dpapi ? { dpapi } : {}), close: () => closed++ });
    const vault = new CredentialVault(tempDir(), keychain);
    const runtime = { credentials: vault, backup: { noteBigChange: () => {} }, profile: { id: "p1" } } as unknown as ProfileRuntime;
    return { root, service, vault, runtime, closed: () => closed };
  }
  const { current, old } = FIXTURE_WINDOWS_PASSWORDS;

  it("unwraps the key and the rows from before v10, and ends the worker", async () => {
    const asked: number[] = [];
    const { service, vault, runtime, closed } = windows(async (blob) => {
      asked.push(blob.length);
      return fakeDpapi(blob);
    });
    const p = (await service.run(runtime, "brave", "Default", ["passwords"])).passwords!;
    expect({ added: p.added, protected: p.protected, locked: p.locked }).toEqual({ added: 2, protected: 0, locked: 0 });
    expect(vault.findByLogin(current.origin, current.username)?.password).toBe(current.password);
    expect(vault.findByLogin(old.origin, old.username)?.password).toBe(old.password);
    expect(asked).toHaveLength(2); // the key once, the old row once: not once per login
    expect(closed()).toBe(1);
  });

  it("when the worker gives nothing, the logins count as protected, and the result says Corvus could not read them", async () => {
    const { service, vault, runtime, closed } = windows(async () => null);
    const result = await service.run(runtime, "brave", "Default", ["passwords"]);
    const p = result.passwords!;
    expect({ added: p.added, protected: p.protected, locked: p.locked, errors: result.errors }).toEqual({ added: 0, protected: 2, locked: 2, errors: {} });
    expect(p.notes.map((n) => n.reason)).toEqual(["keyring", "keyring"]);
    expect(p.browser).toBe("Brave");
    expect(vault.all()).toHaveLength(0);
    expect(closed()).toBe(1);
  });

  it("a key of the wrong size is dropped, not used", async () => {
    const { service, runtime } = windows(async (blob) => (blob.length === 32 ? Buffer.alloc(16, 1) : null));
    expect((await service.run(runtime, "brave", "Default", ["passwords"])).passwords!.locked).toBe(2);
  });

  it("the worker ends when the reading fails too", async () => {
    const { root, service, runtime, closed } = windows(async (blob) => fakeDpapi(blob));
    fs.writeFileSync(path.join(root, "AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data", "Default", "Login Data"), "not a database");
    const result = await service.run(runtime, "brave", "Default", ["passwords"]);
    expect(result.errors.passwords).toBeTruthy();
    expect(closed()).toBe(1);
  });
});
