import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cmdQuote, isBatchFile, resolveWindowsCommand, systemPromptToFile } from "../src/providers/cli-spawn.js";

describe("starting the Claude Code CLI on Windows", () => {
  const env = { PATH: "C:\\Tools;C:\\Users\\me\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("finds a bare name on PATH with PATHEXT, like a terminal", () => {
    const files = new Set(["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", "C:\\Tools\\ccm.cmd", "C:\\Tools\\claude.exe"]);
    const exists = (f: string) => files.has(f);
    expect(resolveWindowsCommand("ccm", env, exists)).toBe("C:\\Tools\\ccm.cmd");
    // PATH order wins, and .exe comes before .cmd in the same folder.
    expect(resolveWindowsCommand("claude", env, exists)).toBe("C:\\Tools\\claude.exe");
    expect(resolveWindowsCommand("missing", env, exists)).toBe("missing");
  });

  it("completes a path without an extension and keeps an explicit one", () => {
    const exists = (f: string) => f === "D:\\bin\\ccm.cmd";
    expect(resolveWindowsCommand("D:\\bin\\ccm", env, exists)).toBe("D:\\bin\\ccm.cmd");
    expect(resolveWindowsCommand("D:\\bin\\ccm.cmd", env, exists)).toBe("D:\\bin\\ccm.cmd");
    expect(resolveWindowsCommand("D:\\bin\\other.exe", env, exists)).toBe("D:\\bin\\other.exe");
  });

  it("reads Path when PATH is not set (Windows env copies keep the original case)", () => {
    expect(resolveWindowsCommand("ccm", { Path: "C:\\Tools" }, (f) => f === "C:\\Tools\\ccm.cmd")).toBe("C:\\Tools\\ccm.cmd");
  });

  it("knows which files need cmd.exe and quotes their arguments", () => {
    expect(isBatchFile("C:\\Tools\\ccm.CMD")).toBe(true);
    expect(isBatchFile("C:\\Tools\\run.bat")).toBe(true);
    expect(isBatchFile("C:\\Tools\\claude.exe")).toBe(false);
    expect(cmdQuote("")).toBe('""');
    expect(cmdQuote('say "hi"')).toBe('"say ""hi"""');
  });

  describe("system prompt", () => {
    let dir = "";
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("moves into a file so no argument spans lines", () => {
      dir = mkdtempSync(join(tmpdir(), "cli-spawn-"));
      const prompt = "You answer with citations.\nNever invent sources.";
      const args = systemPromptToFile(["-p", "--model", "haiku", "--system-prompt", prompt, "--tools", ""], dir);
      expect(args.slice(0, 3)).toEqual(["-p", "--model", "haiku"]);
      expect(args[3]).toBe("--system-prompt-file");
      expect(readFileSync(args[4]!, "utf8")).toBe(prompt);
      expect(args.slice(5)).toEqual(["--tools", ""]);
      expect(args.some((a) => a.includes("\n"))).toBe(false);
    });

    it("leaves arguments without a system prompt alone", () => {
      dir = mkdtempSync(join(tmpdir(), "cli-spawn-"));
      expect(systemPromptToFile(["-p", "--model", "haiku"], dir)).toEqual(["-p", "--model", "haiku"]);
    });
  });
});
