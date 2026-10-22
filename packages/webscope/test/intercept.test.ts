import { describe, expect, it } from "vitest";
import { InterceptEngine } from "../src/intercept.js";
import { emptyRuleSet, scopeEntry } from "../src/index.js";
import type { CdpClient, InterceptConfig, RuleSet, Scope } from "../src/types.js";

/** A fake CDP client that records sent commands and lets tests push Fetch.requestPaused events. */
function fakeClient() {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  let listener: ((method: string, params: Record<string, unknown>) => void) | null = null;
  const client: CdpClient = {
    async send(method, params = {}) {
      sent.push({ method, params });
      return {};
    },
    onEvent(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  return {
    client,
    sent,
    pauseRequest(requestId: string, url: string, method = "GET", resourceType = "Document") {
      listener?.("Fetch.requestPaused", { requestId, request: { url, method, headers: {} }, resourceType });
    },
    pauseResponse(requestId: string, url: string, status = 200) {
      listener?.("Fetch.requestPaused", { requestId, request: { url, method: "GET", headers: {} }, responseStatusCode: status, responseHeaders: {} });
    },
  };
}

const scope = (): Scope => ({ enabled: true, include: [scopeEntry("example.com")], exclude: [] });
const cfg = (over: Partial<InterceptConfig> = {}): InterceptConfig => ({ enabled: true, interceptRequests: true, interceptResponses: false, ...over });

describe("InterceptEngine", () => {
  it("holds an in-scope request and forwards it with edits", async () => {
    const f = fakeClient();
    const eng = new InterceptEngine({ client: f.client, scope, config: () => cfg() });
    await eng.sync();
    f.pauseRequest("r1", "https://example.com/login");
    await Promise.resolve();
    expect(eng.queue()).toHaveLength(1);
    expect(f.sent.some((c) => c.method === "Fetch.continueRequest")).toBe(false); // held, not forwarded

    const id = eng.queue()[0]!.id;
    await eng.forward(id, { headers: [{ name: "X-Test", value: "1" }], body: "a=b" });
    expect(eng.queue()).toHaveLength(0);
    const cont = f.sent.find((c) => c.method === "Fetch.continueRequest");
    expect(cont?.params.requestId).toBe("r1");
    expect(cont?.params.postData).toBe(Buffer.from("a=b").toString("base64"));
    expect(cont?.params.headers).toEqual([{ name: "X-Test", value: "1" }]);
  });

  it("forwards out-of-scope requests immediately without holding", async () => {
    const f = fakeClient();
    const eng = new InterceptEngine({ client: f.client, scope, config: () => cfg() });
    await eng.sync();
    f.pauseRequest("r2", "https://other.com/");
    await Promise.resolve();
    expect(eng.queue()).toHaveLength(0);
    expect(f.sent.some((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "r2")).toBe(true);
  });

  it("drops a held request as a failed request", async () => {
    const f = fakeClient();
    const eng = new InterceptEngine({ client: f.client, scope, config: () => cfg() });
    await eng.sync();
    f.pauseRequest("r3", "https://example.com/pay");
    await Promise.resolve();
    await eng.drop(eng.queue()[0]!.id);
    const fail = f.sent.find((c) => c.method === "Fetch.failRequest");
    expect(fail?.params).toMatchObject({ requestId: "r3", errorReason: "Aborted" });
  });

  it("holds and fulfills an edited response when response interception is on", async () => {
    const f = fakeClient();
    const eng = new InterceptEngine({ client: f.client, scope, config: () => cfg({ interceptResponses: true }) });
    await eng.sync();
    expect(f.sent.find((c) => c.method === "Fetch.enable")?.params.patterns).toHaveLength(2);
    f.pauseResponse("r4", "https://example.com/api", 200);
    await Promise.resolve();
    const item = eng.queue()[0]!;
    expect(item.phase).toBe("response");
    await eng.forward(item.id, { status: 403, body: "denied" });
    const fulfill = f.sent.find((c) => c.method === "Fetch.fulfillRequest");
    expect(fulfill?.params.responseCode).toBe(403);
    expect(fulfill?.params.body).toBe(Buffer.from("denied").toString("base64"));
  });

  it("continues responses without holding when response interception is off", async () => {
    const f = fakeClient();
    const eng = new InterceptEngine({ client: f.client, scope, config: () => cfg({ interceptResponses: false }) });
    await eng.sync();
    f.pauseResponse("r5", "https://example.com/x");
    await Promise.resolve();
    expect(eng.queue()).toHaveLength(0);
    expect(f.sent.some((c) => c.method === "Fetch.continueResponse" && c.params.requestId === "r5")).toBe(true);
  });

  it("applies match filters: only matching exchanges are held", async () => {
    const f = fakeClient();
    const eng = new InterceptEngine({ client: f.client, scope, config: () => cfg({ match: { method: "POST", path: "/login" } }) });
    await eng.sync();
    f.pauseRequest("a", "https://example.com/login", "GET"); // wrong method
    f.pauseRequest("b", "https://example.com/other", "POST"); // wrong path
    f.pauseRequest("c", "https://example.com/login", "POST"); // match
    await Promise.resolve();
    expect(eng.queue().map((q) => q.request.method + " " + q.path)).toEqual(["POST /login"]);
  });

  it("auto-forwards a held request after the timeout (no deadlock)", async () => {
    const f = fakeClient();
    const eng = new InterceptEngine({ client: f.client, scope, config: () => cfg(), timeoutMs: 5 });
    await eng.sync();
    f.pauseRequest("t1", "https://example.com/slow");
    await Promise.resolve();
    expect(eng.queue()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(eng.queue()).toHaveLength(0);
    expect(f.sent.some((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "t1")).toBe(true);
  });

  it("blocks a held request matching a block rule", async () => {
    const f = fakeClient();
    const rules: RuleSet = { ...emptyRuleSet(), block: [{ id: "x", name: "ads", pattern: "*/ads/*", enabled: true }] };
    const eng = new InterceptEngine({ client: f.client, scope, config: () => cfg(), rules: () => rules });
    await eng.sync();
    f.pauseRequest("bk", "https://example.com/ads/banner");
    await Promise.resolve();
    expect(eng.queue()).toHaveLength(0);
    expect(f.sent.some((c) => c.method === "Fetch.failRequest" && c.params.errorReason === "BlockedByClient")).toBe(true);
  });
});
