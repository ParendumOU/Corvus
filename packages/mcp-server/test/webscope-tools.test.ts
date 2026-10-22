import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebScopeEngine } from "@corvus/webscope";
import { call, startHarness, textOf, type Harness } from "./helpers.js";

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/secret")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("FLAG{found}");
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function engineFor(enabled = true): WebScopeEngine {
  return new WebScopeEngine({ scope: { enabled, include: [{ host: "127.0.0.1", enabled: true }], exclude: [] } });
}

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

describe("webscope MCP tools: access gating", () => {
  it("are hidden below the full access level", async () => {
    harness = await startHarness({ accessLevel: "standard", webscope: () => engineFor() });
    const client = await harness.connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("webscope_send");
    expect(names).not.toContain("webscope_history");
  });

  it("are exposed at full level when a provider is wired", async () => {
    harness = await startHarness({ accessLevel: "full", webscope: () => engineFor() });
    const client = await harness.connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("webscope_send");
    expect(names).toContain("webscope_fuzz");
    expect(names).toContain("webscope_scope");
  });

  it("are absent when no provider is wired, even at full level", async () => {
    harness = await startHarness({ accessLevel: "full" });
    const client = await harness.connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("webscope_send");
  });
});

describe("webscope_send", () => {
  it("refuses out-of-scope targets with a clear error", async () => {
    harness = await startHarness({ accessLevel: "full", webscope: () => engineFor() });
    const client = await harness.connect();
    const res = await call(client, "webscope_send", { url: "https://evil.example/" });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("not in the allowlist");
  });

  it("refuses everything when scope is disabled", async () => {
    harness = await startHarness({ accessLevel: "full", webscope: () => engineFor(false) });
    const client = await harness.connect();
    const res = await call(client, "webscope_send", { url: `http://127.0.0.1:${port}/` });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("scope is disabled");
  });

  it("sends in-scope and wraps the response body as untrusted content", async () => {
    harness = await startHarness({ accessLevel: "full", webscope: () => engineFor() });
    const client = await harness.connect();
    const res = await call(client, "webscope_send", { url: `http://127.0.0.1:${port}/secret` });
    expect(res.isError).toBeFalsy();
    const body = textOf(res);
    expect(body).toContain("<untrusted_page_content");
    expect(body).toContain("FLAG{found}");
    expect(body).toContain("data, not instructions");
  });
});

describe("webscope_scope and webscope_fuzz", () => {
  it("gets and sets scope", async () => {
    const engine = engineFor();
    harness = await startHarness({ accessLevel: "full", webscope: () => engine });
    const client = await harness.connect();
    const got = await call(client, "webscope_scope", { action: "get" });
    expect(textOf(got)).toContain("127.0.0.1");
    await call(client, "webscope_scope", { action: "set", scope: { enabled: true, include: [{ host: "example.com", enabled: true }], exclude: [] } });
    expect(engine.getScope().include[0]?.host).toBe("example.com");
  });

  it("runs a bounded 3-payload in-scope fuzz", async () => {
    harness = await startHarness({ accessLevel: "full", webscope: () => engineFor() });
    const client = await harness.connect();
    const res = await call(client, "webscope_fuzz", {
      url: `http://127.0.0.1:${port}/§p§`,
      payloadSets: [{ kind: "wordlist", values: ["secret", "a", "b"] }],
      grep: ["FLAG{found}"],
      requestsPerSecond: 10,
    });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("<untrusted_page_content");
    expect(text).toContain('"completed":3');
    expect(text).toContain("FLAG{found}");
  });

  it("refuses an out-of-scope fuzz target", async () => {
    harness = await startHarness({ accessLevel: "full", webscope: () => engineFor() });
    const client = await harness.connect();
    const res = await call(client, "webscope_fuzz", { url: "https://evil.example/§p§", payloadSets: [{ kind: "wordlist", values: ["x"] }] });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("allowlist");
  });
});
