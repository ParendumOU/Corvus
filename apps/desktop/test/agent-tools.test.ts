import { describe, expect, it } from "vitest";
import type { PageSnapshot, Tab } from "@corvus/shared";
import { RESULT_PREVIEW_CHARS, preview, runAgentTool, stepPreview, wrapUntrusted } from "../src/main/agent-tools";
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
