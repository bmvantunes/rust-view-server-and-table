import { createActor, createMachine } from "xstate";
import { batch } from "@tanstack/store";

import type {
  BrunoTableCellEditChangeGesture,
  BrunoTableCellEditSaveChangeSet,
  BrunoTableCellEditRuntime,
} from "./cell-edit";
import type { BrunoTableEditMemoryRuntime } from "./edit-memory";
import type { BrunoTableColumns, BrunoTableSaveChangeSet } from "../public-types";

type SaveOperationKind = "batch" | "immediate";
type SaveOperationInitiator = "edit" | "footer" | "conflict-review";
type SaveOperationEvent =
  | Readonly<{ readonly type: "RESOLVE" }>
  | Readonly<{ readonly type: "REJECT" }>
  | Readonly<{ readonly type: "RECONCILE" }>;

const brunoTableSaveOperationMachine = createMachine({
  id: "brunoTableSaveOperation",
  initial: "pending",
  types: {} as { events: SaveOperationEvent },
  states: {
    pending: {
      on: {
        RESOLVE: "awaitingSource",
        REJECT: "rejected",
      },
    },
    awaitingSource: { on: { RECONCILE: "completed" } },
    rejected: { on: { RECONCILE: "completed" } },
    completed: { type: "final" },
  },
});

function createSaveOperationActor() {
  const actor = createActor(brunoTableSaveOperationMachine);
  actor.start();
  return actor;
}

type SaveOperationRecord = {
  readonly operationId: string;
  readonly kind: SaveOperationKind;
  readonly initiatedFrom: SaveOperationInitiator;
  changeSet: BrunoTableCellEditSaveChangeSet | undefined;
  readonly actor: ReturnType<typeof createSaveOperationActor>;
  releaseRetainedOperation: (() => void) | undefined;
  releaseSaveWork: (() => void) | undefined;
  releasePromiseReferences: (() => void) | undefined;
  unsubscribeReconciliation: (() => void) | undefined;
};

type SaveHandler = (changeSet: BrunoTableCellEditSaveChangeSet) => PromiseLike<void>;
const BRUNO_TABLE_SAVE_OPERATION_LIMIT = 128;

export function adaptBrunoTableSaveHandler<
  TRow,
  const TColumns extends BrunoTableColumns<TRow>,
  TRowVersion,
>(
  handler: (changeSet: BrunoTableSaveChangeSet<TRow, TColumns, TRowVersion>) => PromiseLike<void>,
): SaveHandler {
  return (changeSet) => handler(changeSet as BrunoTableSaveChangeSet<TRow, TColumns, TRowVersion>);
}

export class BrunoTableSaveOperationRuntime {
  private readonly operations = new Map<string, SaveOperationRecord>();
  private handler: SaveHandler | undefined;
  private sequence = 0;
  private active = false;
  private unregisterBatch: (() => void) | undefined;
  private unregisterImmediate: (() => void) | undefined;

  public constructor(
    private readonly cellEdit: BrunoTableCellEditRuntime,
    private readonly editMemory: BrunoTableEditMemoryRuntime,
  ) {}

  public readonly setHandler = (handler: SaveHandler): (() => void) => {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  };

  public readonly activate = (): (() => void) => {
    if (this.active) return this.dispose;
    this.active = true;
    this.publishCapacityAvailability();
    this.unregisterBatch = this.editMemory.registerSaveCommand((initiatedFrom) => {
      const changeSet = this.cellEdit.createBatchSaveChangeSet();
      return changeSet !== undefined && this.startOperation("batch", changeSet, initiatedFrom);
    });
    this.unregisterImmediate = this.editMemory.registerImmediateSaveCommand(
      (changes: BrunoTableCellEditChangeGesture, initiatedFrom) => {
        const preparation = this.cellEdit.createImmediateSaveChangeSet(changes);
        if (preparation.kind === "reconciled") return "preflight-reconciled";
        if (preparation.kind === "rejected") return "rejected";
        return this.startOperation("immediate", preparation.changeSet, initiatedFrom)
          ? "admitted"
          : "rejected";
      },
    );
    return this.dispose;
  };

  public readonly getRetainedOperationCount = (): number => this.operations.size;

  public readonly getRetainedChangeSetCount = (): number => {
    let count = 0;
    for (const operation of this.operations.values()) {
      if (operation.changeSet !== undefined) count += 1;
    }
    return count;
  };

  public readonly dispose = (): void => {
    if (!this.active) return;
    this.active = false;
    this.unregisterBatch?.();
    this.unregisterBatch = undefined;
    this.unregisterImmediate?.();
    this.unregisterImmediate = undefined;
    for (const operation of this.operations.values()) {
      operation.unsubscribeReconciliation?.();
      operation.unsubscribeReconciliation = undefined;
      operation.changeSet = undefined;
      operation.releaseRetainedOperation?.();
      operation.releaseRetainedOperation = undefined;
      operation.releasePromiseReferences?.();
      operation.releasePromiseReferences = undefined;
      operation.releaseSaveWork?.();
      operation.releaseSaveWork = undefined;
      this.cellEdit.completeSaveOperation(operation.operationId);
      operation.actor.stop();
    }
    this.operations.clear();
    this.publishCapacityAvailability();
    this.handler = undefined;
  };

  private readonly startOperation = (
    kind: SaveOperationKind,
    changeSet: BrunoTableCellEditSaveChangeSet,
    initiatedFrom: SaveOperationInitiator,
  ): boolean => {
    if (!this.active || this.getCapacityOperationCount() >= BRUNO_TABLE_SAVE_OPERATION_LIMIT) {
      return false;
    }
    const operationId = `${kind}:${String((this.sequence += 1))}`;
    let releaseSaveWork = (): void => undefined;
    let admitted = false;
    batch(() => {
      releaseSaveWork = this.editMemory.beginSaveWork(operationId, kind, initiatedFrom);
      admitted = this.cellEdit.beginSaveOperation(operationId, changeSet, kind === "batch");
      if (!admitted) {
        releaseSaveWork();
        this.editMemory.rejectSaveWorkAdmission(operationId, initiatedFrom);
      }
    });
    if (!admitted) return false;
    const operation: SaveOperationRecord = {
      operationId,
      kind,
      initiatedFrom,
      changeSet,
      actor: createSaveOperationActor(),
      releaseRetainedOperation: this.editMemory.beginRetainedSaveOperation(),
      releaseSaveWork,
      releasePromiseReferences: undefined,
      unsubscribeReconciliation: undefined,
    };
    this.operations.set(operationId, operation);
    this.publishCapacityAvailability();
    const promise = (() => {
      const handler = this.handler;
      if (handler === undefined) {
        return Promise.reject(new Error("BrunoTable save operation is unavailable."));
      }
      let result: unknown;
      try {
        result = handler(changeSet);
      } catch (error) {
        return Promise.reject(error);
      }
      let then: unknown;
      try {
        then =
          (typeof result === "object" && result !== null) || typeof result === "function"
            ? (result as { readonly then?: unknown }).then
            : undefined;
      } catch (error) {
        return Promise.reject(error);
      }
      if (typeof then !== "function") {
        return Promise.reject(
          new TypeError("BrunoTable onSaveEdits must return a PromiseLike<void>."),
        );
      }
      return new Promise<void>((resolve, reject) => {
        try {
          Reflect.apply(then, result, [resolve, reject]);
        } catch (error) {
          reject(error);
        }
      });
    })();
    const settlement: {
      runtime: BrunoTableSaveOperationRuntime | undefined;
      operation: SaveOperationRecord | undefined;
    } = { runtime: this, operation };
    operation.releasePromiseReferences = () => {
      settlement.runtime = undefined;
      settlement.operation = undefined;
    };
    void promise.then(
      () => {
        const runtime = settlement.runtime;
        const retainedOperation = settlement.operation;
        if (runtime !== undefined && retainedOperation !== undefined) {
          runtime.resolveOperation(retainedOperation);
        }
      },
      (error: unknown) => {
        const runtime = settlement.runtime;
        const retainedOperation = settlement.operation;
        if (runtime !== undefined && retainedOperation !== undefined) {
          runtime.rejectOperation(retainedOperation, error);
        }
      },
    );
    return true;
  };

  private readonly resolveOperation = (operation: SaveOperationRecord): void => {
    operation.releasePromiseReferences?.();
    operation.releasePromiseReferences = undefined;
    if (!this.active || this.operations.get(operation.operationId) !== operation) return;
    const changeSet = operation.changeSet;
    if (changeSet === undefined) return;
    batch(() => {
      operation.actor.send({ type: "RESOLVE" });
      if (operation.actor.getSnapshot().value !== "awaitingSource") return;
      this.cellEdit.acceptSave(operation.operationId, changeSet, operation.kind === "batch");
      operation.changeSet = undefined;
      this.editMemory.setSaveWorkAwaitingSource(
        operation.operationId,
        this.cellEdit.getAcceptedOverlayRowCountForOperation(operation.operationId),
      );
      this.editMemory.resolveConflictReviewSave(operation.operationId);
    });
    if (operation.actor.getSnapshot().value !== "awaitingSource") return;
    const reconcile = (): void => {
      this.editMemory.setSaveWorkAwaitingSource(
        operation.operationId,
        this.cellEdit.getAcceptedOverlayRowCountForOperation(operation.operationId),
      );
      if (this.cellEdit.getAcceptedOverlayCountForOperation(operation.operationId) > 0) return;
      this.reconcileOperation(operation, false);
    };
    operation.unsubscribeReconciliation = this.cellEdit.subscribeAcceptedOverlayCount(
      operation.operationId,
      reconcile,
    );
    reconcile();
  };

  private readonly rejectOperation = (operation: SaveOperationRecord, reason: unknown): void => {
    operation.releasePromiseReferences?.();
    operation.releasePromiseReferences = undefined;
    if (!this.active || this.operations.get(operation.operationId) !== operation) return;
    this.editMemory.rejectConflictReviewSave(operation.operationId);
    const changeSet = operation.changeSet;
    if (changeSet === undefined) return;
    batch(() => {
      operation.actor.send({ type: "REJECT" });
      if (operation.actor.getSnapshot().value !== "rejected") return;
      this.cellEdit.rejectSave(operation.operationId, changeSet, operation.kind === "immediate");
      operation.changeSet = undefined;
      this.editMemory.recordSaveFailure(operation.operationId, reason, changeSet);
      this.cellEdit.completeSaveOperation(operation.operationId);
      operation.releaseSaveWork?.();
      operation.releaseSaveWork = undefined;
    });
    if (operation.actor.getSnapshot().value !== "rejected") return;
    this.publishCapacityAvailability();
    const remainingCells = this.cellEdit.getRejectedOperationCells(operation.operationId);
    const remainingColumnIdsByRowId = new Map<string, Set<string>>();
    for (const cell of remainingCells) {
      const columnIds = remainingColumnIdsByRowId.get(cell.rowId) ?? new Set<string>();
      columnIds.add(cell.columnId);
      remainingColumnIdsByRowId.set(cell.rowId, columnIds);
    }
    this.editMemory.removeSaveFailureCells(
      operation.operationId,
      changeSet.flatMap((row) =>
        row.changes.flatMap((change) =>
          remainingColumnIdsByRowId.get(row.rowId)?.has(change.columnId) === true
            ? []
            : [Object.freeze({ rowId: row.rowId, columnId: change.columnId })],
        ),
      ),
    );
    const reconcile = (): void => {
      const update = this.cellEdit.getRejectedOperationUpdateSnapshot(operation.operationId);
      this.editMemory.removeSaveFailureCells(operation.operationId, update.removedCells);
      if (update.remainingCount > 0) return;
      this.reconcileOperation(operation, true);
    };
    if (remainingCells.length === 0) {
      this.reconcileOperation(operation, true);
      return;
    }
    operation.unsubscribeReconciliation = this.cellEdit.subscribeRejectedOperation(
      operation.operationId,
      reconcile,
    );
    reconcile();
  };

  private readonly reconcileOperation = (
    operation: SaveOperationRecord,
    clearFailure: boolean,
  ): void => {
    operation.actor.send({ type: "RECONCILE" });
    if (operation.actor.getSnapshot().value !== "completed") return;
    operation.unsubscribeReconciliation?.();
    operation.unsubscribeReconciliation = undefined;
    if (clearFailure) this.editMemory.clearSaveFailure(operation.operationId);
    this.cellEdit.completeSaveOperation(operation.operationId);
    operation.releaseRetainedOperation?.();
    operation.releaseRetainedOperation = undefined;
    operation.releaseSaveWork?.();
    operation.releaseSaveWork = undefined;
    this.operations.delete(operation.operationId);
    this.publishCapacityAvailability();
    operation.actor.stop();
  };

  private readonly publishCapacityAvailability = (): void => {
    const available = this.getCapacityOperationCount() < BRUNO_TABLE_SAVE_OPERATION_LIMIT;
    this.cellEdit.setSaveOperationCapacityAvailable(available);
    this.editMemory.setSaveOperationCapacityAvailable(available);
  };

  private readonly getCapacityOperationCount = (): number => {
    let count = 0;
    for (const operation of this.operations.values()) {
      const state = operation.actor.getSnapshot().value;
      if (state === "pending" || state === "awaitingSource") count += 1;
    }
    return count;
  };
}
