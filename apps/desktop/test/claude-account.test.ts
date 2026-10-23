import { describe, expect, it } from "vitest";
import { claudeCliEnv, defaultSettings, mergeSettings, parseEnvLines } from "../src/shared/settings";

const ai = (patch: Record<string, unknown>) => mergeSettings(defaultSettings(), { ai: patch }).ai;

describe("Claude Code account and CLI environment", () => {
  it("reads NAME=value lines, skipping blanks, comments and invalid names", () => {
    expect(parseEnvLines("HTTPS_PROXY=http://proxy:8080\n\n# note\n  ANTHROPIC_BASE_URL = https://gw.example \nbad name=1\n=x\nA=1\nA=2")).toEqual({
      HTTPS_PROXY: "http://proxy:8080",
      ANTHROPIC_BASE_URL: "https://gw.example",
      A: "2",
    });
  });

  it("leaves the CLI alone by default", () => {
    expect(claudeCliEnv(defaultSettings().ai)).toEqual({});
  });

  it("uses a chosen config folder over the variables", () => {
    expect(claudeCliEnv(ai({ claudeAccount: "folder", claudeConfigDir: " /home/me/.claude-work ", cliEnv: "CLAUDE_CONFIG_DIR=/x\nFOO=1" }))).toEqual({
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
      FOO: "1",
    });
  });

  it("follows the connected Claude Code session once one reported its folder", () => {
    expect(claudeCliEnv(ai({ claudeAccount: "mcp" }))).toEqual({});
    expect(claudeCliEnv(ai({ claudeAccount: "mcp", mcpClaudeConfigDir: "/home/me/.claude-team-4", mcpClaudeAt: 1 }))).toEqual({
      CLAUDE_CONFIG_DIR: "/home/me/.claude-team-4",
    });
    // A session on the default folder clears a folder Corvus itself may have been started with.
    expect(claudeCliEnv(ai({ claudeAccount: "mcp", mcpClaudeConfigDir: "", mcpClaudeAt: 1 }))).toEqual({ CLAUDE_CONFIG_DIR: "" });
  });

  it("drops an unknown account mode from stored settings", () => {
    expect(ai({ claudeAccount: "ccm" }).claudeAccount).toBe("default");
  });
});
