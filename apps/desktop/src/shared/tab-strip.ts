/**
 * Pure tab strip model: tab order, pinning, groups and activation. No Electron imports, so the
 * rules can be unit tested. Invariants maintained by normalize():
 *   - pinned tabs come first and never belong to a group
 *   - tabs of a group are contiguous
 *   - groups without tabs are dropped
 */
import type { GroupColor, GroupId, TabGroup, TabId } from "@corvus/shared";

export interface StripTab {
  id: TabId;
  pinned: boolean;
  groupId?: GroupId;
  openerId?: TabId;
}

export interface TabStripState {
  tabs: StripTab[];
  groups: TabGroup[];
  activeId: TabId | null;
}

export const GROUP_COLORS: readonly GroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

export function emptyStrip(): TabStripState {
  return { tabs: [], groups: [], activeId: null };
}

function withoutGroup(tab: StripTab): StripTab {
  const { groupId: _dropped, ...rest } = tab;
  return rest;
}

function normalize(state: TabStripState): TabStripState {
  const knownGroups = new Set(state.groups.map((g) => g.id));
  const cleaned = state.tabs.map((t) =>
    t.groupId !== undefined && (t.pinned || !knownGroups.has(t.groupId)) ? withoutGroup(t) : t,
  );
  const pinned = cleaned.filter((t) => t.pinned);
  const unpinned = cleaned.filter((t) => !t.pinned);

  const ordered: StripTab[] = [...pinned];
  const placed = new Set<GroupId>();
  for (const tab of unpinned) {
    if (tab.groupId === undefined) {
      ordered.push(tab);
      continue;
    }
    if (placed.has(tab.groupId)) continue;
    placed.add(tab.groupId);
    const gid = tab.groupId;
    ordered.push(...unpinned.filter((t) => t.groupId === gid));
  }

  const groups = state.groups.filter((g) => placed.has(g.id));
  const activeId = state.activeId !== null && ordered.some((t) => t.id === state.activeId) ? state.activeId : null;
  return { tabs: ordered, groups, activeId };
}

export function indexOfTab(state: TabStripState, id: TabId): number {
  return state.tabs.findIndex((t) => t.id === id);
}

export function getGroup(state: TabStripState, id: GroupId): TabGroup | undefined {
  return state.groups.find((g) => g.id === id);
}

export function tabsInGroup(state: TabStripState, groupId: GroupId): StripTab[] {
  return state.tabs.filter((t) => t.groupId === groupId);
}

function isHidden(state: TabStripState, tab: StripTab): boolean {
  if (tab.groupId === undefined) return false;
  return getGroup(state, tab.groupId)?.collapsed === true;
}

/** Tabs that are rendered (not inside a collapsed group). */
export function visibleTabs(state: TabStripState): StripTab[] {
  return state.tabs.filter((t) => !isHidden(state, t) || t.id === state.activeId);
}

/** Where a tab opened from `openerId` goes: right after the opener and its previous children. */
export function insertionIndexForChild(state: TabStripState, openerId: TabId): number {
  const openerIdx = indexOfTab(state, openerId);
  if (openerIdx === -1) return state.tabs.length;
  let idx = openerIdx + 1;
  while (idx < state.tabs.length && state.tabs[idx]?.openerId === openerId) idx++;
  return idx;
}

export interface InsertOptions {
  index?: number;
  activate?: boolean;
}

export function insertTab(state: TabStripState, tab: StripTab, opts: InsertOptions = {}): TabStripState {
  if (indexOfTab(state, tab.id) !== -1) return state;
  const tabs = [...state.tabs];
  let index = opts.index ?? tabs.length;
  if (opts.index === undefined && tab.groupId !== undefined) {
    const last = tabs.map((t) => t.groupId).lastIndexOf(tab.groupId);
    if (last !== -1) index = last + 1;
  }
  index = Math.max(0, Math.min(index, tabs.length));
  tabs.splice(index, 0, tab);
  const next = normalize({ ...state, tabs });
  return opts.activate || next.activeId === null ? activateTab(next, tab.id) : next;
}

/** Pick the tab that becomes active when the tab at `removedIndex` goes away. */
function pickNeighbor(state: TabStripState, removedIndex: number, avoidGroup?: GroupId): TabId | null {
  const candidates = state.tabs.map((t, i) => ({ t, i }));
  const usable = (t: StripTab): boolean => !isHidden(state, t) && (avoidGroup === undefined || t.groupId !== avoidGroup);
  const right = candidates.find(({ t, i }) => i >= removedIndex && usable(t));
  if (right) return right.t.id;
  const left = [...candidates].reverse().find(({ t, i }) => i < removedIndex && usable(t));
  if (left) return left.t.id;
  return null;
}

export function removeTab(state: TabStripState, id: TabId): TabStripState {
  const idx = indexOfTab(state, id);
  if (idx === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== id).map((t) => (t.openerId === id ? { ...t, openerId: undefined } : t));
  let next: TabStripState = { ...state, tabs };
  if (state.activeId === id) {
    const neighbor = pickNeighbor(next, idx) ?? tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
    next = { ...next, activeId: neighbor };
  }
  next = normalize(next);
  return next.activeId !== null ? activateTab(next, next.activeId) : next;
}

export function activateTab(state: TabStripState, id: TabId): TabStripState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return state;
  const groups =
    tab.groupId !== undefined
      ? state.groups.map((g) => (g.id === tab.groupId && g.collapsed ? { ...g, collapsed: false } : g))
      : state.groups;
  return { ...state, groups, activeId: id };
}

/**
 * Move a tab to `toIndex` (index in the resulting strip).
 * groupId: string = join that group, null = leave any group, undefined = keep current group.
 */
export function moveTab(state: TabStripState, id: TabId, toIndex: number, groupId?: GroupId | null): TabStripState {
  const idx = indexOfTab(state, id);
  if (idx === -1) return state;
  const tabs = [...state.tabs];
  const [removed] = tabs.splice(idx, 1);
  if (!removed) return state;
  let tab: StripTab = removed;
  if (groupId === null) tab = withoutGroup(tab);
  else if (groupId !== undefined && getGroup(state, groupId)) tab = { ...tab, groupId, pinned: false };
  const clamped = Math.max(0, Math.min(toIndex, tabs.length));
  tabs.splice(clamped, 0, tab);
  return normalize({ ...state, tabs });
}

export function moveGroup(state: TabStripState, groupId: GroupId, toIndex: number): TabStripState {
  const block = tabsInGroup(state, groupId);
  if (block.length === 0) return state;
  const rest = state.tabs.filter((t) => t.groupId !== groupId);
  const pinnedCount = rest.filter((t) => t.pinned).length;
  let index = Math.max(pinnedCount, Math.min(toIndex, rest.length));
  // Never split another group: slide to the end of the group we would land in.
  const landing = rest[index];
  const before = rest[index - 1];
  if (landing?.groupId !== undefined && before?.groupId === landing.groupId) {
    const gid = landing.groupId;
    while (index < rest.length && rest[index]?.groupId === gid) index++;
  }
  const tabs = [...rest.slice(0, index), ...block, ...rest.slice(index)];
  return normalize({ ...state, tabs });
}

export function setPinned(state: TabStripState, id: TabId, pinned: boolean): TabStripState {
  const idx = indexOfTab(state, id);
  const current = state.tabs[idx];
  if (!current || current.pinned === pinned) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  const pinnedCount = tabs.filter((t) => t.pinned).length;
  const tab = pinned ? { ...withoutGroup(current), pinned: true } : { ...current, pinned: false };
  tabs.splice(pinnedCount, 0, tab);
  return normalize({ ...state, tabs });
}

export function nextGroupColor(state: TabStripState): GroupColor {
  const used = new Set(state.groups.map((g) => g.color));
  return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[state.groups.length % GROUP_COLORS.length] ?? "grey";
}

export function createGroup(state: TabStripState, tabIds: TabId[], group: TabGroup): TabStripState {
  const selected = new Set(tabIds.filter((id) => indexOfTab(state, id) !== -1));
  if (selected.size === 0 || getGroup(state, group.id)) return state;
  const anchor = Math.min(...[...selected].map((id) => indexOfTab(state, id)));
  const rest = state.tabs.filter((t) => !selected.has(t.id));
  const members = state.tabs
    .filter((t) => selected.has(t.id))
    .map((t) => ({ ...t, pinned: false, groupId: group.id }));
  const pinnedCount = rest.filter((t) => t.pinned).length;
  const at = Math.max(anchor, pinnedCount);
  const tabs = [...rest.slice(0, at), ...members, ...rest.slice(at)];
  return normalize({ ...state, tabs, groups: [...state.groups, group] });
}

export function addTabsToGroup(state: TabStripState, tabIds: TabId[], groupId: GroupId): TabStripState {
  if (!getGroup(state, groupId)) return state;
  const selected = new Set(tabIds.filter((id) => indexOfTab(state, id) !== -1));
  if (selected.size === 0) return state;
  const rest = state.tabs.filter((t) => !selected.has(t.id));
  const members = state.tabs.filter((t) => selected.has(t.id)).map((t) => ({ ...t, pinned: false, groupId }));
  const last = rest.map((t) => t.groupId).lastIndexOf(groupId);
  const at = last === -1 ? rest.length : last + 1;
  const tabs = [...rest.slice(0, at), ...members, ...rest.slice(at)];
  return normalize({ ...state, tabs });
}

/** Remove tabs from their groups. They are placed right after the group they left. */
export function ungroupTabs(state: TabStripState, tabIds: TabId[]): TabStripState {
  let tabs = [...state.tabs];
  const selected = new Set(tabIds);
  const affectedGroups = new Set(
    tabs.filter((t) => selected.has(t.id) && t.groupId !== undefined).map((t) => t.groupId as GroupId),
  );
  for (const gid of affectedGroups) {
    const leaving = tabs.filter((t) => t.groupId === gid && selected.has(t.id));
    const firstIdx = tabs.findIndex((t) => t.groupId === gid);
    tabs = tabs.filter((t) => !(t.groupId === gid && selected.has(t.id)));
    const lastRemaining = tabs.map((t) => t.groupId).lastIndexOf(gid);
    const at = lastRemaining === -1 ? firstIdx : lastRemaining + 1;
    tabs.splice(at, 0, ...leaving.map(withoutGroup));
  }
  return normalize({ ...state, tabs });
}

export function removeGroup(state: TabStripState, groupId: GroupId): TabStripState {
  return ungroupTabs(
    state,
    tabsInGroup(state, groupId).map((t) => t.id),
  );
}

/** Link a group to the saved workspace it shows (null unlinks it). */
export function linkGroupWorkspace(state: TabStripState, groupId: GroupId, workspaceId: string | null): TabStripState {
  if (!getGroup(state, groupId)) return state;
  const groups = state.groups.map((g) => {
    if (g.id !== groupId) return g;
    const unlinked: TabGroup = { id: g.id, title: g.title, color: g.color, collapsed: g.collapsed };
    return workspaceId ? { ...unlinked, workspaceId } : unlinked;
  });
  return { ...state, groups };
}

/** The group showing a saved workspace, if one is open in this strip. */
export function groupForWorkspace(state: TabStripState, workspaceId: string): TabGroup | undefined {
  return state.groups.find((g) => g.workspaceId === workspaceId);
}

export type GroupPatch = Partial<Pick<TabGroup, "title" | "color" | "collapsed">>;

/**
 * Update group properties. Collapsing a group that holds the active tab activates the nearest
 * tab outside it; if there is none, the active tab is kept (the caller should open a new tab).
 */
export function updateGroup(state: TabStripState, groupId: GroupId, patch: GroupPatch): TabStripState {
  const group = getGroup(state, groupId);
  if (!group) return state;
  const groups = state.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g));
  let next: TabStripState = { ...state, groups };
  if (patch.collapsed === true) {
    const active = state.tabs.find((t) => t.id === state.activeId);
    if (active?.groupId === groupId) {
      const lastIdx = state.tabs.map((t) => t.groupId).lastIndexOf(groupId);
      const neighbor = pickNeighbor(next, lastIdx + 1, groupId);
      if (neighbor !== null) next = { ...next, activeId: neighbor };
    }
  }
  return next;
}

/** True when the active tab sits inside a collapsed group (caller must open/activate another tab). */
export function activeTabHidden(state: TabStripState): boolean {
  const active = state.tabs.find((t) => t.id === state.activeId);
  return active !== undefined && isHidden(state, active);
}

/** Ctrl+Tab / Ctrl+Shift+Tab. */
export function cycleTab(state: TabStripState, delta: 1 | -1): TabId | null {
  const visible = visibleTabs(state);
  if (visible.length === 0) return null;
  const idx = visible.findIndex((t) => t.id === state.activeId);
  const next = (idx + delta + visible.length) % visible.length;
  return visible[next]?.id ?? null;
}

/** Ctrl+1..8 selects the n-th visible tab, Ctrl+9 the last one. */
export function tabByNumber(state: TabStripState, n: number): TabId | null {
  const visible = visibleTabs(state);
  if (visible.length === 0) return null;
  if (n >= 9) return visible[visible.length - 1]?.id ?? null;
  return visible[n - 1]?.id ?? null;
}

export interface DropTarget {
  toIndex: number;
  groupId: GroupId | null;
}

/** Translate "dragged tab dropped before/after tab `overId`" into a moveTab() call. */
export function computeDropTarget(
  state: TabStripState,
  draggedId: TabId,
  overId: TabId,
  side: "before" | "after",
): DropTarget | null {
  const from = indexOfTab(state, draggedId);
  const over = indexOfTab(state, overId);
  const overTab = state.tabs[over];
  if (from === -1 || !overTab) return null;
  let toIndex = side === "after" ? over + 1 : over;
  if (from < toIndex) toIndex -= 1;
  return { toIndex, groupId: overTab.groupId ?? null };
}

export interface ClosedTab {
  url: string;
  title: string;
  index: number;
  groupId?: GroupId;
  pinned: boolean;
  containerId?: string;
}

export function pushClosed(stack: ClosedTab[], entry: ClosedTab, max = 25): ClosedTab[] {
  return [...stack, entry].slice(-max);
}
