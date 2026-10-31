import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialVault } from "../src/main/credential-store";
import { historyMatches } from "../src/main/password-history";
import { credentialDeletionsAdapter, credentialsAdapter } from "../src/main/sync-adapters";
import type { SecretCipher } from "../src/main/settings-store";
import { isValidCredential } from "../src/shared/credentials";

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-history-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const O = "https://example.com";

describe("password history behind each login", () => {
  it("an edit retires the old password as a keyed hash, never in the clear", () => {
    const dir = tmp();
    const vault = new CredentialVault(dir, keychain);
    const c = vault.add({ origin: O, username: "ana", password: "first-pw" });
    vault.update(c.id, { password: "second-pw" });
    const after = vault.get(c.id)!;
    expect(after.password).toBe("second-pw");
    expect(historyMatches(after.passwordHistory ?? [], "first-pw")).toBe(true);
    vault.flush();
    // On disk the old password appears nowhere (history is inside the sealed secret).
    expect(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")).not.toContain("first-pw");
    // The history survives a reload.
    const reloaded = new CredentialVault(dir, keychain);
    expect(historyMatches(reloaded.get(c.id)!.passwordHistory ?? [], "first-pw")).toBe(true);
  });

  it("editing notes or removing the 2FA only retires nothing", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const c = vault.add({ origin: O, username: "ana", password: "pw", totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } });
    vault.update(c.id, { notes: "hello" });
    vault.update(c.id, { totp: null });
    expect(vault.get(c.id)!.passwordHistory).toBeUndefined();
  });

  it("autofill's save-on-submit update keeps the replaced password in history", () => {
    const vault = new CredentialVault(tmp(), keychain);
    vault.add({ origin: O, username: "ana", password: "before" });
    vault.saveOnSubmit(`${O}/login`, "ana", "after");
    expect(historyMatches(vault.findByLogin(O, "ana")!.passwordHistory ?? [], "before")).toBe(true);
  });
});

describe("import through the merge path", () => {
  it("re-importing the same logins twice adds and changes nothing", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const rows = [
      { origin: O, username: "ana", password: "pw-a", changedAt: 1000 },
      { origin: "https://example.org", username: "bob", password: "pw-b", changedAt: 1000 },
    ];
    expect(vault.importLogins(rows).tally.added).toBe(2);
    const before = JSON.stringify(vault.all());
    const second = vault.importLogins(rows);
    expect(second.tally).toEqual({ added: 0, updated: 0, alreadySaved: 2, olderLeftAlone: 0, deletedLeftOut: 0 });
    expect(JSON.stringify(vault.all())).toBe(before);
  });

  it("a password changed in Corvus is not overwritten by the browser's old copy", () => {
    const vault = new CredentialVault(tmp(), keychain);
    vault.importLogins([{ origin: O, username: "ana", password: "old-pw", changedAt: 1000 }]);
    const c = vault.findByLogin(O, "ana")!;
    vault.update(c.id, { password: "changed-in-corvus" });
    const again = vault.importLogins([{ origin: O, username: "ana", password: "old-pw", changedAt: 1000 }]);
    expect(again.tally.olderLeftAlone).toBe(1);
    expect(vault.findByLogin(O, "ana")!.password).toBe("changed-in-corvus");
    expect(vault.all()).toHaveLength(1);
  });

  it("a newer browser password updates the login; an older one is filed in history", () => {
    const vault = new CredentialVault(tmp(), keychain);
    vault.importLogins([{ origin: O, username: "ana", password: "v1", changedAt: 1000 }]);
    expect(vault.importLogins([{ origin: O, username: "ana", password: "v2", changedAt: 2000 }]).tally.updated).toBe(1);
    expect(vault.findByLogin(O, "ana")!.password).toBe("v2");
    expect(vault.importLogins([{ origin: O, username: "ana", password: "v0", changedAt: 500 }]).tally.olderLeftAlone).toBe(1);
    const c = vault.findByLogin(O, "ana")!;
    expect(c.password).toBe("v2");
    expect(historyMatches(c.passwordHistory ?? [], "v1")).toBe(true);
    expect(historyMatches(c.passwordHistory ?? [], "v0")).toBe(true);
  });

  it("an undated difference (CSV) is listed for review and only applied on confirmation", () => {
    const vault = new CredentialVault(tmp(), keychain);
    vault.add({ origin: O, username: "ana", password: "current" });
    const { tally, review } = vault.importLogins([{ origin: O, username: "ana", password: "from-csv" }]);
    expect(tally.updated).toBe(0);
    expect(review).toEqual([{ origin: O, username: "ana", password: "from-csv" }]);
    expect(vault.findByLogin(O, "ana")!.password).toBe("current");
    expect(vault.updatePasswordForLogin(O, "ana", "from-csv")).toBe(true);
    expect(vault.findByLogin(O, "ana")!.password).toBe("from-csv");
  });

  it("a login deleted in Corvus stays out while its password is unchanged", () => {
    const vault = new CredentialVault(tmp(), keychain);
    vault.importLogins([{ origin: O, username: "gone", password: "same-pw", changedAt: 1000 }]);
    vault.remove(vault.findByLogin(O, "gone")!.id);
    expect(vault.importLogins([{ origin: O, username: "gone", password: "same-pw", changedAt: 1000 }]).tally.deletedLeftOut).toBe(1);
    expect(vault.findByLogin(O, "gone")).toBeUndefined();
    // A different password for that login comes in as new.
    expect(vault.importLogins([{ origin: O, username: "gone", password: "new-pw", changedAt: 3000 }]).tally.added).toBe(1);
  });

  it("deleting a 2FA-only login leaves no deletion memory (nothing to recognise)", () => {
    const vault = new CredentialVault(tmp(), keychain);
    const c = vault.add({ origin: O, username: "ana", password: "", totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } });
    vault.remove(c.id);
    expect(vault.deletionItems()).toHaveLength(0);
  });
});

describe("sync of history and deleted-login memory", () => {
  it("histories merge by union when a remote copy of the login arrives", () => {
    const a = new CredentialVault(tmp(), keychain);
    const c = a.add({ origin: O, username: "ana", password: "p1" });
    a.update(c.id, { password: "p2" });
    const remote = { ...a.get(c.id)! };
    a.update(c.id, { password: "p3" }); // local knows p1, p2
    // Another device changed it independently: its history knows only p1.
    const b = new CredentialVault(tmp(), keychain);
    b.applyRemote([{ id: c.id, cred: remote }]);
    b.update(c.id, { password: "p4" }); // b knows p1, p2
    a.applyRemote([{ id: c.id, cred: b.get(c.id)! }]);
    const merged = a.get(c.id)!;
    expect(merged.password).toBe("p4");
    for (const pw of ["p1", "p2"]) expect(historyMatches(merged.passwordHistory ?? [], pw)).toBe(true);
  });

  it("an older client's login (no history fields) is still valid, and ours validate for it", () => {
    const old = { id: "x", origin: O, username: "u", password: "p", createdAt: 1, updatedAt: 1 };
    expect(isValidCredential(old)).toBe(true);
    const vault = new CredentialVault(tmp(), keychain);
    const c = vault.add({ origin: O, username: "u", password: "p" });
    vault.update(c.id, { password: "q" });
    expect(isValidCredential(vault.get(c.id))).toBe(true);
  });

  it("deleted-login memory syncs to another device and blocks the re-import there", async () => {
    const a = new CredentialVault(tmp(), keychain);
    const c = a.add({ origin: O, username: "gone", password: "same-pw" });
    a.remove(c.id);
    const b = new CredentialVault(tmp(), keychain);
    const items = await credentialDeletionsAdapter(a).list();
    await credentialDeletionsAdapter(b).apply(items.map((i) => ({ collection: "credential_deletions", id: i.id, payload: i.payload, deleted: false })));
    expect(b.importLogins([{ origin: O, username: "gone", password: "same-pw" }]).tally.deletedLeftOut).toBe(1);
    // Logins sync as before: the adapter lists the full record including its history.
    expect((await credentialsAdapter(b).list())).toHaveLength(0);
  });
});
