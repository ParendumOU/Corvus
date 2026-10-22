/**
 * Pure render model for the tab strip, shared by the horizontal strip and the vertical sidebar.
 * Turns the ordered tab list + groups into a flat row list: a header row at the start of every
 * group, then the group's tabs, with tabs inside a collapsed group hidden (the active tab stays
 * visible so the user never loses their place). No React or Electron imports, so it is unit tested.
 */
import type { TabGroup } from "@corvus/shared";

export interface ViewTab {
  id: string;
  pinned: boolean;
  groupId?: string;
  active: boolean;
}

export interface GroupHeaderRow<T> {
  type: "group";
  group: TabGroup;
  /** Member tabs of the group (in order), regardless of collapse state. */
  members: T[];
}

export interface TabRow<T> {
  type: "tab";
  tab: T;
  group?: TabGroup;
  /** First rendered tab of its group (for indentation / rounding). */
  firstInGroup: boolean;
  /** Last rendered tab of its group. */
  lastInGroup: boolean;
}

export type StripRow<T> = GroupHeaderRow<T> | TabRow<T>;

/**
 * Build the ordered rows. A group header is emitted once, right before its first tab. Tabs of a
 * collapsed group are omitted unless they are the active tab.
 */
export function buildStripRows<T extends ViewTab>(tabs: readonly T[], groups: readonly TabGroup[]): StripRow<T>[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const rows: StripRow<T>[] = [];
  let currentGroup: string | undefined;
  let lastTabRow: TabRow<T> | null = null;

  for (const tab of tabs) {
    const group = tab.groupId ? byId.get(tab.groupId) : undefined;
    if (group && group.id !== currentGroup) {
      rows.push({ type: "group", group, members: tabs.filter((t) => t.groupId === group.id) });
    }
    if (!group) currentGroup = undefined;
    else currentGroup = group.id;

    if (group?.collapsed && !tab.active) continue;

    const row: TabRow<T> = { type: "tab", tab, ...(group ? { group } : {}), firstInGroup: false, lastInGroup: false };
    if (group) {
      const prevSameGroup = lastTabRow?.group?.id === group.id;
      row.firstInGroup = !prevSameGroup;
      if (prevSameGroup) lastTabRow!.lastInGroup = false;
      row.lastInGroup = true;
    }
    rows.push(row);
    lastTabRow = row;
  }
  return rows;
}

/** Visible (rendered) tabs, in order: the vertical/horizontal renderers and keyboard cycling agree. */
export function renderedTabs<T extends ViewTab>(tabs: readonly T[], groups: readonly TabGroup[]): T[] {
  return buildStripRows(tabs, groups).flatMap((r) => (r.type === "tab" ? [r.tab] : []));
}
