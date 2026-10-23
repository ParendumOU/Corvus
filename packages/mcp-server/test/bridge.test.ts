import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { startStdioBridge, type StdioBridge } from "../src/index.js";
import { startHarness, TOKEN, type Harness } from "./helpers.js";

function lineReader(stream: PassThrough) {
  let buffer = "";
  const queue: unknown[] = [];
  const waiters: Array<(v: unknown) => void> = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i)) as unknown;
      buffer = buffer.slice(i + 1);
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    }
  });
  return () => new Promise<unknown>((resolve) => (queue.length ? resolve(queue.shift()) : waiters.push(resolve)));
}

describe("stdio bridge", () => {
  let h: Harness | undefined;
  let bridge: StdioBridge | undefined;
  afterEach(async () => {
    await bridge?.close();
    await h?.close();
  });

  it("refuses non-loopback URLs", async () => {
    await expect(startStdioBridge({ url: "http://example.com/mcp", token: TOKEN })).rejects.toThrow(/loopback/);
  });

  it("proxies stdio JSON-RPC to the HTTP server", async () => {
    h = await startHarness();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const next = lineReader(stdout);
    bridge = await startStdioBridge({ url: h.handle.url, token: TOKEN, stdin, stdout, log: () => {} });

    const send = (m: unknown) => stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } },
    });
    expect(await next()).toMatchObject({ id: 1, result: { serverInfo: { name: "corvus" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tabs_list", arguments: {} } });
    const res = (await next()) as { id: number; result: { content: Array<{ text: string }> } };
    expect(res.id).toBe(2);
    expect(res.result.content[0]?.text).toContain("https://example.com/");
  });

  it("keeps pipelined messages behind initialize", async () => {
    h = await startHarness();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const next = lineReader(stdout);
    bridge = await startStdioBridge({ url: h.handle.url, token: TOKEN, stdin, stdout, log: () => {} });
    stdin.write(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-pipelined", version: "1" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]
        .map((m) => `${JSON.stringify(m)}\n`)
        .join(""),
    );
    expect(await next()).toMatchObject({ id: 1, result: { serverInfo: { name: "corvus" } } });
    const list = (await next()) as { id: number; result: { tools: unknown[] } };
    expect(list.id).toBe(2);
    expect(list.result.tools.length).toBeGreaterThan(10);
  });

  it("answers requests with an error when the token is wrong", async () => {
    h = await startHarness();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const next = lineReader(stdout);
    bridge = await startStdioBridge({ url: h.handle.url, token: "wrong-token-0123456789", stdin, stdout, log: () => {} });
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-bad", version: "1" } },
      })}\n`,
    );
    expect(await next()).toMatchObject({ id: 7, error: { code: -32000 } });
  });

  describe("when Corvus goes away", () => {
    const init = (name: string) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } },
    });
    const tabsList = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tabs_list", arguments: {} } };

    async function connected(name: string, reconnect?: () => Promise<{ url: string; token: string }>) {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const next = lineReader(stdout);
      bridge = await startStdioBridge({ url: h!.handle.url, token: TOKEN, stdin, stdout, log: () => {}, reconnect });
      const send = (m: unknown) => stdin.write(`${JSON.stringify(m)}\n`);
      send(init(name));
      expect(await next()).toMatchObject({ id: 1, result: { serverInfo: { name: "corvus" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return { send, next };
    }

    it("finds the restarted browser and replays the handshake", async () => {
      h = await startHarness();
      const { send, next } = await connected("stdio-restart", async () => ({ url: h!.handle.url, token: TOKEN }));
      await h.close();
      h = await startHarness();
      send(tabsList);
      expect(await next()).toMatchObject({ method: "notifications/tools/list_changed" });
      const res = (await next()) as { id: number; result: { content: Array<{ text: string }> } };
      expect(res.id).toBe(2);
      expect(res.result.content[0]?.text).toContain("https://example.com/");
    });

    it("opens a new session when Corvus forgot this one", async () => {
      h = await startHarness();
      let reconnects = 0;
      const { send, next } = await connected("stdio-forgotten", async () => {
        reconnects += 1;
        return { url: h!.handle.url, token: TOKEN };
      });
      h.handle.revokeClient?.("stdio-forgotten");
      send(tabsList);
      expect(await next()).toMatchObject({ method: "notifications/tools/list_changed" });
      expect(await next()).toMatchObject({ id: 2, result: { content: [{ type: "text" }] } });
      expect(reconnects).toBe(1);
    });

    it("reports the browser unreachable when it cannot reconnect", async () => {
      h = await startHarness();
      const { send, next } = await connected("stdio-gone");
      await h.close();
      h = undefined;
      send(tabsList);
      expect(await next()).toMatchObject({ id: 2, error: { code: -32000, message: expect.stringContaining("unreachable") } });
    });
  });
});
