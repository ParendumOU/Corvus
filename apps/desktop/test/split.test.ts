import { describe, expect, it } from "vitest";
import {
  DIVIDER_WIDTH,
  FOCUS_BORDER,
  MAX_RATIO,
  MIN_RATIO,
  clampRatio,
  computeSplitGeometry,
  insetPage,
  type Rect,
} from "../src/shared/split";

const content: Rect = { x: 0, y: 112, width: 1000, height: 800 };

describe("clampRatio", () => {
  it("keeps a sane ratio untouched", () => {
    expect(clampRatio(0.5)).toBe(0.5);
  });
  it("clamps out-of-range and non-finite values", () => {
    expect(clampRatio(0)).toBe(MIN_RATIO);
    expect(clampRatio(1)).toBe(MAX_RATIO);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
});

describe("computeSplitGeometry", () => {
  it("tiles two non-overlapping cells with the divider between them", () => {
    const { leftCell, rightCell, divider } = computeSplitGeometry(content, 0.5);
    const avail = content.width - DIVIDER_WIDTH;
    expect(leftCell.width).toBe(Math.round(avail * 0.5));
    expect(divider.width).toBe(DIVIDER_WIDTH);
    // The divider starts where the left cell ends; the right cell starts after the divider.
    expect(divider.x).toBe(leftCell.x + leftCell.width);
    expect(rightCell.x).toBe(divider.x + DIVIDER_WIDTH);
    // Cells plus the divider exactly fill the content width (no gap, no overlap).
    expect(leftCell.width + divider.width + rightCell.width).toBe(content.width);
    // Both cells span the full content height at the content's top.
    expect(leftCell.y).toBe(content.y);
    expect(leftCell.height).toBe(content.height);
    expect(rightCell.height).toBe(content.height);
  });

  it("gives more width to the left pane as the ratio grows", () => {
    const narrow = computeSplitGeometry(content, 0.25).leftCell.width;
    const wide = computeSplitGeometry(content, 0.75).leftCell.width;
    expect(wide).toBeGreaterThan(narrow);
  });

  it("clamps extreme ratios so neither pane collapses", () => {
    const { leftCell, rightCell } = computeSplitGeometry(content, 2);
    expect(leftCell.width).toBeGreaterThan(0);
    expect(rightCell.width).toBeGreaterThan(0);
  });
});

describe("insetPage", () => {
  it("insets a cell on every side by the focus border", () => {
    const cell: Rect = { x: 10, y: 20, width: 300, height: 400 };
    const page = insetPage(cell);
    expect(page.x).toBe(10 + FOCUS_BORDER);
    expect(page.y).toBe(20 + FOCUS_BORDER);
    expect(page.width).toBe(300 - FOCUS_BORDER * 2);
    expect(page.height).toBe(400 - FOCUS_BORDER * 2);
  });
  it("never produces negative dimensions", () => {
    const page = insetPage({ x: 0, y: 0, width: 2, height: 2 });
    expect(page.width).toBe(0);
    expect(page.height).toBe(0);
  });
});
