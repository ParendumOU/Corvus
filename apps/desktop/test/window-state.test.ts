import { describe, expect, it } from "vitest";
import { EMPTY_AUTOFILL } from "../src/shared/credentials-ipc";
import type { TabView, WindowState } from "../src/shared/ipc";
import { fallbackWindowState } from "../src/shared/window-state";

const tab = (id: string, extra: Partial<TabView> = {}): TabView => ({
  id,
  windowId: "w1",
  url: `https://${id}.test/`,
  title: id,
  pinned: false,
  active: false,
  loading: false,
  agentControlled: false,
  canGoBack: false,
  canGoForward: false,
  webContentsId: -1,
  crashed: false,
  audible: false,
  ...extra,
});

/** The last state the chrome UI got: tabs a, b (b active) in a split, with b's prompt, find bar and zoom. */
function lastState(): WindowState {
  return {
    windowId: "w1",
    tabs: [tab("a"), tab("b", { active: true })],
    groups: [{ id: "g1", title: "Work", color: "blue", collapsed: false }],
    activeTabId: "b",
    connection: { name: "Office proxy", rule: false },
    activeBookmarked: true,
    permissionPrompt: { id: "p1", origin: "https://b.test", kinds: ["notifications"], agent: false, rememberable: true },
    find: { text: "raven", active: 1, matches: 3 },
    zoomPercent: 150,
    readerable: true,
    readerActive: true,
    translate: { state: "offered", pageLang: "fr", target: "en", translated: false },
    autofill: { available: true, matchCount: 2, otpAvailable: false, canSave: true, saveId: 3, savePrompt: false },
    split: { paneIds: ["a", "b"], focusedTabId: "b", ratio: 0.5, ratioY: 0.5, shown: true },
    showBookmarksBar: true,
    copiedLinks: 4,
  } as unknown as WindowState;
}

describe("the chrome UI's fallback state", () => {
  it("shows the window's tabs, groups and active tab now, over the rest of the last state", () => {
    const now = { tabs: [tab("a", { active: true })], groups: [], activeTabId: "a" };
    const state = fallbackWindowState(lastState(), now);
    expect(state.tabs.map((t) => t.id)).toEqual(["a"]);
    expect(state.groups).toEqual([]);
    expect(state.activeTabId).toBe("a");
    // Nothing tied to a tab: kept as it was.
    expect(state.windowId).toBe("w1");
    expect(state.showBookmarksBar).toBe(true);
    expect(state.copiedLinks).toBe(4);
  });

  it("leaves out what belonged to the tab shown before, and a split with a pane gone", () => {
    const state = fallbackWindowState(lastState(), { tabs: [tab("a", { active: true })], groups: [], activeTabId: "a" });
    expect(state).toMatchObject({
      connection: null,
      activeBookmarked: false,
      permissionPrompt: null,
      find: null,
      zoomPercent: 100,
      readerable: false,
      readerActive: false,
      translate: null,
      autofill: EMPTY_AUTOFILL,
      split: null,
    });
  });

  it("keeps the split while all its panes are open", () => {
    const state = fallbackWindowState(lastState(), { tabs: [tab("a"), tab("b", { active: true }), tab("c")], groups: [], activeTabId: "b" });
    expect(state.split?.paneIds).toEqual(["a", "b"]);
  });
});
