import { describe, expect, it } from "vitest";
import { isAgentAllowedUrl } from "../src/shared/internal-urls";
import { classifyOmnibox, intentToUrl } from "../src/shared/omnibox";
import { PAGE_COMMAND_INPUT_MS, commandForInput, isPageFirst, pageCommand, type KeyInput } from "../src/shared/shortcuts";
import { isViewSourceUrl, viewSourceUrl } from "../src/shared/view-source";

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ type: "keyDown", key: k, control: false, meta: false, shift: false, alt: false, ...mods });

describe("view page source", () => {
  it.each([
    ["https://example.com/a?b=1", "view-source:https://example.com/a?b=1"],
    ["http://127.0.0.1:8080/", "view-source:http://127.0.0.1:8080/"],
    ["file:///C:/pages/index.html", "view-source:file:///C:/pages/index.html"],
  ])("shows the source of %s", (url, expected) => {
    expect(viewSourceUrl(url)).toBe(expected);
  });

  it.each(["corvus://settings/", "corvus://pdf/?src=https%3A%2F%2Fexample.com%2Fa.pdf", "view-source:https://example.com/", "about:blank", "data:text/html,hi", "chrome-extension://abc/popup.html", "", "not a url"])(
    "has no source view for %s",
    (url) => {
      expect(viewSourceUrl(url)).toBeNull();
    },
  );

  it("tells a source view from a page", () => {
    expect(isViewSourceUrl("view-source:https://example.com/")).toBe(true);
    expect(isViewSourceUrl("VIEW-SOURCE:https://example.com/")).toBe(true);
    expect(isViewSourceUrl("https://example.com/view-source:x")).toBe(false);
  });

  it("is Ctrl+U on Windows and Linux, Cmd+Option+U on macOS", () => {
    expect(commandForInput(key("u", { control: true }), "win32")).toEqual({ type: "view-source" });
    expect(commandForInput(key("U", { control: true }), "linux")).toEqual({ type: "view-source" });
    expect(commandForInput(key("u", { control: true, shift: true }), "win32")).toBeNull();
    expect(commandForInput(key("u", { meta: true }), "darwin")).toBeNull();
    // Option+U is a dead key on macOS: the physical key says it.
    expect(commandForInput(key("Dead", { meta: true, alt: true, code: "KeyU" }), "darwin")).toEqual({ type: "view-source" });
    expect(commandForInput(key("u", { meta: true, alt: true }), "darwin")).toEqual({ type: "view-source" });
  });

  it("leaves the key to the page first, unlike the browser's other shortcuts", () => {
    expect(isPageFirst({ type: "view-source" })).toBe(true);
    expect(isPageFirst({ type: "new-tab" })).toBe(false);
    expect(isPageFirst({ type: "find" })).toBe(false);
  });

  it("runs what a page let through only right after the person's own key press", () => {
    const now = 1_000_000;
    expect(pageCommand("view-source", now - 50, now)).toEqual({ type: "view-source" });
    expect(pageCommand("view-source", now - PAGE_COMMAND_INPUT_MS - 1, now)).toBeNull();
    // No input of the person's (an agent's keys never count, a page cannot type).
    expect(pageCommand("view-source", undefined, now)).toBeNull();
    // Only page-first commands, whatever else a page sends.
    expect(pageCommand("close-tab", now, now)).toBeNull();
    expect(pageCommand({ type: "view-source" }, now, now)).toBeNull();
  });

  it("stays out of reach of AI agents", () => {
    expect(isAgentAllowedUrl("view-source:https://example.com/")).toBe(false);
    expect(isAgentAllowedUrl(intentToUrl(classifyOmnibox("view-source:https://example.com/")))).toBe(false);
  });
});
