import { describe, expect, it } from "vitest";
import type { Tab, TabGroup } from "@corvus/shared";
import { agentGroupTitle, agentTabLine } from "../src/shared/agent-tabs";
import { RunTabs } from "../src/main/agent-tabs";
import type { AppContext } from "../src/main/context";
import type { BrowserWindowCtl } from "../src/main/window";

describe("agentGroupTitle", () => {
  it("uses the agent's name for the group, else the task", () => {
    expect(agentGroupTitle("busca el vuelo más barato a Lisboa", "Vuelos a Lisboa")).toBe("Vuelos a Lisboa");
    expect(agentGroupTitle("compare umbrellas.")).toBe("compare umbrellas");
  });

  it("cuts a long task at a word boundary", () => {
    const title = agentGroupTitle("find the cheapest flight from Madrid to Lisbon next weekend");
    expect(title).toBe("find the cheapest flight from…");
    expect(title.length).toBeLessThanOrEqual(32);
    expect(agentGroupTitle("x".repeat(60))).toBe(`${"x".repeat(31)}…`);
  });
});

describe("agentTabLine", () => {
  it("marks the working tab, the run's tabs and the start tab", () => {
    const t = { id: "t2", title: "Skyscanner", url: "https://www.skyscanner.es/", active: true };
    expect(agentTabLine(t, { working: true, own: true, start: false })).toBe("t2* [working, yours] Skyscanner — https://www.skyscanner.es/");
    expect(agentTabLine({ ...t, active: false }, { working: false, own: false, start: true })).toBe("t2 [started here] Skyscanner — https://www.skyscanner.es/");
    expect(agentTabLine({ ...t, active: false }, { working: false, own: false, start: false })).toBe("t2 Skyscanner — https://www.skyscanner.es/");
  });
});

/** A window with just what RunTabs uses: tabs in order, groups, the agent badge. */
function fakeWindow() {
  let n = 1;
  const tabs: Array<{ id: string; url: string; groupId?: string; agent: boolean }> = [{ id: "t1", url: "https://news.example/", agent: false }];
  const groups: TabGroup[] = [];
  let active = "t1";
  const toTab = (t: { id: string; url: string; agent: boolean }): Tab => ({ id: t.id, windowId: "w1", url: t.url, title: t.url, pinned: false, active: t.id === active, loading: false, agentControlled: t.agent });
  const runtime = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    return t ? { id, view: { webContents: { isDestroyed: () => false, getURL: () => t.url } } } : undefined;
  };
  const win = {
    createTab: (url: string, opts: { groupId?: string; agent?: boolean } = {}) => {
      const t = { id: `t${++n}`, url, agent: opts.agent === true, ...(opts.groupId ? { groupId: opts.groupId } : {}) };
      tabs.push(t);
      active = t.id;
      return runtime(t.id)!;
    },
    hasTab: (id: string) => tabs.some((t) => t.id === id),
    hasGroup: (id: string) => groups.some((g) => g.id === id),
    groupOf: (id: string) => tabs.find((t) => t.id === id)?.groupId,
    tabIds: () => tabs.map((t) => t.id),
    listTabs: () => tabs.map(toTab),
    listGroups: () => groups,
    createGroup: (ids: string[], opts: { title?: string }) => {
      const g: TabGroup = { id: `g${groups.length + 1}`, title: opts.title ?? "", color: "blue", collapsed: false };
      groups.push(g);
      for (const t of tabs) if (ids.includes(t.id)) t.groupId = g.id;
      return g;
    },
    addToGroup: (ids: string[], groupId: string) => {
      for (const t of tabs) if (ids.includes(t.id)) t.groupId = groupId;
    },
    updateGroup: (groupId: string, patch: { title?: string }) => Object.assign(groups.find((g) => g.id === groupId)!, patch),
    activate: (id: string) => {
      active = id;
    },
    closeTab: (id: string) => tabs.splice(tabs.findIndex((t) => t.id === id), 1),
    clearAgentMark: (id: string) => {
      const t = tabs.find((x) => x.id === id);
      if (t) t.agent = false;
    },
    toTab: (rt: { id: string }) => toTab(tabs.find((t) => t.id === rt.id)!),
  };
  const ctx = {
    windows: {
      regular: () => [win],
      findTab: (id: string) => {
        const tab = runtime(id);
        return tab ? { window: win, tab } : undefined;
      },
    },
    controller: {
      navigate: async (id: string, url: string) => {
        const t = tabs.find((x) => x.id === id)!;
        t.url = url;
        t.agent = true;
        return toTab(t);
      },
    },
  } as unknown as AppContext;
  return { win: win as unknown as BrowserWindowCtl, ctx, tabs, groups, active: () => active };
}

describe("RunTabs", () => {
  it("groups the tabs an Assist run opens and never touches the person's tab", async () => {
    const f = fakeWindow();
    const run = new RunTabs(f.ctx, f.win, "busca el vuelo más barato a Lisboa", "t1");
    const a = await run.open("https://www.google.com/travel/flights", "Vuelos a Lisboa");
    const b = await run.open("https://www.skyscanner.es/", "");
    expect(f.groups).toEqual([expect.objectContaining({ title: "Vuelos a Lisboa" })]);
    expect(f.tabs.filter((t) => t.groupId === "g1").map((t) => t.id)).toEqual([a.id, b.id]);
    expect(f.tabs.find((t) => t.id === "t1")?.groupId).toBeUndefined();

    expect(run.switchTo(a.id).id).toBe(a.id);
    expect(f.active()).toBe(a.id);
    expect(run.switchTo("t1").id).toBe("t1");
    expect(() => run.close("t1", a.id)).toThrow(/not one you opened/);

    expect(run.close(b.id, b.id)).toBe(a.id);
    expect(f.tabs.some((t) => t.id === b.id)).toBe(false);
    expect(run.list(a.id)).toContain(`${a.id}* [working, yours]`);
    expect(run.list(a.id)).toContain("t1 [started here]");

    run.release();
    expect(f.tabs.find((t) => t.id === a.id)?.agent).toBe(false);
  });

  it("loads the Command Bar's empty tab first instead of leaving it blank", async () => {
    const f = fakeWindow();
    const fresh = f.win.createTab("corvus://newtab/", { agent: true });
    const run = new RunTabs(f.ctx, f.win, "compare umbrellas", null);
    run.adopt(fresh.id);
    const first = await run.open("https://shop.example/", "");
    expect(first.id).toBe(fresh.id);
    expect(f.groups[0]?.title).toBe("compare umbrellas");
    const second = await run.open("https://other.example/", "Umbrellas");
    expect(second.id).not.toBe(fresh.id);
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0]?.title).toBe("Umbrellas");
    expect(() => run.switchTo("t1")).toThrow(/not one of your tabs/);
  });

  it("closes a tab that fails to open", async () => {
    const f = fakeWindow();
    (f.ctx.controller as unknown as { navigate: () => Promise<never> }).navigate = async () => {
      throw new Error("Agents may not open file:///etc/passwd");
    };
    const run = new RunTabs(f.ctx, f.win, "t", "t1");
    await expect(run.open("file:///etc/passwd", "")).rejects.toThrow(/may not open/);
    expect(f.tabs.map((t) => t.id)).toEqual(["t1"]);
  });
});
