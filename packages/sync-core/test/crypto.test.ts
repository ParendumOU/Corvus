import { createPrivateKey, createPublicKey, hkdfSync, pbkdf2Sync, sign as nodeSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HKDF_INFO_AUTH,
  HKDF_INFO_DATA,
  HKDF_INFO_RECORD_ID,
  chainIdFromPublicKey,
  decryptRecord,
  deriveKeys,
  encryptRecord,
  fromBase64,
  generateRecoveryPhrase,
  normalizeRecoveryPhrase,
  parseAuthHeader,
  recordIdFor,
  signRequest,
  signingMessage,
  toBase64,
  validateRecoveryPhrase,
  verifyRequestSignature,
} from "../src/index.js";

const PHRASE = `${"abandon ".repeat(23)}art`;
const OTHER_PHRASE = "zoo ".repeat(23) + "vote";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("recovery phrase", () => {
  it("generates 24 valid, distinct words", () => {
    const a = generateRecoveryPhrase();
    const b = generateRecoveryPhrase();
    expect(a.split(" ")).toHaveLength(24);
    expect(validateRecoveryPhrase(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("validates checksum, length and wordlist", () => {
    expect(validateRecoveryPhrase(PHRASE)).toBe(true);
    expect(validateRecoveryPhrase(OTHER_PHRASE)).toBe(true);
    expect(validateRecoveryPhrase(`${"abandon ".repeat(23)}abandon`)).toBe(false); // bad checksum
    expect(validateRecoveryPhrase(`${"abandon ".repeat(11)}about`)).toBe(false); // valid 12-word, but too short
    expect(validateRecoveryPhrase(`${"abandon ".repeat(23)}corvusx`)).toBe(false);
    expect(validateRecoveryPhrase("")).toBe(false);
  });

  it("normalizes case and whitespace", () => {
    const messy = `  ${PHRASE.toUpperCase().replaceAll(" ", " \n\t ")}  `;
    expect(normalizeRecoveryPhrase(messy)).toBe(PHRASE);
    expect(validateRecoveryPhrase(messy)).toBe(true);
    expect(deriveKeys(messy).chainId).toBe(deriveKeys(PHRASE).chainId);
  });

  it("refuses to derive keys from an invalid phrase", () => {
    expect(() => deriveKeys("not a phrase")).toThrow(/Invalid recovery phrase/);
  });
});

describe("key derivation", () => {
  it("matches the fixed test vector", () => {
    const keys = deriveKeys(PHRASE);
    expect(keys.chainId).toBe(VECTOR.chainId);
    expect(hex(keys.authPublicKey)).toBe(VECTOR.authPublicKey);
    expect(hex(keys.dataKey)).toBe(VECTOR.dataKey);
    expect(hex(keys.recordIdKey)).toBe(VECTOR.recordIdKey);
    expect(recordIdFor(keys, "history", "https://example.com/")).toBe(VECTOR.historyRecordId);
  });

  it("agrees with an independent node:crypto implementation", () => {
    const seed = pbkdf2Sync(Buffer.from(PHRASE.normalize("NFKD")), Buffer.from("mnemonic"), 2048, 64, "sha512");
    const derive = (info: string) => new Uint8Array(hkdfSync("sha256", seed, Buffer.alloc(0), info, 32));
    const keys = deriveKeys(PHRASE);
    expect(hex(keys.authSecretKey)).toBe(hex(derive(HKDF_INFO_AUTH)));
    expect(hex(keys.dataKey)).toBe(hex(derive(HKDF_INFO_DATA)));
    expect(hex(keys.recordIdKey)).toBe(hex(derive(HKDF_INFO_RECORD_ID)));

    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(keys.authSecretKey)]);
    const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
    expect(hex(keys.authPublicKey)).toBe(spki.subarray(-32).toString("hex"));
    expect(keys.chainId).toHaveLength(32);
    expect(keys.chainId).toBe(chainIdFromPublicKey(new Uint8Array(spki.subarray(-32))));

    const msg = signingMessage("GET", "/v1/x", 1, "00".repeat(16), new Uint8Array());
    const header = signRequest(keys, "device-1234", { method: "GET", path: "/v1/x", ts: 1, nonce: "00".repeat(16) });
    expect(parseAuthHeader(header)!.sig).toEqual(new Uint8Array(nodeSign(null, msg, priv)));
  });

  it("uses distinct keys per label and per phrase", () => {
    const a = deriveKeys(PHRASE);
    const b = deriveKeys(OTHER_PHRASE);
    expect(new Set([hex(a.authSecretKey), hex(a.dataKey), hex(a.recordIdKey)]).size).toBe(3);
    expect(a.chainId).not.toBe(b.chainId);
    expect(hex(a.dataKey)).not.toBe(hex(b.dataKey));
  });
});

describe("record encryption", () => {
  const keys = deriveKeys(PHRASE);
  const base = {
    collection: "bookmarks" as const,
    naturalId: "bm-1",
    version: 3,
    deviceId: "device-aaaa",
    deleted: false,
    payload: { title: "Corvus", url: "https://corvus.example/" },
  };

  it("round-trips payloads and tombstones", () => {
    const enc = encryptRecord(keys, base);
    expect(enc.id).toBe(recordIdFor(keys, "bookmarks", "bm-1"));
    expect(enc.ciphertext).not.toContain("Corvus");
    expect(decryptRecord(keys, enc)).toEqual({ collection: "bookmarks", id: "bm-1", payload: base.payload, deleted: false });

    const tomb = encryptRecord(keys, { ...base, deleted: true, version: 4 });
    expect(tomb.ciphertext.length).toBeGreaterThan(0);
    expect(decryptRecord(keys, tomb)).toEqual({ collection: "bookmarks", id: "bm-1", payload: null, deleted: true });
  });

  it("uses a fresh random nonce per encryption", () => {
    const a = fromBase64(encryptRecord(keys, base).ciphertext);
    const b = fromBase64(encryptRecord(keys, base).ciphertext);
    expect(hex(a.subarray(0, 24))).not.toBe(hex(b.subarray(0, 24)));
  });

  it("detects tampering with metadata bound by AAD or the envelope", () => {
    const enc = encryptRecord(keys, base);
    const other = encryptRecord(keys, { ...base, naturalId: "bm-2" });
    expect(() => decryptRecord(keys, { ...enc, version: 4 })).toThrow();
    expect(() => decryptRecord(keys, { ...enc, collection: "history" })).toThrow();
    expect(() => decryptRecord(keys, { ...enc, id: other.id })).toThrow();
    expect(() => decryptRecord(keys, { ...enc, deleted: true })).toThrow(/metadata/);
    expect(() => decryptRecord(keys, { ...enc, deviceId: "device-zzzz" })).toThrow(/metadata/);
    expect(() => decryptRecord(deriveKeys(OTHER_PHRASE), enc)).toThrow();

    const bytes = fromBase64(enc.ciphertext);
    bytes[bytes.length - 1]! ^= 1;
    expect(() => decryptRecord(keys, { ...enc, ciphertext: toBase64(bytes) })).toThrow();
    expect(() => decryptRecord(keys, { ...enc, ciphertext: "" })).toThrow();
    expect(() => decryptRecord(keys, { ...enc, ciphertext: "!!!" })).toThrow();
  });
});

describe("record ids", () => {
  const keys = deriveKeys(PHRASE);
  it("are deterministic keyed HMACs that hide the natural key", () => {
    const id = recordIdFor(keys, "history", "https://example.com/");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(recordIdFor(keys, "history", "https://example.com/")).toBe(id);
    expect(recordIdFor(keys, "bookmarks", "https://example.com/")).not.toBe(id);
    expect(recordIdFor(deriveKeys(OTHER_PHRASE), "history", "https://example.com/")).not.toBe(id);
  });
});

describe("request signing", () => {
  const keys = deriveKeys(PHRASE);
  const body = new TextEncoder().encode('{"records":[]}');
  const path = `/v1/chains/${keys.chainId}/records?since=0`;

  it("produces a parseable header that verifies", () => {
    const header = signRequest(keys, "device-aaaa", { method: "POST", path, body });
    const auth = parseAuthHeader(header)!;
    expect(auth.chain).toBe(keys.chainId);
    expect(auth.device).toBe("device-aaaa");
    expect(auth.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Math.abs(auth.ts - Date.now())).toBeLessThan(5000);
    expect(verifyRequestSignature(keys.authPublicKey, auth, "POST", path, body)).toBe(true);
  });

  it("binds method, path, query, body and key", () => {
    const auth = parseAuthHeader(signRequest(keys, "device-aaaa", { method: "POST", path, body }))!;
    expect(verifyRequestSignature(keys.authPublicKey, auth, "GET", path, body)).toBe(false);
    expect(verifyRequestSignature(keys.authPublicKey, auth, "POST", path.replace("since=0", "since=1"), body)).toBe(false);
    expect(verifyRequestSignature(keys.authPublicKey, auth, "POST", path, new Uint8Array())).toBe(false);
    expect(verifyRequestSignature(keys.authPublicKey, { ...auth, ts: auth.ts + 1 }, "POST", path, body)).toBe(false);
    expect(verifyRequestSignature(keys.authPublicKey, { ...auth, nonce: "11".repeat(16) }, "POST", path, body)).toBe(false);
    expect(verifyRequestSignature(deriveKeys(OTHER_PHRASE).authPublicKey, auth, "POST", path, body)).toBe(false);
  });

  it("gives identical requests distinct signatures", () => {
    const a = signRequest(keys, "device-aaaa", { method: "GET", path, ts: 1 });
    const b = signRequest(keys, "device-aaaa", { method: "GET", path, ts: 1 });
    expect(a).not.toBe(b);
  });

  it("rejects malformed headers", () => {
    const good = signRequest(keys, "device-aaaa", { method: "GET", path });
    expect(parseAuthHeader(good)).not.toBeNull();
    expect(parseAuthHeader(good.replace("Corvus-Sig", "Bearer"))).toBeNull();
    expect(parseAuthHeader(good.replace(/sig=[^,]+$/, "sig=AAAA"))).toBeNull();
    expect(parseAuthHeader(good.replace(/ts=\d+/, "ts=abc"))).toBeNull();
    expect(parseAuthHeader(good.replace("device=device-aaaa", "device=x"))).toBeNull();
    expect(parseAuthHeader(`${good},ts=1`)).toBeNull();
    expect(parseAuthHeader(good.replace(/,nonce=[0-9a-f]+/, ""))).toBeNull();
  });
});

// Phrase "abandon x23 art". Also cross-checked against node:crypto (PBKDF2/HKDF/Ed25519) above.
const VECTOR = {
  chainId: "062e7e31b32d3b4ef41f4c067226c064",
  authPublicKey: "22f0b1dd9ca274427d64fce467f3e72ab5d136c1bc911084ff7d8f2aec8d27c0",
  dataKey: "06299aeab44a72b60a51e05dd7bb1380426dec63022bc24f4529e218e3bacb0a",
  recordIdKey: "4cbed6e761752808622277d246c40218336c66e2bb3ec1851e4238a660ac493f",
  historyRecordId: "94786eee617a9d6591f4a3db6195d96a9c592801bf851dbac79a1010a5a19651",
};
