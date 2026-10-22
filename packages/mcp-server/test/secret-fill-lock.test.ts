import { afterEach, describe, expect, it } from "vitest";
import { RAW_PAGE_TOOLS } from "../src/access.js";
import { MockBrowserController, SECRET_FILL_LOCK_TEXT } from "../src/testing/index.js";
import { call, startHarness, textOf, type Harness } from "./helpers.js";

const LOGIN = "https://login.example/";

function controller(): MockBrowserController {
  return new MockBrowserController({
    initialTabs: [LOGIN],
    pages: { [LOGIN]: { title: "Sign in", text: "Sign in", elements: [{ ref: "e1", role: "textbox", name: "Password" }] } },
    evaluate: () => "secret-from-the-page",
    credentialFill: () => ({ status: "filled", message: "Filled the username and password for alice." }),
  });
}

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

const rawCalls = (c: MockBrowserController): string[] =>
  c.calls.map((x) => x.method).filter((m) => ["evaluate", "getHtml", "getText", "extract", "find", "pdf"].includes(m));

describe("script lock after a credential fill", () => {
  it("covers every tool that runs script or returns raw page content", () => {
    expect([...RAW_PAGE_TOOLS].sort()).toEqual(["evaluate", "extract", "find", "get_html", "get_text", "pdf"]);
  });

  it("refuses evaluate and raw reads on the filled tab until it navigates", async () => {
    harness = await startHarness({ accessLevel: "full", rateLimit: false }, controller());
    const client = await harness.connect();
    expect(textOf(await call(client, "evaluate", { expression: "1" }))).toContain("secret-from-the-page");

    expect(textOf(await call(client, "fill_login", {}))).toContain("Filled");
    const before = rawCalls(harness.controller).length;
    const refusals = [
      await call(client, "evaluate", { expression: "document.querySelector('input').value" }),
      await call(client, "get_html", {}),
      await call(client, "get_text", {}),
      await call(client, "extract", { kind: "markdown" }),
      await call(client, "find", { text: "Password" }),
      await call(client, "pdf", {}),
    ];
    for (const res of refusals) {
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(SECRET_FILL_LOCK_TEXT);
    }
    expect(rawCalls(harness.controller).length).toBe(before);

    // The masked snapshot and input tools keep working, so the agent can press "Sign in".
    expect((await call(client, "page_snapshot", {})).isError).toBeFalsy();
    expect((await call(client, "click", { ref: "e1" })).isError).toBeFalsy();

    // A new document lifts the lock.
    await call(client, "navigate", { url: "https://login.example/home" });
    expect(textOf(await call(client, "evaluate", { expression: "1" }))).toContain("secret-from-the-page");
  });

  it("applies at every access level and only to the locked tab", async () => {
    const c = controller();
    harness = await startHarness({ accessLevel: "read", rateLimit: false }, c);
    const client = await harness.connect();
    const [tab] = await c.listTabs();
    c.lockedTabs.add(tab!.id);
    const refused = await call(client, "get_text", {});
    expect(textOf(refused)).toBe(SECRET_FILL_LOCK_TEXT);
    const other = await c.openTab("https://other.example/", { background: true });
    expect((await call(client, "get_text", { tabId: other.id })).isError).toBeFalsy();
  });
});
