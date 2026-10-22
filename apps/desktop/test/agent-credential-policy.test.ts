import { describe, expect, it } from "vitest";
import { approvalReason, pickAgentLogin } from "../src/main/agent-credential-policy";
import type { LoginRecord } from "../src/main/login-sources";

const TOTP = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };

function rec(partial: Partial<LoginRecord>): LoginRecord {
  return {
    id: "a",
    source: "corvus",
    sourceName: "",
    site: "https://example.com",
    username: "alice",
    password: "s3cret-pw",
    agentTotp: false,
    agentSignIn: false,
    updatedAt: 1,
    ...partial,
  };
}

const base = { globalOn: true, host: "example.com", handoffHint: "Call ask_user." };

describe("pickAgentLogin", () => {
  it("hands off when the global setting is off, even for opted-in logins", () => {
    const r = pickAgentLogin([rec({ totp: TOTP, agentTotp: true })], "totp", { ...base, globalOn: false });
    expect(r).toMatchObject({ ok: false, status: "handoff" });
    if (!r.ok) expect(r.message).toContain("ask_user");
  });

  it("hands off when the login is not opted in", () => {
    const totp = pickAgentLogin([rec({ totp: TOTP })], "totp", base);
    expect(totp).toMatchObject({ ok: false, status: "handoff" });
    if (!totp.ok) expect(totp.message).toMatch(/not allowed AI agents to use the 2FA code/);
    const login = pickAgentLogin([rec({})], "signIn", base);
    expect(login).toMatchObject({ ok: false, status: "handoff" });
  });

  it("hands off when there is nothing saved for the site", () => {
    const r = pickAgentLogin([rec({ agentSignIn: true })], "totp", base);
    expect(r).toMatchObject({ ok: false, status: "handoff" });
    if (!r.ok) expect(r.message).toMatch(/no 2FA code/);
    expect(pickAgentLogin([], "signIn", base)).toMatchObject({ ok: false, status: "handoff" });
  });

  it("the 2FA opt-in needs a 2FA secret", () => {
    expect(pickAgentLogin([rec({ agentTotp: true })], "totp", base)).toMatchObject({ ok: false });
  });

  it("picks the single opted-in login", () => {
    const r = pickAgentLogin([rec({ id: "x", totp: TOTP }), rec({ id: "y", username: "bob", totp: TOTP, agentTotp: true })], "totp", base);
    expect(r).toMatchObject({ ok: true, record: { id: "y" } });
  });

  it("asks for a username when several logins are opted in", () => {
    const records = [rec({ id: "x", agentSignIn: true }), rec({ id: "y", username: "bob", agentSignIn: true })];
    const r = pickAgentLogin(records, "signIn", base);
    expect(r).toMatchObject({ ok: false, status: "error" });
    if (!r.ok) expect(r.message).toContain("alice, bob");
    expect(pickAgentLogin(records, "signIn", { ...base, username: "bob" })).toMatchObject({ ok: true, record: { id: "y" } });
    expect(pickAgentLogin(records, "signIn", { ...base, username: "carol" })).toMatchObject({ ok: false, status: "error" });
  });

  it("never puts a secret in a message", () => {
    const records = [rec({ totp: TOTP }), rec({ id: "b", username: "bob", agentSignIn: true }), rec({ id: "c", username: "carol", agentSignIn: true })];
    for (const use of ["totp", "signIn"] as const) {
      for (const opts of [base, { ...base, globalOn: false }, { ...base, username: "zed" }]) {
        const r = pickAgentLogin(records, use, opts);
        if (!r.ok) {
          expect(r.message).not.toContain("s3cret-pw");
          expect(r.message).not.toContain(TOTP.secret);
        }
      }
    }
  });
});

describe("approvalReason", () => {
  it("names the login, the site and the source but no secret", () => {
    const vault = approvalReason("totp", rec({ totp: TOTP }), "example.com");
    expect(vault).toBe("Fill the current 2FA code for alice on example.com. The agent will not see the code.");
    const kp = approvalReason("signIn", rec({ source: "keepass", sourceName: "Personal" }), "example.com");
    expect(kp).toContain("from KeePass (Personal)");
    expect(kp).not.toContain("s3cret-pw");
  });
});
