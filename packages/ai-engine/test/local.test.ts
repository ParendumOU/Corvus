import { describe, expect, it } from "vitest";
import {
  createLocalAgentProvider,
  type AgentTurnRequest,
  type TurnEvent,
} from "../src/agent.js";
import { buildPrompt } from "../src/prompt.js";
import {
  createLocalProvider,
  detectLocalCapabilities,
  isToolsUnsupported,
  LocalModelError,
  normalizeBaseUrl,
  streamLocalChat,
  testLocalConnection,
  type LocalChatEvent,
} from "../src/providers/local.js";
import type { ProviderEvent } from "../src/providers/types.js";

const prompt = buildPrompt("q", "en", [{ url: "https://a.example/", title: "A", snippet: "s", source: "a.example", rank: 1 }]);

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch stub that streams the given chunks as the body, recording every call. */
function streamingFetch(chunksByUrl: (url: string) => { chunks?: string[]; status?: number; json?: unknown; text?: string }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const spec = chunksByUrl(url);
    const status = spec.status ?? 200;
    if (spec.json !== undefined) return new Response(JSON.stringify(spec.json), { status });
    if (spec.text !== undefined) return new Response(spec.text, { status });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const chunk of spec.chunks ?? []) c.enqueue(enc.encode(chunk));
        c.close();
      },
    });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function collect(it: AsyncIterable<ProviderEvent> | AsyncIterable<LocalChatEvent> | AsyncIterable<TurnEvent>): Promise<any[]> {
  const out: any[] = [];
  for await (const ev of it as AsyncIterable<any>) out.push(ev);
  return out;
}

describe("normalizeBaseUrl", () => {
  it("defaults per api and strips trailing slashes", () => {
    expect(normalizeBaseUrl("", "ollama")).toBe("http://localhost:11434");
    expect(normalizeBaseUrl("", "openai")).toBe("http://localhost:8080");
    expect(normalizeBaseUrl("http://host:1234/", "ollama")).toBe("http://host:1234");
    expect(normalizeBaseUrl("http://host:1234/v1/", "openai")).toBe("http://host:1234/v1");
  });
});

describe("createLocalProvider (ollama)", () => {
  it("streams NDJSON content as deltas and reports eval counts as usage", async () => {
    const { fn, calls } = streamingFetch(() => ({
      chunks: [
        '{"model":"llama3.1","message":{"role":"assistant","content":"Hello "},"done":false}\n',
        '{"message":{"content":"[1]"},"done":fa', // split across chunks to exercise buffering
        'lse}\n',
        '{"model":"llama3.1:8b","done":true,"prompt_eval_count":30,"eval_count":12}\n',
      ],
    }));
    const provider = createLocalProvider({ model: "llama3.1", baseUrl: "http://localhost:11434", api: "ollama", fetch: fn });
    const out = await collect(provider.answer({ prompt, maxOutputTokens: 400 }));

    expect(out).toEqual([
      { type: "delta", text: "Hello " },
      { type: "delta", text: "[1]" },
      { type: "usage", inputTokens: 30, outputTokens: 12, model: "llama3.1:8b" },
    ]);
    expect(calls[0]!.url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      model: "llama3.1",
      stream: true,
      options: { num_predict: 400 },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    });
    expect(body.tools).toBeUndefined();
  });

  it("surfaces a non-2xx response as a LocalModelError", async () => {
    const { fn } = streamingFetch(() => ({ status: 404, text: JSON.stringify({ error: "model 'ghost' not found" }) }));
    const provider = createLocalProvider({ model: "ghost", api: "ollama", fetch: fn });
    await expect(collect(provider.answer({ prompt, maxOutputTokens: 100 }))).rejects.toThrow(/404.*not found/);
  });
});

describe("createLocalProvider (openai)", () => {
  it("streams SSE deltas and reads usage from the final chunk", async () => {
    const { fn, calls } = streamingFetch(() => ({
      chunks: [
        'data: {"model":"local","choices":[{"delta":{"content":"Hi "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"there"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ],
    }));
    const provider = createLocalProvider({ model: "local", baseUrl: "http://localhost:1234/v1", api: "openai", fetch: fn });
    const out = await collect(provider.answer({ prompt, maxOutputTokens: 256 }));

    expect(out).toEqual([
      { type: "delta", text: "Hi " },
      { type: "delta", text: "there" },
      { type: "usage", inputTokens: 11, outputTokens: 5, model: "local" },
    ]);
    expect(calls[0]!.url).toBe("http://localhost:1234/v1/chat/completions");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_tokens: 256 });
  });
});

describe("streamLocalChat tool calls", () => {
  it("emits an ollama native tool call with object arguments", async () => {
    const { fn } = streamingFetch(() => ({
      chunks: [
        '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"navigate","arguments":{"url":"https://x.example"}}}]},"done":false}\n',
        '{"done":true,"prompt_eval_count":5,"eval_count":3}\n',
      ],
    }));
    const out = await collect(
      streamLocalChat(
        { model: "m", api: "ollama", fetch: fn },
        { messages: [{ role: "user", content: "go" }], tools: [{ name: "navigate", description: "", parameters: { type: "object", properties: {} } }], maxTokens: 100 },
      ),
    );
    expect(out[0]).toMatchObject({ type: "tool_call", name: "navigate", arguments: { url: "https://x.example" } });
    expect(out.at(-1)).toEqual({ type: "usage", inputTokens: 5, outputTokens: 3, model: "m" });
  });

  it("accumulates fragmented openai tool-call arguments across chunks", async () => {
    const { fn } = streamingFetch(() => ({
      chunks: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"click","arguments":"{\\"ref\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"e3\\"}"}}]}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":4}}\n\n',
        "data: [DONE]\n\n",
      ],
    }));
    const out = await collect(
      streamLocalChat(
        { model: "m", api: "openai", fetch: fn },
        { messages: [{ role: "user", content: "x" }], tools: [{ name: "click", description: "", parameters: { type: "object", properties: {} } }], maxTokens: 100 },
      ),
    );
    expect(out).toContainEqual({ type: "tool_call", id: "call_1", name: "click", arguments: { ref: "e3" } });
    expect(out.at(-1)).toEqual({ type: "usage", inputTokens: 8, outputTokens: 4, model: "m" });
  });
});

describe("detectLocalCapabilities / testLocalConnection", () => {
  it("reports ollama models and native-tool support from /api/tags and /api/show", async () => {
    const { fn } = streamingFetch((url) => {
      if (url.endsWith("/api/tags")) return { json: { models: [{ name: "llama3.1:8b" }, { name: "qwen2.5:7b" }] } };
      if (url.endsWith("/api/show")) return { json: { capabilities: ["completion", "tools"] } };
      return { status: 404, text: "no" };
    });
    const result = await testLocalConnection({ model: "llama3.1", api: "ollama", fetch: fn });
    expect(result).toMatchObject({ ok: true, supportsTools: true, modelPresent: true, models: ["llama3.1:8b", "qwen2.5:7b"] });
  });

  it("folds an unreachable server into reachable:false without throwing", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const caps = await detectLocalCapabilities({ model: "m", api: "ollama", fetch: fn });
    expect(caps).toMatchObject({ reachable: false, tools: false });
    expect(caps.error).toMatch(/ECONNREFUSED/);
  });
});

describe("isToolsUnsupported", () => {
  it("matches tool-rejection errors and 404/501, not plain errors", () => {
    expect(isToolsUnsupported(new LocalModelError("model does not support tools"))).toBe(true);
    expect(isToolsUnsupported(new LocalModelError("gone", 404))).toBe(true);
    expect(isToolsUnsupported(new LocalModelError("boom", 500))).toBe(false);
    expect(isToolsUnsupported(new Error("tools"))).toBe(false);
  });
});

describe("createLocalAgentProvider", () => {
  const req: AgentTurnRequest = {
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    tools: [{ name: "navigate", description: "open url", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }],
    maxTokens: 512,
    signal: new AbortController().signal,
  };

  it("uses native tools when told they are supported", async () => {
    const { fn, calls } = streamingFetch(() => ({
      chunks: [
        '{"message":{"content":"on it","tool_calls":[{"function":{"name":"navigate","arguments":{"url":"https://x"}}}]},"done":false}\n',
        '{"done":true,"prompt_eval_count":10,"eval_count":4}\n',
      ],
    }));
    const provider = createLocalAgentProvider({ model: "m", api: "ollama", supportsTools: true, fetch: fn });
    const out = await collect(provider.streamTurn(req));

    expect(out).toContainEqual({ type: "text", text: "on it" });
    expect(out).toContainEqual({ type: "tool_use", id: expect.any(String), name: "navigate", input: { url: "https://x" } });
    expect(out.at(-1)).toEqual({ type: "end", stopReason: "tool_use" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "navigate" } });
  });

  it("degrades to the text tool-call protocol when the model has no native tools", async () => {
    const { fn, calls } = streamingFetch((url) => {
      if (url.endsWith("/api/tags")) return { json: { models: [{ name: "m" }] } };
      if (url.endsWith("/api/show")) return { json: { capabilities: ["completion"] } };
      return {
        chunks: [
          '{"message":{"content":"```json\\n{\\"tool\\":\\"navigate\\",\\"input\\":{\\"url\\":\\"https://y\\"}}\\n```"},"done":false}\n',
          '{"done":true,"prompt_eval_count":7,"eval_count":2}\n',
        ],
      };
    });
    const provider = createLocalAgentProvider({ model: "m", api: "ollama", fetch: fn });
    const out = await collect(provider.streamTurn(req));

    expect(out).toContainEqual({ type: "tool_use", id: expect.any(String), name: "navigate", input: { url: "https://y" } });
    expect(out.at(-1)).toEqual({ type: "end", stopReason: "tool_use" });
    // The chat call carried no tools param (text protocol).
    const chatCall = calls.find((c) => c.url.endsWith("/api/chat"))!;
    expect(JSON.parse(String(chatCall.init.body)).tools).toBeUndefined();
  });
});
