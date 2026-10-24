import { describe, expect, it } from "vitest";
import { MAX_COMPARE_TABS, compareCandidates, comparisonMarkdown } from "../src/shared/compare";

const tab = (id: string, url: string, groupId?: string) => ({ id, title: `Tab ${id}`, url, ...(groupId ? { groupId } : {}) });

describe("compare tabs", () => {
  it("lists the window's web pages, ticking the right-clicked tab", () => {
    const list = compareCandidates([tab("a", "https://a.example/"), tab("n", "corvus://newtab/"), tab("b", "https://b.example/")], "b");
    expect(list.map((c) => `${c.tabId}:${c.checked}`)).toEqual(["a:false", "b:true"]);
  });

  it("ticks the other pages of its group too, up to the limit", () => {
    const tabs = [tab("x", "https://x.example/"), ...Array.from({ length: 8 }, (_, i) => tab(`g${i}`, `https://g${i}.example/`, "grp"))];
    const list = compareCandidates(tabs, "g3");
    expect(list.find((c) => c.tabId === "x")?.checked).toBe(false);
    expect(list.filter((c) => c.checked)).toHaveLength(MAX_COMPARE_TABS);
    expect(list.find((c) => c.tabId === "g3")?.checked).toBe(true);
  });

  it("copies the table as Markdown, pages as columns, escaping pipes", () => {
    const md = comparisonMarkdown({
      pages: [
        { tabId: "a", title: "Phone A", url: "https://a.example/" },
        { tabId: "b", title: "Phone | B", url: "https://b.example/" },
      ],
      rows: [
        { label: "Battery", values: ["5000 mAh", "4000 mAh"] },
        { label: "Price", values: ["199 €", "—"] },
      ],
      verdict: "A lasts longer.",
    });
    expect(md).toBe(["| | Phone A | Phone \\| B |", "|---|---|---|", "| Battery | 5000 mAh | 4000 mAh |", "| Price | 199 € | — |", "", "A lasts longer."].join("\n"));
  });
});
