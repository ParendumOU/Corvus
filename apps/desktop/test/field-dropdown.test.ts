import { describe, expect, it } from "vitest";
import type { CredentialMatch } from "../src/shared/credentials";
import { dropdownEntries, dropdownLabel, dropdownLines, dropdownTwoFaOnly, moveHighlight, parseDropdownAction } from "../src/shared/field-dropdown";
import { translate } from "../src/shared/i18n-es";

const match = (id: string, extra: Partial<CredentialMatch> = {}): CredentialMatch => ({ id, username: `${id}@example.com`, site: "central.example.com", hasPassword: true, hasTotp: false, source: "corvus", fit: "exact", ...extra });
const words = (lang: "en" | "es") => ({ noUsername: translate(lang, "(no username)"), twoFaOnly: translate(lang, "2FA only"), codeFor: translate(lang, "2FA code for") });
const en = words("en");
const es = words("es");

describe("the field dropdown's entries", () => {
  it("lists the first accounts, the folded section with its accounts when open, then Manage passwords", () => {
    const first = [match("a"), match("b")];
    const others = [match("c", { fit: "domain" })];
    expect(dropdownEntries({ first, others, othersOpen: false }).map((e) => (e.type === "account" ? e.account.id : e.type))).toEqual(["a", "b", "others", "manage"]);
    expect(dropdownEntries({ first, others, othersOpen: true }).map((e) => (e.type === "account" ? e.account.id : e.type))).toEqual(["a", "b", "others", "c", "manage"]);
    expect(dropdownEntries({ first, others: [], othersOpen: true }).map((e) => e.type)).toEqual(["account", "account", "manage"]);
  });

  it("moves the highlight with the arrows, wrapping around", () => {
    expect(moveHighlight(null, 1, 4)).toBe(0);
    expect(moveHighlight(null, -1, 4)).toBe(3);
    expect(moveHighlight(0, 1, 4)).toBe(1);
    expect(moveHighlight(3, 1, 4)).toBe(0);
    expect(moveHighlight(0, -1, 4)).toBe(3);
    expect(moveHighlight(9, 1, 4)).toBe(0);
    expect(moveHighlight(null, 1, 0)).toBeNull();
  });
});

describe("the field dropdown's rows", () => {
  it("say the username, then the site and the KeePass database, and tag accounts without a password under a login field", () => {
    const only = match("only", { hasPassword: false, hasTotp: true });
    expect(dropdownLines(only, en)).toEqual({ user: "only@example.com", details: "central.example.com" });
    expect(dropdownTwoFaOnly(only, "login")).toBe(true);
    expect(dropdownTwoFaOnly(only, "otp")).toBe(false);
    expect(dropdownTwoFaOnly(match("pw"), "login")).toBe(false);
    expect(dropdownLabel(only, "login", en)).toBe("only@example.com  ·  central.example.com  ·  2FA only");
    expect(dropdownLabel(only, "otp", en)).toBe("2FA code for only@example.com  ·  central.example.com");
    expect(dropdownLabel(only, "login", es)).toBe("only@example.com  ·  central.example.com  ·  Solo 2FA");
    expect(dropdownLabel(match("kp", { source: "keepass", sourceName: "Work" }), "login", en)).toBe("kp@example.com  ·  central.example.com  ·  KeePass: Work");
    expect(dropdownLines(match("x", { username: "" }), es).user).toBe("(sin usuario)");
  });

  it("cut long usernames in the middle, keeping both ends", () => {
    const { user } = dropdownLines(match("x", { username: "x7q2k9m4zr8vt3wn5bpl-generated-smoke-account@example.com" }), en);
    expect(user).toHaveLength(40);
    expect(user.startsWith("x7q2k9m4zr8vt3wn5bpl")).toBe(true);
    expect(user.endsWith("account@example.com")).toBe(true);
  });
});

describe("actions from the dropdown view", () => {
  it("are checked before the main process uses them", () => {
    expect(parseDropdownAction({ type: "size", token: 3, width: 376, height: 120 })).toEqual({ type: "size", token: 3, width: 376, height: 120 });
    expect(parseDropdownAction({ type: "activate", token: 3, index: 0 })).toEqual({ type: "activate", token: 3, index: 0 });
    expect(parseDropdownAction({ type: "hover", token: 3, index: 2 })).toEqual({ type: "hover", token: 3, index: 2 });
    for (const bad of [null, "size", {}, { type: "size", token: 3, width: -1, height: 1 }, { type: "activate", token: "3", index: 0 }, { type: "activate", token: 3, index: 1.5 }, { type: "fill", token: 3, index: 0 }, { type: "size", token: 3, width: 99_999, height: 1 }]) {
      expect(parseDropdownAction(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
