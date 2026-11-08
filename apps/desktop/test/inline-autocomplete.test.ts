import { describe, expect, it } from "vitest";
import type { Bookmark } from "@corvus/shared";
import { applySyncedHistory, recordVisit, type HistoryRecord } from "../src/shared/history-ops";
import { toHistoryItem } from "../src/shared/chrome-history";
import { addressSite, buildSuggestions, frecency, inlineMatch, keepCompletion, withoutInline } from "../src/shared/suggest";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

function page(url: string, visitCount: number, extra: Partial<HistoryRecord> = {}): HistoryRecord {
  return { id: url, url, title: "", visitedAt: NOW - DAY, visitCount, ...extra };
}

function bookmark(url: string, title: string): Bookmark {
  return { id: url, parentId: "bar", kind: "bookmark", title, url, position: 0, createdAt: 0, updatedAt: 0 };
}

describe("frecency", () => {
  it("weighs typed visits more and fades with the age of the last visit", () => {
    expect(frecency(1, 1, NOW, NOW)).toBeGreaterThan(frecency(4, 0, NOW, NOW));
    expect(frecency(3, 0, NOW - DAY, NOW)).toBeGreaterThan(frecency(3, 0, NOW - 20 * DAY, NOW));
    expect(frecency(3, 0, NOW - 20 * DAY, NOW)).toBeGreaterThan(frecency(3, 0, NOW - 200 * DAY, NOW));
  });
});

describe("inline autocomplete", () => {
  const history = [
    page("https://edge.example.com/", 3, { title: "Edge admin" }),
    page("https://edge.example.com/login", 6, { title: "Edge admin" }),
    page("https://edge.example.com/proxy", 2),
    page("https://edge.internal.test/", 2),
  ];

  it("completes a site the typed text begins to its root, the rest selected", () => {
    expect(inlineMatch("edge", history, [], NOW)).toMatchObject({ kind: "history", url: "https://edge.example.com/", title: "Edge admin", inline: ".example.com" });
    expect(inlineMatch("edge.i", history, [], NOW)).toMatchObject({ url: "https://edge.internal.test/", inline: "nternal.test" });
  });

  it("prefers the root over a deeper page, and makes one up when only deeper pages were visited", () => {
    const deepOnly = [page("https://docs.example.org/guide/start", 5, { title: "Start" })];
    expect(inlineMatch("docs", deepOnly, [], NOW)).toMatchObject({ kind: "url", url: "https://docs.example.org/", title: "docs.example.org", inline: ".example.org" });
  });

  it("picks the site with the most frecency, typed visits weighing more", () => {
    const two = [page("https://edge.example.com/", 5), page("https://edge.internal.test/", 2, { typedCount: 2 })];
    expect(inlineMatch("edge", two, [], NOW)?.url).toBe("https://edge.internal.test/");
    const recent = [page("https://edge.example.com/", 5, { visitedAt: NOW - 200 * DAY }), page("https://edge.internal.test/", 3)];
    expect(inlineMatch("edge", recent, [], NOW)?.url).toBe("https://edge.internal.test/");
  });

  it("completes a whole address after a slash", () => {
    expect(inlineMatch("edge.example.com/l", history, [], NOW)).toMatchObject({ url: "https://edge.example.com/login", inline: "ogin" });
    expect(inlineMatch("edge.example.com/", history, [], NOW)?.url).toBe("https://edge.example.com/login");
  });

  it("matches only at the start of the address, ignoring scheme and www unless typed", () => {
    const www = [page("https://www.example.net/", 4)];
    expect(inlineMatch("exa", www, [], NOW)).toMatchObject({ url: "https://www.example.net/", inline: "mple.net" });
    expect(inlineMatch("www.exa", www, [], NOW)?.inline).toBe("mple.net");
    expect(inlineMatch("https://exa", www, [], NOW)?.inline).toBe("mple.net");
    expect(inlineMatch("http://exa", www, [], NOW)).toBeNull();
    expect(inlineMatch("www.edge", history, [], NOW)).toBeNull();
    expect(inlineMatch("example", history, [], NOW)).toBeNull();
    expect(inlineMatch("admin", history, [], NOW)).toBeNull();
  });

  it("keeps the case the person typed and the address's own case for the rest", () => {
    expect(inlineMatch("EDGE.example.com/L", history, [], NOW)?.inline).toBe("ogin");
    expect(inlineMatch("Edge", history, [], NOW)?.inline).toBe(".example.com");
  });

  it("fills in nothing for a whole known site, a search, or a page seen once through a link", () => {
    expect(inlineMatch("edge.example.com", history, [], NOW)).toBeNull();
    expect(inlineMatch("edge admin", history, [], NOW)).toBeNull();
    expect(inlineMatch("", history, [], NOW)).toBeNull();
    expect(inlineMatch("www.", history, [], NOW)).toBeNull();
    const once = [page("https://once.example.com/", 1)];
    expect(inlineMatch("once", once, [], NOW)).toBeNull();
    expect(inlineMatch("once", [page("https://once.example.com/", 1, { typedCount: 1 })], [], NOW)?.inline).toBe(".example.com");
    expect(inlineMatch("once", [], [bookmark("https://once.example.com/", "Once")], NOW)).toMatchObject({ kind: "bookmark", title: "Once", inline: ".example.com" });
  });

  it("completes a host with its port and leaves other schemes alone", () => {
    const local = [page("http://localhost:3000/", 3), page("file:///C:/docs/a.html", 9), page("https://user:pw@example.com/", 9)];
    expect(inlineMatch("localh", local, [], NOW)?.inline).toBe("ost:3000");
    expect(inlineMatch("file", local, [], NOW)).toBeNull();
    expect(inlineMatch("exa", local, [], NOW)).toBeNull();
  });
});

describe("suggestions with inline autocomplete", () => {
  const history = [page("https://edge.example.com/", 3, { title: "Edge admin" }), page("https://edge.example.com/login", 6, { title: "Edge login" })];

  it("puts the page filled in first and the typed intent second", () => {
    const s = buildSuggestions("edge", history, [], NOW, [], { inline: true });
    expect(s[0]).toMatchObject({ url: "https://edge.example.com/", inline: ".example.com" });
    expect(s[1]).toMatchObject({ kind: "search", detail: "Search with Corvus AI" });
    expect(s.filter((x) => x.url === "https://edge.example.com/")).toHaveLength(1);
    expect(s.map((x) => x.url)).toContain("https://edge.example.com/login");
  });

  it("keeps the typed intent first without inline autocomplete or with spaces around the text", () => {
    expect(buildSuggestions("edge", history, [], NOW)[0]?.kind).toBe("search");
    expect(buildSuggestions("edge ", history, [], NOW, [], { inline: true })[0]?.inline).toBeUndefined();
  });

  it("goes back to the typed intent first when the field cannot fill it in", () => {
    const s = buildSuggestions("edge", history, [], NOW, [], { inline: true });
    const plain = withoutInline(s);
    expect(plain[0]?.kind).toBe("search");
    expect(plain[1]).toMatchObject({ url: "https://edge.example.com/" });
    expect(plain[1]?.inline).toBeUndefined();
    expect(withoutInline(plain)).toEqual(plain);
  });
});

describe("keepCompletion", () => {
  it("keeps the rest filled in while the typed text still begins it", () => {
    expect(keepCompletion("edge.example.com", "edge.")).toBe("edge.example.com");
    expect(keepCompletion("edge.example.com", "EDGE.E")).toBe("EDGE.Example.com");
    expect(keepCompletion("edge.example.com", "edgy")).toBeNull();
    expect(keepCompletion("edge.example.com", "edge.example.com")).toBeNull();
    expect(keepCompletion(undefined, "edge")).toBeNull();
  });
});

describe("typed visits", () => {
  it("counts addresses typed in the address bar, kept through synced changes", () => {
    let list: HistoryRecord[] = [];
    list = recordVisit(list, { url: "https://a.test/", title: "A", typed: true }, "1", 1);
    list = recordVisit(list, { url: "https://a.test/", title: "A" }, "1", 2);
    list = recordVisit(list, { url: "https://a.test/", title: "A", typed: true }, "1", 3);
    expect(list[0]).toMatchObject({ visitCount: 3, typedCount: 2 });
    expect(toHistoryItem(list[0]!).typedCount).toBe(2);
    const synced = applySyncedHistory(list, [{ url: "https://a.test/", entry: { url: "https://a.test/", title: "A2", visitedAt: 9, visitCount: 7 } }], () => "x");
    expect(synced[0]).toMatchObject({ title: "A2", visitCount: 7, typedCount: 2 });
  });

  it("starts over for a page only known from another browser", () => {
    const live: HistoryRecord[] = [{ id: "1", url: "https://b.test/", title: "B", visitedAt: 1, visitCount: 9, source: "chrome" }];
    expect(recordVisit(live, { url: "https://b.test/", title: "B" }, "1", 2)[0]?.typedCount).toBeUndefined();
    expect(recordVisit(live, { url: "https://b.test/", title: "B", typed: true }, "1", 2)[0]).toMatchObject({ visitCount: 1, typedCount: 1 });
  });

  it("matches the site an address leads to, without www", () => {
    expect(addressSite("https://www.example.com/a")).toBe("example.com");
    expect(addressSite("http://localhost:8080/")).toBe("localhost:8080");
    expect(addressSite("corvus://search?q=x")).toBeNull();
  });
});
