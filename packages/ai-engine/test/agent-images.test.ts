import { describe, expect, it } from "vitest";
import {
  buildClaudeCliAgentArgs,
  cliStreamJsonInput,
  createLocalAgentProvider,
  MAX_CLI_IMAGES,
  MAX_CONTEXT_IMAGES,
  renderTranscript,
  toAnthropicMessages,
  toLocalMessages,
  type AgentMessage,
  type AgentTool,
  type AgentTurnRequest,
} from "../src/agent.js";

const tools: AgentTool[] = [{ name: "screenshot", description: "Capture the page", inputSchema: { type: "object", properties: {} } }];
const shot = (data: string) => ({ base64: data, mediaType: "image/png" as const });

/** task -> screenshot A -> screenshot B -> screenshot C (each a tool_use/tool_result pair). */
function transcript(images: string[]): AgentMessage[] {
  const out: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "look at the page" }] }];
  images.forEach((data, i) => {
    out.push({ role: "assistant", content: [{ type: "tool_use", id: `s${i}`, name: "screenshot", input: {} }] });
    out.push({ role: "user", content: [{ type: "tool_result", toolUseId: `s${i}`, content: `shot ${i}`, image: shot(data) }] });
  });
  return out;
}

describe("anthropic prompt cache", () => {
  it("puts a cache breakpoint on the last block only", () => {
    const params = toAnthropicMessages(transcript(["AAA"]));
    const blocks = params.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const marked = blocks.filter((b) => "cache_control" in b && b.cache_control);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(blocks.at(-1));
  });
});

describe("anthropic image blocks", () => {
  it("sends the latest screenshots as image blocks and replaces older ones with a note", () => {
    const params = toAnthropicMessages(transcript(["AAA", "BBB", "CCC"]));
    const results = params.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");
    const images = results.map((r) => (r.type === "tool_result" && Array.isArray(r.content) ? r.content.filter((c) => c.type === "image").length : 0));
    expect(images).toEqual([0, 1, 1]);
    expect(images.reduce((a, b) => a + b, 0)).toBe(MAX_CONTEXT_IMAGES);
    const first = results[0]!;
    expect(first.type === "tool_result" && Array.isArray(first.content) && first.content[0]!.type === "text" && first.content[0]!.text).toContain("omitted");
  });
});

describe("claude-code-cli images", () => {
  it("passes the caller's system prompt and puts each recent screenshot right after its result", () => {
    const r = renderTranscript(transcript(["AAA", "BBB", "CCC", "DDD"]), tools, { system: "You are Corvus Assist.", images: "attach" });
    expect(r.system.startsWith("You are Corvus Assist.")).toBe(true);
    expect(r.system).toContain("one tool per reply");
    const kinds = r.blocks.map((b) => (b.type === "image" ? `img:${b.image.base64}` : b.text.split("\n")[0]));
    expect(kinds).toEqual(["Task: look at the page", 'You called screenshot with {}', "Result of s0:", 'You called screenshot with {}', "Result of s1:", "img:BBB", 'You called screenshot with {}', "Result of s2:", "img:CCC", 'You called screenshot with {}', "Result of s3:", "img:DDD"]);
    expect(r.blocks.filter((b) => b.type === "image")).toHaveLength(MAX_CLI_IMAGES);
    expect(r.blocks[2]).toMatchObject({ type: "text", text: "Result of s0:\nshot 0\n(an earlier screenshot, omitted to save tokens)" });
    expect(r.blocks[4]).toMatchObject({ type: "text", text: "Result of s1:\nshot 1\n(the screenshot follows)" });
  });

  it("only appends blocks from one turn to the next, so the prompt cache serves what was sent", () => {
    const before = renderTranscript(transcript(["AAA"]), tools, { images: "attach" }).blocks;
    const after = renderTranscript(transcript(["AAA", "BBB"]), tools, { images: "attach" }).blocks;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("builds a stream-json user message from the blocks, images as base64", () => {
    const line = cliStreamJsonInput([{ type: "text", text: "Task: look" }, { type: "image", image: shot("QUJD") }]);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Task: look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      },
    });
  });

  it("always reads the transcript as stream-json from stdin", () => {
    const args = buildClaudeCliAgentArgs("m", "sys");
    expect(args.slice(args.indexOf("--input-format"), args.indexOf("--input-format") + 2)).toEqual(["--input-format", "stream-json"]);
    expect(args).toContain("--output-format");
    expect(args.at(-1)).toBe("sys");
  });

  it("degrades to a text note (no image) for text-only models", () => {
    const r = renderTranscript(transcript(["AAA"]), tools);
    expect(r.blocks.some((b) => b.type === "image")).toBe(false);
    expect(JSON.stringify(r.blocks)).toContain("cannot view images");
    expect(r.system.startsWith("You are Corvus, an AI agent")).toBe(true);
  });
});

describe("local model images", () => {
  it("adds a text note for a model without vision", () => {
    const msgs = toLocalMessages("sys", transcript(["AAA"]));
    expect(msgs.some((m) => m.images)).toBe(false);
    expect(msgs.find((m) => m.role === "tool")!.content).toContain("cannot view images");
  });

  it("attaches the latest screenshot on a user message for a vision model", () => {
    const msgs = toLocalMessages("sys", transcript(["AAA", "BBB"]), true);
    const withImages = msgs.filter((m) => m.images);
    expect(withImages).toHaveLength(1);
    expect(withImages[0]).toMatchObject({ role: "user", images: ["BBB"] });
    expect(msgs[msgs.indexOf(withImages[0]!) - 1]).toMatchObject({ role: "tool", content: "shot 1" });
    expect(msgs.filter((m) => m.role === "tool")[0]!.content).toContain("omitted");
  });

  it("sends images to an Ollama vision model learned from /api/show", async () => {
    const bodies: any[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "llava" }] }));
      if (url.endsWith("/api/show")) return new Response(JSON.stringify({ capabilities: ["completion", "tools", "vision"] }));
      bodies.push(JSON.parse(String(init.body)));
      return new Response('{"message":{"content":"a red page"},"done":false}\n{"done":true,"prompt_eval_count":3,"eval_count":2}\n');
    }) as unknown as typeof fetch;
    const provider = createLocalAgentProvider({ model: "llava", api: "ollama", fetch: fn });
    const req: AgentTurnRequest = { system: "sys", messages: transcript(["AAA"]), tools, maxTokens: 100, signal: new AbortController().signal };
    for await (const _ of provider.streamTurn(req)) void _;
    expect(bodies[0].messages.some((m: { images?: string[] }) => m.images?.[0] === "AAA")).toBe(true);
  });
});
