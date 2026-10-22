import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentStep } from "@corvus/ai-engine";
import { MAX_BLOCK_CHARS } from "../src/shared/agent-run";
import { TranscriptBuilder, boundTranscript, normalizeResumeTranscript } from "../src/main/agent-transcript";

const steps: AgentStep[] = [
  { type: "text", text: "think " },
  { type: "tool_use", id: "a", name: "navigate", input: { url: "https://x" } },
  { type: "tool_result", id: "a", name: "navigate", result: { content: "opened" }, durationMs: 1 },
  { type: "tool_use", id: "b", name: "snapshot", input: {} },
  { type: "tool_result", id: "b", name: "snapshot", result: { content: "page text" }, durationMs: 1 },
  { type: "text", text: "final answer" },
  { type: "stop", reason: "done" },
];

describe("TranscriptBuilder", () => {
  it("folds the step stream back into the same messages runAgent would build", () => {
    const b = new TranscriptBuilder("do the task");
    for (const s of steps) b.push(s);
    const msgs = b.snapshot();

    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(msgs[0]).toEqual({ role: "user", content: [{ type: "text", text: "do the task" }] });
    expect(msgs[1]!.content).toEqual([
      { type: "text", text: "think " },
      { type: "tool_use", id: "a", name: "navigate", input: { url: "https://x" } },
    ]);
    expect(msgs[2]!.content).toEqual([{ type: "tool_result", toolUseId: "a", content: "opened" }]);
    expect(msgs[4]!.content).toEqual([{ type: "tool_result", toolUseId: "b", content: "page text" }]);
    expect(msgs[5]!.content).toEqual([{ type: "text", text: "final answer" }]);
  });

  it("marks an error tool result and keeps a mid-run snapshot ending on the pending turn", () => {
    const b = new TranscriptBuilder("t");
    b.push({ type: "tool_use", id: "a", name: "click", input: {} });
    b.push({ type: "tool_result", id: "a", name: "click", result: { content: "boom", isError: true }, durationMs: 1 });
    b.push({ type: "tool_use", id: "b", name: "snapshot", input: {} });
    // No result yet: the run was interrupted mid-tool. The snapshot still ends on the assistant turn.
    const msgs = b.snapshot();
    expect(msgs.at(-1)).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "b", name: "snapshot", input: {} }] });
    expect(msgs[2]).toEqual({ role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "boom", isError: true }] });
  });

  it("can be seeded from an existing transcript and keep appending", () => {
    const seed: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "task" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "navigate", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "ok" }] },
    ];
    const b = new TranscriptBuilder(seed);
    b.push({ type: "text", text: "next" });
    const msgs = b.snapshot();
    expect(msgs).toHaveLength(4);
    expect(msgs.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "next" }] });
  });
});

describe("normalizeResumeTranscript", () => {
  it("drops a trailing assistant turn so the seed ends on a user turn", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "task" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "navigate", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "ok" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "b", name: "click", input: {} }] },
    ];
    const out = normalizeResumeTranscript(msgs)!;
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("leaves a transcript that already ends on a user turn", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "task" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "navigate", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "ok" }] },
    ];
    expect(normalizeResumeTranscript(msgs)!.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("returns null when nothing resumable remains", () => {
    expect(normalizeResumeTranscript([{ role: "assistant", content: [{ type: "text", text: "x" }] }])).toBeNull();
  });
});

describe("boundTranscript", () => {
  it("caps oversized blocks and drops result images", () => {
    const big = "y".repeat(MAX_BLOCK_CHARS + 500);
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "task" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: big, image: { base64: "AAAA", mediaType: "image/png" } }] },
    ];
    const out = boundTranscript(msgs);
    const result = out[2]!.content[0] as { content: string; image?: unknown };
    expect(result.content.length).toBe(MAX_BLOCK_CHARS);
    expect(result.image).toBeUndefined();
  });
});
