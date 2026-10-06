import { afterAll, describe } from "vite-plus/test";
import { bench } from "../../scripts/benchmark-adapter";

import { BrunoTableServerViewportStore } from "./server-viewport-store";
import { createBrunoTableServerFacetSnapshot } from "./client-facet";
import { compileColumns } from "./compile-columns";
import { BrunoTableGridRuntime } from "./grid-runtime";
import { BrunoTableServerRowPipelineAdapter } from "./server-source-adapter";
import { compileBrunoTableServerQueryPlan } from "./server-query";
import { brunoTableTestSemanticQueryKey } from "./server-semantic-key.test-support";

const referenceFrameBudgetMs = 8.33;
const virtualRowCount = 1_000_000;
const windowSize = 60;
const warmupIterations = 10;

function assertP99FrameBudget(label: string, samples: readonly number[]): void {
  const measured = samples.slice(warmupIterations).toSorted((left, right) => left - right);
  const p99 = measured[Math.max(0, Math.ceil(measured.length * 0.99) - 1)];
  if (p99 === undefined || p99 > referenceFrameBudgetMs) {
    throw new Error(
      `${label} p99 exceeded ${String(referenceFrameBudgetMs)} ms: ${String(p99)} ms.`,
    );
  }
}

const durationsMs: number[] = [];
const store = new BrunoTableServerViewportStore<Readonly<{ value: number }>>();
const generation = store.beginGeneration({ firstRow: 0, lastRow: windowSize - 1 });
store.setRowCount(generation, virtualRowCount, true);
let iteration = 0;

describe("BrunoTable sparse Server viewport benchmark (8.33 ms/120 Hz reference)", () => {
  afterAll(() => {
    assertP99FrameBudget("Sparse Server window publication", durationsMs);
  });

  bench(
    "moves and publishes a realistic sparse window inside a million-row logical space",
    () => {
      iteration += 1;
      const firstRow = (iteration * 7919) % (virtualRowCount - windowSize);
      const lastRow = firstRow + windowSize - 1;
      const rows: Record<number, Readonly<{ value: number }>> = {};
      const keys: Record<number, string> = {};
      for (let index = firstRow; index <= lastRow; index += 1) {
        rows[index] = Object.freeze({ value: index });
        keys[index] = `server-row-${String(index)}`;
      }
      const startedAt = performance.now();
      store.setRequiredRange(generation, { firstRow, lastRow });
      store.setRowData(generation, rows, keys);
      durationsMs.push(performance.now() - startedAt);
      if (store.getSnapshot().rowSpace.totalRows !== virtualRowCount) {
        throw new Error("Sparse publication changed the authoritative logical row count.");
      }
      if (store.getSnapshot().rowSpace.loadedRows > windowSize) {
        throw new Error("Sparse publication retained rows outside the active window.");
      }
    },
    { iterations: 100, time: 0, warmupIterations, warmupTime: 0 },
  );
});

const adapterDurationsMs: number[] = [];
const adapterColumns = compileColumns([
  {
    columnId: "COL_ID_VALUE",
    field: "value",
    headerName: "Value",
    valueType: "number",
  },
]);
let adapterSink:
  | Readonly<{
      readonly setRowCount: (count: number, keepRenderedRows?: boolean) => void;
      readonly setRowData: (
        rows: Readonly<Record<number, Readonly<{ value: number }>>>,
        keys: Readonly<Record<number, string>>,
      ) => void;
    }>
  | undefined;
let setWindowCalls = 0;
let replaceCalls = 0;
let publicationNotifications = 0;
const adapter = new BrunoTableServerRowPipelineAdapter<Readonly<{ value: number }>>(
  adapterColumns,
  undefined,
  [],
  [{ columnId: "COL_ID_VALUE", direction: "asc" }],
);
const adapterViewport = {
  semanticKey: brunoTableTestSemanticQueryKey,
  replace(request: Readonly<{ readonly sink: NonNullable<typeof adapterSink> }>) {
    replaceCalls += 1;
    adapterSink = request.sink;
    return {
      setWindow: () => {
        setWindowCalls += 1;
      },
      release: () => undefined,
    };
  },
};
adapter.subscribePublication(() => {
  publicationNotifications += 1;
});
adapter.reconcileSource({
  viewport: adapterViewport,
  completeRawSelect: ["value"],
  totalRows: 0,
  version: 0,
  status: "ready",
});
adapter.replace(adapterViewport, {
  generation: 0,
  navigationMode: "reconcile",
  filters: [],
  quickFilter: "",
  orderBy: [{ columnId: "COL_ID_VALUE", direction: "asc" }],
});
adapterSink!.setRowCount(virtualRowCount, true);
let adapterIteration = 0;

describe("BrunoTable Server adapter publication benchmark", () => {
  afterAll(() => {
    assertP99FrameBudget("Server adapter 20 Hz publication", adapterDurationsMs);
    if (replaceCalls !== 1 || setWindowCalls !== adapterIteration) {
      throw new Error("Server adapter replaced a semantic generation during window-only work.");
    }
    if (publicationNotifications > adapterIteration * 2 + 2) {
      throw new Error("Server adapter exceeded the bounded coherent publication count.");
    }
  });

  bench(
    "moves, reveals, and accepts 20 Hz-style sparse source batches",
    () => {
      adapterIteration += 1;
      const firstRow = (adapterIteration * 6151) % (virtualRowCount - windowSize);
      const rows: Record<number, Readonly<{ value: number }>> = {};
      const keys: Record<number, string> = {};
      for (let index = firstRow; index < firstRow + windowSize; index += 1) {
        rows[index] = Object.freeze({ value: index });
        keys[index] = `adapter-row-${String(index)}`;
      }
      const startedAt = performance.now();
      adapter.setRequiredRange(firstRow, firstRow + windowSize);
      adapterSink!.setRowData(rows, keys);
      adapterDurationsMs.push(performance.now() - startedAt);
      const rowSpace = adapter.getPublication().rowSpace;
      if (rowSpace === undefined || rowSpace.loadedRows > windowSize) {
        throw new Error("Server adapter exceeded its bounded sparse window.");
      }
    },
    { iterations: 100, time: 0, warmupIterations, warmupTime: 0 },
  );
});

const groupedAdapterDurationsMs: number[] = [];
const groupedColumns = compileColumns([
  {
    columnId: "COL_ID_REGION",
    field: "region",
    headerName: "Region",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_MIN_VALUE",
    field: "value",
    headerName: "Minimum value",
    valueType: "number",
    aggFunc: "min",
  },
  {
    columnId: "COL_ID_MAX_VALUE",
    field: "value",
    headerName: "Maximum value",
    valueType: "number",
    aggFunc: "max",
  },
]);
let groupedSink:
  | Readonly<{
      readonly setRowCount: (count: number, keepRenderedRows?: boolean) => void;
      readonly setRowData: (
        rows: Readonly<Record<number, Readonly<Record<string, unknown>>>>,
        keys: Readonly<Record<number, string>>,
      ) => void;
    }>
  | undefined;
let groupedQuery:
  | Readonly<{
      readonly aggregates: Readonly<Record<string, Readonly<{ readonly aggFunc: string }>>>;
    }>
  | undefined;
let groupedReplaceCalls = 0;
let groupedReleaseCalls = 0;
const groupedAdapter = new BrunoTableServerRowPipelineAdapter<Readonly<Record<string, unknown>>>(
  groupedColumns,
  undefined,
  [],
  [{ columnId: "COL_ID_REGION", direction: "asc" }],
  ["region", "value"],
);
const groupedViewport = {
  semanticKey: brunoTableTestSemanticQueryKey,
  replace(
    request: Readonly<{ readonly query: unknown; readonly sink: NonNullable<typeof groupedSink> }>,
  ) {
    groupedReplaceCalls += 1;
    groupedSink = request.sink;
    groupedQuery = request.query as NonNullable<typeof groupedQuery>;
    return {
      setWindow: () => undefined,
      release: () => {
        groupedReleaseCalls += 1;
      },
    };
  },
};
groupedAdapter.reconcileSource({
  viewport: groupedViewport,
  completeRawSelect: ["region", "value"],
  totalRows: virtualRowCount,
  version: 1,
  status: "ready",
});
groupedAdapter.replace(groupedViewport, {
  generation: 1,
  navigationMode: "reset",
  filters: [],
  quickFilter: "",
  orderBy: [{ columnId: "COL_ID_REGION", direction: "asc" }],
  groupBy: ["COL_ID_REGION"],
  groupOrderBy: [{ columnId: "COL_ID_MAX_VALUE", direction: "desc" }],
});
groupedSink!.setRowCount(virtualRowCount, true);
const groupedAliases = Object.entries(groupedQuery!.aggregates);
const groupedRowsAlias = groupedAliases.find(([, aggregate]) => aggregate.aggFunc === "count")![0];
const groupedMinAlias = groupedAliases.find(([, aggregate]) => aggregate.aggFunc === "min")![0];
const groupedMaxAlias = groupedAliases.find(([, aggregate]) => aggregate.aggFunc === "max")![0];
let groupedIteration = 0;

describe("BrunoTable grouped Server adapter benchmark", () => {
  afterAll(() => {
    assertP99FrameBudget("Grouped Server adapter 20 Hz publication", groupedAdapterDurationsMs);
    if (groupedReplaceCalls !== 1 || groupedReleaseCalls !== 0) {
      throw new Error("Grouped value/window publications replaced their semantic generation.");
    }
  });

  bench(
    "decodes private aliases into a bounded sparse grouped window",
    () => {
      groupedIteration += 1;
      const firstRow = (groupedIteration * 3571) % (virtualRowCount - windowSize);
      const rows: Record<number, Readonly<Record<string, unknown>>> = {};
      const keys: Record<number, string> = {};
      for (let index = firstRow; index < firstRow + windowSize; index += 1) {
        rows[index] = Object.freeze({
          region: `region-${String(index)}`,
          [groupedRowsAlias]: 3n,
          [groupedMinAlias]: index,
          [groupedMaxAlias]: index + 2,
        });
        keys[index] = `authoritative-group-${String(index)}`;
      }
      const startedAt = performance.now();
      groupedAdapter.setRequiredRange(firstRow, firstRow + windowSize);
      groupedSink!.setRowData(rows, keys);
      groupedAdapterDurationsMs.push(performance.now() - startedAt);
      const rowSpace = groupedAdapter.getPublication().rowSpace;
      if (rowSpace === undefined || rowSpace.loadedRows > windowSize) {
        throw new Error("Grouped Server adapter exceeded its bounded sparse window.");
      }
    },
    { iterations: 100, time: 0, warmupIterations, warmupTime: 0 },
  );
});

const equivalenceColumnCount = 40;
const equivalenceColumns = compileColumns(
  Array.from({ length: equivalenceColumnCount }, (_, index) => ({
    columnId: `COL_ID_VALUE_${String(index)}`,
    field: `value${String(index)}`,
    headerName: `Value ${String(index)}`,
    valueType: "number" as const,
  })),
);
type EquivalenceRow = Readonly<Record<string, number>>;
let equivalenceSink:
  | Readonly<{
      readonly setRowData: (
        rows: Readonly<Record<number, EquivalenceRow>>,
        keys: Readonly<Record<number, string>>,
      ) => void;
    }>
  | undefined;
const equivalenceAdapter = new BrunoTableServerRowPipelineAdapter<EquivalenceRow>(
  equivalenceColumns,
  undefined,
  [],
  [{ columnId: "COL_ID_VALUE_0", direction: "asc" }],
);
const equivalenceViewport = {
  semanticKey: brunoTableTestSemanticQueryKey,
  replace(request: Readonly<{ readonly sink: NonNullable<typeof equivalenceSink> }>) {
    equivalenceSink = request.sink;
    return { setWindow: () => undefined, release: () => undefined };
  },
};
equivalenceAdapter.reconcileSource({
  viewport: equivalenceViewport,
  completeRawSelect: [
    "value0",
    ...Array.from(
      { length: equivalenceColumnCount - 1 },
      (_, index) => `value${String(index + 1)}`,
    ),
  ],
  totalRows: 0,
  version: 0,
  status: "ready",
});
equivalenceAdapter.replace(equivalenceViewport, {
  generation: 0,
  navigationMode: "reconcile",
  filters: [],
  quickFilter: "",
  orderBy: [{ columnId: "COL_ID_VALUE_0", direction: "asc" }],
});
const equivalenceKeys: Record<number, string> = {};
const firstEquivalenceRows: Record<number, EquivalenceRow> = {};
for (let rowIndex = 0; rowIndex < windowSize; rowIndex += 1) {
  equivalenceKeys[rowIndex] = `equivalent-row-${String(rowIndex)}`;
  firstEquivalenceRows[rowIndex] = Object.freeze(
    Object.fromEntries(
      Array.from({ length: equivalenceColumnCount }, (_, columnIndex) => [
        `value${String(columnIndex)}`,
        rowIndex * equivalenceColumnCount + columnIndex,
      ]),
    ),
  );
}
equivalenceAdapter.setRequiredRange(0, windowSize);
equivalenceSink!.setRowData(firstEquivalenceRows, equivalenceKeys);
const retainedEquivalenceRows = Object.freeze(
  Object.fromEntries(
    Object.values(equivalenceKeys).map((rowId) => [
      rowId,
      equivalenceAdapter.getPublication().rowSpace!.getRow(rowId),
    ]),
  ),
);
for (const rowId of Object.values(equivalenceKeys)) {
  if (retainedEquivalenceRows[rowId] === undefined) {
    throw new Error(`Equivalence benchmark setup did not admit row ${rowId}.`);
  }
}
const equivalenceDurationsMs: number[] = [];
const affectedSlotDurationsMs: number[] = [];
const affectedRuntime = new BrunoTableGridRuntime(
  equivalenceAdapter.getPublication(),
  equivalenceColumns,
  equivalenceAdapter.getQueryConfiguration(),
  "TABLE_ID_SERVER_AFFECTED_SLOT_BENCHMARK",
);
let affectedCellReads = 0;
equivalenceAdapter.subscribePublication(() => {
  const publication = equivalenceAdapter.getPublication();
  const rowSpace = publication.rowSpace;
  affectedRuntime.publish(
    rowSpace === undefined
      ? publication
      : {
          ...publication,
          rowSpace: {
            ...rowSpace,
            getCellValue(rowId, columnId) {
              affectedCellReads += 1;
              return rowSpace.getCellValue(rowId, columnId);
            },
          },
        },
  );
});
const affectedView = affectedRuntime.getView();
for (const rowId of Object.values(equivalenceKeys)) {
  for (const column of equivalenceColumns) {
    affectedView.subscribeCell(rowId, column.columnId, () => undefined);
  }
}
let affectedIteration = 0;

describe("BrunoTable Server repeated equivalent publication benchmark", () => {
  afterAll(() => {
    assertP99FrameBudget("Server equivalent-row publication", equivalenceDurationsMs);
  });

  bench(
    "retains references for fresh equivalent 40-column rows at 20 Hz-style cadence",
    () => {
      const freshRows: Record<number, EquivalenceRow> = {};
      for (let rowIndex = 0; rowIndex < windowSize; rowIndex += 1) {
        freshRows[rowIndex] = Object.freeze({ ...firstEquivalenceRows[rowIndex]! });
      }
      const startedAt = performance.now();
      equivalenceSink!.setRowData(freshRows, equivalenceKeys);
      equivalenceDurationsMs.push(performance.now() - startedAt);
      const rowSpace = equivalenceAdapter.getPublication().rowSpace!;
      for (const rowId of Object.values(equivalenceKeys)) {
        if (rowSpace.getRow(rowId) !== retainedEquivalenceRows[rowId]) {
          throw new Error("Equivalent source delivery replaced a stable row reference.");
        }
      }
    },
    { iterations: 100, time: 0, warmupIterations, warmupTime: 0 },
  );
});

describe("BrunoTable Server affected-slot publication benchmark", () => {
  afterAll(() => {
    assertP99FrameBudget("Server affected-slot publication", affectedSlotDurationsMs);
  });

  bench(
    "updates one of 60 mounted rows without scanning 2,400 cell subscriptions",
    () => {
      affectedIteration += 1;
      const rowIndex = affectedIteration % windowSize;
      const rowId = equivalenceKeys[rowIndex]!;
      const previous = equivalenceAdapter.getPublication().rowSpace!.getRow(rowId)!;
      const next = Object.freeze({
        ...previous,
        value0: previous["value0"]! + 1,
      });
      affectedCellReads = 0;
      const startedAt = performance.now();
      equivalenceSink!.setRowData({ [rowIndex]: next }, { [rowIndex]: rowId });
      affectedSlotDurationsMs.push(performance.now() - startedAt);
      if (affectedCellReads !== equivalenceColumnCount) {
        throw new Error(
          `Affected-slot publication read ${String(affectedCellReads)} cells instead of ${String(equivalenceColumnCount)}.`,
        );
      }
    },
    { iterations: 100, time: 0, warmupIterations, warmupTime: 0 },
  );
});

const queryColumnCount = 256;
const queryColumns = compileColumns(
  Array.from({ length: queryColumnCount }, (_, index) => ({
    columnId: `COL_ID_QUERY_${String(index)}`,
    field: `field${String(index)}`,
    headerName: `Query ${String(index)}`,
    valueType: "number" as const,
  })),
);
const queryFilters = Object.freeze(
  Array.from({ length: 128 }, (_, index) =>
    Object.freeze({
      columnId: `COL_ID_QUERY_${String(index)}`,
      type: "greaterThanOrEqual",
      filter: index,
    }),
  ),
);
const queryQuickFields = Object.freeze(
  Array.from({ length: 64 }, (_, index) => `quick${String(index)}`),
);
const queryVisibleColumnIds = Object.freeze(
  Array.from({ length: 128 }, (_, index) => `COL_ID_QUERY_${String(index * 2)}`),
);
const queryCompileDurationsMs: number[] = [];

describe("BrunoTable Server large semantic-query compilation benchmark", () => {
  afterAll(() => {
    assertP99FrameBudget("Server 256-column query compilation", queryCompileDurationsMs);
  });

  bench(
    "compiles route, projection, 128 Grid Filters, and 64 Quick Filter fields",
    () => {
      const startedAt = performance.now();
      const plan = compileBrunoTableServerQueryPlan(
        queryColumns,
        {
          routeBy: { region: "emea", revision: 9_007_199_254_740_993n },
          externalFilters: [{ field: "tenant", type: "equals", filter: "primary" }],
          filters: queryFilters,
          quickFilter: "risk",
          quickFilterFields: queryQuickFields,
          visibleColumnIds: queryVisibleColumnIds,
          orderBy: [{ columnId: "COL_ID_QUERY_0", direction: "asc" }],
        },
        undefined,
      );
      queryCompileDurationsMs.push(performance.now() - startedAt);
      if (plan.query.where.length !== 130 || plan.query.select.length !== 192) {
        throw new Error("Large Server query benchmark compiled the wrong semantic shape.");
      }
    },
    { iterations: 100, time: 0, warmupIterations, warmupTime: 0 },
  );
});

const facetValueCount = 1_000;
const facetRows = Object.freeze(
  Array.from({ length: facetValueCount }, (_, index) =>
    Object.freeze({
      amount: 9_007_199_254_740_993n + BigInt(index),
      __bruno_table_facet_count: BigInt((index % 97) + 1),
    }),
  ),
);
const facetColumn = compileColumns([
  {
    columnId: "COL_ID_FACET_AMOUNT",
    enableSetFilter: true,
    field: "amount",
    headerName: "Amount",
    valueType: "bigint",
  },
])[0]!;
const facetPublicationDurationsMs: number[] = [];

describe("BrunoTable Server whole-result facet publication benchmark", () => {
  afterAll(() => {
    assertP99FrameBudget("Server 1,000-value facet publication", facetPublicationDurationsMs);
  });

  bench(
    "projects 1,000 exact bigint facet values and retains absent inclusion intent",
    () => {
      const absentValue = 9_007_199_254_742_993n;
      const startedAt = performance.now();
      const snapshot = createBrunoTableServerFacetSnapshot({
        column: facetColumn,
        countAlias: "__bruno_table_facet_count",
        rows: facetRows,
        expression: {
          columnId: "COL_ID_FACET_AMOUNT",
          type: "in",
          filter: [facetRows[0]!.amount, absentValue],
        },
      });
      facetPublicationDurationsMs.push(performance.now() - startedAt);
      if (
        snapshot.options.length !== facetValueCount + 1 ||
        snapshot.options.at(-1)?.count !== 0n
      ) {
        throw new Error("Large Server facet benchmark projected the wrong live domain.");
      }
    },
    { iterations: 100, time: 0, warmupIterations, warmupTime: 0 },
  );
});
