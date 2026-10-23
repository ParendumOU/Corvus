import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

export interface CliSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Where Windows finds a command the way a terminal does: a bare name is looked up on PATH with each
 * PATHEXT extension, a path without an extension gets them too. Unresolved names come back as given.
 */
export function resolveWindowsCommand(cli: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean = existsSync): string {
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const withExt = (base: string): string | null => {
    if (win32.extname(base) && exists(base)) return base;
    for (const ext of exts) if (exists(base + ext.toLowerCase())) return base + ext.toLowerCase();
    return null;
  };
  if (/[\\/]/.test(cli)) return withExt(cli) ?? cli;
  for (const dir of (env.PATH || env.Path || "").split(";").filter(Boolean)) {
    const found = withExt(win32.join(dir, cli));
    if (found) return found;
  }
  return cli;
}

/** Whether Node needs cmd.exe to start this file (batch wrappers such as npm's claude.cmd). */
export function isBatchFile(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file);
}

/** One argument for a cmd.exe command line; the arguments Corvus passes carry no % or newlines. */
export function cmdQuote(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Moves the `--system-prompt <text>` pair into a file, since cmd.exe cannot pass a multi-line argument. */
export function systemPromptToFile(args: string[], dir: string): string[] {
  const i = args.indexOf("--system-prompt");
  if (i < 0 || i + 1 >= args.length) return args;
  const file = join(dir, "system-prompt.txt");
  writeFileSync(file, args[i + 1]!, "utf8");
  return [...args.slice(0, i), "--system-prompt-file", file, ...args.slice(i + 2)];
}

/**
 * Starts the Claude Code CLI, or the wrapper the person set instead. On Windows a .cmd/.bat wrapper
 * (npm's claude.cmd, account switchers) runs through cmd.exe with the system prompt in a temporary
 * file, and stopping it stops the whole process tree, not only cmd.exe.
 */
export function spawnCli(cliPath: string, args: string[], opts: CliSpawnOptions): ChildProcessWithoutNullStreams {
  const common = { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], windowsHide: true };
  if (process.platform !== "win32") return spawn(cliPath, args, common);
  const command = resolveWindowsCommand(cliPath, opts.env);
  if (!isBatchFile(command)) return spawn(command, args, common);

  const dir = mkdtempSync(join(tmpdir(), "corvus-cli-"));
  const line = [command, ...systemPromptToFile(args, dir)].map(cmdQuote).join(" ");
  const child = spawn(opts.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...common, windowsVerbatimArguments: true });
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  child.once("close", cleanup);
  child.once("error", cleanup);
  const killShell = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    if (child.pid !== undefined && child.exitCode === null) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).once("error", () => undefined);
    }
    return killShell(signal);
  };
  return child;
}
