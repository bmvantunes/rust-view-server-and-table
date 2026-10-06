import { describe } from "vite-plus/test";
import { bench } from "../../scripts/benchmark-adapter";

import { compileColumns, type CompiledColumn } from "./compile-columns";
import {
  deriveBrunoTableClientGroupedProjection,
  type BrunoTableClientGroupedProjection,
  type BrunoTableClientGroupingInputRow,
} from "./client-grouping";

type BenchmarkRow = Readonly<{
  region: string;
  active: boolean;
  desk: string;
  amount: bigint;
  price: number;
}>;

const referenceFrameBudgetMs = 8.33;
const residentRowCount = 2_000;
const columns = compileColumns([
  {
    columnId: "COL_ID_REGION",
    field: "region",
    headerName: "Region",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_ACTIVE",
    field: "active",
    headerName: "Active",
    valueType: "boolean",
    groupBy: true,
  },
  {
    columnId: "COL_ID_AMOUNT_SUM",
    field: "amount",
    headerName: "Amount sum",
    valueType: "bigint",
    aggFunc: "sum",
  },
  {
    columnId: "COL_ID_AMOUNT_MAX",
    field: "amount",
    headerName: "Amount maximum",
    valueType: "bigint",
    aggFunc: "max",
  },
  {
    columnId: "COL_ID_PRICE_MAX",
    field: "price",
    headerName: "Price maximum",
    valueType: "number",
    aggFunc: "max",
  },
  {
    columnId: "COL_ID_DESK_DISTINCT",
    field: "desk",
    headerName: "Distinct desks",
    valueType: "text",
    aggFunc: "countDistinct",
  },
]);
const groupBy = Object.freeze(["COL_ID_REGION", "COL_ID_ACTIVE"]);
const groupOrderBy = Object.freeze([
  Object.freeze({ columnId: "COL_ID_REGION", direction: "asc" as const }),
  Object.freeze({ columnId: "COL_ID_AMOUNT_SUM", direction: "desc" as const }),
]);
const baseRows = Object.freeze(
  Array.from({ length: residentRowCount }, (_unused, rowIndex) =>
    createInputRow(rowIndex, {
      region: `region-${String(rowIndex % 25)}`,
      active: rowIndex % 2 === 0,
      desk: `desk-${String(rowIndex % 80)}`,
      amount: BigInt((rowIndex % 10_000) + 1),
      price: (rowIndex % 1_000) / 10,
    }),
  ),
);

function createInputRow(rowIndex: number, raw: BenchmarkRow): BrunoTableClientGroupingInputRow {
  return Object.freeze({
    raw,
    rowId: `row-${String(rowIndex)}`,
    rowIndex,
    readValue: (column: CompiledColumn) =>
      column.kind === "field" ? raw[column.field as keyof BenchmarkRow] : undefined,
  });
}

function derive(
  rows: readonly BrunoTableClientGroupingInputRow[],
  previous?: BrunoTableClientGroupedProjection,
): BrunoTableClientGroupedProjection {
  return deriveBrunoTableClientGroupedProjection({
    rows,
    columns,
    groupBy,
    groupOrderBy,
    ...(previous === undefined ? {} : { previous }),
  });
}

function percentile99(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] ?? 0;
}

describe("BrunoTable Client grouping benchmark (8.33 ms/120 Hz reference)", () => {
  let livePrevious = derive(baseRows);
  let diagnosticPrevious = derive(baseRows);
  let liveRows = baseRows;
  let diagnosticRows = baseRows;
  let liveIteration = 0;
  const diagnosticSamples: number[] = [];
  let diagnosticPrinted = false;

  bench(
    "derives 2,000 rows with two keys and four participating aggregates",
    () => {
      const projection = derive(baseRows);
      if (projection.kind !== "ready") throw new Error(projection.invalid.message);
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "reconciles a one-row live update through the complete grouped result",
    () => {
      const rowIndex = liveIteration++ % residentRowCount;
      const original = liveRows[rowIndex]!;
      const raw = original.raw as BenchmarkRow;
      const changed = createInputRow(rowIndex, { ...raw, amount: raw.amount + 1n });
      const nextRows = Object.freeze([
        ...liveRows.slice(0, rowIndex),
        changed,
        ...liveRows.slice(rowIndex + 1),
      ]);
      const projection = derive(nextRows, livePrevious);
      if (projection.kind !== "ready") throw new Error(projection.invalid.message);
      liveRows = nextRows;
      livePrevious = projection;
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "diagnostic p99 for complete grouped live derivation (8.33 ms reference)",
    () => {
      const rowIndex = diagnosticSamples.length % residentRowCount;
      const original = diagnosticRows[rowIndex]!;
      const raw = original.raw as BenchmarkRow;
      const changed = createInputRow(rowIndex, { ...raw, amount: raw.amount + 1n });
      const nextRows = Object.freeze([
        ...diagnosticRows.slice(0, rowIndex),
        changed,
        ...diagnosticRows.slice(rowIndex + 1),
      ]);
      const startedAt = performance.now();
      const projection = derive(nextRows, diagnosticPrevious);
      diagnosticSamples.push(performance.now() - startedAt);
      if (projection.kind !== "ready") throw new Error(projection.invalid.message);
      diagnosticRows = nextRows;
      diagnosticPrevious = projection;
      if (!diagnosticPrinted && diagnosticSamples.length >= 100) {
        diagnosticPrinted = true;
        const p99Ms = percentile99(diagnosticSamples);
        process.stdout.write(
          `${JSON.stringify({
            benchmark: "BrunoTable Client grouping",
            residentRowCount,
            groupKeyCount: groupBy.length,
            participatingAggregateCount: 4,
            referenceFrameBudgetMs,
            p99Ms,
            p99WithinReference: p99Ms <= referenceFrameBudgetMs,
          })}\n`,
        );
        if (p99Ms > referenceFrameBudgetMs) {
          throw new Error(
            `BrunoTable Client grouping p99 ${p99Ms.toFixed(3)} ms exceeded ${referenceFrameBudgetMs.toFixed(2)} ms.`,
          );
        }
      }
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );
});
