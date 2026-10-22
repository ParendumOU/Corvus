import { afterEach, describe, expect, it } from "vitest";
import { AI_REDACTED_BODY, WebScopeEngine, type CdpClient } from "@corvus/webscope";
import { call, startHarness, textOf, type Harness } from "./helpers.js";

const SECRET = "kp-secret-Password-9";

/** An engine that captured a login POST the browser marked as carrying a filled secret. */
async function engineWithLogin(): Promise<{ engine: WebScopeEngine; id: string }> {
  const engine = new WebScopeEngine({ scope: { enabled: true, include: [{ host: "login.example", enabled: true }], exclude: [] } });
  const listeners: Array<(m: string, p: Record<string, unknown>) => void> = [];
  const client: CdpClient = {
    send: async (method) => (method === "Network.getResponseBody" ? { body: "Welcome" } : {}),
    onEvent(l) {
      listeners.push(l);
      return () => undefined;
    },
  };
  engine.captureFrom(client, { sensitive: (r) => (r.body ?? "").includes(SECRET) || r.url.includes(SECRET) });
  const emit = (m: string, p: Record<string, unknown>): void => listeners.forEach((l) => l(m, p));
  emit("Network.requestWillBeSent", {
    requestId: "1",
    type: "Document",
    request: { url: `https://login.example/session?p=${SECRET}`, method: "POST", headers: {}, postData: `user=alice&password=${SECRET}` },
  });
  emit("Network.responseReceived", { requestId: "1", type: "Document", response: { status: 200, headers: {}, mimeType: "text/html" } });
  emit("Network.loadingFinished", { requestId: "1", encodedDataLength: 7 });
  await new Promise((r) => setTimeout(r, 10));
  return { engine, id: engine.queryHistory()[0]!.id };
}

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

describe("webscope MCP tools hide credential traffic from AI", () => {
  it("history, search, detail, findings and sitemap never return the filled secret", async () => {
    const { engine, id } = await engineWithLogin();
    expect(engine.getEntry(id)?.request.body).toContain(SECRET);
    harness = await startHarness({ accessLevel: "full", rateLimit: false, webscope: () => engine });
    const client = await harness.connect();

    const history = textOf(await call(client, "webscope_history", {}));
    expect(history).toContain('"aiHidden":true');
    expect(history).not.toContain(SECRET);
    expect(textOf(await call(client, "webscope_history", { search: SECRET }))).toContain("[]");

    const detail = textOf(await call(client, "webscope_request_detail", { id }));
    expect(detail).toContain(AI_REDACTED_BODY);
    expect(detail).not.toContain(SECRET);

    for (const tool of ["webscope_findings", "webscope_sitemap", "webscope_intercept_queue"]) {
      expect(textOf(await call(client, tool, {}))).not.toContain(SECRET);
    }
  });
});
