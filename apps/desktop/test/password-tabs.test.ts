import { describe, expect, it } from "vitest";
import type { CredentialSummary } from "../src/shared/credentials";
import type { KeePassEntrySummary } from "../src/shared/keepass-ipc";
import { deleteChoices, deleteTargetOf, initialDeleteChoice, initialTab, keepassEntryChanged, pageSlice, searchTwoFactor, sortLogins, tabHash, twoFactorItems } from "../src/shared/password-tabs";

const login = (id: string, origin: string, username: string, extra: Partial<CredentialSummary> = {}): CredentialSummary => ({
  id,
  origin,
  username,
  hasNotes: false,
  hasPassword: true,
  hasTotp: true,
  agentTotp: false,
  agentSignIn: false,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const entry = (id: string, site: string, username: string, extra: Partial<KeePassEntrySummary> = {}): KeePassEntrySummary => ({
  id,
  dbId: "db",
  dbName: "Work",
  title: "Issuer",
  username,
  site,
  group: "",
  hasPassword: true,
  hasTotp: true,
  agentTotp: false,
  agentSignIn: false,
  ...extra,
});

describe("initialTab", () => {
  it("follows the link's hash, then the tab chosen last", () => {
    expect(initialTab("#2fa", null)).toBe("2fa");
    expect(initialTab("#2FA", "passwords")).toBe("2fa");
    expect(initialTab("#passwords", "2fa")).toBe("passwords");
    expect(initialTab("#keepass", "2fa")).toBe("passwords");
    expect(initialTab("", "2fa")).toBe("2fa");
    expect(initialTab("", null)).toBe("passwords");
    expect(initialTab("#other", "junk")).toBe("passwords");
    expect(initialTab("#addresses", "2fa")).toBe("addresses");
    expect(initialTab("", "addresses")).toBe("addresses");
    expect(initialTab("#cards", "2fa")).toBe("cards");
    expect(initialTab("", "cards")).toBe("cards");
    expect([tabHash("2fa"), tabHash("passwords"), tabHash("addresses"), tabHash("cards")]).toEqual(["#2fa", "#passwords", "#addresses", "#cards"]);
  });
});

describe("pageSlice", () => {
  const items = Array.from({ length: 130 }, (_, i) => i);

  it("gives one page and clamps the page to the ones there are", () => {
    expect(pageSlice(items, 0)).toEqual({ items: items.slice(0, 25), page: 0 });
    expect(pageSlice(items, 5)).toEqual({ items: items.slice(125), page: 5 });
    expect(pageSlice(items, 9).page).toBe(5);
    expect(pageSlice(items, -3).page).toBe(0);
    expect(pageSlice(items.slice(0, 30), 4)).toEqual({ items: items.slice(25, 30), page: 1 });
    expect(pageSlice([], 2)).toEqual({ items: [], page: 0 });
    expect(pageSlice(items, 1, 50).items).toHaveLength(50);
  });
});

describe("twoFactorItems and searchTwoFactor", () => {
  const vault = [
    login("v1", "https://central.example.com", "info@example.com"),
    login("v2", "https://example.org", "zed@example.org", { hasPassword: false }),
    login("v3", "https://nope.example.net", "no-2fa@example.org", { hasTotp: false }),
    login("v4", "https://www.alpha.example.com:8443", "amy@example.com"),
  ];
  const keepass = [entry("k1", "bank.example.com", "acct-7", { title: "Bank", dbName: "Personal" }), entry("k2", "", "ops", { title: "VPN" }), entry("k3", "x.example.com", "x", { hasTotp: false })];

  it("lists the logins with a 2FA from both sources, by site then username", () => {
    const items = twoFactorItems(vault, keepass);
    expect(items.map((i) => [i.id, i.site, i.source, i.hasPassword])).toEqual([
      ["v4", "www.alpha.example.com:8443", "corvus", true],
      ["k1", "bank.example.com", "keepass", true],
      ["v1", "central.example.com", "corvus", true],
      ["v2", "example.org", "corvus", false],
      ["k2", "", "keepass", true],
    ]);
    expect(items.find((i) => i.id === "k1")).toMatchObject({ sourceName: "Personal", url: "https://bank.example.com", title: "Bank" });
    expect(items.find((i) => i.id === "k2")?.url).toBe("");
  });

  it("searches the site, the username, the issuer and the database", () => {
    const items = twoFactorItems(vault, keepass);
    expect(searchTwoFactor(items, "CENTRAL").map((i) => i.id)).toEqual(["v1"]);
    expect(searchTwoFactor(items, "zed@").map((i) => i.id)).toEqual(["v2"]);
    expect(searchTwoFactor(items, "vpn").map((i) => i.id)).toEqual(["k2"]);
    expect(searchTwoFactor(items, "personal").map((i) => i.id)).toEqual(["k1"]);
    expect(searchTwoFactor(items, "  ")).toHaveLength(5);
    expect(searchTwoFactor(items, "missing")).toEqual([]);
  });
});

describe("deleting a login", () => {
  it("offers Remove the 2FA only only for a login that keeps a password", () => {
    expect(deleteChoices({ hasPassword: true, hasTotp: true })).toEqual(["totp", "login"]);
    expect(deleteChoices({ hasPassword: false, hasTotp: true })).toEqual(["login"]);
    expect(deleteChoices({ hasPassword: true, hasTotp: false })).toEqual(["login"]);
  });

  it("starts on what the row is about: the 2FA in the 2FA codes tab, the login in the Passwords tab", () => {
    expect(initialDeleteChoice({ hasPassword: true, hasTotp: true }, "2fa")).toBe("totp");
    expect(initialDeleteChoice({ hasPassword: true, hasTotp: true }, "passwords")).toBe("login");
    expect(initialDeleteChoice({ hasPassword: false, hasTotp: true }, "2fa")).toBe("login");
  });

  it("names the login the same way from either tab", () => {
    const vault = login("c1", "https://mail.example.com", "alice@example.com", { hasPassword: false });
    const kp = entry("kp:db:u1", "", "bob", { title: "Example Bank" });
    const items = twoFactorItems([vault], [kp]);
    expect(deleteTargetOf.login(vault)).toEqual({ id: "c1", source: "corvus", sourceName: "", site: "mail.example.com", username: "alice@example.com", hasPassword: false, hasTotp: true });
    expect(deleteTargetOf.twoFactor(items.find((i) => i.source === "corvus")!)).toEqual(deleteTargetOf.login(vault));
    expect(deleteTargetOf.keepass(kp)).toEqual({ id: "kp:db:u1", source: "keepass", sourceName: "Work", site: "Example Bank", username: "bob", hasPassword: true, hasTotp: true });
    expect(deleteTargetOf.twoFactor(items.find((i) => i.source === "keepass")!)).toEqual(deleteTargetOf.keepass(kp));
  });
});

describe("sortLogins", () => {
  it("lists the saved logins by site (www. aside), then username, as the table's columns read", () => {
    const list = [
      login("1", "https://www.zeta.example.com", "amy"),
      login("2", "https://alpha.example.org", "zoe"),
      login("3", "https://alpha.example.org", "Bob"),
      login("4", "https://mid.example.net", ""),
    ];
    expect(sortLogins(list).map((c) => c.id)).toEqual(["3", "2", "4", "1"]);
    expect(list.map((c) => c.id)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("keepassEntryChanged", () => {
  const loaded = { title: "Example", username: "alice", url: "https://example.com", notes: "n", group: "Work" };

  it("is false when only what lives outside the file could have changed (the AI options)", () => {
    expect(keepassEntryChanged(loaded, { ...loaded }, "", "")).toBe(false);
    expect(keepassEntryChanged(loaded, { ...loaded }, "", "   ")).toBe(false);
  });

  it("is true for any field of the entry, a new password or a new 2FA", () => {
    for (const patch of [{ title: "x" }, { username: "x" }, { url: "x" }, { notes: "x" }, { group: "x" }]) {
      expect(keepassEntryChanged(loaded, { ...loaded, ...patch }, "", "")).toBe(true);
    }
    expect(keepassEntryChanged(loaded, { ...loaded }, "new-pass", "")).toBe(true);
    expect(keepassEntryChanged(loaded, { ...loaded }, "", "JBSWY3DPEHPK3PXP")).toBe(true);
  });
});
