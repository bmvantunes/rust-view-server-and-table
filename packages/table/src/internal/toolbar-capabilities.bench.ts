import { afterAll, describe } from "vite-plus/test";
import { bench } from "../../scripts/benchmark-adapter";

import { compileColumns } from "./compile-columns";
import { BrunoTableClientRowPipelineAdapter } from "./client-source-adapter";
import { BrunoTableGridRuntime } from "./grid-runtime";

const residentRows = 10_000;
const referenceFrameBudgetMs = 8.33;
const columns = compileColumns([
  {
    columnId: "COL_ID_BENCH_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
  },
]);
const rows = Object.freeze(
  Array.from({ length: residentRows }, (_unused, index) => ({
    id: `row-${String(index)}`,
    name: `Row ${String(index)}`,
  })),
);
const changedRows = Object.freeze([
  ...rows.slice(0, residentRows - 1),
  Object.freeze({ id: `row-${String(residentRows - 1)}`, name: "Updated row" }),
]);
const adapter = new BrunoTableClientRowPipelineAdapter(
  { rows, totalRows: residentRows, version: 1, status: "ready" },
  (row) => row.id,
  columns,
  undefined,
  [{ columnId: "COL_ID_BENCH_NAME", direction: "asc" }],
);
const runtime = new BrunoTableGridRuntime(
  adapter.getPublication(),
  columns,
  {
    baselineFilters: [],
    baselineOrderBy: [{ columnId: "COL_ID_BENCH_NAME", direction: "asc" }],
  },
  "TABLE_ID_TOOLBAR_BENCH",
);
const view = runtime.getView();
let unexpectedNotifications = 0;
view.subscribeLoadedRowCount(() => {
  unexpectedNotifications += 1;
});
view.subscribeActiveFilterCount(() => {
  unexpectedNotifications += 1;
});
view.subscribeActiveSortCount(() => {
  unexpectedNotifications += 1;
});
adapter.subscribeResultRowCount(() => {
  unexpectedNotifications += 1;
});
let version = 1;
let changed = false;
let rowNotifications = 0;
let cellNotifications = 0;
view.subscribeRow(`row-${String(residentRows - 1)}`, () => {
  rowNotifications += 1;
});
const mountedCellSubscriptions = 256;
for (let index = residentRows - mountedCellSubscriptions; index < residentRows; index += 1) {
  view.subscribeCell(`row-${String(index)}`, "COL_ID_BENCH_NAME", () => {
    cellNotifications += 1;
  });
}
const warmupIterations = 10;
const durationsMs: number[] = [];

describe("BrunoTable toolbar subscription benchmark (8.33 ms/120 Hz reference)", () => {
  afterAll(() => {
    const measuredDurations = durationsMs.slice(warmupIterations);
    const sortedDurations = measuredDurations.toSorted((left, right) => left - right);
    const p99Index = Math.max(0, Math.ceil(sortedDurations.length * 0.99) - 1);
    const p99Ms = sortedDurations[p99Index];
    if (p99Ms === undefined || p99Ms > referenceFrameBudgetMs) {
      throw new Error(
        `Toolbar publication isolation p99 exceeded ${String(referenceFrameBudgetMs)} ms: ${String(p99Ms)} ms.`,
      );
    }
  });

  bench(
    "keeps the non-reentrant publication fast path within budget with 256 subscribed cells",
    () => {
      const startedAt = performance.now();
      const previousRowNotifications = rowNotifications;
      const previousCellNotifications = cellNotifications;
      version += 1;
      changed = !changed;
      runtime.publish(
        adapter.publish({
          rows: changed ? changedRows : rows,
          totalRows: residentRows,
          version,
          status: "ready",
        }),
      );
      adapter.publishResultRowCount(residentRows);
      durationsMs.push(performance.now() - startedAt);
      if (unexpectedNotifications !== 0) {
        throw new Error("Stable toolbar projections received an unrelated row notification.");
      }
      if (rowNotifications !== previousRowNotifications + 1) {
        throw new Error("One semantic row change did not produce exactly one row notification.");
      }
      if (cellNotifications !== previousCellNotifications + 1) {
        throw new Error("One semantic cell change did not produce exactly one cell notification.");
      }
    },
    { iterations: 100, time: 0, warmupIterations, warmupTime: 0 },
  );
});
