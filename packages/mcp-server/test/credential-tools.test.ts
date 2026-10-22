import { afterEach, describe, expect, it } from "vitest";
import { requiredLevel } from "../src/access.js";
import { MockBrowserController } from "../src/testing/index.js";
import { call, startHarness, textOf, type Harness } from "./helpers.js";

const URL_ = "https://login.example/";

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

describe("fill_totp / fill_login access gating", () => {
  it("are full level", () => {
    expect(requiredLevel("fill_totp")).toBe("full");
    expect(requiredLevel("fill_login")).toBe("full");
  });

  it("are hidden below full, present at full", async () => {
    harness = await startHarness({ accessLevel: "standard" }, new MockBrowserController({ initialTabs: [URL_] }));
    const standard = (await (await harness.connect()).listTools()).tools.map((t) => t.name);
    expect(standard).not.toContain("fill_totp");
    expect(standard).not.toContain("fill_login");
    await harness.close();
    harness = await startHarness({ accessLevel: "full" }, new MockBrowserController({ initialTabs: [URL_] }));
    const full = (await (await harness.connect()).listTools()).tools.map((t) => t.name);
    expect(full).toContain("fill_totp");
    expect(full).toContain("fill_login");
  });

  it("refuse calls below full without touching the browser", async () => {
    harness = await startHarness({ accessLevel: "standard" }, new MockBrowserController({ initialTabs: [URL_] }));
    const res = await call(await harness.connect(), "fill_totp", { ref: "e1" });
    expect(res.isError).toBe(true);
    expect(harness.controller.calls.some((c) => c.method === "fillTotp")).toBe(false);
  });
});

describe("fill_totp / fill_login behaviour", () => {
  it("hands off by default (no opt-in), as a normal result", async () => {
    harness = await startHarness({ accessLevel: "full" }, new MockBrowserController({ initialTabs: [URL_] }));
    const res = await call(await harness.connect(), "fill_totp", { ref: "e4" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("request_user_action");
  });

  it("passes ref and username to the browser and reports the fill without the code", async () => {
    const controller = new MockBrowserController({
      initialTabs: [URL_],
      credentialFill: (kind, _tab, opts) => ({ status: "filled", message: `Filled the ${kind} for ${opts.username ?? "?"} into ${opts.ref ?? "the form"}.` }),
    });
    harness = await startHarness({ accessLevel: "full" }, controller);
    const client = await harness.connect();
    const totp = await call(client, "fill_totp", { ref: "e4", username: "alice" });
    expect(textOf(totp)).toBe("Filled the totp for alice into e4.");
    const login = await call(client, "fill_login", {});
    expect(textOf(login)).toBe("Filled the login for ? into the form.");
    expect(controller.calls.filter((c) => c.method === "fillTotp")[0]?.args.slice(1)).toEqual(["e4", { username: "alice" }]);
    expect(controller.calls.filter((c) => c.method === "fillLogin")[0]?.args.slice(1)).toEqual([{}]);
  });

  it("marks only real failures as errors", async () => {
    let status: "declined" | "error" = "declined";
    const controller = new MockBrowserController({ initialTabs: [URL_], credentialFill: () => ({ status, message: status }) });
    harness = await startHarness({ accessLevel: "full" }, controller);
    const client = await harness.connect();
    expect((await call(client, "fill_login", { ref: "e2" })).isError).toBeFalsy();
    status = "error";
    expect((await call(client, "fill_login", { ref: "e2" })).isError).toBe(true);
  });

  it("validates the ref shape", async () => {
    harness = await startHarness({ accessLevel: "full" }, new MockBrowserController({ initialTabs: [URL_] }));
    const res = await call(await harness.connect(), "fill_totp", {});
    expect(res.isError).toBe(true);
  });
});
