import { describe, expect, it, vi } from "vitest";
import { ScopeError, WebScopeEngine } from "../src/engine.js";
import type { OutboundRequest, Scope, SendResult } from "../src/index.js";

const scope: Scope = { enabled: true, include: [{ host: "example.com", enabled: true }], exclude: [] };

function okSend(body = "hello"): typeof import("../src/http-client.js").sendRequest {
  return vi.fn(async () => ({ response: { status: 200, headers: [{ name: "content-type", value: "text/plain" }], body, size: body.length, mimeType: "text/plain" }, durationMs: 5 }) satisfies SendResult);
}

describe("WebScopeEngine scope enforcement", () => {
  it("refuses a repeater send to an out-of-scope host", async () => {
    const engine = new WebScopeEngine({ scope, send: okSend() });
    await expect(engine.repeaterSend({ method: "GET", url: "https://evil.com/", headers: [] })).rejects.toBeInstanceOf(ScopeError);
  });

  it("refuses when scope is disabled", async () => {
    const engine = new WebScopeEngine({ scope: { ...scope, enabled: false }, send: okSend() });
    await expect(engine.repeaterSend({ method: "GET", url: "https://example.com/", headers: [] })).rejects.toBeInstanceOf(ScopeError);
  });

  it("sends in-scope and records a repeater history entry + audit", async () => {
    const engine = new WebScopeEngine({ scope, send: okSend() });
    const entry = await engine.repeaterSend({ method: "GET", url: "https://example.com/x", headers: [] });
    expect(entry.source).toBe("repeater");
    expect(entry.response?.status).toBe(200);
    expect(engine.queryHistory({ source: "repeater" })).toHaveLength(1);
    expect(engine.auditLog().some((a) => a.action === "repeater-send")).toBe(true);
  });
});

describe("cookie reuse", () => {
  it("attaches profile cookies only for in-scope hosts", async () => {
    const send = okSend();
    const cookieProvider = vi.fn(async () => "sid=abc");
    const engine = new WebScopeEngine({ scope, send, cookieProvider });
    await engine.repeaterSend({ method: "GET", url: "https://example.com/x", headers: [], useProfileCookies: true });
    expect(cookieProvider).toHaveBeenCalledWith("https://example.com/x");
    expect((send as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1]).toMatchObject({ cookieHeader: "sid=abc" });
  });
});

describe("match/replace through the engine", () => {
  it("applies block rules before sending", async () => {
    const send = okSend();
    const engine = new WebScopeEngine({ scope, send });
    engine.setRules({ matchReplace: [], block: [{ id: "1", name: "stop", enabled: true, pattern: "https://example.com/*" }], hostOverride: [] });
    await expect(engine.repeaterSend({ method: "GET", url: "https://example.com/x", headers: [] })).rejects.toThrow(/blocked/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("fuzz + compare", () => {
  it("runs an in-scope fuzz and compares two responses", async () => {
    const send = vi.fn(async (req: OutboundRequest) => ({
      response: { status: req.url.endsWith("2") ? 404 : 200, headers: [], body: req.url, size: req.url.length },
      durationMs: 1,
    }));
    const engine = new WebScopeEngine({ scope, send });
    const { rows, summary } = await engine.fuzz({
      template: { method: "GET", url: "https://example.com/u/§id§", headers: [] },
      attack: "sniper",
      payloadSets: [{ kind: "numbers", from: 1, to: 3 }],
      concurrency: 2,
      requestsPerSecond: 1000,
    });
    expect(summary.total).toBe(3);
    expect(rows).toHaveLength(3);
    expect(engine.auditLog().some((a) => a.action === "fuzz-finish")).toBe(true);

    const a = await engine.repeaterSend({ method: "GET", url: "https://example.com/a", headers: [] });
    const b = await engine.repeaterSend({ method: "GET", url: "https://example.com/b", headers: [] });
    const diff = engine.compare(a.id, b.id);
    expect(diff.a.status).toBe(200);
    expect(diff.b.status).toBe(200);
  });
});
