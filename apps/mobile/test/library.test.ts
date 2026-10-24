import { isLinkOnly, isReadingItem, linkOnlyReadingItem, withReadState, type Bookmark } from "@corvus/shared";
import { describe, expect, it } from "vitest";
import { bookmarkList, folderContents, folderPath, nextPosition, readingList, searchBookmarks, searchReading } from "../src/lib/library";

const node = (id: string, parentId: string, kind: "folder" | "bookmark", title: string, position: number, url?: string): Bookmark => ({
  id,
  parentId,
  kind,
  title,
  position,
  createdAt: 1,
  updatedAt: 1,
  ...(url ? { url } : {}),
});

describe("bookmarks on the phone", () => {
  const records: Record<string, unknown> = {
    f1: node("f1", "bar", "folder", "Work", 1),
    b1: node("b1", "bar", "bookmark", "Corvus", 0, "https://corvus.example/"),
    b2: node("b2", "f1", "bookmark", "Tracker", 0, "https://tracker.example/board"),
    b3: node("b3", "other", "bookmark", "Recipes", 0, "https://food.example/"),
    broken: { id: "broken", parentId: null, kind: "bookmark" },
  };
  const bookmarks = bookmarkList(records);

  it("browses folders from the two roots", () => {
    expect(bookmarks.map((b) => b.id).sort()).toEqual(["b1", "b2", "b3", "f1"]);
    expect(folderContents(bookmarks, null).map((b) => b.title)).toEqual(["Bookmarks bar", "Other bookmarks"]);
    expect(folderContents(bookmarks, "bar").map((b) => b.title)).toEqual(["Corvus", "Work"]);
    expect(folderPath(bookmarks, "f1").map((b) => b.title)).toEqual(["Bookmarks bar", "Work"]);
    expect(folderPath(bookmarks, null)).toEqual([]);
  });

  it("finds bookmarks anywhere by title or address", () => {
    expect(searchBookmarks(bookmarks, "tracker board").map((b) => b.id)).toEqual(["b2"]);
    expect(searchBookmarks(bookmarks, "work")).toEqual([]);
    expect(searchBookmarks(bookmarks, " ")).toEqual([]);
  });

  it("adds a bookmark at the end of a folder", () => {
    expect(nextPosition(bookmarks, "bar")).toBe(2);
    expect(nextPosition(bookmarks, "other")).toBe(1);
    expect(nextPosition(bookmarks, "empty")).toBe(0);
  });
});

describe("reading list on the phone", () => {
  it("saves a link alone, which a computer fills in, and keeps the read state", () => {
    const item = linkOnlyReadingItem("id-1", "https://www.news.example/story", "", 10);
    expect(isReadingItem(item)).toBe(true);
    expect(isLinkOnly(item)).toBe(true);
    expect(item.siteName).toBe("news.example");
    const read = withReadState(item, 20);
    expect(read.readAt).toBe(20);
    expect("readAt" in withReadState(read, null)).toBe(false);
    expect(isReadingItem({ ...item, readAt: "yesterday" })).toBe(false);
  });

  it("lists unread first, newest first, and searches it", () => {
    const records = {
      "https://a.example/": withReadState(linkOnlyReadingItem("a", "https://a.example/", "Alpha", 30), 40),
      "https://b.example/": linkOnlyReadingItem("b", "https://b.example/", "Beta", 10),
      "https://c.example/": linkOnlyReadingItem("c", "https://c.example/", "Gamma ray", 20),
      "https://bad.example/": { id: "x" },
    };
    const list = readingList(records);
    expect(list.map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(searchReading(list, "ray").map((i) => i.id)).toEqual(["c"]);
    expect(searchReading(list, "")).toHaveLength(3);
  });
});
