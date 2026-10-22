import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  formatTotpCode,
  hotp,
  isValidTotpConfig,
  parseOtpauthUri,
  parseTotpAlgorithm,
  parseTotpInput,
  totpAt,
  totpCode,
  totpConfigFromBytes,
  type TotpAlgorithm,
} from "../src/shared/totp";

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

// RFC 6238 Appendix B seeds: the 20/32/64-byte ASCII "1234567890..." strings.
const SEEDS: Record<TotpAlgorithm, Uint8Array> = {
  SHA1: ascii("12345678901234567890"),
  SHA256: ascii("12345678901234567890123456789012"),
  SHA512: ascii("1234567890123456789012345678901234567890123456789012345678901234"),
};

describe("hotp (RFC 4226 Appendix D)", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  it.each(expected.map((code, counter) => [counter, code] as const))("counter %i -> %s", async (counter, code) => {
    expect(await hotp(SEEDS.SHA1, counter)).toBe(code);
  });
});

describe("totp (RFC 6238 Appendix B)", () => {
  const vectors: Array<[number, string, string, string]> = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  it.each(vectors)("t=%i", async (time, sha1, sha256, sha512) => {
    expect(await totpAt(SEEDS.SHA1, time, { algorithm: "SHA1", digits: 8 })).toBe(sha1);
    expect(await totpAt(SEEDS.SHA256, time, { algorithm: "SHA256", digits: 8 })).toBe(sha256);
    expect(await totpAt(SEEDS.SHA512, time, { algorithm: "SHA512", digits: 8 })).toBe(sha512);
  });

  it("6-digit codes are the low digits of the 8-digit ones", async () => {
    expect(await totpAt(SEEDS.SHA1, 59, { digits: 6 })).toBe("287082");
  });
});

describe("totpCode", () => {
  it("returns the current code and when it expires", async () => {
    const config = totpConfigFromBytes(SEEDS.SHA1, { digits: 8 });
    const at = 1111111109 * 1000 + 250;
    const result = await totpCode(config, at);
    expect(result.code).toBe("07081804");
    expect(result.period).toBe(30);
    expect(result.expiresAt).toBe(1111111110 * 1000);
  });

  it("supports a custom period", async () => {
    const config = totpConfigFromBytes(SEEDS.SHA1, { period: 60 });
    const a = await totpCode(config, 60_000);
    const b = await totpCode(config, 119_999);
    expect(a.code).toBe(b.code);
    expect(a.expiresAt).toBe(120_000);
  });
});

describe("base32", () => {
  it("round-trips the RFC 4648 test vectors", () => {
    const vectors: Array<[string, string]> = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(ascii(plain))).toBe(encoded);
      expect(new TextDecoder().decode(base32Decode(encoded))).toBe(plain);
    }
  });

  it("tolerates lowercase, spaces, dashes and padding", () => {
    expect(new TextDecoder().decode(base32Decode("mzxw 6ytb-oi======"))).toBe("foobar");
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("MZXW1")).toThrow(/base32/);
  });
});

describe("otpauth URIs", () => {
  it("parses issuer, account and parameters", () => {
    const parsed = parseOtpauthUri("otpauth://totp/ACME%20Co:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60");
    expect(parsed.issuer).toBe("ACME Co");
    expect(parsed.account).toBe("alice@example.com");
    expect(parsed.config).toEqual({ secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA256", digits: 8, period: 60 });
  });

  it("defaults to SHA1, 6 digits and 30 seconds", () => {
    const parsed = parseOtpauthUri("otpauth://totp/alice?secret=jbswy3dpehpk3pxp");
    expect(parsed.config).toEqual({ secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 });
    expect(parsed.issuer).toBe("");
    expect(parsed.account).toBe("alice");
  });

  it("rejects hotp, missing secrets and bad parameters", () => {
    expect(() => parseOtpauthUri("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1")).toThrow(/HOTP/);
    expect(() => parseOtpauthUri("otpauth://totp/x")).toThrow(/no secret/);
    expect(() => parseOtpauthUri("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")).toThrow(/algorithm/);
    expect(() => parseOtpauthUri("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=4")).toThrow(/digits/);
    expect(() => parseOtpauthUri("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0")).toThrow(/period/);
    expect(() => parseOtpauthUri("https://example.com")).toThrow(/otpauth/);
  });

  it("builds a URI that parses back to the same config", () => {
    const config = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA512" as const, digits: 7, period: 45 };
    const uri = buildOtpauthUri(config, { issuer: "Example", account: "bob" });
    expect(uri.startsWith("otpauth://totp/Example:bob?")).toBe(true);
    const back = parseOtpauthUri(uri);
    expect(back.config).toEqual(config);
    expect(back.issuer).toBe("Example");
    expect(back.account).toBe("bob");
  });
});

describe("parseTotpInput", () => {
  it("accepts a bare secret with spaces", () => {
    expect(parseTotpInput(" jbsw y3dp ehpk 3pxp ")).toEqual({ secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 });
  });

  it("accepts an otpauth link", () => {
    expect(parseTotpInput("otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&digits=8").digits).toBe(8);
  });

  it("rejects empty, short and non-base32 input", () => {
    expect(() => parseTotpInput("  ")).toThrow();
    expect(() => parseTotpInput("ABCDEFG")).toThrow(/too short/);
    expect(() => parseTotpInput("not a secret 0189")).toThrow(/base32/);
  });
});

describe("helpers", () => {
  it("validates configs", () => {
    expect(isValidTotpConfig({ secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 })).toBe(true);
    expect(isValidTotpConfig({ secret: "JBSWY3DPEHPK3PXP", algorithm: "MD5", digits: 6, period: 30 })).toBe(false);
    expect(isValidTotpConfig({ secret: "jbswy3dp", algorithm: "SHA1", digits: 6, period: 30 })).toBe(false);
    expect(isValidTotpConfig({ secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 9, period: 30 })).toBe(false);
    expect(isValidTotpConfig({ secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 0 })).toBe(false);
    expect(isValidTotpConfig(null)).toBe(false);
  });

  it("maps algorithm spellings", () => {
    expect(parseTotpAlgorithm("HMAC-SHA-256")).toBe("SHA256");
    expect(parseTotpAlgorithm("sha512")).toBe("SHA512");
    expect(parseTotpAlgorithm(undefined)).toBe("SHA1");
    expect(parseTotpAlgorithm("md5")).toBeNull();
  });

  it("formats codes in two groups", () => {
    expect(formatTotpCode("123456")).toBe("123 456");
    expect(formatTotpCode("12345678")).toBe("1234 5678");
    expect(formatTotpCode("1234567")).toBe("123 4567");
  });
});
