import { describe, expect, it } from "vitest";
import type { TabGroup } from "@corvus/shared";
import { buildStripRows, groupsNeedingYou, renderedTabs, type ViewTab } from "../src/shared/tab-strip-view";

const g = (id: string, extra: Partial<TabGroup> = {}): TabGroup => ({ id, title: id, color: "blue", collapsed: false, ...extra });
const t = (id: string, extra: Partial<ViewTab & { needsYou: boolean }> = {}): ViewTab & { needsYou?: boolean } => ({ id, pinned: false, active: false, ...extra });

const shape = (rows: ReturnType<typeof buildStripRows<ViewTab>>): string =>
  rows.map((r) => (r.type === "group" ? `[${r.group.id}:${r.members.length}]` : r.tab.id + (r.firstInGroup ? "{" : "") + (r.lastInGroup ? "}" : ""))).join(" ");

describe("buildStripRows", () => {
  it("emits plain tab rows for ungrouped tabs", () => {
    const rows = buildStripRows([t("a"), t("b"), t("c")], []);
    expect(shape(rows)).toBe("a b c");
  });

  it("emits one header before the first tab of a group and marks first/last", () => {
    const rows = buildStripRows([t("a"), t("b", { groupId: "G" }), t("c", { groupId: "G" }), t("d")], [g("G")]);
    expect(shape(rows)).toBe("a [G:2] b{ c} d");
  });

  it("hides tabs of a collapsed group but keeps the header and the active member", () => {
    const rows = buildStripRows([t("a", { groupId: "G" }), t("b", { groupId: "G", active: true }), t("c")], [g("G", { collapsed: true })]);
    expect(shape(rows)).toBe("[G:2] b{} c");
  });

  it("drops the header's tabs entirely when the collapsed group holds no active tab", () => {
    const rows = buildStripRows([t("a", { groupId: "G" }), t("b", { groupId: "G" }), t("c", { active: true })], [g("G", { collapsed: true })]);
    expect(shape(rows)).toBe("[G:2] c");
  });

  it("pinned tabs render before groups with no header", () => {
    const rows = buildStripRows([t("p", { pinned: true }), t("a", { groupId: "G" })], [g("G")]);
    expect(shape(rows)).toBe("p [G:1] a{}");
  });

  it("renderedTabs matches the visible order and skips collapsed members", () => {
    const tabs = [t("a", { groupId: "G" }), t("b", { groupId: "G" }), t("c")];
    expect(renderedTabs(tabs, [g("G", { collapsed: true })]).map((x) => x.id)).toEqual(["c"]);
    expect(renderedTabs(tabs, [g("G")]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("is identical regardless of orientation (pure data)", () => {
    const tabs = [t("a"), t("b", { groupId: "G" }), t("c", { groupId: "G" })];
    const groups = [g("G")];
    expect(buildStripRows(tabs, groups)).toEqual(buildStripRows(tabs, groups));
  });
});

describe("groupsNeedingYou", () => {
  it("names collapsed groups hiding a tab an AI agent waits in", () => {
    const groups = [g("A", { collapsed: true }), g("B"), g("C", { collapsed: true }), g("D", { collapsed: true })];
    const tabs = [
      t("a", { groupId: "A", needsYou: true }),
      t("b", { groupId: "B", needsYou: true }),
      // A collapsed group still shows its active tab: that tab is lit, not the group.
      t("c", { groupId: "C", needsYou: true, active: true }),
      t("d", { groupId: "D" }),
      t("e", { needsYou: true }),
    ];
    expect([...groupsNeedingYou(tabs, groups)]).toEqual(["A"]);
    expect(groupsNeedingYou(tabs.map((x) => ({ ...x, needsYou: false })), groups).size).toBe(0);
  });
});
