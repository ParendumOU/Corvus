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
}

export const DEFAULT_MODEL = "claude-haiku-5-5";
