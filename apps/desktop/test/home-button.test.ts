import { describe, expect, it } from "vitest";
import { HOME_PAGES, defaultSettings, homePageUrl, mergeSettings } from "../src/shared/settings";
import { commandForInput, type KeyInput } from "../src/shared/shortcuts";

const DEFAULT_SETTINGS = defaultSettings();
const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ type: "keyDown", key: k, control: false, meta: false, shift: false, alt: false, ...mods });

describe("home button", () => {
  it("is on by default and goes to the New Tab page", () => {
    expect(DEFAULT_SETTINGS.appearance.showHomeButton).toBe(true);
    expect(homePageUrl(DEFAULT_SETTINGS.appearance)).toBe("corvus://newtab/");
  });

  it("goes to the chosen search engine or a custom http(s) address", () => {
    expect(homePageUrl({ homePage: "google", homeUrl: "" })).toBe("https://www.google.com/");
    expect(homePageUrl({ homePage: "duckduckgo", homeUrl: "" })).toBe(HOME_PAGES.duckduckgo);
    expect(homePageUrl({ homePage: "custom", homeUrl: " https://parendum.com " })).toBe("https://parendum.com/");
    expect(homePageUrl({ homePage: "custom", homeUrl: "javascript:alert(1)" })).toBe("corvus://newtab/");
    expect(homePageUrl({ homePage: "custom", homeUrl: "not a url" })).toBe("corvus://newtab/");
  });

  it("drops an unknown home page from stored settings", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { appearance: { homePage: "altavista" } });
    expect(merged.appearance.homePage).toBe("corvus");
  });

  it("opens with Alt+Home on every platform", () => {
    expect(commandForInput(key("Home", { alt: true }), "win32")).toEqual({ type: "home" });
    expect(commandForInput(key("Home", { alt: true }), "darwin")).toEqual({ type: "home" });
    expect(commandForInput(key("Home"), "win32")).not.toEqual({ type: "home" });
  });
});
