import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpClientInfo } from "@corvus/shared";
import { startMcpServer } from "../src/index.js";
import { bearerMatches, isAllowedHost, isAllowedOrigin, TokenBucket } from "../src/security.js";
import { MockBrowserController } from "../src/testing/index.js";
import { initializeBody, rawRequest, startHarness, TOKEN, uniqueClientName, type Harness } from "./helpers.js";

const auth = { authorization: `Bearer ${TOKEN}` };

describe("security helpers", () => {
  it("compares bearer tokens exactly", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });

  it("accepts only loopback Host values on the bound port", () => {
    expect(isAllowedHost("127.0.0.1:4000", 4000)).toBe(true);
    expect(isAllowedHost("localhost:4000", 4000)).toBe(true);
    expect(isAllowedHost("localhost:4001", 4000)).toBe(false);
    expect(isAllowedHost("evil.example:4000", 4000)).toBe(false);
    expect(isAllowedHost("127.0.0.1.evil.example:4000", 4000)).toBe(false);
    expect(isAllowedHost(undefined, 4000)).toBe(false);
  });

  it("accepts absent or loopback Origin only", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://localhost:6274")).toBe(true);
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false);
  });

  it("relaxes Host/Origin checks on an all-interfaces bind (bearer token is the gate)", () => {
    expect(isAllowedHost("192.168.1.5:4000", 4000, "0.0.0.0")).toBe(true);
    expect(isAllowedHost("corvus.lan:4000", 4000, "0.0.0.0")).toBe(true);
    expect(isAllowedHost("evil.example:4001", 4000, "0.0.0.0")).toBe(false);
    expect(isAllowedHost(undefined, 4000, "0.0.0.0")).toBe(false);
    expect(isAllowedOrigin("https://app.example", "0.0.0.0")).toBe(true);
    expect(isAllowedOrigin("ftp://app.example", "0.0.0.0")).toBe(false);
    expect(isAllowedOrigin(undefined, "0.0.0.0")).toBe(true);
    // A loopback bind stays strict even when asked about a LAN host.
    expect(isAllowedHost("192.168.1.5:4000", 4000, "127.0.0.1")).toBe(false);
  });

  it("token bucket refills over time", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 }, () => now);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(1000);
    now = 1000;
    expect(bucket.take()).toBe(0);
  });
});

describe("startMcpServer options", () => {
  const controller = new MockBrowserController();

  it("refuses to bind to an arbitrary interface", async () => {
    await expect(startMcpServer({ controller, token: TOKEN, host: "1.2.3.4" })).rejects.toThrow(/bind/);
  });

  it("refuses a short token", async () => {
    await expect(startMcpServer({ controller, token: "short" })).rejects.toThrow(/token/);
  });

  it("binds to 127.0.0.1 on a random port", async () => {
    const handle = await startMcpServer({ controller, token: TOKEN });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/mcp`);
    await handle.close();
  });

  it("binds to all interfaces when explicitly opted in", async () => {
    const handle = await startMcpServer({ controller, token: TOKEN, host: "0.0.0.0" });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://0.0.0.0:${handle.port}/mcp`);
    await handle.close();
  });
});

describe("HTTP endpoint", () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it("rejects requests without a token", async () => {
    h = await startHarness();
    const res = await rawRequest(h.handle.port, { body: initializeBody() });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/Bearer/);
  });

  it("rejects a wrong token, also through the SDK client", async () => {
    h = await startHarness();
    const res = await rawRequest(h.handle.port, { headers: { authorization: "Bearer wrong-token-0123456789" }, body: initializeBody() });
    expect(res.status).toBe(401);
    await expect(h.connect({ token: "wrong-token-0123456789" })).rejects.toThrow();
  });

  it("accepts the right token", async () => {
    h = await startHarness();
    const res = await rawRequest(h.handle.port, { headers: auth, body: initializeBody() });
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeTruthy();
  });

  it("blocks foreign Host headers (DNS rebinding)", async () => {
    h = await startHarness();
    const res = await rawRequest(h.handle.port, { headers: { ...auth, host: `evil.example:${h.handle.port}` }, body: initializeBody() });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/Host/);
  });

  it("blocks foreign Origin headers", async () => {
    h = await startHarness();
    const res = await rawRequest(h.handle.port, { headers: { ...auth, origin: "https://evil.example" }, body: initializeBody() });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/Origin/);
    const ok = await rawRequest(h.handle.port, { headers: { ...auth, origin: "http://localhost:6274" }, body: initializeBody() });
    expect(ok.status).toBe(200);
  });

  it("enforces the body size limit", async () => {
    h = await startHarness({ maxBodyBytes: 1024 });
    const res = await rawRequest(h.handle.port, { headers: auth, body: JSON.stringify({ pad: "x".repeat(4096) }) });
    expect(res.status).toBe(413);
  });

  it("rejects malformed JSON, unknown paths, unknown sessions and session-less GET", async () => {
    h = await startHarness();
    expect((await rawRequest(h.handle.port, { headers: auth, body: "{nope" })).status).toBe(400);
    expect((await rawRequest(h.handle.port, { headers: auth, path: "/other", body: initializeBody() })).status).toBe(404);
    expect((await rawRequest(h.handle.port, { headers: { ...auth, "mcp-session-id": "nope" }, body: "{}" })).status).toBe(404);
    expect((await rawRequest(h.handle.port, { headers: auth, method: "GET" })).status).toBe(400);
    expect((await rawRequest(h.handle.port, { headers: auth, method: "PUT", body: "{}" })).status).toBe(405);
  });

  it("requires initialize before anything else", async () => {
    h = await startHarness();
    const res = await rawRequest(h.handle.port, {
      headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });

  it("supports DELETE to end a session", async () => {
    h = await startHarness();
    const init = await rawRequest(h.handle.port, { headers: auth, body: initializeBody() });
    const sessionId = init.headers["mcp-session-id"] as string;
    const del = await rawRequest(h.handle.port, {
      method: "DELETE",
      headers: { ...auth, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
    });
    expect(del.status).toBe(200);
    const after = await rawRequest(h.handle.port, {
      headers: { ...auth, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(after.status).toBe(404);
  });
});

describe("remote (all-interfaces) binding", () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it("still rejects unauthenticated requests", async () => {
    h = await startHarness({ host: "0.0.0.0" });
    const res = await rawRequest(h.handle.port, { body: initializeBody() });
    expect(res.status).toBe(401);
  });

  it("accepts a foreign Host/Origin with a valid token (bearer is the gate)", async () => {
    h = await startHarness({ host: "0.0.0.0" });
    const res = await rawRequest(h.handle.port, {
      headers: { ...auth, host: `corvus.lan:${h.handle.port}`, origin: "https://app.example" },
      body: initializeBody(),
    });
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeTruthy();
  });
});

describe("client approval", () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it("rejects a client the user does not approve", async () => {
    const onClientConnect = vi.fn(async () => false);
    h = await startHarness({ onClientConnect });
    const name = uniqueClientName("rejected");
    await expect(h.connect({ name })).rejects.toThrow();
    expect(onClientConnect).toHaveBeenCalledTimes(1);
    const info = (onClientConnect.mock.calls[0] as unknown as [McpClientInfo])[0];
    expect(info).toMatchObject({ name, version: "1.0.0", remoteAddress: expect.stringContaining("127.0.0.1") });
  });

  it("asks once per client name and remembers approval", async () => {
    const onClientConnect = vi.fn(async () => true);
    h = await startHarness({ onClientConnect });
    const name = uniqueClientName("approved");
    await h.connect({ name });
    await h.connect({ name });
    expect(onClientConnect).toHaveBeenCalledTimes(1);
    await h.connect();
    expect(onClientConnect).toHaveBeenCalledTimes(2);
  });

  it("treats a throwing approval callback as rejection", async () => {
    h = await startHarness({ onClientConnect: async () => Promise.reject(new Error("dialog crashed")) });
    await expect(h.connect()).rejects.toThrow();
  });
});

describe("idle sessions", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("closes sessions idle for longer than sessionIdleMs, freeing their slot", async () => {
    harness = await startHarness({ sessionIdleMs: 50, maxSessions: 1 });
    const { port } = harness.handle;
    const first = await rawRequest(port, { headers: auth, body: initializeBody() });
    expect(first.status).toBe(200);
    const firstId = first.headers["mcp-session-id"] as string;
    expect(firstId).toBeTruthy();

    const blocked = await rawRequest(port, { headers: auth, body: initializeBody() });
    expect(blocked.status).toBe(503);

    await new Promise((r) => setTimeout(r, 200));
    const second = await rawRequest(port, { headers: auth, body: initializeBody() });
    expect(second.status).toBe(200);

    const stale = await rawRequest(port, {
      headers: { ...auth, "mcp-session-id": firstId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(stale.status).toBe(404);
  });
});
