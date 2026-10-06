import { describe } from "vite-plus/test";
import { bench } from "../../scripts/benchmark-adapter";

import {
  BrunoTableCellEditRuntime,
  type BrunoTableCellEditDraftSnapshot,
  type BrunoTableCellEditSaveChangeSet,
} from "./cell-edit";
import { assertBrunoTableBenchmarkBudget } from "./benchmark-budget";
import { compileColumns } from "./compile-columns";
import { BrunoTableEditMemoryRuntime } from "./edit-memory";

const referenceFrameBudgetMs = 8.33;
const warmupSampleCount = 2;
const measuredSampleCount = 100;
const gestureCellCount = 5_000;
const row = Object.freeze({ value: "server" });
const isEditable = ({ value }: { readonly value: string }) => value.length > 0;
const compileBenchmarkColumns = (permission: true | false | typeof isEditable = isEditable) =>
  compileColumns([
    {
      columnId: "COL_ID_VALUE",
      field: "value",
      headerName: "Value",
      valueType: "text",
      isEditable: permission,
    },
  ]);
const columns = compileBenchmarkColumns();
const equivalentColumns = [compileBenchmarkColumns(), compileBenchmarkColumns()] as const;
const blockedColumns = compileBenchmarkColumns(false);
const changes = Array.from(
  { length: gestureCellCount },
  (_unused, index): BrunoTableCellEditDraftSnapshot =>
    Object.freeze({
      rowId: `row-${String(index)}`,
      columnId: "COL_ID_VALUE",
      field: "value",
      baseRow: row,
      expectedVersion: index,
      base: "server",
      mine: `draft-${String(index)}`,
    }),
);
const firstChange = changes[0];
if (firstChange === undefined) throw new Error("Edit-memory benchmark gesture must be non-empty.");
const gesture: readonly [BrunoTableCellEditDraftSnapshot, ...BrunoTableCellEditDraftSnapshot[]] = [
  firstChange,
  ...changes.slice(1),
];

function createRuntime(onRowRead?: () => void): BrunoTableCellEditRuntime {
  const runtime = new BrunoTableCellEditRuntime({
    columns,
    getRow: () => {
      onRowRead?.();
      return row;
    },
  });
  runtime.setBatchHistoryEnabled(true);
  return runtime;
}

function recordBudgetSample(
  name: string,
  samples: number[],
  elapsedMs: number,
  warmups = warmupSampleCount,
): void {
  samples.push(elapsedMs);
  assertBrunoTableBenchmarkBudget(name, samples, {
    budgetMs: referenceFrameBudgetMs,
    measuredSampleCount,
    warmupSampleCount: warmups,
  });
}

function collectBenchmarkGarbage(): void {
  const collect = (globalThis as typeof globalThis & { readonly gc?: () => void }).gc;
  if (collect === undefined) {
    throw new Error(
      "Edit-memory benchmarks require --expose-gc; run the package test:bench:cell-edit script.",
    );
  }
  collect();
}

describe("BrunoTable sparse edit-memory benchmark (8.33 ms/120 Hz reference)", () => {
  const applySamples: number[] = [];
  const undoSamples: number[] = [];
  const redoSamples: number[] = [];
  const runtime = createRuntime();
  let rowReads = 0;
  const reconciliationRuntime = createRuntime(() => {
    rowReads += 1;
  });
  if (!reconciliationRuntime.applyAcceptedDraftGesture(gesture)) {
    throw new Error("The reconciliation fixture was not accepted.");
  }

  const saveRows = new Map<string, Readonly<{ readonly value: string; readonly revision: bigint }>>(
    Array.from({ length: gestureCellCount }, (_unused, index) => [
      `save-row-${String(index)}`,
      Object.freeze({ value: "server", revision: 1n }),
    ]),
  );
  let saveRowReads = 0;
  const saveReconciliationRuntime = new BrunoTableCellEditRuntime({
    columns,
    getRow: (rowId) => {
      saveRowReads += 1;
      return saveRows.get(rowId);
    },
    getRowVersion: (candidate) => (candidate as Readonly<{ readonly revision: bigint }>).revision,
  });
  const saveChangeRows = [...saveRows].map(([rowId, baseRow]) =>
    Object.freeze({
      rowId,
      baseRow,
      expectedVersion: baseRow.revision,
      changes: Object.freeze([
        Object.freeze({
          columnId: "COL_ID_VALUE",
          field: "value",
          before: "server",
          after: "submitted",
        }),
      ]),
    }),
  );
  const firstSaveChangeRow = saveChangeRows[0];
  if (firstSaveChangeRow === undefined)
    throw new Error("Save benchmark fixture must be non-empty.");
  const saveChangeSet = Object.freeze([
    firstSaveChangeRow,
    ...saveChangeRows.slice(1),
  ]) as BrunoTableCellEditSaveChangeSet;
  if (!saveReconciliationRuntime.beginSaveOperation("save-operation", saveChangeSet, false)) {
    throw new Error("Save benchmark fixture could not acquire its Immediate locks.");
  }
  saveReconciliationRuntime.acceptSave("save-operation", saveChangeSet, false);
  let saveReconciliationIndex = 0;
  const saveReconciliationSamples: number[] = [];
  bench(
    "reconciles and unlocks one row in a 5,000-row Immediate operation without global scans",
    () => {
      const rowId = `save-row-${String(saveReconciliationIndex)}`;
      saveReconciliationIndex += 1;
      const previousCount =
        saveReconciliationRuntime.getAcceptedOverlayCountForOperation("save-operation");
      saveRows.set(rowId, Object.freeze({ value: "submitted", revision: 2n }));
      saveRowReads = 0;
      const startedAt = performance.now();
      saveReconciliationRuntime.reconcileSourceRows(new Set([rowId]));
      recordBudgetSample(
        "one-row Immediate Save reconciliation",
        saveReconciliationSamples,
        performance.now() - startedAt,
      );
      if (
        saveReconciliationRuntime.getAcceptedOverlayCountForOperation("save-operation") !==
        previousCount - 1
      ) {
        throw new Error("One-row Save reconciliation changed the wrong overlay count.");
      }
      if (saveRowReads !== 1) {
        throw new Error("One-row Immediate Save reconciliation visited unrelated source rows.");
      }
      if (!saveReconciliationRuntime.isEditable(rowId, "COL_ID_VALUE")) {
        throw new Error("One-row Save reconciliation retained its Immediate lock.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 2, warmupTime: 0, throws: true },
  );

  const rejectedRows = new Map(saveRows);
  let rejectedRowReads = 0;
  const rejectedReconciliationRuntime = new BrunoTableCellEditRuntime({
    columns,
    getRow: (rowId) => {
      rejectedRowReads += 1;
      return rejectedRows.get(rowId);
    },
  });
  rejectedReconciliationRuntime.rejectSave("rejected-operation", saveChangeSet, false);
  const rejectedFailureMemory = new BrunoTableEditMemoryRuntime();
  rejectedFailureMemory.activate();
  rejectedFailureMemory.recordSaveFailure(
    "rejected-operation",
    new Error("Benchmark rejection."),
    saveChangeSet,
  );
  let lastRejectedUpdate =
    rejectedReconciliationRuntime.getRejectedOperationUpdateSnapshot("rejected-operation");
  const unsubscribeRejectedFailure = rejectedReconciliationRuntime.subscribeRejectedOperation(
    "rejected-operation",
    () => {
      lastRejectedUpdate =
        rejectedReconciliationRuntime.getRejectedOperationUpdateSnapshot("rejected-operation");
      rejectedFailureMemory.removeSaveFailureCells(
        "rejected-operation",
        lastRejectedUpdate.removedCells,
      );
    },
  );
  let rejectedReconciliationIndex = 100;
  const rejectedReconciliationSamples: number[] = [];
  bench(
    "reconciles one row in a 5,000-row rejected operation without scanning other rows",
    () => {
      const rowId = `save-row-${String(rejectedReconciliationIndex)}`;
      rejectedReconciliationIndex += 1;
      rejectedRows.set(rowId, Object.freeze({ value: "submitted", revision: 2n }));
      rejectedRowReads = 0;
      const startedAt = performance.now();
      rejectedReconciliationRuntime.reconcileSourceRows(new Set([rowId]));
      recordBudgetSample(
        "one-row rejected Save reconciliation",
        rejectedReconciliationSamples,
        performance.now() - startedAt,
      );
      if (rejectedRowReads !== 1) {
        throw new Error(
          `One-row rejected Save reconciliation read ${String(rejectedRowReads)} source rows.`,
        );
      }
      if (
        rejectedReconciliationRuntime.getCellSnapshot(rowId, "COL_ID_VALUE").saveFailed === true
      ) {
        throw new Error("One-row rejected Save reconciliation retained converged evidence.");
      }
      if (lastRejectedUpdate.removedCells.length !== 1) {
        throw new Error("Rejected Save reconciliation did not publish one Cell Identity delta.");
      }
      if (rejectedFailureMemory.getSaveFailureSummarySnapshot().count !== 1) {
        throw new Error("Partial rejected reconciliation cleared its compact failure summary.");
      }
    },
    {
      iterations: 100,
      time: 0,
      warmupIterations: 2,
      warmupTime: 0,
      teardown: (_task, mode) => {
        if (mode !== "run") return;
        saveReconciliationRuntime.activate();
        rejectedReconciliationRuntime.activate();
        unsubscribeRejectedFailure();
        rejectedFailureMemory.dispose();
        saveReconciliationRuntime.dispose();
        rejectedReconciliationRuntime.dispose();
        saveRows.clear();
        rejectedRows.clear();
      },
    },
  );

  bench(
    "applies, undoes, and redoes one 5,000-cell gesture as one bounded sparse command",
    () => {
      runtime.resetAllDrafts();
      let startedAt = performance.now();
      if (!runtime.applyAcceptedDraftGesture(gesture)) {
        throw new Error("The 5,000-cell gesture was not accepted.");
      }
      recordBudgetSample("5,000-cell gesture apply", applySamples, performance.now() - startedAt);
      if (runtime.getActivitySnapshot().draftCount !== gestureCellCount) {
        throw new Error("The accepted gesture did not publish every sparse draft.");
      }

      startedAt = performance.now();
      if (!runtime.undoBatchDraft()) throw new Error("The gesture did not undo atomically.");
      recordBudgetSample("5,000-cell gesture undo", undoSamples, performance.now() - startedAt);
      if (runtime.getActivitySnapshot().draftCount !== 0) {
        throw new Error("Undo retained partial gesture state.");
      }

      startedAt = performance.now();
      if (!runtime.redoBatchDraft()) throw new Error("The gesture did not redo atomically.");
      recordBudgetSample("5,000-cell gesture redo", redoSamples, performance.now() - startedAt);
      if (runtime.getActivitySnapshot().draftCount !== gestureCellCount) {
        throw new Error("Redo restored partial gesture state.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 2, warmupTime: 0 },
  );

  const preciseReconciliationSamples: number[] = [];
  bench(
    "reconciles one precise source Row Identity without materializing Reset Review",
    () => {
      const previousRowReads = rowReads;
      const startedAt = performance.now();
      reconciliationRuntime.reconcileSourceRows(new Set(["row-2500"]));
      recordBudgetSample(
        "one-row sparse draft reconciliation",
        preciseReconciliationSamples,
        performance.now() - startedAt,
      );
      if (reconciliationRuntime.getActivitySnapshot().draftCount !== gestureCellCount) {
        throw new Error("Precise reconciliation changed unrelated sparse drafts.");
      }
      if (rowReads - previousRowReads !== 1) {
        throw new Error("Precise reconciliation read outside its one indexed dirty cell.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 2, warmupTime: 0 },
  );

  const conflictRows = new Map<
    string,
    Readonly<{ readonly value: string; readonly revision: symbol }>
  >(
    Array.from({ length: gestureCellCount }, (_unused, index) => [
      `row-${String(index)}`,
      Object.freeze({ value: "server", revision: Symbol(`base-${String(index)}`) }),
    ]),
  );
  let conflictRowReads = 0;
  const conflictReconciliationRuntime = new BrunoTableCellEditRuntime({
    columns,
    getRow: (rowId) => {
      conflictRowReads += 1;
      return conflictRows.get(rowId);
    },
    getRowVersion: (candidate) => (candidate as Readonly<{ readonly revision: symbol }>).revision,
  });
  conflictReconciliationRuntime.setBatchHistoryEnabled(true);
  if (!conflictReconciliationRuntime.applyAcceptedDraftGesture(gesture)) {
    throw new Error("The conflict reconciliation fixture was not accepted.");
  }
  let conflictReconciliationIndex = 0;
  const conflictReconciliationSamples: number[] = [];
  bench(
    "derives one live conflict in 5,000 drafts without scanning unrelated work",
    () => {
      const rowId = `row-${String(conflictReconciliationIndex)}`;
      const serverVersion = Symbol(`server-${String(conflictReconciliationIndex)}`);
      conflictRows.set(
        rowId,
        Object.freeze({
          value: `server-${String(conflictReconciliationIndex)}`,
          revision: serverVersion,
        }),
      );
      conflictReconciliationIndex += 1;
      conflictRowReads = 0;
      const startedAt = performance.now();
      conflictReconciliationRuntime.reconcileSourceRows(new Set([rowId]));
      recordBudgetSample(
        "one-row sparse conflict reconciliation",
        conflictReconciliationSamples,
        performance.now() - startedAt,
      );
      if (conflictRowReads !== 1) {
        throw new Error("Conflict reconciliation visited an unrelated source row.");
      }
      if (
        conflictReconciliationRuntime.getActivitySnapshot().conflictCount !==
        conflictReconciliationIndex
      ) {
        throw new Error("Conflict reconciliation changed the wrong sparse conflict count.");
      }
    },
    {
      iterations: 100,
      time: 0,
      warmupIterations: 2,
      warmupTime: 0,
      teardown: () => {
        conflictReconciliationRuntime.dispose();
        conflictRows.clear();
      },
    },
  );

  const unknownReconciliationSamples: number[] = [];
  bench(
    "reconciles 5,000 sparse drafts after an unknown source publication",
    () => {
      const startedAt = performance.now();
      reconciliationRuntime.reconcileSourceRows(undefined);
      recordBudgetSample(
        "unknown sparse draft reconciliation",
        unknownReconciliationSamples,
        performance.now() - startedAt,
      );
      if (reconciliationRuntime.getActivitySnapshot().draftCount !== gestureCellCount) {
        throw new Error("Unknown reconciliation lost divergent sparse drafts.");
      }
    },
    { iterations: 100, time: 0, warmupIterations: 2, warmupTime: 0 },
  );

  const historySourceRows = new Map<
    string,
    Readonly<{ readonly value: string; readonly revision: symbol }>
  >();
  for (let index = 0; index < gestureCellCount; index += 1) {
    historySourceRows.set(
      `row-${String(index)}`,
      Object.freeze({
        value: `history-99-${String(index)}`,
        revision: Symbol(`history-base-${String(index)}`),
      }),
    );
  }
  let historyColumnRowReads = 0;
  const historyReconciliationRuntime = new BrunoTableCellEditRuntime({
    columns,
    getRow: (rowId) => {
      historyColumnRowReads += 1;
      return historySourceRows.get(rowId);
    },
    getRowVersion: (candidate) => (candidate as Readonly<{ readonly revision: symbol }>).revision,
  });
  historyReconciliationRuntime.setBatchHistoryEnabled(true);
  const populateRetainedHistory = (target: BrunoTableCellEditRuntime): void => {
    for (let commandIndex = 0; commandIndex < 100; commandIndex += 1) {
      const commandChanges = gesture.map((draft, cellIndex) =>
        Object.freeze({
          ...draft,
          mine: `history-${String(commandIndex)}-${String(cellIndex)}`,
        }),
      );
      const firstCommandChange = commandChanges[0];
      if (firstCommandChange === undefined) {
        throw new Error("The retained-history fixture command must be non-empty.");
      }
      const commandGesture: readonly [
        BrunoTableCellEditDraftSnapshot,
        ...BrunoTableCellEditDraftSnapshot[],
      ] = [firstCommandChange, ...commandChanges.slice(1)];
      if (!target.applyAcceptedDraftGesture(commandGesture)) {
        throw new Error("The retained-history fixture command was not accepted.");
      }
    }
  };
  let retainedHistoryPrepared = false;
  const prepareRetainedHistory = (): void => {
    if (retainedHistoryPrepared) return;
    populateRetainedHistory(historyReconciliationRuntime);
    if (historyReconciliationRuntime.getActivitySnapshot().undoCount !== 100) {
      throw new Error("Retained-history scenarios require all 100 commands.");
    }
    retainedHistoryPrepared = true;
  };
  let retainedConflictIndex = 0;
  const retainedConflictSamples: number[] = [];
  bench(
    "derives one live conflict through the indexed 100-command history",
    () => {
      const targetIndex = retainedConflictIndex;
      const rowId = `row-${String(targetIndex)}`;
      historySourceRows.set(
        rowId,
        Object.freeze({
          value: `history-conflict-${String(targetIndex)}`,
          revision: Symbol(`history-conflict-${String(targetIndex)}`),
        }),
      );
      historyColumnRowReads = 0;
      const startedAt = performance.now();
      historyReconciliationRuntime.reconcileSourceRows(new Set([rowId]));
      recordBudgetSample(
        "one-cell indexed retained-history conflict",
        retainedConflictSamples,
        performance.now() - startedAt,
        0,
      );
      retainedConflictIndex += 1;
      if (historyColumnRowReads !== 1) {
        throw new Error("Retained-history conflict read outside its indexed source row.");
      }
      if (
        historyReconciliationRuntime.getActivitySnapshot().conflictCount !== retainedConflictIndex
      ) {
        throw new Error("Retained-history conflict changed unrelated Cell Identities.");
      }
    },
    {
      iterations: 100,
      time: 0,
      warmupIterations: 0,
      warmupTime: 0,
      setup: prepareRetainedHistory,
      teardown: () => {
        for (let index = 0; index < retainedConflictIndex; index += 1) {
          historySourceRows.set(
            `row-${String(index)}`,
            Object.freeze({
              value: `history-99-${String(index)}`,
              revision: Symbol(`history-restored-${String(index)}`),
            }),
          );
        }
      },
    },
  );
  const retainedHistorySamples: number[] = [];
  let retainedHistoryTargetIndex = 0;
  bench(
    "prunes one converged Cell Identity from 100 retained 5,000-cell commands",
    () => {
      const targetIndex = retainedHistoryTargetIndex;
      retainedHistoryTargetIndex += 1;
      const previousDraftCount = historyReconciliationRuntime.getActivitySnapshot().draftCount;
      const startedAt = performance.now();
      historyReconciliationRuntime.reconcileSourceRows(new Set([`row-${String(targetIndex)}`]));
      const elapsedMs = performance.now() - startedAt;
      recordBudgetSample(
        "one-cell retained-history convergence",
        retainedHistorySamples,
        elapsedMs,
        0,
      );
      if (
        historyReconciliationRuntime.getActivitySnapshot().draftCount !==
        previousDraftCount - 1
      ) {
        throw new Error("One-cell convergence changed unrelated retained drafts.");
      }
    },
    {
      iterations: 100,
      time: 0,
      warmupIterations: 0,
      warmupTime: 0,
      setup: prepareRetainedHistory,
    },
  );

  let equivalentColumnIndex = 0;
  const equivalentRecompileSamples: number[] = [];
  bench(
    "reconciles an equivalent column over 100 retained 5,000-cell commands without evidence work",
    () => {
      const previousMemory = historyReconciliationRuntime.getDraftMemorySnapshot();
      const previousRowReads = historyColumnRowReads;
      equivalentColumnIndex = equivalentColumnIndex === 0 ? 1 : 0;
      const startedAt = performance.now();
      historyReconciliationRuntime.reconcileColumns(equivalentColumns[equivalentColumnIndex]!);
      recordBudgetSample(
        "equivalent retained-history column recompile",
        equivalentRecompileSamples,
        performance.now() - startedAt,
      );
      if (historyReconciliationRuntime.getDraftMemorySnapshot() !== previousMemory) {
        throw new Error("Equivalent column recompilation replaced retained edit memory.");
      }
      if (historyColumnRowReads !== previousRowReads) {
        throw new Error("Equivalent column recompilation read retained Row Identities.");
      }
    },
    {
      iterations: 100,
      time: 0,
      warmupIterations: 2,
      warmupTime: 0,
      setup: prepareRetainedHistory,
    },
  );

  let permissionRevoked = false;
  const permissionRecompileSamples: number[] = [];
  bench(
    "toggles static permission for 5,000 drafts without traversing 100 retained commands",
    () => {
      const previousRowReads = historyColumnRowReads;
      const retainedDraftCount = historyReconciliationRuntime.getActivitySnapshot().draftCount;
      permissionRevoked = !permissionRevoked;
      const startedAt = performance.now();
      historyReconciliationRuntime.reconcileColumns(
        permissionRevoked ? blockedColumns : equivalentColumns[0],
      );
      permissionRecompileSamples.push(performance.now() - startedAt);
      assertBrunoTableBenchmarkBudget(
        "5,000-draft static permission recompile",
        permissionRecompileSamples,
        {
          budgetMs: 100,
          measuredSampleCount,
          warmupSampleCount,
        },
      );
      if (historyColumnRowReads - previousRowReads !== retainedDraftCount) {
        throw new Error("Static permission recompilation traversed retained history occurrences.");
      }
      if (historyReconciliationRuntime.getActivitySnapshot().undoCount !== 100) {
        throw new Error("Static permission recompilation changed retained command count.");
      }
    },
    {
      iterations: 100,
      time: 0,
      warmupIterations: 2,
      warmupTime: 0,
      setup: prepareRetainedHistory,
    },
  );

  const massSourceConvergenceSamples: number[] = [];
  const massSourceConvergenceTargets: BrunoTableCellEditRuntime[] = [];
  const massSourceConvergenceSampleCount = 3;
  let massSourceConvergenceCalibration = true;
  const prepareMassSourceConvergenceTarget = (): BrunoTableCellEditRuntime => {
    const target = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => historySourceRows.get(rowId),
    });
    target.setBatchHistoryEnabled(true);
    populateRetainedHistory(target);
    return target;
  };
  bench(
    "clears one 5,000-cell source convergence from 100 retained commands within one frame",
    () => {
      const target = massSourceConvergenceTargets.shift();
      if (target === undefined) throw new Error("Mass convergence fixture was not prepared.");
      const calibration = massSourceConvergenceCalibration;
      massSourceConvergenceCalibration = false;
      try {
        const startedAt = performance.now();
        target.reconcileSourceRows(undefined);
        const elapsedMs = performance.now() - startedAt;
        if (!calibration) massSourceConvergenceSamples.push(elapsedMs);
        assertBrunoTableBenchmarkBudget(
          "5,000-identity retained-history source convergence",
          massSourceConvergenceSamples,
          {
            budgetMs: referenceFrameBudgetMs,
            measuredSampleCount: massSourceConvergenceSampleCount,
            warmupSampleCount: 0,
          },
        );
        expectCleanMassConvergence(target);
      } finally {
        target.dispose();
      }
    },
    {
      setup: (_task, mode) => {
        // Tinybench 2.9 probes the callback once before each phase, outside its timer.
        massSourceConvergenceCalibration = true;
        massSourceConvergenceSamples.length = 0;
        const targetCount = mode === "run" ? massSourceConvergenceSampleCount + 1 : 1;
        for (let index = 0; index < targetCount; index += 1) {
          massSourceConvergenceTargets.push(prepareMassSourceConvergenceTarget());
        }
        collectBenchmarkGarbage();
      },
      teardown: () => {
        for (const target of massSourceConvergenceTargets) target.dispose();
        massSourceConvergenceTargets.length = 0;
      },
      iterations: massSourceConvergenceSampleCount,
      time: 0,
      warmupIterations: 0,
      warmupTime: 0,
    },
  );
});

function expectCleanMassConvergence(runtime: BrunoTableCellEditRuntime): void {
  const activity = runtime.getActivitySnapshot();
  if (activity.draftCount !== 0 || activity.undoCount !== 0 || activity.redoCount !== 0) {
    throw new Error("Mass column convergence retained sparse edit evidence.");
  }
}
