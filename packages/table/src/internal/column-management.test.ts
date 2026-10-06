import { describe, expect, it, vi } from "vitest";

import { compileColumns } from "./compile-columns";
import { BrunoTableGridRuntime } from "./grid-runtime";
import {
  applyBrunoTableGridCommand,
  BRUNO_TABLE_MAX_COLUMN_WIDTH,
  BRUNO_TABLE_MIN_COLUMN_WIDTH,
  createBrunoTableColumnLayout,
  getBrunoTableColumnLayoutSnapshot,
  getBrunoTableLogicalColumnOrder,
  reconcileBrunoTableColumnLayout,
  restoreBrunoTableColumnLayout,
} from "./column-management";
import type { BrunoTableColumnLayoutState, BrunoTableColumnPin } from "./column-management";

const columns = compileColumns([
  { columnId: "COL_ID_NAME", headerName: "Name", field: "name", valueType: "text", width: 120 },
  { columnId: "COL_ID_SCORE", headerName: "Score", field: "score", valueType: "number", width: 96 },
  {
    columnId: "COL_ID_STATUS",
    headerName: "Status",
    field: "status",
    valueType: "text",
    width: 140,
    pinned: "end",
  },
]);

function ids(value: ReturnType<typeof getBrunoTableColumnLayoutSnapshot>): readonly string[] {
  return value.columns.map((column) => column.columnId);
}

function expectLogicalVisibleInvariant(state: BrunoTableColumnLayoutState): void {
  const visible = new Set(state.visibleColumnIds);
  const expected = [
    ...state.allColumns.filter((column) => column.pinned === "start"),
    ...state.allColumns.filter((column) => column.pinned === undefined),
    ...state.allColumns.filter((column) => column.pinned === "end"),
  ]
    .filter((column) => visible.has(column.columnId))
    .map((column) => column.columnId);

  expect(state.visibleColumnIds).toEqual(expected);
  expect(new Set(state.visibleColumnIds).size).toBe(state.visibleColumnIds.length);
}

function randomizedColumnDefinitions(order: readonly string[]) {
  return compileColumns(
    order.map((columnId) => ({
      columnId: `COL_ID_${columnId}` as `COL_ID_${string}`,
      headerName: columnId,
      field: "name" as const,
      valueType: "text" as const,
    })),
  );
}

function nextRandom(seed: { value: number }): number {
  seed.value = (seed.value * 1_664_525 + 1_013_904_223) >>> 0;
  return seed.value / 2 ** 32;
}

function randomIndex(seed: { value: number }, length: number): number {
  return Math.floor(nextRandom(seed) * length);
}

describe("BrunoTable column management", () => {
  it("publishes layout subscribers without waking the query channel", () => {
    const runtime = new BrunoTableGridRuntime(
      {
        status: "ready",
        totalRows: 0,
        version: 1,
        hasCoherentRows: true,
      },
      columns,
      { baselineFilters: [], baselineOrderBy: [] },
      "TABLE_ID_COLUMN_MANAGEMENT_LAYOUT_SUBSCRIBERS",
    );
    const view = runtime.getView();
    const queryListener = vi.fn();
    const layoutListener = vi.fn();
    const commandListener = vi.fn();
    const removeQuery = view.subscribeQuery(queryListener);
    const removeLayout = view.subscribeColumnLayout(layoutListener);
    const removeCommand = view.subscribeColumnCommands("COL_ID_NAME", commandListener);

    runtime.dispatchGridCommand({
      type: "column.resize.commit",
      columnId: "COL_ID_NAME",
      width: 220,
    });

    expect(queryListener).not.toHaveBeenCalled();
    expect(layoutListener).toHaveBeenCalledTimes(1);
    expect(commandListener).toHaveBeenCalledTimes(1);
    expect(view.getQuerySnapshot().columns).toBe(columns);
    expect(view.getColumnLayoutSnapshot().columns[0]?.semantics.width).toBe(220);
    removeQuery();
    removeLayout();
    removeCommand();
  });

  it("keeps the controlled layout input separate from the Client Adapter projection", () => {
    const runtime = new BrunoTableGridRuntime(
      {
        status: "ready",
        totalRows: 0,
        version: 1,
        hasCoherentRows: true,
      },
      columns,
      { baselineFilters: [], baselineOrderBy: [] },
      "TABLE_ID_COLUMN_MANAGEMENT_CONTROLLED_LAYOUT",
    );
    const view = runtime.getView();

    runtime.dispatchGridCommand({
      type: "column.pin.commit",
      columnId: "COL_ID_SCORE",
      pinned: "start",
    });
    expect(view.getColumnLayoutSnapshot().allColumns.map((column) => column.columnId)).toEqual([
      "COL_ID_NAME",
      "COL_ID_SCORE",
      "COL_ID_STATUS",
    ]);
    expect(view.getColumnLayoutSnapshot().visibleColumnIds).toEqual([
      "COL_ID_SCORE",
      "COL_ID_NAME",
      "COL_ID_STATUS",
    ]);
  });

  it("preserves interleaved definitions as Client Adapter input", () => {
    const interleaved = compileColumns([
      {
        columnId: "COL_ID_CENTER_A",
        headerName: "Center A",
        field: "name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_END",
        headerName: "End",
        field: "status",
        valueType: "text",
        pinned: "end",
      },
      {
        columnId: "COL_ID_START",
        headerName: "Start",
        field: "score",
        valueType: "number",
        pinned: "start",
      },
      {
        columnId: "COL_ID_CENTER_B",
        headerName: "Center B",
        field: "name",
        valueType: "text",
      },
    ]);

    expect(
      getBrunoTableColumnLayoutSnapshot(createBrunoTableColumnLayout(interleaved)).columns.map(
        (column) => column.columnId,
      ),
    ).toEqual(["COL_ID_START", "COL_ID_CENTER_A", "COL_ID_CENTER_B", "COL_ID_END"]);
  });

  it("publishes one atomic transition for complete layout reset", () => {
    const runtime = new BrunoTableGridRuntime(
      {
        status: "ready",
        totalRows: 0,
        version: 1,
        hasCoherentRows: true,
      },
      columns,
      { baselineFilters: [], baselineOrderBy: [] },
      "TABLE_ID_COLUMN_MANAGEMENT_INTERLEAVED",
    );
    const view = runtime.getView();
    const layoutListener = vi.fn();
    const queryListener = vi.fn();
    const removeLayout = view.subscribeColumnLayout(layoutListener);
    const removeQuery = view.subscribeQuery(queryListener);

    runtime.dispatchGridCommand({
      type: "column.resize.commit",
      columnId: "COL_ID_NAME",
      width: 240,
    });
    runtime.dispatchGridCommand({
      type: "column.visibility.commit",
      columnId: "COL_ID_SCORE",
      visible: false,
    });
    layoutListener.mockClear();
    queryListener.mockClear();

    runtime.dispatchGridCommand({ type: "column.reset.layout" });

    expect(layoutListener).toHaveBeenCalledTimes(1);
    expect(queryListener).not.toHaveBeenCalled();
    expect(view.getColumnLayoutSnapshot().columns.map((column) => column.columnId)).toEqual([
      "COL_ID_NAME",
      "COL_ID_SCORE",
      "COL_ID_STATUS",
    ]);
    expect(view.getColumnCommandSnapshot("COL_ID_NAME").width).toBe(120);
    removeLayout();
    removeQuery();
  });

  it("keeps one logical order and applies an immutable resize", () => {
    const state = createBrunoTableColumnLayout(columns);
    const next = applyBrunoTableGridCommand(state, {
      type: "column.resize.commit",
      columnId: "COL_ID_SCORE",
      width: 220,
    });

    expect(ids(getBrunoTableColumnLayoutSnapshot(state))).toEqual([
      "COL_ID_NAME",
      "COL_ID_SCORE",
      "COL_ID_STATUS",
    ]);
    expect(ids(getBrunoTableColumnLayoutSnapshot(next))).toEqual(
      ids(getBrunoTableColumnLayoutSnapshot(state)),
    );
    expect(next.allColumns[1]?.semantics.width).toBe(220);
    expect(next.allColumns[0]).toBe(state.allColumns[0]);
    expect(next.allColumns[2]).toBe(state.allColumns[2]);
  });

  it("keeps visible identities aligned with logical order after pinning and visibility reset", () => {
    const state = createBrunoTableColumnLayout(columns);
    const pinned = applyBrunoTableGridCommand(state, {
      type: "column.pin.commit",
      columnId: "COL_ID_SCORE",
      pinned: "start",
    });
    const hidden = applyBrunoTableGridCommand(pinned, {
      type: "column.visibility.commit",
      columnId: "COL_ID_NAME",
      visible: false,
    });
    const reordered = applyBrunoTableGridCommand(hidden, {
      type: "column.reorder.commit",
      columnId: "COL_ID_STATUS",
      targetIndex: 1,
      pinned: "end",
    });
    const resetVisibility = applyBrunoTableGridCommand(reordered, {
      type: "column.reset.visibility",
    });

    expect(getBrunoTableColumnLayoutSnapshot(pinned).visibleColumnIds).toEqual([
      "COL_ID_SCORE",
      "COL_ID_NAME",
      "COL_ID_STATUS",
    ]);
    expect(getBrunoTableColumnLayoutSnapshot(hidden).visibleColumnIds).toEqual([
      "COL_ID_SCORE",
      "COL_ID_STATUS",
    ]);
    expect(getBrunoTableColumnLayoutSnapshot(reordered).visibleColumnIds).toEqual([
      "COL_ID_SCORE",
      "COL_ID_STATUS",
    ]);
    expect(getBrunoTableColumnLayoutSnapshot(resetVisibility).visibleColumnIds).toEqual([
      "COL_ID_SCORE",
      "COL_ID_NAME",
      "COL_ID_STATUS",
    ]);
  });

  it("resets pinning without rewriting the independent column order", () => {
    const state = createBrunoTableColumnLayout(columns);
    const pinned = applyBrunoTableGridCommand(state, {
      type: "column.pin.commit",
      columnId: "COL_ID_SCORE",
      pinned: "start",
    });
    const reset = applyBrunoTableGridCommand(pinned, { type: "column.reset.pinning" });

    expect(pinned.allColumns.map((column) => column.columnId)).toEqual([
      "COL_ID_NAME",
      "COL_ID_SCORE",
      "COL_ID_STATUS",
    ]);
    expect(
      getBrunoTableColumnLayoutSnapshot(pinned).columns.map((column) => column.columnId),
    ).toEqual(["COL_ID_SCORE", "COL_ID_NAME", "COL_ID_STATUS"]);
    expect(reset.allColumns.map((column) => column.columnId)).toEqual([
      "COL_ID_NAME",
      "COL_ID_SCORE",
      "COL_ID_STATUS",
    ]);
    expect(reset.allColumns.find((column) => column.columnId === "COL_ID_SCORE")?.pinned).toBe(
      undefined,
    );
    expect(
      getBrunoTableColumnLayoutSnapshot(reset).columns.map((column) => column.columnId),
    ).toEqual(["COL_ID_NAME", "COL_ID_SCORE", "COL_ID_STATUS"]);
  });

  it("recomputes visible order when a pinned column is unpinned", () => {
    const state = createBrunoTableColumnLayout(columns);
    const pinned = applyBrunoTableGridCommand(state, {
      type: "column.pin.commit",
      columnId: "COL_ID_SCORE",
      pinned: "start",
    });
    const unpinned = applyBrunoTableGridCommand(pinned, {
      type: "column.pin.commit",
      columnId: "COL_ID_SCORE",
      pinned: undefined,
    });

    expect(pinned.visibleColumnIds).toEqual(["COL_ID_SCORE", "COL_ID_NAME", "COL_ID_STATUS"]);
    expect(unpinned.visibleColumnIds).toEqual(["COL_ID_NAME", "COL_ID_SCORE", "COL_ID_STATUS"]);
  });

  it("preserves prior order when moving among multiple pinned columns", () => {
    const interleaved = compileColumns([
      { columnId: "COL_ID_CENTER", headerName: "Center", field: "name", valueType: "text" },
      { columnId: "COL_ID_SECOND", headerName: "Second", field: "score", valueType: "number" },
      { columnId: "COL_ID_FIRST", headerName: "First", field: "status", valueType: "text" },
    ]);
    const firstPinned = applyBrunoTableGridCommand(createBrunoTableColumnLayout(interleaved), {
      type: "column.pin.commit",
      columnId: "COL_ID_FIRST",
      pinned: "start",
    });
    const bothPinned = applyBrunoTableGridCommand(firstPinned, {
      type: "column.pin.commit",
      columnId: "COL_ID_SECOND",
      pinned: "start",
    });
    const moved = applyBrunoTableGridCommand(bothPinned, {
      type: "column.reorder.commit",
      columnId: "COL_ID_FIRST",
      targetIndex: 0,
      pinned: "start",
    });

    expect(bothPinned.visibleColumnIds).toEqual(["COL_ID_SECOND", "COL_ID_FIRST", "COL_ID_CENTER"]);
    expect(moved.visibleColumnIds).toEqual(["COL_ID_FIRST", "COL_ID_SECOND", "COL_ID_CENTER"]);
  });

  it("keeps hidden columns hidden when resetting pinning", () => {
    const state = createBrunoTableColumnLayout(columns);
    const pinned = applyBrunoTableGridCommand(state, {
      type: "column.pin.commit",
      columnId: "COL_ID_SCORE",
      pinned: "start",
    });
    const hidden = applyBrunoTableGridCommand(pinned, {
      type: "column.visibility.commit",
      columnId: "COL_ID_NAME",
      visible: false,
    });
    const reset = applyBrunoTableGridCommand(hidden, { type: "column.reset.pinning" });

    expect(reset.visibleColumnIds).toEqual(["COL_ID_SCORE", "COL_ID_STATUS"]);
    expect(reset.allColumns.find((column) => column.columnId === "COL_ID_NAME")).toBeDefined();
  });

  it("resets order without changing visibility or current pinning", () => {
    const state = createBrunoTableColumnLayout(columns);
    const reordered = applyBrunoTableGridCommand(state, {
      type: "column.reorder.commit",
      columnId: "COL_ID_SCORE",
      targetIndex: 0,
      pinned: undefined,
    });
    const hidden = applyBrunoTableGridCommand(reordered, {
      type: "column.visibility.commit",
      columnId: "COL_ID_NAME",
      visible: false,
    });
    const reset = applyBrunoTableGridCommand(hidden, { type: "column.reset.order" });

    expect(reset.allColumns.map((column) => column.columnId)).toEqual([
      "COL_ID_NAME",
      "COL_ID_SCORE",
      "COL_ID_STATUS",
    ]);
    expect(reset.visibleColumnIds).toEqual(["COL_ID_SCORE", "COL_ID_STATUS"]);
  });

  it("clamps committed widths and preserves no-op identity", () => {
    const state = createBrunoTableColumnLayout(columns);
    const tooSmall = applyBrunoTableGridCommand(state, {
      type: "column.resize.commit",
      columnId: "COL_ID_NAME",
      width: 1,
    });
    const tooLarge = applyBrunoTableGridCommand(state, {
      type: "column.resize.commit",
      columnId: "COL_ID_NAME",
      width: Number.POSITIVE_INFINITY,
    });
    const noOp = applyBrunoTableGridCommand(state, {
      type: "column.resize.commit",
      columnId: "COL_ID_NAME",
      width: 120,
    });

    expect(tooSmall.allColumns[0]?.semantics.width).toBe(BRUNO_TABLE_MIN_COLUMN_WIDTH);
    expect(tooLarge.allColumns[0]?.semantics.width).toBe(BRUNO_TABLE_MAX_COLUMN_WIDTH);
    expect(noOp).toBe(state);
    expect(BRUNO_TABLE_MAX_COLUMN_WIDTH).toBeGreaterThan(BRUNO_TABLE_MIN_COLUMN_WIDTH);
  });

  it("preserves valid compiled width baselines while applying interaction bounds", () => {
    const wideColumns = compileColumns([
      {
        columnId: "COL_ID_WIDE",
        headerName: "Wide",
        field: "name",
        valueType: "text",
        width: 1_200,
      },
      {
        columnId: "COL_ID_NARROW",
        headerName: "Narrow",
        field: "status",
        valueType: "text",
        width: 16,
      },
    ]);
    const state = createBrunoTableColumnLayout(wideColumns);
    const wideNoOp = applyBrunoTableGridCommand(state, {
      type: "column.resize.commit",
      columnId: "COL_ID_WIDE",
      width: 1_200,
    });
    const narrowNoOp = applyBrunoTableGridCommand(state, {
      type: "column.resize.commit",
      columnId: "COL_ID_NARROW",
      width: 16,
    });

    expect(wideNoOp).toBe(state);
    expect(narrowNoOp).toBe(state);
  });

  it("preserves surviving committed layout across definition replacement", () => {
    const resized = applyBrunoTableGridCommand(createBrunoTableColumnLayout(columns), {
      type: "column.resize.commit",
      columnId: "COL_ID_NAME",
      width: 220,
    });
    const pinned = applyBrunoTableGridCommand(resized, {
      type: "column.pin.commit",
      columnId: "COL_ID_SCORE",
      pinned: "start",
    });
    const hidden = applyBrunoTableGridCommand(pinned, {
      type: "column.visibility.commit",
      columnId: "COL_ID_STATUS",
      visible: false,
    });
    const replacement = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Renamed Name",
        valueType: "text",
        width: 80,
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
        width: 72,
      },
      {
        columnId: "COL_ID_NEW",
        field: "name",
        headerName: "New",
        valueType: "text",
        width: 64,
      },
    ]);
    const next = reconcileBrunoTableColumnLayout(hidden, replacement);
    const snapshot = getBrunoTableColumnLayoutSnapshot(next);

    expect(snapshot.allColumns.map((column) => column.columnId)).toEqual([
      "COL_ID_NAME",
      "COL_ID_SCORE",
      "COL_ID_NEW",
    ]);
    expect(snapshot.columns.map((column) => column.columnId)).toEqual([
      "COL_ID_SCORE",
      "COL_ID_NAME",
      "COL_ID_NEW",
    ]);
    expect(snapshot.visibleColumnIds).toEqual(["COL_ID_SCORE", "COL_ID_NAME", "COL_ID_NEW"]);
    const name = snapshot.allColumns.find((column) => column.columnId === "COL_ID_NAME");
    const score = snapshot.allColumns.find((column) => column.columnId === "COL_ID_SCORE");
    expect(name?.headerName).toBe("Renamed Name");
    expect(name?.semantics.width).toBe(220);
    expect(score?.pinned).toBe("start");
  });

  it("preserves baseline-equal restored pinning across definition replacement", () => {
    const currentColumns = compileColumns([
      { columnId: "COL_ID_NAME", headerName: "Name", field: "name", valueType: "text" },
      { columnId: "COL_ID_SCORE", headerName: "Score", field: "score", valueType: "number" },
      {
        columnId: "COL_ID_STATUS",
        headerName: "Status",
        field: "status",
        valueType: "text",
        pinned: "end",
      },
      {
        columnId: "COL_ID_NEW",
        headerName: "New",
        field: "name",
        valueType: "text",
        pinned: "start",
      },
    ]);
    const restored = restoreBrunoTableColumnLayout(currentColumns, {
      columnOrder: ["COL_ID_NAME", "COL_ID_SCORE", "COL_ID_STATUS"],
      columnVisibility: {},
      columnWidths: {},
      columnPinning: { start: [], end: ["COL_ID_STATUS", "COL_ID_NEW"] },
    });
    expect(restored.allColumns.find((column) => column.columnId === "COL_ID_NEW")?.pinned).toBe(
      "start",
    );
    const replacement = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        pinned: "start",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
      {
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        valueType: "text",
        pinned: "start",
      },
      {
        columnId: "COL_ID_NEW",
        field: "name",
        headerName: "New",
        valueType: "text",
        pinned: "start",
      },
    ]);

    const next = reconcileBrunoTableColumnLayout(restored, replacement);

    expect(next.allColumns.find((column) => column.columnId === "COL_ID_NAME")?.pinned).toBe(
      undefined,
    );
    expect(next.allColumns.find((column) => column.columnId === "COL_ID_STATUS")?.pinned).toBe(
      "end",
    );
    expect(next.allColumns.find((column) => column.columnId === "COL_ID_NEW")?.pinned).toBe(
      "start",
    );
  });

  it("does not commit mount-time order when no persisted identity survives", () => {
    const restored = restoreBrunoTableColumnLayout(columns, {
      columnOrder: ["COL_ID_REMOVED"],
      columnVisibility: {},
      columnWidths: {},
      columnPinning: { start: [], end: [] },
    });
    const replacement = compileColumns([
      { columnId: "COL_ID_STATUS", headerName: "Status", field: "status", valueType: "text" },
      { columnId: "COL_ID_NAME", headerName: "Name", field: "name", valueType: "text" },
      { columnId: "COL_ID_SCORE", headerName: "Score", field: "score", valueType: "number" },
    ]);

    expect(restored.orderOverride).toBeUndefined();
    expect(
      reconcileBrunoTableColumnLayout(restored, replacement).allColumns.map(
        (column) => column.columnId,
      ),
    ).toEqual(["COL_ID_STATUS", "COL_ID_NAME", "COL_ID_SCORE"]);
  });

  it("restores a very wide complete order within one linear initialization budget", () => {
    const wideColumns = compileColumns(
      Array.from({ length: 10_000 }, (_unused, index) => ({
        columnId: `COL_ID_WIDE_${String(index)}`,
        headerName: `Wide ${String(index)}`,
        field: "name",
        valueType: "text" as const,
      })),
    );
    const columnOrder = wideColumns.map((column) => column.columnId).reverse();
    const start = performance.now();

    const restored = restoreBrunoTableColumnLayout(wideColumns, {
      columnOrder,
      columnVisibility: {},
      columnWidths: {},
      columnPinning: { start: [], end: [] },
    });

    expect(performance.now() - start).toBeLessThan(150);
    expect(restored.allColumns[0]?.columnId).toBe("COL_ID_WIDE_9999");

    const reconcileStart = performance.now();
    const reconciled = reconcileBrunoTableColumnLayout(restored, wideColumns);
    expect(performance.now() - reconcileStart).toBeLessThan(150);
    expect(reconciled.allColumns[0]?.columnId).toBe("COL_ID_WIDE_9999");
  });

  it("reconciles visible order when definitions are reordered", () => {
    const state = createBrunoTableColumnLayout(randomizedColumnDefinitions(["A", "B", "C"]));
    const next = reconcileBrunoTableColumnLayout(
      state,
      randomizedColumnDefinitions(["C", "B", "A"]),
    );

    expect(next.allColumns.map((column) => column.columnId)).toEqual([
      "COL_ID_C",
      "COL_ID_B",
      "COL_ID_A",
    ]);
    expect(next.visibleColumnIds).toEqual(["COL_ID_C", "COL_ID_B", "COL_ID_A"]);
    expect(
      getBrunoTableColumnLayoutSnapshot(next).columns.map((column) => column.columnId),
    ).toEqual(next.visibleColumnIds);
  });

  it("reconciles a newly inserted definition at its definition position", () => {
    const state = createBrunoTableColumnLayout(randomizedColumnDefinitions(["A", "B"]));
    const next = reconcileBrunoTableColumnLayout(
      state,
      randomizedColumnDefinitions(["A", "NEW", "B"]),
    );

    expect(next.allColumns.map((column) => column.columnId)).toEqual([
      "COL_ID_A",
      "COL_ID_NEW",
      "COL_ID_B",
    ]);
    expect(next.visibleColumnIds).toEqual(["COL_ID_A", "COL_ID_NEW", "COL_ID_B"]);
  });

  it("keeps pin commits and visibility reset on one logical projection", () => {
    const state = createBrunoTableColumnLayout(
      randomizedColumnDefinitions(["CENTER", "SECOND", "FIRST"]),
    );
    const firstPinned = applyBrunoTableGridCommand(state, {
      type: "column.pin.commit",
      columnId: "COL_ID_FIRST",
      pinned: "start",
    });
    const bothPinned = applyBrunoTableGridCommand(firstPinned, {
      type: "column.pin.commit",
      columnId: "COL_ID_SECOND",
      pinned: "start",
    });
    const resetVisibility = applyBrunoTableGridCommand(bothPinned, {
      type: "column.reset.visibility",
    });

    expectLogicalVisibleInvariant(bothPinned);
    expectLogicalVisibleInvariant(resetVisibility);
    expect(bothPinned.visibleColumnIds).toEqual(["COL_ID_SECOND", "COL_ID_FIRST", "COL_ID_CENTER"]);
    expect(resetVisibility.visibleColumnIds).toEqual(bothPinned.visibleColumnIds);
  });

  it("preserves the logical visible projection through randomized command sequences", () => {
    const definitions = [
      randomizedColumnDefinitions(["A", "B", "C", "D"]),
      randomizedColumnDefinitions(["D", "B", "NEW", "A", "C"]),
      randomizedColumnDefinitions(["C", "A", "E", "B", "D"]),
    ];
    const seed = { value: 48 };
    let state = createBrunoTableColumnLayout(definitions[0]!);
    const operations = ["reorder", "pin", "hide", "show", "reset", "reconcile"] as const;

    for (let step = 0; step < 240; step += 1) {
      const operation =
        operations[step < operations.length ? step : randomIndex(seed, operations.length)]!;
      const visible = [...state.visibleColumnIds];
      const hidden = state.allColumns
        .map((column) => column.columnId)
        .filter((columnId) => !state.visibleColumnIds.includes(columnId));

      switch (operation) {
        case "reorder": {
          if (visible.length > 1) {
            const columnId = visible[randomIndex(seed, visible.length)]!;
            const column = state.allColumns.find((candidate) => candidate.columnId === columnId)!;
            state = applyBrunoTableGridCommand(state, {
              type: "column.reorder.commit",
              columnId,
              targetIndex: randomIndex(seed, visible.length),
              pinned: column.pinned,
            });
          }
          break;
        }
        case "pin": {
          const column = state.allColumns[randomIndex(seed, state.allColumns.length)]!;
          const pinned: BrunoTableColumnPin =
            column.pinned === "start" ? "end" : column.pinned === "end" ? undefined : "start";
          state = applyBrunoTableGridCommand(state, {
            type: "column.pin.commit",
            columnId: column.columnId,
            pinned,
          });
          break;
        }
        case "hide": {
          if (visible.length > 1) {
            state = applyBrunoTableGridCommand(state, {
              type: "column.visibility.commit",
              columnId: visible[randomIndex(seed, visible.length)]!,
              visible: false,
            });
          }
          break;
        }
        case "show": {
          const columnId =
            hidden.length > 0
              ? hidden[randomIndex(seed, hidden.length)]!
              : visible[randomIndex(seed, visible.length)]!;
          state = applyBrunoTableGridCommand(state, {
            type: "column.visibility.commit",
            columnId,
            visible: true,
          });
          break;
        }
        case "reset": {
          const resetCommands = [
            { type: "column.reset.order" },
            { type: "column.reset.visibility" },
            { type: "column.reset.pinning" },
            { type: "column.reset.layout" },
          ] as const;
          state = applyBrunoTableGridCommand(
            state,
            resetCommands[randomIndex(seed, resetCommands.length)]!,
          );
          break;
        }
        case "reconcile": {
          state = reconcileBrunoTableColumnLayout(
            state,
            definitions[randomIndex(seed, definitions.length)]!,
          );
          break;
        }
      }

      expectLogicalVisibleInvariant(state);
      expect(
        getBrunoTableLogicalColumnOrder(state.allColumns)
          .filter((column) => state.visibleColumnIds.includes(column.columnId))
          .map((column) => column.columnId),
      ).toEqual(state.visibleColumnIds);
    }
  });

  it("applies definition width and pin changes when the user has not overridden them", () => {
    const state = createBrunoTableColumnLayout(columns);
    const replacement = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        width: 220,
        pinned: "end",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
        width: 72,
      },
    ]);
    const next = reconcileBrunoTableColumnLayout(state, replacement);
    const name = next.allColumns.find((column) => column.columnId === "COL_ID_NAME");

    expect(name?.semantics.width).toBe(220);
    expect(name?.pinned).toBe("end");
  });

  it("retains a visible column when all previously visible identities are removed", () => {
    const state = applyBrunoTableGridCommand(createBrunoTableColumnLayout(columns), {
      type: "column.visibility.commit",
      columnId: "COL_ID_SCORE",
      visible: false,
    });
    const hiddenOnly = applyBrunoTableGridCommand(state, {
      type: "column.visibility.commit",
      columnId: "COL_ID_STATUS",
      visible: false,
    });
    const replacement = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);

    const next = reconcileBrunoTableColumnLayout(hiddenOnly, replacement);

    expect(next.visibleColumnIds).toEqual(["COL_ID_SCORE"]);
  });

  it("reorders visible columns without losing hidden-column durability", () => {
    const state = createBrunoTableColumnLayout(columns);
    const unpinned = applyBrunoTableGridCommand(state, {
      type: "column.pin.commit",
      columnId: "COL_ID_STATUS",
      pinned: undefined,
    });
    const hidden = applyBrunoTableGridCommand(unpinned, {
      type: "column.visibility.commit",
      columnId: "COL_ID_SCORE",
      visible: false,
    });
    const reordered = applyBrunoTableGridCommand(hidden, {
      type: "column.reorder.commit",
      columnId: "COL_ID_STATUS",
      targetIndex: 0,
      pinned: undefined,
    });
    const shown = applyBrunoTableGridCommand(reordered, {
      type: "column.visibility.commit",
      columnId: "COL_ID_SCORE",
      visible: true,
    });

    expect(ids(getBrunoTableColumnLayoutSnapshot(hidden))).toEqual([
      "COL_ID_NAME",
      "COL_ID_STATUS",
    ]);
    expect(ids(getBrunoTableColumnLayoutSnapshot(reordered))).toEqual([
      "COL_ID_STATUS",
      "COL_ID_NAME",
    ]);
    expect(ids(getBrunoTableColumnLayoutSnapshot(shown))).toEqual([
      "COL_ID_STATUS",
      "COL_ID_SCORE",
      "COL_ID_NAME",
    ]);
  });

  it("crosses pinning regions through one atomic reorder command", () => {
    const state = createBrunoTableColumnLayout(columns);
    const statusToCenter = applyBrunoTableGridCommand(state, {
      type: "column.reorder.commit",
      columnId: "COL_ID_STATUS",
      targetIndex: 1,
      pinned: undefined,
    });
    const nameToEnd = applyBrunoTableGridCommand(statusToCenter, {
      type: "column.reorder.commit",
      columnId: "COL_ID_NAME",
      targetIndex: 2,
      pinned: "end",
    });

    expect(statusToCenter.allColumns.map((column) => column.columnId)).toEqual([
      "COL_ID_NAME",
      "COL_ID_STATUS",
      "COL_ID_SCORE",
    ]);
    expect(
      statusToCenter.allColumns.find((column) => column.columnId === "COL_ID_STATUS")?.pinned,
    ).toBe(undefined);
    expect(nameToEnd.allColumns.map((column) => column.columnId)).toEqual([
      "COL_ID_STATUS",
      "COL_ID_SCORE",
      "COL_ID_NAME",
    ]);
    expect(nameToEnd.allColumns.find((column) => column.columnId === "COL_ID_NAME")?.pinned).toBe(
      "end",
    );
  });

  it("uses visible logical positions when hidden columns precede a reorder target", () => {
    const reorderColumns = compileColumns([
      { columnId: "COL_ID_FIRST", headerName: "First", field: "name", valueType: "text" },
      { columnId: "COL_ID_SECOND", headerName: "Second", field: "score", valueType: "number" },
      { columnId: "COL_ID_THIRD", headerName: "Third", field: "status", valueType: "text" },
    ]);
    const hiddenFirst = applyBrunoTableGridCommand(createBrunoTableColumnLayout(reorderColumns), {
      type: "column.visibility.commit",
      columnId: "COL_ID_FIRST",
      visible: false,
    });
    const reordered = applyBrunoTableGridCommand(hiddenFirst, {
      type: "column.reorder.commit",
      columnId: "COL_ID_THIRD",
      targetIndex: 0,
      pinned: undefined,
    });

    expect(getBrunoTableColumnLayoutSnapshot(reordered).visibleColumnIds).toEqual([
      "COL_ID_THIRD",
      "COL_ID_SECOND",
    ]);
    expect(reordered.allColumns.map((column) => column.columnId)).toEqual([
      "COL_ID_FIRST",
      "COL_ID_THIRD",
      "COL_ID_SECOND",
    ]);
  });

  it("rejects hiding the last navigable column", () => {
    const state = createBrunoTableColumnLayout(columns);
    const one = applyBrunoTableGridCommand(state, {
      type: "column.visibility.commit",
      columnId: "COL_ID_SCORE",
      visible: false,
    });
    const two = applyBrunoTableGridCommand(one, {
      type: "column.visibility.commit",
      columnId: "COL_ID_NAME",
      visible: false,
    });
    const rejected = applyBrunoTableGridCommand(two, {
      type: "column.visibility.commit",
      columnId: "COL_ID_STATUS",
      visible: false,
    });

    expect(ids(getBrunoTableColumnLayoutSnapshot(two))).toEqual(["COL_ID_STATUS"]);
    expect(rejected).toBe(two);
  });

  it("resets each layout axis independently and resets all axes atomically", () => {
    const state = createBrunoTableColumnLayout(columns);
    const changed = [
      {
        type: "column.resize.commit" as const,
        columnId: "COL_ID_NAME",
        width: 240,
      },
      {
        type: "column.reorder.commit" as const,
        columnId: "COL_ID_NAME",
        targetIndex: 1,
        pinned: undefined,
      },
      {
        type: "column.visibility.commit" as const,
        columnId: "COL_ID_SCORE",
        visible: false,
      },
      {
        type: "column.pin.commit" as const,
        columnId: "COL_ID_NAME",
        pinned: "start" as const,
      },
    ].reduce(applyBrunoTableGridCommand, state);
    const resetWidths = applyBrunoTableGridCommand(changed, { type: "column.reset.widths" });
    const resetLayout = applyBrunoTableGridCommand(changed, { type: "column.reset.layout" });

    expect(
      resetWidths.allColumns.find((column) => column.columnId === "COL_ID_NAME")?.semantics.width,
    ).toBe(120);
    expect(getBrunoTableColumnLayoutSnapshot(resetWidths).visibleColumnIds).toEqual([
      "COL_ID_NAME",
      "COL_ID_STATUS",
    ]);
    expect(ids(getBrunoTableColumnLayoutSnapshot(resetLayout))).toEqual([
      "COL_ID_NAME",
      "COL_ID_SCORE",
      "COL_ID_STATUS",
    ]);
    expect(resetLayout.allColumns.map((column) => column.semantics.width)).toEqual([120, 96, 140]);
    expect(resetLayout.allColumns.map((column) => column.pinned)).toEqual([
      undefined,
      undefined,
      "end",
    ]);
  });
});
