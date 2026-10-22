import { describe, expect, it } from "vitest";
import { AI_REDACTED_BODY, AI_REDACTED_VALUE, entryForAi, interceptItemForAi, redactUrlForAi } from "../src/ai-redact.js";
import { CaptureEngine } from "../src/capture.js";
import { WebScopeEngine } from "../src/engine.js";
import { HistoryBuffer } from "../src/history.js";
import type { CapturedRequest, CdpClient, HistoryEntry, InterceptItem, Scope } from "../src/types.js";

const SECRET = "hunter2-correct-horse";
const scope: Scope = { enabled: true, include: [{ host: "login.example", enabled: true }], exclude: [] };
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A CDP client fake that lets tests push Network and Fetch events. */
function fakeCdp() {
  const listeners: Array<(m: string, p: Record<string, unknown>) => void> = [];
  const client: CdpClient = {
    send: async (method) => (method === "Network.getResponseBody" ? { body: "<html>Welcome</html>" } : {}),
    onEvent(l) {
      listeners.push(l);
      return () => undefined;
    },
  };
  const emit = (m: string, p: Record<string, unknown>): void => listeners.forEach((l) => l(m, p));
  /** A form POST to /session followed by its response. */
  const login = async (id: string, body: string, url = "https://login.example/session?next=%2Fhome"): Promise<void> => {
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (body.includes(SECRET)) headers.Referer = `https://login.example/form?u=alice&p=${SECRET}`;
    emit("Network.requestWillBeSent", {
      requestId: id,
      type: "Document",
      request: { url, method: "POST", headers, postData: body },
    });
    emit("Network.responseReceived", { requestId: id, type: "Document", response: { status: 200, headers: { "content-type": "text/html" }, mimeType: "text/html" } });
    emit("Network.loadingFinished", { requestId: id, encodedDataLength: 20 });
    await flush();
  };
  return { client, emit, login };
}

const carriesSecret = (r: CapturedRequest): boolean => `${r.url}\n${r.body ?? ""}`.includes(SECRET);

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "e1",
    profileId: "p",
    startedAt: 1,
    host: "login.example",
    path: "/session?u=alice&p=secret",
    type: "document",
    inScope: true,
    source: "capture",
    request: { method: "POST", url: "https://login.example/session?u=alice&p=secret#top", headers: [{ name: "Referer", value: "https://login.example/?p=secret" }], body: "user=alice&pass=secret" },
    response: { status: 200, headers: [], body: "ok" },
    ...over,
  };
}

describe("redactUrlForAi", () => {
  it("keeps parameter names and replaces every value", () => {
    expect(redactUrlForAi("https://a.test/x?u=alice&p=secret#frag")).toBe(`https://a.test/x?u=${AI_REDACTED_VALUE}&p=${AI_REDACTED_VALUE}#frag`);
    expect(redactUrlForAi("/session?token")).toBe(`/session?token=${AI_REDACTED_VALUE}`);
    expect(redactUrlForAi("https://a.test/plain")).toBe("https://a.test/plain");
  });
});

describe("entryForAi / interceptItemForAi", () => {
  it("returns entries not hidden from AI untouched", () => {
    const e = entry();
    expect(entryForAi(e)).toBe(e);
  });

  it("drops the body and query values of hidden requests, without touching the original", () => {
    const e = entry({ aiHidden: true, request: { ...entry().request, bodyBase64: true } });
    const ai = entryForAi(e);
    expect(ai.request.body).toBe(AI_REDACTED_BODY);
    expect(ai.request.bodyBase64).toBeUndefined();
    expect(JSON.stringify(ai)).not.toContain("secret\"");
    expect(JSON.stringify(ai)).not.toMatch(/=secret|pass=/);
    expect(ai.path).toBe(`/session?u=${AI_REDACTED_VALUE}&p=${AI_REDACTED_VALUE}`);
    expect(ai.request.headers[0]!.value).toBe(`https://login.example/?p=${AI_REDACTED_VALUE}`);
    expect(ai.response?.body).toBe("ok");
    expect(e.request.body).toBe("user=alice&pass=secret");
  });

  it("redacts held intercept items the same way", () => {
    const item: InterceptItem = { id: "i1", phase: "request", host: "login.example", path: "/s", request: entry().request, createdAt: 1, aiHidden: true };
    expect(interceptItemForAi(item).request.body).toBe(AI_REDACTED_BODY);
    expect(interceptItemForAi({ ...item, aiHidden: false }).request.body).toContain("secret");
  });
});

describe("capture marking", () => {
  it("marks requests the sensitivity check flags, and only those", async () => {
    const history = new HistoryBuffer();
    const cdp = fakeCdp();
    const capture = new CaptureEngine({ client: cdp.client, profileId: "p", history, scope: () => scope, sensitive: carriesSecret });
    await capture.start();
    await cdp.login("1", `user=alice&pass=${SECRET}`);
    await cdp.login("2", "q=weather", "https://login.example/search");
    const [a, b] = history.all();
    expect(a?.aiHidden).toBe(true);
    expect(b?.aiHidden).toBeUndefined();
  });

  it("hides from AI when the check itself fails", async () => {
    const history = new HistoryBuffer();
    const cdp = fakeCdp();
    const capture = new CaptureEngine({
      client: cdp.client,
      profileId: "p",
      history,
      scope: () => scope,
      sensitive: () => {
        throw new Error("boom");
      },
    });
    await capture.start();
    await cdp.login("1", "a=b");
    expect(history.all()[0]?.aiHidden).toBe(true);
  });
});

describe("WebScopeEngine AI reads", () => {
  async function engineWithLogin(): Promise<{ engine: WebScopeEngine; id: string }> {
    const engine = new WebScopeEngine({ scope });
    const cdp = fakeCdp();
    engine.captureFrom(cdp.client, { sensitive: carriesSecret });
    await flush();
    await cdp.login("1", `user=alice&pass=${SECRET}`);
    await cdp.login("2", "q=weather", "https://login.example/search?q=weather");
    const id = engine.queryHistory({ method: "POST" }).find((s) => s.path.startsWith("/session"))!.id;
    return { engine, id };
  }

  it("people see the request in full, with the mark; AI clients get it redacted", async () => {
    const { engine, id } = await engineWithLogin();
    expect(engine.getEntry(id)?.request.body).toContain(SECRET);
    expect(engine.queryHistory().find((s) => s.id === id)?.aiHidden).toBe(true);
    const ai = engine.getEntryForAi(id)!;
    expect(ai.request.body).toBe(AI_REDACTED_BODY);
    expect(JSON.stringify(ai)).not.toContain(SECRET);
  });

  it("search cannot probe a hidden body for AI clients", async () => {
    const { engine } = await engineWithLogin();
    expect(engine.queryHistory({ search: SECRET })).toHaveLength(1);
    expect(engine.queryHistory({ search: SECRET }, 200, { forAi: true })).toHaveLength(0);
    expect(engine.queryHistory({ search: "hunter2" }, 200, { forAi: true })).toHaveLength(0);
    expect(engine.queryHistory({ search: "weather" }, 200, { forAi: true })).toHaveLength(1);
  });

  it("findings, sitemap and the AI HAR export never carry the secret", async () => {
    const { engine } = await engineWithLogin();
    expect(JSON.stringify(engine.findings({ forAi: true }))).not.toContain(SECRET);
    expect(JSON.stringify(engine.sitemap({ forAi: true }))).not.toContain(SECRET);
    const har = engine.exportHar(undefined, { forAi: true });
    const post = har.log.entries.find((e) => e.request.method === "POST" && e.request.url.includes("/session"))!;
    expect(post.request.postData?.text).toBe(AI_REDACTED_BODY);
    expect(post.request.queryString).toEqual([{ name: "next", value: AI_REDACTED_VALUE }]);
    expect(JSON.stringify(har)).not.toContain(SECRET);
    expect(JSON.stringify(engine.exportHar())).toContain(SECRET);
  });

  it("held intercept items are marked and redacted for AI", async () => {
    const engine = new WebScopeEngine({ scope });
    const listeners: Array<(m: string, p: Record<string, unknown>) => void> = [];
    const client: CdpClient = {
      send: async () => ({}),
      onEvent(l) {
        listeners.push(l);
        return () => undefined;
      },
    };
    engine.interceptFrom(client, { sensitive: carriesSecret });
    await engine.setInterceptConfig({ enabled: true, interceptRequests: true, interceptResponses: false });
    for (const l of listeners) {
      l("Fetch.requestPaused", {
        requestId: "f1",
        resourceType: "Document",
        request: { url: "https://login.example/session", method: "POST", headers: {}, postData: `pass=${SECRET}` },
      });
    }
    await flush();
    expect(engine.interceptQueue()[0]?.aiHidden).toBe(true);
    expect(engine.interceptQueue()[0]?.request.body).toContain(SECRET);
    expect(JSON.stringify(engine.interceptQueue({ forAi: true }))).not.toContain(SECRET);
  });
});
