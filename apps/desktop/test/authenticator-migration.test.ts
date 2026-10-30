import { describe, expect, it } from "vitest";
import {
  decodeMigrationPayload,
  encodeMigrationPayload,
  isMigrationUri,
  migrationUri,
  parseMigrationUri,
  splitAccountName,
} from "../src/shared/authenticator-migration";
import { base32Decode, base32Encode, totpCode } from "../src/shared/totp";

/** The example export from Google Authenticator's migration format write-ups (made-up "Hello!" secret; account moved to example.com). */
const EXAMPLE = "otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YW5uYUBleGFtcGxlLmNvbRoHRXhhbXBsZTAC";

const bytes = (...parts: Array<number | string | number[]>): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "number" ? [p] : typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

describe("parseMigrationUri", () => {
  it("reads a real-format export code", () => {
    const batch = parseMigrationUri(EXAMPLE);
    expect(batch.accounts).toEqual([{ issuer: "Example", account: "anna@example.com", config: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } }]);
    expect(batch.skipped).toEqual([]);
    expect(batch).toMatchObject({ batchSize: 1, batchIndex: 0 });
  });

  it("reads every field of a hand-built payload, unknown fields skipped", () => {
    const secret = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const otp = bytes(
      0x0a, secret.length, secret, // 1 secret
      0x12, 13, "octocat-smoke", // 2 name
      0x1a, 6, "GitHub", // 3 issuer
      0x20, 2, // 4 algorithm SHA256
      0x28, 2, // 5 digits eight
      0x30, 2, // 6 type TOTP
      0x38, 0, // 7 counter
      0x45, 1, 2, 3, 4, // 8: fixed32, unknown
    );
    const payload = bytes(
      0x0a, otp.length, [...otp],
      0x10, 1, // 2 version
      0x18, 4, // 3 batch size
      0x20, 2, // 4 batch index
      0x28, 0xf6, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, // 5 batch id -10
    );
    const batch = decodeMigrationPayload(payload);
    expect(batch).toMatchObject({ version: 1, batchSize: 4, batchIndex: 2, batchId: -10 });
    expect(batch.accounts).toEqual([{ issuer: "GitHub", account: "octocat-smoke", config: { secret: base32Encode(Uint8Array.from(secret)), algorithm: "SHA256", digits: 8, period: 30 } }]);
  });

  it("lists HOTP, MD5 and secretless accounts as skipped", () => {
    const secret = new Uint8Array(10).fill(7);
    const uri = migrationUri(
      encodeMigrationPayload([
        { secret, name: "Bank:counter", issuer: "Bank", type: 1, counter: 5 },
        { secret, name: "old@example.com", issuer: "Legacy", algorithm: 4 },
        { secret: new Uint8Array(0), name: "empty", issuer: "Broken" },
        { secret, name: "ok@example.com", issuer: "Fine" },
      ]),
    );
    const batch = parseMigrationUri(uri);
    expect(batch.accounts.map((a) => a.account)).toEqual(["ok@example.com"]);
    expect(batch.skipped).toEqual([
      { issuer: "Bank", account: "counter", reason: "hotp" },
      { issuer: "Legacy", account: "old@example.com", reason: "md5" },
      { issuer: "Broken", account: "empty", reason: "invalid" },
    ]);
  });

  it("accepts the data URL-encoded, with spaces for plus signs, or URL-safe", () => {
    const payload = encodeMigrationPayload([{ secret: Uint8Array.from([0xfb, 0xff, 0xbf, 0xfe, 0xfb, 0xff, 0xbf, 0xfe, 0xfb, 0xff]), name: "Plus:sign" }]);
    const uri = migrationUri(payload);
    expect(uri).toMatch(/%2B|%2F/);
    const raw = decodeURIComponent(uri.split("data=")[1]!);
    const expected = parseMigrationUri(uri).accounts;
    expect(parseMigrationUri(`otpauth-migration://offline?data=${raw.replace(/\+/g, " ")}`).accounts).toEqual(expected);
    expect(parseMigrationUri(`otpauth-migration://offline?data=${raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`).accounts).toEqual(expected);
    expect(parseMigrationUri(`OTPAUTH-MIGRATION://offline/?data=${encodeURIComponent(raw)}`).accounts).toEqual(expected);
  });

  it("rejects damaged and foreign codes with a readable message", () => {
    expect(() => parseMigrationUri("otpauth-migration://offline?data=%%%")).toThrow(/damaged/);
    expect(() => parseMigrationUri("otpauth-migration://offline?data=CjEKCkhlbGxv")).toThrow(/damaged/);
    expect(() => parseMigrationUri("otpauth-migration://offline?x=1")).toThrow(/no data/);
    expect(() => parseMigrationUri("otpauth://totp/A?secret=JBSWY3DP")).toThrow(/Not a Google Authenticator/);
    expect(isMigrationUri(" otpauth-migration://offline?data=abc ")).toBe(true);
    expect(isMigrationUri("https://example.com")).toBe(false);
  });

  it("round-trips batches with negative ids, and the codes match RFC 6238", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    const batch = parseMigrationUri(migrationUri(encodeMigrationPayload([{ secret, name: "rfc@example.com", issuer: "RFC", digits: 2 }], { batchSize: 12, batchIndex: 11, batchId: -2_000_000_000 })));
    expect(batch).toMatchObject({ batchSize: 12, batchIndex: 11, batchId: -2_000_000_000 });
    const config = batch.accounts[0]!.config;
    expect(base32Decode(config.secret)).toEqual(secret);
    expect((await totpCode(config, 59_000)).code).toBe("94287082");
    expect((await totpCode(config, 1_111_111_109_000)).code).toBe("07081804");
  });
});

describe("splitAccountName", () => {
  it("drops a prefix that repeats the issuer, or uses it as the issuer", () => {
    expect(splitAccountName("Google:alice@example.com", "Google")).toEqual({ issuer: "Google", account: "alice@example.com" });
    expect(splitAccountName("GITHUB: octocat", "GitHub")).toEqual({ issuer: "GitHub", account: "octocat" });
    expect(splitAccountName("Proton:bob@example.org", "")).toEqual({ issuer: "Proton", account: "bob@example.org" });
    expect(splitAccountName("bob@example.com", "Example")).toEqual({ issuer: "Example", account: "bob@example.com" });
    expect(splitAccountName("Other:bob", "Example")).toEqual({ issuer: "Example", account: "Other:bob" });
    expect(splitAccountName(":bob", "")).toEqual({ issuer: "", account: ":bob" });
  });
});
