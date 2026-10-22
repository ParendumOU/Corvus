/**
 * Rebuilds the model transcript (the AgentMessage array runAgent feeds the provider) from the unified
 * AgentStep stream the runner already receives, so an interrupted run can be resumed. The fold mirrors
 * runAgent's own message construction: streamed text + tool_use become one assistant message per turn,
 * and that turn's tool results become the following user message.
 *
 * The transcript is kept main-side only (never sent to a renderer). Images are dropped from saved
 * results to bound the store; the model simply re-captures on resume if it needs to see the page.
 */
import type { AgentContent, AgentMessage, AgentStep } from "@corvus/ai-engine";
import { MAX_BLOCK_CHARS, MAX_TRANSCRIPT_MESSAGES } from "../shared/agent-run";

/** Accumulates the running transcript from AgentSteps. `snapshot()` returns a consistent copy anytime. */
export class TranscriptBuilder {
  private readonly messages: AgentMessage[] = [];
  private assistant: AgentContent[] = [];
  private results: AgentContent[] = [];
  private textBuf = "";

  /**
   * Seed with the first user message (the task, possibly augmented) to match runAgent's messages[0],
   * or with an existing transcript (to resume appending onto a prior run's messages).
   */
  constructor(seed: string | AgentMessage[]) {
    if (typeof seed === "string") this.messages.push({ role: "user", content: [{ type: "text", text: seed }] });
    else for (const m of seed) this.messages.push({ role: m.role, content: [...m.content] });
  }

  push(step: AgentStep): void {
    switch (step.type) {
      case "text":
        this.flushResults();
        this.textBuf += step.text;
        break;
      case "tool_use":
        this.flushResults();
        this.flushText();
        this.assistant.push({ type: "tool_use", id: step.id, name: step.name, input: step.input });
        break;
      case "tool_result":
        this.flushAssistant();
        this.results.push({
          type: "tool_result",
          toolUseId: step.id,
          content: step.result.content,
          ...(step.result.isError ? { isError: true } : {}),
        });
        break;
      default:
        break;
    }
  }

  /** A valid, bounded copy of the transcript so far (pending turn flushed into throwaway messages). */
  snapshot(): AgentMessage[] {
    const out = this.messages.map((m) => ({ role: m.role, content: [...m.content] }));
    const pendingAssistant = this.pendingAssistant();
    if (pendingAssistant) out.push(pendingAssistant);
    if (this.results.length) out.push({ role: "user", content: [...this.results] });
    return boundTranscript(out);
  }

  private flushText(): void {
    if (this.textBuf) {
      this.assistant.push({ type: "text", text: this.textBuf });
      this.textBuf = "";
    }
  }

  private flushAssistant(): void {
    this.flushText();
    if (this.assistant.length) {
      this.messages.push({ role: "assistant", content: this.assistant });
      this.assistant = [];
    }
  }

  private flushResults(): void {
    if (this.results.length) {
      this.messages.push({ role: "user", content: this.results });
      this.results = [];
    }
  }

  private pendingAssistant(): AgentMessage | null {
    const content = [...this.assistant];
    if (this.textBuf) content.push({ type: "text", text: this.textBuf });
    return content.length ? { role: "assistant", content } : null;
  }
}

/** Cap block sizes, drop result images (already absent here) and trim whole turn-pairs beyond the cap. */
export function boundTranscript(messages: AgentMessage[]): AgentMessage[] {
  const capped = messages.map((m) => ({
    role: m.role,
    content: m.content.map((c): AgentContent => {
      if (c.type === "text") return { type: "text", text: cap(c.text) };
      if (c.type === "tool_result") return { type: "tool_result", toolUseId: c.toolUseId, content: cap(c.content), ...(c.isError ? { isError: true } : {}) };
      return c;
    }),
  }));
  if (capped.length <= MAX_TRANSCRIPT_MESSAGES) return capped;
  // Keep the task head, then drop oldest whole (assistant,user) pairs so no tool_result is orphaned.
  const head = capped[0]!;
  const tail = capped.slice(1);
  const over = capped.length - MAX_TRANSCRIPT_MESSAGES;
  const drop = Math.min(tail.length, over % 2 === 0 ? over : over + 1);
  return [head, ...tail.slice(drop)];
}

/**
 * Make a saved transcript safe to resume from: it must end on a user turn. A trailing assistant
 * message (a half-finished turn, or one whose tool calls never produced results) is dropped so the
 * model simply re-plans from the last user turn. Returns null when nothing resumable remains.
 */
export function normalizeResumeTranscript(messages: readonly AgentMessage[]): AgentMessage[] | null {
  const out = messages.map((m) => ({ role: m.role, content: [...m.content] }));
  while (out.length > 0 && out[out.length - 1]!.role === "assistant") out.pop();
  if (out.length === 0) return null;
  if (out[0]!.role !== "user") return null;
  return out;
}

function cap(text: string): string {
  return text.length > MAX_BLOCK_CHARS ? `${text.slice(0, MAX_BLOCK_CHARS - 1)}…` : text;
}
