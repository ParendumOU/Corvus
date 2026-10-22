import { describe, expect, it } from "vitest";
import {
  credentialSummary,
  generatePassword,
  isValidCredential,
  matchCredentials,
  originKeyOf,
  searchCredentials,
  type Credential,
} from "../src/shared/credentials";

function cred(partial: Partial<Credential>): Credential {
  return { id: "1", origin: "https://example.com", username: "alice", password: "pw", createdAt: 1, updatedAt: 1, ...partial };
}

describe("originKeyOf", () => {
  it("normalizes host case and strips default ports", () => {
    expect(originKeyOf("https://Example.com/login?x=1")).toBe("https://example.com");
    expect(originKeyOf("https://example.com:443/")).toBe("https://example.com");
    expect(originKeyOf("http://example.com:80/")).toBe("http://example.com");
    expect(originKeyOf("https://example.com:8443/")).toBe("https://example.com:8443");
  });

  it("rejects non-http(s) and garbage", () => {
    expect(originKeyOf("corvus://settings")).toBe("");
    expect(originKeyOf("file:///tmp/x")).toBe("");
    expect(originKeyOf("not a url")).toBe("");
    expect(originKeyOf("")).toBe("");
  });
});

describe("matchCredentials", () => {
  const list = [
    cred({ id: "a", origin: "https://example.com", updatedAt: 1 }),
    cred({ id: "b", origin: "https://example.com", updatedAt: 5 }),
    cred({ id: "c", origin: "https://other.com", updatedAt: 9 }),
  ];
  it("returns only same-origin logins, newest first", () => {
    expect(matchCredentials(list, "https://example.com/login").map((c) => c.id)).toEqual(["b", "a"]);
    expect(matchCredentials(list, "https://other.com/").map((c) => c.id)).toEqual(["c"]);
    expect(matchCredentials(list, "https://nope.com/")).toEqual([]);
    expect(matchCredentials(list, "corvus://settings")).toEqual([]);
  });
});

describe("searchCredentials", () => {
  const list = [
    credentialSummary(cred({ id: "a", origin: "https://github.com", username: "dev", updatedAt: 1 })),
    credentialSummary(cred({ id: "b", origin: "https://gitlab.com", username: "ops", updatedAt: 2 })),
  ];
  it("matches host and username, newest first when empty", () => {
    expect(searchCredentials(list, "").map((c) => c.id)).toEqual(["b", "a"]);
    expect(searchCredentials(list, "github").map((c) => c.id)).toEqual(["a"]);
    expect(searchCredentials(list, "ops").map((c) => c.id)).toEqual(["b"]);
    expect(searchCredentials(list, "zzz")).toEqual([]);
  });
});

describe("isValidCredential", () => {
  it("accepts complete records and rejects partial ones", () => {
    expect(isValidCredential(cred({}))).toBe(true);
    expect(isValidCredential(cred({ notes: "hi" }))).toBe(true);
    expect(isValidCredential({ ...cred({}), origin: "" })).toBe(false);
    expect(isValidCredential({ ...cred({}), password: 5 })).toBe(false);
    expect(isValidCredential(null)).toBe(false);
  });

  it("validates the optional 2FA generator and agent opt-ins", () => {
    const totp = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };
    expect(isValidCredential(cred({ totp, agentTotp: true, agentSignIn: false }))).toBe(true);
    expect(isValidCredential({ ...cred({}), totp: { ...totp, digits: 4 } })).toBe(false);
    expect(isValidCredential({ ...cred({}), agentTotp: "yes" })).toBe(false);
  });

  it("summaries say whether a login has 2FA and opt-ins, without the secret", () => {
    const totp = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };
    const summary = credentialSummary(cred({ totp, agentTotp: true }));
    expect(summary).toMatchObject({ hasTotp: true, agentTotp: true, agentSignIn: false });
    expect(JSON.stringify(summary)).not.toContain(totp.secret);
  });
});

describe("generatePassword", () => {
  it("honors length and only uses selected classes", () => {
    const pw = generatePassword({ length: 32, lowercase: true, uppercase: false, digits: false, symbols: false });
    expect(pw).toHaveLength(32);
    expect(pw).toMatch(/^[a-z]+$/);
  });

  it("includes at least one of each enabled class", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword({ length: 12, lowercase: true, uppercase: true, digits: true, symbols: true });
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*\-_=+?]/);
    }
  });

  it("never returns shorter than the number of enabled classes", () => {
    const pw = generatePassword({ length: 1, lowercase: true, uppercase: true, digits: true, symbols: true });
    expect(pw.length).toBeGreaterThanOrEqual(4);
  });

  it("produces different passwords", () => {
    expect(generatePassword({ length: 20, lowercase: true, uppercase: true, digits: true, symbols: true })).not.toBe(
      generatePassword({ length: 20, lowercase: true, uppercase: true, digits: true, symbols: true }),
    );
  });
});
