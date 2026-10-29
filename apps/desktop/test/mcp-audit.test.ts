import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpAuditLog } from "../src/main/mcp-audit";
import type { McpActivityEntry } from "../src/shared/ipc";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-audit-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<McpActivityEntry> = {}): McpActivityEntry => ({
  at: NOW,
  client: "claude-code",
  tool: "click",
  host: "shop.example",
  outcome: "ok",
  durationMs: 40,
  ...over,
});

describe("McpAuditLog", () => {
  it("records calls, lists them newest first and keeps them across restarts", () => {
    const log = new McpAuditLog(dir, () => true, () => NOW);
    log.record(entry({ at: NOW - 2000, tool: "navigate" }));
    log.record(entry({ at: NOW - 1000, tool: "click", outcome: "error", error: "click failed: Element e3 not found" }));
    log.record(entry({ at: NOW, tool: "tabs_list", client: "cursor", host: "", outcome: "rate-limited", durationMs: 0 }));
    expect(log.list().map((e) => e.tool)).toEqual(["tabs_list", "click", "navigate"]);
    const again = new McpAuditLog(dir, () => true, () => NOW);
    expect(again.list({ client: "claude-code" }).map((e) => e.tool)).toEqual(["click", "navigate"]);
    expect(again.list({ problemsOnly: true }).map((e) => e.outcome)).toEqual(["rate-limited", "error"]);
    expect(again.list({ limit: 1 })).toHaveLength(1);
    expect(again.clients()).toEqual(["cursor", "claude-code"]);
  });

  it("pages through the matching calls, newest first, with how many match in all", () => {
    const log = new McpAuditLog(dir, () => true, () => NOW);
    for (let i = 0; i < 12; i++) log.record(entry({ at: NOW - (12 - i) * 1000, tool: `t${i}`, outcome: i % 5 === 4 ? "error" : "ok" }));
    expect(log.page({ limit: 5 })).toEqual({ entries: log.list({ limit: 5 }), total: 12 });
    expect(log.page({ limit: 5, offset: 5 }).entries.map((e) => e.tool)).toEqual(["t6", "t5", "t4", "t3", "t2"]);
    expect(log.page({ limit: 5, offset: 10 }).entries.map((e) => e.tool)).toEqual(["t1", "t0"]);
    expect(log.page({ limit: 5, offset: 20 })).toEqual({ entries: [], total: 12 });
    expect(log.page({ limit: 5, problemsOnly: true })).toEqual({ entries: [expect.objectContaining({ tool: "t9" }), expect.objectContaining({ tool: "t4" })], total: 2 });
  });

  it("records nothing while the log is off", () => {
    let on = false;
    const log = new McpAuditLog(dir, () => on, () => NOW);
    log.record(entry());
    expect(log.list()).toEqual([]);
    on = true;
    log.record(entry());
    expect(log.list()).toHaveLength(1);
  });

  it("sums up each tool over a window: calls, errors, over the limit and mean time", () => {
    const log = new McpAuditLog(dir, () => true, () => NOW);
    log.record(entry({ at: NOW - 2 * DAY, tool: "click" }));
    log.record(entry({ tool: "click", durationMs: 10 }));
    log.record(entry({ tool: "click", durationMs: 30, outcome: "error" }));
    log.record(entry({ tool: "click", durationMs: 0, outcome: "rate-limited" }));
    log.record(entry({ tool: "navigate", durationMs: 500 }));
    log.record(entry({ tool: "(connected)", host: "", durationMs: 0 }));
    expect(log.list().map((e) => e.tool)).toContain("(connected)");
    expect(log.summary(NOW - DAY)).toEqual([
      { tool: "click", calls: 3, errors: 1, rateLimited: 1, avgMs: 20 },
      { tool: "navigate", calls: 1, errors: 0, rateLimited: 0, avgMs: 500 },
    ]);
  });

  it("drops entries older than 30 days and corrupt lines when it loads", () => {
    const file = path.join(dir, "mcp-activity.jsonl");
    const lines = [JSON.stringify(entry({ at: NOW - 31 * DAY, tool: "old" })), "{not json", JSON.stringify({ at: NOW, tool: "x", outcome: "maybe" }), JSON.stringify(entry({ tool: "kept" }))];
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const log = new McpAuditLog(dir, () => true, () => NOW);
    expect(log.list().map((e) => e.tool)).toEqual(["kept"]);
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("clips long fields and never keeps unknown ones", () => {
    const log = new McpAuditLog(dir, () => true, () => NOW);
    log.record({ ...entry({ error: "e".repeat(1000) }), args: { text: "secret" } } as McpActivityEntry);
    const [saved] = log.list();
    expect(saved!.error).toHaveLength(200);
    expect(Object.keys(saved!).sort()).toEqual(["at", "client", "durationMs", "error", "host", "outcome", "tool"]);
    expect(fs.readFileSync(path.join(dir, "mcp-activity.jsonl"), "utf8")).not.toContain("secret");
  });

  it("clears the log", () => {
    const log = new McpAuditLog(dir, () => true, () => NOW);
    log.record(entry());
    log.clear();
    expect(log.list()).toEqual([]);
    expect(new McpAuditLog(dir, () => true, () => NOW).list()).toEqual([]);
  });

  it("exports CSV oldest first, quoting and defusing spreadsheet formulas", () => {
    const log = new McpAuditLog(dir, () => true, () => NOW);
    log.record(entry({ at: NOW - 1000, tool: "navigate", host: "a.example" }));
    log.record(entry({ client: "=cmd|calc", outcome: "error", error: 'failed: "quoted", with comma' }));
    log.record(entry({ tool: "navigate", host: "10.0.10.1", certificateError: "ERR_CERT_AUTHORITY_INVALID" }));
    const rows = log.csv().trim().split("\n");
    expect(rows[0]).toBe("time,client,tool,site,outcome,duration_ms,error,certificate_error");
    expect(rows[1]).toBe(`${new Date(NOW - 1000).toISOString()},claude-code,navigate,a.example,ok,40,,`);
    expect(rows[2]).toBe(`${new Date(NOW).toISOString()},'=cmd|calc,click,shop.example,error,40,"failed: ""quoted"", with comma",`);
    expect(rows[3]).toBe(`${new Date(NOW).toISOString()},claude-code,navigate,10.0.10.1,ok,40,,ERR_CERT_AUTHORITY_INVALID`);
  });

  it("keeps the certificate error a call went on past, across restarts", () => {
    const log = new McpAuditLog(dir, () => true, () => NOW);
    log.record(entry({ tool: "navigate", host: "10.0.10.1", certificateError: "ERR_CERT_AUTHORITY_INVALID" }));
    log.record(entry());
    const entries = new McpAuditLog(dir, () => true, () => NOW).list();
    expect(entries.map((e) => e.certificateError ?? null)).toEqual([null, "ERR_CERT_AUTHORITY_INVALID"]);
  });
});
