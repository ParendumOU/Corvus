import { describe, expect, it } from "vitest";
import type { Tab, TabGroup } from "@corvus/shared";
import { agentGroupTitle, agentTabLine } from "../src/shared/agent-tabs";
import { RunTabs } from "../src/main/agent-tabs";
import { CertificateError } from "../src/main/controller";
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
  const working = new Set<string>();
  let active = "t1";
  const toTab = (t: { id: string; url: string; agent: boolean }): Tab => ({ id: t.id, windowId: "w1", url: t.url, title: t.url, pinned: false, active: t.id === active, loading: false, agentControlled: t.agent });
  const runtime = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    return t ? { id, view: { webContents: { isDestroyed: () => false, getURL: () => t.url } } } : undefined;
  };
  const win = {
    createTab: (url: string, opts: { groupId?: string; agent?: boolean; activate?: boolean } = {}) => {
      const t = { id: `t${++n}`, url, agent: opts.agent === true, ...(opts.groupId ? { groupId: opts.groupId } : {}) };
      tabs.push(t);
      if (opts.activate !== false) active = t.id;
      return runtime(t.id)!;
    },
    activeTab: () => ({ id: active }),
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
    setAgentGroup: (id: string, on: boolean) => (on ? working.add(id) : working.delete(id)),
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
  return { win: win as unknown as BrowserWindowCtl, ctx, tabs, groups, working, active: () => active };
}

describe("RunTabs", () => {
  it("works in the background once the person has gone to another tab", async () => {
    const f = fakeWindow();
    const own = f.win.createTab("https://mine.example/");
    const run = new RunTabs(f.ctx, f.win, "compare", "t1");
    (f.win as unknown as { activate: (id: string) => void }).activate("t1");
    const a = await run.open("https://a.example/", "Compare");
    expect(f.active()).toBe(a.id);
    // The person reads their own tab: new tabs and switches stay in the background.
    (f.win as unknown as { activate: (id: string) => void }).activate(own.id);
    const b = await run.open("https://b.example/", "");
    expect(f.active()).toBe(own.id);
    run.switchTo(a.id);
    expect(f.active()).toBe(own.id);
    expect(run.close(b.id, b.id)).toBe(a.id);
    expect(f.active()).toBe(own.id);
    // Back on one of the run's tabs: it shows its tabs again.
    (f.win as unknown as { activate: (id: string) => void }).activate(a.id);
    const c = await run.open("https://c.example/", "");
    expect(f.active()).toBe(c.id);
  });

  it("groups the tabs an Assist run opens and never touches the person's tab", async () => {
    const f = fakeWindow();
    const run = new RunTabs(f.ctx, f.win, "busca el vuelo más barato a Lisboa", "t1");
    const a = await run.open("https://www.google.com/travel/flights", "Vuelos a Lisboa");
    const b = await run.open("https://www.skyscanner.es/", "");
    expect(f.groups).toEqual([expect.objectContaining({ title: "Vuelos a Lisboa" })]);
    expect(f.tabs.filter((t) => t.groupId === "g1").map((t) => t.id)).toEqual([a.id, b.id]);
    expect(f.tabs.find((t) => t.id === "t1")?.groupId).toBeUndefined();
    expect([...f.working]).toEqual(["g1"]);

    expect(run.switchTo(a.id).id).toBe(a.id);
    expect(f.active()).toBe(a.id);
    expect(run.switchTo("t1").id).toBe("t1");
    expect(() => run.close("t1", a.id)).toThrow(/not one you opened/);

    expect(run.close(b.id, b.id)).toBe(a.id);
    expect(f.tabs.some((t) => t.id === b.id)).toBe(false);
    expect(run.list(a.id)).toContain(`${a.id}* [working, yours]`);
    expect(run.list(a.id)).toContain("t1 [started here]");

    expect(run.release()).toEqual([{ id: a.id, title: "https://www.google.com/travel/flights", url: "https://www.google.com/travel/flights" }]);
    expect(f.tabs.find((t) => t.id === a.id)?.agent).toBe(false);
    expect(f.working.size).toBe(0);
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

  it("keeps a tab stopped on a certificate error open for the person's choice, and passes the run's policy", async () => {
    const f = fakeWindow();
    const policies: unknown[] = [];
    (f.ctx.controller as unknown as { navigate: (id: string, url: string, certs: unknown) => Promise<never> }).navigate = async (id, url, certs) => {
      policies.push(certs);
      f.tabs.find((t) => t.id === id)!.url = url;
      throw new CertificateError("certificate error: ERR_CERT_AUTHORITY_INVALID for 10.0.10.1; the person must choose to proceed.");
    };
    const run = new RunTabs(f.ctx, f.win, "router", "t1");
    await expect(run.open("https://10.0.10.1/", "")).rejects.toThrow(/person must choose/);
    expect(f.tabs).toHaveLength(2);
    expect(run.list(null)).toContain("[yours] https://10.0.10.1/");
    expect(policies).toEqual(["refuse"]);
  });
});
