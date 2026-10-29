import { describe, expect, it, vi } from "vitest";
import { WebScopeEngine } from "../src/engine.js";
import { HistoryBuffer } from "../src/history.js";
import type { HistoryEntry, Scope } from "../src/types.js";

function entry(id: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    profileId: "p1",
    startedAt: 1,
    host: "example.com",
    path: `/${id}`,
    type: "document",
    inScope: true,
    source: "capture",
    request: { method: "GET", url: `https://example.com/${id}`, headers: [] },
    response: { status: 200, headers: [], body: `body of ${id}` },
    ...over,
  };
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

describe("HistoryBuffer live cursor", () => {
  it("returns everything with reset when there is no cursor, then only what came after it", () => {
    const history = new HistoryBuffer();
    history.add(entry("a"));
    history.add(entry("b"));
    const first = history.querySince({}, null, 100);
    expect(first.reset).toBe(true);
    expect(ids(first.rows)).toEqual(["b", "a"]);

    history.add(entry("c"));
    history.add(entry("d"));
    const next = history.querySince({}, first.cursor, 100);
    expect(next.reset).toBe(false);
    expect(ids(next.rows)).toEqual(["d", "c"]);
    expect(history.querySince({}, next.cursor, 100).rows).toEqual([]);
  });

  it("hands back an updated entry again, and applies the filter and limit to new rows only", () => {
    const history = new HistoryBuffer();
    history.add(entry("a"));
    history.add(entry("b", { host: "other.test" }));
    const { cursor } = history.querySince({}, null, 100);
    history.add(entry("a", { response: { status: 500, headers: [] } }));
    history.add(entry("c"));
    history.add(entry("d", { host: "other.test" }));
    const page = history.querySince({ host: "example.com" }, cursor, 100);
    expect(ids(page.rows)).toEqual(["c", "a"]);
    expect(page.rows[1]?.status).toBe(500);
    expect(ids(history.querySince({}, cursor, 1).rows)).toEqual(["d"]);
  });

  it("resets readers after a clear, and after evictions they only see what is still there", () => {
    const history = new HistoryBuffer(2);
    history.add(entry("a"));
    const { cursor } = history.querySince({}, null, 100);
    history.clear();
    history.add(entry("b"));
    const page = history.querySince({}, cursor, 100);
    expect(page.reset).toBe(true);
    expect(ids(page.rows)).toEqual(["b"]);

    history.add(entry("c"));
    history.add(entry("d"));
    expect(ids(history.querySince({}, page.cursor, 100).rows)).toEqual(["d", "c"]);
    expect(history.size()).toBe(2);
  });

  it("tells listeners about adds, updates and clears, and a failing listener breaks nothing", () => {
    const history = new HistoryBuffer();
    const seen = vi.fn();
    history.onChange(() => {
      throw new Error("listener bug");
    });
    const off = history.onChange(seen);
    history.add(entry("a"));
    history.add(entry("a"));
    history.clear();
    expect(seen).toHaveBeenCalledTimes(3);
    off();
    history.add(entry("b"));
    expect(seen).toHaveBeenCalledTimes(3);
    expect(history.size()).toBe(1);
  });
});

describe("WebScopeEngine change events", () => {
  const scope: Scope = { enabled: true, include: [{ host: "example.com", enabled: true }], exclude: [] };

  it("reports history, config and intercept changes", async () => {
    const engine = new WebScopeEngine();
    const changes: string[] = [];
    const off = engine.onChange((c) => changes.push(c));
    engine.history.add(entry("a"));
    engine.setScope(scope);
    engine.setRules({ matchReplace: [], block: [], hostOverride: [] });
    await engine.setInterceptConfig({ enabled: true, interceptRequests: true, interceptResponses: false });
    engine.clearHistory();
    expect(changes).toEqual(["history", "config", "config", "intercept", "config", "history"]);
    off();
    engine.history.add(entry("b"));
    expect(changes).toHaveLength(6);
  });

  it("pages history for live views, redacted for AI readers", () => {
    const engine = new WebScopeEngine();
    engine.history.add(entry("a"));
    const { cursor } = engine.historyPage({}, null, 10);
    engine.history.add(entry("secret", { aiHidden: true, request: { method: "POST", url: "https://example.com/login", headers: [], body: "password=hunter2" } }));
    expect(ids(engine.historyPage({ search: "hunter2" }, cursor, 10).rows)).toEqual(["secret"]);
    expect(engine.historyPage({ search: "hunter2" }, cursor, 10, { forAi: true }).rows).toEqual([]);
  });
});
