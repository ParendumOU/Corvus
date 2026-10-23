import { describe, expect, it } from "vitest";
import type { TabGroup } from "@corvus/shared";
import {
  isWorkspaceTabUrl,
  nextWorkspaceName,
  removeWorkspace,
  renameWorkspace,
  reviveWorkspace,
  reviveWorkspaces,
  summarize,
  updateWorkspaceTabs,
  upsertWorkspace,
  workspaceFromGroup,
  workspaceFromWindow,
  workspaceOpenPlan,
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
      live("corvus://newtab/"), // dropped: an empty new tab is not worth saving
    ];
    const ws = workspaceFromWindow("  Work  space  ", tabs, [group("G1"), group("G2")], "w1", 1000);
    expect(ws.name).toBe("Work space");
    expect(ws.tabs.map((t) => t.url)).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
    expect(ws.groups.map((g) => g.id)).toEqual(["G1"]);
    expect(summarize(ws)).toEqual({ id: "w1", name: "Work space", createdAt: 1000, updatedAt: 1000, tabCount: 3 });
  });

  it("drops a group id from a pinned tab", () => {
    const ws = workspaceFromWindow("x", [live("https://a.com", { pinned: true, groupId: "G1" })], [group("G1")], "w", 1);
    expect(ws.tabs[0]?.groupId).toBeUndefined();
    expect(ws.groups).toEqual([]);
  });
});

describe("isWorkspaceTabUrl", () => {
  it("keeps pages worth reopening, not new tab pages or the browser UI", () => {
    expect(isWorkspaceTabUrl("https://a.com/")).toBe(true);
    expect(isWorkspaceTabUrl("corvus://settings/")).toBe(true);
    expect(isWorkspaceTabUrl("corvus://newtab/")).toBe(false);
    expect(isWorkspaceTabUrl("corvus://chrome/")).toBe(false);
    expect(isWorkspaceTabUrl("about:blank")).toBe(false);
  });
});

describe("workspaceFromGroup / updateWorkspaceTabs", () => {
  it("stores a group's tabs as one group named after the workspace, keeping its color", () => {
    const tabs = [live("https://a.com", { pinned: true }), live("corvus://newtab/"), live("https://b.com", { groupId: "Gx" })];
    const ws = workspaceFromGroup("  Research ", tabs, "purple", "w", 5);
    expect(ws).toMatchObject({ id: "w", name: "Research", createdAt: 5, updatedAt: 5 });
    expect(ws.tabs).toEqual([
      { url: "https://a.com", title: "https://a.com", pinned: false, groupId: "g1" },
      { url: "https://b.com", title: "https://b.com", pinned: false, groupId: "g1" },
    ]);
    expect(ws.groups).toEqual([{ id: "g1", title: "Research", color: "purple", collapsed: false }]);
    // Round-trips through the stored/synced format unchanged.
    expect(reviveWorkspace(JSON.parse(JSON.stringify(ws)), 9)).toEqual(ws);
  });

  it("re-saves a workspace with new tabs, keeping its id, name and creation time", () => {
    const ws = workspaceFromGroup("Research", [live("https://a.com")], "blue", "w", 5);
    const next = updateWorkspaceTabs(ws, [live("https://b.com"), live("https://c.com")], "red", 20);
    expect(next).toMatchObject({ id: "w", name: "Research", createdAt: 5, updatedAt: 20 });
    expect(next.tabs.map((t) => t.url)).toEqual(["https://b.com", "https://c.com"]);
    expect(next.groups[0]?.color).toBe("red");
  });

  it("an empty group yields an empty workspace (the store refuses to save it)", () => {
    expect(workspaceFromGroup("x", [live("corvus://newtab/")], "grey", "w", 1).tabs).toEqual([]);
  });
});

describe("nextWorkspaceName", () => {
  it("picks the first free default name", () => {
    expect(nextWorkspaceName([])).toBe("Workspace");
    expect(nextWorkspaceName(["Workspace", "workspace 2", "Other"])).toBe("Workspace 3");
  });
});

describe("workspaceOpenPlan", () => {
  it("flattens every saved tab into one group named after the workspace, in saved order", () => {
    // A workspace saved by an older version: pinned + two groups + an ungrouped tab.
    const legacy = reviveWorkspace(
      {
        id: "old",
        name: "Trip",
        tabs: [
          { url: "https://pinned.com", title: "P", pinned: true },
          { url: "https://a.com", title: "A", pinned: false, groupId: "G1" },
          { url: "https://b.com", title: "B", pinned: false },
          { url: "https://c.com", title: "C", pinned: false, groupId: "G2" },
        ],
        groups: [
          { id: "G1", title: "Flights", color: "cyan", collapsed: true },
          { id: "G2", title: "Hotels", color: "red", collapsed: false },
        ],
      },
      1,
    );
    expect(legacy).not.toBeNull();
    const plan = workspaceOpenPlan(legacy as Workspace);
    expect(plan.title).toBe("Trip");
    expect(plan.color).toBe("cyan");
    expect(plan.tabs).toEqual([
      { url: "https://pinned.com", title: "P" },
      { url: "https://a.com", title: "A" },
      { url: "https://b.com", title: "B" },
      { url: "https://c.com", title: "C" },
    ]);
  });

  it("leaves the color to the window when nothing was grouped", () => {
    const ws = workspaceFromWindow("x", [live("https://a.com")], [], "w", 1);
    expect(workspaceOpenPlan(ws).color).toBeUndefined();
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
