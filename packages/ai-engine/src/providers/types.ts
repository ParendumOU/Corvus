import type { AIProviderKind } from "@corvus/shared";
import type { BuiltPrompt } from "../prompt.js";

export type ProviderEvent =
  | { type: "delta"; text: string }
  /** inputTokens counts every input token; cachedInputTokens the part read from the prompt cache. */
  | { type: "usage"; inputTokens: number; outputTokens: number; model: string; cachedInputTokens?: number };

export interface AnswerRequest {
  prompt: BuiltPrompt;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

/** One LLM call that streams the grounded answer. Implementations must honor the AbortSignal. */
export interface AnswerProvider {
  readonly kind: AIProviderKind;
  readonly model: string;
  answer(req: AnswerRequest): AsyncIterable<ProviderEvent>;
  /**
   * Optional: starts a call before its user message is known (the Claude Code CLI starts its
   * process, so that part of its start-up overlaps the web search). Aborting `signal` before the
   * call is made releases it unused, without any request.
   */
  prepare?(call: PreparedCall): PreparedAnswer;
}

export interface PreparedCall {
  system: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface PreparedAnswer {
  answer(user: string): AsyncIterable<ProviderEvent>;
}

export const DEFAULT_MODEL = "claude-haiku-5-5";
