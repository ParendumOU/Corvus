import { describe, expect, it } from "vitest";
import type { Bookmark } from "@corvus/shared";
import { queryHistory, recordVisit, removeEntries, topSites, updateEntry, type HistoryRecord } from "../src/shared/history-ops";
import { isAgentAllowedUrl, internalPageOf } from "../src/shared/internal-urls";
import { defaultSettings, mcpAddCommand, mergeSettings } from "../src/shared/settings";
import { commandForInput, type KeyInput } from "../src/shared/shortcuts";
import { buildSuggestions } from "../src/shared/suggest";

describe("history", () => {
  it("merges repeat visits by URL and moves them to the top", () => {
    let list: HistoryRecord[] = [];
    list = recordVisit(list, { url: "https://a.test/", title: "A" }, "1", 1);
    list = recordVisit(list, { url: "https://b.test/", title: "B" }, "2", 2);
    list = recordVisit(list, { url: "https://a.test/", title: "" }, "3", 3);
    expect(list.map((e) => [e.url, e.visitCount, e.title])).toEqual([
      ["https://a.test/", 2, "A"],
      ["https://b.test/", 1, "B"],
    ]);
  });

  it("prunes beyond the cap", () => {
    let list: HistoryRecord[] = [];
    for (let i = 0; i < 5; i++) list = recordVisit(list, { url: `https://${i}.test/`, title: "" }, String(i), i, 3);
    expect(list.map((e) => e.id)).toEqual(["4", "3", "2"]);
  });

  it("queries by all terms, newest first, with paging", () => {
    let list: HistoryRecord[] = [];
    list = recordVisit(list, { url: "https://docs.rust-lang.org/", title: "Rust docs" }, "1", 1);
    list = recordVisit(list, { url: "https://rust.test/book", title: "The Book" }, "2", 2);
    list = recordVisit(list, { url: "https://go.dev/", title: "Go" }, "3", 3);
    expect(queryHistory(list, "rust").entries.map((e) => e.id)).toEqual(["2", "1"]);
    expect(queryHistory(list, "rust docs").entries.map((e) => e.id)).toEqual(["1"]);
    expect(queryHistory(list, "", 1, 1)).toMatchObject({ total: 3, entries: [{ id: "2" }] });
  });

  it("updates titles/favicons and removes entries", () => {
    let list = recordVisit([], { url: "https://a.test/", title: "A" }, "1", 1);
    const same = updateEntry(list, "https://a.test/", { title: "A" });
    expect(same).toBe(list);
    list = updateEntry(list, "https://a.test/", { title: "Alpha", faviconUrl: "https://a.test/f.ico" });
    expect(list[0]).toMatchObject({ title: "Alpha", faviconUrl: "https://a.test/f.ico" });
    expect(removeEntries(list, ["1"])).toEqual([]);
  });

  it("lists top sites once per host", () => {
    let list: HistoryRecord[] = [];
    list = recordVisit(list, { url: "https://a.test/1", title: "" }, "1", 1);
    list = recordVisit(list, { url: "https://a.test/2", title: "" }, "2", 2);
    list = recordVisit(list, { url: "https://a.test/2", title: "" }, "3", 3);
    list = recordVisit(list, { url: "https://b.test/", title: "" }, "4", 4);
    expect(topSites(list).map((e) => e.url)).toEqual(["https://a.test/2", "https://b.test/"]);
  });
});

describe("suggestions", () => {
  const history = [
    { id: "1", url: "https://github.com/", title: "GitHub", visitedAt: 0, visitCount: 50 },
    { id: "2", url: "https://gist.github.com/", title: "Gists", visitedAt: 0, visitCount: 1 },
    { id: "3", url: "https://example.com/", title: "Example", visitedAt: 0, visitCount: 3 },
  ];
  const bookmarks: Bookmark[] = [
    { id: "b", parentId: "bar", kind: "bookmark", title: "GitLab", url: "https://gitlab.com/", position: 0, createdAt: 0, updatedAt: 0 },
  ];

  it("puts the typed intent first, then ranked matches", () => {
    const s = buildSuggestions("git", history, bookmarks, 1);
    expect(s[0]).toMatchObject({ kind: "search", url: "corvus://search?q=git" });
    expect(s.slice(1).map((x) => x.url)).toEqual(["https://github.com/", "https://gitlab.com/", "https://gist.github.com/"]);
  });

  it("offers navigation for URL-like input and dedupes it", () => {
    const s = buildSuggestions("github.com", history, [], 1);
    expect(s[0]).toMatchObject({ kind: "url", url: "https://github.com/" });
    expect(s.filter((x) => x.url === "https://github.com/")).toHaveLength(1);
  });

  it("returns nothing for empty input", () => {
    expect(buildSuggestions("  ", history, bookmarks, 1)).toEqual([]);
  });
});

describe("agent URL policy", () => {
  it.each([
    ["https://example.com", true],
    ["http://localhost:3000", true],
    ["about:blank", true],
    ["corvus://search?q=x", true],
    ["corvus://newtab/", true],
    ["corvus://settings", false],
    ["corvus://extensions", false],
    ["file:///etc/passwd", false],
    ["javascript:alert(1)", false],
    ["chrome-extension://abc/x.html", false],
    ["data:text/html,hi", false],
    ["not a url", false],
  ])("%s -> %s", (url, allowed) => {
    expect(isAgentAllowedUrl(url)).toBe(allowed);
  });

  it("recognises internal pages", () => {
    expect(internalPageOf("corvus://settings/#mcp")).toBe("settings");
    expect(internalPageOf("corvus://unknown")).toBeNull();
    expect(internalPageOf("https://settings")).toBeNull();
  });
});

describe("settings", () => {
  it("merges valid values and ignores junk", () => {
    const base = defaultSettings();
    const merged = mergeSettings(base, {
      ai: { model: "claude-sonnet-5", maxOutputTokens: "lots", provider: "evil" },
      mcp: { port: 70000, approvedClients: ["claude-code", 5] },
      bogus: { x: 1 },
      appearance: { theme: "dark" },
    });
    expect(merged.ai.model).toBe("claude-sonnet-5");
    expect(merged.ai.maxOutputTokens).toBe(400);
    expect(merged.ai.provider).toBe("anthropic-api");
    expect(merged.mcp.port).toBe(0);
    expect(merged.mcp.approvedClients).toEqual([]);
    expect(merged.appearance.theme).toBe("dark");
    expect(base.appearance.theme).toBe("system");
  });

  it("reads defaults from the environment", () => {
    const s = defaultSettings({ CORVUS_AI_PROVIDER: "claude-code-cli", CORVUS_RETRIEVER: "brave", CORVUS_SEARXNG_URL: "http://sx:8080" });
    expect(s.ai).toMatchObject({ provider: "claude-code-cli", retriever: "brave", searxngUrl: "http://sx:8080" });
  });

  it("defaults update settings and reads the feed from the environment", () => {
    expect(defaultSettings().update).toEqual({ autoCheck: true, channel: "stable", feedUrl: "" });
    const s = defaultSettings({ CORVUS_UPDATE_CHANNEL: "beta", CORVUS_UPDATE_FEED_URL: "https://feed.test/corvus" });
    expect(s.update).toEqual({ autoCheck: true, channel: "beta", feedUrl: "https://feed.test/corvus" });
  });

  it("validates the update channel and clamps the feed URL", () => {
    const base = defaultSettings();
    expect(mergeSettings(base, { update: { channel: "nope" } }).update.channel).toBe("stable");
    expect(mergeSettings(base, { update: { channel: "beta", autoCheck: false } }).update).toMatchObject({ channel: "beta", autoCheck: false });
    expect(mergeSettings(base, { update: { feedUrl: "x".repeat(5000) } }).update.feedUrl).toHaveLength(2048);
  });

  it("formats the claude mcp add command", () => {
    expect(mcpAddCommand(4321, "tok")).toBe(
      'claude mcp add --transport http corvus http://127.0.0.1:4321/mcp --header "Authorization: Bearer tok"',
    );
  });
});

describe("shortcuts", () => {
  const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
    type: "keyDown",
    key: k,
    control: false,
    meta: false,
    shift: false,
    alt: false,
    ...mods,
  });

  it.each([
    [key("t", { control: true }), { type: "new-tab" }],
    [key("T", { control: true, shift: true }), { type: "reopen-closed-tab" }],
    [key("w", { control: true }), { type: "close-tab" }],
    [key("l", { control: true }), { type: "focus-omnibox" }],
    [key("Tab", { control: true }), { type: "next-tab" }],
    [key("Tab", { control: true, shift: true }), { type: "prev-tab" }],
    [key("r", { control: true }), { type: "reload", hard: false }],
    [key("F5"), { type: "reload", hard: false }],
    [key("3", { control: true }), { type: "select-tab", n: 3 }],
    [key("ArrowLeft", { alt: true }), { type: "back" }],
    [key("d", { control: true }), { type: "bookmark-page" }],
  ])("maps %o on linux/windows", (input, expected) => {
    expect(commandForInput(input, "linux")).toEqual(expected);
    expect(commandForInput(input, "win32")).toEqual(expected);
  });

  it("uses Cmd on macOS", () => {
    expect(commandForInput(key("t", { meta: true }), "darwin")).toEqual({ type: "new-tab" });
    expect(commandForInput(key("t", { control: true }), "darwin")).toBeNull();
    expect(commandForInput(key("Tab", { control: true }), "darwin")).toEqual({ type: "next-tab" });
  });

  it("ignores plain typing and key-up events", () => {
    expect(commandForInput(key("t"), "linux")).toBeNull();
    expect(commandForInput({ ...key("t", { control: true }), type: "keyUp" }, "linux")).toBeNull();
  });
});
