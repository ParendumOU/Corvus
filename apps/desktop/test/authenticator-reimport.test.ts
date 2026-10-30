import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportAccount } from "../src/shared/authenticator-import";
import { splitAccountName } from "../src/shared/authenticator-migration";
import { base32Encode, type TotpConfig } from "../src/shared/totp";
import { importAccounts } from "../src/main/authenticator-import";
import { CredentialVault } from "../src/main/credential-store";
import type { SecretCipher } from "../src/main/settings-store";

vi.mock("electron", () => ({}));


const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function vault(): CredentialVault {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-reimport-"));
  dirs.push(dir);
  return new CredentialVault(dir, keychain);
}

/** A made-up 20-byte secret per seed. */
const config = (seed: number): TotpConfig => ({ secret: base32Encode(Uint8Array.from({ length: 20 }, (_, i) => (seed * 37 + i * 11 + 3) & 0xff)), algorithm: "SHA1", digits: 6, period: 30 });

/** An account as an export holds it, read with today's label parsing. */
const account = (id: string, issuer: string, rawName: string, seed: number): ImportAccount => ({ id, ...splitAccountName(rawName, issuer), config: config(seed) });

describe("importAccounts on a vault an earlier import filled", () => {
  it("fixes the label-shaped entries, moves a 2FA to the login with a password, and leaves every typed site as it was", () => {
    const v = vault();
    // The first import (before the label fix): fifty accounts of unknown issuers, every site typed by the
    // person; ten names were "Issuer - address" and became the whole username.
    const raw = (n: number): string => (n < 10 ? `Intranet ${n} - user${n}@example.com` : `user${n}@example.com`);
    const earlier = Array.from({ length: 50 }, (_, n) => v.add({ origin: `https://app${n}.example.org`, username: raw(n), password: "", totp: config(n) }));
    // The owner's case: a login with a password, and the 2FA-only entry the first import made next to it.
    const real = v.add({ origin: "https://central.example.com", username: "info@example.com", password: "pw-central" });
    const old = v.add({ origin: "https://central.example.com", username: "Parendum Central - info@example.com", password: "", totp: config(99) });
    const before = new Map(v.all().map((c) => [c.id, JSON.stringify(c)]));

    const accounts = [...Array.from({ length: 50 }, (_, n) => account(`a${n}`, `Intranet ${n}`, raw(n), n)), account("a50", "Parendum Central", "Parendum Central - info@example.com", 99)];
    const result = importAccounts(v, accounts, {}, accounts.map((a) => a.id));

    expect(result).toEqual({ attached: 1, created: 0, repaired: 11 });
    for (const [n, c] of earlier.entries()) {
      const now = v.get(c.id)!;
      expect(now.origin).toBe(`https://app${n}.example.org`);
      expect(now.totp).toEqual(config(n));
      if (n < 10) expect(now.username).toBe(`user${n}@example.com`);
      else expect(JSON.stringify(now)).toBe(before.get(c.id));
    }
    expect(v.get(real.id)).toMatchObject({ origin: "https://central.example.com", username: "info@example.com", password: "pw-central", totp: config(99) });
    expect(v.get(old.id)).toBeUndefined();
    expect(v.all()).toHaveLength(51);

    // A third import of the same photos changes nothing.
    const snapshot = JSON.stringify(v.all());
    expect(importAccounts(v, accounts, {}, accounts.map((a) => a.id))).toEqual({ attached: 0, created: 0, repaired: 0 });
    expect(JSON.stringify(v.all())).toBe(snapshot);
  });

  it("never removes an entry that got a password after the preview", () => {
    const v = vault();
    const real = v.add({ origin: "https://central.example.com", username: "info@example.com", password: "pw" });
    const old = v.add({ origin: "https://central.example.com", username: "Parendum Central - info@example.com", password: "", totp: config(7) });
    const accounts = [account("a1", "Parendum Central", "Parendum Central - info@example.com", 7)];
    // The person types a password into the entry between the preview and the import: the plan is made
    // again, so it is now a login with a password that already has the 2FA.
    v.update(old.id, { password: "typed-later" });
    expect(importAccounts(v, accounts, {}, ["a1"])).toEqual({ attached: 0, created: 0, repaired: 0 });
    expect(v.get(old.id)?.password).toBe("typed-later");
    expect(v.get(real.id)?.totp).toBeUndefined();
  });
});
