import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENABLE_MCP_SWITCH, corvusExecutable, readDiscovery, waitForCorvus } from "../src/index.js";

const TARGET = { url: "http://127.0.0.1:40123/mcp", token: "tok-0123456789abcdef" };
/** No process has this id (Linux caps pids far lower). */
const DEAD_PID = 2 ** 30;

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

  it("says so when Corvus is not installed where it looks", async () => {
    const logs: string[] = [];
    await expect(waitForCorvus({ home, launch: true, timeoutMs: 600, findExecutable: async () => null, log: (m) => logs.push(m) })).rejects.toThrow();
    expect(logs.join("\n")).toContain("CORVUS_BIN");
  });
});
