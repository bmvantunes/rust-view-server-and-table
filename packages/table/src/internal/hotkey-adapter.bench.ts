import { afterAll, describe } from "vite-plus/test";
import { bench } from "../../scripts/benchmark-adapter";

import { compileColumns } from "./compile-columns";
import {
  BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_FILTER_WORKFLOW_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_GRID_HOTKEYS,
  BRUNO_TABLE_GROUP_BY_HOTKEY_REGISTRATION_COUNT,
  brunoTableHotkeyRegistrationBound,
} from "./hotkey-adapter";
import { BrunoTableNavigationRuntime } from "./navigation";

const referenceFrameBudgetMs = 8.33;
const heldGestureCount = 100;
const mountedRows = 80;
const mountedColumns = 24;
const logicalRowCount = 10_000;
const logicalColumnCount = 240;
const columns = compileColumns(
  Array.from({ length: logicalColumnCount }, (_unused, index) => ({
    columnId: `COL_ID_HOTKEY_BENCH_${String(index).padStart(3, "0")}`,
    field: "value" as const,
    headerName: `Hotkey benchmark ${String(index)}`,
    valueType: "text" as const,
  })),
);
const rowSpace = Object.freeze({
  totalRows: logicalRowCount,
  getRowId: (index: number) => `row-${String(index)}`,
  findRowIndex: (rowId: string) => {
    const index = Number(rowId.slice(4));
    return Number.isInteger(index) && index >= 0 && index < logicalRowCount ? index : undefined;
  },
});

function createNavigation(): BrunoTableNavigationRuntime {
  const navigation = new BrunoTableNavigationRuntime();
  navigation.setShape(rowSpace, columns);
  return navigation;
}

function percentile99(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] ?? 0;
}

describe("BrunoTable navigation command seam benchmark (8.33 ms/120 Hz reference)", () => {
  const navigation = createNavigation();
  let direction: "up" | "down" = "down";

  bench(
    "dispatches 100 already-matched held-arrow commands through the navigation runtime",
    () => {
      for (let gesture = 0; gesture < heldGestureCount; gesture += 1) {
        navigation.navigate({ type: "step", direction });
      }
      direction = direction === "down" ? "up" : "down";
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  const diagnosticNavigation = createNavigation();
  const diagnosticSamples: number[] = [];
  let diagnosticDirection: "up" | "down" = "down";

  afterAll(() => {
    const heldNavigationP99Ms = percentile99(diagnosticSamples);
    if (diagnosticSamples.length !== 100 || heldNavigationP99Ms > referenceFrameBudgetMs) {
      throw new Error("The held-navigation diagnostic missed its sample count or frame budget.");
    }
    console.log(
      JSON.stringify({
        benchmark: "BrunoTable already-matched held-navigation command seam",
        referenceFrameBudgetMs,
        heldGestureCount,
        heldNavigationP99Ms,
        heldNavigationP99WithinReference: heldNavigationP99Ms <= referenceFrameBudgetMs,
        bindingDefinitionsPerTable: brunoTableHotkeyRegistrationBound(mountedRows, mountedColumns),
        bindingDefinitionsWithFilterWorkflow: brunoTableHotkeyRegistrationBound(
          mountedRows,
          mountedColumns,
          1,
        ),
        bindingDefinitionsWithGrouping: brunoTableHotkeyRegistrationBound(
          mountedRows,
          mountedColumns,
          0,
          false,
          true,
        ),
        bindingDefinitionsWithEditMemory: brunoTableHotkeyRegistrationBound(
          mountedRows,
          mountedColumns,
          0,
          false,
          false,
          false,
          true,
        ),
        expectedBaseBindingDefinitions: BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT,
        expectedFilterWorkflowBindingDefinitions:
          BRUNO_TABLE_FILTER_WORKFLOW_HOTKEY_REGISTRATION_COUNT,
        expectedGroupByBindingDefinitions: BRUNO_TABLE_GROUP_BY_HOTKEY_REGISTRATION_COUNT,
        declaredGridHotkeys: BRUNO_TABLE_GRID_HOTKEYS.length,
        mountedRows,
        mountedColumns,
      }),
    );
  });

  bench(
    "diagnostic p99 for the navigation seam and table/workflow registration bounds",
    () => {
      const startedAt = performance.now();
      for (let gesture = 0; gesture < heldGestureCount; gesture += 1) {
        diagnosticNavigation.navigate({ type: "step", direction: diagnosticDirection });
      }
      diagnosticSamples.push(performance.now() - startedAt);
      diagnosticDirection = diagnosticDirection === "down" ? "up" : "down";
    },
    { iterations: 100, time: 0, warmupIterations: 0, warmupTime: 0 },
  );
});
