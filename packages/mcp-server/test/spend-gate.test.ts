import { afterEach, describe, expect, it } from "vitest";
import { MockBrowserController, type MockBrowserControllerOptions, type MockPage } from "../src/testing/index.js";
import { call, startHarness, textOf, type Harness } from "./helpers.js";

const SHOP = "https://shop.example/product/42";
const CHECKOUT = "https://shop.example/checkout";

const PRODUCT_PAGE: MockPage = {
  title: "Raven umbrella",
  text: "The Raven travel umbrella costs 42 dollars.",
  elements: [
    { ref: "e1", role: "button", name: "Place order" },
    { ref: "e2", role: "link", name: "Books" },
    { ref: "e3", role: "link", name: "Order history" },
    { ref: "e4", role: "button", name: "Add to cart" },
    { ref: "e5", role: "searchbox", name: "Search products" },
    { ref: "e6", role: "textbox", name: "Promo code" },
    { ref: "e7", role: "button", name: "Comprar" },
    { ref: "e8", role: "button", name: "Kinnita tellimus" },
  ],
  forms: {
    e5: { action: "https://shop.example/search", submitName: "Search", submitRole: "button" },
    e6: { action: SHOP, submitName: "Place order", submitRole: "button" },
  },
};

const CHECKOUT_PAGE: MockPage = {
  title: "Checkout",
  text: "Shipping and payment.",
  elements: [
    { ref: "e1", role: "textbox", name: "Email" },
    { ref: "e2", role: "button", name: "Continue" },
  ],
};

function controller(opts: Partial<MockBrowserControllerOptions> = {}): MockBrowserController {
  return new MockBrowserController({ initialTabs: [SHOP], pages: { [SHOP]: PRODUCT_PAGE, [CHECKOUT]: CHECKOUT_PAGE }, ...opts });
}

const clicks = (c: MockBrowserController): unknown[] => c.calls.filter((x) => x.method === "click").map((x) => x.args[1]);
const types = (c: MockBrowserController): unknown[] => c.calls.filter((x) => x.method === "type").map((x) => x.args[1]);

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

describe("spend gate: click", () => {
  it("asks the user before a click that spends money, and clicks once allowed", async () => {
    const c = controller();
    harness = await startHarness({ accessLevel: "standard" }, c);
    const res = await call(await harness.connect(), "click", { ref: "e1" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("ok");
    expect(c.spendPrompts).toHaveLength(1);
    expect(c.spendPrompts[0]!.request).toEqual({ action: 'Click "Place order" on shop.example', host: "shop.example" });
    expect(clicks(c)).toEqual(["e1"]);
  });

  it("returns a clear tool error on Deny and clicks nothing", async () => {
    const c = controller({ spendApproval: () => false });
    harness = await startHarness({ accessLevel: "standard" }, c);
    const res = await call(await harness.connect(), "click", { ref: "e1" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('The user declined: Click "Place order" on shop.example spends money');
    expect(textOf(res)).toContain("request_user_action");
    expect(clicks(c)).toEqual([]);
  });

  it("asks at every access level that can click", async () => {
    for (const accessLevel of ["standard", "full"] as const) {
      const c = controller({ spendApproval: () => false });
      harness = await startHarness({ accessLevel }, c);
      const res = await call(await harness.connect(), "click", { ref: "e7" });
      expect(res.isError, accessLevel).toBe(true);
      expect(c.spendPrompts.map((p) => p.request.action)).toEqual(['Click "Comprar" on shop.example']);
      await harness.close();
    }
    harness = undefined as unknown as Harness;
  });

  it("catches Spanish and Estonian spend buttons", async () => {
    const c = controller();
    harness = await startHarness({ accessLevel: "standard" }, c);
    const client = await harness.connect();
    await call(client, "click", { ref: "e7" });
    await call(client, "click", { ref: "e8" });
    expect(c.spendPrompts.map((p) => p.request.action)).toEqual(['Click "Comprar" on shop.example', 'Click "Kinnita tellimus" on shop.example']);
  });

  it("does not ask for Books, Order history or Add to cart", async () => {
    const c = controller({ spendApproval: () => false });
    harness = await startHarness({ accessLevel: "standard" }, c);
    const client = await harness.connect();
    for (const ref of ["e2", "e3", "e4"]) expect((await call(client, "click", { ref })).isError, ref).toBeFalsy();
    expect(c.spendPrompts).toEqual([]);
    expect(clicks(c)).toEqual(["e2", "e3", "e4"]);
  });

  it("fails closed when the browser cannot ask", async () => {
    const c = Object.assign(controller(), { confirmSpend: undefined });
    harness = await startHarness({ accessLevel: "standard" }, c);
    const res = await call(await harness.connect(), "click", { ref: "e1" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("cannot ask the user");
    expect(clicks(c)).toEqual([]);
  });

  it("still classifies from a snapshot when the browser cannot read the target live", async () => {
    const c = Object.assign(controller({ spendApproval: () => false }), { describeTarget: undefined });
    harness = await startHarness({ accessLevel: "standard" }, c);
    const res = await call(await harness.connect(), "click", { ref: "e1" });
    expect(res.isError).toBe(true);
    expect(clicks(c)).toEqual([]);
  });
});

describe("spend gate: type with submit", () => {
  it("asks before Enter in a form whose default button spends money", async () => {
    const c = controller({ spendApproval: () => false });
    harness = await startHarness({ accessLevel: "standard" }, c);
    const res = await call(await harness.connect(), "type", { ref: "e6", text: "SPRING", submit: true });
    expect(res.isError).toBe(true);
    expect(c.spendPrompts[0]!.request.action).toBe('Submit "Place order" on shop.example');
    expect(types(c)).toEqual([]);
  });

  it("asks before Enter on a checkout page, and types once allowed", async () => {
    const c = controller();
    harness = await startHarness({ accessLevel: "standard" }, c);
    const client = await harness.connect();
    await call(client, "navigate", { url: CHECKOUT });
    const res = await call(client, "type", { ref: "e1", text: "a@b.c", submit: true });
    expect(res.isError).toBeFalsy();
    expect(c.spendPrompts.map((p) => p.request.action)).toEqual(["Submit a checkout or payment form on shop.example"]);
    expect(types(c)).toEqual(["e1"]);
  });

  it("does not ask for a search submit or for typing without submit", async () => {
    const c = controller({ spendApproval: () => false });
    harness = await startHarness({ accessLevel: "standard" }, c);
    const client = await harness.connect();
    expect((await call(client, "type", { ref: "e5", text: "umbrella", submit: true })).isError).toBeFalsy();
    expect((await call(client, "type", { ref: "e6", text: "SPRING" })).isError).toBeFalsy();
    expect(c.spendPrompts).toEqual([]);
    expect(types(c)).toEqual(["e5", "e6"]);
  });
});

describe("spend gate: fill_fields with submit", () => {
  it("asks before submitting on a checkout page; Deny fills but does not submit", async () => {
    const c = controller({ initialTabs: [CHECKOUT], spendApproval: () => false });
    harness = await startHarness({ accessLevel: "full" }, c);
    const res = await call(await harness.connect(), "fill_fields", { fields: [{ name: "Email", value: "a@b.c" }], submit: true, submitName: "Continue" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("filled 1/1; not submitted. The user declined");
    expect(c.spendPrompts.map((p) => p.request.action)).toEqual(['Click "Continue" on shop.example']);
    expect(clicks(c)).toEqual([]);
  });

  it("submits once allowed", async () => {
    const c = controller({ initialTabs: [CHECKOUT] });
    harness = await startHarness({ accessLevel: "full" }, c);
    const res = await call(await harness.connect(), "fill_fields", { fields: [{ name: "Email", value: "a@b.c" }], submit: true, submitName: "Continue" });
    expect(textOf(res)).toBe('filled 1/1; submitted via "Continue"');
    expect(clicks(c)).toEqual(["e2"]);
  });
});
