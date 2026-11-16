import { describe, expect, it } from "vitest";
import { chromeBandHeight, MIN_PAGE_HEIGHT } from "../src/main/chrome-layout";

describe("chromeBandHeight", () => {
  it("gives the chrome what it asks for when it fits", () => {
    expect(chromeBandHeight(112, 900)).toBe(112);
    expect(chromeBandHeight(112.4, 900)).toBe(112);
  });

  it("lets a tall request bar grow past 400px in a tall window", () => {
    // Tab strip, toolbar and bookmarks (~118px) plus a request bar scrolling at 320px.
    expect(chromeBandHeight(470, 1030)).toBe(470);
  });

  it("always leaves room for the page", () => {
    expect(chromeBandHeight(2000, 1030)).toBe(1030 - MIN_PAGE_HEIGHT);
  });

  it("keeps 400px in a short window", () => {
    expect(chromeBandHeight(2000, 500)).toBe(400);
  });

  it("never goes negative", () => {
    expect(chromeBandHeight(-5, 900)).toBe(0);
  });
});
