/**
 * Several tabs picked together in a window's strip, as in Chrome: Ctrl+click (Cmd+click on macOS)
 * adds or takes out one tab, Shift+click picks the range from the last tab clicked. The active tab
 * is always among them. Actions of the tab menu, Ctrl+W and dragging then apply to all of them. Pure,
 * so the rules are unit tested; BrowserWindowCtl keeps one per window.
 */
import type { TabId } from "@corvus/shared";
import { visibleTabs, type TabStripState } from "./tab-strip";

export interface TabSelection {
  /** The tabs picked; only those still in the strip count (see selectedTabs). */
  ids: TabId[];
  /** Where a Shift+click range starts: the tab last clicked without Shift. */
  anchor: TabId | null;
}

export function emptySelection(): TabSelection {
  return { ids: [], anchor: null };
}

/**
 * The selected tabs, in strip order: the active tab and the tabs picked with it. When the active
 * tab is not among the picked ones (another tab was activated by other means, the picked ones
 * closed), the selection is the active tab alone.
 */
export function selectedTabs(strip: TabStripState, selection: TabSelection): TabId[] {
  const active = strip.activeId;
  if (active === null) return [];
  const picked = new Set(selection.ids);
  if (!picked.has(active)) return [active];
  return strip.tabs.filter((t) => picked.has(t.id)).map((t) => t.id);
}

export interface SelectModifiers {
  /** Ctrl (Cmd on macOS): add the tab to the selection, or take it out. */
  toggle?: boolean;
  /** Shift: the range from the anchor to the tab. */
  range?: boolean;
  /**
   * A plain press on a tab that is already selected among others: it becomes the active one and the
   * selection stays, so dragging it moves them all (the release, without a drag, then picks it alone).
   */
  keep?: boolean;
}

export interface SelectResult {
  selection: TabSelection;
  /** The tab to make active, if any. */
  activate: TabId | null;
}

/** The selection, and the tab to activate, after a click on tab `id` with `mods`. */
export function clickSelection(strip: TabStripState, selection: TabSelection, id: TabId, mods: SelectModifiers = {}): SelectResult {
  if (!strip.tabs.some((t) => t.id === id)) return { selection, activate: null };
  const current = selectedTabs(strip, selection);
  if (mods.range) {
    const order = visibleTabs(strip).map((t) => t.id);
    const anchor = selection.anchor !== null && order.includes(selection.anchor) ? selection.anchor : (strip.activeId ?? id);
    const from = order.indexOf(anchor);
    const to = order.indexOf(id);
    const range = from === -1 || to === -1 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
    const ids = mods.toggle ? [...new Set([...current, ...range])] : range;
    return { selection: { ids, anchor }, activate: id };
  }
  if (mods.toggle) {
    if (!current.includes(id)) return { selection: { ids: [...current, id], anchor: id }, activate: id };
    // The last selected tab stays selected (it is the active one).
    if (current.length === 1) return { selection, activate: null };
    const rest = current.filter((t) => t !== id);
    if (strip.activeId !== id) return { selection: { ids: rest, anchor: selection.anchor === id ? strip.activeId : selection.anchor }, activate: null };
    // Taking out the active tab: the nearest selected tab to its right (else its left) takes over.
    const order = strip.tabs.map((t) => t.id);
    const at = order.indexOf(id);
    const next = rest.find((t) => order.indexOf(t) > at) ?? rest[rest.length - 1] ?? null;
    return { selection: { ids: rest, anchor: next }, activate: next };
  }
  if (mods.keep && current.length > 1 && current.includes(id)) return { selection: { ...selection, anchor: id }, activate: id };
  return { selection: { ids: [id], anchor: id }, activate: id };
}

/** The tabs an action on tab `id` applies to: the whole selection when `id` is one of several selected, else `id` alone. */
export function actionTabs(strip: TabStripState, selection: TabSelection, id: TabId): TabId[] {
  const selected = selectedTabs(strip, selection);
  return selected.length > 1 && selected.includes(id) ? selected : [id];
}
