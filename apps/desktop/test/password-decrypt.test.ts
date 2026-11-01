import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINUX_V10_SECRET,
  chromiumCbcKey,
  decryptChromiumValue,
  decryptFirefoxField,
  dpapiWrappedKey,
  firefoxLoginKey,
  type Key4Rows,
} from "../src/main/password-decrypt";
import { chromiumValue, firefoxField, nssPbe, writeFirefoxLogins } from "../src/main/smoke-password-fixtures";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-pwdecrypt-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Chromium values", () => {
  it("reads Windows v10 (AES-256-GCM, 12-byte nonce, 16-byte tag)", async () => {
    const key = { kind: "gcm", key: crypto.randomBytes(32) } as const;
    expect(await decryptChromiumValue(chromiumValue("made-up-gcm", key), { v10: key })).toEqual({ ok: true, password: "made-up-gcm" });
  });

  it("reads macOS v10 (Keychain secret, PBKDF2-SHA1 1003 rounds, AES-128-CBC)", async () => {
    const key = { kind: "cbc", key: chromiumCbcKey("keychain-secret", 1003) } as const;
    expect(await decryptChromiumValue(chromiumValue("made-up-mac", key), { v10: key })).toEqual({ ok: true, password: "made-up-mac" });
  });

  it("reads Linux v10 (fixed key) and v11 (keyring secret)", async () => {
    const v10 = { kind: "cbc", key: chromiumCbcKey(LINUX_V10_SECRET, 1) } as const;
    const v11 = { kind: "cbc", key: chromiumCbcKey("keyring-secret", 1) } as const;
    expect(await decryptChromiumValue(chromiumValue("made-up-v10", v10), { v10, v11 })).toEqual({ ok: true, password: "made-up-v10" });
    expect(await decryptChromiumValue(chromiumValue("made-up-v11", v11, "v11"), { v10, v11 })).toEqual({ ok: true, password: "made-up-v11" });
    // Without the keyring, v11 is locked, not guessed.
    expect(await decryptChromiumValue(chromiumValue("made-up-v11", v11, "v11"), { v10 })).toEqual({ ok: false, reason: "locked" });
  });

  it("never attempts app-bound values (v20 and newer)", async () => {
    const key = { kind: "gcm", key: crypto.randomBytes(32) } as const;
    for (const prefix of ["v20", "v21"]) {
      expect(await decryptChromiumValue(Buffer.concat([Buffer.from(prefix), crypto.randomBytes(40)]), { v10: key, v11: key })).toEqual({ ok: false, reason: "app-bound" });
    }
  });

  it("a wrong key or a damaged value is unreadable, never a wrong password", async () => {
    const key = { kind: "gcm", key: crypto.randomBytes(32) } as const;
    const other = { kind: "gcm", key: crypto.randomBytes(32) } as const;
    expect(await decryptChromiumValue(chromiumValue("x", key), { v10: other })).toEqual({ ok: false, reason: "unreadable" });
    expect(await decryptChromiumValue(Buffer.from("v10abc"), { v10: key })).toEqual({ ok: false, reason: "unreadable" });
  });

  it("values without a version go through Windows DPAPI when it is there", async () => {
    const blob = Buffer.from("opaque");
    expect(await decryptChromiumValue(blob, { dpapi: async () => Buffer.from("made-up-legacy") })).toEqual({ ok: true, password: "made-up-legacy" });
    expect(await decryptChromiumValue(blob, { dpapi: async () => null })).toEqual({ ok: false, reason: "locked" });
    expect(await decryptChromiumValue(blob, {})).toEqual({ ok: false, reason: "unreadable" });
  });

  it("finds the DPAPI-wrapped key in Local State", () => {
    const blob = crypto.randomBytes(40);
    const state = JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), blob]).toString("base64") } });
    expect(dpapiWrappedKey(state)?.equals(blob)).toBe(true);
    expect(dpapiWrappedKey(JSON.stringify({ os_crypt: {} }))).toBeNull();
    expect(dpapiWrappedKey("not json")).toBeNull();
  });
});

const key4Rows = (dir: string): Key4Rows => {
  const db = new DatabaseSync(path.join(dir, "key4.db"));
  const meta = db.prepare("SELECT item1, item2 FROM metaData WHERE id = 'password'").get() as { item1: Uint8Array; item2: Uint8Array };
  const keys = db.prepare("SELECT a11 FROM nssPrivate").all() as Array<{ a11: Uint8Array }>;
  db.close();
  return { globalSalt: Buffer.from(meta.item1), check: Buffer.from(meta.item2), privateKeys: keys.map((k) => Buffer.from(k.a11)) };
};

describe("Firefox key4.db and logins.json", () => {
  const login = { hostname: "https://forum.example.org", username: "fox@example.org", password: "made-up-fox", changed: 1 };
  const fieldsOf = (dir: string) => (JSON.parse(fs.readFileSync(path.join(dir, "logins.json"), "utf8")) as { logins: Array<{ encryptedUsername: string; encryptedPassword: string }> }).logins[0]!;

  for (const variant of [
    { name: "PBES2 (PBKDF2 + AES-256-CBC), 3DES logins", opts: {} },
    { name: "PBES2, AES-256-CBC logins", opts: { aesLogins: true } },
    { name: "older SHA-1 + 3DES", opts: { legacy: true } },
  ]) {
    it(`reads ${variant.name} with no primary password`, () => {
      const dir = tempDir();
      writeFirefoxLogins(dir, [login], variant.opts);
      const key = firefoxLoginKey(key4Rows(dir));
      expect(Buffer.isBuffer(key)).toBe(true);
      const f = fieldsOf(dir);
      expect(decryptFirefoxField(f.encryptedUsername, key as Buffer)).toBe("fox@example.org");
      expect(decryptFirefoxField(f.encryptedPassword, key as Buffer)).toBe("made-up-fox");
    });
  }

  it("a primary password is detected (and opens it when given)", () => {
    const dir = tempDir();
    writeFirefoxLogins(dir, [login], { primaryPassword: "made-up-primary" });
    expect(firefoxLoginKey(key4Rows(dir))).toBe("primary-password");
    const key = firefoxLoginKey(key4Rows(dir), "made-up-primary");
    expect(decryptFirefoxField(fieldsOf(dir).encryptedPassword, key as Buffer)).toBe("made-up-fox");
  });

  it("NSS PBE round-trips both forms", () => {
    const salt = crypto.randomBytes(20);
    const rows = (legacy: boolean): Key4Rows => ({ globalSalt: salt, check: nssPbe(Buffer.from("password-check"), salt, "", legacy), privateKeys: [nssPbe(Buffer.alloc(24, 7), salt, "", legacy)] });
    for (const legacy of [false, true]) expect((firefoxLoginKey(rows(legacy)) as Buffer).equals(Buffer.alloc(24, 7))).toBe(true);
    // A wrong key throws on the padding, or by chance (1 in 256) passes it and gives garbage: never the value.
    const withWrongKey = (): string | null => {
      try {
        return decryptFirefoxField(firefoxField("x", Buffer.alloc(24, 1)), Buffer.alloc(24, 2));
      } catch {
        return null;
      }
    };
    expect(withWrongKey()).not.toBe("x");
  });
});
