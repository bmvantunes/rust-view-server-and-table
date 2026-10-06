import { describe, expect, it, vi } from "vitest";

import { compileColumns, type CompiledFieldColumn } from "./compile-columns";
import {
  BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST,
  BrunoTableCellEditTraversalIndex,
} from "./cell-edit-traversal";

type Row = Readonly<{
  readonly id: string;
  readonly enabled: boolean;
  readonly alternate: boolean;
}>;

const makeColumns = () =>
  compileColumns([
    {
      columnId: "COL_ID_ENABLED",
      field: "enabled",
      headerName: "Enabled",
      valueType: "boolean",
      isEditable: ({ row }: { readonly row: Row }) => row.enabled,
    },
    {
      columnId: "COL_ID_ALTERNATE",
      field: "alternate",
      headerName: "Alternate",
      valueType: "boolean",
      isEditable: ({ row }: { readonly row: Row }) => row.alternate,
    },
  ]);

function rowSpace(rowIds: readonly string[]) {
  return Object.freeze({
    totalRows: rowIds.length,
    getRowId: (rowIndex: number) => rowIds[rowIndex],
  });
}

describe("BrunoTable editable traversal index", () => {
  it("coalesces repeated single-cell invalidation and preserves additional dirty columns", () => {
    const row: Row = { id: "row", enabled: false, alternate: false };
    const eligible = new Set<string>();
    const evaluate = vi.fn((_rowId: string, _row: object, column: CompiledFieldColumn) =>
      eligible.has(column.columnId),
    );
    const index = new BrunoTableCellEditTraversalIndex(() => row, evaluate);
    const columns = makeColumns();
    index.reconcile(columns, rowSpace([row.id]));
    evaluate.mockClear();

    eligible.add("COL_ID_ALTERNATE");
    index.invalidateCell(row.id, "COL_ID_ALTERNATE");
    index.invalidateCell(row.id, "COL_ID_ALTERNATE");
    expect(index.find(0, "COL_ID_ENABLED", 1)?.columnId).toBe("COL_ID_ALTERNATE");
    expect(evaluate).toHaveBeenCalledTimes(1);
    evaluate.mockClear();

    eligible.clear();
    eligible.add("COL_ID_ENABLED");
    index.invalidateCell(row.id, "COL_ID_ALTERNATE");
    index.invalidateCell(row.id, "COL_ID_ENABLED");
    index.invalidateCell(row.id, "COL_ID_ALTERNATE");
    expect(index.find(0, "COL_ID_ALTERNATE", -1)?.columnId).toBe("COL_ID_ENABLED");
    expect(index.find(0, "COL_ID_ENABLED", 1)).toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("paces initial and remapped row-space identity projection without rescanning equivalent columns", () => {
    const rowCount = 5_000;
    const rows = new Map<string, Row>(
      Array.from({ length: rowCount }, (_unused, rowIndex) => {
        const id = `projection-${String(rowIndex)}`;
        return [id, { id, enabled: rowIndex === rowCount - 1, alternate: false }];
      }),
    );
    const editable = ({ row }: { readonly row: Row }) => row.enabled;
    const makeEquivalentColumns = () =>
      compileColumns([
        {
          columnId: "COL_ID_PROJECTION",
          field: "enabled" as const,
          headerName: "Projection",
          valueType: "boolean" as const,
          isEditable: editable,
        },
      ]);
    const rowIds = [...rows.keys()];
    const getRowId = vi.fn((rowIndex: number) => rowIds[rowIndex]);
    const projection = Object.freeze({ totalRows: rowCount, getRowId });
    const evaluate = vi.fn((_rowId: string, row: object) => (row as Row).enabled);
    const getRow = vi.fn((rowId: string) => rows.get(rowId));
    const index = new BrunoTableCellEditTraversalIndex(getRow, evaluate, true);

    expect(index.reconcile(makeEquivalentColumns(), projection)).toBe(true);
    expect(getRowId).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(index.find(0, "COL_ID_PROJECTION", 1)).toBeUndefined();
    expect(index.buildNextSlice(80, Number.POSITIVE_INFINITY)).toBe(true);
    expect(getRowId).toHaveBeenCalledTimes(5);
    expect(getRowId.mock.calls.map(([rowIndex]) => rowIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(index.reconcile(makeEquivalentColumns(), projection)).toBe(true);
    expect(index.buildNextSlice(80, Number.POSITIVE_INFINITY)).toBe(true);
    expect(getRowId.mock.calls.map(([rowIndex]) => rowIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));
    expect(index.find(0, "COL_ID_PROJECTION", 1)?.rowId).toBe(`projection-${String(rowCount - 1)}`);

    getRowId.mockClear();
    evaluate.mockClear();
    expect(index.reconcile(makeEquivalentColumns(), projection)).toBe(false);
    expect(index.isReady()).toBe(true);
    expect(getRowId).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();

    const reversedRowIds = rowIds.toReversed();
    const remappedGetRowId = vi.fn((rowIndex: number) => reversedRowIds[rowIndex]);
    const remappedProjection = Object.freeze({ totalRows: rowCount, getRowId: remappedGetRowId });
    expect(index.reconcile(makeEquivalentColumns(), remappedProjection)).toBe(true);
    expect(remappedGetRowId).not.toHaveBeenCalled();
    expect(index.find(0, "COL_ID_PROJECTION", 1)).toBeUndefined();
    expect(index.buildNextSlice(80, Number.POSITIVE_INFINITY)).toBe(true);
    expect(remappedGetRowId).toHaveBeenCalledTimes(5);

    getRow.mockClear();
    expect(index.reconcile(makeEquivalentColumns(), projection)).toBe(true);
    expect(getRowId).not.toHaveBeenCalled();
    expect(index.buildNextSlice(80, Number.POSITIVE_INFINITY)).toBe(true);
    expect(getRow).not.toHaveBeenCalled();
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));
    expect(evaluate).not.toHaveBeenCalled();
    expect(remappedGetRowId).toHaveBeenCalledTimes(5);
    expect(index.find(0, "COL_ID_PROJECTION", 1)?.rowId).toBe(`projection-${String(rowCount - 1)}`);
  });

  it("keeps literal editable columns analytical without reading or evaluating rows", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_STATIC",
        field: "id",
        headerName: "Static",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const getRow = vi.fn();
    const evaluate = vi.fn();
    const index = new BrunoTableCellEditTraversalIndex(getRow, evaluate);

    const rowIds = Array.from({ length: 5_000 }, (_unused, index) => `row-${String(index)}`);
    const projection = rowSpace(rowIds);
    index.reconcile(columns, projection);

    expect(index.find(0, "COL_ID_STATIC", 1)).toEqual({
      rowIndex: 1,
      rowId: "row-1",
      columnId: "COL_ID_STATIC",
    });
    expect(index.reconcileRows(new Set(rowIds))).toBe(false);
    expect(index.reconcileRows(undefined)).toBe(false);
    expect(index.isReady()).toBe(true);
    expect(index.getCachedRowCount()).toBe(0);
    expect(index.find(rowIds.length - 2, "COL_ID_STATIC", 1)?.rowId).toBe("row-4999");
    expect(getRow).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("retains dirty-cell authority through a synchronous projection rebuild", () => {
    const row: Row = { id: "row", enabled: false, alternate: false };
    const columns = makeColumns();
    let draftEligible = false;
    const evaluate = vi.fn(
      (_rowId: string, _row: object, column: CompiledFieldColumn) =>
        column.columnId === "COL_ID_ENABLED" && draftEligible,
    );
    const index = new BrunoTableCellEditTraversalIndex(() => row, evaluate);

    index.reconcile(columns, rowSpace([row.id]));
    expect(index.findFromRowBoundary(0, 1)).toBeUndefined();

    draftEligible = true;
    evaluate.mockClear();
    index.invalidateCell(row.id, "COL_ID_ENABLED");
    index.reconcile(columns, rowSpace([row.id]));

    expect(evaluate).toHaveBeenCalledTimes(columns.length);
    expect(index.findFromRowBoundary(0, 1)).toEqual({
      rowIndex: 0,
      rowId: row.id,
      columnId: "COL_ID_ENABLED",
    });
  });

  it("atomically discards in-flight predicate evidence when columns become static", () => {
    const rowIds = Array.from({ length: 40 }, (_unused, index) => `transition-${String(index)}`);
    const rows = new Map(
      rowIds.map((id, index) => [id, { id, enabled: index === 39, alternate: false }]),
    );
    const predicateColumns = compileColumns(
      Array.from({ length: 40 }, (_unused, columnIndex) => ({
        columnId: `COL_ID_TRANSITION_${String(columnIndex)}`,
        field: "enabled" as const,
        headerName: `Transition ${String(columnIndex)}`,
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      })),
    );
    const staticColumns = compileColumns([
      {
        columnId: "COL_ID_STATIC_TRANSITION",
        field: "id" as const,
        headerName: "Static transition",
        valueType: "text" as const,
        isEditable: true,
      },
    ]);
    const getRow = vi.fn((rowId: string) => rows.get(rowId));
    const index = new BrunoTableCellEditTraversalIndex(
      getRow,
      (_rowId, row) => (row as Row).enabled,
      true,
    );
    const projection = rowSpace(rowIds);

    expect(index.reconcile(predicateColumns, projection)).toBe(true);
    index.buildNextSlice(80, Number.POSITIVE_INFINITY);
    expect(index.isReady()).toBe(false);
    getRow.mockClear();
    expect(index.reconcile(staticColumns, projection)).toBe(true);

    expect(index.isReady()).toBe(false);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));
    expect(index.isReady()).toBe(true);
    expect(index.getCachedRowCount()).toBe(0);
    expect(index.find(0, "COL_ID_STATIC_TRANSITION", 1)?.rowId).toBe("transition-1");
    expect(index.reconcileRows(new Set(rowIds))).toBe(false);
    expect(index.reconcileRows(undefined)).toBe(false);
    expect(getRow).not.toHaveBeenCalled();
  });

  it("restores predicate-era missing identities when a ready index becomes static", () => {
    const rowIds = ["missing", "present"];
    const rows = new Map<string, Row>([
      ["present", { id: "present", enabled: false, alternate: false }],
    ]);
    const predicateColumns = compileColumns([
      {
        columnId: "COL_ID_TRANSITION",
        field: "enabled" as const,
        headerName: "Transition",
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      },
    ]);
    const staticColumns = compileColumns([
      {
        columnId: "COL_ID_TRANSITION",
        field: "enabled" as const,
        headerName: "Transition",
        valueType: "boolean" as const,
        isEditable: true,
      },
    ]);
    const getRow = vi.fn((rowId: string) => rows.get(rowId));
    const index = new BrunoTableCellEditTraversalIndex(
      getRow,
      (_rowId, row) => (row as Row).enabled,
      true,
    );
    const projection = rowSpace(rowIds);
    index.reconcile(predicateColumns, projection);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));
    expect(index.isReady()).toBe(true);
    getRow.mockClear();

    expect(index.reconcile(staticColumns, projection)).toBe(true);
    expect(index.isReady()).toBe(false);
    expect(getRow).not.toHaveBeenCalled();
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));
    expect(index.findFromRowBoundary(1, -1)).toEqual({
      rowIndex: 0,
      rowId: "missing",
      columnId: "COL_ID_TRANSITION",
    });
    expect(getRow).not.toHaveBeenCalled();
  });

  it("finds exact far-later, reverse, and terminal destinations without a cell scan", () => {
    const rows = new Map<string, Row>(
      Array.from({ length: 5_000 }, (_unused, index) => {
        const id = `row-${String(index)}`;
        return [id, { id, enabled: index === 4_999, alternate: false }];
      }),
    );
    const columns = makeColumns();
    const evaluate = vi.fn((_rowId: string, row: object, column: CompiledFieldColumn) =>
      column.columnId === "COL_ID_ENABLED" ? (row as Row).enabled : (row as Row).alternate,
    );
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate);
    const projection = rowSpace([...rows.keys()]);

    index.reconcile(columns, projection);

    expect(index.find(0, "COL_ID_ENABLED", 1)).toEqual({
      rowIndex: 4_999,
      rowId: "row-4999",
      columnId: "COL_ID_ENABLED",
    });
    expect(index.find(4_999, "COL_ID_ALTERNATE", -1)).toEqual({
      rowIndex: 4_999,
      rowId: "row-4999",
      columnId: "COL_ID_ENABLED",
    });
    expect(index.find(0, "COL_ID_ENABLED", -1)).toBeUndefined();
    expect(index.find(4_999, "COL_ID_ENABLED", 1)).toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(10_000);
  });

  it("reuses predicate evidence across sort and filter, then reevaluates bounded causes", () => {
    const first: Row = { id: "first", enabled: false, alternate: false };
    const second: Row = { id: "second", enabled: true, alternate: false };
    const third: Row = { id: "third", enabled: false, alternate: true };
    const rows = new Map<string, Row>([
      [first.id, first],
      [second.id, second],
      [third.id, third],
    ]);
    const evaluate = vi.fn((_rowId: string, row: object, column: CompiledFieldColumn) =>
      column.columnId === "COL_ID_ENABLED" ? (row as Row).enabled : (row as Row).alternate,
    );
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate);
    const columns = makeColumns();

    index.reconcile(columns, rowSpace(["first", "second", "third"]));
    expect(evaluate).toHaveBeenCalledTimes(6);
    index.reconcile(columns, rowSpace(["third", "second", "first"]));
    index.reconcile(columns, rowSpace(["third", "first"]));
    index.reconcile(columns, rowSpace(["first", "second", "third"]));
    expect(evaluate).toHaveBeenCalledTimes(6);
    expect(index.find(0, "COL_ID_ENABLED", 1)).toEqual({
      rowIndex: 1,
      rowId: "second",
      columnId: "COL_ID_ENABLED",
    });

    index.reconcile(columns.toReversed(), rowSpace(["third", "second", "first"]));
    expect(evaluate).toHaveBeenCalledTimes(6);
    expect(index.find(0, "COL_ID_ENABLED", -1)).toEqual({
      rowIndex: 0,
      rowId: "third",
      columnId: "COL_ID_ALTERNATE",
    });
    index.reconcile(columns, rowSpace(["first", "second", "third"]));

    const replacement: Row = { ...second, enabled: false, alternate: true };
    rows.set(second.id, replacement);
    index.reconcileRows(new Set(["second"]));
    expect(evaluate).toHaveBeenCalledTimes(6);
    expect(index.find(0, "COL_ID_ENABLED", 1)).toEqual({
      rowIndex: 1,
      rowId: "second",
      columnId: "COL_ID_ALTERNATE",
    });
    expect(evaluate).toHaveBeenCalledTimes(8);

    index.invalidateCell("second", "COL_ID_ALTERNATE");
    expect(index.find(0, "COL_ID_ENABLED", 1)).toEqual({
      rowIndex: 1,
      rowId: "second",
      columnId: "COL_ID_ALTERNATE",
    });
    expect(evaluate).toHaveBeenCalledTimes(9);

    const nextColumns = makeColumns();
    index.reconcile(nextColumns, rowSpace(["first", "second", "third"]));
    expect(evaluate).toHaveBeenCalledTimes(15);

    index.reconcile(nextColumns, rowSpace(["first", "third"]));
    expect(index.getCachedRowCount()).toBe(3);
    rows.delete("second");
    index.reconcileRows(new Set(["second"]));
    index.reconcile(nextColumns, rowSpace(["first", "third"]));
    expect(index.getCachedRowCount()).toBe(2);
  });

  it("reuses predicate evidence across equivalent column recompiles", () => {
    const predicate = ({ row }: { readonly row: Row }) => row.enabled;
    const makeEquivalentColumns = () =>
      compileColumns([
        {
          columnId: "COL_ID_ENABLED",
          field: "enabled" as const,
          headerName: "Enabled",
          valueType: "boolean" as const,
          isEditable: predicate,
        },
      ]);
    const rows = new Map<string, Row>([
      ["first", { id: "first", enabled: true, alternate: false }],
      ["second", { id: "second", enabled: false, alternate: false }],
    ]);
    const evaluate = vi.fn((_rowId: string, row: object) => (row as Row).enabled);
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate);

    index.reconcile(makeEquivalentColumns(), rowSpace(["first", "second"]));
    expect(evaluate).toHaveBeenCalledTimes(2);
    index.reconcile(makeEquivalentColumns(), rowSpace(["first", "second"]));
    expect(evaluate).toHaveBeenCalledTimes(2);

    index.reconcile(
      compileColumns([
        {
          columnId: "COL_ID_ENABLED",
          field: "enabled" as const,
          headerName: "Enabled",
          valueType: "boolean" as const,
          isEditable: ({ row }: { readonly row: Row }) => row.alternate,
        },
      ]),
      rowSpace(["first", "second"]),
    );
    expect(evaluate).toHaveBeenCalledTimes(4);
  });

  it("cycles exact horizontal and vertical range eligibility from indexed evidence", () => {
    const rangeRows = new Map<string, Row>([
      ["first", { id: "first", enabled: true, alternate: false }],
      ["middle", { id: "middle", enabled: false, alternate: false }],
      ["last", { id: "last", enabled: true, alternate: true }],
    ]);
    const columns = makeColumns();
    const index = new BrunoTableCellEditTraversalIndex(
      (rowId) => rangeRows.get(rowId),
      (_rowId, row, column) =>
        column.columnId === "COL_ID_ENABLED" ? (row as Row).enabled : (row as Row).alternate,
    );
    index.reconcile(columns, rowSpace([...rangeRows.keys()]));
    const vertical = Object.freeze({
      axis: "vertical" as const,
      columnId: "COL_ID_ENABLED",
      rowIds: Object.freeze(["first", "middle", "last"]),
    });
    const horizontal = Object.freeze({
      axis: "horizontal" as const,
      rowId: "last",
      columnIds: Object.freeze(["COL_ID_ENABLED", "COL_ID_ALTERNATE"]),
    });

    expect(index.findRange(vertical, "first", "COL_ID_ENABLED", 1)?.rowId).toBe("last");
    expect(index.findRange(vertical, "last", "COL_ID_ENABLED", 1)?.rowId).toBe("first");
    expect(index.findRange(vertical, "first", "COL_ID_ENABLED", -1)?.rowId).toBe("last");
    expect(index.getCachedVerticalRangeDestinationCount()).toBe(2);
    expect(index.findRange(horizontal, "last", "COL_ID_ENABLED", 1)?.columnId).toBe(
      "COL_ID_ALTERNATE",
    );
    expect(index.findRange(horizontal, "last", "COL_ID_ALTERNATE", 1)?.columnId).toBe(
      "COL_ID_ENABLED",
    );

    rangeRows.set("middle", { id: "middle", enabled: true, alternate: false });
    index.reconcileRows(new Set(["middle"]));
    expect(index.findRange(vertical, "first", "COL_ID_ENABLED", 1)?.rowId).toBe("middle");

    index.reconcileRange(horizontal);
    expect(index.getCachedVerticalRangeDestinationCount()).toBe(0);
    rangeRows.set("middle", { id: "middle", enabled: false, alternate: false });
    index.reconcileRows(new Set(["middle"]));
    expect(index.getCachedVerticalRangeDestinationCount()).toBe(0);

    index.findRange(vertical, "first", "COL_ID_ENABLED", 1);
    expect(index.getCachedVerticalRangeDestinationCount()).toBe(2);
    index.reconcileRange(undefined);
    expect(index.getCachedVerticalRangeDestinationCount()).toBe(0);
  });

  it("reevaluates only 150 predicate cells for one changed row in a 5,000 by 150 index", () => {
    const rows = new Map<string, Row>(
      Array.from({ length: 5_000 }, (_unused, rowIndex) => {
        const id = `row-${String(rowIndex)}`;
        return [id, { id, enabled: false, alternate: false }];
      }),
    );
    const columns = compileColumns(
      Array.from({ length: 150 }, (_unused, columnIndex) => ({
        columnId: `COL_ID_${String(columnIndex)}`,
        field: "enabled" as const,
        headerName: `Column ${String(columnIndex)}`,
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      })),
    );
    const evaluate = vi.fn((_rowId: string, row: object) => (row as Row).enabled);
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate);
    index.reconcile(columns, rowSpace([...rows.keys()]));
    evaluate.mockClear();

    rows.set("row-2500", { id: "row-2500", enabled: true, alternate: false });
    index.reconcileRows(new Set(["row-2500"]));

    expect(evaluate).not.toHaveBeenCalled();
    expect(index.find(0, columns[0]!.columnId, 1)?.rowId).toBe("row-2500");
    expect(evaluate).toHaveBeenCalledTimes(150);
  });

  it("paces replacement of every predicate authority without synchronous callbacks", () => {
    const rowCount = 40;
    const columnCount = 40;
    const rowIds = Array.from({ length: rowCount }, (_unused, rowIndex) => `authority-${rowIndex}`);
    const rows = new Map<string, Row>(
      rowIds.map((id) => [id, { id, enabled: true, alternate: false }]),
    );
    const makeAuthorityColumns = () =>
      compileColumns(
        Array.from({ length: columnCount }, (_unused, columnIndex) => ({
          columnId: `COL_ID_AUTHORITY_${String(columnIndex)}`,
          field: "enabled" as const,
          headerName: `Authority ${String(columnIndex)}`,
          valueType: "boolean" as const,
          isEditable: ({ row }: { readonly row: Row }) => row.enabled,
        })),
      );
    const evaluate = vi.fn((_rowId: string, row: object) => (row as Row).enabled);
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate, true);
    const projection = rowSpace(rowIds);
    index.reconcile(makeAuthorityColumns(), projection);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));
    evaluate.mockClear();

    expect(index.reconcile(makeAuthorityColumns(), projection)).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(index.isReady()).toBe(false);
    expect(index.find(0, "COL_ID_AUTHORITY_0", 1)).toBeUndefined();
    expect(index.buildNextSlice(80, Number.POSITIVE_INFINITY)).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(80);
    expect(index.isReady()).toBe(false);

    for (let slice = 1; slice < rowCount / 2; slice += 1) {
      expect(index.buildNextSlice(80, Number.POSITIVE_INFINITY)).toBe(true);
    }
    expect(evaluate).toHaveBeenCalledTimes(rowCount * columnCount);
    expect(index.isReady()).toBe(false);
    expect(index.find(0, "COL_ID_AUTHORITY_0", 1)).toBeUndefined();
    expect(index.buildNextSlice(80, Number.POSITIVE_INFINITY)).toBe(false);
    expect(index.isReady()).toBe(true);
    expect(index.find(0, "COL_ID_AUTHORITY_0", 1)?.columnId).toBe("COL_ID_AUTHORITY_1");
  });

  it("paces decoder-authority changes that alter predicate eligibility", () => {
    type DecodeRow = Readonly<{ readonly id: string; readonly value: string }>;
    const rows = new Map<string, DecodeRow>([["row", { id: "row", value: "raw" }]]);
    const predicate = ({ value }: { readonly value: string }) => value === "allow";
    const makeColumns = (canonical: string) =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: {
            codecId: "test/traversal-decoder-authority",
            codecVersion: 1,
            filterFamily: "equality",
            editorFamily: "text",
            cellAlign: "start",
            editorLayout: "inline",
            defaultWidth: 120,
            decodeRuntime: () => ({ _tag: "Success", value: canonical }) as const,
            equivalent: Object.is,
            compare: () => 0 as const,
            formatCanonicalText: (value: string) => value,
            parseCanonicalText: (text: string) => ({ _tag: "Success", value: text }) as const,
            formatDisplay: (value: string) => value,
            encodePersisted: (value: string) => value,
            decodePersisted: () => ({ _tag: "Success", value: canonical }) as const,
          },
          isEditable: predicate,
        },
      ]);
    const evaluate = vi.fn((_rowId: string, row: object, column: CompiledFieldColumn) => {
      const decoded = column.semantics.decodeRuntime((row as DecodeRow).value);
      return decoded._tag === "Success" && predicate({ value: decoded.value as string });
    });
    const allowedColumns = makeColumns("allow");
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate, true);
    const projection = rowSpace(["row"]);
    index.reconcile(allowedColumns, projection);
    while (index.buildNextSlice(1, Number.POSITIVE_INFINITY));
    expect(index.findFromRowBoundary(1, -1)?.rowId).toBe("row");
    evaluate.mockClear();

    expect(index.reconcile(makeColumns("deny"), projection)).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(index.findFromRowBoundary(1, -1)).toBeUndefined();
    while (index.buildNextSlice(1, Number.POSITIVE_INFINITY));
    expect(evaluate).toHaveBeenCalledOnce();
    expect(index.findFromRowBoundary(1, -1)).toBeUndefined();
  });

  it("restarts an authority projection for row-space and draft interleavings", () => {
    const rows = new Map<string, Row>([
      ["a", { id: "a", enabled: false, alternate: false }],
      ["b", { id: "b", enabled: false, alternate: false }],
      ["c", { id: "c", enabled: false, alternate: false }],
      ["d", { id: "d", enabled: true, alternate: false }],
    ]);
    const draftedRowIds = new Set<string>();
    const makeColumns = () =>
      compileColumns([
        {
          columnId: "COL_ID_INTERLEAVED_AUTHORITY",
          field: "enabled" as const,
          headerName: "Interleaved authority",
          valueType: "boolean" as const,
          isEditable: ({ row }: { readonly row: Row }) => row.enabled,
        },
      ]);
    const index = new BrunoTableCellEditTraversalIndex(
      (rowId) => rows.get(rowId),
      (rowId, row) => (row as Row).enabled || draftedRowIds.has(rowId),
      true,
    );
    const forward = rowSpace(["a", "b", "c", "d"]);
    const reversed = rowSpace(["d", "c", "b", "a"]);
    const initialColumns = makeColumns();
    index.reconcile(initialColumns, forward);
    while (index.buildNextSlice(1, Number.POSITIVE_INFINITY));

    const reorderedColumns = makeColumns();
    index.reconcile(reorderedColumns, forward);
    for (let row = 0; row < rows.size; row += 1) {
      expect(index.buildNextSlice(1, Number.POSITIVE_INFINITY)).toBe(true);
    }
    expect(index.buildNextSlice(2, Number.POSITIVE_INFINITY)).toBe(true);
    expect(index.isReady()).toBe(false);
    index.reconcile(reorderedColumns, reversed);
    while (index.buildNextSlice(1, Number.POSITIVE_INFINITY));
    expect(index.find(1, "COL_ID_INTERLEAVED_AUTHORITY", -1)?.rowId).toBe("d");

    const draftedColumns = makeColumns();
    index.reconcile(draftedColumns, reversed);
    for (let row = 0; row < rows.size; row += 1) {
      expect(index.buildNextSlice(1, Number.POSITIVE_INFINITY)).toBe(true);
    }
    expect(index.buildNextSlice(3, Number.POSITIVE_INFINITY)).toBe(true);
    draftedRowIds.add("b");
    index.invalidateCell("b", "COL_ID_INTERLEAVED_AUTHORITY");
    index.reconcile(draftedColumns, reversed);
    while (index.buildNextSlice(1, Number.POSITIVE_INFINITY));
    expect(index.find(3, "COL_ID_INTERLEAVED_AUTHORITY", -1)?.rowId).toBe("b");
  });

  it("validates row references after an unknown publication without rebuilding unchanged rows", () => {
    const rows = new Map<string, Row>([
      ["first", { id: "first", enabled: false, alternate: false }],
      ["second", { id: "second", enabled: true, alternate: false }],
    ]);
    const evaluate = vi.fn((_rowId: string, row: object, column: CompiledFieldColumn) =>
      column.columnId === "COL_ID_ENABLED" ? (row as Row).enabled : (row as Row).alternate,
    );
    const columns = makeColumns();
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate);
    const projection = rowSpace(["first", "second"]);
    index.reconcile(columns, projection);
    expect(evaluate).toHaveBeenCalledTimes(4);

    index.reconcileRows(undefined);
    expect(evaluate).toHaveBeenCalledTimes(4);
    index.reconcile(columns, rowSpace(["second", "first"]));
    expect(evaluate).toHaveBeenCalledTimes(4);

    rows.set("first", { id: "first", enabled: true, alternate: false });
    index.reconcileRows(undefined);
    index.reconcile(columns, rowSpace(["second"]));
    expect(evaluate).toHaveBeenCalledTimes(4);
    index.reconcile(columns, rowSpace(["first", "second"]));
    expect(evaluate).toHaveBeenCalledTimes(6);
    expect(index.find(0, "COL_ID_ENABLED", 1)?.rowId).toBe("second");
  });

  it("withholds partial destinations and restarts exact incremental work after unknown publications", () => {
    const rowCount = 40;
    const rows = new Map<string, Row>(
      Array.from({ length: rowCount }, (_unused, rowIndex) => {
        const id = `row-${String(rowIndex)}`;
        return [id, { id, enabled: rowIndex === rowCount - 1, alternate: false }];
      }),
    );
    const columns = compileColumns(
      Array.from({ length: 40 }, (_unused, columnIndex) => ({
        columnId: `COL_ID_INCREMENTAL_${String(columnIndex)}`,
        field: "enabled" as const,
        headerName: `Incremental ${String(columnIndex)}`,
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      })),
    );
    const evaluate = vi.fn((_rowId: string, row: object) => (row as Row).enabled);
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate, true);
    const projection = rowSpace([...rows.keys()]);

    expect(index.reconcile(columns, projection)).toBe(true);
    expect(index.find(0, columns[0]!.columnId, 1)).toBeUndefined();
    index.buildNextSlice(80, Number.POSITIVE_INFINITY);
    expect(index.isReady()).toBe(false);

    for (const [rowId, row] of rows) rows.set(rowId, { ...row });
    index.reconcileRows(undefined);
    expect(index.isReady()).toBe(false);
    expect(index.find(0, columns[0]!.columnId, 1)).toBeUndefined();
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY)) {
      expect(index.find(0, columns[0]!.columnId, 1)).toBeUndefined();
    }
    expect(index.isReady()).toBe(true);
    expect(index.find(0, columns[0]!.columnId, 1)).toEqual({
      rowIndex: rowCount - 1,
      rowId: `row-${String(rowCount - 1)}`,
      columnId: columns[0]!.columnId,
    });

    for (const [rowId, row] of rows) rows.set(rowId, { ...row });
    index.reconcileRows(undefined);
    expect(index.find(0, columns[0]!.columnId, 1)).toBeUndefined();
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY)) {
      expect(index.isReady()).toBe(false);
    }
    expect(index.find(0, columns[0]!.columnId, 1)?.rowId).toBe(`row-${String(rowCount - 1)}`);
  });

  it("paces, deduplicates, and applies the latest known-row batch without partial destinations", () => {
    const rowCount = 40;
    const columnCount = 40;
    const rows = new Map<string, Row>(
      Array.from({ length: rowCount }, (_unused, rowIndex) => {
        const id = `known-${String(rowIndex)}`;
        return [id, { id, enabled: rowIndex === rowCount - 1, alternate: false }];
      }),
    );
    const columns = compileColumns(
      Array.from({ length: columnCount }, (_unused, columnIndex) => ({
        columnId: `COL_ID_KNOWN_${String(columnIndex)}`,
        field: "enabled" as const,
        headerName: `Known ${String(columnIndex)}`,
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      })),
    );
    const evaluate = vi.fn((_rowId: string, row: object) => (row as Row).enabled);
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate, true);
    const projection = rowSpace([...rows.keys()]);
    index.reconcile(columns, projection);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));
    evaluate.mockClear();

    for (const [rowId, row] of rows) rows.set(rowId, { ...row, enabled: false });
    const allRowIds = new Set(rows.keys());
    rows.delete("known-0");
    index.reconcileRows(allRowIds);
    expect(evaluate).not.toHaveBeenCalled();
    expect(index.reconcile(columns, projection)).toBe(true);
    expect(index.find(0, columns[0]!.columnId, 1)).toBeUndefined();

    rows.set(`known-${String(rowCount - 1)}`, {
      id: `known-${String(rowCount - 1)}`,
      enabled: true,
      alternate: false,
    });
    index.reconcileRows(new Set([`known-${String(rowCount - 1)}`]));
    expect(index.reconcile(columns, projection)).toBe(true);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY)) {
      expect(index.find(0, columns[0]!.columnId, 1)).toBeUndefined();
    }

    expect(evaluate).toHaveBeenCalledTimes((rowCount - 1) * columnCount);
    expect(index.getCachedRowCount()).toBe(rowCount - 1);
    expect(index.find(0, columns[0]!.columnId, 1)?.rowId).toBe(`known-${String(rowCount - 1)}`);
  });

  it("enqueues late invalidations without rebuilding a large pending tail", () => {
    const rowCount = 40;
    const columnCount = 40;
    const rows = new Map<string, Row>(
      Array.from({ length: rowCount }, (_unused, rowIndex) => {
        const id = `pending-${String(rowIndex)}`;
        return [id, { id, enabled: true, alternate: false }];
      }),
    );
    const columns = compileColumns(
      Array.from({ length: columnCount }, (_unused, columnIndex) => ({
        columnId: `COL_ID_PENDING_${String(columnIndex)}`,
        field: "enabled" as const,
        headerName: `Pending ${String(columnIndex)}`,
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      })),
    );
    const evaluate = vi.fn((_rowId: string, row: object) => (row as Row).enabled);
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate, true);
    const projection = rowSpace([...rows.keys()]);
    index.reconcile(columns, projection);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));

    for (const [rowId, row] of rows) rows.set(rowId, { ...row, enabled: false });
    index.reconcileRows(new Set(rows.keys()));
    expect(index.reconcile(columns, projection)).toBe(true);
    expect(index.buildNextSlice(80, Number.POSITIVE_INFINITY)).toBe(true);
    evaluate.mockClear();

    rows.set("pending-0", { id: "pending-0", enabled: true, alternate: false });
    rows.set("pending-39", { id: "pending-39", enabled: true, alternate: false });
    index.reconcileRows(new Set(["pending-0"]));
    for (let repetition = 0; repetition < 100; repetition += 1) {
      index.reconcileRows(new Set(["pending-39"]));
    }
    expect(index.reconcile(columns, projection)).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(index.find(1, columns[0]!.columnId, -1)).toBeUndefined();

    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY)) {
      expect(index.find(1, columns[0]!.columnId, -1)).toBeUndefined();
    }

    expect(evaluate).toHaveBeenCalledTimes((rowCount - 1) * columnCount);
    expect(index.find(1, columns[0]!.columnId, -1)?.rowId).toBe("pending-0");
    expect(index.find(rowCount - 2, columns[0]!.columnId, 1)?.rowId).toBe("pending-39");
  });

  it("preserves staged row invalidations across a row-space replacement", () => {
    const rowIds = Array.from({ length: 40 }, (_unused, rowIndex) => `restart-${rowIndex}`);
    const rows = new Map<string, Row>(
      rowIds.map((id) => [id, { id, enabled: true, alternate: false }]),
    );
    const columns = compileColumns([
      {
        columnId: "COL_ID_RESTART_EDIT",
        field: "enabled" as const,
        headerName: "Restart edit",
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      },
    ]);
    const evaluate = vi.fn((_rowId: string, row: object) => (row as Row).enabled);
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate, true);
    const initialProjection = rowSpace(rowIds);
    index.reconcile(columns, initialProjection);
    while (index.buildNextSlice(8, Number.POSITIVE_INFINITY));
    evaluate.mockClear();

    rows.set("restart-0", { id: "restart-0", enabled: false, alternate: false });
    rows.delete("restart-39");
    index.reconcileRows(new Set(["restart-0", "restart-39"]));
    expect(index.reconcile(columns, initialProjection)).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();

    const replacementProjection = rowSpace(rowIds.slice(0, -1));
    expect(index.reconcile(columns, replacementProjection)).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(index.find(1, columns[0]!.columnId, -1)).toBeUndefined();
    while (index.buildNextSlice(8, Number.POSITIVE_INFINITY)) {
      expect(index.find(1, columns[0]!.columnId, -1)).toBeUndefined();
    }

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(index.find(1, columns[0]!.columnId, -1)).toBeUndefined();
    expect(index.getCachedRowCount()).toBe(rowIds.length - 1);
  });

  it("consumes present dirty identities during replacement projection discovery", () => {
    const rowIds = Array.from({ length: 40 }, (_unused, rowIndex) => `project-${rowIndex}`);
    const rows = new Map<string, Row>(
      rowIds.map((id) => [id, { id, enabled: true, alternate: false }]),
    );
    const columns = compileColumns([
      {
        columnId: "COL_ID_PROJECT_EDIT",
        field: "enabled" as const,
        headerName: "Project edit",
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      },
    ]);
    const evaluate = vi.fn((_rowId: string, value: object) => (value as Row).enabled);
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate, true);
    const initialProjection = rowSpace(rowIds);
    index.reconcile(columns, initialProjection);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));

    for (const [rowId, value] of rows) rows.set(rowId, { ...value, enabled: false });
    index.reconcileRows(new Set(rowIds));
    index.reconcile(columns, initialProjection);
    const replacementProjection = rowSpace([...rowIds]);
    index.reconcile(columns, replacementProjection);
    evaluate.mockClear();

    expect(
      index.buildNextSlice(
        rowIds.length * BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST,
        Number.POSITIVE_INFINITY,
      ),
    ).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(index.buildNextSlice(1, Number.POSITIVE_INFINITY)).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(index.find(0, columns[0]!.columnId, 1)).toBeUndefined();
  });

  it("discovers unknown replacements without tearing down predicate evidence synchronously", () => {
    const rowCount = 40;
    const columnCount = 40;
    const rows = new Map<string, Row>(
      Array.from({ length: rowCount }, (_unused, rowIndex) => {
        const id = `unknown-${String(rowIndex)}`;
        return [id, { id, enabled: true, alternate: false }];
      }),
    );
    const columns = compileColumns(
      Array.from({ length: columnCount }, (_unused, columnIndex) => ({
        columnId: `COL_ID_UNKNOWN_${String(columnIndex)}`,
        field: "enabled" as const,
        headerName: `Unknown ${String(columnIndex)}`,
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      })),
    );
    const evaluate = vi.fn((_rowId: string, row: object) => (row as Row).enabled);
    const getRow = vi.fn((rowId: string) => rows.get(rowId));
    const index = new BrunoTableCellEditTraversalIndex(getRow, evaluate, true);
    const projection = rowSpace([...rows.keys()]);
    index.reconcile(columns, projection);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));
    evaluate.mockClear();
    getRow.mockClear();

    for (const [rowId, row] of rows) rows.set(rowId, { ...row, enabled: false });
    rows.delete("unknown-0");
    expect(index.reconcileRows(undefined)).toBe(true);
    expect(index.reconcile(columns, projection)).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(index.find(0, columns[0]!.columnId, 1)).toBeUndefined();
    expect(index.buildNextSlice(160, Number.POSITIVE_INFINITY)).toBe(true);
    expect(getRow).toHaveBeenCalledTimes(
      160 / BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST,
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(index.isReady()).toBe(false);

    rows.set(`unknown-${String(rowCount - 1)}`, {
      id: `unknown-${String(rowCount - 1)}`,
      enabled: true,
      alternate: false,
    });
    expect(index.reconcileRows(undefined)).toBe(true);
    expect(index.reconcile(columns, projection)).toBe(true);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY)) {
      expect(index.find(0, columns[0]!.columnId, 1)).toBeUndefined();
    }

    expect(evaluate).toHaveBeenCalledTimes((rowCount - 1) * columnCount);
    expect(index.getCachedRowCount()).toBe(rowCount - 1);
    expect(index.find(0, columns[0]!.columnId, 1)?.rowId).toBe(`unknown-${String(rowCount - 1)}`);
  });

  it("restarts paced unknown evidence for late row, draft, and missing-return invalidations", () => {
    const rowIds = ["late-0", "late-1", "late-2", "late-3"];
    const columns = compileColumns([
      {
        columnId: "COL_ID_LATE_UNKNOWN",
        field: "enabled" as const,
        headerName: "Late unknown",
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      },
    ]);
    const projection = rowSpace(rowIds);
    const createCase = () => {
      const rows = new Map<string, Row>(
        rowIds.map((id) => [id, { id, enabled: false, alternate: false } satisfies Row]),
      );
      const draftedRowIds = new Set<string>();
      const index = new BrunoTableCellEditTraversalIndex(
        (rowId) => rows.get(rowId),
        (rowId, row) => (row as Row).enabled || draftedRowIds.has(rowId),
        true,
      );
      index.reconcile(columns, projection);
      while (index.buildNextSlice(160, Number.POSITIVE_INFINITY));
      return { draftedRowIds, index, rows };
    };
    const drain = (index: BrunoTableCellEditTraversalIndex) => {
      while (index.buildNextSlice(160, Number.POSITIVE_INFINITY)) {
        expect(index.find(1, columns[0]!.columnId, -1)).toBeUndefined();
      }
    };

    const rowCase = createCase();
    rowCase.index.reconcileRows(undefined);
    rowCase.index.reconcile(columns, projection);
    rowCase.index.buildNextSlice(96, Number.POSITIVE_INFINITY);
    rowCase.rows.set("late-0", { id: "late-0", enabled: true, alternate: false });
    rowCase.index.reconcileRows(new Set(["late-0"]));
    drain(rowCase.index);
    expect(rowCase.index.find(1, columns[0]!.columnId, -1)?.rowId).toBe("late-0");

    const draftCase = createCase();
    draftCase.index.reconcileRows(undefined);
    draftCase.index.reconcile(columns, projection);
    draftCase.index.buildNextSlice(96, Number.POSITIVE_INFINITY);
    draftCase.draftedRowIds.add("late-0");
    draftCase.index.invalidateCell("late-0", columns[0]!.columnId);
    drain(draftCase.index);
    expect(draftCase.index.find(1, columns[0]!.columnId, -1)?.rowId).toBe("late-0");

    const missingCase = createCase();
    missingCase.rows.delete("late-0");
    missingCase.index.reconcileRows(undefined);
    missingCase.index.reconcile(columns, projection);
    missingCase.index.buildNextSlice(64, Number.POSITIVE_INFINITY);
    missingCase.rows.set("late-0", { id: "late-0", enabled: true, alternate: false });
    missingCase.index.reconcileRows(new Set(["late-0"]));
    drain(missingCase.index);
    expect(missingCase.index.getCachedRowCount()).toBe(rowIds.length);
    expect(missingCase.index.find(1, columns[0]!.columnId, -1)?.rowId).toBe("late-0");
  });

  it("deduplicates repeated late row and draft invalidations during projection", () => {
    const rowIds = ["repeat-0", "repeat-1", "repeat-2", "repeat-3"];
    const rows = new Map<string, Row>(
      rowIds.map((id) => [id, { id, enabled: false, alternate: false } satisfies Row]),
    );
    const columns = compileColumns([
      {
        columnId: "COL_ID_REPEAT",
        field: "enabled" as const,
        headerName: "Repeat",
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      },
    ]);
    const getRow = vi.fn((rowId: string) => rows.get(rowId));
    const index = new BrunoTableCellEditTraversalIndex(
      getRow,
      (_rowId, row) => (row as Row).enabled,
      true,
    );
    const projection = rowSpace(rowIds);
    index.reconcile(columns, projection);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));

    index.reconcileRows(undefined);
    index.reconcile(columns, projection);
    index.buildNextSlice(80, Number.POSITIVE_INFINITY);
    getRow.mockClear();
    rows.set("repeat-0", { id: "repeat-0", enabled: true, alternate: false });
    for (let repeat = 0; repeat < 100; repeat += 1) {
      index.reconcileRows(new Set(["repeat-0"]));
      index.invalidateCell("repeat-0", columns[0]!.columnId);
    }
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));

    expect(getRow).toHaveBeenCalledTimes(1);
    expect(index.find(1, columns[0]!.columnId, -1)?.rowId).toBe("repeat-0");
  });

  it("charges still-missing late rows against every production slice", () => {
    const rowCount = 40;
    const columnCount = 40;
    const rowIds = Array.from({ length: rowCount }, (_unused, rowIndex) => `missing-${rowIndex}`);
    const rows = new Map<string, Row>(
      rowIds.map((id) => [id, { id, enabled: true, alternate: false }]),
    );
    const columns = compileColumns(
      Array.from({ length: columnCount }, (_unused, columnIndex) => ({
        columnId: `COL_ID_MISSING_${String(columnIndex)}`,
        field: "enabled" as const,
        headerName: `Missing ${String(columnIndex)}`,
        valueType: "boolean" as const,
        isEditable: ({ row }: { readonly row: Row }) => row.enabled,
      })),
    );
    const getRow = vi.fn((rowId: string) => rows.get(rowId));
    const index = new BrunoTableCellEditTraversalIndex(
      getRow,
      (_rowId, row) => (row as Row).enabled,
      true,
    );
    const projection = rowSpace(rowIds);
    index.reconcile(columns, projection);
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));

    index.reconcileRows(undefined);
    index.reconcile(columns, projection);
    index.buildNextSlice(
      rowCount * 2 * BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST,
      Number.POSITIVE_INFINITY,
    );
    rows.clear();
    index.reconcileRows(new Set(rowIds));
    getRow.mockClear();

    expect(index.buildNextSlice(80, Number.POSITIVE_INFINITY)).toBe(true);
    expect(getRow).toHaveBeenCalledTimes(2);
    expect(index.getCachedRowCount()).toBe(0);
    expect(index.isReady()).toBe(false);
    expect(index.find(0, columns[0]!.columnId, 1)).toBeUndefined();
    while (index.buildNextSlice(80, Number.POSITIVE_INFINITY));
    expect(index.getCachedRowCount()).toBe(0);
    expect(index.isReady()).toBe(true);
  });

  it.each([false, true])(
    "retains unchanged eligibility when new dirty identities match the old cache count (projection changes: %s)",
    (projectionChanges) => {
      const rows = new Map<string, Row>([
        ["first", { id: "first", enabled: true, alternate: false }],
        ["retained", { id: "retained", enabled: true, alternate: false }],
      ]);
      const evaluate = vi.fn((_rowId: string, row: object, column: CompiledFieldColumn) =>
        column.columnId === "COL_ID_ENABLED" ? (row as Row).enabled : (row as Row).alternate,
      );
      const columns = makeColumns();
      const index = new BrunoTableCellEditTraversalIndex((id) => rows.get(id), evaluate, true);
      const projection = rowSpace(
        projectionChanges ? ["first", "retained"] : ["first", "retained", "new"],
      );
      index.reconcile(columns, projection);
      while (index.buildNextSlice());
      evaluate.mockClear();
      rows.set("first", { id: "first", enabled: false, alternate: false });
      rows.set("new", { id: "new", enabled: false, alternate: false });
      index.reconcileRows(new Set(["first", "new"]));
      index.reconcile(
        columns,
        projectionChanges ? rowSpace(["first", "retained", "new"]) : projection,
      );
      while (index.buildNextSlice(2, Number.POSITIVE_INFINITY)) {
        expect(index.find(0, "COL_ID_ENABLED", 1)).toBeUndefined();
      }
      expect(evaluate).toHaveBeenCalledTimes(4);
      expect(index.getCachedRowCount()).toBe(3);
      expect(index.find(0, "COL_ID_ENABLED", 1)?.rowId).toBe("retained");
    },
  );

  it("evicts removed filtered rows and bounds caches across unknown source replacements", () => {
    const first: Row = { id: "first", enabled: true, alternate: false };
    const rows = new Map<string, Row>([
      [first.id, first],
      ["removed", { id: "removed", enabled: true, alternate: false }],
    ]);
    const evaluate = vi.fn((_rowId: string, row: object) => (row as Row).enabled);
    const columns = makeColumns();
    const index = new BrunoTableCellEditTraversalIndex((rowId) => rows.get(rowId), evaluate);

    index.reconcile(columns, rowSpace(["first", "removed"]));
    index.reconcile(columns, rowSpace(["first"]));
    evaluate.mockClear();
    rows.delete("removed");
    index.reconcileRows(undefined);
    index.reconcile(columns, rowSpace(["first"]));
    expect(index.getCachedRowCount()).toBe(1);
    expect(evaluate).not.toHaveBeenCalled();

    for (let replacement = 0; replacement < 20; replacement += 1) {
      const rowId = `replacement-${String(replacement)}`;
      rows.set(rowId, { id: rowId, enabled: false, alternate: false });
      index.reconcileRows(undefined);
      index.reconcile(columns, rowSpace(["first", rowId]));
      expect(index.getCachedRowCount()).toBe(2);
      rows.delete(rowId);
      index.reconcileRows(undefined);
      index.reconcile(columns, rowSpace(["first"]));
      expect(index.getCachedRowCount()).toBe(1);
    }
    expect(evaluate).toHaveBeenCalledTimes(40);
  });
});
