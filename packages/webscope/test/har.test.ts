import { describe, expect, it } from "vitest";
import { exportHar, importHar } from "../src/har.js";
import type { HistoryEntry } from "../src/types.js";

const entry: HistoryEntry = {
  id: "e1",
  profileId: "p1",
  startedAt: Date.parse("2026-01-01T00:00:00.000Z"),
  durationMs: 42,
  host: "example.com",
  path: "/api?q=1",
  type: "xhr",
  inScope: true,
  source: "capture",
  request: { method: "POST", url: "https://example.com/api?q=1", headers: [{ name: "content-type", value: "application/json" }], body: '{"a":1}' },
  response: { status: 201, statusText: "Created", headers: [{ name: "content-type", value: "application/json" }], body: '{"ok":true}', mimeType: "application/json", size: 11 },
};

describe("HAR round-trip", () => {
  it("exports and re-imports an entry losslessly for the fields it carries", () => {
    const har = exportHar([entry]);
    expect(har.log.version).toBe("1.2");
    const [back] = importHar(har);
    expect(back?.request.method).toBe("POST");
    expect(back?.request.url).toBe("https://example.com/api?q=1");
    expect(back?.request.body).toBe('{"a":1}');
    expect(back?.response?.status).toBe(201);
    expect(back?.response?.body).toBe('{"ok":true}');
    expect(back?.host).toBe("example.com");
  });

  it("preserves binary bodies via base64 encoding", () => {
    const bin: HistoryEntry = { ...entry, response: { status: 200, headers: [], body: Buffer.from([0, 1, 2, 255]).toString("base64"), bodyBase64: true, size: 4 } };
    const [back] = importHar(exportHar([bin]));
    expect(back?.response?.bodyBase64).toBe(true);
    expect(Buffer.from(back!.response!.body!, "base64")).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it("rejects documents that are not HAR logs", () => {
    expect(() => importHar({ foo: "bar" })).toThrow();
  });
});
