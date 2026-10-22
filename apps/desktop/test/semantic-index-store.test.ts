import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SemanticIndexStore } from "../src/main/semantic-index-store";
import { defaultSettings, mergeSettings } from "../src/shared/settings";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "corvus-semidx-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SemanticIndexStore", () => {
  it("indexes visits, bookmarks and reading separately and keyed by kind+url", () => {
    const store = new SemanticIndexStore(dir);
    store.addVisit("https://a.example/", "A", "alpha body", 1);
    store.addBookmark("https://a.example/", "A bookmark", 2);
    store.addReading("https://a.example/", "A article", "reading body", 3);
    const all = store.all();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((d) => d.kind))).toEqual(new Set(["history", "bookmark", "reading"]));
  });

  it("keeps an earlier captured snippet when a later title-only visit arrives", () => {
    const store = new SemanticIndexStore(dir);
    store.addVisit("https://a.example/", "A", "captured text", 1);
    store.addVisit("https://a.example/", "A v2", "", 2);
    const doc = store.all().find((d) => d.kind === "history");
    expect(doc?.text).toBe("captured text");
    expect(doc?.title).toBe("A v2");
  });

  it("replaceKind swaps one source wholesale and leaves others intact", () => {
    const store = new SemanticIndexStore(dir);
    store.addVisit("https://h.example/", "H", "body", 1);
    store.replaceKind("bookmark", [{ url: "https://b.example/", title: "B", text: "", ts: 2 }]);
    store.replaceKind("bookmark", [{ url: "https://c.example/", title: "C", text: "", ts: 3 }]);
    const urls = store.all().map((d) => d.url).sort();
    expect(urls).toEqual(["https://c.example/", "https://h.example/"]);
  });

  it("removeUrl drops every kind for that URL", () => {
    const store = new SemanticIndexStore(dir);
    store.addVisit("https://a.example/", "A", "x", 1);
    store.addBookmark("https://a.example/", "A", 2);
    store.removeUrl("https://a.example/");
    expect(store.size()).toBe(0);
  });

  it("persists and reloads across instances", () => {
    const store = new SemanticIndexStore(dir);
    store.addVisit("https://a.example/", "A", "body", 1);
    store.flush();
    const reopened = new SemanticIndexStore(dir);
    expect(reopened.size()).toBe(1);
  });
});

describe("semanticSearch settings", () => {
  it("defaults to index on, embeddings off", () => {
    const s = defaultSettings().semanticSearch;
    expect(s.indexPages).toBe(true);
    expect(s.useEmbeddings).toBe(false);
    expect(s.embeddingModel).toBe("nomic-embed-text");
  });

  it("merges booleans and keeps a non-empty model, falling back when blanked", () => {
    const base = defaultSettings();
    const merged = mergeSettings(base, { semanticSearch: { useEmbeddings: true, embeddingModel: "  mxbai-embed  " } });
    expect(merged.semanticSearch.useEmbeddings).toBe(true);
    expect(merged.semanticSearch.embeddingModel).toBe("mxbai-embed");
    const blanked = mergeSettings(base, { semanticSearch: { embeddingModel: "   " } });
    expect(blanked.semanticSearch.embeddingModel).toBe("nomic-embed-text");
  });
});
