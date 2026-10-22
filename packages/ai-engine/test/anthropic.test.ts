import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import type { ProviderEvent } from "../src/providers/types.js";

const prompt = buildPrompt("q", "en", [{ url: "https://a.example/", title: "A", snippet: "s", source: "a.example", rank: 1 }]);

describe("createAnthropicProvider", () => {
  it("streams text deltas, sends cache_control on the system prompt and reports real usage", async () => {
    let body: any;
    let options: any;
    const events = [
      {
        type: "message_start",
        message: {
          model: "claude-haiku-5-5-20260901",
          usage: { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 120, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[1]" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42, input_tokens: null } },
      { type: "message_stop" },
    ];
    const client = {
      messages: {
        stream(b: unknown, o: unknown) {
          body = b;
          options = o;
          return (async function* () {
            yield* events;
          })();
        },
      },
    };
    const controller = new AbortController();
    const provider = createAnthropicProvider({ apiKey: "k", model: "claude-haiku-5-5", client: client as never });
    const out: ProviderEvent[] = [];
    for await (const ev of provider.answer({ prompt, maxOutputTokens: 400, signal: controller.signal })) out.push(ev);

    expect(out).toEqual([
      { type: "delta", text: "Hello " },
      { type: "delta", text: "[1]" },
      { type: "usage", inputTokens: 420, outputTokens: 42, model: "claude-haiku-5-5-20260901" },
    ]);
    expect(body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 400,
      system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt.user }],
    });
    expect(options.signal).toBe(controller.signal);
  });
});
