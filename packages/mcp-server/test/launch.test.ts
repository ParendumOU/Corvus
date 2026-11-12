import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENABLE_MCP_SWITCH, corvusExecutable, readDiscovery, waitForCorvus } from "../src/index.js";
import { startCorvus } from "../src/launch.js";

const TARGET = { url: "http://127.0.0.1:40123/mcp", token: "tok-0123456789abcdef" };
/** No process has this id (Linux caps pids far lower). */
const DEAD_PID = 2 ** 30;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until<T>(check: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Parent ids up to init, from /proc (Linux). */
async function ancestors(pid: number): Promise<number[]> {
  const chain: number[] = [];
  for (let current = pid; current > 1; ) {
    const stat = await readFile(`/proc/${current}/stat`, "utf8");
    current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    chain.push(current);
  }
  return chain;
}

describe("finding and starting Corvus", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "corvus-home-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const discover = (data: object) => writeFile(join(home, "mcp.json"), JSON.stringify(data));
  const touch = async (file: string) => {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "");
    return file;
  };

  it("reads the discovery file of a running Corvus", async () => {
    await discover({ ...TARGET, pid: process.pid });
    expect(await readDiscovery(home)).toEqual(TARGET);
  });

  it("ignores a discovery file a crashed Corvus left behind", async () => {
    await discover({ ...TARGET, pid: DEAD_PID });
    expect(await readDiscovery(home)).toBeNull();
    await writeFile(join(home, "mcp.json"), "{not json");
    expect(await readDiscovery(home)).toBeNull();
  });

  it("looks for the executable in CORVUS_BIN, then where Corvus last ran, then the install folder", async () => {
    const installed = await touch(join(home, "LocalAppData", "Programs", "Corvus", "Corvus.exe"));
    const env = { LOCALAPPDATA: join(home, "LocalAppData") };
    expect(await corvusExecutable(home, env, "win32")).toBe(installed);

    const portable = await touch(join(home, "Downloads", "Corvus-Portable-0.3.3.exe"));
    await writeFile(join(home, "app.json"), JSON.stringify({ exe: portable }));
    expect(await corvusExecutable(home, env, "win32")).toBe(portable);

    const custom = await touch(join(home, "bin", "corvus"));
    expect(await corvusExecutable(home, { ...env, CORVUS_BIN: custom }, "win32")).toBe(custom);
    expect(await corvusExecutable(home, { CORVUS_BIN: join(home, "missing") }, "linux")).not.toBe(join(home, "missing"));
  });

  it("uses a running Corvus without starting another", async () => {
    await discover({ ...TARGET, pid: process.pid });
    const started: string[] = [];
    const target = await waitForCorvus({ home, launch: true, start: (exe) => started.push(exe), findExecutable: async () => "/opt/Corvus/corvus", log: () => {} });
    expect(target).toEqual(TARGET);
    expect(started).toEqual([]);
  });

  it("starts Corvus when no server runs and waits for it", async () => {
    const started: string[] = [];
    const target = await waitForCorvus({
      home,
      launch: true,
      timeoutMs: 5_000,
      findExecutable: async () => "/opt/Corvus/corvus",
      start: (exe) => {
        started.push(exe);
        setTimeout(() => void discover({ ...TARGET, pid: process.pid }), 300);
      },
      log: () => {},
    });
    expect(started).toEqual(["/opt/Corvus/corvus"]);
    expect(target).toEqual(TARGET);
    expect(ENABLE_MCP_SWITCH).toBe("--enable-mcp");
  });

  it("only waits when launching is off, and gives up with a hint", async () => {
    const started: string[] = [];
    const logs: string[] = [];
    await expect(
      waitForCorvus({ home, launch: false, timeoutMs: 600, start: (exe) => started.push(exe), log: (m) => logs.push(m) }),
    ).rejects.toThrow(/Enable MCP server/);
    expect(started).toEqual([]);
    expect(logs.join("\n")).toContain("waiting for Corvus");
  });

  // A tree kill of the agent session (taskkill /T, tree-kill) follows parent ids: Corvus must not have the bridge as an ancestor.
  it.skipIf(process.platform !== "linux")("starts Corvus outside the bridge's process tree", async () => {
    const exe = join(home, "corvus");
    await writeFile(exe, '#!/bin/sh\necho "$$ $PPID $1" > "$0.started"\nexec sleep 30\n', { mode: 0o755 });
    startCorvus(exe, () => {});
    const line = await until(async () => (await readFile(`${exe}.started`, "utf8").catch(() => "")).trim());
    const [pid, parent, flag] = line.split(" ");
    const browser = Number(pid);
    const handoff = Number(parent);
    try {
      expect(flag).toBe(ENABLE_MCP_SWITCH);
      expect(handoff).not.toBe(process.pid);
      expect(await until(async () => !alive(handoff), 10_000)).toBe(true);
      expect(alive(browser)).toBe(true);
      expect(await ancestors(browser)).not.toContain(process.pid);
    } finally {
      process.kill(browser, "SIGKILL");
    }
  });

  it("logs when the executable cannot be started", async () => {
    const logs: string[] = [];
    startCorvus(join(home, "missing"), (m) => logs.push(m));
    await until(async () => logs.length > 0);
    expect(logs[0]).toContain("could not start Corvus");
  });

  it("says so when Corvus is not installed where it looks", async () => {
    const logs: string[] = [];
    await expect(waitForCorvus({ home, launch: true, timeoutMs: 600, findExecutable: async () => null, log: (m) => logs.push(m) })).rejects.toThrow();
    expect(logs.join("\n")).toContain("CORVUS_BIN");
  });
});
