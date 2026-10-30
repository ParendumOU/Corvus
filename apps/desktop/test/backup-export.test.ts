import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base32Encode, type TotpConfig } from "../src/shared/totp";
import { BackupStore } from "../src/main/backup-store";
import { CredentialVault } from "../src/main/credential-store";
import { exportVaultToKdbx } from "../src/main/ipc-credentials";
import { openKdbx } from "../src/main/keepass-format";
import type { ProfileRuntime } from "../src/main/profiles";
import type { SecretCipher } from "../src/main/settings-store";

vi.mock("electron", () => ({ ipcMain: { on: () => undefined, handle: () => undefined } }));

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-backup-export-"));
  dirs.push(dir);
  return dir;
};

/** A made-up secret per seed. */
const totp = (seed: number, algorithm: TotpConfig["algorithm"] = "SHA1", digits = 6, period = 30): TotpConfig => ({
  secret: base32Encode(Uint8Array.from({ length: 20 }, (_, i) => (seed * 41 + i * 13 + 5) & 0xff)),
  algorithm,
  digits,
  period,
});

describe("Back up now (the vault's KeePass export)", () => {
  it("writes every login with its 2FA, 2FA-only logins too, and records the backup", async () => {
    const dir = tmp();
    const vault = new CredentialVault(dir, keychain);
    const backup = new BackupStore(dir);
    const configs = [totp(1), totp(2, "SHA256", 8), totp(3, "SHA512", 6, 60), totp(4)];
    vault.add({ origin: "https://central.example.com", username: "info@example.com", password: "pw-1", totp: configs[0] });
    vault.add({ origin: "https://central.example.com", username: "Portal - info@example.com", password: "", totp: configs[1] });
    vault.add({ origin: "https://example.org", username: "ops", password: "pw-3", notes: "note", totp: configs[2] });
    vault.add({ origin: "https://app.example.net:8443", username: "", password: "", totp: configs[3] });
    vault.add({ origin: "https://plain.example.com", username: "nobody", password: "pw-5" });
    for (let n = 0; n < 40; n++) vault.add({ origin: `https://svc${n}.example`, username: `user${n}@example.com`, password: "", totp: totp(100 + n) });
    const profile = { credentials: vault, backup } as unknown as ProfileRuntime;

    const file = path.join(dir, "Corvus passwords");
    const result = await exportVaultToKdbx(profile, file, "backup-master-1");
    expect(result).toEqual({ ok: true, path: `${file}.kdbx`, count: 45 });
    expect(backup.state()).toMatchObject({ changedSinceBackup: false, bigChange: false });
    expect(backup.state().lastBackupAt).toBeGreaterThan(0);

    const db = await openKdbx(new Uint8Array(fs.readFileSync(`${file}.kdbx`)), "backup-master-1", null);
    expect(db.entries).toHaveLength(45);
    for (const c of vault.all()) {
      const entry = db.entries.find((e) => e.urls[0] === c.origin && e.username === c.username);
      expect(entry, `${c.origin} ${c.username}`).toBeDefined();
      expect(entry!.password).toBe(c.password);
      expect(entry!.totp).toEqual(c.totp);
    }
    // Never over an existing file, and a failed export records nothing.
    const before = backup.state();
    expect((await exportVaultToKdbx(profile, file, "backup-master-1"))?.ok).toBe(false);
    expect(backup.state()).toEqual(before);
  }, 60_000);
});
