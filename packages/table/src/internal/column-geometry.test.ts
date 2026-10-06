import { describe, expect, it } from "vitest";

import {
  projectBrunoTableLogicalColumnIndex,
  resolveBrunoTableReorderCenterBounds,
  resolveBrunoTableReorderTargetIndex,
} from "./column-geometry";

const mountedRightWindow = [
  { columnIndex: 4, left: 0, width: 100 },
  { columnIndex: 5, left: 100, width: 100 },
  { columnIndex: 6, left: 200, width: 100 },
] as const;

describe("BrunoTable virtual reorder geometry", () => {
  it("resolves a target from absolute indexes when the source is offscreen", () => {
    expect(resolveBrunoTableReorderTargetIndex(mountedRightWindow, 0, "ltr", 1, 0, 8)).toBe(3);
    expect(resolveBrunoTableReorderTargetIndex(mountedRightWindow, 250, "ltr", 1, 0, 8)).toBe(6);
  });

  it("uses visual slots consistently in RTL", () => {
    const cells = [
      { columnIndex: 0, left: 200, width: 100 },
      { columnIndex: 1, left: 100, width: 100 },
      { columnIndex: 2, left: 0, width: 100 },
    ] as const;
    expect(resolveBrunoTableReorderTargetIndex(cells, 280, "rtl", 1, 0, 2)).toBe(0);
    expect(resolveBrunoTableReorderTargetIndex(cells, 20, "rtl", 1, 0, 2)).toBe(2);
  });

  it("clamps pointer targets to the active logical region", () => {
    const leftWindow = [
      { columnIndex: 0, left: 0, width: 100 },
      { columnIndex: 1, left: 100, width: 100 },
      { columnIndex: 2, left: 200, width: 100 },
    ] as const;
    expect(resolveBrunoTableReorderTargetIndex(leftWindow, -100, "ltr", 1, 0, 2)).toBe(0);
    expect(resolveBrunoTableReorderTargetIndex(mountedRightWindow, 1_000, "ltr", 5, 4, 5)).toBe(5);
  });

  it("falls back to the source when no remaining cell is mounted", () => {
    expect(
      resolveBrunoTableReorderTargetIndex(
        [{ columnIndex: 2, left: 0, width: 100 }],
        50,
        "ltr",
        2,
        2,
        2,
      ),
    ).toBe(2);
  });

  it("projects mounted columns through an unmounted source placeholder", () => {
    expect(projectBrunoTableLogicalColumnIndex(4, 1, 6)).toBe(3);
    expect(projectBrunoTableLogicalColumnIndex(5, 1, 6)).toBe(4);
    expect(projectBrunoTableLogicalColumnIndex(6, 1, 6)).toBe(5);
    expect(projectBrunoTableLogicalColumnIndex(1, 6, 1)).toBe(2);
    expect(projectBrunoTableLogicalColumnIndex(4, 6, 1)).toBe(5);
  });

  it("excludes the leading utility gutter from LTR and RTL reorder bounds", () => {
    const grid = { left: 100, right: 600 };
    const ltrUtility = { left: 100, right: 140 };
    const rtlUtility = { left: 560, right: 600 };

    expect(resolveBrunoTableReorderCenterBounds("ltr", grid, [], [], ltrUtility)).toEqual({
      left: 140,
      right: 600,
    });
    expect(resolveBrunoTableReorderCenterBounds("rtl", grid, [], [], rtlUtility)).toEqual({
      left: 100,
      right: 560,
    });
    expect(
      resolveBrunoTableReorderCenterBounds(
        "ltr",
        grid,
        [{ left: 140, right: 260 }],
        [{ left: 480, right: 600 }],
        ltrUtility,
      ),
    ).toEqual({ left: 260, right: 480 });
    expect(resolveBrunoTableReorderCenterBounds("ltr", grid, [], [])).toEqual({
      left: 100,
      right: 600,
    });
    expect(resolveBrunoTableReorderCenterBounds("rtl", grid, [], [])).toEqual({
      left: 100,
      right: 600,
    });
    expect(
      resolveBrunoTableReorderCenterBounds(
        "rtl",
        grid,
        [{ left: 140, right: 260 }],
        [{ left: 480, right: 600 }],
        rtlUtility,
      ),
    ).toEqual({ left: 260, right: 480 });
  });
});
