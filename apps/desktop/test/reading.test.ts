import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadingFiller, fetchArticle } from "../src/main/reading-fill";
import { ReadingStore } from "../src/main/reading-store";
import { defaultSettings, mergeSettings } from "../src/shared/settings";
import {
  type ReadingItem,
  linkOnlyReadingItem,
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

  it("marks items read and unread, and takes the read state from other devices", () => {
    const store = new ReadingStore(dir);
    store.save(item({ id: "a" }));
    store.setRead("a", true, 50);
    expect(store.get("a")?.readAt).toBe(50);
    store.setRead("a", false);
    expect(store.get("a")?.readAt).toBeUndefined();
    // Only the read state changed on the other device: the same id and savedAt still apply.
    store.applyRemote([{ url: "https://example.org/raven", item: { ...item({ id: "a" }), readAt: 70 } }]);
    expect(store.get("a")?.readAt).toBe(70);
  });

  it("keeps the article when the phone sends the link only, and fills in links saved from the phone", async () => {
    const store = new ReadingStore(dir);
    store.save(item({ id: "a" }));
    const fromPhone = { ...linkOnlyReadingItem("a", "https://example.org/raven", "", 1), readAt: 90 };
    store.applyRemote([{ url: fromPhone.url, item: fromPhone }]);
    expect(store.get("a")?.markdown).toContain("The common raven");
    expect(store.get("a")?.readAt).toBe(90);

    const saved = linkOnlyReadingItem("p", "https://news.test/story", "Shared title", 5);
    store.applyRemote([{ url: saved.url, item: saved }]);
    expect(store.linkOnly().map((i) => i.id)).toEqual(["p"]);
    const fetched: string[] = [];
    const filler = new ReadingFiller(async (url) => {
      fetched.push(url);
      return { title: "", siteName: "News", byline: "R. Porter", excerpt: "What happened.", markdown: "# Story\n\nBody", wordCount: 400, readingMinutes: 2 };
    });
    expect(await filler.run(store)).toBe(1);
    expect(await filler.run(store)).toBe(0);
    expect(fetched).toEqual(["https://news.test/story"]);
    expect(store.get("p")).toMatchObject({ title: "Shared title", siteName: "News", wordCount: 400, savedAt: 5 });
    expect(store.linkOnly()).toEqual([]);
  });

  it("reads a fetched page as an article", async () => {
    const paragraph = "The common raven is a large all-black passerine bird found across the Northern Hemisphere. ".repeat(12);
    const html = `<html><head><title>Ravens</title></head><body><article><h1>Ravens</h1>${`<p>${paragraph}</p>`.repeat(6)}</article></body></html>`;
    const article = await fetchArticle("https://birds.test/ravens", async (url) => ({ url, html }));
    expect(article?.title).toBe("Ravens");
    expect(article?.markdown).toContain("<https://birds.test/ravens>");
    expect(article?.wordCount).toBeGreaterThan(100);
    expect(await fetchArticle("https://birds.test/gone", async () => undefined)).toBeNull();
  });
});
