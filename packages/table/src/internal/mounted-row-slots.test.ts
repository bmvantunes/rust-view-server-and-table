import { expect, it, vi } from "vitest";

import { BrunoTableMountedRowSlots } from "./mounted-row-slots";
import type { BrunoTableRowRangeSnapshot } from "./virtual-viewport";

it("publishes immutable bounded slots before notifying, without work during snapshot reads", () => {
  let range: BrunoTableRowRangeSnapshot = {
    rowStart: 0,
    rowEnd: 3,
    totalHeight: 1_000,
    segmentedRows: false,
  };
  const getRowId = vi.fn((index: number) => `row-${index}`);
  const slots = new BrunoTableMountedRowSlots(() => range, { getRowId });
  const first = slots.getSnapshot();
  const reads = getRowId.mock.calls.length;
  expect(slots.getSnapshot()).toBe(first);
  expect(getRowId).toHaveBeenCalledTimes(reads);
  const listener = vi.fn(() => {
    expect(slots.getSnapshot().rows.map((row) => row.rowId)).toEqual(["row-1", "row-2", "row-3"]);
  });
  const unsubscribe = slots.subscribe(listener);
  range = { ...range, rowStart: 1, rowEnd: 4 };
  slots.refresh();
  const next = slots.getSnapshot();
  expect(listener).toHaveBeenCalledOnce();
  expect(next.rows.map((row) => row.key)).toEqual([1, 2, 0]);
  expect(first.rows.map((row) => row.rowId)).toEqual(["row-0", "row-1", "row-2"]);
  slots.refresh();
  expect(listener).toHaveBeenCalledOnce();
  expect(slots.getSnapshot()).toBe(next);
  unsubscribe();
});

it("retains identity across reordering and recycles retired loading slots", () => {
  const range = { rowStart: 0, rowEnd: 3, totalHeight: 1_000, segmentedRows: false };
  const slots = new BrunoTableMountedRowSlots(() => range, {
    getRowId: (index) => ["first", "other", undefined][index],
  });
  slots.setIdentities({ getRowId: (index) => ["other", "first", "loaded"][index] });
  expect(slots.getSnapshot().rows.map((row) => row.key)).toEqual([1, 0, 2]);
  expect(slots.getSnapshot().hasUnloadedRows).toBe(false);
});

it("publishes geometry-only changes without changing shell assignments", () => {
  let range = { rowStart: 0, rowEnd: 1, totalHeight: 1_000, segmentedRows: false };
  const slots = new BrunoTableMountedRowSlots(() => range, { getRowId: () => "first" });
  const rows = slots.getSnapshot().rows;
  range = { ...range, totalHeight: 2_000 };
  slots.refresh();
  expect(slots.getSnapshot().range).toBe(range);
  expect(slots.getSnapshot().rows).toBe(rows);
});

it("does not strand a subscriber when another subscriber throws", () => {
  const range = { rowStart: 0, rowEnd: 1, totalHeight: 1_000, segmentedRows: false };
  const slots = new BrunoTableMountedRowSlots(() => range, { getRowId: () => "first" });
  const failure = new Error("observer failed");
  slots.subscribe(() => {
    throw failure;
  });
  const survivor = vi.fn();
  slots.subscribe(survivor);
  expect(() => slots.setIdentities({ getRowId: () => "second" })).toThrow(failure);
  expect(survivor).toHaveBeenCalledOnce();
  expect(slots.getSnapshot().rows[0]?.rowId).toBe("second");
});
