import { describe, expect, it } from "vitest";
import { CertExceptions, certAgentError, certBlockReason, certErrorCode, certErrorKind, certHost, isCertNetError, isIpHost } from "../src/shared/cert-errors";

describe("certificate error mapping", () => {
  it("reads Chromium's names from certificate-error and did-fail-load", () => {
    expect(certErrorCode("net::ERR_CERT_AUTHORITY_INVALID")).toBe("ERR_CERT_AUTHORITY_INVALID");
    expect(certErrorCode("ERR_CERT_DATE_INVALID")).toBe("ERR_CERT_DATE_INVALID");
  });

  it("tells certificate failures from other load failures", () => {
    expect(isCertNetError(-202)).toBe(true);
    expect(isCertNetError(-200)).toBe(true);
    expect(isCertNetError(-150)).toBe(true);
    expect(isCertNetError(-105)).toBe(false);
    expect(isCertNetError(-300)).toBe(false);
    expect(isCertNetError(-3)).toBe(false);
  });

  it("explains each error, expired apart from not valid yet", () => {
    const now = Date.UTC(2026, 9, 29);
    const seconds = now / 1000;
    expect(certErrorKind("ERR_CERT_AUTHORITY_INVALID")).toBe("authority");
    expect(certErrorKind("ERR_CERT_COMMON_NAME_INVALID")).toBe("name");
    expect(certErrorKind("ERR_CERT_REVOKED")).toBe("revoked");
    expect(certErrorKind("ERR_CERT_WEAK_SIGNATURE_ALGORITHM")).toBe("weak");
    expect(certErrorKind("ERR_CERT_DATE_INVALID", { start: seconds - 400, expiry: seconds - 100 }, now)).toBe("expired");
    expect(certErrorKind("ERR_CERT_DATE_INVALID", { start: seconds + 100, expiry: seconds + 400 }, now)).toBe("not-yet-valid");
    expect(certErrorKind("ERR_CERT_DATE_INVALID")).toBe("date");
    expect(certErrorKind("ERR_CERT_SOMETHING_NEW")).toBe("other");
  });

  it("offers Proceed like Chrome: never for HSTS sites or errors that are never overridable", () => {
    expect(certBlockReason("ERR_CERT_AUTHORITY_INVALID", false)).toBeNull();
    expect(certBlockReason("ERR_CERT_DATE_INVALID", false)).toBeNull();
    expect(certBlockReason("ERR_CERT_AUTHORITY_INVALID", true)).toBe("hsts");
    expect(certBlockReason("ERR_CERT_REVOKED", false)).toBe("fatal");
    expect(certBlockReason("ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN", true)).toBe("fatal");
  });

  it("keys exceptions by host without port, and knows IP literals have no HSTS", () => {
    expect(certHost("https://Router.Example:8443/admin")).toBe("router.example");
    expect(certHost("not a url")).toBe("");
    expect(isIpHost("10.0.10.1")).toBe(true);
    expect(isIpHost("[::1]")).toBe(true);
    expect(isIpHost("router.example")).toBe(false);
  });

  it("tells an agent what happened and who decides", () => {
    expect(certAgentError("ERR_CERT_AUTHORITY_INVALID", "10.0.10.1", null)).toBe(
      "certificate error: ERR_CERT_AUTHORITY_INVALID for 10.0.10.1; the person must choose to proceed. Ask them to decide in that tab (Proceed or Back to safety), then continue.",
    );
    expect(certAgentError("ERR_CERT_AUTHORITY_INVALID", "example.dev", "hsts")).toContain("HSTS");
  });
});

describe("certificate exceptions", () => {
  const profile = {};
  const privateWindow = {};

  it("accept that host with that exact certificate, in that session only", () => {
    const store = new CertExceptions<object>();
    store.allow(profile, "10.0.10.1", "sha256/AAA", "ERR_CERT_AUTHORITY_INVALID");
    expect(store.allows(profile, "10.0.10.1", "sha256/AAA")).toBe(true);
    expect(store.allows(profile, "10.0.10.1", "sha256/BBB")).toBe(false);
    expect(store.allows(profile, "10.0.10.2", "sha256/AAA")).toBe(false);
    expect(store.allows(privateWindow, "10.0.10.1", "sha256/AAA")).toBe(false);
    expect(store.allows(profile, "10.0.10.1", "")).toBe(false);
  });

  it("say which error a host was let through with, until warnings are turned on again", () => {
    const store = new CertExceptions<object>();
    expect(store.errorFor(profile, "10.0.10.1")).toBeNull();
    store.allow(profile, "10.0.10.1", "sha256/AAA", "ERR_CERT_AUTHORITY_INVALID");
    expect(store.errorFor(profile, "10.0.10.1")).toBe("ERR_CERT_AUTHORITY_INVALID");
    expect(store.errorFor(privateWindow, "10.0.10.1")).toBeNull();
    expect(store.revoke(profile, "10.0.10.1")).toBe(true);
    expect(store.errorFor(profile, "10.0.10.1")).toBeNull();
    expect(store.allows(profile, "10.0.10.1", "sha256/AAA")).toBe(false);
    expect(store.revoke(profile, "10.0.10.1")).toBe(false);
  });

  it("start empty in a new store (nothing is kept across restarts)", () => {
    const before = new CertExceptions<object>();
    before.allow(profile, "10.0.10.1", "sha256/AAA", "ERR_CERT_AUTHORITY_INVALID");
    expect(new CertExceptions<object>().allows(profile, "10.0.10.1", "sha256/AAA")).toBe(false);
  });
});
