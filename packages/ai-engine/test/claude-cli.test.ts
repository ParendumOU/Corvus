import { chmodSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt.js";
import { buildClaudeCliArgs, createClaudeCliProvider, StreamJsonParser } from "../src/providers/claude-cli.js";
import type { ProviderEvent } from "../src/providers/types.js";

const fixture = readFileSync(new URL("./fixtures/claude-stream.jsonl", import.meta.url), "utf8");
const fakeCli = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

const prompt = buildPrompt("what is rust", "en", [
  { url: "https://rust-lang.org/", title: "Rust", snippet: "Rust language", source: "rust-lang.org", rank: 1 },
]);

async function collect(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe("StreamJsonParser", () => {
  it("turns text_delta lines into deltas and the result line into usage", () => {
    const parser = new StreamJsonParser("fallback-model");
    const events = [...parser.push(fixture), ...parser.end()];
    const text = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
    expect(text).toBe("Rust is a general-purpose language focused on memory safety [1]; the official book is free online [3].");
    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 412 + 724, outputTokens: 31, model: "claude-haiku-5-5" });
    expect(parser.done).toBe(true);
  });

  it("reassembles lines split across chunks", () => {
    const parser = new StreamJsonParser("m");
    const events: ProviderEvent[] = [];
    for (let i = 0; i < fixture.length; i += 13) events.push(...parser.push(fixture.slice(i, i + 13)));
    events.push(...parser.end());
    expect(events.filter((e) => e.type === "delta")).toHaveLength(3);
  });

  it("falls back to the full assistant message without partial messages", () => {
    const withoutPartials = fixture
      .split("\n")
      .filter((l) => l && !l.includes('"stream_event"'))
      .join("\n");
    const events = new StreamJsonParser("m").push(`${withoutPartials}\n`);
    expect(events[0]).toEqual({
      type: "delta",
      text: "Rust is a general-purpose language focused on memory safety [1]; the official book is free online [3].",
    });
  });

  it("throws on an error result", () => {
    const parser = new StreamJsonParser("m");
    expect(() =>
      parser.push(`${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key" })}\n`),
    ).toThrow(/Invalid API key/);
  });

  it("ignores garbage lines", () => {
    expect(new StreamJsonParser("m").push("not json\n{}\n")).toEqual([]);
  });
});

describe("buildClaudeCliArgs", () => {
  it("disables tools, MCP, settings and session persistence", () => {
    const args = buildClaudeCliArgs("claude-haiku-5-5", "SYS");
    expect(args.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args.at(-1)).toBe("SYS");
  });
});

describe.skipIf(process.platform === "win32")("createClaudeCliProvider (fake binary)", () => {
  beforeAll(() => {
    try {
      chmodSync(fakeCli, 0o755);
    } catch {
      // Read-only checkouts: the file is committed executable.
    }
  });
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_MODE;
  });

  it("streams deltas and usage from the spawned process", async () => {
    const provider = createClaudeCliProvider({ model: "claude-haiku-5-5", cliPath: fakeCli });
    const events = await collect(provider.answer({ prompt, maxOutputTokens: 400 }));
    expect(events.filter((e) => e.type === "delta")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "usage", inputTokens: 1136, outputTokens: 31 });
  });

  it("surfaces CLI error results and crashes", async () => {
    const provider = createClaudeCliProvider({ model: "m", cliPath: fakeCli });
    process.env.FAKE_CLAUDE_MODE = "error";
    await expect(collect(provider.answer({ prompt, maxOutputTokens: 400 }))).rejects.toThrow(/Not logged in/);
    process.env.FAKE_CLAUDE_MODE = "crash";
    await expect(collect(provider.answer({ prompt, maxOutputTokens: 400 }))).rejects.toThrow(/exited with code 2: boom/);
  });

  it("passes extra environment to the CLI process", async () => {
    const provider = createClaudeCliProvider({ model: "m", cliPath: fakeCli, env: { FAKE_CLAUDE_MODE: "error" } });
    await expect(collect(provider.answer({ prompt, maxOutputTokens: 400 }))).rejects.toThrow(/Not logged in/);
  });

  it("reports a missing binary", async () => {
    const provider = createClaudeCliProvider({ model: "m", cliPath: "/nonexistent/claude" });
    await expect(collect(provider.answer({ prompt, maxOutputTokens: 400 }))).rejects.toThrow(/not found/);
  });
});
