import { describe, expect, it } from "vitest";
import type { TabGroup } from "@corvus/shared";
import { activateTab, createGroup, emptyStrip, insertTab, insertTabs, type TabStripState } from "../src/shared/tab-strip";
import { STRIP_MARGIN, stripRect, tearOffBounds, tearsOff } from "../src/shared/tab-tearoff";

const group = (id: string, extra: Partial<TabGroup> = {}): TabGroup => ({ id, title: id, color: "blue", collapsed: false, ...extra });

function strip(...ids: string[]): TabStripState {
  let s = emptyStrip();
  for (const id of ids) s = insertTab(s, { id, pinned: false });
  return activateTab(s, ids[0] ?? "");
}

const order = (s: TabStripState): string => s.tabs.map((t) => (t.groupId ? `${t.id}@${t.groupId}` : t.pinned ? `${t.id}*` : t.id)).join(" ");

describe("tearing tabs off their window", () => {
  const band = { x: 100, y: 50, width: 1200, height: 40 };

  it("let go away from the window's tab strip, they go to a new window", () => {
    expect(tearsOff({ x: 600, y: 400 }, band)).toBe(true);
    expect(tearsOff({ x: 2000, y: 60 }, band)).toBe(true);
    expect(tearsOff({ x: 600, y: 0 }, band)).toBe(true);
  });

  it("let go on or near the strip, the drag was given up", () => {
    expect(tearsOff({ x: 600, y: 70 }, band)).toBe(false);
    expect(tearsOff({ x: 600, y: 90 + STRIP_MARGIN }, band)).toBe(false);
    expect(tearsOff({ x: 100 - STRIP_MARGIN, y: 60 }, band)).toBe(false);
    expect(tearsOff({ x: 600, y: 91 + STRIP_MARGIN }, band)).toBe(true);
  });

  it("the new window keeps the old one's size, its first tab under the pointer", () => {
    expect(tearOffBounds({ x: 900, y: 500 }, { width: 1280, height: 840 })).toEqual({ x: 780, y: 482, width: 1280, height: 840 });
  });

  it("the strip is the band along the window's top, or its sidebar with vertical tabs", () => {
    const content = { x: 10, y: 20, width: 1000, height: 700 };
    expect(stripRect(content, { vertical: false, sidebarWidth: 240, stripHeight: 40 })).toEqual({ x: 10, y: 20, width: 1000, height: 40 });
    expect(stripRect(content, { vertical: true, sidebarWidth: 240, stripHeight: 40 })).toEqual({ x: 10, y: 20, width: 240, height: 700 });
  });
});

describe("tabs arriving from another window", () => {
  it("go together where they were dropped, without their old opener", () => {
    const s = insertTabs(strip("a", "b", "c"), [{ id: "x", pinned: false, openerId: "zz" }, { id: "y", pinned: false }], 1);
    expect(order(s)).toBe("a x y b c");
    expect(s.tabs.some((t) => t.openerId !== undefined)).toBe(false);
    expect(s.activeId).toBe("a");
  });

  it("join the group they are dropped in", () => {
    const s = createGroup(strip("a", "b", "c"), ["b", "c"], group("g"));
    expect(order(insertTabs(s, [{ id: "x", pinned: false, groupId: "old" }], 2, { joinGroup: "g" }))).toBe("a b@g x@g c@g");
  });

  it("bring along a group that moved whole, with its id, and leave behind one that did not", () => {
    const s = strip("a", "b");
    const moved = insertTabs(
      s,
      [
        { id: "x", pinned: false, groupId: "whole" },
        { id: "y", pinned: false, groupId: "whole" },
        { id: "z", pinned: false, groupId: "partial" },
      ],
      2,
      { groups: [group("whole", { title: "Trip", color: "red" })] },
    );
    expect(order(moved)).toBe("a b x@whole y@whole z");
    expect(moved.groups).toEqual([group("whole", { title: "Trip", color: "red" })]);
  });

  it("pinned ones stay pinned, first", () => {
    expect(order(insertTabs(strip("a", "b"), [{ id: "p", pinned: true }], 2))).toBe("p* a b");
  });

  it("a tab already in the strip is not added twice", () => {
    expect(order(insertTabs(strip("a", "b"), [{ id: "a", pinned: false }], 2))).toBe("a b");
  });
});
