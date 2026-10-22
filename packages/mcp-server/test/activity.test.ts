import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpToolResultEvent } from "@corvus/shared";
import { call, startHarness, textOf, uniqueClientName, type Harness } from "./helpers.js";

describe("tool activity hooks", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("reports duration, outcome and result size for every call", async () => {
    const results: McpToolResultEvent[] = [];
    h = await startHarness({ onToolResult: (e) => results.push(e), rateLimit: false });
    const name = uniqueClientName("activity");
    const client = await h.connect({ name });
    await call(client, "tabs_list");
    await call(client, "tab_close", { tabId: "nope" });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ client: name, tool: "tabs_list", ok: true });
    expect(results[0]!.resultChars).toBeGreaterThan(10);
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(results[1]).toMatchObject({ tool: "tab_close", ok: false });
  });

  it("fails tool calls when the onToolCall observer refuses them (pause switch)", async () => {
    const onToolCall = vi.fn(() => {
      throw new Error("Agents are paused in Corvus");
    });
    h = await startHarness({ onToolCall, rateLimit: false });
    const client = await h.connect();
    const before = (await h.controller.listTabs()).length;
    const result = await call(client, "tab_open", { url: "https://example.org/" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Agents are paused in Corvus");
    expect((await h.controller.listTabs()).length).toBe(before);
  });

  it("revokeClient closes the client's sessions and forgets its approval", async () => {
    const onClientConnect = vi.fn(async () => true);
    h = await startHarness({ onClientConnect, rateLimit: false });
    const name = uniqueClientName("revoke");
    const client = await h.connect({ name });
    await call(client, "tabs_list");
    expect(onClientConnect).toHaveBeenCalledTimes(1);
    h.handle.revokeClient?.(name);
    await expect(call(client, "tabs_list")).rejects.toThrow();
    await h.connect({ name });
    expect(onClientConnect).toHaveBeenCalledTimes(2);
  });
});
