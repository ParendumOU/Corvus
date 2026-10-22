import { describe, expect, it } from "vitest";
import { findRanges, matchSection, normalizeQuery, type SectionIndexEntry } from "../src/renderer/pages/settings-search-lib";

const section: SectionIndexEntry = {
  title: "AI search",
  description: "Searches run against a retriever first. One small-model call writes a cited answer.",
  rows: [
    { label: "AI provider", hint: "Anthropic API with your own key." },
    { label: "Model", hint: "A small, fast model keeps answers cheap." },
    { label: "Answer language", hint: "" },
  ],
};

describe("normalizeQuery", () => {
  it("lowercases, trims and collapses whitespace", () => {
    expect(normalizeQuery("  Dark   Mode  ")).toBe("dark mode");
    expect(normalizeQuery("")).toBe("");
  });
});

describe("matchSection", () => {
  it("shows everything when the query is empty", () => {
    const m = matchSection(section, "");
    expect(m).toEqual({ visible: true, sectionHit: false, rowVisible: [true, true, true] });
  });

  it("surfaces the whole section when the title matches", () => {
    const m = matchSection(section, "ai search");
    expect(m.visible).toBe(true);
    expect(m.sectionHit).toBe(true);
    expect(m.rowVisible).toEqual([true, true, true]);
  });

  it("surfaces the whole section when the description matches", () => {
    const m = matchSection(section, "cited answer");
    expect(m.sectionHit).toBe(true);
    expect(m.rowVisible.every(Boolean)).toBe(true);
  });

  it("shows only matching rows on a label hit", () => {
    const m = matchSection(section, "provider");
    expect(m.visible).toBe(true);
    expect(m.sectionHit).toBe(false);
    expect(m.rowVisible).toEqual([true, false, false]);
  });

  it("matches on help text (hint)", () => {
    const m = matchSection(section, "anthropic");
    expect(m.rowVisible).toEqual([true, false, false]);
  });

  it("hides the section when nothing matches", () => {
    const m = matchSection(section, "bluetooth");
    expect(m.visible).toBe(false);
    expect(m.rowVisible).toEqual([false, false, false]);
  });
});

describe("findRanges", () => {
  it("returns non-overlapping case-insensitive ranges", () => {
    expect(findRanges("Answer the answer", "answer")).toEqual([
      [0, 6],
      [11, 17],
    ]);
  });

  it("returns nothing for an empty query or no match", () => {
    expect(findRanges("anything", "")).toEqual([]);
    expect(findRanges("anything", "zzz")).toEqual([]);
  });
});
