import { describe, expect, it } from "vitest";
import { buildSitemap, scanFindings } from "../src/findings.js";
import type { HistoryEntry, HttpHeader } from "../src/types.js";

let seq = 0;
function entry(over: Partial<HistoryEntry> & { url: string; status?: number; resHeaders?: HttpHeader[]; mime?: string; body?: string }): HistoryEntry {
  const url = over.url;
  const u = new URL(url);
  return {
    id: `e${seq++}`,
    profileId: "p",
    startedAt: Date.now(),
    host: u.host,
    path: u.pathname + u.search,
    type: over.type ?? "document",
    inScope: true,
    source: "capture",
    request: { method: over.request?.method ?? "GET", url, headers: over.request?.headers ?? [] },
    response: over.status === undefined ? undefined : { status: over.status, headers: over.resHeaders ?? [], mimeType: over.mime ?? "text/html", ...(over.body !== undefined ? { body: over.body } : {}) },
    ...over,
  } as HistoryEntry;
}

describe("scanFindings", () => {
  it("flags missing security headers on an HTML document", () => {
    const f = scanFindings([entry({ url: "https://example.com/", status: 200, resHeaders: [] })]);
    const kinds = f.map((x) => x.title);
    expect(kinds).toContain("Missing Content-Security-Policy");
    expect(kinds).toContain("Missing HSTS");
    expect(kinds.some((t) => t.includes("X-Content-Type-Options"))).toBe(true);
  });

  it("does not flag HSTS on plain HTTP", () => {
    const f = scanFindings([entry({ url: "http://example.com/", status: 200, resHeaders: [] })]);
    expect(f.some((x) => x.title === "Missing HSTS")).toBe(false);
  });

  it("is quiet when the hardening headers are present", () => {
    const f = scanFindings([
      entry({
        url: "https://example.com/",
        status: 200,
        resHeaders: [
          { name: "Content-Security-Policy", value: "default-src 'self'; frame-ancestors 'none'" },
          { name: "X-Content-Type-Options", value: "nosniff" },
          { name: "Strict-Transport-Security", value: "max-age=63072000" },
        ],
      }),
    ]);
    expect(f.filter((x) => x.kind === "missing-security-header")).toHaveLength(0);
  });

  it("flags insecure cookies and version disclosure", () => {
    const f = scanFindings([
      entry({
        url: "https://example.com/login",
        status: 200,
        resHeaders: [
          { name: "Set-Cookie", value: "sid=abc; Path=/" },
          { name: "Server", value: "nginx/1.21.0" },
        ],
      }),
    ]);
    expect(f.some((x) => x.kind === "insecure-cookie" && x.title.includes("Secure"))).toBe(true);
    expect(f.some((x) => x.kind === "version-disclosure")).toBe(true);
  });

  it("flags a reflected query parameter echoed in the body", () => {
    const f = scanFindings([entry({ url: "https://example.com/s?q=needle123", status: 200, mime: "text/html", body: "<p>results for needle123</p>" })]);
    expect(f.some((x) => x.kind === "reflected-parameter")).toBe(true);
  });

  it("flags mixed content: http resource on an https host", () => {
    const f = scanFindings([
      entry({ url: "https://example.com/", status: 200, resHeaders: [{ name: "Content-Security-Policy", value: "x" }, { name: "X-Content-Type-Options", value: "nosniff" }, { name: "X-Frame-Options", value: "DENY" }, { name: "Strict-Transport-Security", value: "max-age=1" }] }),
      entry({ url: "http://example.com/script.js", status: 200, type: "script", mime: "application/javascript" }),
    ]);
    expect(f.some((x) => x.kind === "mixed-content")).toBe(true);
  });

  it("dedupes repeated observations", () => {
    const e = () => entry({ url: "https://example.com/", status: 200, resHeaders: [] });
    const f = scanFindings([e(), e(), e()]);
    expect(f.filter((x) => x.title === "Missing Content-Security-Policy")).toHaveLength(1);
  });
});

describe("buildSitemap", () => {
  it("builds a host -> path tree with methods and counts", () => {
    const tree = buildSitemap([
      entry({ url: "https://example.com/api/users", request: { method: "GET", url: "x", headers: [] } }),
      entry({ url: "https://example.com/api/users", request: { method: "POST", url: "x", headers: [] } }),
      entry({ url: "https://example.com/about", request: { method: "GET", url: "x", headers: [] } }),
    ]);
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root.segment).toBe("example.com");
    expect(root.count).toBe(3);
    const api = root.children.find((c) => c.segment === "api")!;
    const users = api.children.find((c) => c.segment === "users")!;
    expect(users.methods.sort()).toEqual(["GET", "POST"]);
    expect(users.path).toBe("/api/users");
  });
});
