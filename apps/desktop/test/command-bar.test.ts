import { describe, expect, it } from "vitest";
import { fuzzyScore, looksLikeTask, parseCommandInput, rankActions, type PaletteAction } from "../src/shared/command-bar";
import { classifyAction, isChallengeHandoff } from "../src/shared/agent-safety";

describe("fuzzyScore", () => {
  it("returns a score only for subsequence matches", () => {
    expect(fuzzyScore("stg", "Open settings")).not.toBeNull();
    expect(fuzzyScore("zzz", "Open settings")).toBeNull();
  });

  it("scores a prefix higher than a scattered match", () => {
    const prefix = fuzzyScore("set", "settings")!;
    const scattered = fuzzyScore("set", "save every tab")!;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("rewards word-boundary starts", () => {
    const boundary = fuzzyScore("nt", "new tab")!;
    const inside = fuzzyScore("nt", "fonts panel")!;
    expect(boundary).toBeGreaterThan(inside);
  });

  it("treats an empty query as a neutral match", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

const actions: PaletteAction[] = [
  { id: "newtab", kind: "command", title: "New tab", icon: "newtab", priority: 5 },
  { id: "settings", kind: "command", title: "Open settings", icon: "settings", priority: 3 },
  { id: "ext", kind: "command", title: "Open extensions", icon: "extensions", priority: 2 },
  { id: "tab:1", kind: "tab", title: "GitHub — pull request", keywords: "https://github.com/x/y/pull/1", icon: "tab" },
  { id: "bm:1", kind: "bookmark", title: "Hacker News", keywords: "https://news.ycombinator.com", icon: "bookmark" },
];

describe("rankActions", () => {
  it("keeps priority order when the query is empty", () => {
    const ranked = rankActions("", actions);
    expect(ranked.map((a) => a.id)).toEqual(["newtab", "settings", "ext", "tab:1", "bm:1"]);
  });

  it("filters and ranks by match quality", () => {
    const ranked = rankActions("set", actions);
    expect(ranked[0]!.id).toBe("settings");
    expect(ranked.some((a) => a.id === "newtab")).toBe(false);
  });

  it("matches against keywords (URLs) too", () => {
    const ranked = rankActions("github", actions);
    expect(ranked[0]!.id).toBe("tab:1");
  });

  it("respects the limit", () => {
    expect(rankActions("open", actions, 1)).toHaveLength(1);
  });
});

describe("parseCommandInput / looksLikeTask", () => {
  it("switches to agent mode on the > prefix", () => {
    expect(parseCommandInput("> book me a flight")).toEqual({ mode: "agent", query: "book me a flight" });
    expect(parseCommandInput(">buy milk")).toEqual({ mode: "agent", query: "buy milk" });
    expect(parseCommandInput("settings")).toEqual({ mode: "command", query: "settings" });
  });

  it("detects task-like input by its verb and length", () => {
    expect(looksLikeTask("find the cheapest flight to Lisbon")).toBe(true);
    expect(looksLikeTask("compare iPhone 16 prices")).toBe(true);
    expect(looksLikeTask("github")).toBe(false);
    expect(looksLikeTask("new tab")).toBe(false);
  });
});

describe("classifyAction", () => {
  it("allows read-only tools without approval", () => {
    for (const tool of ["page_snapshot", "screenshot", "extract", "wait", "web_search", "scroll", "list_tabs"]) {
      expect(classifyAction(tool, {}).risky).toBe(false);
    }
  });

  it("flags a click on a committing button", () => {
    const risk = classifyAction("click", { ref: "e1" }, "Place order");
    expect(risk.risky).toBe(true);
    expect(risk.reason).toContain("Place order");
  });

  it("allows a click on a plain link", () => {
    expect(classifyAction("click", { ref: "e2" }, "Read more").risky).toBe(false);
  });

  it("flags form submission and secret fields", () => {
    expect(classifyAction("type", { ref: "e1", text: "x", submit: true }).risky).toBe(true);
    const secret = classifyAction("type", { ref: "e1", text: "x" }, "Password");
    expect(secret.risky).toBe(true);
    expect(secret.handoff).toBe(true);
  });

  it("flags navigation to login or payment pages", () => {
    expect(classifyAction("navigate", { url: "https://shop.test/checkout" }).risky).toBe(true);
    expect(classifyAction("navigate", { url: "https://example.com/article" }).risky).toBe(false);
  });

  it("treats unknown tools as risky", () => {
    expect(classifyAction("delete_everything", {}).risky).toBe(true);
  });

  it("always asks before using a saved login or 2FA code", () => {
    for (const tool of ["fill_login", "fill_totp"]) {
      const risk = classifyAction(tool, { ref: "e3" });
      expect(risk.risky).toBe(true);
      expect(risk.alwaysAsk).toBe(true);
      expect(risk.handoff).toBe(false);
    }
    // Spending money always asks too; an ordinary risky click (deleting, signing in) does not.
    expect(classifyAction("click", { ref: "e1" }, "Place order").alwaysAsk).toBe(true);
    expect(classifyAction("click", { ref: "e1" }, "Delete").alwaysAsk).toBeUndefined();
  });

  it("still hands typing into a 2FA field to the person", () => {
    const risk = classifyAction("type", { ref: "e1", text: "123456" }, "2FA code");
    expect(risk.handoff).toBe(true);
  });

  it("detects a challenge handoff", () => {
    expect(isChallengeHandoff("recaptcha")).toBe(true);
    expect(isChallengeHandoff(undefined)).toBe(false);
  });
});
