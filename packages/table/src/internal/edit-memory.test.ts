import { afterEach, describe, expect, it, vi } from "vitest";

import { BrunoTableCellEditRuntime } from "./cell-edit";
import { compileColumns } from "./compile-columns";
import {
  type BrunoTableConflictResolutionAvailabilitySnapshot,
  BrunoTableEditMemoryRuntime,
} from "./edit-memory";

const disposers: Array<() => void> = [];

type EditMemoryTestRow = Readonly<{
  readonly id: string;
  readonly value: string;
  readonly revision: bigint;
}>;

const valueColumns = compileColumns([
  {
    columnId: "COL_ID_VALUE",
    field: "value",
    headerName: "Value",
    valueType: "text",
    isEditable: true,
  },
]);

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

describe("BrunoTable Edit Memory", () => {
  it("keeps Conflict Review closed in the workflow while another cell editor is active", () => {
    type Row = EditMemoryTestRow;
    const rows = new Map<string, Row>([
      ["row-1", Object.freeze({ id: "row-1", value: "base-1", revision: 1n })],
      ["row-2", Object.freeze({ id: "row-2", value: "base-2", revision: 1n })],
    ]);
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    const conflictedRow = rows.get("row-1")!;
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: conflictedRow.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: conflictedRow,
          expectedVersion: conflictedRow.revision,
          base: conflictedRow.value,
          mine: "mine",
          conflict: { server: "server", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    expect(cellEdit.start("row-2", "COL_ID_VALUE")).toBe(true);

    expect(memory.openConflictReview()).toBe(false);
    expect(memory.getConflictReviewSnapshot().open).toBe(false);

    cellEdit.cancel();
    expect(memory.openConflictReview()).toBe(true);
  });

  it("publishes conflict resolution availability across source gaps and Batch save locks", () => {
    type Row = EditMemoryTestRow;
    let authoritative = true;
    const base = Object.freeze({ id: "row-1", value: "base", revision: 1n });
    const server = Object.freeze({ id: "row-1", value: "server", revision: 2n });
    const second = Object.freeze({ id: "row-2", value: "second", revision: 1n });
    const rows = new Map<string, Row>([
      [server.id, server],
      [second.id, second],
    ]);
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).revision,
      isSourceAuthoritative: () => authoritative,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: base.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.value,
          mine: "mine",
          conflict: { server: server.value, serverVersion: server.revision },
        },
      ]),
    ).toBe(true);
    expect(memory.openConflictReview()).toBe(true);
    const id = cellEdit.getDraftReviewSnapshot()[0]!.id;
    expect(memory.getConflictResolutionAvailabilitySnapshot(id)).toMatchObject({
      mineAvailable: true,
      serverAvailable: true,
    });

    authoritative = false;
    memory.setSavePreflightAvailable(false);
    expect(memory.getConflictResolutionAvailabilitySnapshot(id)).toMatchObject({
      mineAvailable: false,
      serverAvailable: false,
      mineReason: "Conflict choices are unavailable until the current source is ready.",
    });

    authoritative = true;
    memory.setSavePreflightAvailable(true);
    expect(memory.getConflictResolutionAvailabilitySnapshot(id)).toMatchObject({
      mineAvailable: true,
      serverAvailable: true,
    });

    const changeSet = [
      {
        rowId: second.id,
        baseRow: second,
        expectedVersion: second.revision,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: second.value,
            after: "changed",
          },
        ],
      },
    ] as const;
    expect(cellEdit.beginSaveOperation("batch-lock", changeSet, true)).toBe(true);
    const releaseSaveWork = memory.beginSaveWork("batch-lock", "batch");
    expect(memory.getConflictResolutionAvailabilitySnapshot(id)).toMatchObject({
      mineAvailable: false,
      serverAvailable: false,
      mineReason: "Wait for the current save to finish before resolving this conflict.",
    });

    cellEdit.completeSaveOperation("batch-lock");
    releaseSaveWork();
    expect(memory.getConflictResolutionAvailabilitySnapshot(id)).toMatchObject({
      mineAvailable: true,
      serverAvailable: true,
    });
  });

  it("keeps Server available while a permission block disables Mine", () => {
    type Row = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly editable: boolean;
      readonly revision: bigint;
    }>;
    const permissionColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: ({ row }: { readonly row: Row }) => row.editable,
      },
    ]);
    const base: Row = Object.freeze({
      id: "row-1",
      value: "base",
      editable: true,
      revision: 1n,
    });
    const server: Row = Object.freeze({
      ...base,
      value: "server",
      editable: false,
      revision: 2n,
    });
    const cellEdit = new BrunoTableCellEditRuntime({
      columns: permissionColumns,
      getRow: () => server,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: base.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.value,
          mine: "mine",
          conflict: { server: server.value, serverVersion: server.revision },
        },
      ]),
    ).toBe(true);
    cellEdit.reconcileSourceRows(new Set([base.id]));
    expect(cellEdit.getActivitySnapshot()).toMatchObject({ blockedCount: 1, conflictCount: 1 });
    expect(memory.openConflictReview()).toBe(true);
    const id = cellEdit.getDraftReviewSnapshot()[0]!.id;

    expect(memory.getConflictResolutionAvailabilitySnapshot(id)).toEqual({
      mineAvailable: false,
      serverAvailable: true,
      mineReason: "Keep Mine is unavailable while this change is blocked.",
    });
  });

  it("publishes bulk conflict availability without a mounted per-row subscriber", () => {
    type Row = EditMemoryTestRow;
    let authoritative = true;
    const base = Object.freeze({ id: "row-1", value: "base", revision: 1n });
    const server = Object.freeze({ id: "row-1", value: "server", revision: 2n });
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => server,
      getRowVersion: (candidate) => (candidate as Row).revision,
      isSourceAuthoritative: () => authoritative,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    const getAvailabilityStoreCount = (): number =>
      (
        memory as unknown as {
          readonly conflictResolutionControlStores: ReadonlyMap<string, unknown>;
        }
      ).conflictResolutionControlStores.size;
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: base.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.value,
          mine: "mine",
          conflict: { server: server.value, serverVersion: server.revision },
        },
      ]),
    ).toBe(true);
    expect(memory.openConflictReview()).toBe(true);
    const id = cellEdit.getDraftReviewSnapshot()[0]!.id;
    expect(memory.getConflictResolutionAvailabilitySnapshot(id)).toMatchObject({
      mineAvailable: true,
      serverAvailable: true,
    });
    expect(getAvailabilityStoreCount()).toBe(0);
    const readyVersion = memory.getConflictResolutionAvailabilityVersionSnapshot();

    authoritative = false;
    memory.setSavePreflightAvailable(false);

    expect(memory.getConflictResolutionAvailabilityVersionSnapshot()).toBeGreaterThan(readyVersion);
    expect(memory.getConflictResolutionAvailabilitySnapshot(id)).toMatchObject({
      mineAvailable: false,
      serverAvailable: false,
    });
    expect(getAvailabilityStoreCount()).toBe(0);
  });

  it("keeps every conflict availability projection referentially stable", () => {
    type Row = EditMemoryTestRow;
    const columns = valueColumns;
    const assertStable = (
      memory: BrunoTableEditMemoryRuntime,
      id: string,
    ): BrunoTableConflictResolutionAvailabilitySnapshot => {
      const first = memory.getConflictResolutionAvailabilitySnapshot(id);
      expect(memory.getConflictResolutionAvailabilitySnapshot(id)).toBe(first);
      return first;
    };

    const base = Object.freeze({ id: "row-batch", value: "base", revision: 1n });
    const server = Object.freeze({ ...base, value: "server", revision: 2n });
    const saveRow = Object.freeze({ id: "row-save", value: "save", revision: 1n });
    let current: Row = server;
    let authoritative = true;
    const batchCellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => (rowId === saveRow.id ? saveRow : current),
      getRowVersion: (candidate) => (candidate as Row).revision,
      isSourceAuthoritative: () => authoritative,
    });
    const batchMemory = new BrunoTableEditMemoryRuntime();
    batchCellEdit.activate();
    batchMemory.activate();
    disposers.push(
      batchMemory.connectCellEdit(batchCellEdit),
      () => batchMemory.dispose(),
      () => batchCellEdit.dispose(),
    );
    expect(batchMemory.requestMode("batch")).toBe(true);
    expect(
      batchCellEdit.applyAcceptedDraftGesture([
        {
          rowId: base.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.value,
          mine: "mine",
          conflict: { server: server.value, serverVersion: server.revision },
        },
      ]),
    ).toBe(true);
    expect(batchMemory.openConflictReview()).toBe(true);
    const batchId = batchCellEdit.getDraftReviewSnapshot()[0]!.id;
    const batchListener = vi.fn();
    disposers.push(batchMemory.subscribeConflictResolutionAvailabilityVersion(batchListener));
    const available = assertStable(batchMemory, batchId);

    expect(batchCellEdit.start(base.id, "COL_ID_VALUE")).toBe(true);
    const activeEditor = assertStable(batchMemory, batchId);
    expect(activeEditor).not.toBe(available);
    expect(activeEditor.mineReason).toContain("active edit");
    expect(batchListener).toHaveBeenCalled();
    expect(batchCellEdit.cancel()).toBe(true);
    expect(assertStable(batchMemory, batchId)).toBe(available);

    const saveChangeSet = [
      {
        rowId: saveRow.id,
        baseRow: saveRow,
        expectedVersion: saveRow.revision,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: saveRow.value,
            after: "saved",
          },
        ],
      },
    ] as const;
    expect(batchCellEdit.beginSaveOperation("batch-lock", saveChangeSet, true)).toBe(true);
    const releaseSaveWork = batchMemory.beginSaveWork("batch-lock", "batch");
    const saveWork = assertStable(batchMemory, batchId);
    expect(saveWork).not.toBe(available);
    expect(saveWork.mineReason).toContain("current save");
    batchCellEdit.completeSaveOperation("batch-lock");
    releaseSaveWork();
    expect(assertStable(batchMemory, batchId)).toBe(available);

    authoritative = false;
    batchMemory.setSavePreflightAvailable(false);
    const sourceGap = assertStable(batchMemory, batchId);
    expect(sourceGap).not.toBe(available);
    expect(sourceGap.mineReason).toContain("current source");
    authoritative = true;
    batchMemory.setSavePreflightAvailable(true);
    expect(assertStable(batchMemory, batchId)).toBe(available);

    current = Object.freeze({ ...server, value: "newer", revision: 3n });
    batchMemory.setSaveOperationCapacityAvailable(false);
    const staleEvidence = assertStable(batchMemory, batchId);
    expect(staleEvidence).not.toBe(available);
    expect(staleEvidence).not.toBe(sourceGap);
    expect(staleEvidence.mineReason).toContain("latest source evidence");
    current = server;
    batchMemory.setSaveOperationCapacityAvailable(true);
    expect(assertStable(batchMemory, batchId)).toBe(available);

    const immediateBase = Object.freeze({ id: "row-immediate", value: "base", revision: 1n });
    const immediateServer = Object.freeze({
      ...immediateBase,
      value: "server",
      revision: 2n,
    });
    const immediateCellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => immediateServer,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const immediateMemory = new BrunoTableEditMemoryRuntime();
    immediateCellEdit.activate();
    immediateMemory.activate();
    disposers.push(
      immediateMemory.connectCellEdit(immediateCellEdit),
      immediateMemory.registerImmediateSaveCommand(() => "admitted"),
      () => immediateMemory.dispose(),
      () => immediateCellEdit.dispose(),
    );
    expect(
      immediateCellEdit.applyAcceptedDraftGesture([
        {
          rowId: immediateBase.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: immediateBase,
          expectedVersion: immediateBase.revision,
          base: immediateBase.value,
          mine: "mine",
          conflict: {
            server: immediateServer.value,
            serverVersion: immediateServer.revision,
          },
        },
      ]),
    ).toBe(true);
    expect(immediateMemory.openConflictReview()).toBe(true);
    const immediateId = immediateCellEdit.getDraftReviewSnapshot()[0]!.id;
    const immediateListener = vi.fn();
    disposers.push(
      immediateMemory.subscribeConflictResolutionAvailabilityVersion(immediateListener),
    );
    const immediateAvailable = assertStable(immediateMemory, immediateId);

    immediateMemory.setSaveOperationCapacityAvailable(false);
    const immediateCapacity = assertStable(immediateMemory, immediateId);
    expect(immediateCapacity).not.toBe(immediateAvailable);
    expect(immediateCapacity.mineAvailable).toBe(false);
    expect(immediateCapacity.serverAvailable).toBe(true);
    expect(immediateCapacity.mineReason).toContain("another save");
    expect(immediateListener).toHaveBeenCalled();

    immediateMemory.setSaveOperationCapacityAvailable(true);
    expect(assertStable(immediateMemory, immediateId)).toBe(immediateAvailable);
    immediateMemory.setSavePreflightAvailable(false);
    const immediateSourceGap = assertStable(immediateMemory, immediateId);
    expect(immediateSourceGap).not.toBe(immediateAvailable);
    expect(immediateSourceGap).not.toBe(immediateCapacity);
    expect(immediateSourceGap.mineAvailable).toBe(false);
    expect(immediateSourceGap.serverAvailable).toBe(true);
    expect(immediateSourceGap.mineReason).toContain("current source");
  });

  it("finalizes an all-Server Batch review without discarding its undo history", () => {
    type Row = EditMemoryTestRow;
    let row: Row = Object.freeze({ id: "row-1", value: "base", revision: 1n });
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      memory.registerSaveCommand(() => true),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: row,
          expectedVersion: row.revision,
          base: row.value,
          mine: "mine",
        },
      ]),
    ).toBe(true);
    row = Object.freeze({ ...row, value: "server", revision: 2n });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(memory.openConflictReview()).toBe(true);
    const id = cellEdit.getDraftReviewSnapshot()[0]!.id;
    expect(memory.resolveConflictRows([id], "server")).toBe(true);
    expect(cellEdit.getActivitySnapshot()).toMatchObject({
      conflictCount: 0,
      draftCount: 0,
      undoCount: 2,
    });

    expect(memory.saveConflictReview()).toBe(true);
    expect(memory.getConflictReviewSnapshot().open).toBe(false);

    row = Object.freeze({ ...row, revision: 3n });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(cellEdit.getActivitySnapshot()).toMatchObject({ conflictCount: 0, undoCount: 2 });
    expect(memory.undo()).toBe(true);
    expect(cellEdit.getActivitySnapshot()).toMatchObject({ conflictCount: 1, draftCount: 1 });
  });

  it("saves ordinary Batch drafts from an all-current open Conflict Review", () => {
    type Row = EditMemoryTestRow;
    const rows = new Map<string, Row>([
      ["row-a", Object.freeze({ id: "row-a", value: "base-a", revision: 1n })],
      ["row-b", Object.freeze({ id: "row-b", value: "base-b", revision: 1n })],
    ]);
    const cellEdit = new BrunoTableCellEditRuntime({
      columns: valueColumns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    let releaseSave = (): void => undefined;
    const save = vi.fn((initiatedFrom: "footer" | "conflict-review") => {
      releaseSave = memory.beginSaveWork("all-current-review-save", "batch", initiatedFrom);
      return true;
    });
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      memory.registerSaveCommand(save),
      () => releaseSave(),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);
    const rowA = rows.get("row-a")!;
    const rowB = rows.get("row-b")!;
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: rowA.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rowA,
          expectedVersion: rowA.revision,
          base: rowA.value,
          mine: "mine-a",
        },
        {
          rowId: rowB.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rowB,
          expectedVersion: rowB.revision,
          base: rowB.value,
          mine: "mine-b",
        },
      ]),
    ).toBe(true);

    rows.set("row-a", Object.freeze({ ...rowA, value: "server-a", revision: 2n }));
    cellEdit.reconcileSourceRows(new Set([rowA.id]));
    expect(memory.openConflictReview()).toBe(true);

    rows.set("row-a", Object.freeze({ ...rowA, value: "mine-a", revision: 3n }));
    cellEdit.reconcileSourceRows(new Set([rowA.id]));
    expect(cellEdit.getActivitySnapshot()).toMatchObject({
      conflictCount: 0,
      draftCount: 1,
    });
    expect(memory.getConflictReviewSnapshot()).toMatchObject({
      open: true,
      count: 0,
      resolutionCount: 0,
    });
    expect(memory.getCanSaveSnapshot()).toBe(true);

    expect(memory.saveConflictReview()).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("conflict-review");
  });

  it("keeps retained Server choices out of Reset Review until Undo restores the draft", () => {
    type Row = EditMemoryTestRow;
    let row: Row = Object.freeze({ id: "row-1", value: "base", revision: 1n });
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: row,
          expectedVersion: row.revision,
          base: row.value,
          mine: "mine",
        },
      ]),
    ).toBe(true);
    row = Object.freeze({ ...row, value: "server", revision: 2n });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(memory.openConflictReview()).toBe(true);
    const id = cellEdit.getDraftReviewSnapshot()[0]!.id;
    expect(memory.resolveConflictRows([id], "server")).toBe(true);
    expect(cellEdit.getActivitySnapshot()).toMatchObject({ draftCount: 0, undoCount: 2 });
    memory.closeConflictReview();

    expect(memory.openResetReview()).toBe(true);
    expect(memory.getResetReviewSnapshot()).toMatchObject({ pendingCount: 0 });
    expect(memory.getResetReviewRowsSnapshot()).toHaveLength(0);
    row = Object.freeze({ ...row });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(memory.getResetReviewRowsSnapshot()).toHaveLength(0);

    memory.closeResetReview();
    expect(memory.undo()).toBe(true);
    expect(cellEdit.getActivitySnapshot()).toMatchObject({ conflictCount: 1, draftCount: 1 });
  });

  it("accepts a fresh conflict choice after retained evidence is invalidated", () => {
    type Row = EditMemoryTestRow;
    let row: Row = Object.freeze({ id: "row-1", value: "base", revision: 1n });
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: row,
          expectedVersion: row.revision,
          base: row.value,
          mine: "mine",
          conflict: { server: "server-1", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    row = Object.freeze({ ...row, value: "server-1", revision: 2n });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(memory.openConflictReview()).toBe(true);
    const id = cellEdit.getDraftReviewSnapshot()[0]?.id;
    expect(id).toBeDefined();
    expect(memory.resolveConflictRows([id!], "mine")).toBe(true);
    expect(memory.getConflictResolutionSnapshot(id!)).toMatchObject({ resolution: "mine" });

    row = Object.freeze({ ...row, value: "server-2" });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(memory.getConflictResolutionSnapshot(id!)).toBeUndefined();
    expect(memory.resolveConflictRows([id!], "mine")).toBe(true);
    expect(memory.getConflictResolutionSnapshot(id!)).toMatchObject({ resolution: "mine" });
  });

  it("keeps conflict-resolution transition ownership in the workflow actor", () => {
    type Row = EditMemoryTestRow;
    let row: Row = Object.freeze({ id: "row-1", value: "base", revision: 1n });
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: row,
          expectedVersion: row.revision,
          base: row.value,
          mine: "mine",
          conflict: { server: "server", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    row = Object.freeze({ ...row, value: "server", revision: 2n });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(memory.openConflictReview()).toBe(true);
    const id = cellEdit.getDraftReviewSnapshot()[0]!.id;
    const actorOwnedDuringPublication: boolean[] = [];
    const unsubscribe = cellEdit.subscribeDraftReviewClassification(() => {
      if (cellEdit.getDraftReviewClassificationSnapshot().conflictIds.has(id)) return;
      const actor = (
        memory as unknown as {
          readonly actor: {
            readonly getSnapshot: () => {
              readonly context: {
                readonly conflictResolutionInProgressIds: ReadonlySet<string>;
              };
            };
          };
        }
      ).actor;
      actorOwnedDuringPublication.push(
        actor.getSnapshot().context.conflictResolutionInProgressIds.has(id),
      );
    });
    disposers.push(unsubscribe);

    expect(memory.resolveConflictRows([id], "server")).toBe(true);
    expect(actorOwnedDuringPublication).toContain(true);
    const actor = (
      memory as unknown as {
        readonly actor: {
          readonly getSnapshot: () => {
            readonly context: { readonly conflictResolutionInProgressIds: ReadonlySet<string> };
          };
        };
      }
    ).actor;
    expect(actor.getSnapshot().context.conflictResolutionInProgressIds.size).toBe(0);
  });

  it("reopens a retained Mine resolution when only the Row Version extractor changes", () => {
    type Row = EditMemoryTestRow;
    let row: Row = Object.freeze({ id: "row-1", value: "base", revision: 1n });
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: row,
          expectedVersion: row.revision,
          base: row.value,
          mine: "mine",
        },
      ]),
    ).toBe(true);
    row = Object.freeze({ ...row, value: "server", revision: 2n });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(memory.openConflictReview()).toBe(true);
    const id = cellEdit.getDraftReviewSnapshot()[0]!.id;
    expect(memory.resolveConflictRows([id], "mine")).toBe(true);
    expect(memory.getConflictResolutionSnapshot(id)).toMatchObject({ resolution: "mine" });

    cellEdit.setRowVersionExtractor(() => 3n);

    expect(memory.getConflictResolutionSnapshot(id)).toBeUndefined();
    expect(cellEdit.getActivitySnapshot()).toMatchObject({ conflictCount: 1 });
  });

  it("keeps an Immediate Conflict Review locked across disjoint review-origin saves", () => {
    type Row = EditMemoryTestRow;
    const rows = new Map<string, Row>([
      ["row-1", Object.freeze({ id: "row-1", value: "base-1", revision: 1n })],
      ["row-2", Object.freeze({ id: "row-2", value: "base-2", revision: 1n })],
    ]);
    const columns = valueColumns;
    const memory = new BrunoTableEditMemoryRuntime();
    let saveReady = false;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).revision,
      onCommitGesture: (changes) => (saveReady ? memory.requestImmediateSave(changes) : undefined),
    });
    cellEdit.activate();
    memory.activate();
    let operationSequence = 0;
    const releaseSaves: Array<() => void> = [];
    disposers.push(
      memory.connectCellEdit(cellEdit),
      memory.registerImmediateSaveCommand((_changes, initiatedFrom) => {
        operationSequence += 1;
        releaseSaves.push(
          memory.beginSaveWork(
            `immediate-review-${String(operationSequence)}`,
            "immediate",
            initiatedFrom,
          ),
        );
        return "admitted";
      }),
      () => {
        for (const releaseSave of releaseSaves) releaseSave();
      },
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    type GestureDraft = Readonly<{
      readonly rowId: string;
      readonly columnId: string;
      readonly field: string;
      readonly baseRow: Row;
      readonly expectedVersion: bigint;
      readonly base: string;
      readonly mine: string;
      readonly conflict: Readonly<{ readonly server: string; readonly serverVersion: bigint }>;
    }>;
    expect(
      cellEdit.applyAcceptedDraftGesture(
        [...rows.values()].map((row) => ({
          rowId: row.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: row,
          expectedVersion: row.revision,
          base: row.value,
          mine: `mine-${row.id}`,
          conflict: { server: `server-${row.id}`, serverVersion: 2n },
        })) as [GestureDraft, ...GestureDraft[]],
      ),
    ).toBe(true);
    for (const [rowId, current] of rows) {
      rows.set(rowId, Object.freeze({ ...current, value: `server-${rowId}`, revision: 2n }));
    }
    cellEdit.reconcileSourceRows(new Set(rows.keys()));
    expect(memory.openConflictReview()).toBe(true);
    const [first, second] = cellEdit.getDraftReviewSnapshot();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    saveReady = true;

    expect(memory.resolveConflictRows([first!.id], "mine")).toBe(true);
    expect(memory.getConflictReviewSnapshot()).toMatchObject({
      open: true,
      count: 1,
      saving: true,
    });
    memory.closeConflictReview();
    expect(memory.getConflictReviewSnapshot().open).toBe(true);

    expect(memory.resolveConflictRows([second!.id], "mine")).toBe(true);
    expect(memory.getConflictReviewSnapshot()).toMatchObject({
      open: true,
      count: 0,
      resolutionCount: 2,
      saving: true,
    });
    memory.resolveConflictReviewSave("immediate-review-1");
    expect(memory.getConflictReviewSnapshot()).toMatchObject({ open: true, saving: true });
    memory.closeConflictReview();
    expect(memory.getConflictReviewSnapshot().open).toBe(true);

    memory.resolveConflictReviewSave("immediate-review-2");
    expect(memory.getConflictReviewSnapshot()).toMatchObject({
      open: false,
      resolutionCount: 0,
      saving: false,
    });
  });

  it("retains unrelated Immediate resolutions while unresolved conflicts keep review open", () => {
    type Row = EditMemoryTestRow;
    const rows = new Map<string, Row>([
      ["row-a", Object.freeze({ id: "row-a", value: "base-a", revision: 1n })],
      ["row-b", Object.freeze({ id: "row-b", value: "base-b", revision: 1n })],
      ["row-c", Object.freeze({ id: "row-c", value: "base-c", revision: 1n })],
    ]);
    const memory = new BrunoTableEditMemoryRuntime();
    let saveReady = false;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns: valueColumns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).revision,
      onCommitGesture: (changes) => (saveReady ? memory.requestImmediateSave(changes) : undefined),
    });
    cellEdit.activate();
    memory.activate();
    let operationSequence = 0;
    const releaseSaves: Array<() => void> = [];
    disposers.push(
      memory.connectCellEdit(cellEdit),
      memory.registerImmediateSaveCommand((_changes, initiatedFrom) => {
        operationSequence += 1;
        releaseSaves.push(
          memory.beginSaveWork(
            `immediate-review-${String(operationSequence)}`,
            "immediate",
            initiatedFrom,
          ),
        );
        return "admitted";
      }),
      () => {
        for (const releaseSave of releaseSaves) releaseSave();
      },
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    const [rowA, rowB, rowC] = [...rows.values()];
    if (rowA === undefined || rowB === undefined || rowC === undefined) {
      throw new Error("Expected three conflict rows.");
    }
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: rowA.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rowA,
          expectedVersion: rowA.revision,
          base: rowA.value,
          mine: "mine-a",
          conflict: { server: "server-a", serverVersion: 2n },
        },
        {
          rowId: rowB.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rowB,
          expectedVersion: rowB.revision,
          base: rowB.value,
          mine: "mine-b",
          conflict: { server: "server-b", serverVersion: 2n },
        },
        {
          rowId: rowC.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rowC,
          expectedVersion: rowC.revision,
          base: rowC.value,
          mine: "mine-c",
          conflict: { server: "server-c", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    for (const [rowId, current] of rows) {
      rows.set(rowId, Object.freeze({ ...current, value: `server-${rowId.at(-1)}`, revision: 2n }));
    }
    cellEdit.reconcileSourceRows(new Set(rows.keys()));
    expect(memory.openConflictReview()).toBe(true);
    const reviewRows = cellEdit.getDraftReviewSnapshot();
    const rowAConflict = reviewRows.find((entry) => entry.rowId === rowA.id);
    const rowBConflict = reviewRows.find((entry) => entry.rowId === rowB.id);
    expect(rowAConflict).toBeDefined();
    expect(rowBConflict).toBeDefined();
    saveReady = true;

    expect(memory.resolveConflictRows([rowBConflict!.id], "server")).toBe(true);
    expect(memory.resolveConflictRows([rowAConflict!.id], "mine")).toBe(true);
    expect(memory.getConflictReviewSnapshot()).toMatchObject({
      open: true,
      count: 1,
      resolutionCount: 2,
      saving: true,
    });

    memory.resolveConflictReviewSave("immediate-review-1");

    expect(memory.getConflictReviewSnapshot()).toMatchObject({
      open: true,
      count: 1,
      resolutionCount: 2,
      saving: false,
    });
    expect(memory.getConflictResolutionSnapshot(rowBConflict!.id)).toMatchObject({
      resolution: "server",
    });
  });

  it("finalizes retained Server evidence when a mixed Immediate review succeeds", () => {
    type Row = EditMemoryTestRow;
    const rows = new Map<string, Row>([
      ["row-a", Object.freeze({ id: "row-a", value: "base-a", revision: 1n })],
      ["row-b", Object.freeze({ id: "row-b", value: "base-b", revision: 1n })],
    ]);
    const memory = new BrunoTableEditMemoryRuntime();
    let saveReady = false;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns: valueColumns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).revision,
      onCommitGesture: (changes) => (saveReady ? memory.requestImmediateSave(changes) : undefined),
    });
    cellEdit.activate();
    memory.activate();
    let releaseSave = (): void => undefined;
    let submittedChangeSet: Parameters<BrunoTableCellEditRuntime["acceptSave"]>[1] | undefined;
    disposers.push(
      memory.connectCellEdit(cellEdit),
      memory.registerImmediateSaveCommand((changes, initiatedFrom) => {
        releaseSave = memory.beginSaveWork("immediate-review-1", "immediate", initiatedFrom);
        const change = changes[0];
        if (change === undefined) return "rejected";
        const currentRow = rows.get(change.rowId);
        if (currentRow === undefined) return "rejected";
        const nextChangeSet = Object.freeze([
          Object.freeze({
            rowId: change.rowId,
            baseRow: currentRow,
            expectedVersion: currentRow.revision,
            changes: Object.freeze([
              Object.freeze({
                columnId: change.columnId,
                field: change.field,
                before: change.before,
                after: change.after,
              }),
            ] as const),
          }),
        ] as const);
        submittedChangeSet = nextChangeSet;
        if (!cellEdit.beginSaveOperation("immediate-review-1", nextChangeSet, false)) {
          return "rejected";
        }
        return "admitted";
      }),
      () => releaseSave(),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    const [rowA, rowB] = [...rows.values()];
    if (rowA === undefined || rowB === undefined) throw new Error("Expected two conflict rows.");
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: rowA.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rowA,
          expectedVersion: rowA.revision,
          base: rowA.value,
          mine: "mine-a",
          conflict: { server: "server-a", serverVersion: 2n },
        },
        {
          rowId: rowB.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rowB,
          expectedVersion: rowB.revision,
          base: rowB.value,
          mine: "mine-b",
          conflict: { server: "server-b", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    for (const [rowId, current] of rows) {
      rows.set(rowId, Object.freeze({ ...current, value: `server-${rowId.at(-1)}`, revision: 2n }));
    }
    cellEdit.reconcileSourceRows(new Set(rows.keys()));
    expect(memory.openConflictReview()).toBe(true);
    const reviewRows = cellEdit.getDraftReviewSnapshot();
    const rowAConflict = reviewRows.find((entry) => entry.rowId === rowA.id);
    const rowBConflict = reviewRows.find((entry) => entry.rowId === rowB.id);
    expect(rowAConflict).toBeDefined();
    expect(rowBConflict).toBeDefined();
    saveReady = true;

    expect(memory.resolveConflictRows([rowBConflict!.id], "server")).toBe(true);
    expect(memory.resolveConflictRows([rowAConflict!.id], "mine")).toBe(true);
    expect(cellEdit.hasRetainedConflictResolution(rowBConflict!.id)).toBe(true);
    expect(memory.getConflictReviewSnapshot()).toMatchObject({
      open: true,
      count: 0,
      resolutionCount: 2,
      saving: true,
    });

    if (submittedChangeSet === undefined) throw new Error("Expected one submitted Mine change.");
    cellEdit.acceptSave("immediate-review-1", submittedChangeSet, false);
    memory.resolveConflictReviewSave("immediate-review-1");

    expect(memory.getConflictReviewSnapshot()).toMatchObject({
      open: false,
      resolutionCount: 0,
      saving: false,
    });
    expect(cellEdit.hasRetainedConflictResolution(rowBConflict!.id)).toBe(false);
    expect(cellEdit.getRetainedDraftDependencyCellCount()).toBe(0);
    cellEdit.reconcileSourceRows(undefined);
    expect(cellEdit.getActivitySnapshot()).toMatchObject({ draftCount: 0, conflictCount: 0 });
  });

  it("does not let unrelated save work inherit a rejected Conflict Review admission", () => {
    type Row = EditMemoryTestRow;
    let currentRow: Row = Object.freeze({
      id: "row-1",
      value: "server",
      revision: 1n,
    });
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => currentRow,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    let releaseUnrelatedSave = (): void => undefined;
    disposers.push(
      memory.connectCellEdit(cellEdit),
      memory.registerSaveCommand((initiatedFrom) => {
        const releaseReviewAdmission = memory.beginSaveWork(
          "review-admission",
          "batch",
          initiatedFrom,
        );
        memory.rejectSaveWorkAdmission("review-admission", initiatedFrom);
        releaseReviewAdmission();
        releaseUnrelatedSave = memory.beginSaveWork("unrelated-save", "immediate");
        return false;
      }),
      () => releaseUnrelatedSave(),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );

    expect(memory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: currentRow.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: currentRow,
          expectedVersion: currentRow.revision,
          base: currentRow.value,
          mine: "mine",
          conflict: { server: "server-now", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    currentRow = Object.freeze({ ...currentRow, value: "server-now", revision: 2n });
    cellEdit.reconcileSourceRows(new Set([currentRow.id]));
    expect(memory.openConflictReview()).toBe(true);
    const conflictId = cellEdit.getDraftReviewSnapshot()[0]?.id;
    expect(conflictId).toBeDefined();
    expect(memory.resolveConflictRows([conflictId!], "mine")).toBe(true);

    expect(memory.saveConflictReview()).toBe(false);
    expect(memory.getConflictReviewSnapshot()).toMatchObject({ open: true, saving: false });

    memory.resolveConflictReviewSave("unrelated-save");
    expect(memory.getConflictReviewSnapshot()).toMatchObject({ open: true, saving: false });
  });

  it("retains a Mine acknowledgement while its authoritative row is absent", () => {
    type Row = EditMemoryTestRow;
    let row: Row | undefined = Object.freeze({
      id: "row-1",
      value: "base",
      revision: 1n,
    });
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: "row-1",
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: row!,
          expectedVersion: 1n,
          base: "base",
          mine: "mine",
        },
      ]),
    ).toBe(true);
    row = Object.freeze({ id: "row-1", value: "server", revision: 3n });
    cellEdit.reconcileSourceRows(new Set(["row-1"]));
    expect(memory.openConflictReview()).toBe(true);
    const id = cellEdit.getDraftReviewSnapshot()[0]!.id;
    expect(memory.resolveConflictRows([id], "mine")).toBe(true);

    row = undefined;
    cellEdit.reconcileSourceRows(undefined);
    expect(memory.getConflictResolutionSnapshot(id)).toMatchObject({ resolution: "mine" });

    row = Object.freeze({ id: "row-1", value: "server", revision: 2n });
    cellEdit.reconcileSourceRows(undefined);
    expect(memory.getConflictResolutionSnapshot(id)).toBeUndefined();
    expect(cellEdit.getActivitySnapshot().conflictCount).toBe(1);
    expect(memory.resolveConflictRows([id], "mine")).toBe(true);
    row = Object.freeze({ id: "row-1", value: "mine", revision: 4n });
    cellEdit.reconcileSourceRows(new Set(["row-1"]));
    expect(cellEdit.getRetainedResolutionPublicationSnapshot()).toContain(id);
    expect(cellEdit.isDraftConflictEvidenceCurrent(id, "mine", "server", 2n)).toBe(false);
    expect(cellEdit.isConflictResolutionLocallyUndone(id, "server", 2n)).toBe(false);
    expect(cellEdit.isConflictResolutionTemporarilyDiscarded(id)).toBe(false);
    expect(cellEdit.hasRetainedConflictResolution(id)).toBe(false);
    expect(memory.getConflictResolutionSnapshot(id)).toBeUndefined();
    expect(cellEdit.getActivitySnapshot().conflictCount).toBe(0);
    expect(memory.getConflictReviewRowsSnapshot()).toHaveLength(0);
  });

  it("closes an Immediate Server review while its row is absent and reopens on return", () => {
    type Row = EditMemoryTestRow;
    let row: Row | undefined = Object.freeze({ id: "row-1", value: "base", revision: 1n });
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: "row-1",
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: row!,
          expectedVersion: 1n,
          base: "base",
          mine: "mine",
        },
      ]),
    ).toBe(true);
    row = Object.freeze({ id: "row-1", value: "server", revision: 2n });
    cellEdit.reconcileSourceRows(new Set(["row-1"]));
    expect(memory.openConflictReview()).toBe(true);
    const id = cellEdit.getDraftReviewSnapshot()[0]!.id;
    expect(memory.resolveConflictRows([id], "server")).toBe(true);

    row = undefined;
    cellEdit.reconcileSourceRows(new Set(["row-1"]));
    memory.closeConflictReview();
    expect(memory.getConflictReviewSnapshot().open).toBe(false);
    expect(memory.getConflictResolutionSnapshot(id)).toMatchObject({ resolution: "server" });

    row = Object.freeze({ id: "row-1", value: "server", revision: 3n });
    cellEdit.reconcileSourceRows(new Set(["row-1"]));
    expect(cellEdit.getActivitySnapshot().conflictCount).toBe(1);
  });

  it("reconciles only the authoritative subset when an Immediate Server review closes", () => {
    type Row = EditMemoryTestRow;
    const rows = new Map<string, Row>([
      ["row-1", Object.freeze({ id: "row-1", value: "base-1", revision: 1n })],
      ["row-2", Object.freeze({ id: "row-2", value: "base-2", revision: 1n })],
    ]);
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    const [firstRow, secondRow] = [...rows.values()] as [Row, Row];
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: firstRow.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: firstRow,
          expectedVersion: firstRow.revision,
          base: firstRow.value,
          mine: `mine-${firstRow.id}`,
        },
        {
          rowId: secondRow.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: secondRow,
          expectedVersion: secondRow.revision,
          base: secondRow.value,
          mine: `mine-${secondRow.id}`,
        },
      ]),
    ).toBe(true);
    rows.set("row-1", Object.freeze({ id: "row-1", value: "server-1", revision: 2n }));
    rows.set("row-2", Object.freeze({ id: "row-2", value: "server-2", revision: 2n }));
    cellEdit.reconcileSourceRows(undefined);
    expect(memory.openConflictReview()).toBe(true);
    const idsByRow = new Map(
      cellEdit.getDraftReviewSnapshot().map((row) => [row.rowId, row.id] as const),
    );
    const firstId = idsByRow.get("row-1")!;
    const secondId = idsByRow.get("row-2")!;
    expect(memory.resolveConflictRows([firstId, secondId], "server")).toBe(true);

    rows.delete("row-2");
    cellEdit.reconcileSourceRows(new Set(["row-2"]));
    memory.closeConflictReview();

    expect(memory.getConflictReviewSnapshot().open).toBe(false);
    expect(memory.getConflictResolutionSnapshot(firstId)).toBeUndefined();
    expect(memory.getConflictResolutionSnapshot(secondId)).toMatchObject({
      resolution: "server",
    });
    expect(cellEdit.getActivitySnapshot().conflictCount).toBe(1);

    rows.set("row-2", Object.freeze({ id: "row-2", value: "server-2", revision: 3n }));
    cellEdit.reconcileSourceRows(new Set(["row-2"]));
    expect(memory.getConflictResolutionSnapshot(secondId)).toBeUndefined();
    expect(cellEdit.getActivitySnapshot().conflictCount).toBe(2);
  });

  it.each(["mine", "server"] as const)(
    "reconciles an undone %s resolution after the source returns to the safe base",
    (resolution) => {
      type Row = EditMemoryTestRow;
      let row: Row = Object.freeze({ id: "row-1", value: "base", revision: 1n });
      const columns = valueColumns;
      const cellEdit = new BrunoTableCellEditRuntime({
        columns,
        getRow: () => row,
        getRowVersion: (candidate) => (candidate as Row).revision,
      });
      const memory = new BrunoTableEditMemoryRuntime();
      cellEdit.activate();
      memory.activate();
      disposers.push(
        memory.connectCellEdit(cellEdit),
        () => memory.dispose(),
        () => cellEdit.dispose(),
      );
      expect(memory.requestMode("batch")).toBe(true);
      expect(
        cellEdit.applyAcceptedDraftGesture([
          {
            rowId: row.id,
            columnId: "COL_ID_VALUE",
            field: "value",
            baseRow: row,
            expectedVersion: row.revision,
            base: row.value,
            mine: "mine",
          },
        ]),
      ).toBe(true);
      row = Object.freeze({ ...row, value: "server", revision: 2n });
      cellEdit.reconcileSourceRows(new Set([row.id]));
      expect(memory.openConflictReview()).toBe(true);
      const id = cellEdit.getDraftReviewSnapshot()[0]!.id;
      expect(memory.resolveConflictRows([id], resolution)).toBe(true);
      memory.closeConflictReview();
      expect(memory.undo()).toBe(true);
      expect(cellEdit.getActivitySnapshot().conflictCount).toBe(1);

      row = Object.freeze({ ...row, value: "base", revision: 3n });
      cellEdit.reconcileSourceRows(new Set([row.id]));
      expect(cellEdit.getActivitySnapshot()).toMatchObject({
        draftCount: 1,
        conflictCount: 0,
        redoCount: 0,
      });
    },
  );

  it("releases the narrow draft-review subscription when either sparse review closes", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    disposers.push(() => vi.unstubAllGlobals());
    type Row = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly editable: boolean;
      readonly revision: bigint;
    }>;
    let row: Row = Object.freeze({
      id: "row-1",
      value: "base",
      editable: true,
      revision: 1n,
    });
    const columns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: ({ row: candidate }: { readonly row: Row }) => candidate.editable,
      },
    ]);
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    const getDraftReviewSubscriberCount = (): number =>
      (
        cellEdit as unknown as {
          readonly draftReviewSubscriberCount: number;
        }
      ).draftReviewSubscriberCount;
    const getConflictResolutionStoreCount = (): number =>
      (
        memory as unknown as {
          readonly conflictResolutionControlStores: ReadonlyMap<string, unknown>;
        }
      ).conflictResolutionControlStores.size;
    let frameSequence = 0;
    class ReviewFocusTarget {
      public readonly closest = vi.fn(() => null);
      public readonly dataset: DOMStringMap = {};
      public readonly focus = vi.fn();
      public readonly isConnected = true;
      public ownerDocument!: Document;
    }
    const cancelReviewFrame = vi.fn();
    const requestReviewFrame = vi.fn(() => (frameSequence += 1));
    const reviewWindow = {
      HTMLElement: ReviewFocusTarget,
      cancelAnimationFrame: cancelReviewFrame,
      requestAnimationFrame: requestReviewFrame,
    } as unknown as Window;
    const reviewDocument = {
      activeElement: null,
      defaultView: reviewWindow,
    } as unknown as Document;
    const conflictFocus = new ReviewFocusTarget();
    conflictFocus.ownerDocument = reviewDocument;
    const blockedFocus = new ReviewFocusTarget();
    blockedFocus.ownerDocument = reviewDocument;
    cellEdit.activate();
    memory.activate();
    const disconnect = memory.connectCellEdit(cellEdit);
    disposers.push(
      disconnect,
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );

    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: row,
          expectedVersion: row.revision,
          base: "base",
          mine: "mine",
          conflict: { server: "server", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    row = Object.freeze({ ...row, value: "server", editable: false, revision: 2n });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(cellEdit.getActivitySnapshot()).toMatchObject({ conflictCount: 1, blockedCount: 1 });

    expect(getDraftReviewSubscriberCount()).toBe(0);
    expect(memory.openConflictReview(conflictFocus as unknown as EventTarget)).toBe(true);
    expect(getDraftReviewSubscriberCount()).toBe(1);
    const conflictId = cellEdit.getDraftReviewSnapshot()[0]?.id;
    expect(conflictId).toBeDefined();
    const unsubscribeResolution = memory.subscribeConflictResolutionControl(
      conflictId!,
      () => undefined,
    );
    expect(getConflictResolutionStoreCount()).toBe(1);
    memory.closeConflictReview();
    expect(getDraftReviewSubscriberCount()).toBe(0);
    expect(getConflictResolutionStoreCount()).toBe(0);
    unsubscribeResolution();
    expect(requestReviewFrame).toHaveBeenCalledOnce();

    expect(memory.openBlockedReview(blockedFocus as unknown as EventTarget)).toBe(true);
    expect(cancelReviewFrame).toHaveBeenCalledWith(1);
    expect(getDraftReviewSubscriberCount()).toBe(1);
    memory.closeBlockedReview();
    expect(getDraftReviewSubscriberCount()).toBe(0);
  });

  it("bounds per-conflict stores while one open review cycles through new identities", () => {
    type Row = EditMemoryTestRow;
    const rows = new Map<string, Row>();
    let authoritative = true;
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).revision,
      isSourceAuthoritative: () => authoritative,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    const getStoreCount = (): number => {
      const stores = memory as unknown as {
        readonly conflictResolutionControlStores: ReadonlyMap<string, unknown>;
      };
      return stores.conflictResolutionControlStores.size;
    };
    cellEdit.activate();
    memory.activate();
    disposers.push(
      memory.connectCellEdit(cellEdit),
      () => memory.dispose(),
      () => cellEdit.dispose(),
    );
    expect(memory.requestMode("batch")).toBe(true);

    for (let index = 0; index < 128; index += 1) {
      const base = Object.freeze({ id: `row-${String(index)}`, value: "base", revision: 1n });
      const server = Object.freeze({ ...base, value: "server", revision: 2n });
      rows.set(base.id, server);
      expect(
        cellEdit.applyAcceptedDraftGesture([
          {
            rowId: base.id,
            columnId: "COL_ID_VALUE",
            field: "value",
            baseRow: base,
            expectedVersion: base.revision,
            base: base.value,
            mine: "mine",
            conflict: { server: server.value, serverVersion: server.revision },
          },
        ]),
      ).toBe(true);
      if (index === 0) expect(memory.openConflictReview()).toBe(true);
      const id = cellEdit.getDraftReviewSnapshot()[0]!.id;
      expect(memory.getConflictResolutionSnapshot(id)).toBeUndefined();
      expect(memory.getConflictResolutionAvailabilitySnapshot(id)).toMatchObject({
        mineAvailable: true,
        serverAvailable: true,
      });

      rows.set(base.id, Object.freeze({ ...base, value: "mine", revision: 3n }));
      cellEdit.reconcileSourceRows(new Set([base.id]));
      expect(cellEdit.getActivitySnapshot().conflictCount).toBe(0);
    }

    expect(memory.getConflictReviewSnapshot().open).toBe(true);
    expect(getStoreCount()).toBe(0);

    const current = Object.freeze({ id: "row-current", value: "server", revision: 2n });
    rows.set(current.id, current);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: current.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: Object.freeze({ ...current, value: "base", revision: 1n }),
          expectedVersion: 1n,
          base: "base",
          mine: "mine",
          conflict: { server: current.value, serverVersion: current.revision },
        },
      ]),
    ).toBe(true);
    const currentId = cellEdit.getDraftReviewSnapshot()[0]!.id;
    const controlListener = vi.fn();
    const firstControl = memory.getConflictResolutionControlSnapshot(currentId);
    expect(memory.getConflictResolutionControlSnapshot(currentId)).toBe(firstControl);
    const unsubscribeControl = memory.subscribeConflictResolutionControl(
      currentId,
      controlListener,
    );
    expect(getStoreCount()).toBe(1);

    authoritative = false;
    memory.setSavePreflightAvailable(false);
    expect(controlListener).toHaveBeenCalledOnce();
    expect(memory.getConflictResolutionControlSnapshot(currentId)).toMatchObject({
      active: true,
      resolution: undefined,
      mineAvailable: false,
      serverAvailable: false,
    });
    expect(memory.getConflictResolutionAvailabilitySnapshot(currentId)).toMatchObject({
      mineAvailable: false,
      serverAvailable: false,
    });

    authoritative = true;
    memory.setSavePreflightAvailable(true);
    expect(memory.getConflictResolutionAvailabilitySnapshot(currentId)).toMatchObject({
      mineAvailable: true,
      serverAvailable: true,
    });
    controlListener.mockClear();
    expect(memory.resolveConflictRows([currentId], "server")).toBe(true);
    expect(controlListener).toHaveBeenCalledOnce();
    expect(memory.getConflictResolutionControlSnapshot(currentId)).toMatchObject({
      active: false,
      resolution: "server",
      mineAvailable: false,
      serverAvailable: false,
    });
    expect(memory.getConflictResolutionSnapshot(currentId)).toMatchObject({
      resolution: "server",
    });

    unsubscribeControl();
    expect(getStoreCount()).toBe(0);
    expect(memory.getConflictResolutionSnapshot(currentId)).toMatchObject({
      resolution: "server",
    });
    expect(getStoreCount()).toBe(0);
  });

  it("reports an awaiting Batch operation even when no rows remain", () => {
    const memory = new BrunoTableEditMemoryRuntime();
    disposers.push(() => memory.dispose());
    memory.activate();
    const release = memory.beginSaveWork("batch:1", "batch");
    disposers.push(release);

    memory.setSaveWorkAwaitingSource("batch:1", 0);

    expect(memory.getSaveWorkSnapshot()).toEqual({
      pendingBatchCount: 0,
      awaitingBatchCount: 1,
      awaitingBatchRowCount: 0,
      pendingImmediateCount: 0,
      awaitingImmediateCount: 0,
    });
  });

  it("aggregates failures by operation and clears only the converged operation", () => {
    const memory = new BrunoTableEditMemoryRuntime();
    disposers.push(() => memory.dispose());
    memory.activate();
    const changeSet = [
      {
        rowId: "row-1",
        baseRow: { id: "row-1", value: "before" },
        expectedVersion: 1n,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: "before",
            after: "after",
          },
        ],
      },
    ] as const;
    const rows = [
      {
        rowId: "row-1",
        cells: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
          },
        ],
      },
    ];

    memory.recordSaveFailure("operation-1", new Error("First failed."), changeSet);
    memory.recordSaveFailure("operation-2", new Error("Second failed."), changeSet);
    expect(memory.getSaveFailureSnapshot()).toEqual({
      count: 2,
      messages: ["First failed.", "Second failed."],
      operations: [
        { operationId: "operation-1", message: "First failed.", rows },
        { operationId: "operation-2", message: "Second failed.", rows },
      ],
    });

    memory.clearSaveFailure("operation-1");
    expect(memory.getSaveFailureSnapshot()).toEqual({
      count: 1,
      messages: ["Second failed."],
      operations: [{ operationId: "operation-2", message: "Second failed.", rows }],
    });

    memory.dismissSaveFailures();
    expect(memory.getSaveFailureSnapshot()).toEqual({ count: 0, messages: [], operations: [] });
  });

  it("normalizes non-Error rejection reasons without reading unsafe explanation protocols", () => {
    const memory = new BrunoTableEditMemoryRuntime();
    disposers.push(() => memory.dispose());
    memory.activate();
    const changeSet = [
      {
        rowId: "row-1",
        baseRow: { id: "row-1", value: "before" },
        expectedVersion: 1n,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: "before",
            after: "after",
          },
        ],
      },
    ] as const;
    const throwingMessage = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(throwingMessage, "message", {
      get: () => {
        throw new Error("Do not expose this getter failure.");
      },
    });

    memory.recordSaveFailure("operation-string", "  String rejection.  ", changeSet);
    memory.recordSaveFailure("operation-object", { message: "Object rejection." }, changeSet);
    memory.recordSaveFailure("operation-throwing", throwingMessage, changeSet);

    expect(
      memory.getSaveFailureSnapshot().operations.map((operation) => operation.message),
    ).toEqual([
      "The save could not be confirmed.",
      "The save could not be confirmed.",
      "The save could not be confirmed.",
    ]);
  });

  it("retains only rendered identity evidence for rejected-operation details", () => {
    const memory = new BrunoTableEditMemoryRuntime();
    disposers.push(() => memory.dispose());
    memory.activate();
    memory.recordSaveFailure("operation-1", new Error("Save failed."), [
      {
        rowId: "row-1",
        baseRow: { id: "row-1" },
        expectedVersion: { opaque: "version" },
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: { arbitrary: "before" },
            after: { arbitrary: "after" },
          },
        ],
      },
    ]);

    expect(memory.getSaveFailureSnapshot().operations).toEqual([
      {
        operationId: "operation-1",
        message: "Save failed.",
        rows: [
          {
            rowId: "row-1",
            cells: [{ columnId: "COL_ID_VALUE", field: "value" }],
          },
        ],
      },
    ]);
  });

  it("prunes rejected details by Cell Identity without waking the compact summary", () => {
    const memory = new BrunoTableEditMemoryRuntime();
    disposers.push(() => memory.dispose());
    memory.activate();
    const summaryListener = vi.fn();
    const detailListener = vi.fn();
    disposers.push(
      memory.subscribeSaveFailureSummary(summaryListener),
      memory.subscribeSaveFailure(detailListener),
    );
    memory.recordSaveFailure("operation-1", new Error("Save failed."), [
      {
        rowId: "row-1",
        baseRow: { id: "row-1", value: "before-1" },
        expectedVersion: 1n,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: "before-1",
            after: "after-1",
          },
        ],
      },
      {
        rowId: "row-2",
        baseRow: { id: "row-2", value: "before-2" },
        expectedVersion: 1n,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: "before-2",
            after: "after-2",
          },
        ],
      },
    ]);
    const before = memory.getSaveFailureSnapshot();
    expect(memory.getSaveFailureSnapshot()).toBe(before);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.operations)).toBe(true);
    expect(Object.isFrozen(before.operations[0]?.rows)).toBe(true);
    expect(Object.isFrozen(before.operations[0]?.rows[0]?.cells)).toBe(true);
    summaryListener.mockClear();
    detailListener.mockClear();

    memory.removeSaveFailureCells("operation-1", [{ rowId: "row-1", columnId: "COL_ID_VALUE" }]);

    expect(summaryListener).not.toHaveBeenCalled();
    expect(detailListener).toHaveBeenCalledTimes(1);
    const after = memory.getSaveFailureSnapshot();
    expect(after).not.toBe(before);
    expect(before.operations[0]?.rows).toHaveLength(2);
    expect(after.operations[0]?.rows).toEqual([
      {
        rowId: "row-2",
        cells: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
          },
        ],
      },
    ]);
  });

  it("publishes only compact changed footer projections and keeps Save command-owned", () => {
    type Row = EditMemoryTestRow;
    let row: Row = Object.freeze({ id: "row-1", value: "server", revision: 1n });
    const columns = valueColumns;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as typeof row).revision,
    });
    const memory = new BrunoTableEditMemoryRuntime();
    cellEdit.activate();
    memory.activate();
    const disconnect = memory.connectCellEdit(cellEdit);
    const modeListener = vi.fn();
    const statusListener = vi.fn();
    const resetListener = vi.fn();
    const saveListener = vi.fn();
    const unsubscribers = [
      memory.subscribeMode(modeListener),
      memory.subscribeSafetyStatus(statusListener),
      memory.subscribeCanReset(resetListener),
      memory.subscribeCanSave(saveListener),
    ];

    cellEdit.reconcileSourceRows(undefined);
    expect(modeListener).not.toHaveBeenCalled();
    expect(statusListener).not.toHaveBeenCalled();
    expect(resetListener).not.toHaveBeenCalled();
    expect(saveListener).not.toHaveBeenCalled();

    expect(memory.requestMode("batch")).toBe(true);
    expect(modeListener).toHaveBeenCalledOnce();
    expect(cellEdit.start(row.id, "COL_ID_VALUE")).toBe(true);
    expect(cellEdit.commit("draft")).toBe(true);
    expect(statusListener).toHaveBeenCalledOnce();
    expect(resetListener).toHaveBeenCalledOnce();
    expect(memory.getCanSaveSnapshot()).toBe(false);

    const save = vi.fn(() => true);
    const unregisterSave = memory.registerSaveCommand(save);
    expect(memory.getCanSaveSnapshot()).toBe(true);
    memory.setSaveOperationCapacityAvailable(false);
    expect(memory.getCanSaveSnapshot()).toBe(false);
    expect(memory.requestSave()).toBe(false);
    expect(cellEdit.getActivitySnapshot().draftCount).toBe(1);
    expect(save).not.toHaveBeenCalled();
    memory.setSaveOperationCapacityAvailable(true);
    expect(memory.getCanSaveSnapshot()).toBe(true);
    memory.setSavePreflightAvailable(false);
    expect(memory.getCanSaveSnapshot()).toBe(false);
    memory.setSavePreflightAvailable(true);
    expect(memory.getCanSaveSnapshot()).toBe(true);
    const releaseSaveWork = memory.beginSaveWork();
    expect(memory.getModeSnapshot().canChange).toBe(false);
    expect(memory.getCanResetSnapshot()).toBe(false);
    expect(memory.getCanSaveSnapshot()).toBe(false);
    expect(memory.requestSave()).toBe(false);
    expect(memory.undo()).toBe(false);
    expect(memory.redo()).toBe(false);
    expect(memory.openResetReview()).toBe(false);
    releaseSaveWork();
    expect(memory.getCanResetSnapshot()).toBe(true);
    expect(memory.getCanSaveSnapshot()).toBe(true);
    expect(memory.requestSave()).toBe(true);
    expect(save).toHaveBeenCalledOnce();

    expect(cellEdit.start(row.id, "COL_ID_VALUE")).toBe(true);
    expect(memory.getCanSaveSnapshot()).toBe(false);
    cellEdit.updateActiveCandidate("pending", false);
    expect(memory.getCanSaveSnapshot()).toBe(false);
    expect(cellEdit.cancel()).toBe(true);
    expect(memory.getCanSaveSnapshot()).toBe(true);

    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: row,
          expectedVersion: row.revision,
          base: "server",
          mine: "conflicted draft",
          conflict: { server: "new server", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    expect(memory.getCanSaveSnapshot()).toBe(false);
    const openConflictReview = vi.fn();
    const unregisterConflictReview = memory.registerConflictReviewCommand(openConflictReview);
    expect(memory.getCanSaveSnapshot()).toBe(true);
    expect(memory.requestSave()).toBe(true);
    expect(openConflictReview).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();

    expect(memory.getCanResetSnapshot()).toBe(true);
    expect(memory.getCanSaveSnapshot()).toBe(true);
    expect(memory.getHotkeyAvailabilitySnapshot()).toMatchObject({ undo: true });
    memory.dispose();
    expect(memory.getCanResetSnapshot()).toBe(false);
    expect(memory.getCanSaveSnapshot()).toBe(false);
    expect(memory.getHotkeyAvailabilitySnapshot()).toEqual({ undo: false, redo: false });

    modeListener.mockClear();
    statusListener.mockClear();
    resetListener.mockClear();
    saveListener.mockClear();
    row = Object.freeze({ id: "row-1", value: "server", revision: 2n });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(modeListener).not.toHaveBeenCalled();
    expect(statusListener).not.toHaveBeenCalled();
    expect(resetListener).not.toHaveBeenCalled();
    expect(saveListener).not.toHaveBeenCalled();

    unregisterSave();
    unregisterConflictReview();
    for (const unsubscribe of unsubscribers) unsubscribe();
    disconnect();
    cellEdit.dispose();
  });
});
