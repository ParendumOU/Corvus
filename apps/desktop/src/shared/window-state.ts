import { EMPTY_AUTOFILL } from "./credentials-ipc";
import type { WindowState } from "./ipc";

/**
 * The state the chrome UI gets when the window's full state could not be built: its tabs, groups and
 * active tab as they are now, over the last state it got. What belonged to the tab shown then (its
 * permission prompt, find bar, zoom, proxy, bookmark star, reader, translate and autofill buttons) is
 * left out rather than shown for another tab, and so is a split whose panes are not all open.
 */
export function fallbackWindowState(last: WindowState, now: Pick<WindowState, "tabs" | "groups" | "activeTabId">): WindowState {
  const open = new Set(now.tabs.map((t) => t.id));
  return {
    ...last,
    ...now,
    connection: null,
    activeBookmarked: false,
    permissionPrompt: null,
    find: null,
    zoomPercent: 100,
    readerable: false,
    readerActive: false,
    translate: null,
    autofill: EMPTY_AUTOFILL,
    split: last.split?.paneIds.every((id) => open.has(id)) ? last.split : null,
  };
}
