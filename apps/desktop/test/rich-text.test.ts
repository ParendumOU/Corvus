import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../src/shared/rich-text";

describe("Markdown blocks in Assist answers", () => {
  it("reads headings, lists, quotes, rules and paragraphs that keep their line breaks", () => {
    const text = [
      "## Getting there",
      "Take the train from the airport.",
      "It runs every 10 minutes.",
      "",
      "1. Buy a ticket",
      "2. Validate it",
      "   on the platform",
      "",
      "- Cheap",
      "* Fast",
      "",
      "> Tip: sit on the left",
      "",
      "---",
      "Done.",
    ].join("\n");
    expect(parseBlocks(text)).toEqual([
      { kind: "heading", level: 2, text: "Getting there" },
      { kind: "paragraph", text: "Take the train from the airport.\nIt runs every 10 minutes." },
      { kind: "list", ordered: true, start: 1, items: ["Buy a ticket", "Validate it on the platform"] },
      { kind: "list", ordered: false, start: 1, items: ["Cheap", "Fast"] },
      { kind: "quote", text: "Tip: sit on the left" },
      { kind: "rule" },
      { kind: "paragraph", text: "Done." },
    ]);
  });

  it("keeps fenced code as written and reads tables with their alignment", () => {
    const text = "Run:\n```sh\nnpm  install\n  --save\n```\n| Name | Price |\n|:---|---:|\n| A \\| B | 12 |\n| C |\n";
    expect(parseBlocks(text)).toEqual([
      { kind: "paragraph", text: "Run:" },
      { kind: "code", lang: "sh", code: "npm  install\n  --save" },
      { kind: "table", head: ["Name", "Price"], align: ["left", "right"], rows: [["A | B", "12"], ["C", ""]] },
    ]);
  });

  it("treats an unclosed fence as code to the end, and a lone pipe line as text", () => {
    expect(parseBlocks("```\nstill typing")).toEqual([{ kind: "code", lang: "", code: "still typing" }]);
    expect(parseBlocks("a | b")).toEqual([{ kind: "paragraph", text: "a | b" }]);
  });
});

describe("marks inside a line", () => {
  it("reads bold, italic, code, links and citations", () => {
    expect(parseInline("**Vueling** is *cheapest*, see `fare` at [the site](https://vueling.com/x) [2][5]", 3)).toEqual([
      { kind: "bold", text: "Vueling" },
      { kind: "text", text: " is " },
      { kind: "italic", text: "cheapest" },
      { kind: "text", text: ", see " },
      { kind: "code", text: "fare" },
      { kind: "text", text: " at " },
      { kind: "link", text: "the site", url: "https://vueling.com/x" },
      { kind: "text", text: " " },
      { kind: "cite", sections: [1] },
      { kind: "text", text: "[5]" },
    ]);
  });

  it("links bare https addresses without their trailing punctuation", () => {
    expect(parseInline("More at https://example.com/a?b=1.")).toEqual([
      { kind: "text", text: "More at " },
      { kind: "link", text: "https://example.com/a?b=1", url: "https://example.com/a?b=1" },
      { kind: "text", text: "." },
    ]);
  });

  it("never links other schemes and leaves snake_case and 2*3*4 alone", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ kind: "text", text: "[click](javascript:alert(1))" }]);
    expect(parseInline("use my_var_name and 2*3*4")).toEqual([{ kind: "text", text: "use my_var_name and 2*3*4" }]);
    expect(parseInline("[1, 2] cites", 0)).toEqual([{ kind: "text", text: "[1, 2] cites" }]);
    expect(parseInline("[1, 2] cites", 5)).toEqual([{ kind: "cite", sections: [0, 1] }, { kind: "text", text: " cites" }]);
  });
});
