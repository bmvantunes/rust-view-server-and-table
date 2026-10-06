import { afterAll, describe } from "vite-plus/test";
import { bench } from "../../scripts/benchmark-adapter";

import { BrunoTableRowSelectionRuntime } from "./row-selection";

const residentRows = 10_000;
const referenceFrameBudgetMs = 8.33;
const rowIds = Object.freeze(
  Array.from({ length: residentRows }, (_unused, index) => `row-${String(index)}`),
);
const selection = new BrunoTableRowSelectionRuntime(rowIds);
const gestureSelection = new BrunoTableRowSelectionRuntime(rowIds);
const repeatedSelectAllSelection = new BrunoTableRowSelectionRuntime(rowIds);
const repeatedClearAllSelection = new BrunoTableRowSelectionRuntime(rowIds);
const sourceSnapshotToken = Object.freeze({});
repeatedSelectAllSelection.toggleAll(true);
let headerNotifications = 0;
let rowNotifications = 0;
let gestureHeaderNotifications = 0;
let gestureRowNotifications = 0;
selection.subscribeHeader(() => {
  headerNotifications += 1;
});
for (let index = 0; index < 256; index += 1) {
  selection.subscribeRow(rowIds[index]!, () => {
    rowNotifications += 1;
  });
  gestureSelection.subscribeRow(rowIds[index]!, () => {
    gestureRowNotifications += 1;
  });
}
gestureSelection.subscribeHeader(() => {
  gestureHeaderNotifications += 1;
});
const publicationDurationsMs: number[] = [];
const gestureDurationsMs: number[] = [];
const repeatedSelectAllDurationsMs: number[] = [];

describe("BrunoTable Row Selection benchmark (8.33 ms/120 Hz reference)", () => {
  afterAll(() => {
    const p99Ms = percentile99(publicationDurationsMs);
    const gestureP99Ms = percentile99(gestureDurationsMs);
    const repeatedSelectAllP99Ms = percentile99(repeatedSelectAllDurationsMs);
    process.stdout.write(
      `${JSON.stringify({
        benchmark: "BrunoTable Row Selection",
        residentRows,
        mountedRowSubscriptions: 256,
        valuePublications: publicationDurationsMs.length,
        headerNotifications,
        rowNotifications,
        p99Ms,
        gestureP99Ms,
        repeatedSelectAllP99Ms,
        referenceFrameBudgetMs,
      })}\n`,
    );
    if (headerNotifications !== 0 || rowNotifications !== 0) {
      throw new Error("Value-only publications notified Row Selection subscribers.");
    }
    if (p99Ms > referenceFrameBudgetMs) {
      throw new Error(
        `Row Selection publication isolation p99 exceeded ${String(referenceFrameBudgetMs)} ms: ${String(p99Ms)} ms.`,
      );
    }
    if (gestureP99Ms > referenceFrameBudgetMs) {
      throw new Error(
        `Row Selection Select All p99 exceeded ${String(referenceFrameBudgetMs)} ms: ${String(gestureP99Ms)} ms.`,
      );
    }
    if (repeatedSelectAllP99Ms > referenceFrameBudgetMs) {
      throw new Error(
        `Row Selection repeated Select All p99 exceeded ${String(referenceFrameBudgetMs)} ms: ${String(repeatedSelectAllP99Ms)} ms.`,
      );
    }
  });

  bench(
    "reconciles 20 Hz-style value publications without selection notifications",
    () => {
      const startedAt = performance.now();
      selection.reconcile(Array.from(rowIds), Array.from(rowIds), sourceSnapshotToken);
      publicationDurationsMs.push(performance.now() - startedAt);
    },
    { iterations: 100, time: 0, warmupIterations: 10, warmupTime: 0 },
  );

  let gestureChecked = false;
  bench(
    "selects or deselects 10,000 identities with 256 mounted row subscribers",
    () => {
      const previousHeaderNotifications = gestureHeaderNotifications;
      const previousRowNotifications = gestureRowNotifications;
      const startedAt = performance.now();
      gestureChecked = !gestureChecked;
      gestureSelection.toggleAll(gestureChecked);
      gestureDurationsMs.push(performance.now() - startedAt);
      if (gestureHeaderNotifications !== previousHeaderNotifications + 1) {
        throw new Error("One Select All gesture did not notify the header exactly once.");
      }
      if (gestureRowNotifications !== previousRowNotifications + 256) {
        throw new Error("One Select All gesture did not notify each mounted affected row once.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 10, warmupTime: 0 },
  );

  bench(
    "repeats already-satisfied select and clear commands with zero projected visits",
    () => {
      const startedAt = performance.now();
      const selectedVisits = repeatedSelectAllSelection.toggleAll(true);
      const clearedVisits = repeatedClearAllSelection.toggleAll(false);
      repeatedSelectAllDurationsMs.push(performance.now() - startedAt);
      if (selectedVisits !== 0 || clearedVisits !== 0) {
        throw new Error("An already-satisfied selection command visited the projection.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 10, warmupTime: 0 },
  );
});

function percentile99(samples: readonly number[]): number {
  const sorted = samples.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)] ?? 0;
}
