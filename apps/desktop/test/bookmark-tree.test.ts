import { describe, expect, it } from "vitest";
import type { Bookmark } from "@corvus/shared";
import {
  BAR_FOLDER_ID,
  BookmarkError,
  OTHER_FOLDER_ID,
  addNode,
  childrenOf,
  defaultTree,
  ensureRoots,
  findByUrl,
  moveNode,
  pathTo,
  removeNode,
  toTree,
  updateNode,
  upsertNode,
} from "../src/shared/bookmark-tree";

let seq = 0;
const id = (): string => `n${++seq}`;

function add(list: Bookmark[], parentId: string, kind: Bookmark["kind"], title: string, url?: string, index?: number): { list: Bookmark[]; id: string } {
  const nodeId = id();
  const res = addNode(list, { parentId, kind, title, url, index }, nodeId, 1000 + seq);
  return { list: res.list, id: nodeId };
}

const titles = (list: Bookmark[], parentId: string): string[] => childrenOf(list, parentId).map((b) => b.title);

describe("bookmark tree", () => {
  it("starts with the bar and other folders", () => {
    const tree = defaultTree(1);
    expect(tree.map((b) => b.id)).toEqual([BAR_FOLDER_ID, OTHER_FOLDER_ID]);
    expect(ensureRoots([], 1)).toHaveLength(2);
    expect(ensureRoots(tree, 1)).toBe(tree);
  });

  it("adds nodes at the end or at an index with contiguous positions", () => {
    let list = defaultTree(1);
    ({ list } = add(list, BAR_FOLDER_ID, "bookmark", "A", "https://a.test/"));
    ({ list } = add(list, BAR_FOLDER_ID, "bookmark", "C", "https://c.test/"));
    ({ list } = add(list, BAR_FOLDER_ID, "bookmark", "B", "https://b.test/", 1));
    expect(titles(list, BAR_FOLDER_ID)).toEqual(["A", "B", "C"]);
    expect(childrenOf(list, BAR_FOLDER_ID).map((b) => b.position)).toEqual([0, 1, 2]);
  });

  it("validates parents and URLs", () => {
    const list = defaultTree(1);
    expect(() => addNode(list, { parentId: "nope", kind: "folder", title: "x" }, "x", 1)).toThrow(BookmarkError);
    expect(() => addNode(list, { parentId: BAR_FOLDER_ID, kind: "bookmark", title: "x" }, "x", 1)).toThrow(/URL/);
    const { list: withBm, id: bm } = add(list, BAR_FOLDER_ID, "bookmark", "A", "https://a.test/");
    expect(() => addNode(withBm, { parentId: bm, kind: "folder", title: "x" }, "y", 1)).toThrow(/not a folder/);
  });

  it("defaults empty titles", () => {
    const { list, id: f } = add(defaultTree(1), BAR_FOLDER_ID, "folder", "  ");
    expect(list.find((b) => b.id === f)?.title).toBe("New folder");
  });

  it("updates titles and URLs but not roots", () => {
    let { list, id: bm } = add(defaultTree(1), BAR_FOLDER_ID, "bookmark", "A", "https://a.test/");
    list = updateNode(list, bm, { title: "Alpha", url: "https://alpha.test/" }, 5000);
    expect(list.find((b) => b.id === bm)).toMatchObject({ title: "Alpha", url: "https://alpha.test/", updatedAt: 5000 });
    expect(() => updateNode(list, BAR_FOLDER_ID, { title: "x" }, 1)).toThrow(/Root/);
  });

  it("moves nodes between folders and reindexes both sides", () => {
    let list = defaultTree(1);
    let f: string;
    let a: string;
    ({ list, id: f } = add(list, BAR_FOLDER_ID, "folder", "Folder"));
    ({ list, id: a } = add(list, BAR_FOLDER_ID, "bookmark", "A", "https://a.test/"));
    ({ list } = add(list, BAR_FOLDER_ID, "bookmark", "B", "https://b.test/"));
    list = moveNode(list, a, f, 0, 9);
    expect(titles(list, BAR_FOLDER_ID)).toEqual(["Folder", "B"]);
    expect(childrenOf(list, BAR_FOLDER_ID).map((b) => b.position)).toEqual([0, 1]);
    expect(titles(list, f)).toEqual(["A"]);
    expect(pathTo(list, a).map((b) => b.title)).toEqual(["Bookmarks bar", "Folder", "A"]);
  });

  it("reorders within the same folder", () => {
    let list = defaultTree(1);
    let a: string;
    ({ list, id: a } = add(list, OTHER_FOLDER_ID, "bookmark", "A", "https://a.test/"));
    ({ list } = add(list, OTHER_FOLDER_ID, "bookmark", "B", "https://b.test/"));
    ({ list } = add(list, OTHER_FOLDER_ID, "bookmark", "C", "https://c.test/"));
    list = moveNode(list, a, OTHER_FOLDER_ID, 2, 9);
    expect(titles(list, OTHER_FOLDER_ID)).toEqual(["B", "C", "A"]);
  });

  it("prevents cycles and moving roots", () => {
    let list = defaultTree(1);
    let outer: string;
    let inner: string;
    ({ list, id: outer } = add(list, BAR_FOLDER_ID, "folder", "Outer"));
    ({ list, id: inner } = add(list, outer, "folder", "Inner"));
    expect(() => moveNode(list, outer, inner, 0, 1)).toThrow(/itself/);
    expect(() => moveNode(list, outer, outer, 0, 1)).toThrow(/itself/);
    expect(() => moveNode(list, BAR_FOLDER_ID, OTHER_FOLDER_ID, 0, 1)).toThrow(/Root/);
  });

  it("removes whole subtrees and protects roots", () => {
    let list = defaultTree(1);
    let f: string;
    ({ list, id: f } = add(list, BAR_FOLDER_ID, "folder", "F"));
    ({ list } = add(list, f, "bookmark", "A", "https://a.test/"));
    ({ list } = add(list, BAR_FOLDER_ID, "bookmark", "Z", "https://z.test/"));
    const res = removeNode(list, f, 2);
    expect(res.removed).toHaveLength(2);
    expect(titles(res.list, BAR_FOLDER_ID)).toEqual(["Z"]);
    expect(childrenOf(res.list, BAR_FOLDER_ID)[0]?.position).toBe(0);
    expect(() => removeNode(list, OTHER_FOLDER_ID, 1)).toThrow(/Root/);
    expect(removeNode(list, "missing", 1).removed).toEqual([]);
  });

  it("finds bookmarks by URL ignoring hash and trailing slash", () => {
    const { list } = add(defaultTree(1), BAR_FOLDER_ID, "bookmark", "A", "https://a.test/page/");
    expect(findByUrl(list, "https://a.test/page#top")).toHaveLength(1);
    expect(findByUrl(list, "https://a.test/other")).toHaveLength(0);
  });

  it("builds a nested tree", () => {
    let list = defaultTree(1);
    let f: string;
    ({ list, id: f } = add(list, BAR_FOLDER_ID, "folder", "F"));
    ({ list } = add(list, f, "bookmark", "A", "https://a.test/"));
    const tree = toTree(list);
    expect(tree.map((n) => n.title)).toEqual(["Bookmarks bar", "Other bookmarks"]);
    expect(tree[0]?.children[0]?.children[0]?.title).toBe("A");
  });

  it("upserts synced nodes with last-writer-wins", () => {
    const base = defaultTree(1);
    const remote: Bookmark = { id: "r1", parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Remote", url: "https://r.test/", position: 0, createdAt: 10, updatedAt: 10 };
    let list = upsertNode(base, remote);
    expect(list.find((b) => b.id === "r1")?.title).toBe("Remote");
    list = upsertNode(list, { ...remote, title: "Older", updatedAt: 5 });
    expect(list.find((b) => b.id === "r1")?.title).toBe("Remote");
    expect(upsertNode(list, { ...base[0]!, title: "Hacked" })).toBe(list);
  });

  it("keeps synced nodes that arrive before their parent and refuses cycles", () => {
    const base = defaultTree(1);
    const child: Bookmark = { id: "c1", parentId: "f1", kind: "bookmark", title: "Child", url: "https://c.test/", position: 0, createdAt: 10, updatedAt: 10 };
    const folder: Bookmark = { id: "f1", parentId: BAR_FOLDER_ID, kind: "folder", title: "Folder", position: 0, createdAt: 10, updatedAt: 10 };
    let list = upsertNode(base, child);
    expect(list.some((b) => b.id === "c1")).toBe(true);
    expect(toTree(list)[0]?.children).toEqual([]);
    list = upsertNode(list, folder);
    expect(toTree(list)[0]?.children[0]?.children.map((n) => n.title)).toEqual(["Child"]);

    // A folder whose parent is (an orphan pointing back at) itself would form a cycle.
    const loop: Bookmark = { ...folder, id: "f2", parentId: "f3" };
    list = upsertNode(list, { ...folder, id: "f3", parentId: "f2" });
    expect(upsertNode(list, loop)).toBe(list);
    expect(upsertNode(list, { ...folder, parentId: "f1" })).toBe(list);
  });
});
