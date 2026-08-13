import { describe, it, expect } from "vitest";
import {
  estimateGroupHeight,
  computeGroupOffsets,
  visibleGroupRange,
  EST_GROUP_HEADER,
  EST_BUTTON_ROW,
  GROUP_PADDING_BOTTOM,
} from "@/shared/utils/listWindow";

const group = (n) => ({ models: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) });

describe("estimateGroupHeight", () => {
  it("always accounts for header + bottom padding", () => {
    expect(estimateGroupHeight(group(0))).toBe(EST_GROUP_HEADER + EST_BUTTON_ROW + GROUP_PADDING_BOTTOM);
    expect(estimateGroupHeight(group(5))).toBe(EST_GROUP_HEADER + EST_BUTTON_ROW + GROUP_PADDING_BOTTOM);
  });

  it("scales with wrapped rows", () => {
    const oneRow = estimateGroupHeight(group(6));
    const twoRows = estimateGroupHeight(group(7));
    expect(twoRows - oneRow).toBe(EST_BUTTON_ROW);
  });
});

describe("computeGroupOffsets", () => {
  it("accumulates measured heights when available", () => {
    const groups = [["a", group(1)], ["b", group(1)], ["c", group(1)]];
    const { offsets, total } = computeGroupOffsets(groups, { a: 100, b: 50 });
    expect(offsets).toEqual([0, 100, 150]);
    expect(total).toBe(150 + estimateGroupHeight(group(1)));
  });

  it("falls back to estimates for unmeasured groups", () => {
    const groups = [["a", group(10)], ["b", group(3)]];
    const { offsets, total } = computeGroupOffsets(groups);
    const hA = estimateGroupHeight(group(10));
    expect(offsets[1]).toBe(hA);
    expect(total).toBe(hA + estimateGroupHeight(group(3)));
  });

  it("handles an empty list", () => {
    const { offsets, total } = computeGroupOffsets([]);
    expect(offsets).toEqual([]);
    expect(total).toBe(0);
  });
});

describe("visibleGroupRange", () => {
  // Three groups of 100px each.
  const offsets = [0, 100, 200];
  const total = 300;

  it("returns everything when the list fits the viewport", () => {
    expect(visibleGroupRange(offsets, total, 0, 400, 0)).toEqual({ start: 0, end: 2 });
  });

  it("windows to the visible slice without overscan", () => {
    expect(visibleGroupRange(offsets, total, 50, 100, 0)).toEqual({ start: 0, end: 1 });
    expect(visibleGroupRange(offsets, total, 150, 100, 0)).toEqual({ start: 1, end: 2 });
    expect(visibleGroupRange(offsets, total, 100, 1, 0)).toEqual({ start: 1, end: 1 });
  });

  it("adds overscan groups above and below", () => {
    expect(visibleGroupRange(offsets, total, 150, 100, 1)).toEqual({ start: 0, end: 2 });
    expect(visibleGroupRange(offsets, total, 50, 100, 1)).toEqual({ start: 0, end: 2 });
  });

  it("clamps overscan to the list bounds", () => {
    expect(visibleGroupRange(offsets, total, 0, 1, 5)).toEqual({ start: 0, end: 2 });
  });

  it("clamps to the nearest group when scrolled past the end", () => {
    // 500 > total 300: no group intersects, so fall back to the last group.
    expect(visibleGroupRange(offsets, total, 500, 100, 0)).toEqual({ start: 2, end: 2 });
    expect(visibleGroupRange(offsets, total, 10 ** 6, 100, 2)).toEqual({ start: 0, end: 2 });
  });

  it("handles empty lists", () => {
    expect(visibleGroupRange([], 0, 0, 400)).toEqual({ start: 0, end: -1 });
  });
});
