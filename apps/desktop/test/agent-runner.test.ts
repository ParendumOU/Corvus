import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentModelProvider, AgentTurnRequest, TurnEvent } from "@corvus/ai-engine";
import type { PageSnapshot, Tab } from "@corvus/shared";
import { AgentRunStore } from "../src/main/agent-run-store";
import { AgentRunner } from "../src/main/agent-runner";
import type { CredentialFillOptions } from "../src/main/agent-credentials";
import type { AppContext } from "../src/main/context";
import { SECRET_FILL_LOCK_MESSAGE, SecretFillGuard } from "../src/main/secret-fill-guard";
import type { BrowserWindowCtl } from "../src/main/window";

/** A scripted provider: each turn emits the given events; captures the messages it is handed. */
function scripted(turns: TurnEvent[][]): { provider: AgentModelProvider; seen: AgentTurnRequest[] } {
  const seen: AgentTurnRequest[] = [];
  let i = 0;
  const provider: AgentModelProvider = {
    kind: "anthropic-api",
    model: "fake-agent",
    async *streamTurn(req) {
      seen.push({ ...req, messages: structuredClone(req.messages) });
      const turn = turns[Math.min(i++, turns.length - 1)] ?? [{ type: "text", text: "done" }];
      for (const ev of turn) yield ev;
      yield { type: "end", stopReason: turn.some((e) => e.type === "tool_use") ? "tool_use" : "end_turn" };
    },
  };
  return { provider, seen };
}

const snap: PageSnapshot = {
  tabId: "agent1",
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
  const tabs: Tab[] = [{ id: "agent1", windowId: "w1", url: snap.url, title: snap.title, pinned: false, active: true, loading: false, agentControlled: true }];
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

/** Stand-in for AgentCredentialService: asks for approval like the real one, then "fills" a secret into a fake page. */
function fakeCredentials(enabled: boolean) {
  const page = { value: "" };
  const fill = async (opts: CredentialFillOptions, secret: string, what: string) => {
    const ok = await opts.approve({ use: "totp", host: "shop.test", username: "alice", reason: "Fill the current 2FA code for alice on shop.test. The agent will not see the code.", client: opts.client });
    if (!ok) return { status: "declined" as const, message: "The person declined." };
    page.value = secret;
    return { status: "filled" as const, message: `Filled ${what} for alice.` };
  };
  return {
    page,
    service: {
      enabled,
      fillTotp: vi.fn((_tab: string, _ref: string, opts: CredentialFillOptions) => fill(opts, "424242", "the current 2FA code")),
      fillLogin: vi.fn((_tab: string, _ref: string | null, opts: CredentialFillOptions) => fill(opts, "hunter2-secret", "the password")),
    },
  };
}

function fakeContext(controller: ReturnType<typeof mockController>, askBeforeRisky: boolean, maxSteps = 15, credentials = fakeCredentials(false)) {
  const secretFills = new SecretFillGuard();
  const listeners = new Set<() => void>();
  const agents = {
    paused: false,
    setPaused(p: boolean) {
      this.paused = p;
      for (const l of listeners) l();
    },
    onChange(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    clientConnected: vi.fn(),
    toolCall: vi.fn(),
    toolResult: vi.fn(),
  };
  const ctx = {
    controller,
    agents,
    assist: { open: vi.fn() },
    agentCredentials: credentials.service,
    secretFills,
    settings: {
      get: () => ({ agent: { maxSteps, askBeforeRisky }, ai: { provider: "anthropic-api", model: "fake", claudeCliPath: "claude" } }),
      getSecret: () => "sk-test",
    },
  } as unknown as AppContext;
  return { ctx, agents, secretFills };
}

let dir: string;
let store: AgentRunStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-runner-"));
  store = new AgentRunStore(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeWindow(): BrowserWindowCtl {
  return {
    createTab: () => ({ id: "agent1" }),
    pushState: vi.fn(),
    sendCommand: vi.fn(),
    notifyInternalPages: vi.fn(),
    profile: { agentRuns: store },
  } as unknown as BrowserWindowCtl;
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

describe("AgentRunner", () => {
  it("runs the tool loop, wraps page content as untrusted and finishes", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller, false);
    const { provider, seen } = scripted([
      [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
      [{ type: "tool_use", id: "t2", name: "click", input: { ref: "e2" } }],
      [{ type: "text", text: "The item costs 20 dollars." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "how much is the item?");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");

    const run = runner.windowExtras(win).agentRun!;
    expect(controller.calls).toEqual(["snapshot", "click:e2"]);
    expect(run.finalText).toContain("20 dollars");
    expect(run.steps.map((s) => s.kind)).toEqual(["page_snapshot", "click", "message"]);
    // The snapshot result handed to the model is fenced as untrusted data.
    const toolResult = seen[1]!.messages.at(-1)!.content[0];
    expect(JSON.stringify(toolResult)).toContain("<untrusted_page_content");
  });

  it("asks for approval before a risky click and runs it when approved", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller, true);
    const { provider } = scripted([
      [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
      [{ type: "tool_use", id: "t2", name: "click", input: { ref: "e1" } }],
      [{ type: "text", text: "Bought it." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "buy the item");

    await waitFor(() => runner.windowExtras(win).agentRun?.status === "awaiting-approval");
    expect(runner.windowExtras(win).agentRun!.approval!.reason).toContain("Buy now");
    expect(controller.calls).toEqual(["snapshot"]);
    runner.approve(win, "approve");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    expect(controller.calls).toEqual(["snapshot", "click:e1"]);
  });

  it("skips a risky action without running it", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller, true);
    const { provider } = scripted([
      [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
      [{ type: "tool_use", id: "t2", name: "click", input: { ref: "e1" } }],
      [{ type: "text", text: "Did not buy." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "buy the item");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "awaiting-approval");
    runner.approve(win, "skip");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    expect(controller.calls).toEqual(["snapshot"]);
    expect(runner.windowExtras(win).agentRun!.steps.find((s) => s.kind === "click")!.status).toBe("skipped");
  });

  it("stops the run when the user chooses Stop at an approval", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller, true);
    const { provider } = scripted([
      [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
      [{ type: "tool_use", id: "t2", name: "click", input: { ref: "e1" } }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "buy the item");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "awaiting-approval");
    runner.approve(win, "stop");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "stopped");
    expect(controller.calls).toEqual(["snapshot"]);
  });

  it("stops at the configured step cap", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller, false, 3);
    // Always asks for another snapshot: only the step cap can end it.
    const { provider } = scripted([[{ type: "tool_use", id: "t", name: "page_snapshot", input: {} }]]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "keep reading");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    expect(runner.windowExtras(win).agentRun!.stepCount).toBe(3);
  });

  it("halts the loop while paused and resumes after", async () => {
    const controller = mockController();
    const { ctx, agents } = fakeContext(controller, false, 2);
    const { provider } = scripted([[{ type: "tool_use", id: "t", name: "page_snapshot", input: {} }]]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    agents.setPaused(true);
    const win = fakeWindow();
    runner.start(win, "loop");
    // Parks at the first tool while paused: nothing runs.
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "paused");
    await new Promise((r) => setTimeout(r, 40));
    expect(controller.calls).toEqual([]);
    // Resume: the loop runs to its step cap.
    runner.pause(win, false);
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    expect(runner.windowExtras(win).agentRun!.stepCount).toBe(2);
  });

  it("persists a completed run to the per-profile store", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller, false);
    const { provider } = scripted([
      [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
      [{ type: "text", text: "All good." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "check the item");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");

    const records = store.views();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ task: "check the item", status: "done", source: "command-bar", finalText: "All good." });
    expect(store.get(records[0]!.id)!.transcript.length).toBeGreaterThan(1);
  });

  it("resumes a saved interrupted run from its step state, continuing counts within the caps", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller, false, 15);
    const runner = new AgentRunner(ctx);
    const id = "saved-run";
    // Seed a run that was cut off mid-loop (as if the app had restarted): 1 step done, a valid
    // transcript ending on a user turn.
    store.commit({
      id,
      task: "keep looking",
      source: "command-bar",
      status: "interrupted",
      stopReason: "aborted",
      steps: [{ id: "a", kind: "page_snapshot", summary: "", status: "ok", at: 1 }],
      finalText: "",
      error: null,
      stepCount: 1,
      maxSteps: 15,
      inputTokens: 50,
      outputTokens: 10,
      provider: "anthropic-api",
      model: "fake",
      startedAt: 1,
      endedAt: null,
      transcript: [
        { role: "user", content: [{ type: "text", text: "keep looking" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "page_snapshot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "page" }] },
      ],
    });

    const resumeProvider = scripted([
      [{ type: "tool_use", id: "t3", name: "page_snapshot", input: {} }],
      [{ type: "text", text: "Found it." }],
    ]);
    runner.setTestProvider(resumeProvider.provider);
    const win = fakeWindow();
    const res = runner.resume(win, id);
    expect(res.ok).toBe(true);
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done" && runner.windowExtras(win).agentRun?.finalText === "Found it.");

    const view = runner.windowExtras(win).agentRun!;
    expect(view.id).toBe(id);
    // 1 prior step + exactly 1 resumed tool call (the prior snapshot is NOT re-run).
    expect(view.stepCount).toBe(2);
    expect(controller.calls).toEqual(["snapshot"]);
    // The resumed turn was handed the saved transcript, not a fresh task seed.
    expect(resumeProvider.seen[0]!.messages).toHaveLength(3);
    expect(store.get(id)!.status).toBe("done");
    expect(win.sendCommand).toHaveBeenCalledWith({ type: "open-command-palette" });
  });

  it("declines to resume a cleanly finished run", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller, false);
    const { provider } = scripted([[{ type: "text", text: "Done immediately." }]]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "trivial");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    const id = runner.windowExtras(win).agentRun!.id;
    const res = runner.resume(win, id);
    expect(res.ok).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it("does not offer the credential tools while Settings keeps them off", async () => {
    const { ctx } = fakeContext(mockController(), false);
    const { provider, seen } = scripted([[{ type: "text", text: "ok" }]]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "sign in");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    const names = seen[0]!.tools.map((t) => t.name);
    expect(names).not.toContain("fill_totp");
    expect(names).not.toContain("fill_login");
    expect(seen[0]!.system).not.toContain("fill_totp");
  });

  it("always asks before a 2FA fill and keeps the code out of the transcript", async () => {
    const credentials = fakeCredentials(true);
    // "Ask before risky actions" is off: the credential tools must still ask.
    const { ctx } = fakeContext(mockController(), false, 15, credentials);
    const { provider, seen } = scripted([
      [{ type: "tool_use", id: "t1", name: "fill_totp", input: { ref: "e4" } }],
      [{ type: "text", text: "Signed in." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "finish signing in");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "awaiting-approval");
    expect(seen[0]!.tools.map((t) => t.name)).toContain("fill_totp");
    expect(runner.windowExtras(win).agentRun!.approval!.reason).toContain("2FA code for alice");
    expect(credentials.page.value).toBe("");
    runner.approve(win, "approve");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");

    expect(credentials.page.value).toBe("424242");
    expect(credentials.service.fillTotp).toHaveBeenCalledWith("agent1", "e4", expect.objectContaining({ client: "Corvus" }));
    const stored = JSON.stringify(store.get(runner.windowExtras(win).agentRun!.id));
    expect(stored).toContain("Filled the current 2FA code for alice.");
    expect(stored).not.toContain("424242");
    expect(JSON.stringify(seen.map((s) => s.messages))).not.toContain("424242");
  });

  it("a declined sign-in is skipped and nothing is filled", async () => {
    const credentials = fakeCredentials(true);
    const { ctx } = fakeContext(mockController(), true, 15, credentials);
    const { provider } = scripted([
      [{ type: "tool_use", id: "t1", name: "fill_login", input: {} }],
      [{ type: "text", text: "Asked the person instead." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "sign in");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "awaiting-approval");
    runner.approve(win, "skip");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    expect(credentials.page.value).toBe("");
    expect(runner.windowExtras(win).agentRun!.steps.find((s) => s.kind === "fill_login")!.status).toBe("skipped");
    expect(credentials.service.fillLogin).toHaveBeenCalledWith("agent1", null, expect.anything());
  });

  it("asks before a click that spends money even in auto mode", async () => {
    const controller = mockController();
    // "Ask before risky actions" is off: a spend must still ask.
    const { ctx } = fakeContext(controller, false);
    const { provider } = scripted([
      [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
      [{ type: "tool_use", id: "t2", name: "click", input: { ref: "e1" } }],
      [{ type: "text", text: "Bought it." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "buy the item");

    await waitFor(() => runner.windowExtras(win).agentRun?.status === "awaiting-approval");
    expect(runner.windowExtras(win).agentRun!.approval!.reason).toBe('Spends money: clicks "Buy now".');
    expect(controller.calls).toEqual(["snapshot"]);
    runner.approve(win, "approve");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    expect(controller.calls).toEqual(["snapshot", "click:e1"]);
  });

  it("does not ask before an ordinary form submit in auto mode", async () => {
    const controller = Object.assign(mockController(), {
      async snapshot(this: { calls: string[] }) {
        this.calls.push("snapshot");
        return { ...snap, elements: [...snap.elements, { ref: "e3", role: "searchbox", name: "Search products" }] };
      },
      async describeTarget() {
        return { url: snap.url, role: "searchbox", name: "Search products", form: { action: "https://shop.test/search", submitName: "Search", submitRole: "button" } };
      },
    });
    const { ctx } = fakeContext(controller, false);
    const { provider } = scripted([
      [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
      [{ type: "tool_use", id: "t2", name: "type", input: { ref: "e3", text: "umbrella", submit: true } }],
      [{ type: "text", text: "Searched." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "search for umbrellas");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    expect(controller.calls).toEqual(["snapshot", "type"]);
    expect(runner.windowExtras(win).agentRun!.steps.every((s) => s.status !== "skipped")).toBe(true);
  });

  it("asks before Enter in a checkout form found on the live page, even in auto mode", async () => {
    // The snapshot only shows a harmless field; the page says its form submits "Place order".
    const controller = Object.assign(mockController(), {
      async snapshot(this: { calls: string[] }) {
        this.calls.push("snapshot");
        return { ...snap, elements: [{ ref: "e5", role: "textbox", name: "Promo code" }] };
      },
      async describeTarget() {
        return { url: snap.url, role: "textbox", name: "Promo code", form: { action: snap.url, submitName: "Place order", submitRole: "button" } };
      },
    });
    const { ctx } = fakeContext(controller, false);
    const { provider } = scripted([
      [{ type: "tool_use", id: "t1", name: "page_snapshot", input: {} }],
      [{ type: "tool_use", id: "t2", name: "type", input: { ref: "e5", text: "SPRING", submit: true } }],
      [{ type: "text", text: "Done." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "apply the promo code");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "awaiting-approval");
    expect(runner.windowExtras(win).agentRun!.approval!.reason).toBe('Spends money: presses Enter in "Promo code", which submits "Place order".');
    runner.approve(win, "skip");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    expect(controller.calls).toEqual(["snapshot"]);
  });

  it("asks before a saved workflow's step that spends money, even in auto mode", async () => {
    const controller = mockController();
    const { ctx } = fakeContext(controller, false);
    const flow = {
      id: "wf1",
      name: "Buy the item",
      startUrl: "",
      steps: [{ kind: "click", url: snap.url, label: 'Click "Buy now"', target: { role: "button", name: "Buy now", index: 0, tag: "", selector: "" } }],
      createdAt: 1,
      updatedAt: 1,
      description: "",
      origin: "agent",
      sourceRunId: null,
      sites: ["shop.test"],
      params: [],
      usage: { runs: 0, ok: 0, failed: 0, lastRunAt: null, lastStatus: null, lastError: null, lastBrokenStep: null, lastRunBy: null },
    };
    const recordRun = vi.fn();
    Object.assign(ctx, { flows: { storeFor: () => ({ list: () => [flow] }), memory: { enabled: () => false, learn: vi.fn() }, recordRun } });
    const { provider } = scripted([
      [{ type: "tool_use", id: "t1", name: "run_workflow", input: { workflow: "wf1" } }],
      [{ type: "text", text: "Ran it." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "buy the item again");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "awaiting-approval");
    expect(runner.windowExtras(win).agentRun!.approval!.reason).toBe('Spends money: clicks "Buy now".');
    expect(controller.calls).not.toContain("click:e1");
    runner.approve(win, "approve");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    expect(controller.calls).toContain("click:e1");
    expect(recordRun).toHaveBeenCalledWith(expect.anything(), "wf1", expect.objectContaining({ status: "ok" }));
  });

  it("refuses run_workflow on a tab where a saved secret was filled", async () => {
    const { ctx, secretFills } = fakeContext(mockController(), false);
    secretFills.mark("agent1");
    const { provider, seen } = scripted([
      [{ type: "tool_use", id: "t1", name: "run_workflow", input: { workflow: "Sign in" } }],
      [{ type: "text", text: "Navigated away instead." }],
    ]);
    const runner = new AgentRunner(ctx);
    runner.setTestProvider(provider);
    const win = fakeWindow();
    runner.start(win, "replay the sign-in workflow");
    await waitFor(() => runner.windowExtras(win).agentRun?.status === "done");
    const result = seen[1]!.messages.at(-1)!.content[0] as { content: string; isError?: boolean };
    expect(result.content).toBe(SECRET_FILL_LOCK_MESSAGE);
    expect(result.isError).toBe(true);
  });
});
