import { describe, expect, it } from "vitest";
import { dedupeResults, domainOf, normalizeUrl, stripTracking } from "../src/url.js";

describe("stripTracking", () => {
  it("removes utm_*, click ids and other trackers but keeps real params", () => {
    expect(stripTracking("https://example.com/a?utm_source=x&utm_medium=y&id=42&gclid=1&fbclid=2#top")).toBe(
      "https://example.com/a?id=42#top",
    );
    expect(stripTracking("https://shop.example/p?ref_src=twsrc&mc_cid=a&mc_eid=b&color=red")).toBe(
      "https://shop.example/p?color=red",
    );
  });

  it("leaves invalid and non-http URLs untouched", () => {
    expect(stripTracking("not a url")).toBe("not a url");
    expect(stripTracking("mailto:a@b.c?utm_source=x")).toBe("mailto:a@b.c?utm_source=x");
  });
});

describe("normalizeUrl", () => {
  it("treats scheme, www, trailing slash, fragment, default port and param order as equivalent", () => {
    const variants = [
      "https://www.Example.com/docs/?b=2&a=1",
      "http://example.com/docs?a=1&b=2",
      "https://example.com:443/docs/?a=1&b=2&utm_source=news#intro",
      "https://EXAMPLE.com//docs?b=2&a=1&fbclid=zzz",
    ];
    const keys = new Set(variants.map(normalizeUrl));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("example.com/docs?a=1&b=2");
  });

  it("keeps meaningful differences", () => {
    expect(normalizeUrl("https://example.com/a")).not.toBe(normalizeUrl("https://example.com/b"));
    expect(normalizeUrl("https://example.com/a?id=1")).not.toBe(normalizeUrl("https://example.com/a?id=2"));
    expect(normalizeUrl("https://example.com:8080/")).toBe("example.com:8080");
  });
});

describe("dedupeResults", () => {
  it("keeps the first occurrence and re-ranks", () => {
    const r = (url: string, title: string) => ({ url, title, snippet: "", source: domainOf(url), rank: 0 });
    const out = dedupeResults([
      r("https://www.rust-lang.org/", "first"),
      r("https://doc.rust-lang.org/book/", "book"),
      r("http://rust-lang.org#community", "dup"),
      r("https://doc.rust-lang.org/book/?utm_campaign=x", "dup book"),
    ]);
    expect(out.map((x) => [x.title, x.rank])).toEqual([
      ["first", 1],
      ["book", 2],
    ]);
  });
});

describe("domainOf", () => {
  it("returns the bare lowercase host", () => {
    expect(domainOf("https://WWW.Wikipedia.org/wiki/X")).toBe("wikipedia.org");
    expect(domainOf("garbage")).toBe("");
  });
});
