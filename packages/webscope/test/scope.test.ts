import { describe, expect, it } from "vitest";
import { emptyScope, isInScope, normalizeHost, parseTarget, scopeEntry, scopeRejectionReason } from "../src/scope.js";
import type { Scope } from "../src/types.js";

function scopeWith(include = [scopeEntry("example.com")], exclude: ReturnType<typeof scopeEntry>[] = []): Scope {
  return { enabled: true, include, exclude };
}

describe("parseTarget", () => {
  it("drops userinfo so an in-scope host cannot be smuggled into the authority", () => {
    const t = parseTarget("https://example.com@evil.com/path");
    expect(t?.host).toBe("evil.com");
  });
  it("rejects non-http(s) schemes", () => {
    expect(parseTarget("file:///etc/passwd")).toBeNull();
    expect(parseTarget("javascript:alert(1)")).toBeNull();
    expect(parseTarget("not a url")).toBeNull();
  });
});

describe("normalizeHost", () => {
  it("lowercases, strips trailing dot and IPv6 brackets", () => {
    expect(normalizeHost("EXAMPLE.com.")).toBe("example.com");
    expect(normalizeHost("[::1]")).toBe("::1");
  });
});

describe("isInScope", () => {
  it("is false when scope is disabled", () => {
    expect(isInScope({ ...scopeWith(), enabled: false }, "https://example.com/")).toBe(false);
  });
  it("requires an include match", () => {
    expect(isInScope(scopeWith(), "https://example.com/")).toBe(true);
    expect(isInScope(scopeWith(), "https://other.com/")).toBe(false);
  });
  it("lets exclude win over include", () => {
    expect(isInScope(scopeWith([scopeEntry("*.example.com")], [scopeEntry("secret.example.com")]), "https://secret.example.com/")).toBe(false);
    expect(isInScope(scopeWith([scopeEntry("*.example.com")], [scopeEntry("secret.example.com")]), "https://app.example.com/")).toBe(true);
  });
  it("matches wildcard hosts but stays anchored (no partial-host bypass)", () => {
    expect(isInScope(scopeWith([scopeEntry("*.example.com")]), "https://api.example.com/")).toBe(true);
    expect(isInScope(scopeWith([scopeEntry("*.example.com")]), "https://example.com.evil.com/")).toBe(false);
    expect(isInScope(scopeWith([scopeEntry("example.com")]), "https://notexample.com/")).toBe(false);
  });
  it("honours port and path-prefix constraints", () => {
    expect(isInScope(scopeWith([scopeEntry("example.com", { port: 8443 })]), "https://example.com:8443/")).toBe(true);
    expect(isInScope(scopeWith([scopeEntry("example.com", { port: 8443 })]), "https://example.com/")).toBe(false);
    expect(isInScope(scopeWith([scopeEntry("example.com", { pathPrefix: "/api" })]), "https://example.com/api/users")).toBe(true);
    expect(isInScope(scopeWith([scopeEntry("example.com", { pathPrefix: "/api" })]), "https://example.com/admin")).toBe(false);
  });
  it("ignores disabled include entries", () => {
    expect(isInScope(scopeWith([scopeEntry("example.com", { enabled: false })]), "https://example.com/")).toBe(false);
  });
});

describe("scopeRejectionReason", () => {
  it("explains why a URL is out of scope and is null when in scope", () => {
    expect(scopeRejectionReason(emptyScope(), "https://example.com/")).toMatch(/disabled/);
    expect(scopeRejectionReason(scopeWith(), "https://other.com/")).toMatch(/not in the allowlist/);
    expect(scopeRejectionReason(scopeWith([scopeEntry("*.x.com")], [scopeEntry("a.x.com")]), "https://a.x.com/")).toMatch(/excluded/);
    expect(scopeRejectionReason(scopeWith(), "https://example.com/")).toBeNull();
  });
});
