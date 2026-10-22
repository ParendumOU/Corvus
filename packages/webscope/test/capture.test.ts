import { describe, expect, it } from "vitest";
import { CaptureEngine } from "../src/capture.js";
import { HistoryBuffer } from "../src/history.js";
import type { CdpClient, Scope } from "../src/types.js";

class FakeCdp implements CdpClient {
  private listeners: Array<(m: string, p: Record<string, unknown>) => void> = [];
  bodies: Record<string, { body: string; base64Encoded?: boolean }> = {};
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === "Network.getResponseBody") return Promise.resolve(this.bodies[String(params?.requestId)] ?? {});
    return Promise.resolve({});
  }
  onEvent(l: (m: string, p: Record<string, unknown>) => void): () => void {
    this.listeners.push(l);
    return () => {};
  }
  emit(method: string, params: Record<string, unknown>): void {
    for (const l of this.listeners) l(method, params);
  }
}

const scope: Scope = { enabled: true, include: [{ host: "example.com", enabled: true }], exclude: [] };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("CaptureEngine", () => {
  it("parses a full request/response exchange into a history entry", async () => {
    const history = new HistoryBuffer();
    const cdp = new FakeCdp();
    cdp.bodies["1"] = { body: "<html>hi</html>" };
    const engine = new CaptureEngine({ client: cdp, profileId: "p1", history, scope: () => scope });
    await engine.start();

    cdp.emit("Network.requestWillBeSent", {
      requestId: "1",
      type: "Document",
      request: { url: "https://example.com/page", method: "GET", headers: { "User-Agent": "x" } },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "1",
      type: "Document",
      response: { status: 200, statusText: "OK", headers: { "content-type": "text/html" }, mimeType: "text/html" },
    });
    cdp.emit("Network.loadingFinished", { requestId: "1", encodedDataLength: 15 });
    await flush();

    const [entry] = history.all();
    expect(entry?.host).toBe("example.com");
    expect(entry?.path).toBe("/page");
    expect(entry?.type).toBe("document");
    expect(entry?.inScope).toBe(true);
    expect(entry?.response?.status).toBe(200);
    expect(entry?.response?.body).toBe("<html>hi</html>");
  });

  it("marks out-of-scope requests and records failures", async () => {
    const history = new HistoryBuffer();
    const cdp = new FakeCdp();
    const engine = new CaptureEngine({ client: cdp, profileId: "p1", history, scope: () => scope });
    await engine.start();

    cdp.emit("Network.requestWillBeSent", { requestId: "2", type: "XHR", request: { url: "https://other.com/x", method: "GET", headers: {} } });
    cdp.emit("Network.loadingFailed", { requestId: "2", errorText: "net::ERR_FAILED" });
    await flush();

    const [entry] = history.all();
    expect(entry?.inScope).toBe(false);
    expect(entry?.error).toBe("net::ERR_FAILED");
  });

  it("truncates bodies above the cap but keeps the real size", async () => {
    const history = new HistoryBuffer();
    const cdp = new FakeCdp();
    cdp.bodies["3"] = { body: "0123456789" };
    const engine = new CaptureEngine({ client: cdp, profileId: "p1", history, scope: () => scope, maxBodyBytes: 4 });
    await engine.start();
    cdp.emit("Network.requestWillBeSent", { requestId: "3", type: "Fetch", request: { url: "https://example.com/d", method: "GET", headers: {} } });
    cdp.emit("Network.responseReceived", { requestId: "3", type: "Fetch", response: { status: 200, headers: {} } });
    cdp.emit("Network.loadingFinished", { requestId: "3", encodedDataLength: 10 });
    await flush();
    const [entry] = history.all();
    expect(entry?.response?.body).toBe("0123");
    expect(entry?.response?.size).toBe(10);
  });
});
