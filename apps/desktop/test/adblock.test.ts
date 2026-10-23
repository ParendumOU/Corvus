import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  BlockedCounts,
  addAllowed,
  bundleScriptlets,
  decodeDataUrl,
  hostFromUrl,
  isBlockablePageUrl,
  isHostAllowed,
  isLoopbackHost,
  isNeverBlockedUrl,
  normalizeHost,
  removeAllowed,
  reviveAdblockSettings,
  shouldBlockPage,
  type AdblockSettings,
} from "../src/shared/adblock";

const on: AdblockSettings = { enabled: true, allowed: [] };

describe("bundleScriptlets", () => {
  // The shape of a Ghostery scriptlet: helpers inlined as top-level declarations, uBO's shared globals.
  const scriptlet = (name: string) => `if (typeof scriptletGlobals === 'undefined') { var scriptletGlobals = {}; };
    class JSONPath {}
    function safeSelf() { if (safeSelf.safe) return safeSelf.safe; return { parse: JSON.parse }; }
    if (scriptletGlobals.safeSelf) { safeSelf.safe = scriptletGlobals.safeSelf; } else { scriptletGlobals.safeSelf = safeSelf(); }
    ran.push([${JSON.stringify(name)}, safeSelf().parse === originalParse]);
    JSON.parse = new Proxy(JSON.parse, { apply: (t, self, args) => Reflect.apply(t, self, args) });`;

  it("runs every scriptlet once, without clashing declarations, on the page's original built-ins", () => {
    const sandbox = { ran: [] as Array<[string, boolean]>, JSON: { parse: JSON.parse }, originalParse: undefined as unknown };
    sandbox.originalParse = sandbox.JSON.parse;
    runInNewContext(bundleScriptlets([scriptlet("a"), scriptlet("b"), "throw new Error('broken')", scriptlet("c")]), sandbox);
    expect(sandbox.ran).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);
    expect("scriptletGlobals" in sandbox).toBe(false);
  });

  it("is empty when there is nothing to run", () => {
    expect(bundleScriptlets([])).toBe("");
  });
});

describe("decodeDataUrl (stand-ins served instead of data: redirects)", () => {
  it("decodes base64 and plain bodies with their content type", () => {
    const gif = decodeDataUrl("data:image/gif;base64,R0lGODlhAQABAA==");
    expect(gif?.type).toBe("image/gif");
    expect(Array.from(gif?.bytes ?? []).slice(0, 6)).toEqual([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const js = decodeDataUrl("data:application/javascript;base64,KGZ1bmN0aW9uKCl7fSkoKTs=");
    expect(new TextDecoder().decode(js?.bytes)).toBe("(function(){})();");
    const text = decodeDataUrl("data:text/plain;charset=utf-8,ok, fine");
    expect(text).toEqual({ type: "text/plain;charset=utf-8", bytes: new TextEncoder().encode("ok, fine") });
  });

  it("refuses anything else", () => {
    expect(decodeDataUrl("https://example.com/noop.js")).toBeNull();
    expect(decodeDataUrl("data:no-comma")).toBeNull();
  });
});

describe("normalizeHost", () => {
  it("lower-cases, strips www and trailing dot", () => {
    expect(normalizeHost("WWW.Example.COM.")).toBe("example.com");
  });
  it("accepts full URLs and bare hosts", () => {
    expect(normalizeHost("https://www.news.example.com/page?x=1")).toBe("news.example.com");
    expect(normalizeHost("sub.example.org")).toBe("sub.example.org");
  });
  it("returns empty for junk", () => {
    expect(normalizeHost("   ")).toBe("");
  });
});

describe("hostFromUrl", () => {
  it("extracts hostnames", () => {
    expect(hostFromUrl("https://ads.doubleclick.net/x")).toBe("ads.doubleclick.net");
    expect(hostFromUrl("not a url")).toBeNull();
  });
});

describe("loopback / never-blocked", () => {
  it("recognises loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("foo.localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
  it("never blocks requests to corvus://, loopback and non-web schemes", () => {
    expect(isNeverBlockedUrl("corvus://settings/")).toBe(true);
    expect(isNeverBlockedUrl("http://localhost:8080/ad.js")).toBe(true);
    expect(isNeverBlockedUrl("http://127.0.0.1:5000/track")).toBe(true);
    expect(isNeverBlockedUrl("data:text/html,x")).toBe(true);
    expect(isNeverBlockedUrl("https://ads.doubleclick.net/x")).toBe(false);
  });
});

describe("isBlockablePageUrl", () => {
  it("is true for http(s) pages including loopback dev servers, false for corvus:// and others", () => {
    expect(isBlockablePageUrl("https://example.com/")).toBe(true);
    expect(isBlockablePageUrl("http://127.0.0.1:8080/fixture")).toBe(true);
    expect(isBlockablePageUrl("corvus://settings/")).toBe(false);
    expect(isBlockablePageUrl("about:blank")).toBe(false);
    expect(isBlockablePageUrl("")).toBe(false);
  });
});

describe("allow list", () => {
  it("adds (normalized, deduped, sorted) and removes", () => {
    let list = addAllowed([], "WWW.Example.com");
    list = addAllowed(list, "aaa.org");
    list = addAllowed(list, "example.com"); // dup after normalize
    expect(list).toEqual(["aaa.org", "example.com"]);
    expect(removeAllowed(list, "www.example.com")).toEqual(["aaa.org"]);
  });
  it("matches host and subdomains", () => {
    expect(isHostAllowed("example.com", ["example.com"])).toBe(true);
    expect(isHostAllowed("shop.example.com", ["example.com"])).toBe(true);
    expect(isHostAllowed("notexample.com", ["example.com"])).toBe(false);
    expect(isHostAllowed("www.example.com", ["example.com"])).toBe(true);
  });
});

describe("shouldBlockPage", () => {
  it("blocks normal sites when enabled", () => {
    expect(shouldBlockPage(on, "example.com")).toBe(true);
  });
  it("does not block when globally disabled", () => {
    expect(shouldBlockPage({ enabled: false, allowed: [] }, "example.com")).toBe(false);
  });
  it("does not block allowed sites or their subdomains", () => {
    const s: AdblockSettings = { enabled: true, allowed: ["example.com"] };
    expect(shouldBlockPage(s, "example.com")).toBe(false);
    expect(shouldBlockPage(s, "news.example.com")).toBe(false);
    expect(shouldBlockPage(s, "other.org")).toBe(true);
  });
  it("does not block empty hosts", () => {
    expect(shouldBlockPage(on, "")).toBe(false);
  });
});

describe("reviveAdblockSettings", () => {
  it("defaults enabled to true and normalizes the allow list", () => {
    expect(reviveAdblockSettings(undefined)).toEqual({ enabled: true, allowed: [] });
    expect(reviveAdblockSettings({ enabled: false, allowed: ["WWW.B.com", "a.com", "a.com"] })).toEqual({
      enabled: false,
      allowed: ["a.com", "b.com"],
    });
  });
});

describe("BlockedCounts", () => {
  it("counts per tab and keeps a running total", () => {
    const counts = new BlockedCounts();
    expect(counts.record(1)).toBe(1);
    expect(counts.record(1)).toBe(2);
    counts.record(2);
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(1);
    expect(counts.total()).toBe(3);
  });
  it("reset clears a tab count but keeps the total; forget drops the entry", () => {
    const counts = new BlockedCounts();
    counts.record(1);
    counts.record(1);
    counts.reset(1);
    expect(counts.get(1)).toBe(0);
    expect(counts.total()).toBe(2);
    counts.record(1);
    counts.forget(1);
    expect(counts.get(1)).toBe(0);
    expect(counts.total()).toBe(3);
  });
  it("unknown tab reads as zero", () => {
    expect(new BlockedCounts().get(99)).toBe(0);
  });
});
