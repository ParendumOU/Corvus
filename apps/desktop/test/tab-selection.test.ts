import { describe, expect, it } from "vitest";
import type { TabGroup } from "@corvus/shared";
import { activateTab, computeDropTarget, createGroup, emptyStrip, insertTab, moveTabsTogether, setPinned, updateGroup, type TabStripState } from "../src/shared/tab-strip";
import { actionTabs, clickSelection, emptySelection, selectedTabs, type TabSelection } from "../src/shared/tab-selection";

const group = (id: string, extra: Partial<TabGroup> = {}): TabGroup => ({ id, title: id, color: "blue", collapsed: false, ...extra });

function strip(...ids: string[]): TabStripState {
  let s = emptyStrip();
  for (const id of ids) s = insertTab(s, { id, pinned: false });
  return activateTab(s, ids[0] ?? "");
}

const order = (s: TabStripState): string => s.tabs.map((t) => (t.groupId ? `${t.id}@${t.groupId}` : t.pinned ? `${t.id}*` : t.id)).join(" ");

/** Applies a click like BrowserWindowCtl.selectTab does. */
function click(s: TabStripState, sel: TabSelection, id: string, mods = {}): { s: TabStripState; sel: TabSelection } {
  const result = clickSelection(s, sel, id, mods);
  return { s: result.activate ? activateTab(s, result.activate) : s, sel: result.selection };
}

describe("selecting several tabs", () => {
  it("is the active tab alone by default", () => {
    expect(selectedTabs(strip("a", "b", "c"), emptySelection())).toEqual(["a"]);
    expect(selectedTabs(emptyStrip(), emptySelection())).toEqual([]);
  });

  it("Ctrl+click adds a tab and makes it active; again takes it out", () => {
    let { s, sel } = click(strip("a", "b", "c", "d"), emptySelection(), "a");
    ({ s, sel } = click(s, sel, "c", { toggle: true }));
    expect(s.activeId).toBe("c");
    expect(selectedTabs(s, sel)).toEqual(["a", "c"]);
    ({ s, sel } = click(s, sel, "a", { toggle: true }));
    expect(s.activeId).toBe("c");
    expect(selectedTabs(s, sel)).toEqual(["c"]);
  });

  it("Ctrl+click on the active tab of several hands the active role to the nearest selected one", () => {
    let { s, sel } = click(strip("a", "b", "c", "d"), emptySelection(), "a");
    ({ s, sel } = click(s, sel, "b", { toggle: true }));
    ({ s, sel } = click(s, sel, "d", { toggle: true }));
    ({ s, sel } = click(s, sel, "d", { toggle: true }));
    expect(selectedTabs(s, sel)).toEqual(["a", "b"]);
    expect(s.activeId).toBe("b");
    ({ s, sel } = click(s, sel, "b", { toggle: true }));
    expect(s.activeId).toBe("a");
    expect(selectedTabs(s, sel)).toEqual(["a"]);
  });

  it("Ctrl+click on the only selected tab keeps it", () => {
    const s = strip("a", "b");
    const result = clickSelection(s, emptySelection(), "a", { toggle: true });
    expect(result.activate).toBeNull();
    expect(selectedTabs(s, result.selection)).toEqual(["a"]);
  });

  it("Shift+click picks the range from the active tab, either way", () => {
    let { s, sel } = click(strip("a", "b", "c", "d", "e"), emptySelection(), "b");
    ({ s, sel } = click(s, sel, "d", { range: true }));
    expect(selectedTabs(s, sel)).toEqual(["b", "c", "d"]);
    expect(s.activeId).toBe("d");
    // The range starts at the anchor (b), not at the new active tab.
    ({ s, sel } = click(s, sel, "a", { range: true }));
    expect(selectedTabs(s, sel)).toEqual(["a", "b"]);
  });

  it("Ctrl+Shift+click adds the range to the selection", () => {
    let { s, sel } = click(strip("a", "b", "c", "d", "e", "f"), emptySelection(), "a");
    ({ s, sel } = click(s, sel, "d", { toggle: true }));
    ({ s, sel } = click(s, sel, "f", { range: true, toggle: true }));
    expect(selectedTabs(s, sel)).toEqual(["a", "d", "e", "f"]);
  });

  it("a range skips the hidden tabs of a collapsed group", () => {
    let s = createGroup(strip("a", "b", "c", "d"), ["b", "c"], group("g"));
    s = updateGroup(s, "g", { collapsed: true });
    const result = clickSelection(s, emptySelection(), "d", { range: true });
    expect(selectedTabs(activateTab(s, "d"), result.selection)).toEqual(["a", "d"]);
  });

  it("a plain click picks one tab; a press on a selected one keeps the others for a drag", () => {
    let { s, sel } = click(strip("a", "b", "c"), emptySelection(), "a");
    ({ s, sel } = click(s, sel, "c", { range: true }));
    ({ s, sel } = click(s, sel, "b", { keep: true }));
    expect(s.activeId).toBe("b");
    expect(selectedTabs(s, sel)).toEqual(["a", "b", "c"]);
    ({ s, sel } = click(s, sel, "b"));
    expect(selectedTabs(s, sel)).toEqual(["b"]);
  });

  it("activating a tab outside the selection by other means leaves that tab alone selected", () => {
    let { s, sel } = click(strip("a", "b", "c"), emptySelection(), "a");
    ({ s, sel } = click(s, sel, "b", { toggle: true }));
    expect(selectedTabs(activateTab(s, "c"), sel)).toEqual(["c"]);
  });

  it("actions apply to the selection when the tab is one of it, else to the tab alone", () => {
    let { s, sel } = click(strip("a", "b", "c"), emptySelection(), "a");
    ({ s, sel } = click(s, sel, "b", { toggle: true }));
    expect(actionTabs(s, sel, "a")).toEqual(["a", "b"]);
    expect(actionTabs(s, sel, "c")).toEqual(["c"]);
  });
});

describe("moving selected tabs together", () => {
  it("moves them, in order, to where the dragged one lands", () => {
    const s = strip("a", "b", "c", "d", "e");
    const target = computeDropTarget(s, "b", "e", "after")!;
    expect(order(moveTabsTogether(s, ["a", "b"], "b", target.toIndex, target.groupId))).toBe("c d e a b");
    const front = computeDropTarget(s, "e", "a", "before")!;
    expect(order(moveTabsTogether(s, ["c", "e"], "e", front.toIndex, front.groupId))).toBe("c e a b d");
  });

  it("dropped among themselves, they gather there", () => {
    const s = strip("a", "b", "c", "d", "e");
    const target = computeDropTarget(s, "e", "c", "before")!;
    expect(order(moveTabsTogether(s, ["a", "c", "e"], "e", target.toIndex, target.groupId))).toBe("b a c e d");
  });

  it("join the group they are dropped in, or leave theirs", () => {
    const s = createGroup(strip("a", "b", "c", "d"), ["c", "d"], group("g"));
    const into = computeDropTarget(s, "b", "c", "after")!;
    expect(order(moveTabsTogether(s, ["a", "b"], "b", into.toIndex, into.groupId))).toBe("c@g a@g b@g d@g");
    expect(order(moveTabsTogether(s, ["c", "d"], "d", 0, null))).toBe("c d a b");
  });

  it("pinned tabs stay first", () => {
    const s = setPinned(strip("a", "b", "c"), "a", true);
    const target = computeDropTarget(s, "b", "c", "after")!;
    expect(order(moveTabsTogether(s, ["a", "b"], "b", target.toIndex, target.groupId))).toBe("a* c b");
  });

  it("one tab moves as moveTab does", () => {
    const s = strip("a", "b", "c");
    expect(order(moveTabsTogether(s, ["a"], "a", 2, null))).toBe("b c a");
  });
});
