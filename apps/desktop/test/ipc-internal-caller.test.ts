import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { internalCallerPage } from "../src/main/ipc";

describe("internalCallerPage", () => {
  it("names the Corvus page of its own document", () => {
    expect(internalCallerPage("corvus://newtab/")).toBe("newtab");
    expect(internalCallerPage("corvus://settings/#sync")).toBe("settings");
    expect(internalCallerPage("corvus://search/?q=corvus")).toBe("search");
  });

  it("refuses other documents of the same host", () => {
    // A custom widget opened as a page of its own must not get the New Tab page's powers.
    expect(internalCallerPage("corvus://newtab/widget/custom-1")).toBeNull();
    expect(internalCallerPage("corvus://newtab/media/bg.png")).toBeNull();
    expect(internalCallerPage("corvus://history/settings.html")).toBeNull();
  });

  it("refuses anything that is not a Corvus page", () => {
    expect(internalCallerPage("https://example.com/")).toBeNull();
    expect(internalCallerPage("corvus://nope/")).toBeNull();
    expect(internalCallerPage("not a url")).toBeNull();
  });
});
