import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createClaudeCliAgentProvider,
  AgentStopError,
  parseToolCall,
  renderTranscript,
  runAgent,
  type AgentModelProvider,
  type AgentStep,
  type AgentTool,
  type AgentTurnRequest,
  type TurnEvent,
} from "../src/agent.js";

const tools: AgentTool[] = [
  { name: "navigate", description: "Open a URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "snapshot", description: "Read the page", inputSchema: { type: "object", properties: {} } },
];

/** A provider scripted with a queue of turns. Each turn is a list of TurnEvents (no "end" needed). */
function scriptedProvider(turns: TurnEvent[][]): { provider: AgentModelProvider; seen: AgentTurnRequest[] } {
  const seen: AgentTurnRequest[] = [];
  let i = 0;
  const provider: AgentModelProvider = {
    kind: "anthropic-api",
    model: "fake",
    async *streamTurn(req) {
      seen.push({ ...req, messages: structuredClone(req.messages) });
      const turn = turns[i++] ?? [{ type: "text", text: "done" }];
      for (const ev of turn) yield ev;
      yield { type: "end", stopReason: turn.some((e) => e.type === "tool_use") ? "tool_use" : "end_turn" };
    },
  };
  return { provider, seen };
}

async function collect(iter: AsyncIterable<AgentStep>): Promise<AgentStep[]> {
  const out: AgentStep[] = [];
  for await (const s of iter) out.push(s);
  return out;
}

describe("runAgent loop", () => {
  it("executes tool calls and feeds results back until the model stops", async () => {
    const { provider, seen } = scriptedProvider([
      [{ type: "tool_use", id: "a", name: "navigate", input: { url: "https://x" } }],
      [{ type: "tool_use", id: "b", name: "snapshot", input: {} }],
      [{ type: "text", text: "All done." }],
    ]);
    const calls: string[] = [];
    const steps = await collect(
      runAgent({
        provider,
        system: "s",
        task: "do it",
        tools,
        signal: new AbortController().signal,
        execute: async (name) => {
          calls.push(name);
          return { content: `ok ${name}` };
        },
      }),
    );
    expect(calls).toEqual(["navigate", "snapshot"]);
    expect(steps.filter((s) => s.type === "tool_result").map((s) => (s as { name: string }).name)).toEqual(["navigate", "snapshot"]);
    expect(steps.at(-1)).toEqual({ type: "stop", reason: "done" });
    // Third turn receives the assistant tool_use + user tool_result transcript.
    expect(seen).toHaveLength(3);
    expect(seen[2]!.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", toolUseId: "b", content: "ok snapshot" }] });
  });

  it("stops at the step cap", async () => {
    const loop: TurnEvent[][] = Array.from({ length: 10 }, (_, n) => [{ type: "tool_use", id: `t${n}`, name: "snapshot", input: {} }]);
    const { provider } = scriptedProvider(loop);
    const steps = await collect(
      runAgent({ provider, system: "s", task: "t", tools, maxSteps: 3, signal: new AbortController().signal, execute: async () => ({ content: "r" }) }),
    );
    expect(steps.filter((s) => s.type === "tool_result")).toHaveLength(3);
    expect(steps.at(-1)).toEqual({ type: "stop", reason: "max_steps" });
  });

  it("stops the whole run when the executor throws AgentStopError", async () => {
    const { provider } = scriptedProvider([[{ type: "tool_use", id: "a", name: "navigate", input: {} }]]);
    const steps = await collect(
      runAgent({
        provider,
        system: "s",
        task: "t",
        tools,
        signal: new AbortController().signal,
        execute: async () => {
          throw new AgentStopError("user stopped");
        },
      }),
    );
    expect(steps.at(-1)).toEqual({ type: "stop", reason: "aborted", message: "user stopped" });
  });

  it("reports a failing tool back to the model and keeps going", async () => {
    const { provider, seen } = scriptedProvider([
      [{ type: "tool_use", id: "a", name: "navigate", input: {} }],
      [{ type: "text", text: "recovered" }],
    ]);
    const steps = await collect(
      runAgent({
        provider,
        system: "s",
        task: "t",
        tools,
        signal: new AbortController().signal,
        execute: async () => {
          throw new Error("boom");
        },
      }),
    );
    const result = steps.find((s) => s.type === "tool_result") as { result: { content: string; isError?: boolean } };
    expect(result.result).toEqual({ content: "boom", isError: true });
    expect(seen[1]!.messages.at(-1)).toMatchObject({ content: [{ type: "tool_result", isError: true }] });
    expect(steps.at(-1)).toEqual({ type: "stop", reason: "done" });
  });

  it("aborts before a turn when the signal is already set", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider } = scriptedProvider([[{ type: "text", text: "never" }]]);
    const steps = await collect(runAgent({ provider, system: "s", task: "t", tools, signal: controller.signal, execute: async () => ({ content: "x" }) }));
    expect(steps).toEqual([{ type: "stop", reason: "aborted" }]);
  });

  it("stops once the token budget is spent", async () => {
    const { provider } = scriptedProvider([
      [
        { type: "tool_use", id: "a", name: "snapshot", input: {} },
        { type: "usage", inputTokens: 500, outputTokens: 400, model: "fake" },
      ],
      [{ type: "tool_use", id: "b", name: "snapshot", input: {} }],
    ]);
    const steps = await collect(
      runAgent({ provider, system: "s", task: "t", tools, tokenBudget: 100, signal: new AbortController().signal, execute: async () => ({ content: "r" }) }),
    );
    const usage = steps.find((s) => s.type === "usage") as { totalInputTokens: number; totalOutputTokens: number };
    expect(usage.totalInputTokens).toBe(500);
    expect(steps.at(-1)).toEqual({ type: "stop", reason: "budget" });
  });

  it("counts tokens read from the prompt cache at a tenth toward the budget", async () => {
    const usage = (input: number, cached: number): TurnEvent => ({ type: "usage", inputTokens: input, outputTokens: 0, model: "fake", cachedInputTokens: cached });
    const { provider } = scriptedProvider([
      [{ type: "tool_use", id: "a", name: "snapshot", input: {} }, usage(1000, 900)],
      [{ type: "tool_use", id: "b", name: "snapshot", input: {} }, usage(1000, 900)],
      [{ type: "text", text: "done" }],
    ]);
    // Weighted: (2000 - 1800) + 1800 * 0.1 = 380 tokens, under a 500 budget (2000 raw would be over).
    const steps = await collect(
      runAgent({ provider, system: "s", task: "t", tools, tokenBudget: 500, signal: new AbortController().signal, execute: async () => ({ content: "r" }) }),
    );
    expect(steps.at(-1)).toEqual({ type: "stop", reason: "done" });
    const last = steps.filter((s) => s.type === "usage").at(-1) as { totalInputTokens: number; totalCachedInputTokens: number };
    expect(last).toMatchObject({ totalInputTokens: 2000, totalCachedInputTokens: 1800 });
  });

  it("forwards image tool results as content blocks", async () => {
    const { provider, seen } = scriptedProvider([
      [{ type: "tool_use", id: "a", name: "screenshot", input: {} }],
      [{ type: "text", text: "seen" }],
    ]);
    await collect(
      runAgent({
        provider,
        system: "s",
        task: "t",
        tools,
        signal: new AbortController().signal,
        execute: async () => ({ content: "screenshot", image: { base64: "AAAA", mediaType: "image/png" } }),
      }),
    );
    expect(seen[1]!.messages.at(-1)!.content[0]).toMatchObject({ type: "tool_result", image: { base64: "AAAA", mediaType: "image/png" } });
  });

  it("resumes from a seeded transcript and continues the step + token counters", async () => {
    const { provider, seen } = scriptedProvider([
      [{ type: "tool_use", id: "c", name: "snapshot", input: {} }],
      [{ type: "text", text: "continued" }],
    ]);
    const seedMessages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "original task" }] },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "a", name: "navigate", input: { url: "https://x" } }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: "a", content: "page" }] },
    ];
    const steps = await collect(
      runAgent({
        provider,
        system: "s",
        task: "ignored when seeded",
        tools,
        maxSteps: 2,
        signal: new AbortController().signal,
        seedMessages,
        startSteps: 1,
        startTokens: { input: 10, output: 5 },
        execute: async () => ({ content: "r" }),
      }),
    );
    // First resumed turn sees the full prior transcript (not the task seed).
    expect(seen[0]!.messages).toHaveLength(3);
    expect(seen[0]!.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "original task" }] });
    // One prior step + one new tool exactly hits the maxSteps=2 cap.
    expect(steps.filter((s) => s.type === "tool_result")).toHaveLength(1);
    expect(steps.at(-1)).toEqual({ type: "stop", reason: "max_steps" });
  });
});

describe("parseToolCall", () => {
  it("extracts the last json tool call from model text", () => {
    const text = 'Thinking...\n```json\n{"tool":"navigate","input":{"url":"https://a"}}\n```';
    expect(parseToolCall(text)).toEqual({ name: "navigate", input: { url: "https://a" } });
  });

  it("returns null without a json block", () => {
    expect(parseToolCall("The task is complete. I opened the page.")).toBeNull();
  });

  it("ignores malformed json and blocks without a tool field", () => {
    expect(parseToolCall("```json\n{not json}\n```")).toBeNull();
    expect(parseToolCall('```json\n{"input":{}}\n```')).toBeNull();
  });

  it("defaults input to an empty object", () => {
    expect(parseToolCall('```json\n{"tool":"snapshot"}\n```')).toEqual({ name: "snapshot", input: {} });
  });
});

describe("renderTranscript", () => {
  it("documents tools and serializes the running conversation", () => {
    const { system, blocks } = renderTranscript(
      [
        { role: "user", content: [{ type: "text", text: "find the price" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "navigate", input: { url: "https://shop" } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "page text" }] },
      ],
      tools,
    );
    expect(system).toContain("navigate: Open a URL");
    expect(system).toContain("one tool per reply");
    expect(system).toContain("ends with the latest result");
    const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(text).toContain("Task: find the price");
    expect(text).toContain("You called navigate");
    expect(text).toContain("page text");
    expect(blocks).toHaveLength(3);
  });
});

describe("claude-code-cli session", () => {
  const fake = fileURLToPath(new URL("./fixtures/fake-claude-agent.mjs", import.meta.url));

  it("keeps one process for the run and sends each turn only the new results", async () => {
    chmodSync(fake, 0o755);
    const starts = path.join(mkdtempSync(path.join(os.tmpdir(), "corvus-cli-")), "starts");
    process.env.FAKE_CLAUDE_STARTS = starts;
    try {
      const provider = createClaudeCliAgentProvider({ model: "m", cliPath: fake, timeoutMs: 10_000 });
      const steps = await collect(
        runAgent({ provider, system: "s", task: "find the price", tools, signal: new AbortController().signal, execute: async () => ({ content: "page text" }) }),
      );
      const answer = steps.filter((s) => s.type === "text").map((s) => (s as { text: string }).text).join("");
      // Turn 2 got only the tool result, not the task or its own call again.
      expect(answer.startsWith("received 1 blocks, first: Result of ")).toBe(true);
      expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
      expect(steps.filter((s) => s.type === "usage").at(-1)).toMatchObject({ totalCachedInputTokens: 100 });
      expect(steps.at(-1)).toEqual({ type: "stop", reason: "done" });
    } finally {
      delete process.env.FAKE_CLAUDE_STARTS;
    }
  });
});
