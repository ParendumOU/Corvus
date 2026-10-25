import { describe, expect, it } from "vitest";
import type { TabGroup } from "@corvus/shared";
import { registerTabGroupApis, type TabGroupAccess } from "../src/main/extension-apis";
import type { RouterCallback } from "../src/main/extensions";
import { groupEvents, queryGroups, type GroupPlacement } from "../src/shared/chrome-tab-groups";

const group = (id: string, over: Partial<TabGroup> = {}): TabGroup => ({ id, title: "", color: "blue", collapsed: false, ...over });
const place = (id: number, g: TabGroup, index: number, over: Partial<GroupPlacement> = {}): GroupPlacement => ({ id, windowId: 1, index, windowTabs: 6, group: g, ...over });

describe("chrome.tabGroups helpers", () => {
  it("queries by every property given, the title with * wildcards and the current window as -2", () => {
    const list = [place(1, group("g1", { title: "Work stuff" }), 0), place(2, group("g2", { title: "Trip", color: "red", collapsed: true }), 3, { windowId: 2 })];
    expect(queryGroups(list, {}).map((g) => g.id)).toEqual([1, 2]);
    expect(queryGroups(list, { title: "Work*" }).map((g) => g.id)).toEqual([1]);
    expect(queryGroups(list, { color: "red", collapsed: true }).map((g) => g.id)).toEqual([2]);
    expect(queryGroups(list, { windowId: -2 }, 2).map((g) => g.id)).toEqual([2]);
    expect(queryGroups(list, { title: "Work" })).toEqual([]);
    expect(queryGroups(list, { title: "Trip" })[0]).toEqual({ id: 2, collapsed: true, color: "red", title: "Trip", windowId: 2 });
  });

  it("turns snapshots into created, updated, moved and removed events", () => {
    const a = group("ga", { title: "A" });
    const b = group("gb", { title: "B" });
    const before = [place(1, a, 0), place(2, b, 3)];
    expect(groupEvents(before, [place(1, { ...a, title: "A2" }, 0), place(2, b, 3), place(3, group("gc"), 5)]).map((e) => `${e.event}:${e.group.id}`)).toEqual([
      "onUpdated:1",
      "onCreated:3",
    ]);
    expect(groupEvents(before, [place(2, b, 0), place(1, a, 2)]).map((e) => `${e.event}:${e.group.id}`)).toEqual(["onMoved:2", "onMoved:1"]);
    expect(groupEvents(before, [place(1, a, 0)]).map((e) => `${e.event}:${e.group.id}`)).toEqual(["onRemoved:2"]);
    // A tab closed before a group shifts its index: not a move.
    expect(groupEvents(before, [place(1, a, 0, { windowTabs: 5 }), place(2, b, 2, { windowTabs: 5 })])).toEqual([]);
  });
});

/** The window layer's groups in memory, with the calls the API made. */
function fakeAccess(): TabGroupAccess & { list: GroupPlacement[]; changed: () => void; listeners: Array<() => void> } {
  const list = [place(1, group("g1", { title: "Work" }), 1)];
  const listeners: Array<() => void> = [];
  return {
    list,
    listeners,
    changed: () => listeners.forEach((l) => l()),
    groups: () => list.map((p) => ({ ...p, group: { ...p.group } })),
    currentWindowId: () => 1,
    update: (id, patch) => {
      const p = list.find((x) => x.id === id)!;
      p.group = { ...p.group, ...patch };
    },
    move: (id, index) => {
      list.find((x) => x.id === id)!.index = index;
    },
    group: (tabIds, groupId) => {
      if (groupId !== undefined) return groupId;
      list.push(place(2, group("g2"), tabIds[0]!));
      return 2;
    },
    ungroup: () => {
      list.splice(1);
    },
  };
}

describe("chrome.tabGroups for extensions", () => {
  it("gets, queries, updates and moves groups behind the tabGroups permission, with events", async () => {
    const access = fakeAccess();
    const handlers = new Map<string, { cb: RouterCallback; permission?: string }>();
    const events: Array<{ permission: string; event: string; args: unknown[] }> = [];
    registerTabGroupApis(
      {
        handle: (name, cb, permission) => void handlers.set(name, { cb, ...(permission ? { permission } : {}) }),
        emit: (permission, event, ...args) => void events.push({ permission, event, args }),
        onWindowChanged: (l) => {
          access.listeners.push(l);
          return () => undefined;
        },
      },
      access,
    );
    const call = async (name: string, ...args: unknown[]): Promise<unknown> => handlers.get(name)!.cb({ type: "frame" }, ...args);
    expect([...handlers].filter(([n]) => n.startsWith("tabGroups.")).every(([, h]) => h.permission === "tabGroups")).toBe(true);
    expect(handlers.get("tabs.group")!.permission).toBeUndefined();

    expect(await call("tabGroups.get", 1)).toEqual({ id: 1, collapsed: false, color: "blue", title: "Work", windowId: 1 });
    await expect(call("tabGroups.get", 99)).rejects.toThrow("No group with id: 99.");
    expect(await call("tabGroups.update", 1, { title: "Deep work", color: "green", collapsed: true })).toMatchObject({ title: "Deep work", color: "green", collapsed: true });
    await expect(call("tabGroups.update", 1, { color: "black" })).rejects.toThrow("Invalid color");
    expect(await call("tabGroups.move", 1, { index: 4 })).toMatchObject({ id: 1 });
    expect(await call("tabs.group", { tabIds: [7, 8] })).toBe(2);
    expect(((await call("tabGroups.query", { windowId: -2 })) as unknown[]).length).toBe(2);
    await expect(call("tabs.group", { tabIds: [] })).rejects.toThrow("No tabs given.");

    access.changed();
    expect(events.map((e) => `${e.event}:${(e.args[0] as { id: number }).id}`)).toEqual(["tabGroups.onUpdated:1", "tabGroups.onMoved:1", "tabGroups.onCreated:2"]);
    expect(events.every((e) => e.permission === "tabGroups")).toBe(true);
    await call("tabs.ungroup", [7, 8]);
    access.changed();
    expect(events.at(-1)!.event).toBe("tabGroups.onRemoved");
  });
});

describe("chrome.tabGroups events", () => {
  it("are two events for two quick changes, even before the window flushes its state", async () => {
    const access = fakeAccess();
    const handlers = new Map<string, RouterCallback>();
    const events: string[] = [];
    registerTabGroupApis(
      {
        handle: (name, cb) => void handlers.set(name, cb),
        emit: (_permission, event, ...args) => void events.push(`${event}:${(args[0] as { title: string }).title}`),
        onWindowChanged: () => () => undefined,
      },
      access,
    );
    const id = await handlers.get("tabs.group")!({ type: "frame" }, { tabIds: [5] });
    await handlers.get("tabGroups.update")!({ type: "frame" }, id, { title: "Named" });
    expect(events).toEqual(["tabGroups.onCreated:", "tabGroups.onUpdated:Named"]);
  });
});
