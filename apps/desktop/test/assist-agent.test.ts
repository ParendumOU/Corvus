import { describe, expect, it } from "vitest";
import { actionLabel, assistAgentView, historyActions, resultLabel } from "../src/shared/assist-agent";
import type { AgentRunStep, AgentRunView } from "../src/shared/command-bar-ipc";
import { translate } from "../src/shared/i18n-es";
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

describe("step labels in Spanish", () => {
  const es = (text: string, vars?: Record<string, string | number>): string => translate("es", text, vars);

  it("translates the line and keeps names, hosts and quotes as they are", () => {
    expect(actionLabel("navigate", { url: "https://www.skyscanner.es/vuelos" }, "", es)).toBe("Abrió www.skyscanner.es");
    expect(actionLabel("open_tab", { url: "https://www.google.com/travel/flights" }, "", es)).toBe("Abrió www.google.com en una pestaña nueva");
    expect(actionLabel("web_search", { query: "vuelo barato Lisboa" }, "", es)).toBe('Buscó en la web "vuelo barato Lisboa"');
    expect(actionLabel("type", { ref: "e2", text: "Lisboa", submit: true }, "Destino", es)).toBe('Escribió "Lisboa" en "Destino" y lo envió');
    expect(actionLabel("scroll_at", { x: 1, y: 2, direction: "left" }, "", es)).toBe("Desplazó hacia la izquierda en un punto");
  });

  it("translates result lines and failures", () => {
    expect(resultLabel("click_at", "x", 'Clicked at (1, 2) on button "Buy now".', false, es)).toBe('Hizo clic en (1, 2) sobre button "Buy now"');
    expect(resultLabel("scroll_at", "x", "Scrolled down at (3, 4) over a canvas; page scroll 400/1200 px.", false, es)).toBe(
      "Desplazó hacia abajo en (3, 4) sobre a canvas; la página va por 400/1200 px",
    );
    expect(resultLabel("switch_tab", "x", "Switched to tab t3 at https://www.skyscanner.es/x — Skyscanner", false, es)).toBe("Cambió a www.skyscanner.es");
    expect(resultLabel("click", "Hizo clic en e3", "Element e3 not found", true, es)).toBe("Hizo clic en e3 (falló: Element e3 not found)");
  });

  it("keeps the English lines of coordinate tools", () => {
    expect(resultLabel("hover_at", "x", "Moved the mouse to (5, 6) over a canvas.", false)).toBe("Pointed at (5, 6) over a canvas");
    expect(resultLabel("press_key", "x", 'Pressed Enter in textbox "Search".', false)).toBe('Pressed Enter in textbox "Search"');
    expect(resultLabel("type_text", "x", 'Typed 6 characters into textbox "To".', false)).toBe('Typed 6 characters into textbox "To"');
    expect(resultLabel("fill_login", "Filled your saved login", "Filled the saved login for ana. You cannot read the password.", false)).toBe("Filled your saved login");
    expect(resultLabel("fill_login", "Filled your saved login", "The person no longer allows agents to use this login.", false)).toBe("The person no longer allows agents to use this login");
  });
});

describe("tabs left open", () => {
  it("are offered under the answer once the run ends", () => {
    const leftTabs = [{ id: "t5", title: "Skyscanner", url: "https://www.skyscanner.es/" }];
    expect(assistAgentView(run([step("s1", "open_tab")], { leftTabs })).view.leftTabs).toEqual(leftTabs);
    expect(assistAgentView(run([step("s1", "open_tab")])).view.leftTabs).toBeUndefined();
  });
});
