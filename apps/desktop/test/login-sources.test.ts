import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountDetails, loginDomainOf, loginFit, middleEllipsis, splitAccounts, type CredentialMatch } from "../src/shared/credentials";
import type { TotpConfig } from "../src/shared/totp";
import { CredentialVault } from "../src/main/credential-store";
import { entryFit } from "../src/main/keepass-entries";
import { lastUsedFirst, LoginSources, vaultProvider, type LoginProvider, type LoginRecord } from "../src/main/login-sources";
import type { SecretCipher } from "../src/main/settings-store";

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const TOTP: TotpConfig = { secret: "JBSWY3DPEHPK3PXPJBSWY3DP", algorithm: "SHA1", digits: 6, period: 30 };
const TOTP2: TotpConfig = { secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", algorithm: "SHA1", digits: 6, period: 30 };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function vault(): CredentialVault {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-logins-"));
  dirs.push(dir);
  return new CredentialVault(dir, keychain);
}

/** A KeePass database stand-in: entries with URLs, matched the way the real provider does. */
function keepass(entries: Array<{ id: string; username: string; password: string; urls: string[]; totp?: TotpConfig; modified?: number }>): LoginProvider {
  const record = (e: (typeof entries)[number]): LoginRecord => ({
    id: e.id,
    source: "keepass",
    sourceName: "Work",
    site: e.urls[0] ?? "",
    username: e.username,
    password: e.password,
    ...(e.totp ? { totp: e.totp } : {}),
    agentTotp: false,
    agentSignIn: false,
    updatedAt: e.modified ?? 0,
  });
  return {
    matches: () => [],
    candidates: (url) => entries.flatMap((e) => {
      const fit = entryFit(e, url);
      return fit ? [{ record: record(e), ...fit }] : [];
    }),
    get: (id) => {
      const e = entries.find((x) => x.id === id);
      return e ? record(e) : undefined;
    },
  };
}

/** Adds a login with a given last update, so tests can order them. */
function add(v: CredentialVault, origin: string, username: string, password: string, updatedAt: number, totp?: TotpConfig): string {
  const c = v.add({ origin, username, password, ...(totp ? { totp } : {}) });
  (v.get(c.id) as { updatedAt: number }).updatedAt = updatedAt;
  return c.id;
}

describe("loginDomainOf and loginFit", () => {
  it("shares logins across the hosts of one registrable domain only", () => {
    expect(loginDomainOf("central.example.com")).toBe("example.com");
    expect(loginDomainOf("www.example.com")).toBe("example.com");
    expect(loginDomainOf("a.b.example.co.uk")).toBe("example.co.uk");
    expect(loginDomainOf("shop.example.com.es")).toBe("example.com.es");
    for (const host of ["127.0.0.1", "localhost", "intranet", "app.herokuapp.com", "me.github.io", "x.web.app", "[::1]"]) expect(loginDomainOf(host), host).toBe("");
  });

  it("says how a saved site fits a page", () => {
    const at = (scheme: "http:" | "https:" | null, host: string, port = "") => ({ scheme, host, port });
    expect(loginFit(at("https:", "central.example.com"), "https://central.example.com/login")).toBe("exact");
    expect(loginFit(at(null, "central.example.com"), "http://central.example.com/")).toBe("exact");
    expect(loginFit(at("https:", "example.com"), "https://central.example.com/")).toBe("domain");
    expect(loginFit(at("https:", "app.example.com"), "https://central.example.com/")).toBe("domain");
    expect(loginFit(at("https:", "example.org"), "https://example.com/")).toBeNull();
    expect(loginFit(at("https:", "example.co.uk"), "https://other.co.uk/")).toBeNull();
    expect(loginFit(at("https:", "a.github.io"), "https://b.github.io/")).toBeNull();
    expect(loginFit(at("https:", "central.example.com"), "http://central.example.com/")).toBeNull();
    expect(loginFit(at("http:", "127.0.0.1", "8080"), "http://127.0.0.1:8080/x")).toBe("exact");
    expect(loginFit(at("http:", "127.0.0.1", "8080"), "http://127.0.0.1:9090/x")).toBeNull();
    expect(loginFit(at("https:", "example.com"), "corvus://passwords")).toBeNull();
  });
});

describe("LoginSources accounts", () => {
  it("merges a 2FA-only login and a login with a password of the same user into one account", () => {
    const v = vault();
    const real = add(v, "https://central.example.com", "info@example.com", "pw-real", 5);
    const only = add(v, "https://central.example.com", "Info@Example.com ", "", 9, TOTP);
    const logins = new LoginSources(() => [vaultProvider(v)]);
    const [account, ...rest] = logins.accounts("https://central.example.com/login");
    expect(rest).toEqual([]);
    expect(account).toMatchObject({ id: real, username: "info@example.com" });
    expect(account!.password?.record.password).toBe("pw-real");
    expect(account!.totp?.record.id).toBe(only);
    expect(logins.matchesFor("https://central.example.com/")).toEqual([{ id: real, username: "info@example.com", site: "central.example.com", hasPassword: true, hasTotp: true, source: "corvus", fit: "exact" }]);
    // Either login's id names the account; never on another site.
    expect(logins.accountFor(only, "https://central.example.com/")?.id).toBe(real);
    expect(logins.accountFor(real, "https://example.org/")).toBeUndefined();
    expect(JSON.stringify(logins.matchesFor("https://central.example.com/"))).not.toContain("pw-real");
  });

  it("marks an account 2FA only when none of its logins has a password", () => {
    const v = vault();
    const only = add(v, "https://central.example.com", "info@example.com", "", 1, TOTP);
    expect(new LoginSources(() => [vaultProvider(v)]).matchesFor("https://central.example.com/")).toEqual([
      { id: only, username: "info@example.com", site: "central.example.com", hasPassword: false, hasTotp: true, source: "corvus", fit: "exact" },
    ]);
  });

  it("prefers the page's own origin, then the newest, for the password and the 2FA", () => {
    const v = vault();
    add(v, "https://example.com", "info@example.com", "pw-domain", 9, TOTP2);
    const exact = add(v, "https://central.example.com", "info@example.com", "pw-exact", 1);
    const logins = new LoginSources(() => [vaultProvider(v)]);
    const account = logins.accountFor(exact, "https://central.example.com/")!;
    expect(account.password?.record.password).toBe("pw-exact");
    // The password's login has no 2FA: the best login that has one gives it.
    expect(account.totp?.record.totp).toEqual(TOTP2);
    expect(logins.matchesFor("https://central.example.com/")[0]).toMatchObject({ site: "central.example.com", hasTotp: true });
    // On another host of the site, the newest wins.
    expect(logins.accountFor(exact, "https://app.example.com/")?.password?.record.password).toBe("pw-domain");
  });

  it("takes the 2FA from the password's own login first", () => {
    const v = vault();
    add(v, "https://central.example.com", "info@example.com", "", 9, TOTP2);
    const real = add(v, "https://central.example.com", "info@example.com", "pw", 1, TOTP);
    expect(new LoginSources(() => [vaultProvider(v)]).accountFor(real, "https://central.example.com/")?.totp?.record.totp).toEqual(TOTP);
  });

  it("offers logins of the other hosts of the site, never of another registrable domain", () => {
    const v = vault();
    add(v, "https://example.com", "root@example.com", "pw1", 1);
    add(v, "https://example.org", "other@example.org", "pw2", 2);
    add(v, "https://central.example.com", "info@example.com", "pw3", 3);
    const logins = new LoginSources(() => [vaultProvider(v)]);
    expect(logins.matchesFor("https://app.example.com/").map((m) => [m.username, m.site])).toEqual([
      ["info@example.com", "central.example.com"],
      ["root@example.com", "example.com"],
    ]);
    expect(logins.matchesFor("https://example.org/").map((m) => m.username)).toEqual(["other@example.org"]);
    expect(logins.matchesFor("http://example.com/")).toEqual([]);
  });

  it("keeps several users of a site apart, the page's own logins first", () => {
    const v = vault();
    add(v, "https://example.com", "alice@example.com", "pw-a", 9);
    add(v, "https://central.example.com", "bob@example.com", "pw-b", 1);
    add(v, "https://central.example.com", "carol@example.com", "pw-c", 2);
    expect(new LoginSources(() => [vaultProvider(v)]).matchesFor("https://central.example.com/").map((m) => m.username)).toEqual(["carol@example.com", "bob@example.com", "alice@example.com"]);
  });

  it("merges KeePass and built-in logins of one user", () => {
    const v = vault();
    const only = add(v, "https://central.example.com", "info@example.com", "", 9, TOTP);
    const kp = keepass([
      { id: "kp:db:1", username: "INFO@example.com", password: "kp-pw", urls: ["example.com"], modified: 1 },
      { id: "kp:db:2", username: "ops", password: "kp-ops", urls: ["https://other.example.org"] },
    ]);
    const logins = new LoginSources(() => [vaultProvider(v), kp]);
    expect(logins.matchesFor("https://central.example.com/")).toEqual([{ id: "kp:db:1", username: "INFO@example.com", site: "example.com", hasPassword: true, hasTotp: true, source: "keepass", sourceName: "Work", fit: "exact" }]);
    const account = logins.accountFor(only, "https://central.example.com/")!;
    expect([account.password?.record.password, account.totp?.record.id]).toEqual(["kp-pw", only]);
  });

  it("leaves agents and auto sign-in with the page's own logins", () => {
    const v = vault();
    const exact = add(v, "https://central.example.com", "info@example.com", "pw", 1);
    const domain = add(v, "https://example.com", "info@example.com", "", 2, TOTP);
    const logins = new LoginSources(() => [vaultProvider(v)]);
    expect(logins.records("https://central.example.com/").map((r) => r.id)).toEqual([exact]);
    expect(logins.forPage(domain, "https://central.example.com/")).toBeUndefined();
    expect(logins.accountFor(domain, "https://central.example.com/")?.id).toBe(exact);
  });
});

describe("accountDetails", () => {
  const match = (extra: Partial<CredentialMatch>): CredentialMatch => ({ id: "x", username: "info@example.com", site: "central.example.com", hasPassword: true, hasTotp: false, source: "corvus", fit: "exact", ...extra });

  it("shows the site, the KeePass database and 2FA only", () => {
    expect(accountDetails(match({}), "2FA only")).toEqual(["central.example.com"]);
    expect(accountDetails(match({ hasPassword: false, hasTotp: true }), "Solo 2FA")).toEqual(["central.example.com", "Solo 2FA"]);
    expect(accountDetails(match({ source: "keepass", sourceName: "Work" }), "2FA only")).toEqual(["central.example.com", "KeePass: Work"]);
    expect(accountDetails(match({ source: "keepass", sourceName: "Work" }), "2FA only", { source: false })).toEqual(["central.example.com"]);
  });
});

describe("the page's own host first", () => {
  it("tells accounts of the page's own host from those of the domain's other hosts", () => {
    const v = vault();
    const own = add(v, "https://edge.example.com", "admin", "pw-edge", 1);
    // A 2FA saved on another host of the domain still joins the page's own account.
    add(v, "https://example.com", "ADMIN", "", 2, TOTP);
    const central = add(v, "https://central.example.com", "info@example.com", "", 3, TOTP2);
    const home = add(v, "https://home.example.com", "home", "pw-home", 4);
    const matches = new LoginSources(() => [vaultProvider(v)]).matchesFor("https://edge.example.com/login");
    expect(matches.map((m) => [m.id, m.fit, m.hasTotp])).toEqual([
      [own, "exact", true],
      [home, "domain", false],
      [central, "domain", true],
    ]);
    const { first, others } = splitAccounts(matches);
    expect(first.map((m) => m.id)).toEqual([own]);
    expect(others.map((m) => m.id)).toEqual([home, central]);
  });

  it("offers the account used last on the site first, the others below it in their order", () => {
    const v = vault();
    const admin = add(v, "https://edge.example.com", "admin", "pw-edge", 5);
    const adminTotp = add(v, "https://example.com", "admin", "", 1, TOTP);
    const info = add(v, "https://central.example.com", "info@example.com", "", 3, TOTP2);
    const cloud = add(v, "https://cloud.example.com", "cloud@example.com", "", 9, TOTP);
    const logins = new LoginSources(() => [vaultProvider(v)]);
    const page = "https://verify.example.com/2fa";
    expect(logins.matchesFor(page).map((m) => m.id)).toEqual([cloud, admin, info]);
    expect(logins.matchesFor(page, info).map((m) => m.id)).toEqual([info, cloud, admin]);
    // Any login of the account names it (here the 2FA-only one merged into admin's account).
    expect(logins.matchesFor(page, adminTotp).map((m) => m.id)).toEqual([admin, cloud, info]);
    // A login that is gone, or of another site, changes nothing.
    expect(logins.matchesFor(page, "gone").map((m) => m.id)).toEqual([cloud, admin, info]);
    expect(lastUsedFirst([], info)).toEqual([]);
    // On a host with its own account, that account still leads its section; the last used leads the others.
    const onEdge = logins.matchesFor("https://edge.example.com/login", info);
    expect(splitAccounts(onEdge)).toEqual({ first: [expect.objectContaining({ id: admin })], others: [expect.objectContaining({ id: info }), expect.objectContaining({ id: cloud })] });
  });

  it("lists the domain's accounts first when the page's own host has none", () => {
    const domainOnly = [{ id: "a", fit: "domain" as const }, { id: "b", fit: "domain" as const }];
    expect(splitAccounts(domainOnly)).toEqual({ first: domainOnly, others: [] });
    expect(splitAccounts([])).toEqual({ first: [], others: [] });
  });
});

describe("menu labels", () => {
  const match = (extra: Partial<CredentialMatch>): CredentialMatch => ({ id: "x", username: "info@example.com", site: "central.example.com", hasPassword: false, hasTotp: true, source: "corvus", fit: "exact", ...extra });

  it("leaves 2FA only out when the menu is about the code", () => {
    expect(accountDetails(match({}), "")).toEqual(["central.example.com"]);
  });

  it("cuts long labels in the middle, keeping both ends", () => {
    const long = "x7q2k9m4zr8vt3wn5bpl-generated-account@example.com";
    const cut = middleEllipsis(long, 32);
    expect(cut).toHaveLength(32);
    expect(cut.startsWith("x7q2k9m4zr8vt3wn")).toBe(true);
    expect(cut.endsWith("unt@example.com")).toBe(true);
    expect(cut).toContain("\u2026");
    expect(middleEllipsis("short@example.com", 32)).toBe("short@example.com");
  });
});
