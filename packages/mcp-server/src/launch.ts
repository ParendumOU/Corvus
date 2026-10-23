import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeTarget } from "./bridge.js";

/**
 * How the stdio bridge finds Corvus, and starts it when it is not running.
 *
 * While its MCP server runs, Corvus writes `mcp.json` ({url, token, pid}) in its home folder
 * (~/.corvus, or $CORVUS_HOME); on every start it also records where its executable lives in
 * `app.json`. When no live server is found, the bridge starts Corvus with --enable-mcp (a normal,
 * visible window), or hands that switch to the running Corvus, which turns its server on, and waits
 * for the discovery file. A client still needs the person's approval in Corvus the first time.
 */

/** Command-line switch that turns on Corvus's MCP server (kept in sync with apps/desktop). */
export const ENABLE_MCP_SWITCH = "--enable-mcp";

const WAIT_MS = 60_000;
const POLL_MS = 500;

export function corvusHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CORVUS_HOME || join(homedir(), ".corvus");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The running server from the discovery file; null when missing or left behind by a crash. */
export async function readDiscovery(home: string): Promise<BridgeTarget | null> {
  const data = await readJson<{ url?: unknown; token?: unknown; pid?: unknown }>(join(home, "mcp.json"));
  if (typeof data?.url !== "string" || typeof data.token !== "string" || !data.url || !data.token) return null;
  if (typeof data.pid === "number" && !alive(data.pid)) return null;
  return { url: data.url, token: data.token };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Where Corvus is installed: $CORVUS_BIN, where it last ran from, then the default install paths. */
export async function corvusExecutable(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const recorded = await readJson<{ exe?: unknown }>(join(home, "app.json"));
  const candidates = [env.CORVUS_BIN, typeof recorded?.exe === "string" ? recorded.exe : undefined];
  if (platform === "win32") {
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Programs", "Corvus", "Corvus.exe"));
    if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, "Corvus", "Corvus.exe"));
  } else if (platform === "darwin") {
    candidates.push("/Applications/Corvus.app/Contents/MacOS/Corvus", join(homedir(), "Applications", "Corvus.app", "Contents", "MacOS", "Corvus"));
  } else {
    candidates.push("/opt/Corvus/corvus", "/usr/bin/corvus");
  }
  for (const file of candidates) if (file && (await exists(file))) return file;
  return null;
}

/** Starts Corvus detached from the bridge, in a visible window, with its MCP server on. */
export function startCorvus(exe: string, log: (message: string) => void): void {
  const child = spawn(exe, [ENABLE_MCP_SWITCH], { detached: true, stdio: "ignore" });
  child.once("error", (err) => log(`could not start Corvus (${exe}): ${err.message}`));
  child.unref();
}

export interface WaitOptions {
  home?: string;
  /** Start Corvus (or turn on the running one's server) when no server is found. */
  launch?: boolean;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Test seam for starting Corvus. */
  start?: (exe: string, log: (message: string) => void) => void;
  findExecutable?: (home: string) => Promise<string | null>;
}

/** Returns the running server, starting Corvus first when allowed. */
export async function waitForCorvus(opts: WaitOptions = {}): Promise<BridgeTarget> {
  const home = opts.home ?? corvusHome();
  const log = opts.log ?? ((m: string) => process.stderr.write(`[corvus-mcp-stdio] ${m}\n`));
  const found = await readDiscovery(home);
  if (found) return found;

  if (opts.launch) {
    const exe = await (opts.findExecutable ?? corvusExecutable)(home);
    if (exe) {
      log(`starting Corvus: ${exe}`);
      (opts.start ?? startCorvus)(exe, log);
    } else {
      log("Corvus is not running and was not found. Start it, or set CORVUS_BIN to its executable.");
    }
  } else {
    log(`waiting for Corvus (no ${join(home, "mcp.json")}; is the MCP server enabled in Corvus > Settings > AI agents?)`);
  }

  const deadline = Date.now() + (opts.timeoutMs ?? WAIT_MS);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const target = await readDiscovery(home);
    if (target) return target;
  }
  throw new Error(
    "Corvus did not start its MCP server in time. Open Corvus and turn on Settings > AI agents > Enable MCP server, " +
      "or set CORVUS_MCP_URL and CORVUS_MCP_TOKEN.",
  );
}
