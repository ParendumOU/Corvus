import type { GroupColor, TabGroup } from "@corvus/shared";

/**
 * chrome.tabGroups over Corvus's tab groups: Chrome's group shape (numeric ids, the window's id),
 * query, and the events a change between two snapshots amounts to. Corvus's colors are Chrome's.
 * Pure, for the main process and the tests.
 */
export const TAB_GROUP_ID_NONE = -1;

export interface ChromeTabGroup {
  id: number;
  collapsed: boolean;
  color: GroupColor;
  title: string;
  windowId: number;
}

/** A group as the window layer reports it: its numeric id, window, first tab's index and the window's tab count. */
export interface GroupPlacement {
  id: number;
  windowId: number;
  index: number;
  windowTabs: number;
  group: TabGroup;
}

export const toChromeGroup = (p: GroupPlacement): ChromeTabGroup => ({
  id: p.id,
  collapsed: p.group.collapsed,
  color: p.group.color,
  title: p.group.title,
  windowId: p.windowId,
});

export interface TabGroupQuery {
  collapsed?: boolean;
  color?: string;
  title?: string;
  windowId?: number;
}

/** chrome.tabGroups.query(): every property given must match (the title as a pattern with * wildcards). */
export function queryGroups(list: readonly GroupPlacement[], q: TabGroupQuery, currentWindowId?: number): ChromeTabGroup[] {
  const windowId = q.windowId === -2 ? currentWindowId : q.windowId;
  const title = q.title === undefined ? null : new RegExp(`^${q.title.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return list
    .filter((p) => (q.collapsed === undefined || p.group.collapsed === q.collapsed) && (q.color === undefined || p.group.color === q.color))
    .filter((p) => (windowId === undefined || p.windowId === windowId) && (!title || title.test(p.group.title)))
    .map(toChromeGroup);
}

export type ChromeTabGroupEvent = { event: "onCreated" | "onUpdated" | "onRemoved" | "onMoved"; group: ChromeTabGroup };

/**
 * The chrome.tabGroups events between two snapshots of every window's groups. A group moved when it
 * changed window, changed place among the window's groups, or changed index while the window kept
 * the same tabs (an index shifted by tabs opened or closed before it is not a move).
 */
export function groupEvents(before: readonly GroupPlacement[], after: readonly GroupPlacement[]): ChromeTabGroupEvent[] {
  const was = new Map(before.map((p) => [p.id, p]));
  const now = new Map(after.map((p) => [p.id, p]));
  const out: ChromeTabGroupEvent[] = [];
  for (const p of before) if (!now.has(p.id)) out.push({ event: "onRemoved", group: toChromeGroup(p) });
  for (const p of after) {
    const old = was.get(p.id);
    if (!old) {
      out.push({ event: "onCreated", group: toChromeGroup(p) });
      continue;
    }
    if (old.group.title !== p.group.title || old.group.color !== p.group.color || old.group.collapsed !== p.group.collapsed) {
      out.push({ event: "onUpdated", group: toChromeGroup(p) });
    }
    const rank = (list: readonly GroupPlacement[], x: GroupPlacement): number =>
      list.filter((o) => o.windowId === x.windowId).sort((a, b) => a.index - b.index).findIndex((o) => o.id === x.id);
    const moved =
      old.windowId !== p.windowId || rank(before, old) !== rank(after, p) || (old.index !== p.index && old.windowTabs === p.windowTabs);
    if (moved) out.push({ event: "onMoved", group: toChromeGroup(p) });
  }
  return out;
}
