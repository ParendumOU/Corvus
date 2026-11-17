import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userData: "", unusable: new Set<number>(), calls: [] as number[] }));

vi.mock("electron", () => ({ app: { getPath: () => state.userData, isPackaged: false } }));
vi.mock("../src/main/module-loader", () => ({
  loadOptionalModule: async () => ({
    startMcpServer: async (opts: { port: number }) => {
      state.calls.push(opts.port);
      if (state.unusable.has(opts.port)) throw Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${opts.port}`), { code: "EACCES" });
      return { port: opts.port || 50123, close: async () => undefined };
    },
  }),
}));

import { McpService } from "../src/main/mcp-service";
import type { AppContext } from "../src/main/context";

function service(port: number): { mcp: McpService; saved: () => number } {
  let settings = { mcp: { enabled: true, host: "127.0.0.1", port, accessLevel: "standard", allowEvaluate: false, approvedClients: [], rateLimit: "standard", activityLog: false } };
  const ctx = {
    settings: {
      get: () => settings,
      onChange: () => () => undefined,
      mcpToken: () => "token",
      update: (patch: { mcp: { port: number } }) => {
        settings = { ...settings, mcp: { ...settings.mcp, ...patch.mcp } };
      },
    },
    windows: { broadcastState: () => undefined },
    search: { proxy: {} },
    controller: {},
  } as unknown as AppContext;
  return { mcp: new McpService(ctx), saved: () => settings.mcp.port };
}

describe("McpService port", () => {
  beforeEach(() => {
    state.userData = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-mcp-port-"));
    process.env.CORVUS_HOME = state.userData;
    state.unusable.clear();
    state.calls = [];
  });
  afterEach(() => {
    delete process.env.CORVUS_HOME;
    fs.rmSync(state.userData, { recursive: true, force: true });
  });

  it("picks a new port when the one it picked itself became unusable", async () => {
    const first = service(0);
    await first.mcp.apply();
    expect(first.saved()).toBe(50123);
    await first.mcp.stop();

    state.unusable.add(50123);
    state.calls = [];
    const next = service(50123);
    await next.mcp.apply();
    expect(state.calls).toEqual([50123, 0]);
    expect(next.mcp.isRunning()).toBe(true);
    expect(next.mcp.status().error).toBeNull();
  });

  it("keeps a port the person typed and reports the error", async () => {
    state.unusable.add(8765);
    const typed = service(8765);
    await typed.mcp.apply();
    expect(state.calls).toEqual([8765]);
    expect(typed.mcp.isRunning()).toBe(false);
    expect(typed.saved()).toBe(8765);
    expect(typed.mcp.status().error).toMatch(/EACCES/);
  });
});
