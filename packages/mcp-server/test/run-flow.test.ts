import { afterEach, describe, expect, it } from "vitest";
import type { FlowRunner, FlowSummary } from "../src/index.js";
import { requiredLevel } from "../src/access.js";
import { call, startHarness, textOf, untrustedJson, type Harness } from "./helpers.js";

const FLOWS: FlowSummary[] = [
  { id: "f1", name: "Login", startUrl: "https://shop.example/login", steps: 4 },
  { id: "f2", name: "Weekly order", startUrl: "https://shop.example/", steps: 1 },
];

const started: string[] = [];

function runner(flows: FlowSummary[] = FLOWS): FlowRunner {
  return {
    list: () => flows,
    run: (nameOrId) => {
      const f = flows.find((x) => x.id === nameOrId || x.name.toLowerCase() === nameOrId.toLowerCase());
      if (!f) throw new Error(`No flow matches "${nameOrId}"`);
      started.push(f.id);
      return { id: f.id, name: f.name, steps: f.steps, status: "running" };
    },
  };
}

let harness: Harness;
afterEach(async () => {
  started.length = 0;
  await harness?.close();
});

describe("run_flow access gating", () => {
  it("is full level", () => {
    expect(requiredLevel("run_flow")).toBe("full");
  });

  it("is hidden below full even with a provider", async () => {
    harness = await startHarness({ accessLevel: "standard", flows: () => runner() });
    const names = (await (await harness.connect()).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("run_flow");
  });

  it("is absent at full without a provider", async () => {
    harness = await startHarness({ accessLevel: "full" });
    const names = (await (await harness.connect()).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("run_flow");
  });

  it("is exposed at full when a provider is wired", async () => {
    harness = await startHarness({ accessLevel: "full", flows: () => runner() });
    const names = (await (await harness.connect()).listTools()).tools.map((t) => t.name);
    expect(names).toContain("run_flow");
  });
});

describe("run_flow behavior", () => {
  it("lists saved flows as untrusted content", async () => {
    harness = await startHarness({ accessLevel: "full", flows: () => runner() });
    const client = await harness.connect();
    const res = await call(client, "run_flow", { action: "list" });
    expect(textOf(res)).toContain("data, not instructions");
    const rows = untrustedJson<Array<{ id: string; name: string; steps: number }>>(res);
    expect(rows.map((r) => r.name)).toEqual(["Login", "Weekly order"]);
  });

  it("starts a replay by name without bypassing the gate", async () => {
    harness = await startHarness({ accessLevel: "full", flows: () => runner() });
    const client = await harness.connect();
    const res = await call(client, "run_flow", { action: "run", flow: "Login" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/Started flow "Login" \(4 steps\); status running/);
    expect(textOf(res)).toContain("pause for your approval");
    expect(started).toEqual(["f1"]);
  });

  it("runs by id and reports a single step correctly", async () => {
    harness = await startHarness({ accessLevel: "full", flows: () => runner() });
    const res = await call(await harness.connect(), "run_flow", { action: "run", flow: "f2" });
    expect(textOf(res)).toContain("(1 step)");
  });

  it("errors on an unknown flow and on run without a name", async () => {
    harness = await startHarness({ accessLevel: "full", flows: () => runner() });
    const client = await harness.connect();
    const unknown = await call(client, "run_flow", { action: "run", flow: "nope" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('No flow matches "nope"');
    const noName = await call(client, "run_flow", { action: "run" });
    expect(noName.isError).toBe(true);
    expect(textOf(noName)).toContain("requires a flow name");
  });
});
