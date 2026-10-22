import { describe, expect, it } from "vitest";
import { applyRequestRules, applyResponseRules, isBlocked, resolveOverride } from "../src/rules.js";
import type { CapturedResponse, OutboundRequest, RuleSet } from "../src/types.js";

const req: OutboundRequest = {
  method: "GET",
  url: "https://example.com/api?q=1",
  headers: [{ name: "User-Agent", value: "old" }],
  body: "name=alice",
};

function rules(partial: Partial<RuleSet>): RuleSet {
  return { matchReplace: [], block: [], hostOverride: [], ...partial };
}

describe("match/replace", () => {
  it("rewrites request header, url and body", () => {
    const set = rules({
      matchReplace: [
        { id: "1", name: "ua", enabled: true, target: "request-header", match: "User-Agent: old", replace: "User-Agent: new", regex: false },
        { id: "2", name: "url", enabled: true, target: "request-url", match: "q=1", replace: "q=2", regex: false },
        { id: "3", name: "body", enabled: true, target: "request-body", match: "alice", replace: "bob", regex: false },
      ],
    });
    const out = applyRequestRules(req, set);
    expect(out.request.headers[0]).toEqual({ name: "User-Agent", value: "new" });
    expect(out.request.url).toBe("https://example.com/api?q=2");
    expect(out.request.body).toBe("name=bob");
  });
  it("ignores disabled rules", () => {
    const set = rules({ matchReplace: [{ id: "1", name: "x", enabled: false, target: "request-body", match: "alice", replace: "bob", regex: false }] });
    expect(applyRequestRules(req, set).request.body).toBe("name=alice");
  });
  it("supports response-body regex", () => {
    const res: CapturedResponse = { status: 200, headers: [], body: "token=abcd1234" };
    const set = rules({ matchReplace: [{ id: "1", name: "redact", enabled: true, target: "response-body", match: "token=\\w+", replace: "token=REDACTED", regex: true }] });
    expect(applyResponseRules(res, set).body).toBe("token=REDACTED");
  });
});

describe("block rules", () => {
  it("blocks matching urls", () => {
    const set = rules({ block: [{ id: "1", name: "ads", enabled: true, pattern: "https://example.com/api*" }] });
    expect(isBlocked(req.url, set)?.name).toBe("ads");
    expect(applyRequestRules(req, set).blockedBy).toBe("ads");
  });
});

describe("host override", () => {
  it("maps a host to an address", () => {
    const set = rules({ hostOverride: [{ id: "1", enabled: true, host: "example.com", address: "127.0.0.1" }] });
    expect(resolveOverride(req.url, set)?.address).toBe("127.0.0.1");
    expect(applyRequestRules(req, set).override?.address).toBe("127.0.0.1");
  });
});
