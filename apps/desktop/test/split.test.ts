import { describe, expect, it } from "vitest";
import {
  DIVIDER_WIDTH,
  FOCUS_BORDER,
  MAX_RATIO,
  MIN_RATIO,
  clampRatio,
  MAX_PANES,
  computeGridGeometry,
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

describe("computeGridGeometry", () => {
  const area = (r: Rect): number => r.width * r.height;
  const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it("matches the two-pane split for two panes", () => {
    const grid = computeGridGeometry(content, 2, 0.4, 0.5);
    const split = computeSplitGeometry(content, 0.4);
    expect(grid.cells).toEqual([split.leftCell, split.rightCell]);
    expect(grid.dividers).toEqual([{ axis: "x", rect: split.divider }]);
  });

  it("puts one pane on the left and two stacked on the right for three", () => {
    const { cells, dividers } = computeGridGeometry(content, 3, 0.5, 0.25);
    const [left, top, bottom] = cells as [Rect, Rect, Rect];
    expect(left.height).toBe(content.height);
    expect(top.x).toBe(bottom.x);
    expect(top.width).toBe(bottom.width);
    expect(top.height).toBeLessThan(bottom.height);
    expect(top.height + DIVIDER_WIDTH + bottom.height).toBe(content.height);
    expect(dividers.map((d) => d.axis)).toEqual(["x", "y"]);
    expect(dividers[1]?.rect.x).toBe(top.x);
  });

  it("tiles a 2×2 grid without gaps or overlaps for four", () => {
    const { cells, dividers } = computeGridGeometry(content, 4, 0.5, 0.5);
    expect(cells).toHaveLength(4);
    const [tl, tr, bl, br] = cells as [Rect, Rect, Rect, Rect];
    expect(tl.y).toBe(tr.y);
    expect(bl.y).toBe(br.y);
    expect(tl.x).toBe(bl.x);
    expect(tr.x).toBe(br.x);
    for (let i = 0; i < cells.length; i += 1) for (let j = i + 1; j < cells.length; j += 1) expect(overlaps(cells[i]!, cells[j]!)).toBe(false);
    const dividerArea = content.width * DIVIDER_WIDTH + content.height * DIVIDER_WIDTH - DIVIDER_WIDTH * DIVIDER_WIDTH;
    expect(cells.reduce((sum, c) => sum + area(c), 0) + dividerArea).toBe(area(content));
    expect(dividers.find((d) => d.axis === "y")?.rect.width).toBe(content.width);
  });

  it("clamps the pane count to 2..4", () => {
    expect(computeGridGeometry(content, 1, 0.5, 0.5).cells).toHaveLength(2);
    expect(computeGridGeometry(content, 9, 0.5, 0.5).cells).toHaveLength(MAX_PANES);
  });
});
