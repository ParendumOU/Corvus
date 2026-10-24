import { describe, expect, it } from "vitest";
import { classifyAction, classifyPointAction, type PointTarget } from "../src/shared/agent-safety";
import { cssToDip, fitShot, parseKey, pointOf, shotToCss, wheelDelta } from "../src/shared/visual-input";
import { classifyToolCall, cssPointOf, hitLabel, type ToolRunState } from "../src/main/agent-tools";
import type { AppContext } from "../src/main/context";

const shop = "https://shop.test/item";
const t = (p: Partial<PointTarget>): PointTarget => ({ url: shop, role: "button", name: "", tag: "button", ...p });

describe("screenshot geometry", () => {
  it("keeps a normal viewport 1:1 in CSS px", () => {
    expect(fitShot(1200, 760)).toEqual({ width: 1200, height: 760, cssWidth: 1200, cssHeight: 760 });
  });

  it("scales a large viewport down under the edge and pixel caps", () => {
    const g = fitShot(2560, 1440);
    expect(g.width).toBeLessThanOrEqual(1280);
    expect(g.width * g.height).toBeLessThanOrEqual(1_000_000);
    expect(g.width / g.height).toBeCloseTo(2560 / 1440, 2);
  });

  it("maps screenshot pixels to CSS px through the scale, and rejects points off the image", () => {
    const g = fitShot(2560, 1440);
    const css = shotToCss(g, { x: g.width / 2, y: g.height / 2 })!;
    expect(css.x).toBeCloseTo(1280, 0);
    expect(css.y).toBeCloseTo(720, 0);
    expect(shotToCss(fitShot(800, 600), { x: 400, y: 300 })).toEqual({ x: 400, y: 300 });
    expect(shotToCss(fitShot(800, 600), { x: 800, y: 10 })).toBeNull();
    expect(shotToCss(fitShot(800, 600), { x: -1, y: 10 })).toBeNull();
    // No screenshot yet: the point is taken as CSS px.
    expect(shotToCss(undefined, { x: 12, y: 34 })).toEqual({ x: 12, y: 34 });
  });

  it("maps CSS px to view DIPs with the page zoom (device scale never enters)", () => {
    expect(cssToDip({ x: 100, y: 50 }, 1)).toEqual({ x: 100, y: 50 });
    expect(cssToDip({ x: 100, y: 50 }, 1.25)).toEqual({ x: 125, y: 63 });
    expect(cssToDip({ x: 100, y: 50 }, Number.NaN)).toEqual({ x: 100, y: 50 });
  });

  it("reads points from tool input, numbers or numeric strings only", () => {
    expect(pointOf({ x: 3, y: "4" })).toEqual({ x: 3, y: 4 });
    expect(pointOf({ x: 3 })).toBeNull();
    expect(pointOf({ x: "a", y: 1 })).toBeNull();
    expect(cssPointOf({ tabId: "t", elementNames: new Map(), lastShot: fitShot(1000, 500) }, { x: 999, y: 499 })).toEqual({ x: 999, y: 499 });
  });
});

describe("parseKey", () => {
  it("maps DOM key names to Electron key codes with the typed char", () => {
    expect(parseKey("Enter")).toMatchObject({ keyCode: "Enter", char: "\r", modifiers: [] });
    expect(parseKey("ArrowDown")).toMatchObject({ keyCode: "Down", char: null, label: "ArrowDown" });
    expect(parseKey("Esc")).toMatchObject({ keyCode: "Escape" });
    expect(parseKey(" ")).toMatchObject({ keyCode: "Space", char: " " });
    expect(parseKey("a")).toMatchObject({ keyCode: "A", char: "a" });
    expect(parseKey("F5")).toMatchObject({ keyCode: "F5", char: null });
  });

  it("parses combos and extra modifiers; shortcuts do not type their letter", () => {
    expect(parseKey("Control+A")).toMatchObject({ keyCode: "A", char: null, modifiers: ["control"], label: "Control+A" });
    expect(parseKey("Tab", ["Shift"])).toMatchObject({ keyCode: "Tab", modifiers: ["shift"], label: "Shift+Tab" });
    expect(parseKey("a", ["shift"])).toMatchObject({ char: "A" });
    expect(parseKey("cmd+Enter")).toMatchObject({ keyCode: "Enter", modifiers: ["meta"] });
  });

  it("rejects unknown keys and modifiers", () => {
    expect(parseKey("")).toBeNull();
    expect(parseKey("Hyper+A")).toBeNull();
    expect(parseKey("NotAKey")).toBeNull();
  });
});

describe("wheelDelta", () => {
  it("defaults to 400 px down, DOM sign convention, capped", () => {
    expect(wheelDelta({})).toEqual({ deltaX: 0, deltaY: 400 });
    expect(wheelDelta({ direction: "up", amount: 120 })).toEqual({ deltaX: 0, deltaY: -120 });
    expect(wheelDelta({ direction: "right" })).toEqual({ deltaX: 400, deltaY: 0 });
    expect(wheelDelta({ direction: "down", amount: 99999 })).toEqual({ deltaX: 0, deltaY: 3000 });
  });
});

describe("classifyPointAction (spend gate for coordinates and keys)", () => {
  it("click_at on a Buy now button spends money and always asks", () => {
    const r = classifyPointAction("click_at", { x: 10, y: 10 }, t({ name: "Buy now" }));
    expect(r).toMatchObject({ risky: true, alwaysAsk: true, spend: true });
    expect(r.reason).toMatch(/^Spends money/);
  });

  it("click_at uses the hit element's own text too (custom widgets without a role)", () => {
    const r = classifyPointAction("click_at", { x: 1, y: 1 }, t({ role: "div", tag: "div", name: "", text: "Place order" }));
    expect(r.alwaysAsk).toBe(true);
  });

  it("click_at on a canvas or a plain link does not ask", () => {
    expect(classifyPointAction("click_at", { x: 1, y: 1 }, t({ role: "canvas", tag: "canvas" })).risky).toBe(false);
    expect(classifyPointAction("click_at", { x: 1, y: 1 }, t({ role: "link", tag: "a", name: "Reviews" })).risky).toBe(false);
  });

  it("lets the agent act inside a CAPTCHA so it can solve it, and asks for payment frames and unreadable targets", () => {
    expect(classifyPointAction("click_at", {}, t({ role: "frame", frame: "www.google.com", captcha: true }))).toMatchObject({ risky: false, handoff: false, challenge: true });
    expect(classifyPointAction("click_at", {}, t({ role: "frame", frame: "js.stripe.com", payFrame: true }))).toMatchObject({ alwaysAsk: true, spend: true });
    expect(classifyPointAction("click_at", { x: 5, y: 6 }, null)).toMatchObject({ risky: true, alwaysAsk: true });
    expect(classifyAction("click_at", { x: 5, y: 6 })).toMatchObject({ risky: true, alwaysAsk: true });
  });

  it("press_key Enter on a focused spend button or in a checkout form asks; other keys do not", () => {
    expect(classifyPointAction("press_key", { key: "Enter" }, t({ name: "Place order" })).alwaysAsk).toBe(true);
    expect(classifyPointAction("press_key", { key: " " }, t({ name: "Pay now" })).alwaysAsk).toBe(true);
    const field = t({ role: "textbox", tag: "input", name: "Coupon", url: "https://shop.test/checkout/payment", form: { action: "https://shop.test/checkout/pay" } });
    expect(classifyPointAction("press_key", { key: "Enter" }, field)).toMatchObject({ alwaysAsk: true, spend: true });
    expect(classifyPointAction("press_key", { key: "Tab" }, t({ name: "Place order" })).risky).toBe(false);
    expect(classifyPointAction("press_key", { key: "Enter" }, t({ role: "", tag: "body", none: true })).risky).toBe(false);
    expect(classifyAction("press_key", { key: "Enter" }).alwaysAsk).toBe(true);
    expect(classifyAction("press_key", { key: "ArrowDown" }).risky).toBe(false);
  });

  it("type_text into a password or card field is handed to the person", () => {
    expect(classifyPointAction("type_text", { text: "x" }, t({ role: "textbox", tag: "input", name: "Password", secret: true })).handoff).toBe(true);
    expect(classifyPointAction("type_text", { text: "x" }, t({ role: "textbox", tag: "input", name: "Card number" })).handoff).toBe(true);
    expect(classifyPointAction("type_text", { text: "ravens" }, t({ role: "searchbox", tag: "input", name: "Search" })).risky).toBe(false);
  });

  it("hover_at and scroll_at never ask", () => {
    expect(classifyAction("hover_at", { x: 1, y: 1 }).risky).toBe(false);
    expect(classifyAction("scroll_at", { x: 1, y: 1 }).risky).toBe(false);
  });

  it("labels hits for the step log", () => {
    expect(hitLabel(t({ name: "Buy now" }))).toBe('button "Buy now"');
    expect(hitLabel(t({ role: "canvas", tag: "canvas" }))).toBe("a canvas");
    expect(hitLabel(t({ role: "frame", frame: "js.stripe.com" }))).toBe("an embedded frame from js.stripe.com");
    expect(hitLabel(null)).toMatch(/could not read/);
  });
});

describe("classifyToolCall reads the live target for click_at", () => {
  function ctxWith(hit: PointTarget | null, scripts: string[]): AppContext {
    const wc = {
      isDestroyed: () => false,
      getURL: () => shop,
      executeJavaScriptInIsolatedWorld: async (_world: number, sources: Array<{ code: string }>) => {
        scripts.push(sources[0]!.code);
        return hit;
      },
    };
    return { windows: { findTab: () => ({ window: {}, tab: { url: shop, view: { webContents: wc } } }) } } as unknown as AppContext;
  }

  it("maps the screenshot point to CSS px and gates a spend button in every mode", async () => {
    const scripts: string[] = [];
    const state: ToolRunState = { tabId: "t1", elementNames: new Map(), lastShot: { width: 1000, height: 500, cssWidth: 2000, cssHeight: 1000 } };
    const risk = await classifyToolCall(ctxWith(t({ name: "Buy now" }), scripts), state, "click_at", { x: 100, y: 50 });
    expect(risk).toMatchObject({ alwaysAsk: true, spend: true });
    expect(scripts[0]).toContain("let x = 200, y = 100");
  });

  it("asks when the page cannot be read, and not for a point off the screenshot", async () => {
    const state: ToolRunState = { tabId: "t1", elementNames: new Map(), lastShot: { width: 100, height: 100, cssWidth: 100, cssHeight: 100 } };
    expect((await classifyToolCall(ctxWith(null, []), state, "click_at", { x: 10, y: 10 })).alwaysAsk).toBe(true);
    expect((await classifyToolCall(ctxWith(t({ name: "Buy now" }), []), state, "click_at", { x: 500, y: 10 })).risky).toBe(false);
  });

  it("classifies press_key by the focused element", async () => {
    const state: ToolRunState = { tabId: "t1", elementNames: new Map() };
    expect((await classifyToolCall(ctxWith(t({ name: "Place order" }), []), state, "press_key", { key: "Enter" })).alwaysAsk).toBe(true);
    expect((await classifyToolCall(ctxWith(t({ name: "Place order" }), []), state, "press_key", { key: "Escape" })).risky).toBe(false);
  });
});
