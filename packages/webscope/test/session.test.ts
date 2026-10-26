import { describe, expect, it } from "vitest";
import { WebScopeEngine } from "../src/engine.js";
import { SESSION_FORMAT, SESSION_VERSION, SessionFormatError } from "../src/session.js";
import type { HistoryEntry, RuleSet, Scope } from "../src/types.js";

const scope: Scope = { enabled: true, include: [{ host: "example.com", enabled: true }], exclude: [{ host: "admin.example.com", enabled: true }] };
const rules: RuleSet = {
  matchReplace: [{ id: "r1", name: "ua", enabled: true, target: "request-header", match: "Chrome", replace: "Corvus", regex: false }],
  block: [{ id: "b1", name: "ads", enabled: true, pattern: "https://*/ads*" }],
  hostOverride: [{ id: "h1", enabled: true, host: "example.com", address: "127.0.0.1" }],
};

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "cap-1",
    profileId: "p1",
    startedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    durationMs: 12,
    host: "example.com",
    path: "/login",
    type: "document",
    inScope: true,
    source: "capture",
    request: { method: "POST", url: "https://example.com/login", headers: [{ name: "content-type", value: "application/x-www-form-urlencoded" }], body: "user=a&pass=b" },
    response: { status: 302, headers: [{ name: "location", value: "/home" }], size: 0 },
    aiHidden: true,
    ...over,
  };
}

function engineWithTraffic(): WebScopeEngine {
  const engine = new WebScopeEngine({ scope, rules, profileId: "p1" });
  engine.history.add(entry());
  engine.history.add(entry({ id: "cap-2", path: "/", type: "xhr", request: { method: "GET", url: "https://example.com/", headers: [] }, aiHidden: undefined }));
  return engine;
}

describe("WebScope sessions", () => {
  it("saves scope, rules and intercept filters, and traffic only when asked", async () => {
    const engine = engineWithTraffic();
    await engine.setInterceptConfig({ enabled: false, interceptRequests: true, interceptResponses: false, match: { host: "example", method: "POST" } });

    const light = engine.exportSession();
    expect(light.format).toBe(SESSION_FORMAT);
    expect(light.version).toBe(SESSION_VERSION);
    expect(light.scope).toEqual(scope);
    expect(light.rules).toEqual(rules);
    expect(light.interceptMatch).toEqual({ host: "example", method: "POST" });
    expect(light.history).toBeUndefined();

    const full = engine.exportSession({ includeHistory: true });
    expect(full.history).toHaveLength(2);
    expect(engine.auditLog().filter((a) => a.action === "session-export")).toHaveLength(2);
  });

  it("opens a session into another engine with the scope disarmed", async () => {
    const saved = JSON.parse(JSON.stringify(engineWithTraffic().exportSession({ includeHistory: true }))) as unknown;
    const target = new WebScopeEngine({ profileId: "p2" });

    const result = await target.importSession(saved);
    expect(result.history).toBe(2);
    expect(target.getScope()).toEqual({ ...scope, enabled: false });
    expect(target.isInScope("https://example.com/")).toBe(false);
    expect(target.getRules().matchReplace[0]).toMatchObject({ name: "ua", target: "request-header", match: "Chrome", replace: "Corvus" });
    expect(target.getRules().block[0]?.pattern).toBe("https://*/ads*");
    expect(target.getRules().hostOverride[0]).toMatchObject({ host: "example.com", address: "127.0.0.1" });
    expect(target.auditLog().some((a) => a.action === "session-import")).toBe(true);

    const rows = target.queryHistory({}, 10);
    expect(rows).toHaveLength(2);
    // Traffic is attributed to this profile, and counted in scope as it would be once armed.
    const login = rows.find((r) => r.path === "/login");
    expect(login?.inScope).toBe(true);
    expect(login?.aiHidden).toBe(true);
    expect(target.getEntry(login!.id)?.profileId).toBe("p2");
    expect(target.getEntry(login!.id)?.request.body).toBe("user=a&pass=b");
  });

  it("keeps the intercept switches and takes the session's filters", async () => {
    const saved = engineWithTraffic().exportSession();
    const target = new WebScopeEngine();
    await target.setInterceptConfig({ enabled: true, interceptRequests: true, interceptResponses: true, match: { path: "/old" } });
    await target.importSession(saved);
    expect(target.getInterceptConfig()).toEqual({ enabled: true, interceptRequests: true, interceptResponses: true });
  });

  it("refuses files that are not WebScope sessions", async () => {
    const engine = new WebScopeEngine();
    await expect(engine.importSession({ log: { entries: [] } })).rejects.toBeInstanceOf(SessionFormatError);
    await expect(engine.importSession(null)).rejects.toBeInstanceOf(SessionFormatError);
    await expect(engine.importSession({ format: SESSION_FORMAT, version: 99, scope, rules })).rejects.toThrow(/version/);
    expect(engine.getScope().include).toHaveLength(0);
  });

  it("drops malformed parts and does not trust the file's own claims", async () => {
    const engine = new WebScopeEngine({ profileId: "p1" });
    const result = await engine.importSession({
      format: SESSION_FORMAT,
      version: SESSION_VERSION,
      scope: { enabled: true, include: [{ host: "example.com", port: 99999, enabled: true }, { host: "" }, "nope"], exclude: null },
      rules: { matchReplace: [{ target: "nowhere", match: "x" }, { target: "response-body", match: "a", replace: 3 }], block: [{ name: "no pattern" }], hostOverride: [{ host: "a.test" }] },
      interceptMatch: { types: ["xhr", "bogus"], method: 7 },
      history: [
        entry({ host: "evil.test", inScope: true, type: "bogus" as never, source: "nope" as never, id: "dup" }),
        { request: { url: "javascript:alert(1)" } },
        { request: { url: "https://other.test/x", method: "get", headers: [{ name: "a" }, { name: "b", value: "c" }] } },
        "junk",
      ],
    });

    expect(engine.getScope()).toEqual({ enabled: false, include: [{ host: "example.com", enabled: true }], exclude: [] });
    expect(engine.getRules().matchReplace).toEqual([{ id: expect.any(String), name: "", enabled: true, target: "response-body", match: "a", replace: "", regex: false }]);
    expect(engine.getRules().block).toEqual([]);
    expect(engine.getRules().hostOverride).toEqual([]);
    expect(engine.getInterceptConfig().match).toEqual({ types: ["xhr"] });

    expect(result.history).toBe(2);
    const rows = engine.queryHistory({}, 10);
    const first = rows.find((r) => r.path === "/login");
    expect(first?.host).toBe("example.com");
    expect(first?.type).toBe("other");
    expect(first?.source).toBe("capture");
    expect(first?.id).not.toBe("dup");
    const other = rows.find((r) => r.host === "other.test");
    expect(other?.inScope).toBe(false);
    expect(other?.method).toBe("GET");
    expect(engine.getEntry(other!.id)?.request.headers).toEqual([{ name: "b", value: "c" }]);
  });
});
