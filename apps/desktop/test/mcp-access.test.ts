import { describe, expect, it } from "vitest";
import { requiredLevel, toolAllowed } from "@corvus/mcp-server/access";
import { DEFAULT_RATE_LIMIT } from "@corvus/mcp-server";
import { defaultSettings, MCP_RATE_LIMITS, mergeSettings, resolveMcpAccessLevel } from "../src/shared/settings";

describe("MCP access level settings", () => {
  it("defaults to standard with evaluate off", () => {
    const mcp = defaultSettings().mcp;
    expect(mcp.accessLevel).toBe("standard");
    expect(mcp.allowEvaluate).toBe(false);
  });

  it("resolves the effective level, folding in the legacy allowEvaluate switch", () => {
    expect(resolveMcpAccessLevel({ accessLevel: "read", allowEvaluate: false })).toBe("read");
    expect(resolveMcpAccessLevel({ accessLevel: "standard", allowEvaluate: false })).toBe("standard");
    expect(resolveMcpAccessLevel({ accessLevel: "full", allowEvaluate: false })).toBe("full");
    // A config upgraded from the old boolean (allowEvaluate on, level still standard) keeps full access.
    expect(resolveMcpAccessLevel({ accessLevel: "standard", allowEvaluate: true })).toBe("full");
    expect(resolveMcpAccessLevel({ accessLevel: "read", allowEvaluate: true })).toBe("full");
  });

  it("rejects an invalid accessLevel on merge", () => {
    const base = defaultSettings();
    const merged = mergeSettings(base, { mcp: { accessLevel: "root" } });
    expect(merged.mcp.accessLevel).toBe("standard");
    const ok = mergeSettings(base, { mcp: { accessLevel: "full" } });
    expect(ok.mcp.accessLevel).toBe("full");
  });

  it("keeps a known rate limit (standard by default, the server's own default) and the activity log on", () => {
    const base = defaultSettings();
    expect(base.mcp.rateLimit).toBe("standard");
    expect(MCP_RATE_LIMITS.standard).toEqual(DEFAULT_RATE_LIMIT);
    expect(base.mcp.activityLog).toBe(true);
    expect(mergeSettings(base, { mcp: { rateLimit: "strict" } }).mcp.rateLimit).toBe("strict");
    expect(mergeSettings(base, { mcp: { rateLimit: "none" } }).mcp.rateLimit).toBe("standard");
    expect(mergeSettings(base, { mcp: { rateLimit: "toString" } }).mcp.rateLimit).toBe("standard");
  });

  it("gates full-only tools: evaluate is absent at the standard default", () => {
    const level = resolveMcpAccessLevel(defaultSettings().mcp);
    expect(requiredLevel("evaluate")).toBe("full");
    expect(toolAllowed("evaluate", level)).toBe(false);
    expect(toolAllowed("navigate", level)).toBe(true);
    expect(toolAllowed("evaluate", resolveMcpAccessLevel({ accessLevel: "full", allowEvaluate: false }))).toBe(true);
  });
});
