import { describe, expect, it } from "vitest";
import type { CredentialSummary } from "../src/shared/credentials";
import type { KeePassEntrySummary } from "../src/shared/keepass-ipc";
import { initialTab, pageSlice, searchTwoFactor, tabHash, twoFactorItems } from "../src/shared/password-tabs";

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
    expect([tabHash("2fa"), tabHash("passwords")]).toEqual(["#2fa", "#passwords"]);
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
