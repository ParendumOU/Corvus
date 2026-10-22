import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SearchResult } from "@corvus/shared";
import {
  braveSearchLang,
  createBraveRetriever,
  createDuckDuckGoRetriever,
  createRetrieverChain,
  createSearxngRetriever,
  duckduckgoRegion,
  formatDuration,
  parseBrave,
  parseDuckDuckGoHtml,
  parseSearxng,
  type Retriever,
  retrieveWithFallback,
  unwrapDuckDuckGoHref,
} from "../src/retrievers/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("searxng", () => {
  it("parses results, strips tags/tracking, drops non-http and duplicates", () => {
    const results = parseSearxng(JSON.parse(fixture("searxng.json")), 8);
    expect(results.map((r) => r.url)).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
      "https://www.rust-lang.org/",
      "https://doc.rust-lang.org/book/",
      "https://rust-lang.org/learn/get-started/",
    ]);
    expect(results[0]).toMatchObject({
      title: "Rust (programming language) - Wikipedia",
      source: "en.wikipedia.org",
      rank: 1,
    });
    expect(results[0]!.snippet).not.toContain("<span");
    expect(results[2]!.title).toBe("The Rust Programming Language & you");
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it("honors maxResults", () => {
    expect(parseSearxng(JSON.parse(fixture("searxng.json")), 2)).toHaveLength(2);
  });

  it("rejects unexpected shapes", () => {
    expect(() => parseSearxng({ error: "nope" }, 8)).toThrow(/unexpected response shape/);
  });

  it("sends query, json format and language", async () => {
    let requested = "";
    const retriever = createSearxngRetriever("http://searxng:8080", {
      fetch: async (url) => {
        requested = String(url);
        return jsonResponse(JSON.parse(fixture("searxng.json")));
      },
    });
    const results = await retriever.search("rust lang", { lang: "es-ES", maxResults: 3 });
    const url = new URL(requested);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("rust lang");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("language")).toBe("es-ES");
    expect(results).toHaveLength(3);
  });

  it("fails on HTTP errors and on timeout", async () => {
    const http500 = createSearxngRetriever("http://s", { fetch: async () => new Response("", { status: 500 }) });
    await expect(http500.search("x", { lang: "en", maxResults: 5 })).rejects.toThrow(/searxng: HTTP 500/);

    const hanging = createSearxngRetriever("http://s", {
      timeoutMs: 50,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    await expect(hanging.search("x", { lang: "en", maxResults: 5 })).rejects.toThrow(/timed out after 50 ms/);
  });
});

describe("searxng verticals", () => {
  it("parses news with age, publisher and thumbnail", () => {
    const results = parseSearxng(JSON.parse(fixture("searxng-news.json")), 12, "news");
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({
      source: "theatlantic.com",
      rank: 1,
      age: "13 hours ago",
      publisher: "The Atlantic",
    });
    expect(results[0]!.thumbnail).toMatch(/^https:\/\/www\.bing\.com\//);
    expect(results[2]).toMatchObject({ publisher: "The New York Times", age: "4 days ago" });
  });

  it("parses images with source page, image, thumbnail and size, deduped by image", () => {
    const body = JSON.parse(fixture("searxng-images.json"));
    body.results.push({ ...body.results[0], url: "https://www.britannica.com/animal/common-raven?utm_source=x" });
    const results = parseSearxng(body, 30, "images");
    expect(results.length).toBe(5);
    expect(results[0]).toMatchObject({
      url: "https://www.britannica.com/animal/common-raven",
      source: "britannica.com",
      image: { src: "https://cdn.britannica.com/45/125645-050-A817FE34/Common-raven.jpg", width: 1600, height: 1174, format: "jpeg" },
    });
    expect(results[0]!.thumbnail).toMatch(/^https:\/\/encrypted-tbn0\.gstatic\.com\//);
    expect(results.every((r) => r.image?.src.startsWith("https://"))).toBe(true);
    expect(parseSearxng(body, 2, "images")).toHaveLength(2);
  });

  it("parses videos with duration, channel, date and thumbnail", () => {
    const results = parseSearxng(JSON.parse(fixture("searxng-videos.json")), 12, "videos");
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results[0]).toMatchObject({ duration: "10:21", publisher: "Will Velida" });
    expect(results.every((r) => !r.thumbnail || /^https:\/\//.test(r.thumbnail))).toBe(true);
    expect(results.some((r) => r.publishedAt?.startsWith("2024-06-09"))).toBe(true);
    expect(results.some((r) => r.duration === "1:53:22")).toBe(true);
  });

  it("formats durations", () => {
    expect(formatDuration("10:21")).toBe("10:21");
    expect(formatDuration("00:15")).toBe("0:15");
    expect(formatDuration(6802)).toBe("1:53:22");
    expect(formatDuration("PT4M13S")).toBe("4:13");
    expect(formatDuration("live")).toBeUndefined();
    expect(formatDuration(null)).toBeUndefined();
  });

  it("asks SearXNG for the category and advertises the verticals", async () => {
    let requested = "";
    const retriever = createSearxngRetriever("http://searxng:8080", {
      fetch: async (url) => {
        requested = String(url);
        return jsonResponse(JSON.parse(fixture("searxng-images.json")));
      },
    });
    expect(retriever.categories).toEqual(["news", "images", "videos"]);
    const results = await retriever.search("raven", { lang: "en", maxResults: 3, category: "images" });
    expect(new URL(requested).searchParams.get("categories")).toBe("images");
    expect(results[0]!.image).toBeDefined();
    await retriever.search("raven", { lang: "en", maxResults: 3 });
    expect(new URL(requested).searchParams.has("categories")).toBe(false);
  });
});

describe("brave", () => {
  it("parses web results and dedupes", () => {
    const results = parseBrave(JSON.parse(fixture("brave.json")), 8);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      url: "https://www.example-recetas.es/paella-valenciana",
      title: "Paella valenciana: la receta tradicional",
      source: "example-recetas.es",
    });
    expect(results[1]!.title).toBe("Cómo hacer paella – guía paso a paso");
  });

  it("handles a response without web results", () => {
    expect(parseBrave({ type: "search" }, 8)).toEqual([]);
  });

  it("maps languages to Brave codes and sends the API key", async () => {
    expect(braveSearchLang("ja")).toBe("jp");
    expect(braveSearchLang("zh-TW")).toBe("zh-hant");
    expect(braveSearchLang("zh")).toBe("zh-hans");
    expect(braveSearchLang("pt")).toBe("pt-br");
    expect(braveSearchLang("es-MX")).toBe("es");
    expect(braveSearchLang("xx")).toBeUndefined();

    let headers: Headers | undefined;
    let requested = "";
    const retriever = createBraveRetriever("KEY", {
      fetch: async (url, init) => {
        requested = String(url);
        headers = new Headers(init?.headers);
        return jsonResponse(JSON.parse(fixture("brave.json")));
      },
    });
    await retriever.search("receta paella", { lang: "es", maxResults: 5 });
    expect(headers?.get("x-subscription-token")).toBe("KEY");
    expect(new URL(requested).searchParams.get("search_lang")).toBe("es");
    expect(new URL(requested).searchParams.get("count")).toBe("5");
  });
});

describe("duckduckgo", () => {
  it("parses the HTML endpoint, skipping ads and unwrapping redirect links", () => {
    const results = parseDuckDuckGoHtml(fixture("ddg-results.html"), 10);
    expect(results.length).toBeGreaterThanOrEqual(5);
    expect(results[0]).toMatchObject({ url: "https://rust-lang.org/", title: "Rust Programming Language" });
    expect(results[0]!.snippet).toMatch(/^Rust is a fast, memory-safe/);
    expect(results.some((r) => r.url.includes("duckduckgo.com") || r.url.includes("bing.com"))).toBe(false);
    expect(results.find((r) => r.source === "doc.rust-lang.org")?.snippet).toContain("you're using Rust");
  });

  it("detects the bot challenge page", () => {
    expect(() => parseDuckDuckGoHtml(fixture("ddg-challenge.html"), 10)).toThrow(/bot challenge/);
  });

  it("unwraps uddg links and maps regions", () => {
    expect(unwrapDuckDuckGoHref("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x")).toBe(
      "https://example.com/a?b=1",
    );
    expect(unwrapDuckDuckGoHref("https://direct.example/")).toBe("https://direct.example/");
    expect(unwrapDuckDuckGoHref("//duckduckgo.com/y.js?ad_domain=x")).toBeUndefined();
    expect(duckduckgoRegion("es")).toBe("es-es");
    expect(duckduckgoRegion("pt-BR")).toBe("br-pt");
    expect(duckduckgoRegion("xx")).toBe("wt-wt");
  });

  it("uses GET with the kl region", async () => {
    let method = "";
    let requested = "";
    const retriever = createDuckDuckGoRetriever({
      fetch: async (url, init) => {
        requested = String(url);
        method = init?.method ?? "GET";
        return new Response(fixture("ddg-results.html"), { headers: { "content-type": "text/html" } });
      },
    });
    const results = await retriever.search("rust", { lang: "de", maxResults: 3 });
    expect(method).toBe("GET");
    expect(new URL(requested).searchParams.get("kl")).toBe("de-de");
    expect(results).toHaveLength(3);
  });
});

describe("fallback chain", () => {
  const result = (url: string): SearchResult => ({ url, title: url, snippet: "", source: "x", rank: 1 });
  const fake = (kind: Retriever["kind"], impl: () => Promise<SearchResult[]>): Retriever => ({ kind, search: impl });

  it("orders the configured retriever first and only includes usable ones", () => {
    expect(createRetrieverChain({ retriever: "duckduckgo", searxngUrl: "http://s" }).map((r) => r.kind)).toEqual([
      "duckduckgo",
      "searxng",
    ]);
    expect(
      createRetrieverChain({ retriever: "brave", braveApiKey: "k", searxngUrl: "http://s" }).map((r) => r.kind),
    ).toEqual(["brave", "searxng", "duckduckgo"]);
    expect(createRetrieverChain({ retriever: "searxng" }).map((r) => r.kind)).toEqual(["duckduckgo"]);
  });

  it("falls back on error and on empty results", async () => {
    const chain = [
      fake("searxng", async () => {
        throw new Error("connect ECONNREFUSED");
      }),
      fake("brave", async () => []),
      fake("duckduckgo", async () => [result("https://a.example/")]),
    ];
    const out = await retrieveWithFallback(chain, "q", { lang: "en", maxResults: 5 });
    expect(out.retriever).toBe("duckduckgo");
    expect(out.errors).toEqual(["searxng: connect ECONNREFUSED", "brave: no results"]);
  });

  it("returns the first empty list when nothing has results, throws when all fail", async () => {
    const empty = await retrieveWithFallback([fake("searxng", async () => [])], "q", { lang: "en", maxResults: 5 });
    expect(empty).toMatchObject({ retriever: "searxng", results: [] });
    const failing = fake("searxng", async () => {
      throw new Error("boom");
    });
    await expect(retrieveWithFallback([failing], "q", { lang: "en", maxResults: 5 })).rejects.toThrow(
      /All retrievers failed \(searxng: boom\)/,
    );
  });

  it("does not fall back after a caller abort", async () => {
    const controller = new AbortController();
    let secondCalled = false;
    const chain = [
      fake("searxng", async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
      fake("duckduckgo", async () => {
        secondCalled = true;
        return [];
      }),
    ];
    await expect(
      retrieveWithFallback(chain, "q", { lang: "en", maxResults: 5, signal: controller.signal }),
    ).rejects.toThrow();
    expect(secondCalled).toBe(false);
  });
});
