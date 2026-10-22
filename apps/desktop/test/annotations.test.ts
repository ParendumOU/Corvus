import { describe, expect, it } from "vitest";
import {
  type Annotation,
  ANCHOR_CONTEXT_CHARS,
  MAX_NOTE_CHARS,
  annotationsToMarkdown,
  buildAnchor,
  groupAnnotationsByPage,
  isAnnotation,
  locateAnchor,
  normalizePageUrl,
  searchAnnotations,
} from "../src/shared/annotations";

function anno(partial: Partial<Annotation>): Annotation {
  return {
    id: "a1",
    url: "https://x.example/p",
    pageTitle: "Page",
    color: "yellow",
    note: "",
    anchor: { quote: "q", prefix: "", suffix: "" },
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("annotation anchors", () => {
  const text = "The quick brown fox jumps over the lazy dog. The quick brown cat sleeps.";

  it("builds an anchor with bounded prefix/suffix context", () => {
    const start = text.indexOf("fox");
    const anchor = buildAnchor(text, start, start + 3);
    expect(anchor.quote).toBe("fox");
    expect(text.endsWith(anchor.suffix)).toBe(false);
    expect(anchor.prefix.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_CHARS);
    expect(anchor.suffix.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_CHARS);
    expect(anchor.prefix.endsWith("brown ")).toBe(true);
  });

  it("re-anchors an exact unique quote", () => {
    const start = text.indexOf("fox");
    const anchor = buildAnchor(text, start, start + 3);
    expect(locateAnchor(text, anchor)).toEqual({ start, end: start + 3 });
  });

  it("disambiguates repeated quotes using prefix/suffix context", () => {
    const first = text.indexOf("quick");
    const second = text.indexOf("quick", first + 1);
    const a1 = buildAnchor(text, first, first + 5);
    const a2 = buildAnchor(text, second, second + 5);
    expect(locateAnchor(text, a1)).toEqual({ start: first, end: first + 5 });
    expect(locateAnchor(text, a2)).toEqual({ start: second, end: second + 5 });
  });

  it("returns null when the quote no longer appears (graceful degradation)", () => {
    expect(locateAnchor("totally different content", { quote: "fox", prefix: "", suffix: "" })).toBeNull();
    expect(locateAnchor(text, { quote: "", prefix: "", suffix: "" })).toBeNull();
  });
});

describe("annotation helpers", () => {
  it("normalizes page URLs by dropping the fragment", () => {
    expect(normalizePageUrl("https://x.example/p?q=1#frag")).toBe("https://x.example/p?q=1");
    expect(normalizePageUrl("not a url")).toBe("not a url");
  });

  it("validates shape and enforces the note cap", () => {
    expect(isAnnotation(anno({}))).toBe(true);
    expect(isAnnotation(anno({ note: "x".repeat(MAX_NOTE_CHARS + 1) }))).toBe(false);
    expect(isAnnotation(anno({ color: "chartreuse" as never }))).toBe(false);
    expect(isAnnotation({ ...anno({}), anchor: { quote: "", prefix: "", suffix: "" } })).toBe(false);
  });

  it("groups by page, newest page first, items oldest first within a page", () => {
    const items = [
      anno({ id: "1", url: "https://a.example/", createdAt: 10, updatedAt: 10 }),
      anno({ id: "2", url: "https://a.example/", createdAt: 5, updatedAt: 5 }),
      anno({ id: "3", url: "https://b.example/", createdAt: 1, updatedAt: 99 }),
    ];
    const groups = groupAnnotationsByPage(items);
    expect(groups.map((g) => g.url)).toEqual(["https://b.example/", "https://a.example/"]);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(["2", "1"]);
  });

  it("searches notes, titles, host and quote", () => {
    const items = [anno({ id: "1", note: "important thought" }), anno({ id: "2", note: "", anchor: { quote: "needle", prefix: "", suffix: "" } })];
    expect(searchAnnotations(items, "important").map((a) => a.id)).toEqual(["1"]);
    expect(searchAnnotations(items, "needle").map((a) => a.id)).toEqual(["2"]);
    expect(searchAnnotations(items, "").length).toBe(2);
  });

  it("exports Markdown grouped by page", () => {
    const md = annotationsToMarkdown([
      anno({ id: "1", url: "https://a.example/", pageTitle: "Alpha", note: "a note", anchor: { quote: "hello", prefix: "", suffix: "" } }),
    ]);
    expect(md).toContain("# Annotations");
    expect(md).toContain("## Alpha");
    expect(md).toContain("<https://a.example/>");
    expect(md).toContain("> hello _(yellow)_");
    expect(md).toContain("a note");
  });
});
