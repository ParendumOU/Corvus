import { describe, expect, it } from "vitest";
import {
  AgentsPausedError,
  assertAgentsRunning,
  initialAgentActivity,
  MAX_TIMELINE,
  overlayCaption,
  prettyClientName,
  reduceAgentActivity,
  summarizeArgs,
  type AgentActivityState,
} from "../src/shared/agent-activity";
import { commandForInput } from "../src/shared/shortcuts";
import {
  duplicateKey,
  findDuplicates,
  groupByDomain,
  organizerCandidates,
  proposalsFromIndices,
  sanitizeGroupsToApply,
  siteOf,
  type OrganizerTab,
} from "../src/shared/tab-organizer";

const tab = (id: string, url: string, extra: Partial<OrganizerTab> = {}): OrganizerTab => ({
  id,
  url,
  title: id,
  pinned: false,
  active: false,
  ...extra,
});

describe("agent activity reducer", () => {
  const call = (state: AgentActivityState, id: string, at: number, tool = "click", client = "claude-code") =>
    reduceAgentActivity(state, { type: "call", id, client, tool, args: { ref: "e3", tabId: "t1" }, at });

  it("records calls newest first and completes them with the matching result", () => {
    let s = call(initialAgentActivity(), "a", 100);
    s = call(s, "b", 200, "type");
    expect(s.calls.map((c) => c.id)).toEqual(["b", "a"]);
    expect(s.calls[1]).toMatchObject({ summary: "e3", durationMs: null, ok: null });
    s = reduceAgentActivity(s, { type: "result", client: "claude-code", tool: "click", at: 100, durationMs: 512, ok: true, resultChars: 2 });
    expect(s.calls[1]).toMatchObject({ durationMs: 512, ok: true, resultChars: 2 });
    expect(s.calls[0]?.durationMs).toBeNull();
  });

  it("ignores results that match no pending call", () => {
    const s = call(initialAgentActivity(), "a", 100);
    expect(reduceAgentActivity(s, { type: "result", client: "x", tool: "click", at: 100, durationMs: 1, ok: true, resultChars: 0 })).toBe(s);
  });

  it("caps the timeline", () => {
    let s = initialAgentActivity();
    for (let i = 0; i < MAX_TIMELINE + 25; i++) s = call(s, `c${i}`, i);
    expect(s.calls).toHaveLength(MAX_TIMELINE);
    expect(s.calls[0]?.id).toBe(`c${MAX_TIMELINE + 24}`);
  });

  it("tracks clients: calls, connect, reject and revoke", () => {
    let s = call(initialAgentActivity(), "a", 100);
    s = call(s, "b", 300);
    s = reduceAgentActivity(s, { type: "connect", client: "cursor", at: 50, allowed: false });
    expect(s.clients.find((c) => c.name === "claude-code")).toMatchObject({ calls: 2, firstSeen: 100, lastSeen: 300, status: "connected" });
    expect(s.clients.find((c) => c.name === "cursor")?.status).toBe("rejected");
    s = reduceAgentActivity(s, { type: "revoke", client: "claude-code" });
    expect(s.clients.find((c) => c.name === "claude-code")?.status).toBe("revoked");
    s = reduceAgentActivity(s, { type: "clear" });
    expect(s.calls).toEqual([]);
    expect(s.clients).toHaveLength(2);
  });
});

describe("pause switch", () => {
  it("throws while paused and marks refused calls as blocked", () => {
    let s = initialAgentActivity();
    expect(() => assertAgentsRunning(s)).not.toThrow();
    s = reduceAgentActivity(s, { type: "pause", paused: true });
    expect(() => assertAgentsRunning(s)).toThrow(AgentsPausedError);
    s = reduceAgentActivity(s, { type: "call", id: "x", client: "c", tool: "navigate", args: { url: "https://a.dev/" }, at: 1 });
    expect(s.calls[0]).toMatchObject({ blocked: true, ok: false, durationMs: 0 });
    s = reduceAgentActivity(s, { type: "pause", paused: false });
    expect(() => assertAgentsRunning(s)).not.toThrow();
  });

  it("returns the same state for a no-op toggle", () => {
    const s = initialAgentActivity();
    expect(reduceAgentActivity(s, { type: "pause", paused: false })).toBe(s);
  });
});

describe("activity labels", () => {
  it("summarizes common tool arguments", () => {
    expect(summarizeArgs("navigate", { url: "https://www.example.com/a/b?q=1" })).toBe("www.example.com/a/b");
    expect(summarizeArgs("type", { ref: "e4", text: "hello", submit: true })).toBe('"hello" into e4, submit');
    expect(summarizeArgs("web_search", { query: "rust async" })).toBe('"rust async"');
    expect(summarizeArgs("tabs_list", {})).toBe("");
    expect(summarizeArgs("unknown_tool", { a: 1, tabId: "t" })).toBe("a=1");
  });

  it("builds overlay captions and masks secrets", () => {
    expect(prettyClientName("claude-code")).toBe("Claude Code");
    expect(prettyClientName("my_agent")).toBe("My Agent");
    expect(overlayCaption("claude-code", { kind: "click", label: "Sign in" })).toBe("Claude Code: clicking 'Sign in'");
    expect(overlayCaption("claude-code", { kind: "type", label: "Password", text: "hunter2", secret: true })).toBe(
      "Claude Code: typing '•••••••' into 'Password'",
    );
    expect(overlayCaption("x", { kind: "navigate", url: "https://news.ycombinator.com/" })).toBe("X: opening news.ycombinator.com");
  });
});

describe("tab organizer", () => {
  const tabs = [
    tab("1", "https://github.com/a/b"),
    tab("2", "https://docs.github.com/en"),
    tab("3", "https://www.bbc.co.uk/news"),
    tab("4", "https://bbc.co.uk/sport"),
    tab("5", "https://example.org/", { pinned: true }),
    tab("6", "https://example.org/x", { groupId: "g1" }),
    tab("7", "corvus://newtab/"),
    tab("8", "https://solo.dev/"),
  ];

  it("derives the site from a URL", () => {
    expect(siteOf("https://docs.github.com/x")).toBe("github.com");
    expect(siteOf("https://www.bbc.co.uk/")).toBe("bbc.co.uk");
    expect(siteOf("http://127.0.0.1:8080/")).toBe("127.0.0.1");
    expect(siteOf("not a url")).toBe("");
  });

  it("only regroups ungrouped, unpinned web tabs", () => {
    expect(organizerCandidates(tabs).map((t) => t.id)).toEqual(["1", "2", "3", "4", "8"]);
  });

  it("falls back to one group per site with 2+ tabs", () => {
    const groups = groupByDomain(tabs);
    expect(groups.map((g) => [g.name, g.tabIds])).toEqual([
      ["Github", ["1", "2"]],
      ["Bbc", ["3", "4"]],
    ]);
    expect(new Set(groups.map((g) => g.color)).size).toBe(2);
  });

  it("finds duplicates and keeps the active tab", () => {
    const dups = findDuplicates([
      tab("a", "https://x.dev/page#top"),
      tab("b", "https://www.x.dev/page/", { active: true }),
      tab("c", "https://x.dev/page?b=2&a=1"),
      tab("d", "https://x.dev/page?a=1&b=2"),
      tab("e", "corvus://newtab/"),
      tab("f", "corvus://newtab/"),
    ]);
    expect(dups).toEqual([
      { tabId: "a", title: "a", url: "https://x.dev/page#top", keepId: "b" },
      { tabId: "d", title: "d", url: "https://x.dev/page?a=1&b=2", keepId: "c" },
    ]);
    expect(duplicateKey("https://x.dev/p?b=2&a=1")).toBe(duplicateKey("http://www.x.dev/p/?a=1&b=2"));
  });

  it("maps AI indices to tab ids and drops tiny groups", () => {
    const candidates = organizerCandidates(tabs);
    expect(
      proposalsFromIndices(
        [
          { name: "Code", color: "blue", tabs: [0, 1] },
          { name: "News", color: "nope", tabs: [2, 3, 99] },
          { name: "Solo", color: "red", tabs: [4] },
        ],
        candidates,
      ),
    ).toEqual([
      { name: "Code", color: "blue", tabIds: ["1", "2"] },
      { name: "News", color: expect.any(String), tabIds: ["3", "4"] },
    ]);
  });

  it("sanitizes edited groups from the preview", () => {
    const known = new Set(["1", "2", "3"]);
    expect(
      sanitizeGroupsToApply(
        [
          { name: "  A   b ", color: "green", tabIds: ["1", "2", "zz"] },
          { name: "B", color: "evil", tabIds: ["2", "3"] },
          { name: "C", color: "red", tabIds: [] },
          "junk",
        ],
        known,
      ),
    ).toEqual([
      { name: "A b", color: "green", tabIds: ["1", "2"] },
      { name: "B", color: "grey", tabIds: ["3"] },
    ]);
    expect(sanitizeGroupsToApply("nope", known)).toEqual([]);
  });
});

describe("assist shortcuts", () => {
  const key = (k: string, mods: Partial<{ control: boolean; meta: boolean; shift: boolean }>) => ({
    type: "keyDown",
    key: k,
    control: false,
    meta: false,
    shift: false,
    alt: false,
    ...mods,
  });
  it("maps Ctrl+Shift+A and Ctrl+Shift+O", () => {
    expect(commandForInput(key("A", { control: true, shift: true }), "win32")).toEqual({ type: "toggle-assist" });
    expect(commandForInput(key("O", { control: true, shift: true }), "linux")).toEqual({ type: "organize-tabs" });
    expect(commandForInput(key("a", { meta: true, shift: true }), "darwin")).toEqual({ type: "toggle-assist" });
  });
});
