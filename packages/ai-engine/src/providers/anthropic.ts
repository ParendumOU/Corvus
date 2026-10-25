import type Anthropic from "@anthropic-ai/sdk";
import type { AnswerProvider, AnswerRequest, ProviderEvent } from "./types.js";

type MessagesClient = Pick<Anthropic, "messages">;

/**
 * An Anthropic client, made on first use: the SDK is large and most starts of the app never call
 * the API, so it is loaded only then. The same promise serves every later call.
 */
export function lazyAnthropicClient(make: (Sdk: typeof Anthropic) => MessagesClient): () => Promise<MessagesClient> {
  let client: Promise<MessagesClient> | undefined;
  return () => (client ??= import("@anthropic-ai/sdk").then((sdk) => make(sdk.default)));
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** Injected in tests. */
  client?: MessagesClient;
}

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Total billed input = uncached + cache writes + cache reads. */
export function totalInputTokens(usage: UsageLike): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): AnswerProvider {
  const injected = opts.client;
  const client = injected ? async () => injected : lazyAnthropicClient((Sdk) => new Sdk({ apiKey: opts.apiKey, maxRetries: 1, timeout: 30_000 }));
  return {
    kind: "anthropic-api",
    model: opts.model,
    async *answer(req: AnswerRequest): AsyncIterable<ProviderEvent> {
      const stream = (await client()).messages.stream(
        {
          model: opts.model,
          max_tokens: req.maxOutputTokens,
          thinking: { type: "disabled" },
          system: [{ type: "text", text: req.prompt.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: req.prompt.user }],
        },
        { signal: req.signal },
      );
      let model = opts.model;
      const usage: UsageLike = {};
      for await (const event of stream) {
        if (event.type === "message_start") {
          model = event.message.model;
          Object.assign(usage, event.message.usage);
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          if (event.delta.text) yield { type: "delta", text: event.delta.text };
        } else if (event.type === "message_delta") {
          // message_delta usage is cumulative; only overwrite fields it actually reports.
          for (const [key, value] of Object.entries(event.usage)) {
            if (typeof value === "number") (usage as Record<string, number>)[key] = value;
          }
        }
      }
      yield { type: "usage", inputTokens: totalInputTokens(usage), outputTokens: usage.output_tokens ?? 0, model };
    },
  };
}
