import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerExtensionApis } from "../src/main/extension-apis";
import type { RouterCallback } from "../src/main/extensions";
import { BookmarkStore, HistoryStore } from "../src/main/stores";
import { BAR_FOLDER_ID, OTHER_FOLDER_ID } from "../src/shared/bookmark-tree";
import { CHROME_ROOT_ID, bookmarkEvents, isBookmarkableUrl, searchBookmarks } from "../src/shared/chrome-bookmarks";
import { searchHistory } from "../src/shared/chrome-history";

const NOW = Date.UTC(2026, 9, 25, 12);
const HOUR = 60 * 60 * 1000;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-extapi-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the extension host: records handlers (with their permission) and events. */
function fakeHost() {
  const handlers = new Map<string, { cb: RouterCallback; permission?: string }>();
  const events: Array<{ permission: string; event: string; args: unknown[] }> = [];
  return {
    handlers,
    events,
    host: {
      handle: (name: string, cb: RouterCallback, permission?: string) => void handlers.set(name, { cb, ...(permission ? { permission } : {}) }),
      emit: (permission: string, event: string, ...args: unknown[]) => void events.push({ permission, event, args }),
    },
    call: async (name: string, ...args: unknown[]): Promise<unknown> => {
      const h = handlers.get(name);
      if (!h) throw new Error(`no handler ${name}`);
      return h.cb({ type: "frame" }, ...args);
    },
  };
}

describe("chrome.bookmarks for extensions", () => {
  it("answers in Chrome's shape under the invisible root, behind the bookmarks permission", async () => {
    const store = new BookmarkStore(dir);
    const api = fakeHost();
    registerExtensionApis(api.host, store, new HistoryStore(dir));
    expect([...api.handlers.entries()].filter(([n]) => n.startsWith("bookmarks.")).every(([, h]) => h.permission === "bookmarks")).toBe(true);
    const corvus = store.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Corvus", url: "https://corvus.example/" });

    const [root] = (await api.call("bookmarks.getTree")) as Array<{ id: string; children: Array<{ id: string; parentId: string; children: Array<{ id: string; url: string; index: number }> }> }>;
    expect(root!.id).toBe(CHROME_ROOT_ID);
    expect(root!.children.map((c) => c.id)).toEqual([BAR_FOLDER_ID, OTHER_FOLDER_ID]);
    expect(root!.children[0]!.parentId).toBe(CHROME_ROOT_ID);
    expect(root!.children[0]!.children[0]).toMatchObject({ id: corvus.id, url: "https://corvus.example/", index: 0 });
    expect(await api.call("bookmarks.get", corvus.id)).toEqual([expect.objectContaining({ id: corvus.id, parentId: BAR_FOLDER_ID, title: "Corvus" })]);
    await expect(api.call("bookmarks.get", "nope")).rejects.toThrow("Can't find bookmark for id.");
  });

  it("creates, updates, moves and removes like Chrome, and never touches the root folders", async () => {
    const store = new BookmarkStore(dir);
    const api = fakeHost();
    registerExtensionApis(api.host, store, new HistoryStore(dir));
    const folder = (await api.call("bookmarks.create", { title: "Reading" })) as { id: string; parentId: string; url?: string };
    expect(folder.parentId).toBe(OTHER_FOLDER_ID);
    expect(folder.url).toBeUndefined();
    const mark = (await api.call("bookmarks.create", { parentId: folder.id, title: "Ravens", url: "https://ravens.example/" })) as { id: string };
    await expect(api.call("bookmarks.create", { title: "x", url: "javascript:alert(1)" })).rejects.toThrow("Invalid URL.");

    expect(await api.call("bookmarks.update", mark.id, { title: "Ravens (birds)" })).toMatchObject({ title: "Ravens (birds)" });
    expect(await api.call("bookmarks.move", mark.id, { parentId: BAR_FOLDER_ID, index: 0 })).toMatchObject({ parentId: BAR_FOLDER_ID, index: 0 });
    expect((await api.call("bookmarks.search", "birds")) as unknown[]).toHaveLength(1);
    expect((await api.call("bookmarks.getRecent", 5)) as Array<{ id: string }>).toEqual([expect.objectContaining({ id: mark.id })]);

    await api.call("bookmarks.move", mark.id, { parentId: folder.id });
    await expect(api.call("bookmarks.remove", folder.id)).rejects.toThrow("Can't remove non-empty folder");
    await api.call("bookmarks.removeTree", folder.id);
    expect(store.get(mark.id)).toBeUndefined();
    await expect(api.call("bookmarks.remove", BAR_FOLDER_ID)).rejects.toThrow("Can't modify the root bookmark folders.");
    await expect(api.call("bookmarks.update", OTHER_FOLDER_ID, { title: "Mine" })).rejects.toThrow("root");
  });

  it("tells extensions about every change, whoever made it", () => {
    const store = new BookmarkStore(dir);
    const api = fakeHost();
    registerExtensionApis(api.host, store, new HistoryStore(dir));
    const a = store.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "A", url: "https://a.example/" });
    const folder = store.create({ parentId: OTHER_FOLDER_ID, kind: "folder", title: "F" });
    store.create({ parentId: folder.id, kind: "bookmark", title: "Inside", url: "https://in.example/" });
    store.update(a.id, { title: "A2" });
    store.move(a.id, folder.id);
    store.remove(folder.id);
    const names = api.events.map((e) => e.event);
    expect(names).toEqual(["bookmarks.onCreated", "bookmarks.onCreated", "bookmarks.onCreated", "bookmarks.onChanged", "bookmarks.onMoved", "bookmarks.onRemoved"]);
    expect(api.events.every((e) => e.permission === "bookmarks")).toBe(true);
    // A removed folder is one event, carrying its subtree.
    const removed = api.events.at(-1)!.args[1] as { parentId: string; node: { children: unknown[] } };
    expect(removed.parentId).toBe(OTHER_FOLDER_ID);
    expect(removed.node.children).toHaveLength(2);
  });
});

describe("chrome.bookmarks helpers", () => {
  it("reports a reorder inside a folder as onChildrenReordered", () => {
    const store = new BookmarkStore(dir);
    const one = store.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "1", url: "https://1.example/" });
    const two = store.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "2", url: "https://2.example/" });
    const before = store.list();
    store.move(two.id, BAR_FOLDER_ID, 0);
    expect(bookmarkEvents(before, store.list())).toEqual([{ event: "onChildrenReordered", args: [BAR_FOLDER_ID, { childIds: [two.id, one.id] }] }]);
  });

  it("searches by words, exact address or exact title, never the roots", () => {
    const store = new BookmarkStore(dir);
    store.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Raven facts", url: "https://birds.example/raven" });
    store.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Crow", url: "https://birds.example/crow" });
    expect(searchBookmarks(store.list(), "birds raven").map((b) => b.title)).toEqual(["Raven facts"]);
    expect(searchBookmarks(store.list(), { url: "https://birds.example/crow" }).map((b) => b.title)).toEqual(["Crow"]);
    expect(searchBookmarks(store.list(), { title: "Crow" })).toHaveLength(1);
    expect(searchBookmarks(store.list(), "").every((b) => b.id !== BAR_FOLDER_ID)).toBe(true);
    expect(["https://x.example/", "file:///tmp/a.html"].every(isBookmarkableUrl)).toBe(true);
    expect(["javascript:void 0", "data:text/html,x", "nonsense"].some(isBookmarkableUrl)).toBe(false);
  });
});

describe("chrome.history for extensions", () => {
  it("searches the last day by default, by words, newest first", () => {
    const list = [
      { id: "1", url: "https://ravens.example/", title: "Ravens", visitedAt: NOW - HOUR, visitCount: 3 },
      { id: "2", url: "https://crows.example/", title: "Crows", visitedAt: NOW - 2 * HOUR, visitCount: 1 },
      { id: "3", url: "https://old.example/", title: "Old ravens", visitedAt: NOW - 48 * HOUR, visitCount: 9 },
    ];
    expect(searchHistory(list, {}, NOW).map((i) => i.id)).toEqual(["1", "2"]);
    expect(searchHistory(list, { text: "ravens" }, NOW).map((i) => i.id)).toEqual(["1"]);
    expect(searchHistory(list, { text: "ravens", startTime: 0 }, NOW).map((i) => i.id)).toEqual(["1", "3"]);
    expect(searchHistory(list, { startTime: 0, maxResults: 1 }, NOW)).toEqual([{ id: "1", url: "https://ravens.example/", title: "Ravens", lastVisitTime: NOW - HOUR, visitCount: 3, typedCount: 0 }]);
  });

  it("adds, lists visits and deletes through the profile's history, with events", async () => {
    const history = new HistoryStore(dir);
    const api = fakeHost();
    registerExtensionApis(api.host, new BookmarkStore(dir), history, () => Date.now());
    expect([...api.handlers.entries()].filter(([n]) => n.startsWith("history.")).every(([, h]) => h.permission === "history")).toBe(true);
    await api.call("history.addUrl", { url: "https://ravens.example/" });
    history.recordVisit("https://crows.example/", "Crows");
    expect(((await api.call("history.search", { text: "" })) as Array<{ url: string }>).map((i) => i.url)).toEqual(["https://crows.example/", "https://ravens.example/"]);
    expect(await api.call("history.getVisits", { url: "https://crows.example/" })).toEqual([expect.objectContaining({ transition: "link" })]);
    await expect(api.call("history.addUrl", { url: "javascript:alert(1)" })).rejects.toThrow("Invalid URL.");
    await api.call("history.deleteUrl", { url: "https://ravens.example/" });
    expect(history.all().map((e) => e.url)).toEqual(["https://crows.example/"]);
    await api.call("history.deleteAll");
    expect(history.all()).toEqual([]);
    expect(api.events.map((e) => e.event)).toEqual(["history.onVisited", "history.onVisited", "history.onVisitRemoved", "history.onVisitRemoved"]);
    expect(api.events.at(-2)!.args[0]).toEqual({ allHistory: false, urls: ["https://ravens.example/"] });
    expect(api.events.at(-1)!.args[0]).toEqual({ allHistory: true, urls: [] });
  });

  it("answers chrome.topSites with the most visited sites, behind the topSites permission", async () => {
    const history = new HistoryStore(dir);
    const api = fakeHost();
    registerExtensionApis(api.host, new BookmarkStore(dir), history);
    expect(api.handlers.get("topSites.get")?.permission).toBe("topSites");
    history.recordVisit("https://ravens.example/", "Ravens");
    history.recordVisit("https://ravens.example/", "Ravens");
    history.recordVisit("https://crows.example/", "Crows");
    expect(await api.call("topSites.get")).toEqual([
      { url: "https://ravens.example/", title: "Ravens" },
      { url: "https://crows.example/", title: "Crows" },
    ]);
  });
});
