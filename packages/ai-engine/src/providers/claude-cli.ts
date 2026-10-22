import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { AnswerProvider, AnswerRequest, ProviderEvent } from "./types.js";

export interface ClaudeCliProviderOptions {
  model: string;
  /** Path to the Claude Code binary. Default "claude". On Windows point it at claude.exe, not a .cmd shim. */
  cliPath?: string;
  /** Hard limit for one answer, in ms. Default 60000. */
  timeoutMs?: number;
}

/**
 * Flags for a single tool-less, stateless, hook-less completion:
 * --tools ""             no built-in tools
 * --strict-mcp-config    no MCP servers (none passed via --mcp-config)
 * --setting-sources ""   skip user/project/local settings, so the user's hooks and plugins do not run
 * --system-prompt        replace Claude Code's default agent prompt with ours
 * --include-partial-messages  real token-level text deltas
 * --effort low           keep adaptive thinking short (it cannot be switched off from the CLI)
 */
export function buildClaudeCliArgs(model: string, systemPrompt: string): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    model,
    "--effort",
    "low",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--system-prompt",
    systemPrompt,
  ];
}

export const CLI_THINKING_HEADROOM = 1024;

export class ClaudeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

interface StreamJsonUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose` output.
 * Text comes from stream_event/text_delta lines; when partial messages are unavailable it
 * falls back to the full assistant message. Usage comes from the final `result` line.
 */
export class StreamJsonParser {
  private buffer = "";
  private sawDelta = false;
  private model: string;
  private finished = false;

  constructor(defaultModel: string) {
    this.model = defaultModel;
  }

  get done(): boolean {
    return this.finished;
  }

  push(chunk: string): ProviderEvent[] {
    this.buffer += chunk;
    const events: ProviderEvent[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) events.push(...this.parseLine(line));
    }
    return events;
  }

  end(): ProviderEvent[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? this.parseLine(rest) : [];
  }

  private parseLine(line: string): ProviderEvent[] {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    // Ignore anything produced by a nested tool/subagent context.
    if (msg.parent_tool_use_id) return [];
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && typeof msg.model === "string") this.model = msg.model;
        return [];
      case "stream_event": {
        const ev = msg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          this.sawDelta = true;
          return [{ type: "delta", text: String(ev.delta.text) }];
        }
        return [];
      }
      case "assistant": {
        if (this.sawDelta) return [];
        const blocks: Array<{ type: string; text?: string }> = msg.message?.content ?? [];
        const text = blocks
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("");
        return text ? [{ type: "delta", text }] : [];
      }
      case "result": {
        this.finished = true;
        if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
          throw new ClaudeCliError(`Claude Code CLI: ${String(msg.result || msg.subtype || "error")}`);
        }
        const usage: StreamJsonUsage = msg.usage ?? {};
        const model = Object.keys(msg.modelUsage ?? {})[0] ?? this.model;
        return [
          {
            type: "usage",
            inputTokens:
              (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
            outputTokens: usage.output_tokens ?? 0,
            model,
          },
        ];
      }
      default:
        return [];
    }
  }
}

/** Uses the locally installed Claude Code and the user's own login. Personal use only. */
export function createClaudeCliProvider(opts: ClaudeCliProviderOptions): AnswerProvider {
  const cliPath = opts.cliPath ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    kind: "claude-code-cli",
    model: opts.model,
    async *answer(req: AnswerRequest): AsyncIterable<ProviderEvent> {
      const child = spawn(cliPath, buildClaudeCliArgs(opts.model, req.prompt.system), {
        // A neutral cwd keeps project CLAUDE.md files out of the context.
        cwd: tmpdir(),
        env: {
          ...process.env,
          // The CLI's output cap also counts thinking tokens, and hitting it makes Claude Code send a
          // second "continue" request that re-reads the whole prompt. Headroom avoids that.
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.maxOutputTokens + CLI_THINKING_HEADROOM),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const kill = () => {
        if (child.exitCode === null) child.kill();
      };
      const timer = setTimeout(kill, timeoutMs);
      req.signal?.addEventListener("abort", kill, { once: true });

      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => {
        if (stderr.length < 4000) stderr += d;
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      // Surface spawn errors (e.g. ENOENT) through the iterator rather than as unhandled rejections.
      exited.catch(() => undefined);

      child.stdin.on("error", () => undefined);
      child.stdin.end(req.prompt.user);

      const parser = new StreamJsonParser(opts.model);
      try {
        child.stdout.setEncoding("utf8");
        for await (const chunk of child.stdout) {
          for (const ev of parser.push(chunk as string)) yield ev;
        }
        for (const ev of parser.end()) yield ev;
        const code = await exited;
        if (req.signal?.aborted) return;
        if (!parser.done) {
          throw new ClaudeCliError(
            `Claude Code CLI exited with code ${code ?? "null"}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
          );
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ClaudeCliError(`Claude Code CLI not found at "${cliPath}"`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", kill);
        kill();
      }
    },
  };
}
