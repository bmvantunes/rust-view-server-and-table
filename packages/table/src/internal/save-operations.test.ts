import { afterEach, describe, expect, it, vi } from "vitest";

import { compileColumns } from "./compile-columns";
import { BrunoTableCellEditRuntime } from "./cell-edit";
import { BrunoTableEditMemoryRuntime } from "./edit-memory";
import { BrunoTableSaveOperationRuntime } from "./save-operations";

type Row = Readonly<{
  readonly id: string;
  readonly value: string;
  readonly revision: bigint;
}>;

const row: Row = Object.freeze({ id: "row-1", value: "server", revision: 1n });
const columns = compileColumns([
  {
    columnId: "COL_ID_VALUE",
    field: "value",
    headerName: "Value",
    valueType: "text",
    isEditable: true,
  },
]);
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

describe("BrunoTableSaveOperationRuntime", () => {
  it("rejects a scalar Immediate admission when its second Row Version read fails", () => {
    let immediateVersionReads = 0;
    let editMemory!: BrunoTableEditMemoryRuntime;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => {
        immediateVersionReads += 1;
        if (immediateVersionReads === 3) throw new Error("version unavailable");
        return (candidate as Row).revision;
      },
      onCommit: (change) => editMemory.requestImmediateSave([change]),
      onCommitGesture: (changes) => editMemory.requestImmediateSave(changes),
    });
    editMemory = new BrunoTableEditMemoryRuntime();
    const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
    const handler = vi.fn(() => Promise.resolve());
    const traversalInvalidation = vi.fn();
    const draftObservations: boolean[] = [];
    cellEdit.activate();
    editMemory.activate();
    disposers.push(
      () => cellEdit.dispose(),
      () => editMemory.dispose(),
      saveOperations.activate(),
      editMemory.connectCellEdit(cellEdit),
      saveOperations.setHandler(handler),
      cellEdit.subscribeTraversalInvalidation(traversalInvalidation),
      cellEdit.subscribeCell(row.id, "COL_ID_VALUE", () => {
        draftObservations.push(cellEdit.getDraftSnapshot(row.id, "COL_ID_VALUE") !== undefined);
      }),
    );

    expect(cellEdit.start(row.id, "COL_ID_VALUE")).toBe(true);
    cellEdit.updateActiveCandidate("mine", false);

    expect(cellEdit.commit("mine")).toBe(false);
    expect(cellEdit.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      rowId: row.id,
      columnId: "COL_ID_VALUE",
    });
    expect(cellEdit.getActiveCandidateSnapshot()).toEqual({
      kind: "scalar",
      rawText: "mine",
      nativeInvalid: false,
    });
    expect(cellEdit.getDraftSnapshot(row.id, "COL_ID_VALUE")).toBeUndefined();
    expect(draftObservations.every((hasDraft) => !hasDraft)).toBe(true);
    expect(immediateVersionReads).toBe(3);
    expect(traversalInvalidation).not.toHaveBeenCalled();
    expect(saveOperations.getRetainedOperationCount()).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an Immediate gesture when its second Row Version read fails", () => {
    let immediateVersionReads = 0;
    let editMemory!: BrunoTableEditMemoryRuntime;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => {
        immediateVersionReads += 1;
        if (immediateVersionReads === 2) throw new Error("version unavailable");
        return (candidate as Row).revision;
      },
      onCommit: (change) => editMemory.requestImmediateSave([change]),
      onCommitGesture: (changes) => editMemory.requestImmediateSave(changes),
    });
    editMemory = new BrunoTableEditMemoryRuntime();
    const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
    const handler = vi.fn(() => Promise.resolve());
    const traversalInvalidation = vi.fn();
    const draftObservations: boolean[] = [];
    cellEdit.activate();
    editMemory.activate();
    disposers.push(
      () => cellEdit.dispose(),
      () => editMemory.dispose(),
      saveOperations.activate(),
      editMemory.connectCellEdit(cellEdit),
      saveOperations.setHandler(handler),
      cellEdit.subscribeTraversalInvalidation(traversalInvalidation),
      cellEdit.subscribeCell(row.id, "COL_ID_VALUE", () => {
        draftObservations.push(cellEdit.getDraftSnapshot(row.id, "COL_ID_VALUE") !== undefined);
      }),
    );

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
    ).toBe(false);
    expect(cellEdit.getDraftSnapshot(row.id, "COL_ID_VALUE")).toBeUndefined();
    expect(draftObservations.every((hasDraft) => !hasDraft)).toBe(true);
    expect(immediateVersionReads).toBe(2);
    expect(traversalInvalidation).not.toHaveBeenCalled();
    expect(saveOperations.getRetainedOperationCount()).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("releases Conflict Review saving state when Batch admission fails", () => {
    let currentRow: Row = row;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => currentRow,
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const editMemory = new BrunoTableEditMemoryRuntime();
    const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
    const handler = vi.fn(() => Promise.resolve());
    cellEdit.activate();
    editMemory.activate();
    disposers.push(
      () => cellEdit.dispose(),
      () => editMemory.dispose(),
      saveOperations.activate(),
      editMemory.connectCellEdit(cellEdit),
      saveOperations.setHandler(handler),
    );

    expect(editMemory.requestMode("batch")).toBe(true);
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
          conflict: { server: "server-now", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    currentRow = Object.freeze({ ...row, value: "server-now", revision: 2n });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(editMemory.openConflictReview()).toBe(true);
    const conflictId = cellEdit.getDraftReviewSnapshot()[0]?.id;
    expect(conflictId).toBeDefined();
    expect(editMemory.resolveConflictRows([conflictId!], "mine")).toBe(true);
    expect(editMemory.getConflictReviewSnapshot()).toMatchObject({
      count: 0,
      resolutionCount: 1,
      saving: false,
    });
    vi.spyOn(cellEdit, "beginSaveOperation").mockReturnValueOnce(false);

    expect(editMemory.saveConflictReview()).toBe(false);

    expect(editMemory.getConflictReviewSnapshot()).toMatchObject({ open: true, saving: false });
    expect(saveOperations.getRetainedOperationCount()).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("clears redo-only identities after an accepted Batch save without poisoning later history", async () => {
    const rowA: Row = Object.freeze({ id: "row-a", value: "server-a", revision: 1n });
    const rowB: Row = Object.freeze({ id: "row-b", value: "server-b", revision: 1n });
    const rows = new Map<string, Row>([
      [rowA.id, rowA],
      [rowB.id, rowB],
    ]);
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).revision,
    });
    const editMemory = new BrunoTableEditMemoryRuntime();
    const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
    let resolveSave = (): void => undefined;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    cellEdit.activate();
    editMemory.activate();
    disposers.push(
      () => cellEdit.dispose(),
      () => editMemory.dispose(),
      saveOperations.activate(),
      editMemory.connectCellEdit(cellEdit),
      saveOperations.setHandler(handler),
    );

    expect(editMemory.requestMode("batch")).toBe(true);
    expect(cellEdit.start(rowB.id, "COL_ID_VALUE")).toBe(true);
    expect(cellEdit.commit("mine-b")).toBe(true);
    expect(cellEdit.start(rowA.id, "COL_ID_VALUE")).toBe(true);
    expect(cellEdit.commit("mine-a")).toBe(true);
    expect(editMemory.undo()).toBe(true);
    expect(cellEdit.getActivitySnapshot()).toMatchObject({
      draftCount: 1,
      undoCount: 1,
      redoCount: 1,
    });

    expect(editMemory.requestSave()).toBe(true);
    expect(handler).toHaveBeenCalledWith([
      {
        rowId: rowB.id,
        baseRow: rowB,
        expectedVersion: rowB.revision,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: rowB.value,
            after: "mine-b",
          },
        ],
      },
    ]);
    resolveSave();
    await vi.waitFor(
      () => {
        expect(cellEdit.getActivitySnapshot()).toMatchObject({
          draftCount: 0,
          undoCount: 0,
          redoCount: 0,
        });
      },
      { interval: 1 },
    );

    rows.set(rowB.id, Object.freeze({ ...rowB, value: "mine-b", revision: 2n }));
    cellEdit.reconcileSourceRows(new Set([rowB.id]));
    await vi.waitFor(
      () => {
        expect(saveOperations.getRetainedOperationCount()).toBe(0);
      },
      { interval: 1 },
    );
    expect(editMemory.requestMode("immediate")).toBe(true);
    expect(editMemory.requestMode("batch")).toBe(true);

    expect(cellEdit.start(rowA.id, "COL_ID_VALUE")).toBe(true);
    expect(cellEdit.commit("new-mine-a")).toBe(true);
    expect(cellEdit.getActivitySnapshot()).toMatchObject({ undoCount: 1, redoCount: 0 });
  });

  it.each([
    { outcome: "resolved" as const, expectedOpen: false, expectedResolutionCount: 0 },
    { outcome: "rejected" as const, expectedOpen: true, expectedResolutionCount: 1 },
  ])(
    "keeps the Conflict Review workflow authoritative when a Batch save is $outcome",
    async ({ outcome, expectedOpen, expectedResolutionCount }) => {
      let currentRow: Row = row;
      const cellEdit = new BrunoTableCellEditRuntime({
        columns,
        getRow: () => currentRow,
        getRowVersion: (candidate) => (candidate as Row).revision,
      });
      const editMemory = new BrunoTableEditMemoryRuntime();
      const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
      let resolveSave = (): void => undefined;
      let rejectSave = (_reason: Error): void => undefined;
      const handler = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            resolveSave = resolve;
            rejectSave = reject;
          }),
      );
      cellEdit.activate();
      editMemory.activate();
      disposers.push(
        () => cellEdit.dispose(),
        () => editMemory.dispose(),
        saveOperations.activate(),
        editMemory.connectCellEdit(cellEdit),
        saveOperations.setHandler(handler),
      );

      expect(editMemory.requestMode("batch")).toBe(true);
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
            conflict: { server: "server-now", serverVersion: 2n },
          },
        ]),
      ).toBe(true);
      currentRow = Object.freeze({ ...row, value: "server-now", revision: 2n });
      cellEdit.reconcileSourceRows(new Set([row.id]));
      expect(editMemory.openConflictReview()).toBe(true);
      const conflictId = cellEdit.getDraftReviewSnapshot()[0]?.id;
      expect(conflictId).toBeDefined();
      expect(editMemory.resolveConflictRows([conflictId!], "mine")).toBe(true);

      expect(editMemory.saveConflictReview()).toBe(true);
      expect(editMemory.getConflictReviewSnapshot()).toMatchObject({ open: true, saving: true });
      editMemory.closeConflictReview();
      expect(editMemory.getConflictReviewSnapshot().open).toBe(true);

      if (outcome === "resolved") resolveSave();
      else rejectSave(new Error("Compare-and-set rejected."));

      await vi.waitFor(
        () => {
          expect(editMemory.getConflictReviewSnapshot()).toMatchObject({
            open: expectedOpen,
            resolutionCount: expectedResolutionCount,
            saving: false,
          });
        },
        { interval: 1 },
      );
    },
  );

  it("backpressures Immediate edits at capacity and reopens admission after reconciliation", async () => {
    const pendingRows = new Map<string, Row>(
      Array.from({ length: 129 }, (_, index) => {
        const id = `row-${String(index)}`;
        return [id, Object.freeze({ id, value: "server", revision: 1n })];
      }),
    );
    let editMemory!: BrunoTableEditMemoryRuntime;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => pendingRows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).revision,
      onCommit: (change) => editMemory.requestImmediateSave([change]),
      onCommitGesture: (changes) => editMemory.requestImmediateSave(changes),
    });
    editMemory = new BrunoTableEditMemoryRuntime();
    const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
    const resolvePending: Array<() => void> = [];
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePending.push(resolve);
        }),
    );
    cellEdit.activate();
    editMemory.activate();
    disposers.push(
      () => cellEdit.dispose(),
      () => editMemory.dispose(),
      saveOperations.activate(),
      editMemory.connectCellEdit(cellEdit),
      saveOperations.setHandler(handler),
    );

    for (let index = 0; index < 128; index += 1) {
      const rowId = `row-${String(index)}`;
      expect(cellEdit.start(rowId, "COL_ID_VALUE")).toBe(true);
      expect(cellEdit.commit(`submitted-${String(index)}`)).toBe(true);
    }

    expect(handler).toHaveBeenCalledTimes(128);
    expect(saveOperations.getRetainedOperationCount()).toBe(128);
    expect(saveOperations.getRetainedChangeSetCount()).toBe(128);
    expect(cellEdit.start("row-128", "COL_ID_VALUE")).toBe(false);
    expect(cellEdit.getCellSnapshot("row-128", "COL_ID_VALUE")).toEqual({
      active: false,
      hasDraft: false,
    });

    pendingRows.set("row-0", Object.freeze({ id: "row-0", value: "submitted-0", revision: 2n }));
    resolvePending[0]!();
    await vi.waitFor(
      () => {
        cellEdit.reconcileSourceRows(new Set(["row-0"]));
        expect(saveOperations.getRetainedOperationCount()).toBe(127);
      },
      { interval: 1 },
    );
    expect(saveOperations.getRetainedChangeSetCount()).toBe(127);

    expect(cellEdit.start("row-128", "COL_ID_VALUE")).toBe(true);
    expect(cellEdit.commit("submitted-128")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(129);
    expect(saveOperations.getRetainedOperationCount()).toBe(128);
  });

  it("releases the submitted change set while awaiting live source confirmation", async () => {
    let editMemory!: BrunoTableEditMemoryRuntime;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: () => row.revision,
      onCommit: (change) => editMemory.requestImmediateSave([change]),
      onCommitGesture: (changes) => editMemory.requestImmediateSave(changes),
    });
    editMemory = new BrunoTableEditMemoryRuntime();
    const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
    cellEdit.activate();
    editMemory.activate();
    disposers.push(
      () => cellEdit.dispose(),
      () => editMemory.dispose(),
      saveOperations.activate(),
      editMemory.connectCellEdit(cellEdit),
      saveOperations.setHandler(() => Promise.resolve()),
    );

    expect(cellEdit.start(row.id, "COL_ID_VALUE")).toBe(true);
    expect(cellEdit.commit("submitted")).toBe(true);
    await vi.waitFor(
      () => {
        expect(cellEdit.getAcceptedOverlayCountForOperation("immediate:1")).toBe(1);
      },
      { interval: 1 },
    );

    expect(saveOperations.getRetainedOperationCount()).toBe(1);
    expect(saveOperations.getRetainedChangeSetCount()).toBe(0);
  });

  it("rejects non-thenable results and hostile then accessors through the ordinary workflow", async () => {
    const runInvalidHandler = async (handler: () => never): Promise<string> => {
      let editMemory!: BrunoTableEditMemoryRuntime;
      const cellEdit = new BrunoTableCellEditRuntime({
        columns,
        getRow: () => row,
        getRowVersion: () => row.revision,
        onCommit: (change) => editMemory.requestImmediateSave([change]),
        onCommitGesture: (changes) => editMemory.requestImmediateSave(changes),
      });
      editMemory = new BrunoTableEditMemoryRuntime();
      const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
      cellEdit.activate();
      editMemory.activate();
      disposers.push(
        () => cellEdit.dispose(),
        () => editMemory.dispose(),
        saveOperations.activate(),
        editMemory.connectCellEdit(cellEdit),
        saveOperations.setHandler(handler),
      );

      expect(cellEdit.start(row.id, "COL_ID_VALUE")).toBe(true);
      expect(cellEdit.commit("submitted")).toBe(true);
      await vi.waitFor(
        () => {
          expect(editMemory.getSaveFailureSnapshot().count).toBe(1);
        },
        { interval: 1 },
      );
      expect(cellEdit.start(row.id, "COL_ID_VALUE")).toBe(true);
      cellEdit.cancel();
      return editMemory.getSaveFailureSnapshot().operations[0]!.message;
    };

    await expect(runInvalidHandler(() => 42 as never)).resolves.toBe(
      "BrunoTable onSaveEdits must return a PromiseLike<void>.",
    );
    await expect(runInvalidHandler(() => undefined as never)).resolves.toBe(
      "BrunoTable onSaveEdits must return a PromiseLike<void>.",
    );
    await expect(runInvalidHandler(() => null as never)).resolves.toBe(
      "BrunoTable onSaveEdits must return a PromiseLike<void>.",
    );
    const hostile = new Proxy(Object.create(null) as object, {
      get: (_target, property) => {
        if (property === "then") throw new Error("Hostile then accessor.");
        return undefined;
      },
    });
    await expect(runInvalidHandler(() => hostile as never)).resolves.toBe("Hostile then accessor.");
  });

  it.each([
    {
      label: "throws synchronously",
      expectedMessage: "Compare-and-set rejected synchronously.",
      handler: () => {
        throw new Error("Compare-and-set rejected synchronously.");
      },
    },
    {
      label: "throws while reading then",
      expectedMessage: "Hostile then accessor.",
      handler: () =>
        new Proxy(Object.create(null) as object, {
          get: (_target, property) => {
            if (property === "then") throw new Error("Hostile then accessor.");
            return undefined;
          },
        }) as never,
    },
    {
      label: "returns a non-Promise result",
      expectedMessage: "BrunoTable onSaveEdits must return a PromiseLike<void>.",
      handler: () => 42 as never,
    },
  ])(
    "restores Immediate Conflict Review state when onSaveEdits $label",
    async ({ expectedMessage, handler }) => {
      let currentRow: Row = Object.freeze({ ...row, value: "base", revision: 1n });
      let editMemory!: BrunoTableEditMemoryRuntime;
      let saveReady = false;
      const cellEdit = new BrunoTableCellEditRuntime({
        columns,
        getRow: () => currentRow,
        getRowVersion: (candidate) => (candidate as Row).revision,
        onCommitGesture: (changes) =>
          saveReady ? editMemory.requestImmediateSave(changes) : undefined,
      });
      editMemory = new BrunoTableEditMemoryRuntime();
      const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
      cellEdit.activate();
      editMemory.activate();
      disposers.push(
        () => cellEdit.dispose(),
        () => editMemory.dispose(),
        saveOperations.activate(),
        editMemory.connectCellEdit(cellEdit),
        saveOperations.setHandler(handler),
      );
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
            conflict: { server: "server", serverVersion: 2n },
          },
        ]),
      ).toBe(true);
      currentRow = Object.freeze({ ...currentRow, value: "server", revision: 2n });
      cellEdit.reconcileSourceRows(new Set([currentRow.id]));
      expect(editMemory.openConflictReview()).toBe(true);
      const conflictId = cellEdit.getDraftReviewSnapshot()[0]?.id;
      expect(conflictId).toBeDefined();
      saveReady = true;

      expect(editMemory.resolveConflictRows([conflictId!], "mine")).toBe(true);

      expect(editMemory.getConflictReviewSnapshot()).toMatchObject({
        open: true,
        count: 0,
        resolutionCount: 1,
        saving: true,
      });
      expect(editMemory.getConflictResolutionSnapshot(conflictId!)).toMatchObject({
        resolution: "mine",
        reviewedServer: "server",
        reviewedServerVersion: 2n,
      });
      expect(editMemory.getConflictReviewRowsSnapshot()).toHaveLength(1);

      await vi.waitFor(
        () => {
          expect(editMemory.getConflictReviewSnapshot()).toMatchObject({
            open: true,
            count: 0,
            resolutionCount: 0,
            saving: false,
          });
          expect(editMemory.getSaveFailureSnapshot().count).toBe(1);
        },
        { interval: 1 },
      );

      expect(editMemory.getConflictResolutionSnapshot(conflictId!)).toBeUndefined();
      expect(editMemory.getConflictReviewRowsSnapshot()).toHaveLength(0);
      expect(cellEdit.getDraftSnapshot(currentRow.id, "COL_ID_VALUE")).toBeUndefined();
      expect(cellEdit.getCellSnapshot(currentRow.id, "COL_ID_VALUE")).toMatchObject({
        hasDraft: false,
        saveFailed: true,
      });
      expect(editMemory.saveConflictReview()).toBe(false);
      expect(editMemory.getSaveFailureSnapshot().operations[0]?.message).toBe(expectedMessage);
      expect(saveOperations.getRetainedOperationCount()).toBe(1);
    },
  );

  it("restores latest server state when an admitted Immediate Conflict Review save rejects", async () => {
    let currentRow: Row = Object.freeze({ ...row, value: "base", revision: 1n });
    let editMemory!: BrunoTableEditMemoryRuntime;
    let saveReady = false;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => currentRow,
      getRowVersion: (candidate) => (candidate as Row).revision,
      onCommitGesture: (changes) =>
        saveReady ? editMemory.requestImmediateSave(changes) : undefined,
    });
    editMemory = new BrunoTableEditMemoryRuntime();
    const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
    const handler = vi.fn(() => Promise.reject(new Error("Compare-and-set rejected.")));
    cellEdit.activate();
    editMemory.activate();
    disposers.push(
      () => cellEdit.dispose(),
      () => editMemory.dispose(),
      saveOperations.activate(),
      editMemory.connectCellEdit(cellEdit),
      saveOperations.setHandler(handler),
    );
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
          conflict: { server: "server", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    currentRow = Object.freeze({ ...currentRow, value: "server", revision: 2n });
    cellEdit.reconcileSourceRows(new Set([currentRow.id]));
    expect(editMemory.openConflictReview()).toBe(true);
    const conflictId = cellEdit.getDraftReviewSnapshot()[0]?.id;
    expect(conflictId).toBeDefined();
    saveReady = true;

    expect(editMemory.resolveConflictRows([conflictId!], "mine")).toBe(true);

    await vi.waitFor(
      () => {
        expect(editMemory.getSaveFailureSnapshot().count).toBe(1);
      },
      { interval: 1 },
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(cellEdit.getDraftSnapshot(currentRow.id, "COL_ID_VALUE")).toBeUndefined();
    expect(cellEdit.getCellSnapshot(currentRow.id, "COL_ID_VALUE")).toMatchObject({
      hasDraft: false,
      saveFailed: true,
    });
    expect(cellEdit.getActivitySnapshot()).toMatchObject({
      conflictCount: 0,
      draftCount: 0,
    });
  });

  it("keeps rejected Cell Identities distinct when their delimiter encodings collide", async () => {
    type CollisionRow = Readonly<{
      readonly id: string;
      readonly left: string;
      readonly right: string;
      readonly revision: bigint;
    }>;
    const collisionColumns = compileColumns([
      {
        columnId: "COL_ID_A\0COL_ID_B",
        field: "left",
        headerName: "Left",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_B",
        field: "right",
        headerName: "Right",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const first = Object.freeze({ id: "a", left: "first", right: "", revision: 1n });
    const second = Object.freeze({
      id: "a\0COL_ID_A",
      left: "",
      right: "second",
      revision: 1n,
    });
    const rows = new Map<string, CollisionRow>([
      [first.id, first],
      [second.id, second],
    ]);
    let rejectSave!: (reason: Error) => void;
    let editMemory!: BrunoTableEditMemoryRuntime;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns: collisionColumns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => (candidate as CollisionRow).revision,
      onCommitGesture: (changes) => editMemory.requestImmediateSave(changes),
    });
    editMemory = new BrunoTableEditMemoryRuntime();
    const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
    cellEdit.activate();
    editMemory.activate();
    disposers.push(
      () => cellEdit.dispose(),
      () => editMemory.dispose(),
      saveOperations.activate(),
      editMemory.connectCellEdit(cellEdit),
      saveOperations.setHandler(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectSave = reject;
          }),
      ),
    );

    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: first.id,
          columnId: "COL_ID_A\0COL_ID_B",
          field: "left",
          baseRow: first,
          expectedVersion: first.revision,
          base: first.left,
          mine: "first-submitted",
        },
        {
          rowId: second.id,
          columnId: "COL_ID_B",
          field: "right",
          baseRow: second,
          expectedVersion: second.revision,
          base: second.right,
          mine: "second-submitted",
        },
      ]),
    ).toBe(true);
    rows.set(first.id, Object.freeze({ ...first, left: "first-submitted", revision: 2n }));
    cellEdit.reconcileSourceRows(new Set([first.id]));
    rejectSave(new Error("One cell remained unconfirmed."));
    await vi.waitFor(
      () => {
        expect(editMemory.getSaveFailureSnapshot().count).toBe(1);
      },
      { interval: 1 },
    );

    expect(editMemory.getSaveFailureSnapshot().operations[0]?.rows).toEqual([
      {
        rowId: second.id,
        cells: [
          {
            columnId: "COL_ID_B",
            field: "right",
          },
        ],
      },
    ]);
  });

  it("bounds rejected workflows without consuming pending-operation capacity", async () => {
    let editMemory!: BrunoTableEditMemoryRuntime;
    const cellEdit = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: () => row.revision,
      onCommit: (change) => {
        editMemory.requestImmediateSave([change]);
      },
      onCommitGesture: (changes) => {
        editMemory.requestImmediateSave(changes);
      },
    });
    editMemory = new BrunoTableEditMemoryRuntime();
    const saveOperations = new BrunoTableSaveOperationRuntime(cellEdit, editMemory);
    const handler = vi.fn(() => Promise.reject(new Error("Not confirmed.")));
    cellEdit.activate();
    editMemory.activate();
    disposers.push(
      () => cellEdit.dispose(),
      () => editMemory.dispose(),
      saveOperations.activate(),
      editMemory.connectCellEdit(cellEdit),
      saveOperations.setHandler(handler),
    );
    for (let index = 0; index < 129; index += 1) {
      expect(cellEdit.start(row.id, "COL_ID_VALUE")).toBe(true);
      expect(cellEdit.commit("submitted")).toBe(true);
      await vi.waitFor(
        () => {
          expect(handler).toHaveBeenCalledTimes(index + 1);
          expect(saveOperations.getRetainedChangeSetCount()).toBe(0);
        },
        { interval: 1 },
      );
    }

    expect(editMemory.getSaveFailureSnapshot().count).toBe(128);
    expect(saveOperations.getRetainedOperationCount()).toBe(128);
    expect(saveOperations.getRetainedChangeSetCount()).toBe(0);
    expect(cellEdit.start(row.id, "COL_ID_VALUE")).toBe(true);
  });
});
