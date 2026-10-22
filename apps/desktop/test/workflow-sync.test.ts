import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyUsage, type FlowStep, type FlowUsage, type SavedFlow } from "../src/shared/flow";
import {
  WORKFLOW_TOMBSTONE_TTL_MS,
  combineUsage,
  mergeSyncedWorkflow,
  parseSyncedWorkflow,
  toSyncedWorkflow,
  workflowFromSynced,
  workflowTombstone,
  type SyncedWorkflow,
} from "../src/shared/workflow-sync";
import { FlowStore } from "../src/main/flow-store";

const A = "aaaaaa11";
const B = "bbbbbb22";
const C = "cccccc33";
const T0 = 1_800_000_000_000;

const target = (role: string, name: string) => ({ role, name, index: 0, tag: "", selector: "" });
const STEPS: FlowStep[] = [
  { kind: "navigate", url: "https://shop.example/", label: "Go to shop.example" },
  { kind: "type", url: "https://shop.example/", label: "Type query", target: target("searchbox", "Search"), value: "{{query}}", submit: true, secret: false },
  { kind: "click", url: "https://shop.example/s", label: "Click Add to cart", target: target("button", "Add to cart") },
];

function flow(over: Partial<SavedFlow> = {}): SavedFlow {
  return {
    id: "wf-1",
    name: "Buy again",
    startUrl: "https://shop.example/",
    steps: STEPS,
    createdAt: T0,
    updatedAt: T0,
    description: "Search and add to cart",
    origin: "agent",
    sourceRunId: "run-1",
    sites: ["shop.example"],
    params: [{ name: "query", label: "Query", default: "umbrella" }],
    usage: emptyUsage(),
    ...over,
  };
}

const usage = (runs: number, ok: number, at: number, status: FlowUsage["lastStatus"] = "ok"): FlowUsage => ({
  runs,
  ok,
  failed: runs - ok,
  lastRunAt: at,
  lastStatus: status,
  lastError: status === "failed" ? "Step 2 broke" : null,
  lastBrokenStep: status === "failed" ? 1 : null,
  lastRunBy: "user",
});

const rec = (f: SavedFlow, replica = A): SyncedWorkflow => toSyncedWorkflow(f, replica)!;

describe("workflow merge", () => {
  it("last writer wins by updatedAt, for edits and deletions alike", () => {
    const older = rec(flow({ name: "Old name", updatedAt: T0 + 1 }));
    const newer = rec(flow({ name: "New name", updatedAt: T0 + 2 }));
    expect(mergeSyncedWorkflow(older, newer).flow?.name).toBe("New name");
    expect(mergeSyncedWorkflow(newer, older).flow?.name).toBe("New name");
    // A deletion after the edit wins; an edit after the deletion brings it back.
    const deleted = workflowTombstone("wf-1", T0 + 3);
    expect(mergeSyncedWorkflow(newer, deleted).flow).toBeNull();
    const revived = rec(flow({ name: "Edited later", updatedAt: T0 + 4 }));
    expect(mergeSyncedWorkflow(deleted, revived).flow?.name).toBe("Edited later");
    // Same time: the deletion wins, then a fixed order, so both devices agree.
    expect(mergeSyncedWorkflow(rec(flow({ updatedAt: T0 + 3 })), deleted).flow).toBeNull();
    const x = rec(flow({ name: "X", updatedAt: T0 + 9 }));
    const y = rec(flow({ name: "Y", updatedAt: T0 + 9 }));
    expect(mergeSyncedWorkflow(x, y)).toEqual(mergeSyncedWorkflow(y, x));
  });

  it("combines usage per device without counting the same runs twice", () => {
    const a = rec(flow({ usage: usage(2, 2, T0 + 10) }), A);
    const b = rec(flow({ usage: usage(1, 0, T0 + 20, "failed") }), B);
    const merged = mergeSyncedWorkflow(a, b);
    const shown = combineUsage(merged.usage);
    expect(shown).toMatchObject({ runs: 3, ok: 2, failed: 1, lastRunAt: T0 + 20, lastStatus: "failed", lastBrokenStep: 1 });
    // The same data coming back changes nothing.
    expect(mergeSyncedWorkflow(merged, a)).toEqual(merged);
    expect(mergeSyncedWorkflow(merged, merged)).toEqual(merged);
    // A device that ran it again replaces only its own counters.
    const a2 = rec(flow({ usage: usage(3, 3, T0 + 30) }), A);
    expect(combineUsage(mergeSyncedWorkflow(merged, a2).usage)).toMatchObject({ runs: 4, ok: 3, failed: 1, lastStatus: "ok" });
  });

  it("is idempotent, commutative and associative, usage surviving a deletion that loses later", () => {
    const a = rec(flow({ name: "A", updatedAt: T0 + 1, usage: usage(1, 1, T0 + 5) }), A);
    const b = workflowTombstone("wf-1", T0 + 2, { [B]: usage(2, 1, T0 + 6, "failed") });
    const c = rec(flow({ name: "C", updatedAt: T0 + 3, usage: usage(1, 1, T0 + 7) }), C);
    for (const [x, y] of [
      [a, b],
      [b, c],
      [a, c],
    ] as const) {
      expect(mergeSyncedWorkflow(x, y)).toEqual(mergeSyncedWorkflow(y, x));
      expect(mergeSyncedWorkflow(x, x)).toEqual(x);
    }
    const left = mergeSyncedWorkflow(mergeSyncedWorkflow(a, b), c);
    const right = mergeSyncedWorkflow(a, mergeSyncedWorkflow(b, c));
    expect(left).toEqual(right);
    expect(left.flow?.name).toBe("C");
    expect(combineUsage(left.usage).runs).toBe(4);
  });

  it("never lets a secret travel, even from a step that was not marked secret", () => {
    const leaky = flow({
      startUrl: "https://bank.example/login",
      steps: [
        { kind: "navigate", url: "https://bank.example/login", label: "Go" },
        { kind: "type", url: "https://bank.example/login", label: "User", target: target("textbox", "User name"), value: "alice", secret: false },
        { kind: "type", url: "https://bank.example/login", label: "Pass", target: target("textbox", "Password"), value: "{{pw}}", secret: false },
        { kind: "type", url: "https://bank.example/otp", label: "Code", target: target("textbox", "One-time code"), value: "123456", secret: false },
        { kind: "type", url: "https://bank.example/login", label: "Old", target: target("textbox", "PIN"), secret: true },
      ],
      params: [{ name: "pw", label: "Password", default: "hunter2" }],
    });
    const out = rec(leaky);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/hunter2|123456/);
    expect(out.flow!.steps.slice(2).every((s) => s.secret === true && s.value === undefined)).toBe(true);
    expect(out.flow!.steps[1]).toMatchObject({ value: "alice", secret: false });
    expect(out.flow!.params).toEqual([{ name: "pw", label: "Password", default: "" }]);
    // The same rule applies to what arrives.
    const raw = JSON.parse(JSON.stringify({ ...out, flow: { ...out.flow, steps: leaky.steps, params: leaky.params } })) as unknown;
    expect(JSON.stringify(parseSyncedWorkflow(raw, "wf-1"))).not.toMatch(/hunter2|123456/);
  });

  it("declines records it cannot trust, and a record survives the round trip unchanged", () => {
    // Steps saved without optional fields come out in the receiver's exact form.
    const loose = flow({ steps: [STEPS[0]!, { kind: "type", url: "https://shop.example/", label: "", target: target("textbox", "Password"), secret: true }] });
    const sent = rec(loose);
    expect(parseSyncedWorkflow(JSON.parse(JSON.stringify(sent)), "wf-1")).toEqual(sent);
    expect(sent.flow!.steps[1]).toMatchObject({ submit: false, secret: true, label: expect.stringContaining("secret") });
    expect(toSyncedWorkflow(flow({ steps: [] }), A)).toBeNull();
    const good = rec(flow());
    expect(parseSyncedWorkflow(good, "wf-1")).toEqual(good);
    expect(parseSyncedWorkflow({ ...good, v: 2 }, "wf-1")).toBeNull();
    expect(parseSyncedWorkflow(good, "wf-2")).toBeNull();
    expect(parseSyncedWorkflow({ ...good, flow: { ...good.flow, steps: [] } }, "wf-1")).toBeNull();
    expect(parseSyncedWorkflow({ ...good, flow: { ...good.flow, startUrl: "javascript:alert(1)" } }, "wf-1")).toBeNull();
    expect(parseSyncedWorkflow({ ...good, usage: { "not a replica": usage(1, 1, 1), [B]: usage(1, 1, 1) } }, "wf-1")?.usage).toEqual({ [B]: usage(1, 1, 1) });
    expect(workflowFromSynced(workflowTombstone("wf-1", T0))).toBeNull();
  });
});

describe("flow stores exchanging records", () => {
  let dirs: string[] = [];
  const store = (): FlowStore => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-wfsync-"));
    dirs.push(dir);
    return new FlowStore(dir);
  };
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  const send = (from: FlowStore, to: FlowStore): void => {
    to.applyRemote(from.syncList().map((r) => ({ id: r.id, record: r })));
  };
  const names = (s: FlowStore): string[] => s.list().map((f) => f.name).sort();

  it("creates, edits, renames and deletes across devices; recorded and agent workflows alike", async () => {
    const a = store();
    const b = store();
    const recorded = a.create("Recorded", "https://shop.example/", STEPS)!;
    const fromAgent = a.create("From agent", "https://shop.example/", STEPS, { origin: "agent", sourceRunId: "run-9" })!;
    send(a, b);
    expect(names(b)).toEqual(["From agent", "Recorded"]);
    expect(b.get(fromAgent.id)).toMatchObject({ origin: "agent", sourceRunId: "run-9" });
    expect(a.syncList()).toEqual(b.syncList());

    await new Promise((r) => setTimeout(r, 5));
    b.rename(recorded.id, "Renamed on B");
    send(b, a);
    expect(a.get(recorded.id)?.name).toBe("Renamed on B");

    // A stale copy of the old name does not undo the rename.
    const stale = store();
    stale.applyRemote([{ id: recorded.id, record: toSyncedWorkflow(recorded, stale.replica) }]);
    send(stale, a);
    expect(a.get(recorded.id)?.name).toBe("Renamed on B");

    await new Promise((r) => setTimeout(r, 5));
    a.remove(fromAgent.id);
    send(a, b);
    expect(b.get(fromAgent.id)).toBeUndefined();
    // The stale device still has it, with an older edit: syncing it back does not resurrect it.
    stale.applyRemote([{ id: fromAgent.id, record: toSyncedWorkflow(fromAgent, stale.replica) }]);
    send(stale, a);
    send(stale, b);
    expect(a.get(fromAgent.id)).toBeUndefined();
    expect(b.get(fromAgent.id)).toBeUndefined();
    send(a, stale);
    expect(stale.get(fromAgent.id)).toBeUndefined();
    expect(a.syncList().find((r) => r.id === fromAgent.id)?.flow).toBeNull();
  });

  it("adds up runs from every device and never double counts", () => {
    const a = store();
    const b = store();
    const wf = a.create("Daily", "https://shop.example/", STEPS)!;
    a.recordRun(wf.id, { status: "ok", by: "user", at: T0 + 1 });
    a.recordRun(wf.id, { status: "ok", by: "agent", at: T0 + 2 });
    send(a, b);
    b.recordRun(wf.id, { status: "failed", by: "user", error: "Step 3 broke", brokenStep: 2, at: T0 + 3 });
    send(b, a);
    send(a, b);
    send(b, a);
    for (const s of [a, b]) {
      expect(s.get(wf.id)!.usage).toMatchObject({ runs: 3, ok: 2, failed: 1, lastStatus: "failed", lastBrokenStep: 2, lastRunAt: T0 + 3 });
    }
    a.recordRun(wf.id, { status: "ok", by: "user", at: T0 + 4 });
    send(a, b);
    expect(b.get(wf.id)!.usage).toMatchObject({ runs: 4, ok: 3, lastStatus: "ok" });
  });

  it("counts runs made before sync as this device's own", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-wfsync-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "flows.json"), JSON.stringify([{ ...flow(), usage: usage(5, 4, T0) }]));
    const legacy = new FlowStore(dir);
    expect(legacy.syncList()[0]!.usage).toEqual({ [legacy.replica]: usage(5, 4, T0) });
    legacy.recordRun("wf-1", { status: "ok", by: "user", at: T0 + 1 });
    expect(legacy.get("wf-1")!.usage).toMatchObject({ runs: 6, ok: 5 });
  });

  it("forgets old deletions, and drops the ones made while not syncing when it joins", () => {
    const a = store();
    const wf = a.create("Gone", "https://shop.example/", STEPS)!;
    a.remove(wf.id);
    expect(a.syncList().map((r) => r.id)).toEqual([wf.id]);
    expect(a.syncList(Date.now() + WORKFLOW_TOMBSTONE_TTL_MS + 1)).toEqual([]);
    a.resetSyncMarkers();
    expect(a.syncList()).toEqual([]);
  });

  it("an engine-level deletion removes the workflow", () => {
    const a = store();
    const wf = a.create("Gone", "https://shop.example/", STEPS)!;
    a.applyRemote([{ id: wf.id, record: null }]);
    expect(a.list()).toEqual([]);
  });
});
