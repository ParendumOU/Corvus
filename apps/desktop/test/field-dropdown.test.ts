import { describe, expect, it } from "vitest";
import type { CredentialMatch } from "../src/shared/credentials";
import { DROPDOWN_GAP, dropdownAccounts, dropdownBounds, dropdownEntries, dropdownLabel, dropdownLines, dropdownMayOpen, dropdownStays, dropdownTwoFaOnly, moveHighlight, parseDropdownAction } from "../src/shared/field-dropdown";
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

describe("where the field dropdown goes", () => {
  // The page's area in the window (under the toolbar), and a 360 x 150 dropdown.
  const area = { x: 0, y: 112, width: 1280, height: 700 };
  const size = { width: 360, height: 150 };
  const field = (x: number, y: number) => ({ x, y, width: 300, height: 30 });

  it("goes right under the field, its left edge on the field's", () => {
    expect(dropdownBounds(field(100, 200), size, area)).toEqual({ x: 100, y: 230 + DROPDOWN_GAP, width: 360, height: 150 });
  });

  it("stays inside the page's area: moved left at its right edge, never left of it (a sidebar of vertical tabs)", () => {
    expect(dropdownBounds(field(1100, 200), size, area).x).toBe(1280 - 360);
    expect(dropdownBounds(field(150, 200), size, { ...area, x: 240, width: 1040 }).x).toBe(240);
  });

  it("goes over the field when there is no room below and there is above", () => {
    expect(dropdownBounds(field(100, 700), size, area)).toEqual({ x: 100, y: 700 - 150 - DROPDOWN_GAP, width: 360, height: 150 });
  });

  it("stays under the field, cut to the page's area, when there is room neither below nor above", () => {
    expect(dropdownBounds(field(100, 200), { width: 360, height: 900 }, area)).toEqual({ x: 100, y: 232, width: 360, height: 812 - 232 });
  });

  it("is never wider than the page's area", () => {
    expect(dropdownBounds(field(0, 200), size, { ...area, width: 300 })).toMatchObject({ x: 0, width: 300 });
  });
});

describe("when the field dropdown closes", () => {
  const bounds = { x: 0, y: 112, width: 1280, height: 700 };

  it("stays only while its page is the active tab's, shown, where it was when it opened", () => {
    expect(dropdownStays({ active: true, visible: true, bounds: { ...bounds } }, bounds)).toBe(true);
    // Another tab (a click on the strip, an agent), the page hidden, or moved: a split view, the sidebar, the Assist panel.
    expect(dropdownStays({ active: false, visible: true, bounds }, bounds)).toBe(false);
    expect(dropdownStays({ active: true, visible: false, bounds }, bounds)).toBe(false);
    expect(dropdownStays({ active: true, visible: true, bounds: { ...bounds, width: 640 } }, bounds)).toBe(false);
    expect(dropdownStays({ active: true, visible: true, bounds: { ...bounds, x: 240, width: 1040 } }, bounds)).toBe(false);
    expect(dropdownStays({ active: true, visible: true, bounds: { ...bounds, y: 140, height: 672 } }, bounds)).toBe(false);
  });
});

describe("which accounts the field dropdown offers", () => {
  const password = match("pw");
  const twoFa = match("totp", { hasTotp: true });

  it("lists all of the page's accounts under a login field, those with a 2FA under a code field", () => {
    expect(dropdownAccounts("login", [password, twoFa])).toEqual([password, twoFa]);
    expect(dropdownAccounts("otp", [password, twoFa])).toEqual([twoFa]);
  });

  it("can open (its view is loaded ahead) only on a page with such a field and accounts for it", () => {
    expect(dropdownMayOpen({ login: true, otp: false }, [password])).toBe(true);
    expect(dropdownMayOpen({ login: false, otp: true }, [twoFa])).toBe(true);
    expect(dropdownMayOpen({ login: false, otp: true }, [password])).toBe(false);
    expect(dropdownMayOpen({ login: true, otp: true }, [])).toBe(false);
    expect(dropdownMayOpen({ login: false, otp: false }, [password, twoFa])).toBe(false);
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
