import { describe, expect, it } from "vitest";
import { actionLabel, assistAgentView, historyActions, resultLabel } from "../src/shared/assist-agent";
import type { AgentRunStep, AgentRunView } from "../src/shared/command-bar-ipc";
import { describeFocusedScript, describePointScript, pointerFallbackScript, viewportScript } from "../src/main/page-scripts";

function run(steps: AgentRunStep[], patch: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id: "r1",
    task: "t",
    status: "done",
    steps,
    finalText: "",
    error: null,
    stepCount: steps.filter((s) => s.kind !== "message").length,
    maxSteps: 40,
    inputTokens: 1,
    outputTokens: 1,
    provider: "claude-code-cli",
    model: "m",
    tabId: "t1",
    approval: null,
    startedAt: 0,
    ...patch,
  };
}

const step = (id: string, kind: string, extra: Partial<AgentRunStep> = {}): AgentRunStep => ({ id, kind, summary: "", status: "ok", at: 0, ...extra });

describe("step labels", () => {
  it("reads like what the agent did", () => {
    expect(actionLabel("navigate", { url: "https://github.com/corvus/issues" })).toBe("Opened github.com");
    expect(actionLabel("click", { ref: "e4" }, "Sign in")).toBe('Clicked "Sign in"');
    expect(actionLabel("click", { ref: "e4" })).toBe("Clicked e4");
    expect(actionLabel("type", { ref: "e2", text: "ravens", submit: true }, "Search")).toBe('Typed "ravens" into "Search" and submitted');
    expect(actionLabel("web_search", { query: "cheapest flight to Lisbon" })).toBe('Searched the web for "cheapest flight to Lisbon"');
    expect(actionLabel("screenshot", {})).toBe("Took a screenshot");
    expect(actionLabel("click_at", { x: 10.4, y: 20.6 })).toBe("Clicked at (10, 21)");
    expect(actionLabel("open_tab", { url: "https://www.skyscanner.es/vuelos", group: "Vuelos" })).toBe("Opened www.skyscanner.es in a new tab");
    expect(actionLabel("close_tab", { tabId: "t4" })).toBe("Closed a tab that led nowhere");
  });

  it("uses the result sentence for coordinate tools and marks failures", () => {
    expect(resultLabel("click_at", "Clicked at (1, 2)", 'Clicked at (1, 2) on button "Buy now".', false)).toBe('Clicked at (1, 2) on button "Buy now"');
    expect(resultLabel("navigate", "Opened a.test", "Opened https://a.test — A", false)).toBe("Opened a.test");
    expect(resultLabel("switch_tab", "Switched to another tab", "Switched to tab t3 at https://www.skyscanner.es/x — Skyscanner", false)).toBe("Switched to www.skyscanner.es");
    expect(resultLabel("click", 'Clicked "Go"', "Element e3 not found; take a new page_snapshot", true)).toBe('Clicked "Go" (failed: Element e3 not found; take a new page_snapshot)');
  });
});

describe("assistAgentView", () => {
  it("splits interim notes from the closing answer and attaches thumbnails", () => {
    const { view, answer } = assistAgentView(
      run([
        step("m1", "message", { detail: "Let me look at the page." }),
        step("s1", "screenshot", { label: "Took a screenshot" }),
        step("s2", "click", { label: 'Clicked "Next"' }),
        step("m2", "message", { detail: "Page 3 has the cheapest one: 41 euros." }),
      ]),
      new Map([["s1", "data:image/jpeg;base64,AAAA"]]),
    );
    expect(answer).toBe("Page 3 has the cheapest one: 41 euros.");
    expect(view.steps.map((s) => [s.kind, s.label])).toEqual([
      ["message", "Let me look at the page."],
      ["screenshot", "Took a screenshot"],
      ["click", 'Clicked "Next"'],
    ]);
    expect(view.steps[1]!.thumb).toBe("data:image/jpeg;base64,AAAA");
    expect(historyActions(view)).toEqual(["Took a screenshot", 'Clicked "Next"']);
  });

  it("a plain answer has no steps; a capped run says why it stopped", () => {
    expect(assistAgentView(run([step("m", "message", { detail: "Ravens are larger." })])).view.steps).toEqual([]);
    expect(assistAgentView(run([step("a", "click")], { stopReason: "max_steps" })).view.limit).toBe("max_steps");
  });
});

describe("page scripts for the coordinate tools", () => {
  it("are valid JavaScript", () => {
    for (const code of [describePointScript(10, 20), describeFocusedScript(), viewportScript(), pointerFallbackScript("click", 1, 2), pointerFallbackScript("scroll", 1, 2, 0, 300)]) {
      expect(() => new Function(`return ${code}`)).not.toThrow();
    }
  });

  it("escape the regexes they carry", () => {
    const code = describePointScript(1, 1);
    expect(code).toContain("challenges\\.cloudflare\\.com");
    expect(code).toContain(".split(/\\s+/)");
  });
});
