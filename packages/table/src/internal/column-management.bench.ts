import { describe } from "vite-plus/test";
import { bench } from "../../scripts/benchmark-adapter";
import * as BigDecimal from "effect/BigDecimal";

import { BrunoTableBigDecimalColumn } from "../effect";
import type { BrunoTableColumns } from "../public-types";
import {
  createBrunoTableClientFacetSnapshot,
  createBrunoTableClientFacetStore,
} from "./client-facet";
import { compileColumns } from "./compile-columns";
import { compileClientFilterCollection } from "./grid-query";
import { BrunoTableGridRuntime, type BrunoTableRowPipelineRuntimeView } from "./grid-runtime";
import { createClientQueryPredicate } from "./quick-filter";

const columnCount = 240;
const referenceFrameBudgetMs = 8.33;
const benchmarkColumns = compileColumns(
  Array.from({ length: columnCount }, (_unused, index) => ({
    columnId: `COL_ID_BENCH_${String(index).padStart(3, "0")}`,
    field: "name" as const,
    headerName: `Benchmark ${String(index)}`,
    valueType: "text" as const,
    width: 120,
  })),
);
const benchmarkPublication = {
  status: "ready" as const,
  totalRows: 10_000,
  version: 1,
  hasCoherentRows: true,
};
const benchmarkOrder = [{ columnId: benchmarkColumns[0]!.columnId, direction: "asc" as const }];

function createRuntime(tableId: string): BrunoTableGridRuntime<unknown> {
  return new BrunoTableGridRuntime(
    benchmarkPublication,
    benchmarkColumns,
    {
      baselineFilters: [],
      baselineOrderBy: benchmarkOrder,
    },
    tableId,
  );
}

function createDirtyResetRuntime(index: number): BrunoTableGridRuntime<unknown> {
  const runtime = createRuntime(`TABLE_ID_BENCH_RESET_${String(index)}`);
  runtime.dispatchGridCommand({
    type: "column.resize.commit",
    columnId: benchmarkColumns[0]!.columnId,
    width: 320,
  });
  runtime.dispatchGridCommand({
    type: "column.visibility.commit",
    columnId: benchmarkColumns[1]!.columnId,
    visible: false,
  });
  runtime.dispatchGridCommand({
    type: "column.pin.commit",
    columnId: benchmarkColumns[2]!.columnId,
    pinned: "start",
  });
  return runtime;
}

function percentile99(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] ?? 0;
}

describe("BrunoTable column management runtime benchmark (8.33 ms/120 Hz reference)", () => {
  const resizeRuntime = createRuntime("TABLE_ID_BENCH_RESIZE");
  const reorderRuntime = createRuntime("TABLE_ID_BENCH_REORDER");
  // Keep a larger pool than the requested sample count because Tinybench may execute one
  // additional calibration iteration even with warmup disabled. Every measured sample still
  // receives a previously dirtied runtime and therefore performs a real reset.
  const resetRuntimes = Array.from({ length: 256 }, (_unused, index) =>
    createDirtyResetRuntime(index),
  );
  let resizeIteration = 0;
  let reorderIteration = 0;
  let resetIteration = 0;

  bench(
    "commits resize work for 240 columns (compare p99 with 8.33 ms)",
    () => {
      const column = benchmarkColumns[resizeIteration++ % columnCount]!;
      resizeRuntime.dispatchGridCommand({
        type: "column.resize.commit",
        columnId: column.columnId,
        width: 80 + (resizeIteration % 800),
      });
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "commits reorder work for 240 columns (compare p99 with 8.33 ms)",
    () => {
      const column = benchmarkColumns[reorderIteration++ % columnCount]!;
      reorderRuntime.dispatchGridCommand({
        type: "column.reorder.commit",
        columnId: column.columnId,
        targetIndex: (reorderIteration * 7) % columnCount,
        pinned: undefined,
      });
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "resets a complete 240-column layout (compare p99 with 8.33 ms)",
    () => {
      const resetRuntime = resetRuntimes[resetIteration++ % resetRuntimes.length]!;
      resetRuntime.dispatchGridCommand({ type: "column.reset.layout" });
    },
    {
      iterations: 100,
      time: 0,
      warmupIterations: 0,
      warmupTime: 0,
    },
  );

  const diagnosticResizeRuntime = createRuntime("TABLE_ID_BENCH_DIAGNOSTIC_RESIZE");
  const diagnosticReorderRuntime = createRuntime("TABLE_ID_BENCH_DIAGNOSTIC_REORDER");
  const diagnosticResetRuntimes = Array.from({ length: 256 }, (_unused, index) =>
    createDirtyResetRuntime(10_000 + index),
  );
  const diagnosticSamples = {
    resize: [] as number[],
    reorder: [] as number[],
    reset: [] as number[],
  };
  let diagnosticIteration = 0;
  let diagnosticPrinted = false;

  bench(
    "diagnostic p99 comparison for 240-column commands (8.33 ms reference)",
    () => {
      const iteration = diagnosticIteration++;
      const resizeColumn = benchmarkColumns[iteration % columnCount]!;
      const resizeStartedAt = performance.now();
      diagnosticResizeRuntime.dispatchGridCommand({
        type: "column.resize.commit",
        columnId: resizeColumn.columnId,
        width: 80 + ((iteration + 1) % 800),
      });
      diagnosticSamples.resize.push(performance.now() - resizeStartedAt);

      const reorderColumn = benchmarkColumns[iteration % columnCount]!;
      const reorderStartedAt = performance.now();
      diagnosticReorderRuntime.dispatchGridCommand({
        type: "column.reorder.commit",
        columnId: reorderColumn.columnId,
        targetIndex: ((iteration + 1) * 7) % columnCount,
        pinned: undefined,
      });
      diagnosticSamples.reorder.push(performance.now() - reorderStartedAt);

      const resetStartedAt = performance.now();
      diagnosticResetRuntimes[iteration % diagnosticResetRuntimes.length]!.dispatchGridCommand({
        type: "column.reset.layout",
      });
      diagnosticSamples.reset.push(performance.now() - resetStartedAt);

      if (!diagnosticPrinted && diagnosticIteration >= 100) {
        diagnosticPrinted = true;
        const diagnosticP99Ms = {
          resize: percentile99(diagnosticSamples.resize),
          reorder: percentile99(diagnosticSamples.reorder),
          reset: percentile99(diagnosticSamples.reset),
        };
        process.stdout.write(
          `${JSON.stringify({
            benchmark: "BrunoTable column management runtime",
            referenceFrameBudgetMs,
            diagnosticP99Ms,
            diagnosticP99WithinReference: Object.fromEntries(
              Object.entries(diagnosticP99Ms).map(([kind, durationMs]) => [
                kind,
                durationMs <= referenceFrameBudgetMs,
              ]),
            ),
          })}\n`,
        );
      }
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );
});

describe("BrunoTable open-facet live publication benchmark (8.33 ms/120 Hz reference)", () => {
  const facetColumns = compileColumns([
    {
      columnId: "COL_ID_FACET_VALUE",
      enableSetFilter: true,
      field: "value",
      headerName: "Value",
      valueType: "text",
    },
  ]);
  const filterCollection = compileClientFilterCollection([], facetColumns);
  const residentRowCount = 10_000;
  const baseRows = Array.from({ length: residentRowCount }, (_unused, rowIndex) => {
    const raw = Object.freeze({ value: `value-${String(rowIndex)}`, unrelated: Number(0) });
    return Object.freeze({
      raw,
      rowId: `row-${String(rowIndex)}`,
      rowIndex,
      values: Object.freeze({
        read: (row: unknown) => (row as typeof raw).value,
      }),
    });
  });
  const activeIntentValues = Object.freeze(
    baseRows.slice(0, residentRowCount / 2).map((row) => row.raw.value),
  );
  const activeFilterCollection = compileClientFilterCollection(
    [
      {
        columnId: "COL_ID_FACET_VALUE",
        type: "in",
        filter: activeIntentValues,
        caseSensitive: true,
        accentSensitive: true,
      },
    ],
    facetColumns,
  );
  const activeFilterPredicate = createClientQueryPredicate(
    facetColumns,
    activeFilterCollection.filters,
    "",
    [],
    (_column, row: (typeof baseRows)[number]) => row.raw.value,
    undefined,
    activeFilterCollection,
  );
  type BigDecimalRow = { readonly price: BigDecimal.BigDecimal };
  const bigDecimalDefinitions = [
    BrunoTableBigDecimalColumn({
      columnId: "COL_ID_FACET_DECIMAL",
      enableSetFilter: true,
      field: "price",
      headerName: "Price",
    }),
  ] satisfies BrunoTableColumns<BigDecimalRow>;
  const bigDecimalColumns = compileColumns(bigDecimalDefinitions);
  const bigDecimalRows = Array.from({ length: residentRowCount }, (_unused, rowIndex) =>
    Object.freeze({
      price: BigDecimal.fromStringUnsafe(`${String(rowIndex)}.0000000000000000001`),
    }),
  );
  const activeBigDecimalValues = Object.freeze(
    bigDecimalRows.slice(0, residentRowCount / 2).map((row) => row.price),
  );
  const activeBigDecimalFilters = compileClientFilterCollection(
    [
      {
        columnId: "COL_ID_FACET_DECIMAL",
        type: "in",
        filter: activeBigDecimalValues,
      },
    ],
    bigDecimalColumns,
  );
  const activeBigDecimalPredicate = createClientQueryPredicate(
    bigDecimalColumns,
    activeBigDecimalFilters.filters,
    "",
    [],
    (_column, row: (typeof bigDecimalRows)[number]) => row.price,
    undefined,
    activeBigDecimalFilters,
  );
  const publicationCount = 256;
  const tokens = Array.from({ length: publicationCount }, () => Object.freeze({}));
  let previousRows = Object.freeze(baseRows);
  const snapshots = Array.from({ length: publicationCount }, (_unused, iteration) => {
    if (iteration === 0) {
      return Object.freeze({
        rows: previousRows,
        token: tokens[0]!,
        changedIndexes: Object.freeze([] as number[]),
      });
    }
    const rowIndex = (iteration - 1) % residentRowCount;
    const previous = baseRows[rowIndex]!;
    const rows = Array.from(previousRows);
    rows[rowIndex] = Object.freeze({
      ...previous,
      raw: Object.freeze({ ...previous.raw, unrelated: iteration }),
    });
    previousRows = Object.freeze(rows);
    return Object.freeze({
      rows: previousRows,
      token: tokens[iteration]!,
      parentToken: tokens[iteration - 1]!,
      changedIndexes: Object.freeze([rowIndex]),
    });
  });
  let snapshotIndex = 0;
  let rowListener: (() => void) | undefined;
  const runtime = {
    getQuerySnapshot: () => ({
      columns: facetColumns,
      filters: filterCollection.filters,
      filterCollection,
      quickFilter: "",
      orderBy: [{ columnId: "COL_ID_FACET_VALUE", direction: "asc" as const }],
      generation: 1,
      navigationMode: "reset" as const,
    }),
    getRowSpaceSnapshot: () => undefined,
    getQuickFilterFieldsSnapshot: () => [],
    subscribeFilter: () => () => undefined,
    subscribeRowSpace: (listener: () => void) => {
      rowListener = listener;
      return () => undefined;
    },
  } as unknown as BrunoTableRowPipelineRuntimeView;
  const facetStore = createBrunoTableClientFacetStore({
    column: facetColumns[0]!,
    rows: { getFacetRowsSnapshot: () => snapshots[snapshotIndex]! },
    runtime,
  });
  facetStore.getSnapshot();
  facetStore.subscribe(() => undefined);

  bench(
    "opens 10,000 distinct built-in Text facet values with indexed identity",
    () => {
      createBrunoTableClientFacetSnapshot({
        column: facetColumns[0]!,
        columns: facetColumns,
        filterCollection,
        quickFilter: "",
        quickFilterFields: [],
        rows: baseRows,
        readColumnValue: (_column, row) => row.raw.value,
        readQuickFilterField: () => undefined,
      });
    },
    { iterations: 20, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "projects 10,000 values while retaining 5,000 active exact inclusions",
    () => {
      createBrunoTableClientFacetSnapshot({
        column: facetColumns[0]!,
        columns: facetColumns,
        filterCollection: activeFilterCollection,
        quickFilter: "",
        quickFilterFields: [],
        rows: baseRows,
        readColumnValue: (_column, row) => row.raw.value,
        readQuickFilterField: () => undefined,
      });
    },
    { iterations: 20, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "evaluates 5,000 active exact inclusions over 10,000 rows with indexed membership",
    () => {
      let matches = 0;
      for (const row of baseRows) if (activeFilterPredicate?.(row) === true) matches += 1;
      if (matches !== activeIntentValues.length) throw new Error("Unexpected benchmark result.");
    },
    { iterations: 20, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "evaluates 5,000 active Effect BigDecimal inclusions over 10,000 exact rows",
    () => {
      let matches = 0;
      for (const row of bigDecimalRows) {
        if (activeBigDecimalPredicate?.(row) === true) matches += 1;
      }
      if (matches !== activeBigDecimalValues.length) {
        throw new Error("Unexpected BigDecimal benchmark result.");
      }
    },
    { iterations: 20, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "proves one unrelated changed row cannot rescan 10,000 resident rows",
    () => {
      snapshotIndex += 1;
      rowListener?.();
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );
});
