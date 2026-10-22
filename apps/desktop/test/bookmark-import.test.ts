import { describe, expect, it } from "vitest";
import {
  countBookmarks,
  countFolders,
  isImportedFolder,
  parseBookmarkFile,
  parseChromeJson,
  parseNetscapeHtml,
  type ImportedFolder,
} from "../src/shared/bookmark-import";

const NETSCAPE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><A HREF="https://example.com/" ADD_DATE="1700000000">Example &amp; Co</A>
    <DT><H3 ADD_DATE="1700000001">News</H3>
    <DL><p>
        <DT><A HREF="https://news.example.org/world">World &lt;news&gt;</A>
        <DT><H3>Tech</H3>
        <DL><p>
            <DT><A HREF="https://tech.example.org/">Tech</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="javascript:void(0)">Bad bookmarklet</A>
</DL><p>`;

describe("parseNetscapeHtml", () => {
  it("parses a nested Netscape export and decodes entities", () => {
    const tree = parseNetscapeHtml(NETSCAPE);
    const top = tree.filter((n) => !isImportedFolder(n));
    expect(top.map((n) => (isImportedFolder(n) ? "" : n.title))).toContain("Example & Co");

    const news = tree.find((n): n is ImportedFolder => isImportedFolder(n) && n.title === "News");
    expect(news).toBeDefined();
    const worldLink = news!.children.find((n) => !isImportedFolder(n));
    expect(worldLink && !isImportedFolder(worldLink) ? worldLink.title : null).toBe("World <news>");

    const tech = news!.children.find((n): n is ImportedFolder => isImportedFolder(n) && n.title === "Tech");
    expect(tech).toBeDefined();
    expect(tech!.children).toHaveLength(1);
  });

  it("counts leaves and folders across nesting", () => {
    const tree = parseNetscapeHtml(NETSCAPE);
    expect(countBookmarks(tree)).toBe(4);
    expect(countFolders(tree)).toBe(2);
  });
});

const CHROME_JSON = JSON.stringify({
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "Bookmarks bar",
      children: [
        { type: "url", name: "Example", url: "https://example.com/" },
        { type: "folder", name: "Work", children: [{ type: "url", name: "Docs", url: "https://docs.example.com/" }] },
      ],
    },
    other: { type: "folder", name: "Other bookmarks", children: [{ type: "url", name: "Blog", url: "https://blog.example.com/" }] },
    synced: { type: "folder", name: "Mobile", children: [] },
  },
});

describe("parseChromeJson", () => {
  it("flattens the roots and keeps nested folders", () => {
    const tree = parseChromeJson(CHROME_JSON);
    expect(countBookmarks(tree)).toBe(3);
    const work = tree.find((n): n is ImportedFolder => isImportedFolder(n) && n.title === "Work");
    expect(work?.children).toHaveLength(1);
  });

  it("returns empty on malformed JSON", () => {
    expect(parseChromeJson("{not json")).toEqual([]);
    expect(parseChromeJson("{}")).toEqual([]);
  });
});

describe("parseBookmarkFile dispatch", () => {
  it("routes .json and brace-leading content to the Chrome parser", () => {
    expect(countBookmarks(parseBookmarkFile("Bookmarks", CHROME_JSON))).toBe(3);
    expect(countBookmarks(parseBookmarkFile("export.json", CHROME_JSON))).toBe(3);
  });
  it("routes HTML to the Netscape parser", () => {
    expect(countBookmarks(parseBookmarkFile("bookmarks.html", NETSCAPE))).toBe(4);
  });
});
