import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { replacesUnfiltered } from "../src/main/adblock-lists";
import { downloadList, latestRevision, latestRevisions, type ListFetch } from "../src/main/adblock-sources";

const a = "a".repeat(64);
const b = "b".repeat(64);
const base = "https://cdn.ghostery.com/adblocker/resources";
const serving =
  (pages: Record<string, string>): ListFetch =>
  async (url) => ({ ok: url in pages, status: url in pages ? 200 : 404, text: async () => pages[url] ?? "" });

describe("filter list sources", () => {
  it("takes the newest revision a list names", () => {
    expect(latestRevision(JSON.stringify({ revisions: [a, b] }))).toBe(b);
  });

  it("refuses metadata without a usable revision (it becomes part of an address)", () => {
    for (const bad of [{}, { revisions: [] }, { revisions: ["../../evil"] }, { revisions: [1] }]) {
      expect(() => latestRevision(JSON.stringify(bad))).toThrow();
    }
    expect(() => latestRevision("<html>")).toThrow();
  });

  it("asks for each list's revision, in order, and fails when one is missing", async () => {
    const pages = { [`${base}/one/metadata.json`]: JSON.stringify({ revisions: [a] }), [`${base}/two/metadata.json`]: JSON.stringify({ revisions: [a, b] }) };
    await expect(latestRevisions(serving(pages), ["one", "two"])).resolves.toEqual([a, b]);
    await expect(latestRevisions(serving(pages), ["one", "three"])).rejects.toThrow("HTTP 404");
  });

  it("downloads one revision and treats an error page or an empty list as a failure", async () => {
    const pages = { [`${base}/one/${a}/list.txt`]: "||ads.example^", [`${base}/empty/${a}/list.txt`]: " \n" };
    await expect(downloadList(serving(pages), "one", a)).resolves.toBe("||ads.example^");
    await expect(downloadList(serving(pages), "empty", a)).rejects.toThrow("empty list");
    await expect(downloadList(serving(pages), "gone", a)).rejects.toThrow("HTTP 404");
  });
});

describe("a new engine over one that barely filtered", () => {
  it("is the first run or a change of list set, not a daily update", () => {
    expect(replacesUnfiltered({ source: "bundled" }, "set")).toBe(true);
    expect(replacesUnfiltered({ source: "cache", lists: "old-set" }, "set")).toBe(true);
    expect(replacesUnfiltered({ source: "cache", lists: "set" }, "set")).toBe(false);
    expect(replacesUnfiltered({ source: "network", lists: "set" }, "set")).toBe(false);
  });
});
