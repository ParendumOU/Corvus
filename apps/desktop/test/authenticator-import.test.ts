import { describe, expect, it } from "vitest";
import { AuthenticatorCollector, photoScales, planImport, rowsToImport, siteToOrigin, type ImportAccount, type PlanLogin } from "../src/shared/authenticator-import";
import { encodeMigrationPayload, migrationUri, type MigrationOtpInput } from "../src/shared/authenticator-migration";
import { issuerSite } from "../src/shared/authenticator-sites";
import type { TotpConfig } from "../src/shared/totp";

/** A made-up 20-byte secret, different for every seed. */
const fakeSecret = (seed: number): Uint8Array => Uint8Array.from({ length: 20 }, (_, i) => (seed * 31 + i * 7 + 1) & 0xff);

const totp = (secret: string): TotpConfig => ({ secret, algorithm: "SHA1", digits: 6, period: 30 });

const account = (id: string, issuer: string, name: string, secret = "JBSWY3DPEHPK3PXPJBSWY3DP"): ImportAccount => ({ id, issuer, account: name, config: totp(secret) });

const login = (id: string, origin: string, username: string, extra: Partial<PlanLogin> = {}): PlanLogin => ({ id, origin, username, updatedAt: 1, ...extra });

describe("issuerSite", () => {
  it("knows the sign-in page of common issuers", () => {
    expect(issuerSite("Google")).toBe("https://accounts.google.com");
    expect(issuerSite("GitHub")).toBe("https://github.com");
    expect(issuerSite("Amazon Web Services")).toBe("https://signin.aws.amazon.com");
    expect(issuerSite("X")).toBe("https://x.com");
    expect(issuerSite("Epic Games")).toBe("https://www.epicgames.com");
    expect(issuerSite("Docker Hub")).toBe("https://login.docker.com");
    expect(issuerSite("Google Cloud")).toBe("https://accounts.google.com");
  });

  it("uses an issuer that is a domain name", () => {
    expect(issuerSite("github.com")).toBe("https://github.com");
    expect(issuerSite("amazon.com")).toBe("https://www.amazon.com");
    expect(issuerSite("vault.example.org")).toBe("https://vault.example.org");
  });

  it("leaves unknown issuers empty instead of guessing", () => {
    expect(issuerSite("")).toBe("");
    expect(issuerSite("My Company VPN")).toBe("");
    expect(issuerSite("Mega Corp")).toBe("");
    expect(issuerSite("alice@example.com")).toBe("");
  });
});

describe("siteToOrigin", () => {
  it("turns what a person types into an origin", () => {
    expect(siteToOrigin("github.com")).toBe("https://github.com");
    expect(siteToOrigin(" https://GitHub.com/login ")).toBe("https://github.com");
    expect(siteToOrigin("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080");
    expect(siteToOrigin("")).toBe("");
    expect(siteToOrigin("not a site")).toBe("");
    expect(siteToOrigin("intranet")).toBe("");
    expect(siteToOrigin("ftp://example.com")).toBe("");
  });
});

describe("planImport", () => {
  it("attaches to a login on the same site with the same username, case-insensitive", () => {
    const rows = planImport([account("a1", "GitHub", "OctoCat")], [login("l1", "https://github.com", "octocat"), login("l2", "https://github.com", "other")]);
    expect(rows[0]).toMatchObject({ action: "attach", site: "https://github.com", login: { id: "l1", username: "octocat" }, selected: true });
  });

  it("matches any origin of the site, preferring the exact one", () => {
    const logins = [login("l1", "https://mail.google.com", "alice@example.com", { updatedAt: 9 }), login("l2", "https://accounts.google.com", "alice@example.com")];
    expect(planImport([account("a1", "Google", "alice@example.com")], logins)[0]!.login?.id).toBe("l2");
    expect(planImport([account("a1", "Google", "alice@example.com")], [logins[0]!])[0]!.login?.id).toBe("l1");
  });

  it("uses the only login of a site when the account name matches nothing", () => {
    const rows = planImport([account("a1", "Discord", "Some Name#1234")], [login("l1", "https://discord.com", "me@example.com")]);
    expect(rows[0]).toMatchObject({ action: "attach", login: { id: "l1" } });
  });

  it("does not use the single-login fallback when it is ambiguous", () => {
    const logins = [login("l1", "https://github.com", "octocat")];
    // Another account claims the login by name.
    expect(planImport([account("a1", "GitHub", "octocat"), account("a2", "GitHub", "work-bot", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")], logins).map((r) => r.action)).toEqual(["attach", "create"]);
    // Two accounts without a match on a site with one login.
    expect(planImport([account("a1", "GitHub", "x1"), account("a2", "GitHub", "x2", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")], logins).map((r) => r.action)).toEqual(["create", "create"]);
    // Two logins on the site and no name match.
    expect(planImport([account("a1", "GitHub", "x1")], [...logins, login("l2", "https://github.com", "hubot")])[0]!.action).toBe("create");
  });

  it("marks a different existing 2FA as a conflict, off by default, and the same one as done", () => {
    const logins = [login("l1", "https://github.com", "octocat", { totp: totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") }), login("l2", "https://gitlab.com", "octocat", { totp: totp("JBSWY3DPEHPK3PXPJBSWY3DP") })];
    const rows = planImport([account("a1", "GitHub", "octocat"), account("a2", "GitLab", "octocat")], logins);
    expect(rows.map((r) => [r.action, r.selected])).toEqual([
      ["replace", false],
      ["same", false],
    ]);
  });

  it("creates a 2FA-only login when nothing matches, and needs a site for unknown issuers", () => {
    const rows = planImport([account("a1", "Cloudflare", "ops@example.com"), account("a2", "Acme Intranet", "ops")], []);
    expect(rows[0]).toMatchObject({ action: "create", site: "https://dash.cloudflare.com", login: null, selected: true });
    expect(rows[1]).toMatchObject({ action: "needs-site", site: "", siteInput: "", selected: false });
  });

  it("re-plans with the sites the person typed", () => {
    const accounts = [account("a1", "Acme Intranet", "ops")];
    const logins = [login("l1", "https://intranet.acme.test", "ops")];
    expect(planImport(accounts, logins, { a1: "intranet.acme.test" })[0]).toMatchObject({ action: "attach", site: "https://intranet.acme.test", siteInput: "intranet.acme.test", selected: true });
    expect(planImport(accounts, logins, { a1: "nonsense" })[0]!.action).toBe("needs-site");
    expect(planImport([account("a1", "GitHub", "octocat")], [], { a1: "" })[0]!.action).toBe("needs-site");
  });

  it("selects only the first of several accounts that would write the same login", () => {
    const rows = planImport(
      [account("a1", "GitHub", "octocat"), account("a2", "GitHub", "octocat", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), account("a3", "Proton", "me"), account("a4", "Proton", "ME", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")],
      [login("l1", "https://github.com", "octocat")],
    );
    expect(rows.map((r) => [r.action, r.selected])).toEqual([
      ["attach", true],
      ["attach", false],
      ["create", true],
      ["create", false],
    ]);
    expect(rows[0]!.target).toBe(rows[1]!.target);
    expect(rows[2]!.target).toBe(rows[3]!.target);
  });
});

describe("rowsToImport", () => {
  it("keeps chosen importable rows, one per target", () => {
    const rows = planImport(
      [account("a1", "GitHub", "octocat"), account("a2", "GitHub", "octocat", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), account("a3", "Acme", "x"), account("a4", "GitLab", "y")],
      [login("l1", "https://github.com", "octocat"), login("l2", "https://gitlab.com", "y", { totp: totp("JBSWY3DPEHPK3PXPJBSWY3DP") })],
    );
    expect(rowsToImport(rows, new Set(["a1", "a2", "a3", "a4", "zz"])).map((r) => r.id)).toEqual(["a1"]);
    expect(rowsToImport(rows, new Set(["a2", "a1"])).map((r) => r.id)).toEqual(["a1"]);
    expect(rowsToImport(rows, new Set(["a2"])).map((r) => r.id)).toEqual(["a2"]);
  });
});

/** Accounts of a 12-code export like the one Google Authenticator shows for 100+ accounts. */
function exportCodes(batchId: number, perCode: number, codes: number, seedBase: number): string[] {
  const issuers = ["Google", "GitHub", "Microsoft", "Discord", "Cloudflare", "Acme Intranet"];
  return Array.from({ length: codes }, (_, index) => {
    const otps: MigrationOtpInput[] = Array.from({ length: perCode }, (_, k) => {
      const n = index * perCode + k;
      const issuer = issuers[n % issuers.length]!;
      return { secret: fakeSecret(seedBase + n), name: `${issuer}:user${n}@example.com`, issuer };
    });
    if (index === 3) otps.push({ secret: fakeSecret(999), name: "Bank:hotp", issuer: "Bank", type: 1, counter: 3 });
    return migrationUri(encodeMigrationPayload(otps, { batchSize: codes, batchIndex: index, batchId }));
  });
}

describe("AuthenticatorCollector", () => {
  it("merges a 12-code export of 108 accounts, ignores a code photographed twice and reports a missing one", () => {
    const codes = exportCodes(-123456789, 9, 12, 0);
    const collector = new AuthenticatorCollector();
    const statuses = [...codes.filter((_, i) => i !== 6), codes[2]!].map((c) => collector.add(c));
    expect(statuses[0]).toEqual({ kind: "batch", exportNo: 1, index: 1, size: 12, accounts: 9, again: false });
    expect(statuses[3]).toEqual({ kind: "batch", exportNo: 1, index: 4, size: 12, accounts: 10, again: false });
    expect(statuses.at(-1)).toEqual({ kind: "batch", exportNo: 1, index: 3, size: 12, accounts: 9, again: true });
    expect(collector.accounts).toHaveLength(99);
    expect(new Set(collector.accounts.map((a) => a.id)).size).toBe(99);
    expect(collector.skipped).toEqual([{ issuer: "Bank", account: "hotp", reason: "hotp" }]);
    expect(collector.missing()).toEqual([{ exportNo: 1, size: 12, missing: [7] }]);

    expect(collector.add(codes[6]!)).toMatchObject({ kind: "batch", index: 7, again: false });
    expect(collector.accounts).toHaveLength(108);
    expect(collector.missing()).toEqual([]);

    const rows = planImport(collector.accounts, [login("l1", "https://github.com", "user1@example.com")]);
    expect(rows).toHaveLength(108);
    expect(rows.filter((r) => r.action === "attach")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "needs-site")).toHaveLength(18);
    expect(rows.filter((r) => r.action === "create")).toHaveLength(89);
  });

  it("merges the same accounts from a second export and tells exports apart", () => {
    const collector = new AuthenticatorCollector();
    for (const c of exportCodes(1, 5, 2, 0)) collector.add(c);
    // A later export of the same accounts plus two new ones.
    const second = migrationUri(
      encodeMigrationPayload(
        [
          { secret: fakeSecret(0), name: "Google:user0@example.com", issuer: "Google" },
          { secret: fakeSecret(500), name: "new@example.com", issuer: "Proton" },
          { secret: fakeSecret(501), name: "Reddit:new", issuer: "" },
        ],
        { batchSize: 2, batchIndex: 0, batchId: 2 },
      ),
    );
    expect(collector.add(second)).toEqual({ kind: "batch", exportNo: 2, index: 1, size: 2, accounts: 3, again: false });
    expect(collector.exportCount).toBe(2);
    expect(collector.accounts).toHaveLength(12);
    expect(collector.accounts.at(-1)).toMatchObject({ issuer: "Reddit", account: "new" });
    expect(collector.missing()).toEqual([{ exportNo: 2, size: 2, missing: [2] }]);
  });

  it("takes setup codes too, and says what other codes were", () => {
    const collector = new AuthenticatorCollector();
    const setup = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
    expect(collector.add(setup)).toEqual({ kind: "setup", issuer: "GitHub", account: "octocat", again: false });
    expect(collector.add(setup)).toMatchObject({ kind: "setup", again: true });
    expect(collector.add("https://example.com")).toEqual({ kind: "not-2fa" });
    expect(collector.add("otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1")).toEqual({ kind: "not-2fa" });
    expect(collector.add("otpauth://totp/X?secret=***")).toEqual({ kind: "damaged" });
    expect(collector.add("otpauth-migration://offline?data=CjEKCkhlbGxv")).toEqual({ kind: "damaged" });
    expect(collector.accounts).toHaveLength(1);
    expect(collector.exportCount).toBe(0);
  });
});

describe("photoScales", () => {
  it("tries a few sizes of a large photo, never above 4096 px, and a small one as it is", () => {
    expect(photoScales(4032)).toEqual([1600, 2400, 3200, 2000, 2800, 1100, 4032]);
    expect(photoScales(8160)).toEqual([1600, 2400, 3200, 2000, 2800, 1100, 4096]);
    expect(photoScales(2200)).toEqual([1600, 2000, 1100, 2200]);
    expect(photoScales(1200)).toEqual([1200]);
  });
});
