import { describe, expect, it, vi } from "vitest";

import {
  BrunoTableServerViewportStore,
  sanitizeBrunoTableServerViewportWindow,
} from "./server-viewport-store";

type Row = Readonly<{ readonly symbol: string; readonly price: number }>;

describe("BrunoTableServerViewportStore", () => {
  it("rejects an inclusive maximum index whose exclusive end cannot be represented safely", () => {
    expect(
      sanitizeBrunoTableServerViewportWindow({
        firstRow: Number.MAX_SAFE_INTEGER - 1,
        lastRow: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ firstRow: 0, lastRow: 0 });
  });

  it("publishes an accepted non-pruning required-window snapshot exactly once", () => {
    const store = new BrunoTableServerViewportStore<Row>();
    const generation = store.beginGeneration({ firstRow: 0, lastRow: 17 });
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.setRequiredRange(generation, { firstRow: 10, lastRow: 29 })).toBe(true);
    expect(store.getSnapshot().requiredWindow).toEqual({ firstRow: 10, lastRow: 29 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.setRequiredRange(generation, { firstRow: 10, lastRow: 29 })).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("writes authoritative row keys into out-of-order absolute slots in one publication", () => {
    const store = new BrunoTableServerViewportStore<Row>();
    const listener = vi.fn();
    store.subscribe(listener);
    const generation = store.beginGeneration({ firstRow: 20, lastRow: 24 });
    listener.mockClear();

    store.setRowCount(generation, 1_000, true);
    listener.mockClear();
    const row22 = { symbol: "NVDA", price: 130 } as const;
    const row20 = { symbol: "AAPL", price: 240 } as const;
    expect(
      store.setRowData(generation, { 22: row22, 20: row20 }, { 20: "key-a", 22: "key-n" }),
    ).toBe(true);

    const snapshot = store.getSnapshot();
    expect(snapshot.rowSpace.getRowId(20)).toBe("key-a");
    expect(snapshot.rowSpace.getRowId(21)).toBeUndefined();
    expect(snapshot.rowSpace.getRowId(22)).toBe("key-n");
    expect(snapshot.rowSpace.getRow("key-n")).toBe(row22);
    expect(snapshot.rowSpace.loadedRows).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("retains same-generation overlap and row references while rejecting late generations", () => {
    const store = new BrunoTableServerViewportStore<Row>();
    const first = store.beginGeneration({ firstRow: 0, lastRow: 2 });
    store.setRowCount(first, 100);
    const stable = { symbol: "MSFT", price: 410 } as const;
    store.setRowData(
      first,
      { 0: { symbol: "AAPL", price: 240 }, 1: stable, 2: { symbol: "NVDA", price: 130 } },
      { 0: "a", 1: "m", 2: "n" },
    );

    store.setRequiredRange(first, { firstRow: 1, lastRow: 3 });
    store.setRowData(
      first,
      { 1: { symbol: "MSFT", price: 410 }, 3: { symbol: "SAP", price: 250 } },
      { 1: "m", 3: "s" },
    );
    expect(store.getSnapshot().rowSpace.getRow("m")).toBe(stable);

    const second = store.beginGeneration({ firstRow: 0, lastRow: 1 });
    expect(store.getSnapshot().rowSpace.getRowId(1)).toBeUndefined();
    expect(store.getSnapshot().authoritativeTotalRows).toBe(false);
    expect(store.setRowCount(first, 999, true)).toBe(false);
    expect(store.setRowData(first, { 0: { symbol: "LATE", price: 0 } }, { 0: "late" })).toBe(false);
    expect(store.getSnapshot().generation).toBe(second);
    expect(store.getSnapshot().rowSpace.getRowId(0)).toBeUndefined();
  });

  it("rejects misaligned row and key maps atomically", () => {
    const store = new BrunoTableServerViewportStore<Row>();
    const generation = store.beginGeneration({ firstRow: 0, lastRow: 4 });
    store.setRowCount(generation, 5);

    expect(
      store.setRowData(
        generation,
        { 0: { symbol: "AAPL", price: 240 }, 2: { symbol: "NVDA", price: 130 } },
        { 0: "a" },
      ),
    ).toBe(false);
    expect(store.getSnapshot().rowSpace.loadedRows).toBe(0);

    expect(
      store.setRowData(generation, { 0: { symbol: "AAPL", price: 240 } }, { 0: "a", 1: "extra" }),
    ).toBe(false);
    expect(store.getSnapshot().rowSpace.loadedRows).toBe(0);
  });

  it("admits the exact authoritative key snapshot validated from an accessor-backed map", () => {
    const store = new BrunoTableServerViewportStore<Row>();
    const generation = store.beginGeneration({ firstRow: 0, lastRow: 0 });
    let reads = 0;
    const rowKeysByIndex = {} as Record<number, string>;
    Object.defineProperty(rowKeysByIndex, "0", {
      enumerable: true,
      get: () => (reads++ === 0 ? "validated-key" : "unvalidated-key"),
    });

    expect(
      store.setRowData(generation, { 0: { symbol: "AAPL", price: 240 } }, rowKeysByIndex),
    ).toBe(true);
    expect(reads).toBe(1);
    expect(store.getSnapshot().rowSpace.getRowId(0)).toBe("validated-key");
  });

  it("keeps every authority snapshot and lookup coherent when prepublication work throws", () => {
    const store = new BrunoTableServerViewportStore<Row>();
    const generation = store.beginGeneration({ firstRow: 0, lastRow: 1 });
    const stable = { symbol: "AAPL", price: 240 } as const;
    store.setRowData(generation, { 0: stable }, { 0: "a" });
    const before = store.getSnapshot();
    const delivery = [
      Object.freeze({ index: 1, row: { symbol: "MSFT", price: 410 }, rowId: "m" }),
    ] as const;
    const plan = store.planRowDataSnapshot(generation, delivery)!;

    expect(() =>
      store.commitRowDataPlan(plan, delivery, () => {
        throw new Error("prepublication failure");
      }),
    ).toThrow("prepublication failure");
    expect(store.getSnapshot()).toBe(before);
    expect(store.getSnapshot().rowSpace.getRowId(0)).toBe("a");
    expect(store.getSnapshot().rowSpace.getRow("a")).toBe(stable);
    expect(store.getSnapshot().rowSpace.getRowId(1)).toBeUndefined();
    expect(store.findRowIndex("a")).toBe(0);
    expect(store.findRowIndex("m")).toBeUndefined();

    expect(store.setRowData(generation, { 1: delivery[0].row }, { 1: "m" })).toBe(true);
    expect(store.getSnapshot().rowSpace.getRowId(1)).toBe("m");
    expect(store.findRowIndex("m")).toBe(1);
  });

  it("does not let an older admission overwrite a reentrant newer delivery", () => {
    const initial = { symbol: "INITIAL", price: 1 };
    const older = { symbol: "OLDER", price: 2 };
    const newest = { symbol: "NEWEST", price: 3 };
    let generation = 0;
    let nested = false;
    let store: BrunoTableServerViewportStore<Row>;
    store = new BrunoTableServerViewportStore<Row>(
      () => undefined,
      () => {
        if (!nested) {
          nested = true;
          expect(store.setRowData(generation, { 0: newest }, { 0: "row" })).toBe(true);
        }
        return false;
      },
    );
    generation = store.beginGeneration({ firstRow: 0, lastRow: 0 });
    expect(store.setRowData(generation, { 0: initial }, { 0: "row" })).toBe(true);

    expect(store.setRowData(generation, { 0: older }, { 0: "row" })).toBe(false);
    expect(store.getSnapshot().rowSpace.getRow("row")).toBe(newest);
    expect(store.findRowIndex("row")).toBe(0);
  });

  it.each(["count", "window"] as const)(
    "does not let an older admission overwrite a reentrant %s mutation",
    (mutation) => {
      const row0 = { symbol: "ROW-0", price: 1 };
      const row1 = { symbol: "ROW-1", price: 2 };
      const outer = { symbol: "OUTER", price: 3 };
      let generation = 0;
      let nested = false;
      let store: BrunoTableServerViewportStore<Row>;
      store = new BrunoTableServerViewportStore<Row>(
        () => undefined,
        () => {
          if (!nested) {
            nested = true;
            if (mutation === "count") {
              expect(store.setRowCount(generation, 1, true)).toBe(true);
            } else {
              expect(store.setRequiredRange(generation, { firstRow: 0, lastRow: 0 })).toBe(true);
            }
          }
          return false;
        },
      );
      generation = store.beginGeneration({ firstRow: 0, lastRow: 1 });
      store.setRowCount(generation, 2, true);
      store.setRowData(generation, { 0: row0, 1: row1 }, { 0: "row-0", 1: "row-1" });
      const notifications = vi.fn();
      store.subscribe(notifications);

      expect(store.setRowData(generation, { 0: outer }, { 0: "row-0" })).toBe(false);
      expect(notifications).toHaveBeenCalledOnce();
      expect(store.getSnapshot().rowSpace.getRow("row-0")).toBe(row0);
      expect(store.getSnapshot().rowSpace.getRowId(1)).toBeUndefined();

      if (mutation === "count") {
        expect(store.getSnapshot().rowSpace.totalRows).toBe(1);
        store.setRowCount(generation, 2, true);
      } else {
        expect(store.getSnapshot().requiredWindow).toEqual({ firstRow: 0, lastRow: 0 });
        store.setRequiredRange(generation, { firstRow: 0, lastRow: 1 });
      }
      expect(store.getSnapshot().rowSpace.getRowId(1)).toBeUndefined();
      expect(store.findRowIndex("row-1")).toBeUndefined();
    },
  );

  it("does not let setRowCount retention hints bridge semantic generations", () => {
    const store = new BrunoTableServerViewportStore<Row>();
    const first = store.beginGeneration({ firstRow: 0, lastRow: 9 });
    store.setRowCount(first, 100, true);
    store.setRowData(first, { 0: { symbol: "AAPL", price: 240 } }, { 0: "a" });

    const second = store.beginGeneration({ firstRow: 0, lastRow: 9 });
    expect(store.setRowCount(first, 100, true)).toBe(false);
    expect(store.getSnapshot().generation).toBe(second);
    expect(store.getSnapshot().rowSpace.totalRows).toBe(10);
    expect(store.getSnapshot().rowSpace.getRowId(0)).toBeUndefined();
  });

  it("ignores lifecycle count hints until an authoritative count arrives", () => {
    const store = new BrunoTableServerViewportStore<Row>();
    const generation = store.beginGeneration({ firstRow: 0, lastRow: 17 });

    expect(store.setRowCount(generation, 0, false)).toBe(true);
    expect(store.getSnapshot().authoritativeTotalRows).toBe(false);
    expect(store.getSnapshot().rowSpace.totalRows).toBe(18);

    expect(store.setRowCount(generation, 0, true)).toBe(true);
    expect(store.getSnapshot().authoritativeTotalRows).toBe(true);
    expect(store.getSnapshot().rowSpace.totalRows).toBe(0);
  });

  it("keeps only the active sparse window while retaining overlap", () => {
    const store = new BrunoTableServerViewportStore<Row>();
    const generation = store.beginGeneration({ firstRow: 0, lastRow: 2 });
    store.setRowCount(generation, 1_000_000, true);
    const overlap = { symbol: "NVDA", price: 130 } as const;
    store.setRowData(
      generation,
      { 0: { symbol: "AAPL", price: 240 }, 1: overlap, 2: { symbol: "MSFT", price: 410 } },
      { 0: "a", 1: "n", 2: "m" },
    );

    store.setRequiredRange(generation, { firstRow: 1, lastRow: 3 });
    expect(store.getSnapshot().rowSpace.loadedRows).toBe(2);
    expect(store.getSnapshot().rowSpace.getRow("n")).toBe(overlap);
    store.setRowData(
      generation,
      {
        0: { symbol: "LATE", price: 0 },
        1: { symbol: "NVDA", price: 130 },
        3: { symbol: "SAP", price: 250 },
      },
      { 0: "late", 1: "n", 3: "s" },
    );
    expect(store.getSnapshot().rowSpace.loadedRows).toBe(3);
    expect(store.getSnapshot().rowSpace.getRowId(0)).toBeUndefined();
    expect(store.getSnapshot().rowSpace.getRow("n")).toBe(overlap);
  });

  it("reconciles row moves atomically with exact semantic equality", () => {
    type ExactRow = Readonly<{
      readonly symbol: string;
      readonly exact: { readonly value: string };
    }>;
    const store = new BrunoTableServerViewportStore<ExactRow>(
      () => undefined,
      (left, right) => left.symbol === right.symbol && left.exact.value === right.exact.value,
    );
    const generation = store.beginGeneration({ firstRow: 0, lastRow: 1 });
    const first = { symbol: "A", exact: { value: "1.50" } } as const;
    const second = { symbol: "B", exact: { value: "2.00" } } as const;
    store.setRowData(generation, { 0: first, 1: second }, { 0: "a", 1: "b" });
    const beforeMove = store.getSnapshot();

    store.setRowData(
      generation,
      {
        0: { symbol: "B", exact: { value: "2.00" } },
        1: { symbol: "A", exact: { value: "1.50" } },
      },
      { 0: "b", 1: "a" },
    );
    expect(store.getSnapshot().rowSpace.getRow("a")).toBe(first);
    expect(store.getSnapshot().rowSpace.getRow("b")).toBe(second);
    expect(store.getSnapshot().rowSpace.getRowId(0)).toBe("b");
    expect(store.getSnapshot().rowSpace.getRowId(1)).toBe("a");
    expect(beforeMove.rowSpace.getRowId(0)).toBe("a");
    expect(beforeMove.findRowIndex("a")).toBe(0);
    expect(beforeMove.findRowIndex("b")).toBe(1);
    expect(store.getSnapshot().findRowIndex("a")).toBe(1);
    expect(store.getSnapshot().findRowIndex("b")).toBe(0);
  });
});
