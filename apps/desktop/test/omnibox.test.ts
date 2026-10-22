import { describe, expect, it } from "vitest";
import { classifyOmnibox, displayUrl, intentToUrl, searchQueryOf, searchUrl } from "../src/shared/omnibox";

const url = (input: string): string => {
  const intent = classifyOmnibox(input);
  if (intent.kind !== "url") throw new Error(`expected URL for "${input}", got search "${intent.query}"`);
  return intent.url;
};
const search = (input: string): string => {
  const intent = classifyOmnibox(input);
  if (intent.kind !== "search") throw new Error(`expected search for "${input}", got URL ${intent.url}`);
  return intent.query;
};

describe("classifyOmnibox: explicit schemes", () => {
  it.each([
    ["https://example.com", "https://example.com"],
    ["http://example.com/path?q=1#x", "http://example.com/path?q=1#x"],
    ["HTTPS://Example.com", "https://Example.com"],
    ["https:example.com", "https://example.com"],
    ["corvus://settings", "corvus://settings"],
    ["corvus://search?q=hello", "corvus://search?q=hello"],
    ["corvus:history", "corvus://history"],
    ["about:blank", "about:blank"],
    ["file:///home/user/doc.pdf", "file:///home/user/doc.pdf"],
    ["ftp://files.example.org", "ftp://files.example.org"],
    ["mailto:someone@example.com", "mailto:someone@example.com"],
    ["view-source:https://example.com", "view-source:https://example.com"],
    ["chrome-extension://abc/popup.html", "chrome-extension://abc/popup.html"],
    ["data:text/plain,hi", "data:text/plain,hi"],
  ])("%s -> %s", (input, expected) => {
    expect(url(input)).toBe(expected);
  });

  it("does not treat unknown schemes as URLs", () => {
    expect(search("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(search("foo:bar")).toBe("foo:bar");
    expect(search("note: buy milk")).toBe("note: buy milk");
  });

  it("searches when a scheme URL contains spaces", () => {
    expect(search("https://example.com and more")).toBe("https://example.com and more");
  });
});

describe("classifyOmnibox: hosts without scheme", () => {
  it.each([
    ["example.com", "https://example.com/"],
    ["Example.COM", "https://example.com/"],
    ["www.github.com/corvus/browser", "https://www.github.com/corvus/browser"],
    ["news.ycombinator.com?p=2", "https://news.ycombinator.com?p=2"],
    ["sub.domain.co.uk", "https://sub.domain.co.uk/"],
    ["example.io:8443/api", "https://example.io:8443/api"],
    ["claude.ai", "https://claude.ai/"],
    ["my-site.dev", "https://my-site.dev/"],
    ["example.com.", "https://example.com./"],
    ["xn--bcher-kva.de", "https://xn--bcher-kva.de/"],
    ["example.xn--p1ai", "https://example.xn--p1ai/"],
  ])("%s -> %s", (input, expected) => {
    expect(url(input)).toBe(expected);
  });

  it.each([
    ["localhost", "http://localhost/"],
    ["localhost:3000", "http://localhost:3000/"],
    ["LOCALHOST:8080/admin", "http://localhost:8080/admin"],
    ["app.localhost:5173", "http://app.localhost:5173/"],
    ["127.0.0.1", "http://127.0.0.1/"],
    ["192.168.1.10:8080/status", "http://192.168.1.10:8080/status"],
    ["10.0.0.1/", "http://10.0.0.1/"],
    ["[::1]:8080", "http://[::1]:8080/"],
    ["[2001:db8::1]/x", "http://[2001:db8::1]/x"],
    ["intranet/", "http://intranet/"],
    ["router:8080", "http://router:8080/"],
  ])("local/IP %s -> %s", (input, expected) => {
    expect(url(input)).toBe(expected);
  });

  it("rejects invalid IPs, ports and TLDs", () => {
    expect(search("256.1.1.1")).toBe("256.1.1.1");
    expect(search("localhost:99999")).toBe("localhost:99999");
    expect(search("localhost:abc")).toBe("localhost:abc");
    expect(search("example.notatld")).toBe("example.notatld");
    expect(search("3.14")).toBe("3.14");
    expect(search("1.2.3")).toBe("1.2.3");
    expect(search("file.txt")).toBe("file.txt");
    expect(search("index.html")).toBe("index.html");
    expect(search("-bad-.com")).toBe("-bad-.com");
    expect(search("a..b.com")).toBe("a..b.com");
    expect(search("[::1")).toBe("[::1");
  });
});

describe("classifyOmnibox: searches", () => {
  it.each(["hello", "how tall is the eiffel tower", "what is example.com", "c++ templates", "rust", "react hooks tutorial"])(
    "%s is a search",
    (input) => {
      expect(search(input)).toBe(input);
    },
  );

  it("trims whitespace", () => {
    expect(search("   weather today  ")).toBe("weather today");
    expect(url("  example.com  ")).toBe("https://example.com/");
  });

  it("treats empty input as an empty search", () => {
    expect(classifyOmnibox("")).toEqual({ kind: "search", query: "" });
    expect(classifyOmnibox("   ")).toEqual({ kind: "search", query: "" });
  });

  it("forces search with a leading ?", () => {
    expect(search("? example.com")).toBe("example.com");
    expect(search("?localhost")).toBe("localhost");
  });

  it("treats e-mail addresses as searches", () => {
    expect(search("someone@example.com")).toBe("someone@example.com");
  });
});

describe("classifyOmnibox: file paths", () => {
  it("converts Windows drive paths to file URLs", () => {
    expect(url("C:\\Users\\me\\doc.pdf")).toBe("file:///C:/Users/me/doc.pdf");
    expect(url("d:/projects/readme.txt")).toBe("file:///d:/projects/readme.txt");
  });
});

describe("search URL helpers", () => {
  it("round-trips queries through corvus://search", () => {
    const u = searchUrl("ünïcode & spaces?");
    expect(u.startsWith("corvus://search?q=")).toBe(true);
    expect(searchQueryOf(u)).toBe("ünïcode & spaces?");
  });

  it("returns null for non-search URLs", () => {
    expect(searchQueryOf("https://example.com/?q=x")).toBeNull();
    expect(searchQueryOf("corvus://settings")).toBeNull();
  });

  it("intentToUrl maps searches to the search page", () => {
    expect(intentToUrl(classifyOmnibox("hello world"))).toBe("corvus://search?q=hello%20world");
    expect(intentToUrl(classifyOmnibox("example.com"))).toBe("https://example.com/");
  });
});

describe("displayUrl", () => {
  it("strips scheme and www for web URLs", () => {
    expect(displayUrl("https://www.example.com/")).toBe("example.com");
    expect(displayUrl("https://example.com/a/b?c=1")).toBe("example.com/a/b?c=1");
  });
  it("shows the query on search pages and nothing on the new tab page", () => {
    expect(displayUrl("corvus://search?q=cats")).toBe("cats");
    expect(displayUrl("corvus://newtab/")).toBe("");
  });
  it("keeps other URLs verbatim", () => {
    expect(displayUrl("corvus://settings/")).toBe("corvus://settings/");
    expect(displayUrl("file:///tmp/x")).toBe("file:///tmp/x");
  });
});
