import { describe, expect, it } from "vitest";
import type { TabGroup } from "@corvus/shared";
import {
  materializeWorkspace,
  removeWorkspace,
  renameWorkspace,
  reviveWorkspaces,
  summarize,
  upsertWorkspace,
  workspaceFromWindow,
  type LiveTab,
  type Workspace,
} from "../src/shared/workspaces";

const group = (id: string, extra: Partial<TabGroup> = {}): TabGroup => ({ id, title: id, color: "green", collapsed: false, ...extra });
const live = (url: string, extra: Partial<LiveTab> = {}): LiveTab => ({ url, title: url, pinned: false, ...extra });

describe("workspaceFromWindow", () => {
  it("saves restorable tabs and only the groups still in use", () => {
    const tabs = [
      live("https://a.com", { pinned: true }),
      live("https://b.com", { groupId: "G1" }),
      live("https://c.com", { groupId: "G1" }),
      live("corvus://chrome/"), // dropped: not restorable
    ];
    const ws = workspaceFromWindow("  Work  space  ", tabs, [group("G1"), group("G2")], "w1", 1000);
    expect(ws.name).toBe("Work space");
    expect(ws.tabs.map((t) => t.url)).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
    expect(ws.groups.map((g) => g.id)).toEqual(["G1"]);
    expect(summarize(ws)).toMatchObject({ tabCount: 3, groupCount: 1, name: "Work space" });
  });

  it("drops a group id from a pinned tab", () => {
    const ws = workspaceFromWindow("x", [live("https://a.com", { pinned: true, groupId: "G1" })], [group("G1")], "w", 1);
    expect(ws.tabs[0]?.groupId).toBeUndefined();
    expect(ws.groups).toEqual([]);
  });
});

describe("materializeWorkspace", () => {
  it("regenerates group ids and rewires tabs so merges never collide", () => {
    const ws = workspaceFromWindow("x", [live("https://a.com", { groupId: "G1" }), live("https://b.com", { groupId: "G1" })], [group("G1", { collapsed: true })], "w", 1);
    let n = 0;
    const out = materializeWorkspace(ws, () => `new${++n}`);
    expect(out.groups).toEqual([{ id: "new1", title: "G1", color: "green", collapsed: true }]);
    expect(out.tabs.every((t) => t.groupId === "new1")).toBe(true);
    // Two materializations are independent.
    const out2 = materializeWorkspace(ws, () => `other${++n}`);
    expect(out2.groups[0]?.id).not.toBe(out.groups[0]?.id);
  });
});

describe("reviveWorkspaces", () => {
  it("drops malformed entries, duplicate ids and empty workspaces", () => {
    const raw = [
      { id: "a", name: "A", tabs: [{ url: "https://a.com", title: "A", pinned: false }], groups: [] },
      { id: "a", name: "dup", tabs: [{ url: "https://x.com" }] }, // duplicate id
      { id: "b", name: "B", tabs: [{ url: "corvus://chrome/" }] }, // no restorable tab
      { id: "c" }, // no tabs
      "nonsense",
    ];
    const list = reviveWorkspaces(raw, 5);
    expect(list.map((w) => w.id)).toEqual(["a"]);
    expect(list[0]?.createdAt).toBe(5);
  });

  it("keeps only groups referenced by a tab and strips unknown group ids", () => {
    const list = reviveWorkspaces(
      [{ id: "a", name: "A", tabs: [{ url: "https://a.com", title: "A", pinned: false, groupId: "ghost" }], groups: [{ id: "G", title: "g", color: "red", collapsed: false }] }],
      1,
    );
    expect(list[0]?.groups).toEqual([]);
    expect(list[0]?.tabs[0]?.groupId).toBeUndefined();
  });
});

describe("list ops", () => {
  const base: Workspace = { id: "a", name: "A", createdAt: 1, updatedAt: 1, tabs: [{ url: "https://a.com", title: "A", pinned: false }], groups: [] };
  it("upsert replaces by id and appends new", () => {
    const one = upsertWorkspace([], base);
    expect(one).toHaveLength(1);
    const updated = upsertWorkspace(one, { ...base, name: "A2" });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe("A2");
    expect(upsertWorkspace(updated, { ...base, id: "b" })).toHaveLength(2);
  });
  it("rename and remove", () => {
    const renamed = renameWorkspace([base], "a", "  New  Name ", 9);
    expect(renamed[0]).toMatchObject({ name: "New Name", updatedAt: 9 });
    expect(removeWorkspace([base], "a")).toEqual([]);
  });
});
