import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@corvus/ai-engine";
import { MAX_STORED_RUNS } from "../src/shared/agent-run";
import { AgentRunStore, type StoredAgentRun } from "../src/main/agent-run-store";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-runs-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const transcript: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: "task" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "a", name: "navigate", input: {} }] },
  { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "ok" }] },
];

function makeRun(over: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    id: over.id ?? "r1",
    task: "buy the umbrella",
    source: "command-bar",
    status: "done",
    stopReason: "done",
    steps: [{ id: "a", kind: "navigate", summary: "x", status: "ok", at: 1 }],
    finalText: "bought it",
    error: null,
    stepCount: 1,
    maxSteps: 15,
    inputTokens: 100,
    outputTokens: 20,
    provider: "anthropic-api",
    model: "claude",
    startedAt: 1000,
    endedAt: 2000,
    transcript,
    ...over,
  };
}

describe("AgentRunStore", () => {
  it("persists runs newest-first and reloads them from disk", () => {
    const store = new AgentRunStore(dir);
    store.commit(makeRun({ id: "old", startedAt: 1000 }));
    store.commit(makeRun({ id: "new", startedAt: 5000 }));
    store.flush();

    const reloaded = new AgentRunStore(dir);
    expect(reloaded.list().map((r) => r.id)).toEqual(["new", "old"]);
    expect(reloaded.get("new")!.transcript).toHaveLength(3);
  });

  it("maps a live status to interrupted on load (app died mid-run)", () => {
    const store = new AgentRunStore(dir);
    store.commit(makeRun({ id: "live", status: "running", stopReason: null, finalText: "" }));
    store.flush();

    const view = new AgentRunStore(dir).views().find((r) => r.id === "live")!;
    expect(view.status).toBe("interrupted");
    expect(view.resumable).toBe(true);
  });

  it("computes resumable from status, stop reason and a present transcript", () => {
    const store = new AgentRunStore(dir);
    store.commit(makeRun({ id: "clean", status: "done", stopReason: "done" }));
    store.commit(makeRun({ id: "capped", status: "done", stopReason: "max_steps" }));
    store.commit(makeRun({ id: "stopped", status: "stopped", stopReason: "aborted" }));
    store.commit(makeRun({ id: "notranscript", status: "stopped", stopReason: "aborted", transcript: [] }));
    const views = Object.fromEntries(store.views().map((v) => [v.id, v.resumable]));
    expect(views).toMatchObject({ clean: false, capped: true, stopped: true, notranscript: false });
  });

  it("caps the number of stored runs, keeping the newest", () => {
    const store = new AgentRunStore(dir);
    for (let i = 0; i < MAX_STORED_RUNS + 10; i++) store.save(makeRun({ id: `r${i}`, startedAt: i }));
    expect(store.list()).toHaveLength(MAX_STORED_RUNS);
    expect(store.list()[0]!.id).toBe(`r${MAX_STORED_RUNS + 9}`);
    expect(store.list().some((r) => r.id === "r0")).toBe(false);
  });

  it("replaces a run in place by id", () => {
    const store = new AgentRunStore(dir);
    store.commit(makeRun({ id: "r1", stepCount: 1 }));
    store.commit(makeRun({ id: "r1", stepCount: 4 }));
    expect(store.list()).toHaveLength(1);
    expect(store.get("r1")!.stepCount).toBe(4);
  });

  it("removes and clears", () => {
    const store = new AgentRunStore(dir);
    store.commit(makeRun({ id: "r1" }));
    store.commit(makeRun({ id: "r2" }));
    expect(store.remove("r1").map((r) => r.id)).toEqual(["r2"]);
    expect(store.clear()).toEqual([]);
  });
});
