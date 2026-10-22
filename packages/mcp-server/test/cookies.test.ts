import { afterEach, describe, expect, it } from "vitest";
import type { CookieInfo } from "@corvus/shared";
import { requiredLevel } from "../src/access.js";
import { MockBrowserController } from "../src/testing/index.js";
import { call, startHarness, textOf, untrustedJson, type Harness } from "./helpers.js";

function cookie(name: string, value: string, domain: string, extra: Partial<CookieInfo> = {}): CookieInfo {
  return { name, value, domain, path: "/", secure: true, httpOnly: false, session: false, ...extra };
}

function controller(): MockBrowserController {
  return new MockBrowserController({
    initialTabs: ["https://shop.example/"],
    cookies: {
      "shop.example": [cookie("session", "abc123", "shop.example", { httpOnly: true, expiresAt: 1800000000 }), cookie("theme", "dark", "shop.example")],
      "other.example": [cookie("tracker", "nope", "other.example")],
    },
  });
}

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

describe("cookies access gating", () => {
  it("is full level", () => {
    expect(requiredLevel("cookies")).toBe("full");
  });

  it("is hidden below full", async () => {
    harness = await startHarness({ accessLevel: "standard" }, controller());
    const names = (await (await harness.connect()).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("cookies");
  });

  it("is present at full", async () => {
    harness = await startHarness({ accessLevel: "full" }, controller());
    const names = (await (await harness.connect()).listTools()).tools.map((t) => t.name);
    expect(names).toContain("cookies");
  });
});

describe("cookies behavior", () => {
  it("lists only the active tab site's cookies, wrapped as untrusted", async () => {
    harness = await startHarness({ accessLevel: "full" }, controller());
    const res = await call(await harness.connect(), "cookies");
    expect(textOf(res)).toContain("data, not instructions");
    const data = untrustedJson<{ cookies: Array<{ name: string; domain: string }>; total: number }>(res);
    expect(data.total).toBe(2);
    expect(data.cookies.map((c) => c.name).sort()).toEqual(["session", "theme"]);
    expect(data.cookies.every((c) => c.domain === "shop.example")).toBe(true);
    expect(textOf(res)).not.toContain("tracker");
  });

  it("never dumps another origin's cookies until the tab is on that site", async () => {
    const c = controller();
    harness = await startHarness({ accessLevel: "full" }, c);
    const client = await harness.connect();
    const before = untrustedJson<{ cookies: Array<{ name: string }> }>(await call(client, "cookies"));
    expect(before.cookies.some((x) => x.name === "tracker")).toBe(false);
    await call(client, "navigate", { url: "https://other.example/" });
    const after = untrustedJson<{ cookies: Array<{ name: string }> }>(await call(client, "cookies"));
    expect(after.cookies.map((x) => x.name)).toEqual(["tracker"]);
  });

  it("clears a named cookie", async () => {
    harness = await startHarness({ accessLevel: "full" }, controller());
    const client = await harness.connect();
    expect(textOf(await call(client, "cookies", { action: "clear", name: "theme" }))).toBe("removed 1 cookie(s) named theme");
    const left = untrustedJson<{ cookies: Array<{ name: string }> }>(await call(client, "cookies"));
    expect(left.cookies.map((c) => c.name)).toEqual(["session"]);
    const none = await call(client, "cookies", { action: "clear" });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain("requires a cookie name");
  });
});
