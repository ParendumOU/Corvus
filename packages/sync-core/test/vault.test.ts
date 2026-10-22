import { describe, expect, it } from "vitest";
import { fromBase64, generateVaultKey, openSecret, sealSecret, VAULT_KEY_LENGTH } from "../src/index.js";

describe("vault sealing", () => {
  it("generates 32-byte keys that differ", () => {
    const a = generateVaultKey();
    const b = generateVaultKey();
    expect(a).toHaveLength(VAULT_KEY_LENGTH);
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });

  it("round-trips a secret and hides the plaintext", () => {
    const key = generateVaultKey();
    const secret = JSON.stringify({ username: "alice", password: "s3cr3t!" });
    const sealed = sealSecret(key, secret);
    expect(sealed).not.toContain("s3cr3t");
    expect(sealed).not.toContain("alice");
    expect(openSecret(key, sealed)).toBe(secret);
  });

  it("uses a fresh nonce per seal", () => {
    const key = generateVaultKey();
    const a = fromBase64(sealSecret(key, "same"));
    const b = fromBase64(sealSecret(key, "same"));
    expect(Buffer.from(a.subarray(0, 24)).toString("hex")).not.toBe(Buffer.from(b.subarray(0, 24)).toString("hex"));
  });

  it("fails to open with the wrong key", () => {
    const sealed = sealSecret(generateVaultKey(), "secret");
    expect(() => openSecret(generateVaultKey(), sealed)).toThrow();
  });

  it("binds the aad", () => {
    const key = generateVaultKey();
    const sealed = sealSecret(key, "secret", "cred-1");
    expect(openSecret(key, sealed, "cred-1")).toBe("secret");
    expect(() => openSecret(key, sealed, "cred-2")).toThrow();
    expect(() => openSecret(key, sealed)).toThrow();
  });

  it("detects tampering and rejects garbage", () => {
    const key = generateVaultKey();
    const bytes = fromBase64(sealSecret(key, "secret"));
    bytes[bytes.length - 1]! ^= 1;
    expect(() => openSecret(key, Buffer.from(bytes).toString("base64"))).toThrow();
    expect(() => openSecret(key, "")).toThrow();
    expect(() => openSecret(key, "!!!")).toThrow();
  });

  it("rejects malformed keys", () => {
    expect(() => sealSecret(new Uint8Array(16), "x")).toThrow(/key length/);
    expect(() => openSecret(new Uint8Array(16), sealSecret(generateVaultKey(), "x"))).toThrow(/key length/);
  });
});
