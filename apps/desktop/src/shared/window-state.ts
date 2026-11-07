import { EMPTY_AUTOFILL } from "./credentials-ipc";
import type { WindowState } from "./ipc";
import type { LockScreenView } from "./profile-lock";

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

/** What a locked window's state is built from: the window's own facts, none of the profile's. */
export type LockedWindowFacts = Pick<
  WindowState,
  "windowId" | "platform" | "profile" | "profiles" | "partition" | "privateWindow" | "maximized" | "dark" | "tabLayout" | "sidebarWidth" | "sidebarCollapsed" | "dialog"
>;

/**
 * The state of a window whose profile is locked: the lock screen, and nothing of the profile's
 * pages (no tabs, titles, addresses, icons, bookmarks, downloads or agent runs). Corvus's own
 * questions (`dialog`) still show over it.
 */
export function lockedWindowState(facts: LockedWindowFacts, lock: LockScreenView): WindowState {
  return {
    ...facts,
    lock,
    connection: null,
    tabs: [],
    groups: [],
    agentGroups: [],
    activeTabId: null,
    activeBookmarked: false,
    bookmarksBar: [],
    faviconRevision: 0,
    showBookmarksBar: false,
    showHomeButton: false,
    mcpRunning: false,
    watches: { total: 0, unseen: 0, enabled: false },
    permissionPrompt: null,
    dialogBars: [],
    find: null,
    zoomPercent: 100,
    downloads: { recent: [], active: 0, progress: null, attention: false, finished: 0, queue: null },
    copiedLinks: 0,
    defaultBrowserOffer: false,
    adblock: { enabled: false, allowed: false, blocked: 0, total: 0, host: "", active: false, cookieConsent: false, consentAllowed: false, bannersHandled: 0 },
    readerable: false,
    readerActive: false,
    translate: null,
    dictationReady: false,
    autofill: EMPTY_AUTOFILL,
    split: null,
    assistOpen: false,
    agentsPaused: false,
    agentActive: false,
    agentRun: null,
    agentOthers: [],
    agentReady: false,
    agentSetupReason: null,
  };
}
