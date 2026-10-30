import { describe, expect, it } from "vitest";
import { planAccountFill } from "../src/shared/autofill-plan";
import { codeToFill, MIN_FILL_LIFE_MS, totpCode, type TotpConfig } from "../src/shared/totp";

const TOTP: TotpConfig = { secret: "JBSWY3DPEHPK3PXPJBSWY3DP", algorithm: "SHA1", digits: 6, period: 30 };

describe("planAccountFill", () => {
  const oneForm = { login: true, otp: true };

  it("fills username, password and code in one pick on a page that asks for all three", () => {
    expect(planAccountFill("account", { hasTotp: true }, oneForm)).toEqual({ login: "all", code: true });
  });

  it("keeps typed login fields when the pick was for the code", () => {
    expect(planAccountFill("code", { hasTotp: true }, oneForm)).toEqual({ login: "empty", code: true });
  });

  it("fills no code for an account without a 2FA or a page without a code field", () => {
    expect(planAccountFill("account", { hasTotp: false }, oneForm)).toEqual({ login: "all", code: false });
    expect(planAccountFill("account", { hasTotp: true }, { login: true, otp: false })).toEqual({ login: "all", code: false });
  });

  it("fills only the code on a two-step page's code step", () => {
    expect(planAccountFill("account", { hasTotp: true }, { login: false, otp: true })).toEqual({ login: "none", code: true });
    expect(planAccountFill("code", { hasTotp: true }, { login: false, otp: true })).toEqual({ login: "none", code: true });
  });
});

describe("codeToFill", () => {
  const stepStart = 1_793_000_010_000 - (1_793_000_010_000 % 30_000);

  it("fills the current code while it has time left", async () => {
    const now = stepStart + 10_000;
    expect(await codeToFill(TOTP, now)).toEqual({ code: (await totpCode(TOTP, now)).code, waitMs: 0 });
    const edge = stepStart + 30_000 - MIN_FILL_LIFE_MS;
    expect(await codeToFill(TOTP, edge)).toEqual({ code: (await totpCode(TOTP, edge)).code, waitMs: 0 });
  });

  it("waits for the next code when the current one is about to expire", async () => {
    const now = stepStart + 28_500;
    const next = await totpCode(TOTP, stepStart + 30_000);
    const fill = await codeToFill(TOTP, now);
    expect(fill).toEqual({ code: next.code, waitMs: 1500 });
    expect(fill.code).not.toBe((await totpCode(TOTP, now)).code);
  });
});
