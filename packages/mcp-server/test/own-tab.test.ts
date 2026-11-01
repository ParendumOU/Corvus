import { afterEach, describe, expect, it } from "vitest";
import { MockBrowserController } from "../src/testing/index.js";
import { NO_OWN_TAB } from "../src/server.js";
import { call, startHarness, textOf, untrustedJson, type Harness } from "./helpers.js";

interface TabJson {
  id: string;
  url: string;
  active?: boolean;
}

const USER_PAGE = "https://mail.example/inbox";

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

async function start(): Promise<{ controller: MockBrowserController; userTab: string }> {
  const controller = new MockBrowserController({ initialTabs: [USER_PAGE] });
  harness = await startHarness({ rateLimit: false }, controller);
  return { controller, userTab: (await controller.listTabs())[0]!.id };
}

async function front(controller: MockBrowserController): Promise<TabJson | undefined> {
  return (await controller.listTabs()).find((t) => t.active);
}

describe("an agent works in tabs of its own", () => {
  it("never acts on the user's tab by default: actions refuse, reads read it", async () => {
    const { controller, userTab } = await start();
    const client = await harness.connect();
    for (const [tool, args] of [
      ["click", { ref: "e1" }],
      ["type", { ref: "e2", text: "hello" }],
      ["back", {}],
      ["press_keys", { keys: ["Enter"] }],
    ] as const) {
      const res = await call(client, tool, args);
      expect(res.isError, tool).toBe(true);
      expect(textOf(res), tool).toContain(NO_OWN_TAB);
    }
    expect(controller.calls.filter((c) => ["click", "type", "goBack", "input"].includes(c.method))).toEqual([]);
    expect(textOf(await call(client, "page_snapshot"))).toContain(USER_PAGE);
    expect(controller.calls.at(-1)?.method).toBe("snapshot");
    expect(controller.calls.at(-1)?.args[0]).toBe(userTab);
  });

  it("navigate without a tab of its own opens one in the background and keeps working there", async () => {
    const { controller, userTab } = await start();
    const client = await harness.connect();
    const tab = untrustedJson<TabJson>(await call(client, "navigate", { url: "https://shop.example/" }));
    expect(tab.id).not.toBe(userTab);
    expect(tab.active).toBeUndefined();
    expect(await front(controller)).toMatchObject({ id: userTab, url: USER_PAGE });

    expect(textOf(await call(client, "click", { ref: "e1" }))).toBe("ok");
    expect(controller.calls.at(-1)).toEqual({ method: "click", args: [tab.id, "e1"] });
    const next = untrustedJson<TabJson>(await call(client, "navigate", { url: "https://shop.example/cart" }));
    expect(next.id).toBe(tab.id);
    expect((await controller.listTabs()).length).toBe(2);
    expect(await front(controller)).toMatchObject({ id: userTab, url: USER_PAGE });
  });

  it("uses the latest tab it opened or named, and forgets closed ones", async () => {
    const { controller, userTab } = await start();
    const client = await harness.connect();
    const a = untrustedJson<TabJson>(await call(client, "tab_open", { url: "https://a.example/" }));
    const b = untrustedJson<TabJson>(await call(client, "tab_open", { url: "https://b.example/" }));
    await call(client, "click", { ref: "e1" });
    expect(controller.calls.at(-1)).toEqual({ method: "click", args: [b.id, "e1"] });

    await call(client, "click", { ref: "e1", tabId: a.id });
    await call(client, "click", { ref: "e2" });
    expect(controller.calls.at(-1)).toEqual({ method: "click", args: [a.id, "e2"] });

    // Acting on the user's tab when they ask does not make it the agent's.
    await call(client, "click", { ref: "e3", tabId: userTab });
    expect(controller.calls.at(-1)).toEqual({ method: "click", args: [userTab, "e3"] });
    await call(client, "click", { ref: "e4" });
    expect(controller.calls.at(-1)).toEqual({ method: "click", args: [a.id, "e4"] });

    await controller.closeTab(a.id);
    await call(client, "click", { ref: "e5" });
    expect(controller.calls.at(-1)).toEqual({ method: "click", args: [b.id, "e5"] });
    await call(client, "tab_close", { tabId: b.id });
    const res = await call(client, "click", { ref: "e6" });
    expect(textOf(res)).toContain(NO_OWN_TAB);
    expect(await front(controller)).toMatchObject({ id: userTab });
  });

  it("each session has its own tabs", async () => {
    const { controller, userTab } = await start();
    const one = await harness.connect();
    const two = await harness.connect();
    const tab = untrustedJson<TabJson>(await call(one, "tab_open", { url: "https://one.example/" }));
    expect(textOf(await call(two, "click", { ref: "e1" }))).toContain(NO_OWN_TAB);
    await call(one, "click", { ref: "e1" });
    expect(controller.calls.at(-1)).toEqual({ method: "click", args: [tab.id, "e1"] });
    expect(await front(controller)).toMatchObject({ id: userTab });
  });

  it("brings a tab to the front only when asked to", async () => {
    const { controller } = await start();
    const client = await harness.connect();
    const shown = untrustedJson<TabJson>(await call(client, "tab_open", { url: "https://show.example/", background: false }));
    expect(shown.active).toBe(true);
    expect(await front(controller)).toMatchObject({ id: shown.id });
  });

  it("asks the user in the tab in front when it has no tab of its own", async () => {
    const { controller, userTab } = await start();
    const client = await harness.connect();
    const pending = call(client, "request_user_action", { message: "Sign in, please", timeoutSeconds: 10 });
    for (let i = 0; i < 100 && controller.pendingUserActions.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(controller.pendingUserActions[0]?.tabId).toBe(userTab);
    controller.pendingUserActions[0]!.answer("done");
    expect(textOf(await pending)).toMatch(/^done/);
  });
});
