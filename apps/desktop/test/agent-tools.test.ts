import { describe, expect, it } from "vitest";
import type { PageSnapshot, Tab } from "@corvus/shared";
import { ASSIST_AGENT_SYSTEM, RESULT_PREVIEW_CHARS, TOOLS, agentToolset, preview, runAgentTool, stepPreview, wrapUntrusted, type RunTabsHandle, type ToolRunState } from "../src/main/agent-tools";
import { classifyAction } from "../src/shared/agent-safety";
import type { AppContext } from "../src/main/context";

const snap: PageSnapshot = {
  tabId: "t1",
  url: "https://shop.example/products/umbrella",
  title: "Raven Travel Umbrella | Raven Outfitters",
  text: "Raven Travel Umbrella\nNow €39.00",
  elements: [{ ref: "e1", role: "button", name: "Buy now" }],
  truncated: false,
};

const tab: Tab = { id: "t1", windowId: "w1", url: snap.url, title: snap.title, pinned: false, active: true, loading: false, agentControlled: true };

/** Runs one real tool against a stub controller and returns the raw result the model sees. */
async function rawResult(name: string, input: unknown, page: Partial<PageSnapshot> = {}): Promise<string> {
  const ctx = {
    controller: {
      snapshot: async () => ({ ...snap, ...page }),
      navigate: async (_id: string, url: string) => ({ ...tab, url, title: page.title ?? tab.title }),
      openTab: async (url: string) => ({ ...tab, url, title: page.title ?? tab.title }),
    },
  } as unknown as AppContext;
  const result = await runAgentTool(ctx, { tabId: "t1", elementNames: new Map() }, name, input, new AbortController().signal);
  return result.content;
}

describe("agent step preview", () => {
  it("shows only the page data of a wrapped result, without the safety note or tags", () => {
    const wrapped = wrapUntrusted("https://shop.example/umbrella", "Raven Travel Umbrella\nNow €39.00");
    expect(preview(wrapped)).toBe("Raven Travel Umbrella Now €39.00");
  });

  it("leaves plain tool results alone and caps long ones", () => {
    expect(preview("Clicked.")).toBe("Clicked.");
    const long = preview(wrapUntrusted("https://shop.example/", "word ".repeat(200)));
    expect(long.length).toBe(RESULT_PREVIEW_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(long.startsWith("word word")).toBe(true);
  });

  it("summarizes a page read by its title instead of the raw snapshot", async () => {
    const raw = await rawResult("page_snapshot", {});
    expect(raw).toContain('"url":"https://shop.example/products/umbrella"');
    expect(raw).toContain("e1 button");
    expect(stepPreview("page_snapshot", raw)).toBe("Read page: Raven Travel Umbrella | Raven Outfitters");
  });

  it("falls back to the host when the page has no title", async () => {
    const raw = await rawResult("page_snapshot", {}, { title: "  " });
    expect(stepPreview("page_snapshot", raw)).toBe("Read page: shop.example");
  });

  it("summarizes opened pages by title", async () => {
    expect(stepPreview("navigate", await rawResult("navigate", { url: snap.url }))).toBe("Opened Raven Travel Umbrella | Raven Outfitters");
    expect(stepPreview("open_tab", await rawResult("open_tab", { url: snap.url }, { title: "" }))).toBe("Opened shop.example");
  });

  it("keeps the trimmed raw text for other tools and unexpected shapes", async () => {
    expect(stepPreview("extract", await rawResult("extract", {}))).toBe("Raven Travel Umbrella Now €39.00");
    expect(stepPreview("page_snapshot", "Snapshot failed: tab closed")).toBe("Snapshot failed: tab closed");
    expect(stepPreview("navigate", "Navigation blocked.")).toBe("Navigation blocked.");
  });
});

describe("run tabs", () => {
  const handle = (log: string[]): RunTabsHandle => ({
    open: async (url, group) => {
      log.push(`open ${url} ${group}`);
      return { ...tab, id: "t7", url, title: "Flights" };
    },
    switchTo: (id) => {
      log.push(`switch ${id}`);
      return { ...tab, id, url: "https://www.skyscanner.es/", title: "Skyscanner" };
    },
    close: (id, working) => {
      log.push(`close ${id} ${working}`);
      return "t1";
    },
    list: (working) => `t1 [started here]\nt7* [${working === "t7" ? "working, " : ""}yours]`,
  });

  it("opens, switches and closes through the run's tabs and resets refs", async () => {
    const log: string[] = [];
    const state: ToolRunState = { tabId: "t1", elementNames: new Map([["e1", "Buy now"]]), tabs: handle(log) };
    const ctx = {} as AppContext;
    const signal = new AbortController().signal;
    const opened = await runAgentTool(ctx, state, "open_tab", { url: "https://www.google.com/travel/flights", group: "Vuelos" }, signal);
    expect(opened.content).toBe("Opened tab t7 at https://www.google.com/travel/flights — Flights");
    expect(stepPreview("open_tab", opened.content)).toBe("Opened Flights");
    expect(state.tabId).toBe("t7");
    expect(state.elementNames.size).toBe(0);
    expect((await runAgentTool(ctx, state, "list_tabs", {}, signal)).content).toContain("t7* [working, yours]");
    const switched = await runAgentTool(ctx, state, "switch_tab", { tabId: "t9" }, signal);
    expect(state.tabId).toBe("t9");
    expect(stepPreview("switch_tab", switched.content)).toBe("Opened Skyscanner");
    const closed = await runAgentTool(ctx, state, "close_tab", { tabId: "t9" }, signal);
    expect(closed.content).toBe("Closed tab t9. Working tab: t1.");
    expect(state.tabId).toBe("t1");
    expect(log).toEqual(["open https://www.google.com/travel/flights Vuelos", "switch t9", "close t9 t9"]);
  });

  it("offers the tab tools and steers to real pages only in interactive runs", async () => {
    const { tools, system } = agentToolset(false);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["open_tab", "switch_tab", "close_tab", "list_tabs"]));
    expect(JSON.stringify(tools.find((t) => t.name === "open_tab")?.inputSchema)).toContain("group");
    expect(TOOLS.some((t) => t.name === "switch_tab")).toBe(false);
    expect(system).toContain("never answer about live facts");
    expect(agentToolset(false, ASSIST_AGENT_SYSTEM).system).toContain("open the sites in new");
    await expect(runAgentTool({} as AppContext, { tabId: "t1", elementNames: new Map() }, "switch_tab", { tabId: "t2" }, new AbortController().signal)).rejects.toThrow(/not available/);
    expect(classifyAction("close_tab", { tabId: "t2" }).risky).toBe(false);
    expect(classifyAction("switch_tab", { tabId: "t2" }).risky).toBe(false);
  });
});
