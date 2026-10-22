import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadingStore } from "../src/main/reading-store";
import { defaultSettings, mergeSettings } from "../src/shared/settings";
import {
  type ReadingItem,
  readingExportFilename,
  readingItemToMarkdown,
  searchReadingItems,
  splitSentences,
} from "../src/shared/reading";

function item(overrides: Partial<ReadingItem> = {}): ReadingItem {
  return {
    id: overrides.id ?? "a",
    url: overrides.url ?? "https://example.org/raven",
    title: overrides.title ?? "The Common Raven",
    siteName: overrides.siteName ?? "Field Notes",
    byline: overrides.byline ?? "A. Ornithologist",
    excerpt: overrides.excerpt ?? "A large all-black passerine bird.",
    markdown: overrides.markdown ?? "# The Common Raven\n\n*A. Ornithologist · Field Notes*\n\n<https://example.org/raven>\n\nThe common raven is a large bird.\n\n## Range\n\nIt lives everywhere.",
    keyPoints: overrides.keyPoints ?? ["Largest songbird", "Very intelligent"],
    wordCount: overrides.wordCount ?? 320,
    readingMinutes: overrides.readingMinutes ?? 2,
    savedAt: overrides.savedAt ?? 1000,
  };
}

describe("searchReadingItems", () => {
  const items = [
    item({ id: "a", title: "Ravens", savedAt: 100 }),
    item({ id: "b", title: "Crows", url: "https://birds.test/crow", keyPoints: ["caw caw"], savedAt: 300 }),
    item({ id: "c", title: "Finches", savedAt: 200 }),
  ].map((i) => ({ ...i, markdown: undefined as never }));

  it("sorts newest first when the query is empty", () => {
    expect(searchReadingItems(items, "").map((i) => i.id)).toEqual(["b", "c", "a"]);
  });
  it("matches title, host and key points case-insensitively", () => {
    expect(searchReadingItems(items, "CROW").map((i) => i.id)).toEqual(["b"]);
    expect(searchReadingItems(items, "caw").map((i) => i.id)).toEqual(["b"]);
    expect(searchReadingItems(items, "birds.test").map((i) => i.id)).toEqual(["b"]);
  });
});

describe("readingItemToMarkdown", () => {
  it("keeps the header, inserts key points, then the body, exactly once", () => {
    const md = readingItemToMarkdown(item());
    expect(md).toContain("# The Common Raven");
    expect(md).toContain("<https://example.org/raven>");
    expect(md).toContain("## Key points\n\n- Largest songbird\n- Very intelligent");
    expect(md).toContain("The common raven is a large bird.");
    expect(md.match(/# The Common Raven/g)?.length).toBe(1);
    expect(md.endsWith("\n")).toBe(true);
  });
  it("still works when the stored markdown has no url marker", () => {
    const md = readingItemToMarkdown(item({ markdown: "Just a body." }));
    expect(md).toContain("# The Common Raven");
    expect(md).toContain("Just a body.");
  });
});

describe("readingExportFilename", () => {
  it("slugifies the title", () => {
    expect(readingExportFilename(item({ title: "The Common Raven!" }))).toBe("the-common-raven.md");
    expect(readingExportFilename(item({ title: "   " }))).toBe("article.md");
  });
});

describe("splitSentences", () => {
  it("splits on sentence boundaries and keeps punctuation", () => {
    expect(splitSentences("Hello world. How are you? Fine!")).toEqual(["Hello world.", "How are you?", "Fine!"]);
  });
  it("does not break on abbreviations or decimals", () => {
    expect(splitSentences("It cost 3.5 kg. Dr. Smith agreed.")).toEqual(["It cost 3.5 kg.", "Dr. Smith agreed."]);
  });
  it("returns a single chunk when there is no terminal punctuation", () => {
    expect(splitSentences("no period here")).toEqual(["no period here"]);
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("reader settings validation", () => {
  it("clamps font size and line width and rejects bad enums", () => {
    const base = defaultSettings();
    const merged = mergeSettings(base, { reader: { fontSize: 99, lineWidth: 5, theme: "neon", font: "comic" } });
    expect(merged.reader.fontSize).toBe(28);
    expect(merged.reader.lineWidth).toBe(36);
    expect(merged.reader.theme).toBe(base.reader.theme);
    expect(merged.reader.font).toBe(base.reader.font);
  });
  it("accepts valid reader values", () => {
    const merged = mergeSettings(defaultSettings(), { reader: { fontSize: 22, theme: "sepia", font: "sans", translateLanguage: "Spanish" } });
    expect(merged.reader).toMatchObject({ fontSize: 22, theme: "sepia", font: "sans", translateLanguage: "Spanish" });
  });
});

describe("ReadingStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "corvus-reading-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves, lists summaries without the body, and finds by url", () => {
    const store = new ReadingStore(dir);
    store.save(item({ id: "a", savedAt: 1 }));
    store.save(item({ id: "b", url: "https://other.test/x", title: "Other", savedAt: 2 }));
    const list = store.list();
    expect(list.map((i) => i.id)).toEqual(["b", "a"]);
    expect((list[0] as unknown as { markdown?: string }).markdown).toBeUndefined();
    expect(store.hasUrl("https://example.org/raven")).toBe(true);
    expect(store.hasUrl("https://nope.test")).toBe(false);
    expect(store.get("a")?.markdown).toContain("The common raven");
  });

  it("replaces an earlier save of the same url", () => {
    const store = new ReadingStore(dir);
    store.save(item({ id: "a", savedAt: 1, title: "Old" }));
    store.save(item({ id: "b", savedAt: 2, title: "New" }));
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("New");
  });

  it("removes items and persists across reloads", () => {
    const store = new ReadingStore(dir);
    store.save(item({ id: "a" }));
    store.flush();
    const reopened = new ReadingStore(dir);
    expect(reopened.list()).toHaveLength(1);
    reopened.remove("a");
    expect(reopened.list()).toHaveLength(0);
  });
});
