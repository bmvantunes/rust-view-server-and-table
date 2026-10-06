import { describe } from "vite-plus/test";
import { bench } from "../../scripts/benchmark-adapter";

import { compileColumns, type CompiledFieldColumn } from "./compile-columns";
import {
  BRUNO_TABLE_CELL_EDIT_TRAVERSAL_SLICE_PREDICATE_CELL_LIMIT,
  BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST,
  BrunoTableCellEditTraversalIndex,
} from "./cell-edit-traversal";

const referenceFrameBudgetMs = 8.33;
const rowCount = 5_000;
const columnCount = 150;
type Row = Readonly<{ readonly id: string; readonly editable: boolean }>;
const rows = Array.from(
  { length: rowCount },
  (_unused, rowIndex): Row => ({
    id: `row-${String(rowIndex)}`,
    editable: rowIndex === 0 || rowIndex === rowCount - 1,
  }),
);
const rowsById = new Map(rows.map((row) => [row.id, row]));
const stablePredicate = ({ row }: { readonly row: Row }) => row.editable;
const changedPredicate = ({ row }: { readonly row: Row }) => !row.editable;
const compilePredicateColumns = (firstPredicate = stablePredicate) =>
  compileColumns(
    Array.from({ length: columnCount }, (_unused, columnIndex) => ({
      columnId: `COL_ID_EDIT_${String(columnIndex).padStart(3, "0")}`,
      field: "editable" as const,
      headerName: `Editable ${String(columnIndex)}`,
      valueType: "boolean" as const,
      isEditable: columnIndex === 0 ? firstPredicate : stablePredicate,
    })),
  );
const columns = compilePredicateColumns();
const equivalentColumns = compilePredicateColumns();
const equivalentRecompileColumns = Array.from({ length: 100 }, () => compilePredicateColumns());
const changedAuthorityColumns = compilePredicateColumns(changedPredicate);
const allChangedAuthorityColumns = compileColumns(
  Array.from({ length: columnCount }, (_unused, columnIndex) => ({
    columnId: `COL_ID_EDIT_${String(columnIndex).padStart(3, "0")}`,
    field: "editable" as const,
    headerName: `Editable ${String(columnIndex)}`,
    valueType: "boolean" as const,
    isEditable: changedPredicate,
  })),
);
const rowSpace = Object.freeze({
  totalRows: rowCount,
  getRowId: (rowIndex: number) => rows[rowIndex]?.id,
});
function createIndex(onPredicateEvaluation?: () => void, incrementalBuild = false) {
  const created = new BrunoTableCellEditTraversalIndex(
    (rowId) => rowsById.get(rowId),
    (_rowId: string, row: object, _column: CompiledFieldColumn) => {
      onPredicateEvaluation?.();
      return (row as Row).editable;
    },
    incrementalBuild,
  );
  created.reconcile(columns, rowSpace);
  while (created.buildNextSlice());
  return created;
}
const traversalIndex = createIndex();
let reconciliationPredicateEvaluations = 0;
const reconciliationIndex = createIndex(() => {
  reconciliationPredicateEvaluations += 1;
}, true);
reconciliationPredicateEvaluations = 0;
let authorityPredicateEvaluations = 0;
const authorityIndex = createIndex(() => {
  authorityPredicateEvaluations += 1;
}, true);
authorityPredicateEvaluations = 0;
let allAuthorityPredicateEvaluations = 0;
const allAuthorityIndex = createIndex(() => {
  allAuthorityPredicateEvaluations += 1;
}, true);
allAuthorityPredicateEvaluations = 0;
let equivalentAuthorityPredicateEvaluations = 0;
const equivalentAuthorityIndex = createIndex(() => {
  equivalentAuthorityPredicateEvaluations += 1;
}, true);
equivalentAuthorityPredicateEvaluations = 0;
const rangeIndex = createIndex();
const forwardRowIds = rows.map((row) => row.id);
const reverseRowIds = forwardRowIds.toReversed();
const forwardRowSpace = Object.freeze({
  totalRows: rowCount,
  getRowId: (rowIndex: number) => forwardRowIds[rowIndex],
});
const reverseRowSpace = Object.freeze({
  totalRows: rowCount,
  getRowId: (rowIndex: number) => reverseRowIds[rowIndex],
});
const verticalRange = Object.freeze({
  axis: "vertical" as const,
  columnId: columns[0]!.columnId,
  rowIds: Object.freeze(forwardRowIds),
});
const horizontalRange = Object.freeze({
  axis: "horizontal" as const,
  rowId: rows.at(-1)!.id,
  columnIds: Object.freeze(columns.map((column) => column.columnId)),
});
const staticColumns = compileColumns([
  {
    columnId: "COL_ID_STATIC_EDIT",
    field: "id" as const,
    headerName: "Static edit",
    valueType: "text" as const,
    isEditable: true,
  },
]);
const staticRowCount = 100_000;
const staticRowSpace = Object.freeze({
  totalRows: staticRowCount,
  getRowId: (rowIndex: number) =>
    rowIndex < staticRowCount ? `static-row-${String(rowIndex)}` : undefined,
});
const largeAuthorityRows = Array.from(
  { length: staticRowCount },
  (_unused, rowIndex): Row => ({
    id: `authority-row-${String(rowIndex)}`,
    editable: rowIndex === staticRowCount - 1,
  }),
);
const largeAuthorityRowsById = new Map(largeAuthorityRows.map((row) => [row.id, row]));
const largeAuthorityRowSpace = Object.freeze({
  totalRows: largeAuthorityRows.length,
  getRowId: (rowIndex: number) => largeAuthorityRows[rowIndex]?.id,
});
const largeEnabledAuthorityColumns = compileColumns([
  {
    columnId: "COL_ID_LARGE_AUTHORITY",
    field: "editable" as const,
    headerName: "Large authority",
    valueType: "boolean" as const,
    isEditable: stablePredicate,
  },
]);
const largeDisabledAuthorityColumns = compileColumns([
  {
    columnId: "COL_ID_LARGE_AUTHORITY",
    field: "editable" as const,
    headerName: "Large authority",
    valueType: "boolean" as const,
    isEditable: changedPredicate,
  },
]);
let largeAuthorityPredicateEvaluations = 0;
const largeAuthorityIndex = new BrunoTableCellEditTraversalIndex(
  (rowId) => largeAuthorityRowsById.get(rowId),
  (_rowId, row, column) => {
    largeAuthorityPredicateEvaluations += 1;
    if (typeof column.isEditable !== "function") {
      throw new Error("Large authority benchmark lost its predicate column.");
    }
    const editable = column.isEditable as unknown as (context: {
      readonly row: Row;
      readonly value: boolean;
    }) => boolean;
    return editable({ row: row as Row, value: (row as Row).editable });
  },
  true,
);
largeAuthorityIndex.reconcile(largeEnabledAuthorityColumns, largeAuthorityRowSpace);
while (largeAuthorityIndex.buildNextSlice());
largeAuthorityPredicateEvaluations = 0;
let largeAuthorityEnabled = true;

function percentile99(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] ?? 0;
}

function assertBudgetSamples(name: string, samples: readonly number[], expected?: number): number {
  if (samples.length === 0 || (expected !== undefined && samples.length !== expected)) {
    throw new Error(`${name} produced ${String(samples.length)} samples.`);
  }
  const p99Ms = percentile99(samples);
  if (p99Ms > referenceFrameBudgetMs) {
    throw new Error(`${name} exceeded the frame reference with p99 ${String(p99Ms)} ms.`);
  }
  return p99Ms;
}

const assertedBudgetSeries = new WeakSet<number[]>();

function recordBudgetSample(name: string, samples: number[], elapsedMs: number): void {
  samples.push(elapsedMs);
  if (samples.length < 100 || assertedBudgetSeries.has(samples)) return;
  assertBudgetSamples(name, samples);
  assertedBudgetSeries.add(samples);
}

describe("BrunoTable editable traversal index benchmark (8.33 ms/120 Hz reference)", () => {
  const samples: number[] = [];
  const reconciliationSamples: number[] = [];
  const projectionSliceSamples: number[] = [];
  const rangeSamples: number[] = [];
  const horizontalRangeSamples: number[] = [];
  const equivalentAuthoritySamples: number[] = [];
  const changedAuthoritySamples: number[] = [];
  const changedAuthoritySliceSamples: number[] = [];
  const allAuthorityStagingSamples: number[] = [];
  const allAuthoritySliceSamples: number[] = [];
  bench(
    "proves the exact 750,000-cell initial index is partitioned into bounded production slices",
    () => {
      let predicateEvaluations = 0;
      const index = new BrunoTableCellEditTraversalIndex(
        (rowId) => rowsById.get(rowId),
        () => {
          predicateEvaluations += 1;
          return true;
        },
        true,
      );
      index.reconcile(columns, rowSpace);
      const sliceSamples: number[] = [];
      while (!index.isReady()) {
        const startedAt = performance.now();
        index.buildNextSlice();
        sliceSamples.push(performance.now() - startedAt);
      }
      const p99Ms = assertBudgetSamples("initial predicate-index slice", sliceSamples);
      if (predicateEvaluations !== rowCount * columnCount) {
        throw new Error("Incremental predicate-index construction did not finish exactly.");
      }
      console.log(
        JSON.stringify({
          benchmark: "BrunoTable incremental predicate-index production slices",
          predicateEvaluations,
          sliceCount: sliceSamples.length,
          p99Ms,
          referenceFrameBudgetMs,
        }),
      );
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "paces 100,000-row identity projection and skips equivalent column rescans",
    () => {
      const rowIds = Array.from(
        { length: staticRowCount },
        (_unused, rowIndex) => `paced-row-${String(rowIndex)}`,
      );
      let rowIdReads = 0;
      const initialRowSpace = Object.freeze({
        totalRows: staticRowCount,
        getRowId: (rowIndex: number) => {
          rowIdReads += 1;
          return rowIds[rowIndex];
        },
      });
      const index = new BrunoTableCellEditTraversalIndex(
        () => {
          throw new Error("Static identity projection read row contents.");
        },
        () => {
          throw new Error("Static identity projection evaluated a predicate.");
        },
        true,
      );
      const stagingSamples: number[] = [];
      let startedAt = performance.now();
      index.reconcile(staticColumns, initialRowSpace);
      stagingSamples.push(performance.now() - startedAt);
      if (rowIdReads !== 0 || index.isReady()) {
        throw new Error("Initial identity projection performed synchronous discovery.");
      }
      const sliceSamples: number[] = [];
      while (!index.isReady()) {
        startedAt = performance.now();
        index.buildNextSlice();
        sliceSamples.push(performance.now() - startedAt);
      }
      if (Number(rowIdReads) !== staticRowCount) {
        throw new Error("Initial identity projection did not visit every row exactly once.");
      }

      rowIdReads = 0;
      startedAt = performance.now();
      const equivalentPending = index.reconcile(
        compileColumns([
          {
            columnId: "COL_ID_STATIC_EDIT",
            field: "id" as const,
            headerName: "Static edit",
            valueType: "text" as const,
            isEditable: true,
          },
        ]),
        initialRowSpace,
      );
      stagingSamples.push(performance.now() - startedAt);
      if (equivalentPending || rowIdReads !== 0) {
        throw new Error("Equivalent columns rescanned the stable row-space projection.");
      }

      const reversedRowIds = rowIds.toReversed();
      let remapReads = 0;
      const remappedRowSpace = Object.freeze({
        totalRows: staticRowCount,
        getRowId: (rowIndex: number) => {
          remapReads += 1;
          return reversedRowIds[rowIndex];
        },
      });
      startedAt = performance.now();
      index.reconcile(staticColumns, remappedRowSpace);
      stagingSamples.push(performance.now() - startedAt);
      if (remapReads !== 0 || index.isReady()) {
        throw new Error("Remapped identity projection performed synchronous discovery.");
      }
      while (!index.isReady()) {
        startedAt = performance.now();
        index.buildNextSlice();
        sliceSamples.push(performance.now() - startedAt);
      }
      if (
        Number(remapReads) !== staticRowCount ||
        index.findFromRowBoundary(1, -1)?.rowId !== reversedRowIds[0]
      ) {
        throw new Error("Remapped identity projection did not install exact latest evidence.");
      }
      const stagingP99Ms = assertBudgetSamples("identity-projection staging", stagingSamples);
      const p99Ms = assertBudgetSamples("identity-projection slice", sliceSamples);
      console.log(
        JSON.stringify({
          benchmark: "BrunoTable paced row-space identity projection",
          rowIdReads: staticRowCount + remapReads,
          stagingP99Ms,
          sliceCount: sliceSamples.length,
          p99Ms,
          referenceFrameBudgetMs,
        }),
      );
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "stages one steady-state predicate-row invalidation independently of row count",
    () => {
      const isolatedRows = Array.from(
        { length: staticRowCount },
        (_unused, rowIndex): Row => ({
          id: `isolated-row-${String(rowIndex)}`,
          editable: true,
        }),
      );
      const isolatedRowsById = new Map(isolatedRows.map((row) => [row.id, row]));
      const isolatedRowSpace = Object.freeze({
        totalRows: isolatedRows.length,
        getRowId: (rowIndex: number) => isolatedRows[rowIndex]?.id,
      });
      const isolatedColumns = compileColumns([
        {
          columnId: "COL_ID_ISOLATED_EDIT",
          field: "editable" as const,
          headerName: "Isolated edit",
          valueType: "boolean" as const,
          isEditable: stablePredicate,
        },
      ]);
      let predicateEvaluations = 0;
      const index = new BrunoTableCellEditTraversalIndex(
        (rowId) => isolatedRowsById.get(rowId),
        (_rowId, row) => {
          predicateEvaluations += 1;
          return (row as Row).editable;
        },
        true,
      );
      index.reconcile(isolatedColumns, isolatedRowSpace);
      while (index.buildNextSlice());
      const stagingSamples: number[] = [];
      const sliceSamples: number[] = [];
      const stageAndDrain = (rowId: string, expectedPredicateEvaluations: number) => {
        predicateEvaluations = 0;
        const startedAt = performance.now();
        index.reconcileRows(new Set([rowId]));
        index.reconcile(isolatedColumns, isolatedRowSpace);
        stagingSamples.push(performance.now() - startedAt);
        if (
          predicateEvaluations !== 0 ||
          index.isReady() ||
          index.find(0, isolatedColumns[0]!.columnId, 1) !== undefined
        ) {
          throw new Error(
            "One-row predicate invalidation exposed synchronous or partial evidence.",
          );
        }
        while (!index.isReady()) {
          const sliceStartedAt = performance.now();
          index.buildNextSlice();
          sliceSamples.push(performance.now() - sliceStartedAt);
        }
        if (predicateEvaluations !== expectedPredicateEvaluations) {
          throw new Error(
            "One-row predicate invalidation did not evaluate latest evidence exactly.",
          );
        }
      };

      const firstRow = isolatedRows[0]!;
      const middleRow = isolatedRows[Math.floor(isolatedRows.length / 2)]!;
      const lastRow = isolatedRows.at(-1)!;
      isolatedRowsById.set(firstRow.id, { ...firstRow, editable: false });
      stageAndDrain(firstRow.id, 1);
      if (index.find(1, isolatedColumns[0]!.columnId, -1) !== undefined) {
        throw new Error("Start-row true-to-false invalidation was not exact.");
      }
      isolatedRowsById.set(firstRow.id, firstRow);
      stageAndDrain(firstRow.id, 1);
      if (index.find(1, isolatedColumns[0]!.columnId, -1)?.rowId !== firstRow.id) {
        throw new Error("Start-row false-to-true invalidation did not restore eligibility.");
      }
      isolatedRowsById.set(middleRow.id, { ...middleRow });
      stageAndDrain(middleRow.id, 1);
      if (
        index.find(Math.floor(isolatedRows.length / 2) - 1, isolatedColumns[0]!.columnId, 1)
          ?.rowId !== middleRow.id
      ) {
        throw new Error("Middle-row reference replacement was not exact.");
      }
      isolatedRowsById.delete(lastRow.id);
      stageAndDrain(lastRow.id, 0);
      if (index.find(isolatedRows.length - 2, isolatedColumns[0]!.columnId, 1) !== undefined) {
        throw new Error("Missing end row retained stale eligibility.");
      }
      isolatedRowsById.set(lastRow.id, lastRow);
      stageAndDrain(lastRow.id, 1);
      if (
        index.find(isolatedRows.length - 2, isolatedColumns[0]!.columnId, 1)?.rowId !== lastRow.id
      ) {
        throw new Error("Returned end row did not restore exact eligibility.");
      }

      const stagingP99Ms = assertBudgetSamples(
        "one-row predicate invalidation staging",
        stagingSamples,
      );
      const p99Ms = assertBudgetSamples("one-row predicate invalidation slice", sliceSamples);
      console.log(
        JSON.stringify({
          benchmark: "BrunoTable one-row predicate invalidation",
          rowCount: isolatedRows.length,
          stagingP99Ms,
          sliceCount: sliceSamples.length,
          p99Ms,
          referenceFrameBudgetMs,
        }),
      );
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "paces predicate-authority discovery across 100,000 cached rows",
    () => {
      const stagingSamples: number[] = [];
      const sliceSamples: number[] = [];
      for (let sampleIndex = 0; sampleIndex < 3; sampleIndex += 1) {
        largeAuthorityPredicateEvaluations = 0;
        largeAuthorityEnabled = !largeAuthorityEnabled;
        const replacement = largeAuthorityEnabled
          ? largeEnabledAuthorityColumns
          : largeDisabledAuthorityColumns;
        const startedAt = performance.now();
        largeAuthorityIndex.reconcile(replacement, largeAuthorityRowSpace);
        stagingSamples.push(performance.now() - startedAt);
        if (
          largeAuthorityPredicateEvaluations !== 0 ||
          largeAuthorityIndex.isReady() ||
          largeAuthorityIndex.find(0, replacement[0]!.columnId, 1) !== undefined
        ) {
          throw new Error(
            "Large predicate-authority replacement exposed synchronous or partial evidence.",
          );
        }
        while (!largeAuthorityIndex.isReady()) {
          const sliceStartedAt = performance.now();
          largeAuthorityIndex.buildNextSlice();
          sliceSamples.push(performance.now() - sliceStartedAt);
        }
        if (Number(largeAuthorityPredicateEvaluations) !== staticRowCount) {
          throw new Error("Large predicate-authority replacement did not revisit each row once.");
        }
      }
      const destination = largeAuthorityEnabled
        ? largeAuthorityIndex.find(staticRowCount - 2, largeEnabledAuthorityColumns[0]!.columnId, 1)
        : largeAuthorityIndex.find(0, largeDisabledAuthorityColumns[0]!.columnId, 1);
      const expectedRowId = largeAuthorityEnabled
        ? largeAuthorityRows.at(-1)!.id
        : largeAuthorityRows[1]!.id;
      if (destination?.rowId !== expectedRowId) {
        throw new Error("Large predicate-authority replacement installed inexact eligibility.");
      }
      const stagingP99Ms = assertBudgetSamples(
        "large predicate-authority staging",
        stagingSamples,
        3,
      );
      const p99Ms = assertBudgetSamples("large predicate-authority slice", sliceSamples);
      if (sliceSamples.length > 600) {
        throw new Error("Large predicate-authority replacement exceeded its linear slice bound.");
      }
      console.log(
        JSON.stringify({
          benchmark: "BrunoTable large predicate-authority replacement",
          rowCount: largeAuthorityRows.length,
          stagingP99Ms,
          sliceCount: sliceSamples.length,
          p99Ms,
          referenceFrameBudgetMs,
        }),
      );
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "paces a known 5,000-row publication with latest-row evidence and no partial traversal",
    () => {
      const highEligibilityRows = rows.map((row) => ({ ...row, editable: true }));
      const knownRowsById = new Map(highEligibilityRows.map((row) => [row.id, row]));
      let predicateEvaluations = 0;
      const index = new BrunoTableCellEditTraversalIndex(
        (rowId) => knownRowsById.get(rowId),
        (_rowId, row) => {
          predicateEvaluations += 1;
          return (row as Row).editable;
        },
        true,
      );
      index.reconcile(columns, rowSpace);
      while (index.buildNextSlice());
      predicateEvaluations = 0;
      for (const row of rows) knownRowsById.set(row.id, { ...row, editable: false });
      const changedRowIds = new Set(knownRowsById.keys());
      const stagingSamples: number[] = [];
      let startedAt = performance.now();
      index.reconcileRows(changedRowIds);
      index.reconcile(columns, rowSpace);
      stagingSamples.push(performance.now() - startedAt);
      knownRowsById.set(rows.at(-1)!.id, { ...rows.at(-1)!, editable: true });
      startedAt = performance.now();
      index.reconcileRows(new Set([rows.at(-1)!.id]));
      index.reconcile(columns, rowSpace);
      stagingSamples.push(performance.now() - startedAt);
      const stagingP99Ms = assertBudgetSamples("known-row invalidation staging", stagingSamples);
      if (predicateEvaluations !== 0 || index.find(0, columns[0]!.columnId, 1) !== undefined) {
        throw new Error("Known-row traversal exposed partial predicate evidence.");
      }
      const sliceSamples: number[] = [];
      while (!index.isReady()) {
        const startedAt = performance.now();
        index.buildNextSlice();
        sliceSamples.push(performance.now() - startedAt);
      }
      const p99Ms = assertBudgetSamples("known-row predicate-index slice", sliceSamples);
      if (
        predicateEvaluations !== rowCount * columnCount ||
        index.find(0, columns[0]!.columnId, 1)?.rowId !== rows.at(-1)!.id
      ) {
        throw new Error("Known-row predicate-index reconciliation was not exact/latest-wins.");
      }
      console.log(
        JSON.stringify({
          benchmark: "BrunoTable known-row predicate-index production slices",
          predicateEvaluations,
          stagingP99Ms,
          sliceCount: sliceSamples.length,
          p99Ms,
          referenceFrameBudgetMs,
        }),
      );
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "stages late invalidations independently of a 100,000-row pending tail",
    () => {
      const pendingRows = Array.from(
        { length: staticRowCount },
        (_unused, rowIndex): Row => ({
          id: `pending-row-${String(rowIndex)}`,
          editable: true,
        }),
      );
      const pendingRowsById = new Map(pendingRows.map((row) => [row.id, row]));
      const pendingRowSpace = Object.freeze({
        totalRows: pendingRows.length,
        getRowId: (rowIndex: number) => pendingRows[rowIndex]?.id,
      });
      const pendingColumns = compileColumns([
        {
          columnId: "COL_ID_PENDING_EDIT",
          field: "editable" as const,
          headerName: "Pending edit",
          valueType: "boolean" as const,
          isEditable: stablePredicate,
        },
      ]);
      let predicateEvaluations = 0;
      const index = new BrunoTableCellEditTraversalIndex(
        (rowId) => pendingRowsById.get(rowId),
        (_rowId, row) => {
          predicateEvaluations += 1;
          return (row as Row).editable;
        },
        true,
      );
      index.reconcile(pendingColumns, pendingRowSpace);
      while (index.buildNextSlice());

      for (const row of pendingRows) {
        pendingRowsById.set(row.id, { ...row, editable: false });
      }
      index.reconcileRows(new Set(pendingRowsById.keys()));
      index.reconcile(pendingColumns, pendingRowSpace);
      index.buildNextSlice();
      predicateEvaluations = 0;

      const stagingSamples: number[] = [];
      for (let sampleIndex = 0; sampleIndex < 100; sampleIndex += 1) {
        const row = pendingRows[staticRowCount - 1 - sampleIndex]!;
        pendingRowsById.set(row.id, { ...row, editable: true });
        const startedAt = performance.now();
        index.reconcileRows(new Set([row.id]));
        index.reconcile(pendingColumns, pendingRowSpace);
        stagingSamples.push(performance.now() - startedAt);
        if (predicateEvaluations !== 0 || index.isReady()) {
          throw new Error("Late invalidation exposed synchronous or partial traversal evidence.");
        }
      }

      const processedRow = pendingRows[0]!;
      pendingRowsById.set(processedRow.id, { ...processedRow, editable: true });
      const processedStartedAt = performance.now();
      index.reconcileRows(new Set([processedRow.id]));
      index.reconcile(pendingColumns, pendingRowSpace);
      stagingSamples.push(performance.now() - processedStartedAt);
      if (predicateEvaluations !== 0 || index.isReady()) {
        throw new Error("Processed late invalidation exposed synchronous or partial evidence.");
      }

      const sliceSamples: number[] = [];
      while (!index.isReady()) {
        const startedAt = performance.now();
        index.buildNextSlice();
        sliceSamples.push(performance.now() - startedAt);
      }
      if (
        index.find(1, pendingColumns[0]!.columnId, -1)?.rowId !== processedRow.id ||
        index.find(staticRowCount - 102, pendingColumns[0]!.columnId, 1)?.rowId !==
          pendingRows[staticRowCount - 100]!.id
      ) {
        throw new Error("Late invalidation rebuild did not install exact latest evidence.");
      }

      const stagingP99Ms = assertBudgetSamples("late invalidation staging", stagingSamples);
      const p99Ms = assertBudgetSamples("late invalidation slice", sliceSamples);
      console.log(
        JSON.stringify({
          benchmark: "BrunoTable late pending-tail invalidation",
          rowCount: pendingRows.length,
          stagingP99Ms,
          sliceCount: sliceSamples.length,
          p99Ms,
          referenceFrameBudgetMs,
        }),
      );
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "keeps 100,000-row known and unknown publications analytical for static editability",
    () => {
      let rowReads = 0;
      const index = new BrunoTableCellEditTraversalIndex(
        () => {
          rowReads += 1;
          return undefined;
        },
        () => {
          throw new Error("Static editability evaluated a row predicate.");
        },
        true,
      );
      index.reconcile(staticColumns, staticRowSpace);
      while (index.buildNextSlice());
      const changedRowIds = new Set(
        Array.from(
          { length: staticRowCount },
          (_unused, rowIndex) => `static-row-${String(rowIndex)}`,
        ),
      );
      const startedAt = performance.now();
      index.reconcileRows(changedRowIds);
      index.reconcile(staticColumns, staticRowSpace);
      index.reconcileRows(undefined);
      index.reconcile(staticColumns, staticRowSpace);
      const elapsedMs = performance.now() - startedAt;
      assertBudgetSamples("static-editability publication", [elapsedMs], 1);
      if (
        rowReads !== 0 ||
        index.getCachedRowCount() !== 0 ||
        !index.isReady() ||
        index.find(staticRowCount - 2, staticColumns[0]!.columnId, 1)?.rowId !==
          `static-row-${String(staticRowCount - 1)}`
      ) {
        throw new Error("Static editability lost its analytical traversal projection.");
      }
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "rebuilds a 100,000-row dirty remap immediately after paced identity discovery",
    () => {
      const remapRows = new Map<string, Row>(
        Array.from({ length: staticRowCount }, (_unused, rowIndex) => {
          const row = { id: `dirty-remap-${String(rowIndex)}`, editable: true };
          return [row.id, row];
        }),
      );
      const remapColumns = compileColumns([
        {
          columnId: "COL_ID_DIRTY_REMAP",
          field: "editable" as const,
          headerName: "Dirty remap",
          valueType: "boolean" as const,
          isEditable: stablePredicate,
        },
      ]);
      let projectionReads = 0;
      const createRemapRowSpace = () =>
        Object.freeze({
          totalRows: staticRowCount,
          getRowId: (rowIndex: number) => {
            projectionReads += 1;
            return rowIndex < staticRowCount ? `dirty-remap-${String(rowIndex)}` : undefined;
          },
        });
      let predicateEvaluations = 0;
      const index = new BrunoTableCellEditTraversalIndex(
        (rowId) => remapRows.get(rowId),
        (_rowId, value) => {
          predicateEvaluations += 1;
          return (value as Row).editable;
        },
        true,
      );
      const initialRowSpace = createRemapRowSpace();
      index.reconcile(remapColumns, initialRowSpace);
      while (index.buildNextSlice());
      for (const [rowId, value] of remapRows) {
        remapRows.set(rowId, { ...value, editable: false });
      }
      index.reconcileRows(new Set(remapRows.keys()));
      index.reconcile(remapColumns, initialRowSpace);
      projectionReads = 0;
      predicateEvaluations = 0;
      index.reconcile(remapColumns, createRemapRowSpace());

      const discoverySamples: number[] = [];
      while (projectionReads < staticRowCount) {
        const startedAt = performance.now();
        index.buildNextSlice();
        discoverySamples.push(performance.now() - startedAt);
        if ((projectionReads < staticRowCount && predicateEvaluations !== 0) || index.isReady()) {
          throw new Error("Dirty remap exposed predicate or partial traversal during discovery.");
        }
      }
      let firstRebuildMs = discoverySamples.at(-1)!;
      if (predicateEvaluations === 0) {
        const firstRebuildStartedAt = performance.now();
        index.buildNextSlice();
        firstRebuildMs = performance.now() - firstRebuildStartedAt;
      }
      if (predicateEvaluations === 0 || index.isReady()) {
        throw new Error("Dirty remap inserted a second full bookkeeping pass before rebuilding.");
      }
      const rebuildSamples = [firstRebuildMs];
      while (!index.isReady()) {
        const startedAt = performance.now();
        index.buildNextSlice();
        rebuildSamples.push(performance.now() - startedAt);
      }
      if (predicateEvaluations !== staticRowCount || index.find(0, remapColumns[0]!.columnId, 1)) {
        throw new Error("Dirty remap did not install exact latest predicate evidence.");
      }
      const discoveryP99Ms = assertBudgetSamples("dirty-remap discovery slice", discoverySamples);
      const rebuildP99Ms = assertBudgetSamples("dirty-remap rebuild slice", rebuildSamples);
      console.log(
        JSON.stringify({
          benchmark: "BrunoTable dirty remap without a second identity pass",
          rowCount: staticRowCount,
          discoveryP99Ms,
          rebuildP99Ms,
          referenceFrameBudgetMs,
        }),
      );
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "paces unknown discovery and rebuilding for a 20,000 by 150 replacement",
    () => {
      const unknownRowCount = 20_000;
      const unknownRows = Array.from(
        { length: unknownRowCount },
        (_unused, rowIndex): Row => ({
          id: `unknown-row-${String(rowIndex)}`,
          editable: true,
        }),
      );
      const unknownRowSpace = Object.freeze({
        totalRows: unknownRowCount,
        getRowId: (rowIndex: number) => unknownRows[rowIndex]?.id,
      });
      const unknownRowsById = new Map(unknownRows.map((row) => [row.id, row]));
      let predicateEvaluations = 0;
      const index = new BrunoTableCellEditTraversalIndex(
        (rowId) => unknownRowsById.get(rowId),
        (_rowId, row) => {
          predicateEvaluations += 1;
          return (row as Row).editable;
        },
        true,
      );
      index.reconcile(columns, unknownRowSpace);
      while (index.buildNextSlice());
      predicateEvaluations = 0;
      for (const row of unknownRows) unknownRowsById.set(row.id, { ...row, editable: false });
      unknownRowsById.delete(unknownRows[0]!.id);
      const stagingSamples: number[] = [];
      let startedAt = performance.now();
      index.reconcileRows(undefined);
      index.reconcile(columns, unknownRowSpace);
      stagingSamples.push(performance.now() - startedAt);
      const supersededSliceStartedAt = performance.now();
      index.buildNextSlice();
      const supersededDiscoveryMs = performance.now() - supersededSliceStartedAt;
      unknownRowsById.set(unknownRows.at(-1)!.id, {
        ...unknownRows.at(-1)!,
        editable: true,
      });
      startedAt = performance.now();
      index.reconcileRows(undefined);
      index.reconcile(columns, unknownRowSpace);
      stagingSamples.push(performance.now() - startedAt);
      const stagingP99Ms = assertBudgetSamples("unknown-row invalidation staging", stagingSamples);
      if (predicateEvaluations !== 0 || index.find(0, columns[0]!.columnId, 1) !== undefined) {
        throw new Error("Unknown-row traversal exposed partial predicate evidence.");
      }
      const discoverySamples: number[] = [supersededDiscoveryMs];
      const rebuildSamples: number[] = [];
      while (!index.isReady()) {
        const evaluationsBeforeSlice: number = predicateEvaluations;
        const sliceStartedAt = performance.now();
        index.buildNextSlice();
        const elapsedMs = performance.now() - sliceStartedAt;
        if (predicateEvaluations === evaluationsBeforeSlice) discoverySamples.push(elapsedMs);
        else rebuildSamples.push(elapsedMs);
        if (!index.isReady() && index.find(0, columns[0]!.columnId, 1) !== undefined) {
          throw new Error("Unknown-row traversal exposed a partial destination during a slice.");
        }
      }
      const discoveryP99Ms = assertBudgetSamples("unknown-row discovery slice", discoverySamples);
      const rebuildP99Ms = assertBudgetSamples("unknown-row predicate-index slice", rebuildSamples);
      if (
        predicateEvaluations !== (unknownRowCount - 1) * columnCount ||
        index.getCachedRowCount() !== unknownRowCount - 1 ||
        index.find(0, columns[0]!.columnId, 1)?.rowId !== unknownRows.at(-1)!.id
      ) {
        throw new Error("Unknown-row predicate-index reconciliation was not exact/latest-wins.");
      }
      console.log(
        JSON.stringify({
          benchmark: "BrunoTable unknown-row predicate-index production slices",
          predicateEvaluations,
          stagingP99Ms,
          discoverySliceCount: discoverySamples.length,
          discoveryP99Ms,
          rebuildSliceCount: rebuildSamples.length,
          rebuildP99Ms,
          referenceFrameBudgetMs,
        }),
      );
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "paces 5,000 late projected rows that disappear before rebuilding",
    () => {
      const missingRowsById = new Map(rows.map((row) => [row.id, { ...row, editable: true }]));
      let rowReads = 0;
      let predicateEvaluations = 0;
      const index = new BrunoTableCellEditTraversalIndex(
        (rowId) => {
          rowReads += 1;
          return missingRowsById.get(rowId);
        },
        () => {
          predicateEvaluations += 1;
          return true;
        },
        true,
      );
      index.reconcile(columns, rowSpace);
      while (index.buildNextSlice());
      predicateEvaluations = 0;
      index.reconcileRows(undefined);
      index.reconcile(columns, rowSpace);
      index.buildNextSlice(
        rowCount * 2 * BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST,
        Number.POSITIVE_INFINITY,
      );
      missingRowsById.clear();
      index.reconcileRows(new Set(rows.map((row) => row.id)));
      rowReads = 0;

      const sliceSamples: number[] = [];
      const firstSliceStartedAt = performance.now();
      const hasMoreWork = index.buildNextSlice();
      sliceSamples.push(performance.now() - firstSliceStartedAt);
      const maximumRowsPerSlice = Math.floor(
        BRUNO_TABLE_CELL_EDIT_TRAVERSAL_SLICE_PREDICATE_CELL_LIMIT / columnCount,
      );
      if (!hasMoreWork || index.isReady() || rowReads > maximumRowsPerSlice) {
        throw new Error("Missing projected rows bypassed the production slice budget.");
      }
      while (!index.isReady()) {
        const startedAt = performance.now();
        index.buildNextSlice();
        sliceSamples.push(performance.now() - startedAt);
      }
      const p99Ms = assertBudgetSamples("missing projected-row teardown slice", sliceSamples);
      if (
        predicateEvaluations !== 0 ||
        index.getCachedRowCount() !== 0 ||
        index.find(0, columns[0]!.columnId, 1) !== undefined
      ) {
        throw new Error("Missing projected-row teardown did not converge exactly.");
      }
      console.log(
        JSON.stringify({
          benchmark: "BrunoTable missing projected-row production slices",
          rowReads,
          sliceCount: sliceSamples.length,
          p99Ms,
          referenceFrameBudgetMs,
        }),
      );
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "finds far forward, reverse, and terminal destinations across 750,000 predicate cells",
    () => {
      const startedAt = performance.now();
      const forward = traversalIndex.find(0, columns.at(-1)!.columnId, 1);
      const reverse = traversalIndex.find(rowCount - 1, columns[0]!.columnId, -1);
      const terminal = traversalIndex.find(rowCount - 1, columns.at(-1)!.columnId, 1);
      recordBudgetSample("far traversal", samples, performance.now() - startedAt);
      if (forward?.rowIndex !== rowCount - 1 || reverse?.rowIndex !== 0 || terminal !== undefined) {
        throw new Error("Unexpected editable traversal result.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  let equivalentRecompileIndex = 0;
  bench(
    "reconciles an equivalent 5,000 by 150 recompile without predicate callbacks",
    () => {
      equivalentAuthorityPredicateEvaluations = 0;
      const nextColumns =
        equivalentRecompileColumns[equivalentRecompileIndex % equivalentRecompileColumns.length]!;
      equivalentRecompileIndex += 1;
      const startedAt = performance.now();
      equivalentAuthorityIndex.reconcile(nextColumns, forwardRowSpace);
      recordBudgetSample(
        "equivalent predicate-authority reconciliation",
        equivalentAuthoritySamples,
        performance.now() - startedAt,
      );
      if (equivalentAuthorityPredicateEvaluations !== 0) {
        throw new Error("Equivalent predicate authority revisited cached evidence.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  let changedAuthority = false;
  bench(
    "paces one changed predicate authority across 5,000 rows",
    () => {
      authorityPredicateEvaluations = 0;
      const startedAt = performance.now();
      authorityIndex.reconcile(
        changedAuthority ? equivalentColumns : changedAuthorityColumns,
        forwardRowSpace,
      );
      recordBudgetSample(
        "changed predicate-authority reconciliation",
        changedAuthoritySamples,
        performance.now() - startedAt,
      );
      if (authorityPredicateEvaluations !== 0 || authorityIndex.isReady()) {
        throw new Error("Changed predicate authority performed synchronous row work.");
      }
      while (authorityIndex.isReady() === false) {
        const sliceStartedAt = performance.now();
        authorityIndex.buildNextSlice();
        recordBudgetSample(
          "changed predicate-authority slice",
          changedAuthoritySliceSamples,
          performance.now() - sliceStartedAt,
        );
      }
      changedAuthority = !changedAuthority;
      if (Number(authorityPredicateEvaluations) !== rowCount) {
        throw new Error("Changed predicate authority did not perform bounded row work.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  let allAuthoritiesChanged = false;
  bench(
    "paces replacement of all 750,000 predicate authorities with zero synchronous callbacks",
    () => {
      allAuthorityPredicateEvaluations = 0;
      const startedAt = performance.now();
      allAuthorityIndex.reconcile(
        allAuthoritiesChanged ? columns : allChangedAuthorityColumns,
        forwardRowSpace,
      );
      recordBudgetSample(
        "all predicate-authority staging",
        allAuthorityStagingSamples,
        performance.now() - startedAt,
      );
      assertBudgetSamples("all predicate-authority staging", allAuthorityStagingSamples);
      if (allAuthorityPredicateEvaluations !== 0 || allAuthorityIndex.isReady()) {
        throw new Error("All-authority replacement performed synchronous predicate work.");
      }
      while (allAuthorityIndex.isReady() === false) {
        const sliceStartedAt = performance.now();
        allAuthorityIndex.buildNextSlice();
        recordBudgetSample(
          "all predicate-authority slice",
          allAuthoritySliceSamples,
          performance.now() - sliceStartedAt,
        );
      }
      allAuthoritiesChanged = !allAuthoritiesChanged;
      if (Number(allAuthorityPredicateEvaluations) !== rowCount * columnCount) {
        throw new Error("All-authority replacement did not rebuild every predicate cell.");
      }
    },
    { iterations: 3, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  let reversed = false;
  bench(
    "remaps a sorted or filtered 5,000-row projection without revisiting 750,000 predicates",
    () => {
      reconciliationPredicateEvaluations = 0;
      const nextRowSpace = reversed ? forwardRowSpace : reverseRowSpace;
      const startedAt = performance.now();
      reconciliationIndex.reconcile(columns, nextRowSpace);
      recordBudgetSample(
        "projection reconciliation",
        reconciliationSamples,
        performance.now() - startedAt,
      );
      if (
        reconciliationIndex.isReady() ||
        reconciliationIndex.find(0, columns[0]!.columnId, 1) !== undefined
      ) {
        throw new Error("Projection remapping exposed a partial destination.");
      }
      while (!reconciliationIndex.isReady()) {
        const sliceStartedAt = performance.now();
        reconciliationIndex.buildNextSlice();
        recordBudgetSample(
          "projection reconciliation slice",
          projectionSliceSamples,
          performance.now() - sliceStartedAt,
        );
      }
      reversed = !reversed;
      if (
        reconciliationPredicateEvaluations !== 0 ||
        reconciliationIndex.findFromRowBoundary(rowCount, -1)?.rowId !==
          nextRowSpace.getRowId(rowCount - 1)
      ) {
        throw new Error("Projection remapping did not install exact cached predicate evidence.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  rangeIndex.reconcile(columns, forwardRowSpace);
  rangeIndex.findRange(verticalRange, rows.at(-1)!.id, columns[0]!.columnId, 1);
  bench(
    "cycles a cached 5,000-row vertical editable range exactly",
    () => {
      const startedAt = performance.now();
      const destination = rangeIndex.findRange(
        verticalRange,
        rows.at(-1)!.id,
        columns[0]!.columnId,
        1,
      );
      recordBudgetSample("vertical range traversal", rangeSamples, performance.now() - startedAt);
      if (destination?.rowId !== rows[0]!.id) {
        throw new Error("Unexpected vertical range traversal result.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "cycles a 150-column horizontal editable range exactly",
    () => {
      const startedAt = performance.now();
      const destination = rangeIndex.findRange(
        horizontalRange,
        rows.at(-1)!.id,
        columns[0]!.columnId,
        1,
      );
      recordBudgetSample(
        "horizontal range traversal",
        horizontalRangeSamples,
        performance.now() - startedAt,
      );
      if (destination?.columnId !== columns[1]!.columnId) {
        throw new Error("Unexpected horizontal range traversal result.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );
});
