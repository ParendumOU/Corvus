import { describe, expect, it } from "vitest";
import type { TabGroup } from "@corvus/shared";
import {
  activateTab,
  activeTabHidden,
  addTabsToGroup,
  computeDropTarget,
  createGroup,
  cycleTab,
  emptyStrip,
  insertTab,
  insertionIndexForChild,
  moveGroup,
  moveTab,
  nextGroupColor,
  pushClosed,
  removeGroup,
  removeTab,
  setPinned,
  tabByNumber,
  type TabStripState,
  ungroupTabs,
  updateGroup,
  visibleTabs,
} from "../src/shared/tab-strip";

const group = (id: string, extra: Partial<TabGroup> = {}): TabGroup => ({ id, title: id, color: "blue", collapsed: false, ...extra });

function strip(...ids: string[]): TabStripState {
  let s = emptyStrip();
  for (const id of ids) s = insertTab(s, { id, pinned: false });
  return activateTab(s, ids[0] ?? "");
}

const order = (s: TabStripState): string => s.tabs.map((t) => (t.groupId ? `${t.id}@${t.groupId}` : t.pinned ? `${t.id}*` : t.id)).join(" ");

describe("insert / remove / activate", () => {
  it("appends tabs and activates the first one automatically", () => {
    const s = insertTab(emptyStrip(), { id: "a", pinned: false });
    expect(s.activeId).toBe("a");
    const s2 = insertTab(s, { id: "b", pinned: false });
    expect(order(s2)).toBe("a b");
    expect(s2.activeId).toBe("a");
    expect(insertTab(s2, { id: "c", pinned: false }, { activate: true }).activeId).toBe("c");
  });

  it("ignores duplicate ids", () => {
    const s = strip("a", "b");
    expect(insertTab(s, { id: "a", pinned: false })).toBe(s);
  });

  it("inserts at an index and never before pinned tabs", () => {
    let s = strip("a", "b");
    s = setPinned(s, "b", true);
    s = insertTab(s, { id: "c", pinned: false }, { index: 0 });
    expect(order(s)).toBe("b* c a");
  });

  it("activates the right neighbour when closing the active tab, else the left one", () => {
    let s = activateTab(strip("a", "b", "c"), "b");
    s = removeTab(s, "b");
    expect(s.activeId).toBe("c");
    s = removeTab(s, "c");
    expect(s.activeId).toBe("a");
    s = removeTab(s, "a");
    expect(s.activeId).toBeNull();
    expect(s.tabs).toHaveLength(0);
  });

  it("keeps the active tab when closing a background tab", () => {
    const s = removeTab(activateTab(strip("a", "b", "c"), "c"), "a");
    expect(s.activeId).toBe("c");
  });

  it("places child tabs after the opener and its previous children", () => {
    let s = strip("a", "b");
    s = insertTab(s, { id: "c1", pinned: false, openerId: "a" }, { index: insertionIndexForChild(s, "a") });
    s = insertTab(s, { id: "c2", pinned: false, openerId: "a" }, { index: insertionIndexForChild(s, "a") });
    expect(order(s)).toBe("a c1 c2 b");
  });

  it("activating a tab inside a collapsed group expands it", () => {
    let s = createGroup(strip("a", "b"), ["b"], group("g", { collapsed: true }));
    s = activateTab(s, "b");
    expect(s.groups[0]?.collapsed).toBe(false);
  });
});

describe("pinning", () => {
  it("moves pinned tabs to the front, in pin order", () => {
    let s = strip("a", "b", "c");
    s = setPinned(s, "c", true);
    s = setPinned(s, "b", true);
    expect(order(s)).toBe("c* b* a");
  });

  it("unpinning places the tab right after the pinned area", () => {
    let s = setPinned(setPinned(strip("a", "b", "c"), "b", true), "c", true);
    s = setPinned(s, "b", false);
    expect(order(s)).toBe("c* b a");
  });

  it("pinning removes the tab from its group", () => {
    let s = createGroup(strip("a", "b"), ["a", "b"], group("g"));
    s = setPinned(s, "a", true);
    expect(order(s)).toBe("a* b@g");
  });
});

describe("groups", () => {
  it("creates a contiguous group anchored at the first selected tab", () => {
    const s = createGroup(strip("a", "b", "c", "d"), ["b", "d"], group("g"));
    expect(order(s)).toBe("a b@g d@g c");
    expect(s.groups.map((g) => g.id)).toEqual(["g"]);
  });

  it("refuses an empty selection or a duplicate group id", () => {
    const s = strip("a");
    expect(createGroup(s, ["zzz"], group("g"))).toBe(s);
    const g = createGroup(s, ["a"], group("g"));
    expect(createGroup(g, ["a"], group("g"))).toBe(g);
  });

  it("unpins tabs that join a group", () => {
    const s = createGroup(setPinned(strip("a", "b"), "b", true), ["b"], group("g"));
    expect(order(s)).toBe("b@g a");
  });

  it("adds tabs to the end of an existing group", () => {
    let s = createGroup(strip("a", "b", "c", "d"), ["a", "b"], group("g"));
    s = addTabsToGroup(s, ["d"], "g");
    expect(order(s)).toBe("a@g b@g d@g c");
  });

  it("ungrouping a tab puts it right after the group", () => {
    let s = createGroup(strip("a", "b", "c", "d"), ["a", "b", "c"], group("g"));
    s = ungroupTabs(s, ["a"]);
    expect(order(s)).toBe("b@g c@g a d");
  });

  it("removing a group keeps tab positions and drops the group", () => {
    let s = createGroup(strip("a", "b", "c"), ["b", "c"], group("g"));
    s = removeGroup(s, "g");
    expect(order(s)).toBe("a b c");
    expect(s.groups).toEqual([]);
  });

  it("drops a group when its last tab closes", () => {
    let s = createGroup(strip("a", "b"), ["b"], group("g"));
    s = removeTab(s, "b");
    expect(s.groups).toEqual([]);
  });

  it("renames and recolors", () => {
    let s = createGroup(strip("a"), ["a"], group("g"));
    s = updateGroup(s, "g", { title: "Research", color: "purple" });
    expect(s.groups[0]).toMatchObject({ title: "Research", color: "purple" });
    expect(updateGroup(s, "missing", { title: "x" })).toBe(s);
  });

  it("collapsing the group of the active tab activates a tab outside the group", () => {
    let s = createGroup(strip("a", "b", "c", "d"), ["b", "c"], group("g"));
    s = activateTab(s, "c");
    s = updateGroup(s, "g", { collapsed: true });
    expect(s.activeId).toBe("d");
    expect(visibleTabs(s).map((t) => t.id)).toEqual(["a", "d"]);
  });

  it("collapsing with no tab outside keeps the active tab and reports it hidden", () => {
    let s = createGroup(strip("a", "b"), ["a", "b"], group("g"));
    s = updateGroup(s, "g", { collapsed: true });
    expect(s.activeId).toBe("a");
    expect(activeTabHidden(s)).toBe(true);
  });

  it("picks unused colors first", () => {
    let s = createGroup(strip("a", "b"), ["a"], group("g1", { color: "grey" }));
    expect(nextGroupColor(s)).toBe("blue");
    s = createGroup(s, ["b"], group("g2", { color: "blue" }));
    expect(nextGroupColor(s)).toBe("red");
  });

  it("new tabs with a groupId land at the end of the group", () => {
    let s = createGroup(strip("a", "b", "c"), ["a", "b"], group("g"));
    s = insertTab(s, { id: "n", pinned: false, groupId: "g" });
    expect(order(s)).toBe("a@g b@g n@g c");
  });
});

describe("moving", () => {
  it("reorders tabs", () => {
    const s = moveTab(strip("a", "b", "c"), "a", 2);
    expect(order(s)).toBe("b c a");
  });

  it("moves a tab into a group and out again", () => {
    let s = createGroup(strip("a", "b", "c"), ["b", "c"], group("g"));
    s = moveTab(s, "a", 1, "g");
    expect(order(s)).toBe("b@g a@g c@g");
    s = moveTab(s, "a", 0);
    expect(order(s)).toBe("a@g b@g c@g");
    s = moveTab(s, "b", 2, null);
    expect(order(s)).toBe("a@g c@g b");
  });

  it("keeps groups contiguous when an ungrouped tab is dropped inside", () => {
    let s = createGroup(strip("a", "b", "c", "d"), ["a", "b", "c"], group("g"));
    s = moveTab(s, "d", 1, null);
    expect(order(s)).toBe("a@g b@g c@g d");
  });

  it("pinned tabs stay in the pinned area", () => {
    let s = setPinned(strip("a", "b", "c"), "a", true);
    s = moveTab(s, "a", 2);
    expect(order(s)).toBe("a* b c");
  });

  it("moves whole groups without splitting others", () => {
    let s = createGroup(strip("a", "b", "c", "d", "e"), ["a", "b"], group("g1"));
    s = createGroup(s, ["d", "e"], group("g2"));
    expect(order(s)).toBe("a@g1 b@g1 c d@g2 e@g2");
    const moved = moveGroup(s, "g1", 2);
    expect(order(moved)).toBe("c d@g2 e@g2 a@g1 b@g1");
    expect(order(moveGroup(s, "g2", 0))).toBe("d@g2 e@g2 a@g1 b@g1 c");
  });

  it("computes drop targets relative to the hovered tab", () => {
    let s = createGroup(strip("a", "b", "c", "d"), ["c", "d"], group("g"));
    expect(computeDropTarget(s, "a", "b", "after")).toEqual({ toIndex: 1, groupId: null });
    expect(computeDropTarget(s, "a", "d", "after")).toEqual({ toIndex: 3, groupId: "g" });
    expect(computeDropTarget(s, "d", "a", "before")).toEqual({ toIndex: 0, groupId: null });
    s = moveTab(s, "a", 3, "g");
    expect(order(s)).toBe("b c@g d@g a@g");
  });
});

describe("keyboard navigation", () => {
  it("cycles through visible tabs, skipping collapsed groups", () => {
    let s = createGroup(strip("a", "b", "c", "d"), ["b", "c"], group("g"));
    s = updateGroup(s, "g", { collapsed: true });
    expect(cycleTab(s, 1)).toBe("d");
    expect(cycleTab(activateTab(s, "d"), 1)).toBe("a");
    expect(cycleTab(s, -1)).toBe("d");
  });

  it("selects tabs by number, 9 = last", () => {
    const s = strip("a", "b", "c");
    expect(tabByNumber(s, 2)).toBe("b");
    expect(tabByNumber(s, 9)).toBe("c");
    expect(tabByNumber(s, 5)).toBeNull();
  });
});

describe("closed tab stack", () => {
  it("keeps the most recent entries", () => {
    let stack = pushClosed([], { url: "u1", title: "1", index: 0, pinned: false }, 2);
    stack = pushClosed(stack, { url: "u2", title: "2", index: 0, pinned: false }, 2);
    stack = pushClosed(stack, { url: "u3", title: "3", index: 0, pinned: false }, 2);
    expect(stack.map((x) => x.url)).toEqual(["u2", "u3"]);
  });
});
