import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SearchResult } from "@corvus/shared";
import { extractReadableText, fetchPageExtracts, isFetchablePublicUrl, isPrivateAddress, type LookupLike } from "../src/deep.js";

const article = readFileSync(new URL("./fixtures/article.html", import.meta.url), "utf8");

const result = (url: string, rank: number): SearchResult => ({ url, title: url, snippet: "", source: "x", rank });

/** Every test host resolves to a public documentation address unless a test says otherwise. */
const publicLookup: LookupLike = async () => ["93.184.216.34"];

describe("extractReadableText", () => {
  it("keeps the article body and drops chrome and scripts", () => {
    const text = extractReadableText(article);
    expect(text).toContain("Ownership is a set of rules that govern how a Rust program manages memory.");
    expect(text).toContain("Each value in Rust has an owner.");
    expect(text).not.toContain("should never appear");
    expect(text).not.toContain("Subscribe to our newsletter");
    expect(text).not.toContain("All rights reserved");
  });

  it("keeps block boundaries as spaces on tiny pages", () => {
    const text = extractReadableText("<html><body><nav>menu</nav><p>Short page.</p></body></html>");
    expect(text).toMatch(/(^| )Short page\.$/);
    expect(text).not.toContain("menuShort");
  });

  it("returns empty text for empty documents", () => {
    expect(extractReadableText("<html><body><script>x()</script></body></html>")).toBe("");
  });
});

describe("isFetchablePublicUrl", () => {
  it.each([
    ["https://example.com/a", true],
    ["http://8.8.8.8/", true],
    ["http://localhost:3000/", false],
    ["http://127.0.0.1/", false],
    ["http://192.168.1.10/admin", false],
    ["http://10.0.0.1/", false],
    ["http://172.20.0.5/", false],
    ["http://[::1]/", false],
    ["http://[::ffff:127.0.0.1]/", false],
    ["http://[::ffff:7f00:1]/", false],
    ["http://0.0.0.0/", false],
    ["http://100.64.1.1/", false],
    ["http://169.254.169.254/latest/meta-data", false],
    ["http://2130706433/", false],
    ["http://[2606:4700::1111]/", true],
    ["file:///etc/passwd", false],
    ["corvus://settings", false],
  ])("%s -> %s", (url, ok) => {
    expect(isFetchablePublicUrl(url)).toBe(ok);
  });
});

describe("fetchPageExtracts", () => {
  it("fetches the top 3 concurrently, only text/html, trimmed to the char cap", async () => {
    const requested: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl: typeof fetch = async (url) => {
      requested.push(String(url));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      if (String(url).endsWith("/pdf")) return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
      return new Response(article, { headers: { "content-type": "text/html; charset=utf-8" } });
    };
    const results = [
      result("https://a.example/one", 1),
      result("https://b.example/pdf", 2),
      result("https://c.example/three", 3),
      result("https://d.example/four", 4),
    ];
    const pages = await fetchPageExtracts(results, { fetch: fetchImpl, lookup: publicLookup, maxChars: 200 });
    expect(requested).toHaveLength(3);
    expect(maxInFlight).toBe(3);
    expect(pages.map((p) => p.index)).toEqual([0, 2]);
    for (const p of pages) expect(p.text.length).toBeLessThanOrEqual(200);
  });

  it("skips oversized and slow pages", async () => {
    const big = "<p>" + "x".repeat(5000) + "</p>";
    const fetchImpl: typeof fetch = (url, init) => {
      if (String(url).includes("slow")) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return Promise.resolve(new Response(big, { headers: { "content-type": "text/html" } }));
    };
    const started = Date.now();
    const pages = await fetchPageExtracts([result("https://big.example/", 1), result("https://slow.example/", 2)], {
      fetch: fetchImpl,
      lookup: publicLookup,
      maxBytes: 1000,
      timeoutMs: 100,
    });
    expect(pages).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("isPrivateAddress", () => {
  it.each([
    ["8.8.8.8", false],
    ["10.1.2.3", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["224.0.0.1", true],
    ["fd12::1", true],
    ["fe80::1", true],
    ["::ffff:192.168.0.1", true],
    ["2001:4860:4860::8888", false],
    ["not-an-ip", true],
  ])("%s -> %s", (ip, priv) => {
    expect(isPrivateAddress(ip)).toBe(priv);
  });
});

describe("fetchPageExtracts address checks", () => {
  const page = (): Response =>
    new Response("<html><body><p>" + "public text ".repeat(30) + "</p></body></html>", { headers: { "content-type": "text/html" } });

  it("refuses hostnames that resolve to private addresses", async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      requested.push(String(url));
      return page();
    };
    const lookup: LookupLike = async (host) => (host === "rebind.example" ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"]);
    const pages = await fetchPageExtracts([result("https://rebind.example/", 1), result("https://ok.example/", 2)], { fetch: fetchImpl, lookup });
    expect(requested).toEqual(["https://ok.example/"]);
    expect(pages.map((p) => p.index)).toEqual([1]);
  });

  it("checks every redirect hop and stops at private targets", async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requested.push(String(url));
      expect(init?.redirect).toBe("manual");
      if (String(url).includes("hop1")) return new Response(null, { status: 302, headers: { location: "/hop2" } });
      if (String(url).includes("hop2")) return new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest" } });
      return page();
    };
    const pages = await fetchPageExtracts([result("https://a.example/hop1", 1)], { fetch: fetchImpl, lookup: publicLookup });
    expect(requested).toEqual(["https://a.example/hop1", "https://a.example/hop2"]);
    expect(pages).toEqual([]);
  });

  it("follows public redirects to the final page", async () => {
    const fetchImpl: typeof fetch = async (url) =>
      String(url).endsWith("/old") ? new Response(null, { status: 308, headers: { location: "https://b.example/new" } }) : page();
    const pages = await fetchPageExtracts([result("https://a.example/old", 1)], { fetch: fetchImpl, lookup: publicLookup });
    expect(pages).toHaveLength(1);
  });

  it("gives up after too many redirects", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 302, headers: { location: "/loop" + ++n } });
    const pages = await fetchPageExtracts([result("https://a.example/loop", 1)], { fetch: fetchImpl, lookup: publicLookup });
    expect(pages).toEqual([]);
    expect(n).toBe(6);
  });
});
