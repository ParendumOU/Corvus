import { afterEach, describe, expect, it } from "vitest";
import { MockBrowserController } from "../src/testing/index.js";
import { call, startHarness, textOf, type Harness } from "./helpers.js";

describe("New Tab tools", () => {
  let h: Harness | undefined;
  afterEach(async () => h?.close());

  it("reads the layout with the widget authoring guide", async () => {
    h = await startHarness({ rateLimit: false });
    const client = await h.connect({ name: "newtab-reader" });
    const res = await call(client, "newtab_layout");
    expect(textOf(res)).toContain('"clock-1"');
    expect(textOf(res)).toContain("corvus.onData");
    expect((h.controller as MockBrowserController).newtabRequests).toEqual([{ request: { action: "get" }, client: "newtab-reader" }]);
  });

  it("sends custom widgets with their sources and box, and reports errors", async () => {
    h = await startHarness({ rateLimit: false });
    const client = await h.connect({ name: "newtab-builder" });
    await call(client, "newtab_custom_widget", {
      title: "BTC",
      html: '<div class="cw-value" id="v">…</div>',
      script: "corvus.onData((d) => { v.textContent = d.price.bitcoin.eur; });",
      sources: [{ name: "price", kind: "fetch", url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur", everyMinutes: 5 }],
      w: 3,
      h: 2,
    });
    const sent = (h.controller as MockBrowserController).newtabRequests[0]!;
    expect(sent.client).toBe("newtab-builder");
    expect(sent.request).toMatchObject({ action: "custom", w: 3, h: 2, config: { title: "BTC", sources: [{ name: "price", kind: "fetch" }] } });

    const failed = await call(client, "newtab_remove_widget", { id: "missing" });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("No widget");
  });

  it("is not offered at read-only access, nor by a browser without the capability", async () => {
    h = await startHarness({ accessLevel: "read", rateLimit: false });
    let names = (await (await h.connect()).listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("newtab_"))).toEqual(["newtab_layout"]);
    await h.close();

    const controller = new MockBrowserController({ initialTabs: ["https://example.com/"] });
    Object.defineProperty(controller, "newtab", { value: undefined });
    h = await startHarness({ rateLimit: false }, controller);
    names = (await (await h.connect()).listTools()).tools.map((t) => t.name);
    expect(names.some((n) => n.startsWith("newtab_"))).toBe(false);
  });
});
