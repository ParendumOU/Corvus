import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  // isSupported() === false keeps the runner from constructing real OS notifications in tests.
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): this {
      return this;
    }
    show(): void {}
  },
}));

import type { AgentModelProvider, TurnEvent } from "@corvus/ai-engine";
import type { PageSnapshot, Tab } from "@corvus/shared";
import type { AppContext } from "../src/main/context";
import type { ProfileRuntime } from "../src/main/profiles";
import { ScheduledAgentRunner } from "../src/main/scheduled-agent-runner";
import type { ScheduleInput } from "../src/shared/schedule-ipc";
import type { BrowserWindowCtl } from "../src/main/window";

function scripted(turns: TurnEvent[][]): AgentModelProvider {
  let i = 0;
  return {
    kind: "anthropic-api",
    model: "fake-agent",
    async *streamTurn() {
      const turn = turns[Math.min(i++, turns.length - 1)] ?? [{ type: "text", text: "done" }];
      for (const ev of turn) yield ev;
      yield { type: "end", stopReason: turn.some((e) => e.type === "tool_use") ? "tool_use" : "end_turn" };
    },
  };
}

function throwingProvider(message: string): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: "fake-agent",
    // eslint-disable-next-line require-yield
    async *streamTurn() {
      throw new Error(message);
    },
  };
}

const snap: PageSnapshot = {
  tabId: "sched1",
  url: "https://shop.test/item",
  title: "Item — Shop",
  text: "A nice item costs 20 dollars.",
  elements: [
    { ref: "e1", role: "button", name: "Buy now" },
    { ref: "e2", role: "link", name: "Reviews" },
  ],
  truncated: false,
};

function mockController() {
  const tabs: Tab[] = [{ id: "sched1", windowId: "w1", url: snap.url, title: snap.title, pinned: false, active: false, loading: false, agentControlled: true }];
  return {
    calls: [] as string[],
    async snapshot() {
      this.calls.push("snapshot");
      return snap;
    },
    async click(_id: string, ref: string) {
      this.calls.push(`click:${ref}`);
    },
    async navigate(_id: string, url: string) {
      this.calls.push(`navigate:${url}`);
      return { ...tabs[0]!, url };
    },
    async type() {
      this.calls.push("type");
    },
    async listTabs() {
      return tabs;
    },
  };
}

function fakeWindow(): BrowserWindowCtl {
  const tabs = new Set<string>();
  const groups = new Map<string, { id: string; title: string; collapsed: boolean; tabs: Set<string> }>();
  const groupOf = (id: string): string | undefined => [...groups.values()].find((g) => g.tabs.has(id))?.id;
  return {
    createTab: () => {
      tabs.add("sched1");
      return { id: "sched1", view: { webContents: { isDestroyed: () => false, getURL: () => "corvus://newtab/" } } };
    },
    hasTab: (id: string) => tabs.has(id),
    closeTab: (id: string) => tabs.delete(id),
    tabIds: () => [...tabs],
    listTabs: () => [...tabs].map((id) => ({ id, url: "corvus://newtab/", title: "New Tab" })),
    getTab: (id: string) => (tabs.has(id) ? { id } : undefined),
    toTab: (t: { id: string }) => ({ id: t.id, url: "corvus://newtab/", title: "New Tab" }),
    groupOf,
    hasGroup: (id: string) => groups.has(id),
    listGroups: () => [...groups.values()].map((g) => ({ id: g.id, title: g.title, color: "grey", collapsed: g.collapsed })),
    createGroup: (ids: string[], opts: { title?: string }) => {
      const g = { id: "g1", title: opts.title ?? "", collapsed: false, tabs: new Set(ids) };
      groups.set(g.id, g);
      return { id: g.id, title: g.title, color: "grey", collapsed: false };
    },
    updateGroup: (id: string, patch: { collapsed?: boolean; title?: string }) => Object.assign(groups.get(id) ?? {}, patch),
    addToGroup: vi.fn(),
    closeGroup: (id: string) => {
      for (const t of groups.get(id)?.tabs ?? []) tabs.delete(t);
      groups.delete(id);
    },
    setAgentGroup: vi.fn(),
    clearAgentMark: vi.fn(),
    activate: vi.fn(),
    isDisposed: () => false,
    openSingleton: vi.fn(),
    notifyInternalPages: vi.fn(),
    win: { isDestroyed: () => false, focus: vi.fn() },
    profile: { userMemory: { list: () => [] } },
  } as unknown as BrowserWindowCtl;
}

function fakeContext(controller: ReturnType<typeof mockController>, maxSteps = 15) {
  const win = fakeWindow();
  const ctx = {
    controller,
    agents: { clientConnected: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn() },
    settings: {
      get: () => ({ scheduledAgents: { enabled: true, maxSteps, maxTokens: 60000 }, ai: { provider: "anthropic-api", model: "fake" } }),
      getSecret: () => "sk-test",
    },
    windows: {
      forProfile: () => [win],
      open: () => win,
      focused: () => win,
      findTab: (id: string) => (win.hasTab(id) ? { window: win, tab: { id, view: { webContents: { isDestroyed: () => false, getURL: () => "corvus://newtab/" } } } } : undefined),
    },
  } as unknown as AppContext;
  return { ctx, win };
}

let dir: string;
let runtime: ProfileRuntime;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-sched-"));
  runtime = { profile: { id: "p1" }, dataDir: dir } as unknown as ProfileRuntime;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const INTERVAL: ScheduleInput = { name: "Check item", task: "check the item", kind: "interval", intervalMinutes: 60, maxSteps: 12 };

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

function only(runner: ScheduledAgentRunner) {
  return runner.views(runtime)[0]!;
}

describe("ScheduledAgentRunner", () => {
  it("runs the agent loop in a background tab and records the result", async () => {
    const controller = mockController();
    const { ctx, win } = fakeContext(controller);
    const runner = new ScheduledAgentRunner(ctx);
    runner.setTestProvider(
      scripted([
        [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
        [{ type: "tool_use", id: "t2", name: "click", input: { ref: "e2" } }],
        [{ type: "text", text: "Checked the reviews, all good." }],
      ]),
    );
    runner.attach(runtime);
    const id = runner.add(runtime, INTERVAL)[0]!.id;
    runner.runNow(runtime, id);

    await waitFor(() => !only(runner).running && only(runner).lastRun?.status === "done");
    const view = only(runner);
    expect(controller.calls).toEqual(["snapshot", "click:e2"]);
    expect(view.lastRun!.summary).toContain("reviews");
    expect(view.lastRun!.steps).toBe(2);
    // The background tab was activated false and is closed when the run ends.
    expect((win.hasTab as (id: string) => boolean)("sched1")).toBe(false);
  });

  it("pauses for approval on a risky action and never runs it unattended", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller);
    const runner = new ScheduledAgentRunner(ctx);
    runner.setTestProvider(
      scripted([
        [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
        [{ type: "tool_use", id: "t2", name: "click", input: { ref: "e1" } }],
        [{ type: "text", text: "Bought it." }],
      ]),
    );
    runner.attach(runtime);
    const id = runner.add(runtime, INTERVAL)[0]!.id;
    runner.runNow(runtime, id);

    await waitFor(() => only(runner).approval !== null);
    expect(only(runner).approval!.reason).toContain("Buy now");
    // The risky click has NOT been executed while it waits for approval.
    expect(controller.calls).toEqual(["snapshot"]);

    runner.approve(runtime, id, "approve");
    await waitFor(() => !only(runner).running && only(runner).lastRun?.status === "done");
    expect(controller.calls).toEqual(["snapshot", "click:e1"]);
  });

  it("stops at a click that spends money and waits for the user, whatever auto mode says", async () => {
    const controller = Object.assign(mockController(), {
      async snapshot(this: { calls: string[] }) {
        this.calls.push("snapshot");
        // "Comprar" was not on the old risky word list: the spend rules catch it.
        return { ...snap, elements: [{ ref: "e7", role: "button", name: "Comprar" }] };
      },
    });
    const { ctx } = fakeContext(controller);
    const settings = ctx.settings as unknown as { get: () => Record<string, unknown> };
    const get = settings.get;
    settings.get = () => ({ ...get(), agent: { askBeforeRisky: false, maxSteps: 15 } });
    const runner = new ScheduledAgentRunner(ctx);
    runner.setTestProvider(
      scripted([
        [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
        [{ type: "tool_use", id: "t2", name: "click", input: { ref: "e7" } }],
        [{ type: "text", text: "Bought it." }],
      ]),
    );
    runner.attach(runtime);
    const id = runner.add(runtime, INTERVAL)[0]!.id;
    runner.runNow(runtime, id);

    await waitFor(() => only(runner).approval !== null);
    expect(only(runner).approval!.reason).toBe('Spends money: clicks "Comprar".');
    expect(only(runner).lastRun!.status).toBe("awaiting-approval");
    await new Promise((r) => setTimeout(r, 40));
    // Still waiting: an unattended run never buys on its own.
    expect(controller.calls).toEqual(["snapshot"]);

    runner.approve(runtime, id, "stop");
    await waitFor(() => !only(runner).running && only(runner).lastRun?.status === "stopped");
    expect(controller.calls).toEqual(["snapshot"]);
  });

  it("skips a risky action when the user skips", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller);
    const runner = new ScheduledAgentRunner(ctx);
    runner.setTestProvider(
      scripted([
        [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
        [{ type: "tool_use", id: "t2", name: "click", input: { ref: "e1" } }],
        [{ type: "text", text: "Did not buy." }],
      ]),
    );
    runner.attach(runtime);
    const id = runner.add(runtime, INTERVAL)[0]!.id;
    runner.runNow(runtime, id);
    await waitFor(() => only(runner).approval !== null);
    runner.approve(runtime, id, "skip");
    await waitFor(() => !only(runner).running && only(runner).lastRun?.status === "done");
    expect(controller.calls).toEqual(["snapshot"]);
  });

  it("stops the whole run when the user stops at an approval", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller);
    const runner = new ScheduledAgentRunner(ctx);
    runner.setTestProvider(
      scripted([
        [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
        [{ type: "tool_use", id: "t2", name: "click", input: { ref: "e1" } }],
      ]),
    );
    runner.attach(runtime);
    const id = runner.add(runtime, INTERVAL)[0]!.id;
    runner.runNow(runtime, id);
    await waitFor(() => only(runner).approval !== null);
    runner.approve(runtime, id, "stop");
    await waitFor(() => !only(runner).running && only(runner).lastRun?.status === "stopped");
    expect(controller.calls).toEqual(["snapshot"]);
  });

  it("stops at the configured step cap", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller, 3);
    const runner = new ScheduledAgentRunner(ctx);
    runner.setTestProvider(scripted([[{ type: "tool_use", id: "t", name: "page_snapshot", input: {} }]]));
    runner.attach(runtime);
    const id = runner.add(runtime, INTERVAL)[0]!.id;
    runner.runNow(runtime, id);
    await waitFor(() => !only(runner).running && only(runner).lastRun !== null);
    expect(only(runner).lastRun!.steps).toBe(3);
    expect(only(runner).lastRun!.status).toBe("done");
  });

  it("records a provider error without crashing and surfaces it", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller);
    const runner = new ScheduledAgentRunner(ctx);
    runner.setTestProvider(throwingProvider("model exploded"));
    runner.attach(runtime);
    const id = runner.add(runtime, INTERVAL)[0]!.id;
    runner.runNow(runtime, id);
    await waitFor(() => !only(runner).running && only(runner).lastRun?.status === "error");
    expect(only(runner).lastRun!.error).toContain("model exploded");
  });

  it("does not fire when scheduled agents are disabled", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller);
    (ctx.settings as { get: () => unknown }).get = () => ({ scheduledAgents: { enabled: false, maxSteps: 12, maxTokens: 60000 }, ai: { provider: "anthropic-api", model: "fake" } });
    const runner = new ScheduledAgentRunner(ctx);
    runner.setTestProvider(scripted([[{ type: "text", text: "hi" }]]));
    runner.attach(runtime);
    const id = runner.add(runtime, INTERVAL)[0]!.id;
    runner.runNow(runtime, id);
    await new Promise((r) => setTimeout(r, 60));
    expect(only(runner).running).toBe(false);
    expect(only(runner).lastRun).toBeNull();
    expect(controller.calls).toEqual([]);
  });
});
