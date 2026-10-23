import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { TabLogs, type TabLogGuard } from "../src/main/tab-logs";

class FakeDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params: unknown }> = [];
  isAttached(): boolean {
    return this.attached;
  }
  attach(): void {
    if (this.attached) throw new Error("Debugger is already attached to the target");
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
    this.emit("detach", {}, "target closed");
  }
  async sendCommand(method: string, params: unknown): Promise<unknown> {
    this.commands.push({ method, params });
    return {};
  }
  event(method: string, params: Record<string, unknown>): void {
    this.emit("message", {}, method, params);
  }
}

class FakeWebContents extends EventEmitter {
  url = "https://shop.example/";
  readonly debugger = new FakeDebugger();
  isDestroyed(): boolean {
    return false;
  }
  getURL(): string {
    return this.url;
  }
  log(level: string, message: string, sourceId = "", lineNumber = 0): void {
    this.emit("console-message", { level, message, sourceId, lineNumber });
  }
}

const OPEN_GUARD: TabLogGuard = { sensitiveRequest: () => false, sensitiveText: () => false };

function setup(guard: TabLogGuard = OPEN_GUARD): { logs: TabLogs; fake: FakeWebContents; wc: WebContents } {
  const fake = new FakeWebContents();
  const logs = new TabLogs(guard);
  const wc = fake as unknown as WebContents;
  logs.watch(wc);
  return { logs, fake, wc };
}

function request(fake: FakeWebContents, id: string, url: string, extra: Record<string, unknown> = {}): void {
  fake.debugger.event("Network.requestWillBeSent", {
    requestId: id,
    request: { url, method: "GET", headers: {} },
    documentURL: fake.url,
    type: "Fetch",
    timestamp: 100,
    wallTime: 1_700_000_000,
    ...extra,
  });
}

describe("TabLogs", () => {
  it("records nothing for a tab no agent touched", () => {
    const logs = new TabLogs(OPEN_GUARD);
    const fake = new FakeWebContents();
    fake.log("error", "boom");
    expect(logs.consoleMessages(fake as unknown as WebContents)).toEqual([]);
    expect(fake.debugger.attached).toBe(false);
  });

  it("attaches the debugger once and enables Network without body buffering", () => {
    const { logs, fake, wc } = setup();
    logs.watch(wc);
    expect(fake.debugger.attached).toBe(true);
    expect(fake.debugger.commands).toEqual([{ method: "Network.enable", params: { maxResourceBufferSize: 0, maxTotalBufferSize: 0 } }]);
  });

  it("shares a debugger WebScope already attached, and resumes after it detaches", () => {
    const fake = new FakeWebContents();
    fake.debugger.attached = true;
    const logs = new TabLogs(OPEN_GUARD);
    const wc = fake as unknown as WebContents;
    logs.watch(wc);
    expect(fake.debugger.commands.map((c) => c.method)).toEqual(["Network.enable"]);
    fake.debugger.detach();
    logs.watch(wc);
    expect(fake.debugger.attached).toBe(true);
    expect(fake.debugger.commands.map((c) => c.method)).toEqual(["Network.enable", "Network.enable"]);
  });

  it("filters console messages by minimum level, limits and clears", () => {
    const { logs, fake, wc } = setup();
    fake.log("debug", "d");
    fake.log("info", "loaded");
    fake.log("warning", "slow");
    fake.log("error", "Uncaught TypeError: x is undefined", "https://shop.example/app.js", 10);
    expect(logs.consoleMessages(wc, { level: "warning" }).map((m) => m.text)).toEqual(["slow", "Uncaught TypeError: x is undefined"]);
    expect(logs.consoleMessages(wc, { limit: 1 })[0]).toMatchObject({ level: "error", source: "https://shop.example/app.js:10" });
    logs.consoleMessages(wc, { clear: true });
    expect(logs.consoleMessages(wc)).toEqual([]);
  });

  it("skips console messages from pages agents may not read", () => {
    const { logs, fake, wc } = setup();
    fake.url = "corvus://settings/";
    fake.log("error", "internal");
    expect(logs.consoleMessages(wc)).toEqual([]);
  });

  it("tracks a request through response, finish, failure and redirects", () => {
    const { logs, fake, wc } = setup();
    request(fake, "1", "https://shop.example/api/cart");
    expect(logs.networkRequests(wc)[0]).toMatchObject({ method: "GET", url: "https://shop.example/api/cart", type: "fetch", at: 1_700_000_000_000 });
    expect(logs.networkRequests(wc)[0]?.status).toBeUndefined();
    fake.debugger.event("Network.responseReceived", { requestId: "1", type: "XHR", response: { status: 200, mimeType: "application/json" } });
    fake.debugger.event("Network.loadingFinished", { requestId: "1", timestamp: 100.25, encodedDataLength: 2048 });

    request(fake, "2", "https://shop.example/api/pay");
    fake.debugger.event("Network.loadingFailed", { requestId: "2", timestamp: 100.5, errorText: "net::ERR_CONNECTION_RESET" });

    request(fake, "3", "http://shop.example/old");
    request(fake, "3", "https://shop.example/new", { timestamp: 100.1, redirectResponse: { status: 301 } });
    fake.debugger.event("Network.responseReceived", { requestId: "3", response: { status: 200 } });

    const rows = logs.networkRequests(wc);
    expect(rows[0]).toMatchObject({ status: 200, type: "xhr", mimeType: "application/json", bytes: 2048, durationMs: 250 });
    expect(rows[1]).toMatchObject({ failed: "net::ERR_CONNECTION_RESET", durationMs: 500 });
    expect(rows[2]).toMatchObject({ url: "http://shop.example/old", status: 301, durationMs: 100 });
    expect(rows[3]).toMatchObject({ url: "https://shop.example/new", status: 200 });
    expect(logs.networkRequests(wc, { failedOnly: true }).map((r) => r.url)).toEqual(["https://shop.example/api/pay"]);
    expect(logs.networkRequests(wc, { filter: "/api/" })).toHaveLength(2);
    expect(logs.networkRequests(wc, { limit: 1 })[0]?.url).toBe("https://shop.example/new");
  });

  it("reports blocked and canceled requests", () => {
    const { logs, fake, wc } = setup();
    request(fake, "1", "https://ads.example/x.js");
    fake.debugger.event("Network.loadingFailed", { requestId: "1", timestamp: 101, errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "inspector" });
    request(fake, "2", "https://shop.example/poll");
    fake.debugger.event("Network.loadingFailed", { requestId: "2", timestamp: 101, errorText: "net::ERR_ABORTED", canceled: true });
    expect(logs.networkRequests(wc).map((r) => r.failed)).toEqual(["blocked:inspector", "canceled"]);
  });

  it("returns copies, so later events do not change rows already handed out", () => {
    const { logs, fake, wc } = setup();
    request(fake, "1", "https://shop.example/a");
    const [row] = logs.networkRequests(wc);
    fake.debugger.event("Network.responseReceived", { requestId: "1", response: { status: 404 } });
    expect(row?.status).toBeUndefined();
    expect(logs.networkRequests(wc)[0]?.status).toBe(404);
  });

  it("skips requests made by pages agents may not read", () => {
    const { logs, fake, wc } = setup();
    request(fake, "1", "corvus://settings/app.js", { documentURL: "corvus://settings/" });
    expect(logs.networkRequests(wc)).toEqual([]);
  });

  it("hides what a request carried when it was sent with or right after a filled secret", () => {
    const guard: TabLogGuard = {
      sensitiveRequest: (_wc, r) => r.url.includes("s3cret") || r.body === "pass=s3cret",
      sensitiveText: (text) => text.includes("s3cret"),
    };
    const { logs, fake, wc } = setup(guard);
    request(fake, "1", "https://shop.example/login?user=a&pass=s3cret");
    request(fake, "2", "https://shop.example/reset/s3cret");
    fake.debugger.event("Network.requestWillBeSent", {
      requestId: "3",
      request: { url: "https://shop.example/session", method: "POST", headers: {}, postData: "pass=s3cret" },
      documentURL: fake.url,
      timestamp: 100,
    });
    fake.log("info", "password is s3cret");
    expect(logs.networkRequests(wc).map((r) => r.url)).toEqual([
      "https://shop.example/login?[hidden]",
      "https://shop.example/[hidden]",
      "https://shop.example/session",
    ]);
    expect(logs.consoleMessages(wc)[0]?.text).toBe("[hidden: contains a value Corvus filled]");
  });

  it("keeps the newest entries when the buffers fill up", () => {
    const { logs, fake, wc } = setup();
    for (let i = 0; i < 520; i++) request(fake, String(i), `https://shop.example/${i}`);
    for (let i = 0; i < 310; i++) fake.log("info", `m${i}`);
    const rows = logs.networkRequests(wc, { limit: 1000 });
    expect(rows).toHaveLength(500);
    expect(rows[0]?.url).toBe("https://shop.example/20");
    expect(logs.consoleMessages(wc, { limit: 1000 })).toHaveLength(300);
  });
});
