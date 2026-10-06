import { afterAll, describe } from "vite-plus/test";
import { bench } from "../../scripts/benchmark-adapter";

import {
  BrunoTableCellRangeRuntime,
  captureBrunoTableClipboardSnapshot,
  createBrunoTableCellRangeStructure,
  installBrunoTableCellRangeInstrumentationListener,
  serializeBrunoTableClipboardSnapshot,
  type BrunoTableClipboardTarget,
} from "./cell-range-clipboard";
import { BrunoTableClientRowPipelineAdapter } from "./client-source-adapter";
import { compileColumns } from "./compile-columns";
import { BrunoTableGridRuntime, isBrunoTableInvalidCellValue } from "./grid-runtime";

const referenceFrameBudgetMs = 8.33;
const copyResponsivenessBudgetMs = 50;
const residentRows = 10_000;
const logicalColumns = 240;
const rowIds = Object.freeze(
  Array.from({ length: residentRows }, (_unused, index) => `ROW_${String(index)}`),
);
const columnIds = Object.freeze(
  Array.from({ length: logicalColumns }, (_unused, index) => `COL_ID_${String(index)}`),
);
const structure = createBrunoTableCellRangeStructure(rowIds, columnIds);
const range = new BrunoTableCellRangeRuntime("TABLE_ID_CELL_RANGE_BENCH");
range.replace({ rowId: rowIds[0]!, columnId: columnIds[0]! }, structure);
let publications = 0;
let valueOnlyPublications = 0;
let extensionPublications = 0;
range.subscribe(() => {
  publications += 1;
});
const valuePublicationDurationsMs: number[] = [];
const extensionDurationsMs: number[] = [];
const snapshotDurationsMs: number[] = [];
const largeSpanMembershipDurationsMs: number[] = [];
const largeSpanRows = Object.freeze(
  Array.from({ length: 100_000 }, (_unused, index) => `LARGE_ROW_${String(index)}`),
);
const largeSpanStructure = createBrunoTableCellRangeStructure(largeSpanRows, [columnIds[0]!]);
const largeSpanRange = new BrunoTableCellRangeRuntime("TABLE_ID_CELL_RANGE_MEMBERSHIP_BENCH");
largeSpanRange.replace({ rowId: largeSpanRows[0]!, columnId: columnIds[0]! }, largeSpanStructure);
largeSpanRange.extend(
  { rowId: largeSpanRows.at(-1)!, columnId: columnIds[0]! },
  largeSpanStructure,
  "vertical",
);
let largeSpanPublications = 0;
let largeSpanMaterializations = 0;
largeSpanRange.subscribe(() => {
  largeSpanPublications += 1;
});
const removeLargeSpanInstrumentation = installBrunoTableCellRangeInstrumentationListener(
  "TABLE_ID_CELL_RANGE_MEMBERSHIP_BENCH",
  (event) => {
    if (event.kind === "identity-span-materialization") largeSpanMaterializations += 1;
  },
);

describe("BrunoTable Cell Range benchmark (8.33 ms/120 Hz reference)", () => {
  afterAll(() => {
    removeLargeSpanInstrumentation();
    const valuePublicationP99Ms = percentile99(valuePublicationDurationsMs);
    const extensionP99Ms = percentile99(extensionDurationsMs);
    const snapshotP99Ms = percentile99(snapshotDurationsMs);
    const largeSpanMembershipP99Ms = percentile99(largeSpanMembershipDurationsMs);
    process.stdout.write(
      `${JSON.stringify({
        benchmark: "BrunoTable Cell Range and atomic Copy",
        residentRows,
        logicalColumns,
        publications,
        valueOnlyPublications,
        extensionPublications,
        valuePublicationP99Ms,
        extensionP99Ms,
        snapshotP99Ms,
        largeSpanMembershipP99Ms,
        referenceFrameBudgetMs,
        copyResponsivenessBudgetMs,
      })}\n`,
    );
    if (valueOnlyPublications !== 0) {
      throw new Error("Value-only reconciliation published Cell Range state.");
    }
    if (extensionPublications !== extensionDurationsMs.length) {
      throw new Error("Expected every measured Cell Range extension to publish exactly once.");
    }
    if (largeSpanPublications !== extensionDurationsMs.length || largeSpanMaterializations !== 0) {
      throw new Error(
        "Large Cell Range extensions materialized identities or missed publications.",
      );
    }
    if (
      valuePublicationP99Ms > referenceFrameBudgetMs ||
      extensionP99Ms > referenceFrameBudgetMs ||
      largeSpanMembershipP99Ms > referenceFrameBudgetMs
    ) {
      throw new Error("Cell Range hot-path work exceeded the 120 Hz reference frame budget.");
    }
    if (snapshotP99Ms > copyResponsivenessBudgetMs) {
      throw new Error("Cell Range immutable Copy exceeded its responsiveness budget.");
    }
    if (copyRuntime.getCellCacheDiagnosticSnapshot().installed !== 0) {
      throw new Error("Cell Range Copy populated the reactive render cache.");
    }
  });

  bench(
    "retains the exact range for value-only publications without notifications",
    () => {
      const publicationsBefore = publications;
      const startedAt = performance.now();
      range.reconcile(structure);
      valuePublicationDurationsMs.push(performance.now() - startedAt);
      valueOnlyPublications += publications - publicationsBefore;
    },
    { iterations: 100, time: 0, warmupIterations: 10, warmupTime: 0 },
  );

  bench(
    "decorates 400 mounted cells across a 100,000-row span with constant-time membership",
    () => {
      const startedAt = performance.now();
      for (let mountedIndex = 0; mountedIndex < 400; mountedIndex += 1) {
        const rowId = largeSpanRows[mountedIndex * 250];
        if (rowId === undefined || !largeSpanRange.isCellSelected(rowId, columnIds[0]!)) {
          throw new Error("Expected every sampled mounted cell to remain selected.");
        }
      }
      largeSpanMembershipDurationsMs.push(performance.now() - startedAt);
    },
    { iterations: 100, time: 0, warmupIterations: 10, warmupTime: 0 },
  );

  let destination = largeSpanRows.length - 1;
  bench(
    "projects one vertical gesture over 100,000 identities without materializing the span",
    () => {
      const startedAt = performance.now();
      largeSpanRange.extend(
        { rowId: largeSpanRows[destination]!, columnId: columnIds[0]! },
        largeSpanStructure,
        "vertical",
      );
      extensionDurationsMs.push(performance.now() - startedAt);
      extensionPublications += 1;
      destination =
        destination === largeSpanRows.length - 1
          ? largeSpanRows.length - 2
          : largeSpanRows.length - 1;
    },
    { iterations: 100, time: 0, warmupIterations: 10, warmupTime: 0 },
  );

  const copyTarget: BrunoTableClipboardTarget = {
    axis: "vertical",
    rowIds: [rowIds[0]!, ...rowIds.slice(1)],
    columnIds: [columnIds[0]!],
  };
  const copyColumns = compileColumns([
    {
      columnId: columnIds[0]!,
      field: "value",
      headerName: "Value",
      valueType: "bigint",
    },
  ]);
  const copyRows = rowIds.map((rowId, index) => ({
    id: rowId,
    value: BigInt(index) + 9_007_199_254_740_993n,
  }));
  const copyAdapter = new BrunoTableClientRowPipelineAdapter(
    { rows: copyRows, totalRows: copyRows.length, version: 1, status: "ready" },
    (row) => row.id,
    copyColumns,
    undefined,
    [{ columnId: columnIds[0]!, direction: "asc" }],
  );
  const copyRuntime = new BrunoTableGridRuntime(
    copyAdapter.getPublication(),
    copyColumns,
    copyAdapter.getQueryConfiguration(copyColumns),
    "TABLE_ID_CELL_RANGE_COPY_BENCH",
  );
  bench(
    "captures and serializes one immutable 10,000-cell vertical Clipboard Snapshot",
    () => {
      const startedAt = performance.now();
      const readCell = copyRuntime.captureCellCommandReader();
      const snapshot = captureBrunoTableClipboardSnapshot(copyTarget, ({ rowId, columnId }) => {
        const cell = readCell(rowId, columnId);
        if (
          cell.kind !== "available" ||
          !cell.rowPresent ||
          cell.column === undefined ||
          isBrunoTableInvalidCellValue(cell.value)
        ) {
          return undefined;
        }
        return {
          value: cell.value,
          formatCanonicalText: cell.column.semantics.formatCanonicalText,
        };
      });
      if (snapshot === undefined) throw new Error("Expected a complete Clipboard Snapshot.");
      serializeBrunoTableClipboardSnapshot(snapshot);
      snapshotDurationsMs.push(performance.now() - startedAt);
    },
    { iterations: 100, time: 0, warmupIterations: 10, warmupTime: 0 },
  );
});

function percentile99(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)] ?? 0;
}
