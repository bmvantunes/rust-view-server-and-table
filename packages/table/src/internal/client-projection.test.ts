import { describe, expect, it, vi } from "vitest";

import { compileColumns, type CompiledColumn } from "./compile-columns";
import {
  BRUNO_TABLE_ROWS_COLUMN_ID,
  type BrunoTableClientGroupedProjection,
  type BrunoTableClientGroupedRow,
} from "./client-grouping";
import {
  BrunoTableGroupedPresentationCompiler,
  compileBrunoTableGroupRowsColumn,
  createBrunoTableGroupedColumns,
} from "./client-grouping-presentation";
import {
  BrunoTableClientProjectionCoordinator,
  createBrunoTableGroupedProjectionCandidate,
  createBrunoTableInvalidProjectionCandidate,
  createBrunoTableRawProjectionCandidate,
  type BrunoTableClientProjectionCandidate,
} from "./client-projection";
import {
  BrunoTableGridRuntime,
  type BrunoTableInstalledClientProjectionSnapshot,
  type BrunoTableRowPipelinePublication,
  type BrunoTableRowPipelineRuntimeView,
} from "./grid-runtime";

const columns = compileColumns([
  {
    columnId: "COL_ID_DESK",
    field: "desk",
    headerName: "Desk",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_REGION",
    field: "region",
    headerName: "Region",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
    valueType: "bigint",
    aggFunc: "sum",
  },
]);

describe("grouped presentation compilation", () => {
  it("preserves Missing and Present nullish evidence in Rows callbacks", () => {
    const callback = vi.fn(
      (_input: Readonly<{ readonly groupKeys: readonly Readonly<Record<string, unknown>>[] }>) =>
        "Rows",
    );
    const presentationColumns = compileColumns([
      {
        columnId: "COL_ID_OPTIONAL",
        field: "optional",
        headerName: "Optional",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const groupedColumns = createBrunoTableGroupedColumns({
      columns: presentationColumns,
      visibleColumnIds: ["COL_ID_OPTIONAL"],
      groupBy: ["COL_ID_OPTIONAL"],
      rowsColumn: compileBrunoTableGroupRowsColumn({ valueFormatter: callback }),
    });
    const rowsColumn = groupedColumns.find(
      ({ columnId }) => columnId === BRUNO_TABLE_ROWS_COLUMN_ID,
    );
    const format = (presence: BrunoTableClientGroupedRow["groupKeys"][number]) =>
      Reflect.apply(rowsColumn?.valueFormatter as (...parameters: never[]) => unknown, undefined, [
        {
          row: {
            rowId: "group",
            rowCount: 1n,
            groupKeys: Object.freeze([presence]),
            values: new Map(),
            presences: new Map(),
          } satisfies BrunoTableClientGroupedRow,
          value: 1n,
        },
      ]);

    format(Object.freeze({ _tag: "Missing" as const }));
    format(Object.freeze({ _tag: "Present" as const, value: undefined }));
    format(Object.freeze({ _tag: "Present" as const, value: null }));

    expect(callback.mock.calls.map(([input]) => input.groupKeys[0])).toStrictEqual([
      { columnId: "COL_ID_OPTIONAL", field: "optional", _tag: "Missing" },
      {
        columnId: "COL_ID_OPTIONAL",
        field: "optional",
        _tag: "Present",
        value: undefined,
      },
      { columnId: "COL_ID_OPTIONAL", field: "optional", _tag: "Present", value: null },
    ]);
  });

  it("reuses one table-scoped compiled presentation plan for value-only publications", () => {
    const compiler = new BrunoTableGroupedPresentationCompiler();
    const rowsColumn = compileBrunoTableGroupRowsColumn(undefined);
    const input = {
      columns,
      visibleColumnIds: columns.map(({ columnId }) => columnId),
      groupBy: ["COL_ID_DESK"],
      rowsColumn,
      persistedRowsWidth: 137,
    } as const;

    const first = compiler.compile(input);
    const second = compiler.compile({
      ...input,
      visibleColumnIds: Array.from(input.visibleColumnIds),
      groupBy: Array.from(input.groupBy),
    });

    expect(second).toBe(first);
    expect(second.every((column, index) => column === first[index])).toBe(true);
  });

  it("orders participating aggregates by durable visible Column order", () => {
    const presentationColumns = compileColumns([
      ...columns,
      {
        columnId: "COL_ID_SECOND_AGGREGATE",
        field: "second",
        headerName: "Second aggregate",
        valueType: "bigint",
        aggFunc: "sum",
      },
    ]);

    const groupedColumns = createBrunoTableGroupedColumns({
      columns: presentationColumns,
      visibleColumnIds: [
        "COL_ID_DESK",
        "COL_ID_SECOND_AGGREGATE",
        "COL_ID_QUANTITY",
        "COL_ID_REGION",
      ],
      groupBy: ["COL_ID_DESK"],
      rowsColumn: compileBrunoTableGroupRowsColumn(undefined),
    });

    expect(groupedColumns.map(({ columnId }) => columnId)).toEqual([
      "COL_ID_DESK",
      BRUNO_TABLE_ROWS_COLUMN_ID,
      "COL_ID_SECOND_AGGREGATE",
      "COL_ID_QUANTITY",
    ]);
  });

  it("reuses exact result semantics across equivalent projection candidates", () => {
    const presentationColumns = compileColumns([
      {
        columnId: "COL_ID_KEY",
        field: "desk",
        headerName: "Key",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_DISTINCT",
        field: "region",
        headerName: "Distinct",
        valueType: "text",
        aggFunc: "countDistinct",
        width: 211,
      },
      {
        columnId: "COL_ID_DISTINCT_SECOND",
        field: "region",
        headerName: "Distinct second",
        valueType: "text",
        aggFunc: "countDistinct",
        width: 177,
      },
    ]);
    const input = {
      columns: presentationColumns,
      visibleColumnIds: presentationColumns.map(({ columnId }) => columnId),
      groupBy: ["COL_ID_KEY"],
      rowsColumn: compileBrunoTableGroupRowsColumn(undefined),
      persistedRowsWidth: 137,
    } as const;
    const compiler = new BrunoTableGroupedPresentationCompiler();
    const first = compiler.compile(input);
    const second = compiler.compile(input);
    const firstDistinctSemantics = first.find(
      ({ columnId }) => columnId === "COL_ID_DISTINCT",
    )?.semantics;
    const hiddenSecond = compiler.compile({
      ...input,
      visibleColumnIds: input.visibleColumnIds.filter(
        (columnId) => columnId !== "COL_ID_DISTINCT_SECOND",
      ),
    });
    const shownAgain = compiler.compile(input);

    expect(firstDistinctSemantics).toBe(
      second.find(({ columnId }) => columnId === "COL_ID_DISTINCT")?.semantics,
    );
    expect(firstDistinctSemantics).toBe(
      hiddenSecond.find(({ columnId }) => columnId === "COL_ID_DISTINCT")?.semantics,
    );
    expect(firstDistinctSemantics).toBe(
      shownAgain.find(({ columnId }) => columnId === "COL_ID_DISTINCT")?.semantics,
    );
    expect(firstDistinctSemantics?.width).toBe(211);
    expect(
      shownAgain.find(({ columnId }) => columnId === "COL_ID_DISTINCT_SECOND")?.semantics.width,
    ).toBe(177);
    expect(first.find(({ columnId }) => columnId === BRUNO_TABLE_ROWS_COLUMN_ID)?.semantics).toBe(
      second.find(({ columnId }) => columnId === BRUNO_TABLE_ROWS_COLUMN_ID)?.semantics,
    );
  });
});

describe("BrunoTableClientProjectionCoordinator", () => {
  it("retains grouped recovery evidence only until the final raw ungroup commits", () => {
    const initial = rawCandidate(0, ["raw-a"]);
    const coordinator = new BrunoTableClientProjectionCoordinator(initial);
    coordinator.commit(initial, () => undefined);
    const grouped = groupedCandidate(1, ["COL_ID_DESK"], [groupedRow("group-a", 1n)]);

    expect(coordinator.commit(grouped, () => undefined)).toBe(true);
    const groupedEvidence = coordinator.getPreviousGroupedProjection();
    expect(groupedEvidence).toMatchObject({
      kind: "ready",
      groupBy: ["COL_ID_DESK"],
      rowIds: ["group-a"],
    });
    expect(groupedEvidence?.rows).toBe(
      grouped.kind === "grouped" ? grouped.groupedRows : undefined,
    );

    expect(coordinator.commit(invalidCandidate(2, ["COL_ID_DESK"]), () => undefined)).toBe(true);
    expect(coordinator.getPreviousGroupedProjection()).toBe(groupedEvidence);

    const raw = rawCandidate(3, ["raw-a"]);
    expect(() =>
      coordinator.commit(raw, () => {
        throw new Error("raw install listener failed");
      }),
    ).toThrow("raw install listener failed");
    expect(coordinator.getSnapshot().kind).toBe("raw");
    expect(coordinator.getPreviousGroupedProjection()).toBeUndefined();

    const regrouped = groupedCandidate(4, ["COL_ID_DESK"], [groupedRow("group-b", 2n)]);
    expect(coordinator.getPreviousGroupedProjection()).toBeUndefined();
    expect(coordinator.commit(regrouped, () => undefined)).toBe(true);
    const freshEvidence = coordinator.getPreviousGroupedProjection();
    expect(freshEvidence).not.toBe(groupedEvidence);
    expect(freshEvidence?.rowIds).toEqual(["group-b"]);
  });

  it("publishes one installed grouping structure epoch and ignores value or order-only rows", () => {
    const initial = rawCandidate(0, ["raw-a"]);
    const runtime = createRuntime(initial.publication);
    const view = runtime.getView();
    const coordinator = new BrunoTableClientProjectionCoordinator(initial);
    const listener = vi.fn();
    view.subscribeInstalledGroupingStructure(listener);
    expect(view.getInstalledGroupingStructureSnapshot()).toEqual({
      layoutKey: JSON.stringify(["raw", []]),
      presentationKey: JSON.stringify(["raw", []]),
      groupBy: [],
      columns: undefined,
    });
    const deferred = groupedCandidate(
      1,
      ["COL_ID_DESK"],
      [groupedRow("group-a", 1n), groupedRow("group-b", 2n)],
    );

    expect(listener).not.toHaveBeenCalled();
    coordinator.commit(deferred, view.publishRowPipeline);
    expect(listener).toHaveBeenCalledOnce();
    expect(view.getInstalledGroupingStructureSnapshot()).toEqual({
      layoutKey: JSON.stringify(["grouped", ["COL_ID_DESK"]]),
      presentationKey: "grouped:1",
      groupBy: ["COL_ID_DESK"],
      columns: deferred.columns,
    });

    coordinator.commit(invalidCandidate(2, ["COL_ID_DESK"]), view.publishRowPipeline);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(view.getInstalledGroupingStructureSnapshot()).toEqual({
      layoutKey: JSON.stringify(["invalid", ["COL_ID_DESK"]]),
      presentationKey: "invalid:2",
      groupBy: ["COL_ID_DESK"],
      columns: columns,
    });
    coordinator.commit(deferred, view.publishRowPipeline);
    expect(listener).toHaveBeenCalledTimes(3);

    for (let value = 3n; value <= 22n; value += 1n) {
      const rows =
        value % 2n === 0n
          ? [groupedRow("group-a", value), groupedRow("group-b", 2n)]
          : [groupedRow("group-b", 2n), groupedRow("group-a", value)];
      coordinator.commit(
        groupedCandidate(1, ["COL_ID_DESK"], rows, new Set(["group-a"])),
        view.publishRowPipeline,
      );
    }
    expect(listener).toHaveBeenCalledTimes(3);

    coordinator.commit(rawCandidate(3, ["raw-a"]), view.publishRowPipeline);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(view.getInstalledGroupingStructureSnapshot()).toEqual({
      layoutKey: JSON.stringify(["raw", []]),
      presentationKey: JSON.stringify(["raw", []]),
      groupBy: [],
      columns: undefined,
    });
  });

  it("atomically installs one wholly coherent structural epoch per accepted transition", () => {
    const initial = rawCandidate(0, ["raw-a", "raw-b"]);
    const runtime = createRuntime(initial.publication);
    const view = runtime.getView();
    const coordinator = new BrunoTableClientProjectionCoordinator(initial);
    expect(coordinator.commit(initial, view.publishRowPipeline)).toBe(true);

    const records: ReturnType<typeof recordProjection>[] = [];
    view.subscribeInstalledClientProjection(() => {
      const snapshot = view.getInstalledClientProjectionSnapshot();
      if (snapshot !== undefined) records.push(recordProjection(snapshot, view));
    });
    const transitions = [
      groupedCandidate(1, ["COL_ID_DESK"], [groupedRow("group-desk", 1n)]),
      groupedCandidate(2, ["COL_ID_DESK", "COL_ID_REGION"], [groupedRow("group-desk-region", 2n)]),
      groupedCandidate(3, ["COL_ID_REGION", "COL_ID_DESK"], [groupedRow("group-region-desk", 3n)]),
      groupedCandidate(4, ["COL_ID_DESK"], [groupedRow("group-desk", 4n)]),
      rawCandidate(5, ["raw-b", "raw-a"]),
      invalidCandidate(6, ["COL_ID_DESK"]),
      groupedCandidate(7, ["COL_ID_DESK"], [groupedRow("group-recovered", 7n)]),
    ];

    for (const candidate of transitions) {
      expect(coordinator.commit(candidate, view.publishRowPipeline)).toBe(true);
    }

    expect(records).toHaveLength(transitions.length - 1);
    expect(records.map(({ epoch, kind, groupBy }) => ({ epoch, kind, groupBy }))).toEqual([
      { epoch: 0, kind: "grouped", groupBy: ["COL_ID_DESK"] },
      { epoch: 1, kind: "grouped", groupBy: ["COL_ID_DESK", "COL_ID_REGION"] },
      { epoch: 2, kind: "grouped", groupBy: ["COL_ID_REGION", "COL_ID_DESK"] },
      { epoch: 3, kind: "grouped", groupBy: ["COL_ID_DESK"] },
      { epoch: 0, kind: "invalid", groupBy: ["COL_ID_DESK"] },
      { epoch: 1, kind: "grouped", groupBy: ["COL_ID_DESK"] },
    ]);
    expect(records.map(({ columnIds }) => columnIds)).toEqual([
      ["COL_ID_DESK", BRUNO_TABLE_ROWS_COLUMN_ID, "COL_ID_QUANTITY"],
      ["COL_ID_DESK", "COL_ID_REGION", BRUNO_TABLE_ROWS_COLUMN_ID, "COL_ID_QUANTITY"],
      ["COL_ID_REGION", "COL_ID_DESK", BRUNO_TABLE_ROWS_COLUMN_ID, "COL_ID_QUANTITY"],
      ["COL_ID_DESK", BRUNO_TABLE_ROWS_COLUMN_ID, "COL_ID_QUANTITY"],
      ["COL_ID_DESK", "COL_ID_REGION", "COL_ID_QUANTITY"],
      ["COL_ID_DESK", BRUNO_TABLE_ROWS_COLUMN_ID, "COL_ID_QUANTITY"],
    ]);
    for (const record of records) expect(record.rowIds).toEqual(record.authorityRowIds);
  });

  it("keeps the stable runtime and fine cell subscriptions for value-only publications", () => {
    const initial = groupedCandidate(
      1,
      ["COL_ID_DESK"],
      [groupedRow("group-a", 1n), groupedRow("group-b", 2n)],
    );
    const runtime = createRuntime(publication([]));
    const view = runtime.getView();
    const coordinator = new BrunoTableClientProjectionCoordinator(initial);
    coordinator.commit(initial, view.publishRowPipeline);
    const installed = view.getInstalledClientProjectionSnapshot();
    expect(installed).toBeDefined();
    expect(installed?.kind).toBe("grouped");
    const structuralListener = vi.fn();
    const changedRowListener = vi.fn();
    const unchangedRowListener = vi.fn();
    const changedCellListener = vi.fn();
    const unchangedCellListener = vi.fn();
    view.subscribeInstalledClientProjection(structuralListener);
    view.subscribeRow("group-a", changedRowListener);
    view.subscribeRow("group-b", unchangedRowListener);
    view.subscribeCell("group-a", "COL_ID_QUANTITY", changedCellListener);
    view.subscribeCell("group-b", "COL_ID_QUANTITY", unchangedCellListener);

    for (let value = 2n; value <= 21n; value += 1n) {
      coordinator.commit(
        groupedCandidate(
          1,
          ["COL_ID_DESK"],
          [groupedRow("group-a", value), groupedRow("group-b", 2n)],
          new Set(["group-a"]),
        ),
        view.publishRowPipeline,
      );
    }

    expect(runtime.getView()).toBe(view);
    expect(view.getInstalledClientProjectionSnapshot()).toBe(installed);
    expect(structuralListener).not.toHaveBeenCalled();
    expect(changedRowListener).toHaveBeenCalledTimes(20);
    expect(unchangedRowListener).not.toHaveBeenCalled();
    expect(changedCellListener).toHaveBeenCalledTimes(20);
    expect(unchangedCellListener).not.toHaveBeenCalled();
    expect(view.getCellSnapshot("group-a", "COL_ID_QUANTITY")).toMatchObject({
      kind: "available",
      value: 21n,
    });
  });

  it("invalidates fine subscribers when presentation semantics change without a layout change", () => {
    const initial = groupedCandidate(
      1,
      ["COL_ID_DESK"],
      [groupedRow("group-a", 5n)],
      undefined,
      columns,
      "sum-presentation",
    );
    const runtime = createRuntime(publication([]));
    const view = runtime.getView();
    const coordinator = new BrunoTableClientProjectionCoordinator(initial);
    coordinator.commit(initial, view.publishRowPipeline);
    const cellListener = vi.fn();
    const rowCellListener = vi.fn();
    view.subscribeCell("group-a", "COL_ID_QUANTITY", cellListener);
    view.subscribeRowCell("group-a", "COL_ID_QUANTITY", rowCellListener);
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_REGION",
        field: "region",
        headerName: "Region",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        headerName: "Maximum quantity",
        valueType: "bigint",
        aggFunc: "max",
      },
    ]);

    coordinator.commit(
      groupedCandidate(
        1,
        ["COL_ID_DESK"],
        [groupedRow("group-a", 5n)],
        new Set(),
        replacementColumns,
        "max-presentation",
      ),
      (candidatePublication) =>
        view.reconcileClientProjection(
          candidatePublication,
          replacementColumns,
          {
            baselineFilters: [],
            baselineOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
          },
          96,
        ),
    );

    expect(view.getInstalledClientProjectionSnapshot()?.presentationKey).toBe("max-presentation");
    expect(view.getCellSnapshot("group-a", "COL_ID_QUANTITY").column?.headerName).toBe(
      "Maximum quantity",
    );
    expect(cellListener).toHaveBeenCalledOnce();
    expect(rowCellListener).toHaveBeenCalledOnce();
    expect(view.getCellSnapshot("group-a", "COL_ID_QUANTITY").column?.headerName).toBe(
      "Maximum quantity",
    );
  });

  it("keeps the old epoch visible until commit and does not roll back on listener failure", () => {
    const initial = rawCandidate(0, ["raw-a"]);
    const runtime = createRuntime(initial.publication);
    const view = runtime.getView();
    const coordinator = new BrunoTableClientProjectionCoordinator(initial);
    coordinator.commit(initial, view.publishRowPipeline);
    const deferred = groupedCandidate(1, ["COL_ID_DESK"], [groupedRow("group-a", 1n)]);
    expect(view.getInstalledClientProjectionSnapshot()).toBeUndefined();
    expect(view.getRowSpaceSnapshot()?.getRowId(0)).toBe("raw-a");

    const laterListener = vi.fn();
    view.subscribeInstalledClientProjection(() => {
      throw new Error("listener failed");
    });
    view.subscribeInstalledClientProjection(laterListener);
    expect(() => coordinator.commit(deferred, view.publishRowPipeline)).toThrow("listener failed");
    expect(view.getInstalledClientProjectionSnapshot()).toMatchObject({
      epoch: 0,
      kind: "grouped",
      rowIds: ["group-a"],
    });
    expect(view.getRowSpaceSnapshot()?.getRowId(0)).toBe("group-a");
    expect(view.getCellSnapshot("group-a", "COL_ID_QUANTITY").column?.columnId).toBe(
      "COL_ID_QUANTITY",
    );
    expect(laterListener).toHaveBeenCalledOnce();
  });

  it("stages active-key removal without publishing and installs configuration plus raw authority once", () => {
    const runtime = createRuntime(publication(["raw-a"]));
    const view = runtime.getView();
    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_DESK" });
    const grouped = groupedCandidate(1, ["COL_ID_DESK"], [groupedRow("group-a", 1n)]);
    const coordinator = new BrunoTableClientProjectionCoordinator(grouped);
    coordinator.commit(grouped, (candidatePublication) =>
      view.reconcileClientProjection(
        candidatePublication,
        columns,
        {
          baselineFilters: [],
          baselineOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
        },
        96,
      ),
    );
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
      },
      columns[1],
      columns[2],
    ]);
    const queryListener = vi.fn();
    const projectionListener = vi.fn();
    view.subscribeQuery(queryListener);
    view.subscribeInstalledClientProjection(projectionListener);

    const staged = view.stageClientProjectionConfiguration(
      replacementColumns,
      {
        baselineFilters: [],
        baselineOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      },
      96,
    );
    expect(staged.query).toMatchObject({
      columns: replacementColumns,
      groupBy: [],
      navigationMode: "projection-reset",
    });
    expect(view.getQuerySnapshot().groupBy).toEqual(["COL_ID_DESK"]);
    expect(queryListener).not.toHaveBeenCalled();
    expect(projectionListener).not.toHaveBeenCalled();

    const raw = createBrunoTableRawProjectionCandidate({
      columns: replacementColumns,
      rowIds: ["raw-a"],
      publication: publication(["raw-a"]),
      queryGeneration: staged.query.generation,
      queryNavigationMode: staged.query.navigationMode,
    });
    const rawCoordinator = new BrunoTableClientProjectionCoordinator(raw);
    rawCoordinator.commit(raw, (candidatePublication) =>
      view.reconcileClientProjection(
        candidatePublication,
        replacementColumns,
        {
          baselineFilters: [],
          baselineOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
        },
        96,
      ),
    );

    expect(queryListener).toHaveBeenCalledOnce();
    expect(projectionListener).toHaveBeenCalledOnce();
    expect(view.getInstalledClientProjectionSnapshot()).toBeUndefined();
    expect(view.getQuerySnapshot().groupBy).toEqual([]);
    expect(view.getRowSpaceSnapshot()?.getRowId(0)).toBe("raw-a");
  });
});

function createRuntime(publication: BrunoTableRowPipelinePublication<unknown>) {
  return new BrunoTableGridRuntime(
    publication,
    columns,
    {
      baselineFilters: [],
      baselineOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
    },
    "TABLE_ID_CLIENT_PROJECTION",
    { grouping: true },
  );
}

function rawCandidate(
  generation: number,
  rowIds: readonly string[],
): BrunoTableClientProjectionCandidate {
  return createBrunoTableRawProjectionCandidate({
    columns,
    rowIds,
    publication: publication(rowIds),
    queryGeneration: generation,
    queryNavigationMode: generation === 0 ? "reconcile" : "projection-reset",
  });
}

function groupedCandidate(
  generation: number,
  groupBy: readonly string[],
  rows: readonly BrunoTableClientGroupedRow[],
  changedRowIds?: ReadonlySet<string>,
  sourceColumns: readonly CompiledColumn[] = columns,
  presentationKey?: string,
): BrunoTableClientProjectionCandidate {
  const rowIds = Object.freeze(rows.map(({ rowId }) => rowId));
  const projection: Extract<BrunoTableClientGroupedProjection, { readonly kind: "ready" }> =
    Object.freeze({
      kind: "ready",
      groupBy: Object.freeze(Array.from(groupBy)),
      rows: Object.freeze(Array.from(rows)),
      rowIds,
    });
  const groupedColumns = createBrunoTableGroupedColumns({
    columns: sourceColumns,
    visibleColumnIds: sourceColumns.map(({ columnId }) => columnId),
    groupBy,
    rowsColumn: compileBrunoTableGroupRowsColumn(undefined),
  });
  return createBrunoTableGroupedProjectionCandidate({
    projection,
    columns: groupedColumns,
    ...(presentationKey === undefined ? {} : { presentationKey }),
    publication: publication(rowIds, rows, changedRowIds),
    queryGeneration: generation,
    queryNavigationMode: "projection-reset",
  });
}

function invalidCandidate(
  generation: number,
  groupBy: readonly string[],
): BrunoTableClientProjectionCandidate {
  return createBrunoTableInvalidProjectionCandidate({
    groupBy,
    columns,
    publication: publication([]),
    queryGeneration: generation,
    queryNavigationMode: "clear",
    invalid: Object.freeze({
      kind: "invalid-value",
      rowIndex: 0,
      columnId: "COL_ID_QUANTITY",
      message: "Invalid aggregate result.",
    }),
  });
}

function groupedRow(rowId: string, quantity: bigint): BrunoTableClientGroupedRow {
  return Object.freeze({
    rowId,
    rowCount: 1n,
    groupKeys: Object.freeze([{ _tag: "Present" as const, value: rowId }]),
    values: new Map<string, unknown>([
      ["COL_ID_DESK", rowId],
      [BRUNO_TABLE_ROWS_COLUMN_ID, 1n],
      ["COL_ID_QUANTITY", quantity],
    ]),
    presences: new Map(),
  });
}

function publication(
  rowIds: readonly string[],
  rows: readonly BrunoTableClientGroupedRow[] = [],
  changedRowIds?: ReadonlySet<string>,
): BrunoTableRowPipelinePublication<unknown> {
  const rowsById = new Map(rows.map((row) => [row.rowId, row]));
  return Object.freeze({
    status: "ready",
    totalRows: rowIds.length,
    version: 1,
    hasCoherentRows: true,
    ...(changedRowIds === undefined ? {} : { changedRowIds }),
    rowSpace: Object.freeze({
      totalRows: rowIds.length,
      loadedRows: rowIds.length,
      getRowId: (index: number) => rowIds[index],
      getRow: (rowId: string) => rowsById.get(rowId),
      getCellValue: (rowId: string, columnId: string) => rowsById.get(rowId)?.values.get(columnId),
    }),
  });
}

function recordProjection(
  snapshot: BrunoTableInstalledClientProjectionSnapshot,
  runtime: BrunoTableRowPipelineRuntimeView,
) {
  const authority = runtime.getRowSpaceSnapshot();
  return Object.freeze({
    epoch: snapshot.epoch,
    kind: snapshot.kind,
    groupBy: Array.from(snapshot.groupBy),
    columnIds: snapshot.columns.map(({ columnId }) => columnId),
    rowIds: Array.from(snapshot.rowIds),
    authorityRowIds: Array.from({ length: authority?.totalRows ?? 0 }, (_, index) =>
      authority?.getRowId(index),
    ),
  });
}
