import { describe, expect, it } from "vitest";
import { historyMatching, typedSite, type HistoryRecord } from "../src/shared/history-ops";

const entry = (id: string, url: string, visitedAt: number, title = ""): HistoryRecord => ({ id, url, title, visitedAt, visitCount: 1 }) as HistoryRecord;

describe("clearing history by range, search and site", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const list = [
    entry("a", "https://www.example.com/a", now - 30 * 60 * 1000, "Example A"),
    entry("b", "https://shop.example.com/cart", now - 3 * 24 * 60 * 60 * 1000, "Cart"),
    entry("c", "https://news.test/today", now - 2 * 60 * 60 * 1000, "Example news"),
    entry("d", "https://notexample.com/", now - 60 * 1000, "Other"),
  ];

  it("reads a typed site", () => {
    expect(typedSite("https://www.Example.com/x")).toBe("example.com");
    expect(typedSite("shop.example.com")).toBe("shop.example.com");
    expect(typedSite("not a site")).toBe("");
    expect(typedSite("")).toBe("");
  });

  it("keeps to a time range, a search and a site with its subdomains", () => {
    const ids = (f: Parameters<typeof historyMatching>[1]): string[] => historyMatching(list, f).map((e) => e.id).sort();
    expect(ids({ since: now - 60 * 60 * 1000 })).toEqual(["a", "d"]);
    expect(ids({ query: "cart" })).toEqual(["b"]);
    expect(ids({ query: "example news" })).toEqual(["c"]);
    expect(ids({ site: "example.com" })).toEqual(["a", "b"]);
    expect(ids({ site: "example.com", since: now - 24 * 60 * 60 * 1000 })).toEqual(["a"]);
    expect(ids({})).toEqual(["a", "b", "c", "d"]);
  });
});
