import { describe, expect, it, vi } from "vitest";
import { SECRET_FILL_LOCK_MESSAGE, SecretFillGuard } from "../src/main/secret-fill-guard";

describe("SecretFillGuard", () => {
  it("locks a tab after a fill and unlocks it on a new document", () => {
    const guard = new SecretFillGuard();
    expect(guard.check("t1")).toBeNull();
    guard.mark("t1");
    expect(guard.isLocked("t1")).toBe(true);
    expect(guard.check("t1")).toBe(SECRET_FILL_LOCK_MESSAGE);
    expect(guard.check("t2")).toBeNull();
    expect(guard.clear("t1")).toBe(true);
    expect(guard.check("t1")).toBeNull();
    expect(guard.clear("t1")).toBe(false);
  });

  it("recognises a filled value in captured requests in any wire form, for ten minutes", () => {
    const guard = new SecretFillGuard();
    const req = (body: string, url = "https://a.test/session") => ({ url, headers: [], body });
    guard.mark("t1", ["pa ss&wörd", "123"]);
    guard.clear("t1");
    expect(guard.isSensitiveRequest(null, req("user=a&pass=pa+ss%26w%C3%B6rd"))).toBe(true);
    expect(guard.isSensitiveRequest(null, req('{"password":"pa ss&wörd"}'))).toBe(true);
    expect(guard.isSensitiveRequest(null, req("x", "https://a.test/?p=pa%20ss%26w%C3%B6rd"))).toBe(true);
    expect(guard.isSensitiveRequest(null, req("unrelated=1"))).toBe(false);
    // Values shorter than 4 characters are not remembered: they would match too much traffic.
    expect(guard.isSensitiveRequest(null, req("n=123"))).toBe(false);
    // Binary bodies are not searched.
    expect(guard.isSensitiveRequest(null, { url: "https://a.test/", headers: [], body: "pa ss&wörd", bodyBase64: true })).toBe(false);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(guard.containsFilledValue("pa ss&wörd")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks every request from a locked tab", () => {
    const guard = new SecretFillGuard();
    guard.mark("t1");
    expect(guard.isSensitiveRequest("t1", { url: "https://a.test/track", headers: [] })).toBe(true);
    expect(guard.isSensitiveRequest("t2", { url: "https://a.test/track", headers: [] })).toBe(false);
  });

  it("tells the agent why and what to do instead, without any secret", () => {
    expect(SECRET_FILL_LOCK_MESSAGE).toMatch(/password or 2FA code/);
    expect(SECRET_FILL_LOCK_MESSAGE).toMatch(/navigate/);
    expect(SECRET_FILL_LOCK_MESSAGE).toMatch(/ask the user/);
  });
});
