import { describe, expect, it } from "vitest";
import { additionalUrlFields, entryMatchScore, entrySite, parseEntryUrl, totpFromFields, urlMatchScore } from "../src/main/keepass-entries";
import { base32Decode } from "../src/shared/totp";

const reader = (fields: Record<string, string>) => (name: string) => fields[name] ?? "";
const SECRET = "JBSWY3DPEHPK3PXP";

describe("totpFromFields", () => {
  it("reads KeePassXC's otp otpauth URI", () => {
    expect(totpFromFields(reader({ otp: `otpauth://totp/x?secret=${SECRET}&digits=8&period=60&algorithm=SHA256` }))).toEqual({
      secret: SECRET,
      algorithm: "SHA256",
      digits: 8,
      period: 60,
    });
  });

  it("reads KeePassXC's older key=...&step=...&size=... form", () => {
    expect(totpFromFields(reader({ otp: `key=${SECRET}&step=30&size=6` }))).toEqual({ secret: SECRET, algorithm: "SHA1", digits: 6, period: 30 });
    expect(totpFromFields(reader({ otp: `key=${SECRET}&otpHashMode=sha512` }))?.algorithm).toBe("SHA512");
  });

  it("reads KeePass 2 TimeOtp fields in every secret encoding", () => {
    const bytes = base32Decode(SECRET);
    const base = { "TimeOtp-Length": "8", "TimeOtp-Period": "45", "TimeOtp-Algorithm": "HMAC-SHA-256" };
    const expected = { secret: SECRET, algorithm: "SHA256", digits: 8, period: 45 };
    expect(totpFromFields(reader({ ...base, "TimeOtp-Secret-Base32": SECRET.toLowerCase() }))).toEqual(expected);
    expect(totpFromFields(reader({ ...base, "TimeOtp-Secret-Hex": Buffer.from(bytes).toString("hex") }))).toEqual(expected);
    expect(totpFromFields(reader({ ...base, "TimeOtp-Secret-Base64": Buffer.from(bytes).toString("base64") }))).toEqual(expected);
    expect(totpFromFields(reader({ "TimeOtp-Secret": "12345678901234567890" }))).toEqual({ secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", algorithm: "SHA1", digits: 6, period: 30 });
  });

  it("reads KeePassXC's legacy TOTP Seed / TOTP Settings and skips Steam codes", () => {
    expect(totpFromFields(reader({ "TOTP Seed": SECRET, "TOTP Settings": "30;8" }))).toEqual({ secret: SECRET, algorithm: "SHA1", digits: 8, period: 30 });
    expect(totpFromFields(reader({ "TOTP Seed": SECRET, "TOTP Settings": "30;S" }))).toBeUndefined();
  });

  it("ignores missing, HOTP and malformed generators", () => {
    expect(totpFromFields(reader({}))).toBeUndefined();
    expect(totpFromFields(reader({ otp: `otpauth://hotp/x?secret=${SECRET}&counter=1` }))).toBeUndefined();
    expect(totpFromFields(reader({ "TimeOtp-Secret-Base32": SECRET, "TimeOtp-Algorithm": "MD5" }))).toBeUndefined();
    expect(totpFromFields(reader({ "TimeOtp-Secret-Hex": "zz" }))).toBeUndefined();
  });
});

describe("additionalUrlFields", () => {
  it("orders KP2A_URL fields and ignores others", () => {
    expect(additionalUrlFields(["KP2A_URL_2", "Title", "KP2A_URL", "KP2A_URL_1", "KP2A_URLX"])).toEqual(["KP2A_URL", "KP2A_URL_1", "KP2A_URL_2"]);
  });
});

describe("parseEntryUrl", () => {
  it("accepts full URLs and bare hosts", () => {
    expect(parseEntryUrl("https://Login.Example.com/signin")).toEqual({ scheme: "https:", host: "login.example.com", port: "" });
    expect(parseEntryUrl("example.com")).toEqual({ scheme: null, host: "example.com", port: "" });
    expect(parseEntryUrl("http://localhost:8080")).toEqual({ scheme: "http:", host: "localhost", port: "8080" });
  });

  it("rejects placeholders, app URLs and single-label hosts", () => {
    expect(parseEntryUrl("{REF:U@I:1234}")).toBeNull();
    expect(parseEntryUrl("androidapp://com.example")).toBeNull();
    expect(parseEntryUrl("intranet")).toBeNull();
    expect(parseEntryUrl("")).toBeNull();
  });
});

describe("urlMatchScore", () => {
  it("ranks exact origin over host over subdomain", () => {
    expect(urlMatchScore("https://example.com", "https://example.com/login")).toBe(3);
    expect(urlMatchScore("example.com", "https://example.com/login")).toBe(2);
    expect(urlMatchScore("example.com", "https://accounts.example.com/")).toBe(1);
  });

  it("never matches other sites, lookalikes or parent domains", () => {
    expect(urlMatchScore("example.com", "https://example.com.evil.test/")).toBe(0);
    expect(urlMatchScore("example.com", "https://notexample.com/")).toBe(0);
    expect(urlMatchScore("accounts.example.com", "https://example.com/")).toBe(0);
  });

  it("never sends an https entry to an http page but lets http entries upgrade", () => {
    expect(urlMatchScore("https://example.com", "http://example.com/")).toBe(0);
    expect(urlMatchScore("http://example.com", "https://example.com/")).toBe(2);
  });

  it("requires the same port and does not match subdomains of IPs", () => {
    expect(urlMatchScore("http://127.0.0.1:8080", "http://127.0.0.1:8080/x")).toBe(3);
    expect(urlMatchScore("http://127.0.0.1:8080", "http://127.0.0.1:9090/x")).toBe(0);
    expect(urlMatchScore("https://example.com:8443", "https://example.com/")).toBe(0);
    expect(urlMatchScore("example.com", "corvus://settings")).toBe(0);
  });

  it("uses the best of an entry's URLs", () => {
    expect(entryMatchScore({ urls: ["https://other.test", "example.com"] }, "https://example.com/")).toBe(2);
    expect(entrySite({ urls: ["{REF:x}", "https://Example.com/a"], title: "T" })).toBe("example.com");
    expect(entrySite({ urls: [], title: "Bank" })).toBe("Bank");
  });
});
