import { describe, expect, it } from "vitest";
import {
  applyPromptAddendum,
  capAccessLevel,
  isValidPattern,
  matchSiteProfile,
  normalizeInput,
  parsePattern,
  reviveProfile,
  type SiteProfile,
} from "../src/shared/site-profiles";
import { AGENT_TOOL_ACCESS, CREDENTIAL_AGENT_TOOLS, TOOLS, agentToolset, capAgentTools } from "../src/main/agent-tools";

function profile(partial: Partial<SiteProfile>): SiteProfile {
  return {
    id: partial.id ?? "p1",
    pattern: "example.com",
    label: "",
    enabled: true,
    promptAddendum: "",
    promptPosition: "append",
    accessCap: null,
    provider: null,
    model: null,
    createdAt: 0,
    ...partial,
  };
}

describe("parsePattern", () => {
  it("splits host, wildcard and path", () => {
    expect(parsePattern("https://Docs.Example.com/API/")).toEqual({ host: "docs.example.com", wildcard: false, path: "/api" });
    expect(parsePattern("*.example.com")).toEqual({ host: "example.com", wildcard: true, path: "" });
    expect(parsePattern("example.com:8443")).toEqual({ host: "example.com", wildcard: false, path: "" });
  });
  it("rejects empty or malformed patterns", () => {
    expect(parsePattern("")).toBeNull();
    expect(parsePattern("/just/path")).toBeNull();
    expect(isValidPattern("example.com")).toBe(true);
    expect(isValidPattern("")).toBe(false);
  });
});

describe("matchSiteProfile", () => {
  it("matches a bare domain and its subdomains", () => {
    const p = [profile({ pattern: "example.com" })];
    expect(matchSiteProfile(p, "https://example.com/x")?.id).toBe("p1");
    expect(matchSiteProfile(p, "https://app.example.com/")?.id).toBe("p1");
    expect(matchSiteProfile(p, "https://notexample.com/")).toBeNull();
  });

  it("wildcard matches subdomains only, not the apex", () => {
    const p = [profile({ pattern: "*.example.com" })];
    expect(matchSiteProfile(p, "https://app.example.com/")?.id).toBe("p1");
    expect(matchSiteProfile(p, "https://example.com/")).toBeNull();
  });

  it("honors a path prefix segment-boundary", () => {
    const p = [profile({ pattern: "example.com/app" })];
    expect(matchSiteProfile(p, "https://example.com/app")?.id).toBe("p1");
    expect(matchSiteProfile(p, "https://example.com/app/settings")?.id).toBe("p1");
    expect(matchSiteProfile(p, "https://example.com/apple")).toBeNull();
  });

  it("picks the most specific match", () => {
    const bare = profile({ id: "bare", pattern: "example.com" });
    const host = profile({ id: "host", pattern: "docs.example.com" });
    const path = profile({ id: "path", pattern: "docs.example.com/api" });
    const all = [bare, host, path];
    expect(matchSiteProfile(all, "https://docs.example.com/api/v1")?.id).toBe("path");
    expect(matchSiteProfile(all, "https://docs.example.com/other")?.id).toBe("host");
    expect(matchSiteProfile(all, "https://www.example.com/")?.id).toBe("bare");
  });

  it("skips disabled profiles and non-http urls", () => {
    expect(matchSiteProfile([profile({ enabled: false })], "https://example.com/")).toBeNull();
    expect(matchSiteProfile([profile({})], "corvus://newtab/")).toBeNull();
    expect(matchSiteProfile([profile({})], "not a url")).toBeNull();
  });
});

describe("capAccessLevel", () => {
  it("narrows but never widens", () => {
    expect(capAccessLevel("full", "read")).toBe("read");
    expect(capAccessLevel("standard", "full")).toBe("standard");
    expect(capAccessLevel("full", null)).toBe("full");
    expect(capAccessLevel("read", "standard")).toBe("read");
  });
});

describe("applyPromptAddendum", () => {
  it("prepends, appends, or leaves the base unchanged", () => {
    expect(applyPromptAddendum("BASE", profile({ promptAddendum: "NOTE", promptPosition: "append" }))).toBe("BASE\n\nNOTE");
    expect(applyPromptAddendum("BASE", profile({ promptAddendum: "NOTE", promptPosition: "prepend" }))).toBe("NOTE\n\nBASE");
    expect(applyPromptAddendum("BASE", profile({ promptAddendum: "   " }))).toBe("BASE");
    expect(applyPromptAddendum("BASE", null)).toBe("BASE");
  });
});

describe("capAgentTools", () => {
  it("read removes exactly click and type", () => {
    const names = capAgentTools(TOOLS, "read").map((t) => t.name);
    expect(names).not.toContain("click");
    expect(names).not.toContain("type");
    expect(names).toContain("page_snapshot");
    expect(names).toContain("navigate");
    expect(names).toContain("ask_user");
  });
  it("standard and full keep every tool", () => {
    expect(capAgentTools(TOOLS, "standard")).toHaveLength(TOOLS.length);
    expect(capAgentTools(TOOLS, "full")).toHaveLength(TOOLS.length);
  });
  it("every tool has a declared access level", () => {
    for (const t of [...TOOLS, ...CREDENTIAL_AGENT_TOOLS]) expect(AGENT_TOOL_ACCESS[t.name]).toBeDefined();
  });
  it("credential tools need full access, so a capped site profile drops them", () => {
    const { tools } = agentToolset(true);
    expect(capAgentTools(tools, "full").map((t) => t.name)).toEqual(expect.arrayContaining(["fill_login", "fill_totp"]));
    expect(capAgentTools(tools, "standard").map((t) => t.name)).not.toContain("fill_totp");
    expect(capAgentTools(tools, "standard").map((t) => t.name)).not.toContain("fill_login");
  });
});

describe("agentToolset", () => {
  it("offers the credential tools only when agents may use opted-in logins", () => {
    const off = agentToolset(false);
    expect(off.tools).toBe(TOOLS);
    expect(off.system).not.toContain("fill_totp");
    const on = agentToolset(true);
    expect(on.tools.map((t) => t.name)).toEqual([...TOOLS.map((t) => t.name), "fill_login", "fill_totp"]);
    expect(on.system).toContain("fill_totp");
    expect(on.system).toContain("ask_user");
  });
});

describe("normalizeInput / reviveProfile", () => {
  it("clamps fields and drops invalid provider", () => {
    const n = normalizeInput({
      pattern: "  Example.com  ",
      label: "x".repeat(200),
      enabled: true,
      promptAddendum: "y".repeat(5000),
      promptPosition: "weird" as never,
      accessCap: "bogus" as never,
      provider: "bogus" as never,
      model: "  gpt  ",
    });
    expect(n.pattern).toBe("Example.com");
    expect(n.label).toHaveLength(80);
    expect(n.promptAddendum).toHaveLength(2000);
    expect(n.promptPosition).toBe("append");
    expect(n.accessCap).toBeNull();
    expect(n.provider).toBeNull();
    expect(n.model).toBe("gpt");
  });
  it("reviveProfile rejects a profile with no usable pattern", () => {
    expect(reviveProfile({ id: "a", pattern: "/nohost" })).toBeNull();
    expect(reviveProfile({ id: "a", pattern: "example.com" })?.pattern).toBe("example.com");
    expect(reviveProfile(null)).toBeNull();
  });
});
