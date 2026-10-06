import { afterEach, describe, expect, it, vi } from "vitest";
import * as BigDecimal from "effect/BigDecimal";

import { BrunoTableSelectColumn } from "../column-helpers";
import { BrunoTableBigDecimalValueType } from "../effect";
import type { BrunoTableColumns, BrunoTableValueType } from "../public-types";
import {
  BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH,
  BrunoTableCellEditRuntime as BrunoTableCellEditRuntimeBase,
  isBrunoTableCellEditDraftReviewSourceRow,
  type BrunoTableCellEditChangeGesture,
  type BrunoTableCellEditConflictResolution,
  type BrunoTableCellEditDraftSnapshot,
  type BrunoTableCellEditSaveChangeSet,
} from "./cell-edit";
import { compileColumns } from "./compile-columns";

type Row = Readonly<{
  readonly id: string;
  readonly quantity: bigint;
  readonly score: number;
}>;

const row: Row = { id: "row-1", quantity: 9_007_199_254_740_993n, score: 4 };
const columns = compileColumns([
  {
    columnId: "COL_ID_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
    valueType: "bigint",
    isEditable: true,
  },
  {
    columnId: "COL_ID_SCORE",
    field: "score",
    headerName: "Score",
    valueType: "number",
    isEditable: ({ value }: { readonly value: number }) => value >= 0,
    validate: ({ value }: { readonly value: number }) =>
      value <= 10 ? undefined : "Score must be at most 10.",
  },
]);

const runtimes = new Set<BrunoTableCellEditRuntimeBase>();

class BrunoTableCellEditRuntime extends BrunoTableCellEditRuntimeBase {
  public constructor(options: ConstructorParameters<typeof BrunoTableCellEditRuntimeBase>[0]) {
    super(options);
    const disposeBase = this.dispose;
    Object.defineProperty(this, "dispose", {
      configurable: true,
      value: () => {
        runtimes.delete(this);
        disposeBase();
      },
    });
    runtimes.add(this);
    this.activate();
  }
}

afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes.clear();
});

describe("BrunoTable Cell Edit Session", () => {
  it("opens a current draft review after unsubscribed undo and redo and keeps it live", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.redoBatchDraft()).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { rowId: "row-1", columnId: "COL_ID_SCORE", mine: 7 },
    ]);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toEqual([]);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { rowId: "row-1", columnId: "COL_ID_SCORE", mine: 7 },
    ]);
    unsubscribe();
  });

  it("records bounded Batch draft history and retains redo intent at zero drafts", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.getDraftSnapshot("row-1", "COL_ID_SCORE")).toBe(7);
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 1,
      undoCount: 1,
      redoCount: 0,
    });

    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot("row-1", "COL_ID_SCORE")).toBeUndefined();
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      undoCount: 0,
      redoCount: 1,
    });

    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot("row-1", "COL_ID_SCORE")).toBe(7);
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 1,
      undoCount: 1,
      redoCount: 0,
    });
  });

  it("retains exact Base, Mine, row, field, and Row Version evidence per sparse draft", () => {
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: () => 17n,
    });

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        rowId: "row-1",
        columnId: "COL_ID_SCORE",
        field: "score",
        baseRow: row,
        expectedVersion: 17n,
        base: 4,
        mine: 7,
      },
    ]);

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        rowId: "row-1",
        columnId: "COL_ID_SCORE",
        field: "score",
        baseRow: row,
        expectedVersion: 17n,
        base: 4,
        mine: 8,
      },
    ]);
  });

  it("projects one exact same-row edit patch and shares the projected row across review cells", () => {
    type ProjectionRow = Readonly<{
      readonly id: string;
      readonly primary: string;
      readonly secondary: string;
    }>;
    const source = Object.freeze({ id: "row-1", primary: "A", secondary: "B" });
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_SECONDARY",
        field: "secondary",
        headerName: "Secondary",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<ProjectionRow>);
    const projectEditRow = vi.fn(
      ({
        row,
        patch,
      }: {
        readonly row: object;
        readonly patch: Readonly<Record<string, unknown>>;
      }) => Object.freeze({ ...(row as ProjectionRow), ...patch }),
    );
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => source,
      getRowId: (candidate) => (candidate as ProjectionRow).id,
      projectEditRow,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: 1n,
          base: source.primary,
          mine: "Mine A",
        },
        {
          rowId: source.id,
          columnId: "COL_ID_SECONDARY",
          field: "secondary",
          baseRow: source,
          expectedVersion: 1n,
          base: source.secondary,
          mine: "Mine B",
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    const review = runtime.getDraftReviewSnapshot();
    expect(projectEditRow).toHaveBeenCalledOnce();
    expect(projectEditRow).toHaveBeenCalledWith({
      row: source,
      patch: { primary: "Mine A", secondary: "Mine B" },
    });
    expect(review).toHaveLength(2);
    expect(review[0]?.projectedRow).toBe(review[1]?.projectedRow);
    expect(review[0]?.projectedRow).toEqual({
      id: source.id,
      primary: "Mine A",
      secondary: "Mine B",
    });
    expect(review.every((entry) => entry.projectedRowAvailable)).toBe(true);
    unsubscribe();

    const unsubscribeAgain = runtime.subscribeDraftReview(() => undefined);
    expect(projectEditRow).toHaveBeenCalledTimes(2);
    unsubscribeAgain();
  });

  it("accepts an identical memoized projection after the final review subscriber closes", () => {
    type MemoizedProjectionRow = Readonly<{ readonly id: string; readonly value: string }>;
    const source = Object.freeze({ id: "row-1", value: "server" });
    const projected = Object.freeze({ id: source.id, value: "mine" });
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<MemoizedProjectionRow>);
    const projectEditRow = vi.fn(() => projected);
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => source,
      getRowId: (candidate) => (candidate as MemoizedProjectionRow).id,
      projectEditRow,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: source,
          expectedVersion: 1n,
          base: source.value,
          mine: projected.value,
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).toBe(projected);
    unsubscribe();

    const unsubscribeAgain = runtime.subscribeDraftReview(() => undefined);
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).toBe(projected);
    expect(projectEditRow).toHaveBeenCalledTimes(2);
    unsubscribeAgain();
    const projectionHistory = (
      runtime as unknown as {
        readonly draftReviewProjectionHistoryByRowId: ReadonlyMap<string, unknown>;
      }
    ).draftReviewProjectionHistoryByRowId;
    expect(projectionHistory.size).toBe(1);

    runtime.resetAllDrafts();

    expect(projectionHistory.size).toBe(0);
  });

  it("withdraws a reused projection when its source changes while review is closed", () => {
    type MemoizedProjectionRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly sibling: string;
    }>;
    let source: MemoizedProjectionRow = Object.freeze({
      id: "row-1",
      value: "server",
      sibling: "first",
    });
    const projected = Object.freeze({ id: source.id, value: "mine", sibling: "first" });
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<MemoizedProjectionRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => source,
      getRowId: (candidate) => (candidate as MemoizedProjectionRow).id,
      projectEditRow: () => projected,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: source,
          expectedVersion: 1n,
          base: source.value,
          mine: projected.value,
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).toBe(projected);
    unsubscribe();

    source = Object.freeze({ ...source, sibling: "second" });
    runtime.reconcileSourceRows(new Set([source.id]));
    const unsubscribeAgain = runtime.subscribeDraftReview(() => undefined);
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
      projectedRow: undefined,
      projectedRowAvailable: false,
    });
    unsubscribeAgain();
  });

  it("withdraws a projection reused from any earlier changed-input publication", () => {
    type MemoizedProjectionRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly sibling: string;
      readonly revision: bigint;
    }>;
    const firstSource = Object.freeze({
      id: "row-1",
      value: "server",
      sibling: "first",
      revision: 1n,
    });
    const secondSource = Object.freeze({
      ...firstSource,
      sibling: "second",
      revision: 2n,
    });
    const firstProjection = Object.freeze({ ...firstSource, value: "mine" });
    const secondProjection = Object.freeze({ ...secondSource, value: "mine" });
    let source: MemoizedProjectionRow = firstSource;
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<MemoizedProjectionRow>);
    const projectEditRow = vi.fn(
      ({ row }: { readonly row: object; readonly patch: Readonly<Record<string, unknown>> }) =>
        row === firstSource ? firstProjection : secondProjection,
    );
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => source,
      getRowId: (candidate) => (candidate as MemoizedProjectionRow).id,
      getRowVersion: (candidate) => (candidate as MemoizedProjectionRow).revision,
      projectEditRow,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: firstSource.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: firstSource,
          expectedVersion: firstSource.revision,
          base: firstSource.value,
          mine: firstProjection.value,
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).toBe(firstProjection);

    source = secondSource;
    runtime.reconcileSourceRows(new Set([source.id]));
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).toBe(secondProjection);
    const projectionHistory = (
      runtime as unknown as {
        readonly draftReviewProjectionHistoryByRowId: ReadonlyMap<
          string,
          Readonly<{ readonly historicalProjectedRows: object }>
        >;
      }
    ).draftReviewProjectionHistoryByRowId;
    expect(projectionHistory.get(source.id)?.historicalProjectedRows).toBeInstanceOf(WeakSet);

    source = firstSource;
    runtime.reconcileSourceRows(new Set([source.id]));
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
      projectedRow: undefined,
      projectedRowAvailable: false,
    });
    expect(projectEditRow).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("releases partially established projection references after initial review publication fails", () => {
    type PartialProjectionRow = Readonly<{ readonly id: string; readonly value: string }>;
    const rows = new Map<string, PartialProjectionRow>([
      ["row-1", Object.freeze({ id: "row-1", value: "server-1" })],
      ["row-2", Object.freeze({ id: "row-2", value: "server-2" })],
    ]);
    const rowOneProjection = Object.freeze({ id: "row-1", value: "mine-1" });
    let failRowTwo = true;
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<PartialProjectionRow>);
    const projectEditRow = vi.fn(({ row, patch }) => {
      if (row.id === "row-1") return rowOneProjection;
      if (failRowTwo) throw new Error("row-2 projection failed");
      return Object.freeze({ ...row, ...patch });
    });
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: (rowId) => rows.get(rowId),
      getRowId: (candidate) => (candidate as PartialProjectionRow).id,
      projectEditRow,
    });
    const [firstSource, secondSource] = [...rows.values()];
    if (firstSource === undefined || secondSource === undefined) {
      throw new Error("Expected two projection sources.");
    }
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: firstSource.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: firstSource,
          expectedVersion: 1n,
          base: firstSource.value,
          mine: "mine-1",
        },
        {
          rowId: secondSource.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: secondSource,
          expectedVersion: 1n,
          base: secondSource.value,
          mine: "mine-2",
        },
      ]),
    ).toBe(true);

    expect(() => runtime.subscribeDraftReview(() => undefined)).toThrow("row-2 projection failed");
    failRowTwo = false;

    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(2);
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).toBe(rowOneProjection);
    unsubscribe();
  });

  it("does not poison historical projection identity when a later row aborts publication", () => {
    type ProjectionRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly sibling: string;
      readonly revision: bigint;
    }>;
    const rowOneA = Object.freeze({
      id: "row-1",
      value: "server-1",
      sibling: "a",
      revision: 1n,
    });
    const rowOneB = Object.freeze({ ...rowOneA, sibling: "b", revision: 2n });
    const rowTwo = Object.freeze({
      id: "row-2",
      value: "server-2",
      sibling: "two",
      revision: 1n,
    });
    const projectedA = Object.freeze({ ...rowOneA, value: "mine-1" });
    const projectedB = Object.freeze({ ...rowOneB, value: "mine-1" });
    const rows = new Map<string, ProjectionRow>([
      [rowOneA.id, rowOneA],
      [rowTwo.id, rowTwo],
    ]);
    let failRowTwo = true;
    const projectEditRow = vi.fn(
      ({ row, patch }: { readonly row: object; readonly patch: object }) => {
        const candidate = row as ProjectionRow;
        if (candidate.id === rowTwo.id && failRowTwo) throw new Error("row-2 projection failed");
        if (candidate === rowOneA) return projectedA;
        if (candidate === rowOneB) return projectedB;
        return Object.freeze({ ...candidate, ...patch });
      },
    );
    const runtime = new BrunoTableCellEditRuntime({
      columns: compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: "text",
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<ProjectionRow>),
      getRow: (rowId) => rows.get(rowId),
      getRowId: (candidate) => (candidate as ProjectionRow).id,
      getRowVersion: (candidate) => (candidate as ProjectionRow).revision,
      projectEditRow,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: rowOneA.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rowOneA,
          expectedVersion: rowOneA.revision,
          base: rowOneA.value,
          mine: projectedA.value,
        },
      ]),
    ).toBe(true);
    const unsubscribeA = runtime.subscribeDraftReview(() => undefined);
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).toBe(projectedA);
    unsubscribeA();

    rows.set(rowOneA.id, rowOneB);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: rowTwo.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rowTwo,
          expectedVersion: rowTwo.revision,
          base: rowTwo.value,
          mine: "mine-2",
        },
      ]),
    ).toBe(true);
    expect(() => runtime.subscribeDraftReview(() => undefined)).toThrow("row-2 projection failed");

    failRowTwo = false;
    const unsubscribeB = runtime.subscribeDraftReview(() => undefined);
    expect(
      runtime.getDraftReviewSnapshot().find((row) => row.rowId === rowOneA.id)?.projectedRow,
    ).toBe(projectedB);
    expect(projectEditRow.mock.calls.filter(([call]) => call.row === rowOneB)).toHaveLength(2);
    unsubscribeB();
  });

  it("publishes conflict classification swaps without republishing generic review membership", () => {
    type ReviewRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly revision: bigint;
    }>;
    const baseOne = Object.freeze({ id: "row-1", value: "one", revision: 1n });
    const baseTwo = Object.freeze({ id: "row-2", value: "two", revision: 1n });
    const currentRows = new Map<string, ReviewRow>([
      [baseOne.id, baseOne],
      [baseTwo.id, baseTwo],
    ]);
    const reviewColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<ReviewRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: reviewColumns,
      getRow: (rowId) => currentRows.get(rowId),
      getRowVersion: (candidate) => (candidate as ReviewRow).revision,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: baseOne.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: baseOne,
          expectedVersion: baseOne.revision,
          base: baseOne.value,
          mine: "mine-one",
        },
        {
          rowId: baseTwo.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: baseTwo,
          expectedVersion: baseTwo.revision,
          base: baseTwo.value,
          mine: "mine-two",
        },
      ]),
    ).toBe(true);
    currentRows.set(baseOne.id, Object.freeze({ ...baseOne, value: "server-one", revision: 2n }));
    runtime.reconcileSourceRows(new Set([baseOne.id, baseTwo.id]));
    const genericMembership = vi.fn();
    const classification = vi.fn();
    const unsubscribeReview = runtime.subscribeDraftReview(genericMembership);
    const unsubscribeClassification = runtime.subscribeDraftReviewClassification(classification);
    const idsByRow = new Map(
      runtime.getDraftReviewSourceSnapshot().map((source) => [source.rowId, source.id]),
    );
    expect(runtime.getDraftReviewClassificationSnapshot().conflictIds).toEqual(
      new Set([idsByRow.get(baseOne.id)]),
    );
    genericMembership.mockClear();
    classification.mockClear();

    currentRows.set(baseOne.id, Object.freeze({ ...baseOne, revision: 3n }));
    currentRows.set(baseTwo.id, Object.freeze({ ...baseTwo, value: "server-two", revision: 2n }));
    runtime.reconcileSourceRows(new Set([baseOne.id, baseTwo.id]));

    expect(runtime.getActivitySnapshot().conflictCount).toBe(1);
    expect(genericMembership).not.toHaveBeenCalled();
    expect(classification).toHaveBeenCalledOnce();
    expect(runtime.getDraftReviewClassificationSnapshot().conflictIds).toEqual(
      new Set([idsByRow.get(baseTwo.id)]),
    );
    unsubscribeClassification();
    unsubscribeReview();
  });

  it("publishes blocked classification swaps while the blocked count remains stable", () => {
    type ReviewRow = Readonly<{ readonly id: string; readonly value: string }>;
    const first = Object.freeze({ id: "row-1", value: "one" });
    const second = Object.freeze({ id: "row-2", value: "two" });
    const rows = new Map<string, ReviewRow>([
      [first.id, first],
      [second.id, second],
    ]);
    let blockedRowId: string | undefined;
    const reviewColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<ReviewRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: reviewColumns,
      getRow: (rowId) => rows.get(rowId),
      getRowVersion: (candidate) => {
        if ((candidate as ReviewRow).id === blockedRowId) throw new Error("unavailable");
        return 1n;
      },
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: first.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: first,
          expectedVersion: 1n,
          base: first.value,
          mine: "mine-one",
        },
        {
          rowId: second.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: second,
          expectedVersion: 1n,
          base: second.value,
          mine: "mine-two",
        },
      ]),
    ).toBe(true);
    blockedRowId = first.id;
    runtime.reconcileSourceRows(new Set([first.id, second.id]));
    const unsubscribeReview = runtime.subscribeDraftReview(() => undefined);
    const classification = vi.fn();
    const unsubscribeClassification = runtime.subscribeDraftReviewClassification(classification);
    const idsByRow = new Map(
      runtime.getDraftReviewSourceSnapshot().map((source) => [source.rowId, source.id]),
    );
    expect(runtime.getDraftReviewClassificationSnapshot().blockedIds).toEqual(
      new Set([idsByRow.get(first.id)]),
    );
    classification.mockClear();

    blockedRowId = second.id;
    runtime.reconcileSourceRows(new Set([first.id, second.id]));

    expect(runtime.getActivitySnapshot().blockedCount).toBe(1);
    expect(classification).toHaveBeenCalledOnce();
    expect(runtime.getDraftReviewClassificationSnapshot().blockedIds).toEqual(
      new Set([idsByRow.get(second.id)]),
    );
    unsubscribeClassification();
    unsubscribeReview();
  });

  it("does not iterate unrelated retained resolutions for one-cell draft publication", () => {
    const second = Object.freeze({ ...row, id: "row-2", score: 5 });
    const currentRows = new Map<string, Row>([
      [row.id, row],
      [second.id, second],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => currentRows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    currentRows.set(
      row.id,
      Object.freeze({ ...row, quantity: row.quantity + 1n, score: row.score + 1 }),
    );
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0];
    if (conflict?.conflict === undefined) throw new Error("Expected one retained conflict.");
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "server",
          reviewedServer: conflict.conflict.server,
          reviewedServerVersion: conflict.conflict.serverVersion,
        },
      ]),
    ).toBe(true);
    const retainedResolutionIds = (
      runtime as unknown as { readonly resolvedDraftReviewIds: Set<string> }
    ).resolvedDraftReviewIds;
    expect(retainedResolutionIds.size).toBe(1);
    const iterateRetainedResolutions = vi.spyOn(retainedResolutionIds, Symbol.iterator);

    expect(runtime.start(second.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);

    expect(iterateRetainedResolutions).not.toHaveBeenCalled();
  });

  it("clears 5,000 fully converged drafts and retained history without general-path scans", () => {
    const evidenceCount = 5_000;
    const baseRow = Object.freeze({ id: "base", quantity: 1n, score: 0 });
    const sourceRows = new Map<string, Row>();
    const createGesture = (offset: number) =>
      Array.from({ length: evidenceCount }, (_unused, index) => {
        const rowId = `row-${String(index)}`;
        const mine = index + offset;
        sourceRows.set(
          rowId,
          Object.freeze({ id: rowId, quantity: BigInt(index + 1), score: mine }),
        );
        return Object.freeze({
          rowId,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow,
          expectedVersion: 1n,
          base: baseRow.score,
          mine,
        });
      });
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => sourceRows.get(rowId),
    });
    runtime.setBatchHistoryEnabled(true);
    for (const offset of [1, 2]) {
      const [first, ...remaining] = createGesture(offset);
      if (first === undefined) throw new Error("Expected a non-empty convergence gesture.");
      expect(runtime.applyAcceptedDraftGesture([first, ...remaining])).toBe(true);
    }
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: evidenceCount,
      undoCount: 2,
    });
    const internals = runtime as unknown as {
      readonly rowVersionBlockedRowIds: Set<string>;
      readonly saveLockedCellKeys: Map<string, string>;
    };
    const deleteBlockedRow = vi.spyOn(internals.rowVersionBlockedRowIds, "delete");
    const readSaveLock = vi.spyOn(internals.saveLockedCellKeys, "get");
    const testSaveLock = vi.spyOn(internals.saveLockedCellKeys, "has");

    runtime.reconcileSourceRows(undefined);

    expect(runtime.getDraftMemorySnapshot()).toHaveLength(0);
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      undoCount: 0,
      redoCount: 0,
    });
    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(0);
    expect(runtime.undoBatchDraft()).toBe(false);
    expect(runtime.redoBatchDraft()).toBe(false);
    expect(deleteBlockedRow).not.toHaveBeenCalled();
    expect(readSaveLock).not.toHaveBeenCalled();
    expect(testSaveLock).not.toHaveBeenCalled();
  });

  it("publishes a row-scoped final convergence through the subscribed Cell Identity", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const published = vi.fn();
    const unsubscribe = runtime.subscribeCell(row.id, "COL_ID_SCORE", published);
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE")).toMatchObject({
      hasDraft: true,
      draft: 7,
    });

    current = Object.freeze({ ...row, score: 7, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));

    expect(published).toHaveBeenCalledOnce();
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE")).toEqual({
      active: false,
      hasDraft: false,
    });
    unsubscribe();
  });

  it("releases retained Server-resolution lineage through global source convergence", () => {
    const second = Object.freeze({
      id: "row-2",
      quantity: row.quantity + 1n,
      score: 3,
    });
    const rowsById = new Map<string, Row>([
      [row.id, row],
      [second.id, second],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rowsById.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(second.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);

    const conflictedSecond = Object.freeze({
      ...second,
      score: 5,
      quantity: second.quantity + 1n,
    });
    rowsById.set(second.id, conflictedSecond);
    runtime.reconcileSourceRows(new Set([second.id]));
    const conflict = runtime
      .getDraftReviewSnapshot()
      .find((candidate) => candidate.rowId === second.id);
    if (conflict?.conflict === undefined) throw new Error("Expected row B conflict evidence.");
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "server",
          reviewedServer: conflict.conflict.server,
          reviewedServerVersion: conflict.conflict.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(runtime.hasRetainedConflictResolution(conflict.id)).toBe(true);

    rowsById.set(row.id, Object.freeze({ ...row, score: 7, quantity: row.quantity + 1n }));
    rowsById.set(
      second.id,
      Object.freeze({ ...conflictedSecond, score: 8, quantity: conflictedSecond.quantity + 1n }),
    );
    runtime.reconcileSourceRows(undefined);

    expect(runtime.getDraftMemorySnapshot()).toHaveLength(0);
    expect(runtime.hasRetainedConflictResolution(conflict.id)).toBe(false);
    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(0);
    expect(runtime.reopenResolvedConflicts([conflict.id])).toBe(false);
    expect(runtime.undoBatchDraft()).toBe(false);
    expect(runtime.redoBatchDraft()).toBe(false);
  });

  it("keeps exact Mine and authentic Base but removes row-aware projection when the current row disappears", () => {
    type MissingProjectionRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly sibling: string;
    }>;
    const source = Object.freeze({ id: "row-1", value: "server", sibling: "source sibling" });
    let current: MissingProjectionRow | undefined = source;
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<MissingProjectionRow>);
    const projectEditRow = vi.fn(({ row, patch }) => Object.freeze({ ...row, ...patch }));
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => current,
      getRowId: (candidate) => (candidate as MissingProjectionRow).id,
      projectEditRow,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: source,
          expectedVersion: 1n,
          base: source.value,
          mine: "mine",
        },
      ]),
    ).toBe(true);
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    expect(projectEditRow).toHaveBeenCalledOnce();
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        baseRow: source,
        mine: "mine",
        projectedRowAvailable: true,
      },
    ]);

    current = undefined;
    runtime.reconcileSourceRows(new Set([source.id]));

    expect(projectEditRow).toHaveBeenCalledOnce();
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        baseRow: source,
        mine: "mine",
        projectedRow: undefined,
        projectedRowAvailable: false,
      },
    ]);
    unsubscribe();
  });

  it("preserves an own undefined patch field in projected review rows", () => {
    type OptionalProjectionRow = Readonly<{
      readonly id: string;
      readonly optional?: string;
    }>;
    const source = Object.freeze({ id: "row-1", optional: "server" });
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_OPTIONAL",
        field: "optional",
        headerName: "Optional",
        valueType: "text",
        isEditable: true,
        blankValue: undefined,
      },
    ] satisfies BrunoTableColumns<OptionalProjectionRow>);
    const patches: Readonly<Record<string, unknown>>[] = [];
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => source,
      getRowId: (candidate) => (candidate as OptionalProjectionRow).id,
      projectEditRow: ({ row, patch }) => {
        patches.push(patch);
        return Object.freeze({ ...row, ...patch });
      },
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_OPTIONAL",
          field: "optional",
          baseRow: source,
          expectedVersion: 1n,
          base: source.optional,
          mine: undefined,
        },
      ]),
    ).toBe(true);

    const review = runtime.getDraftReviewSnapshot();
    expect(patches).toHaveLength(1);
    expect(Object.hasOwn(patches[0]!, "optional")).toBe(true);
    expect(patches[0]!["optional"]).toBeUndefined();
    expect(Object.hasOwn(review[0]!.projectedRow!, "optional")).toBe(true);
    expect(Reflect.get(review[0]!.projectedRow!, "optional")).toBeUndefined();
  });

  it("projects Mine resolutions from exact Mine and Server resolutions from authoritative values", () => {
    type ResolutionProjectionRow = Readonly<{
      readonly id: string;
      readonly primary: string;
      readonly secondary: string;
      readonly revision: bigint;
    }>;
    const base = Object.freeze({
      id: "row-1",
      primary: "Primary base",
      secondary: "Secondary base",
      revision: 1n,
    });
    let current: ResolutionProjectionRow | undefined = base;
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_SECONDARY",
        field: "secondary",
        headerName: "Secondary",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<ResolutionProjectionRow>);
    const patches: Readonly<Record<string, unknown>>[] = [];
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => current,
      getRowId: (candidate) => (candidate as ResolutionProjectionRow).id,
      getRowVersion: (candidate) => (candidate as ResolutionProjectionRow).revision,
      projectEditRow: ({ row, patch }) => {
        patches.push(patch);
        return Object.freeze({ ...row, ...patch });
      },
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: base.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.primary,
          mine: "Primary mine",
        },
        {
          rowId: base.id,
          columnId: "COL_ID_SECONDARY",
          field: "secondary",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.secondary,
          mine: "Secondary mine",
        },
      ]),
    ).toBe(true);
    current = Object.freeze({
      id: base.id,
      primary: "Primary server",
      secondary: "Secondary server",
      revision: 2n,
    });
    runtime.reconcileSourceRows(new Set([base.id]));
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    const conflicts = runtime.getDraftReviewSnapshot();
    expect(conflicts).toHaveLength(2);
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflicts[0]!.id,
          resolution: "server",
          reviewedServer: conflicts[0]!.conflict!.server,
          reviewedServerVersion: conflicts[0]!.conflict!.serverVersion,
        },
        {
          id: conflicts[1]!.id,
          resolution: "mine",
          reviewedServer: conflicts[1]!.conflict!.server,
          reviewedServerVersion: conflicts[1]!.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);

    const resolved = runtime.getDraftReviewSnapshot();
    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.projectedRow).toBe(resolved[1]?.projectedRow);
    expect(resolved[0]?.projectedRow).toMatchObject({
      primary: "Primary server",
      secondary: "Secondary mine",
    });
    expect(patches.at(-1)).toEqual({
      primary: "Primary server",
      secondary: "Secondary mine",
    });

    current = undefined;
    runtime.reconcileSourceRows(new Set([base.id]));
    expect(runtime.getDraftReviewSnapshot().every((entry) => !entry.projectedRowAvailable)).toBe(
      true,
    );
    unsubscribe();
  });

  it("rejects a reused projected row as unavailable when a sibling conflict resolves to Server", () => {
    type ResolutionReuseRow = Readonly<{
      readonly id: string;
      readonly primary: string;
      readonly context: string;
      readonly revision: bigint;
    }>;
    const base = Object.freeze({
      id: "row-1",
      primary: "Primary base",
      context: "Context base",
      revision: 1n,
    });
    let current: ResolutionReuseRow = base;
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_CONTEXT",
        field: "context",
        headerName: "Context",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<ResolutionReuseRow>);
    const reusedProjection = {
      id: base.id,
      primary: base.primary,
      context: base.context,
      revision: base.revision,
    };
    const projectEditRow = vi.fn(({ row, patch }) => {
      Object.assign(reusedProjection, row, patch);
      return reusedProjection;
    });
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => current,
      getRowId: (candidate) => (candidate as ResolutionReuseRow).id,
      getRowVersion: (candidate) => (candidate as ResolutionReuseRow).revision,
      projectEditRow,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: base.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.primary,
          mine: "Primary mine",
        },
        {
          rowId: base.id,
          columnId: "COL_ID_CONTEXT",
          field: "context",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.context,
          mine: "Context mine",
        },
      ]),
    ).toBe(true);
    current = Object.freeze({
      id: base.id,
      primary: "Primary server",
      context: "Context server",
      revision: 2n,
    });
    runtime.reconcileSourceRows(new Set([base.id]));
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    const conflicts = runtime.getDraftReviewSnapshot();
    const contextConflict = conflicts.find((entry) => entry.columnId === "COL_ID_CONTEXT");
    expect(contextConflict?.projectedRow).toBe(reusedProjection);

    expect(
      runtime.resolveDraftConflicts([
        {
          id: contextConflict!.id,
          resolution: "server",
          reviewedServer: contextConflict!.conflict!.server,
          reviewedServerVersion: contextConflict!.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);

    expect(projectEditRow).toHaveBeenCalledTimes(2);
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(2);
    expect(
      runtime
        .getDraftReviewSnapshot()
        .every((entry) => !entry.projectedRowAvailable && entry.projectedRow === undefined),
    ).toBe(true);
    const primaryConflict = runtime
      .getDraftReviewSnapshot()
      .find((entry) => entry.columnId === "COL_ID_PRIMARY");
    expect(
      runtime.resolveDraftConflicts([
        {
          id: primaryConflict!.id,
          resolution: "server",
          reviewedServer: primaryConflict!.conflict!.server,
          reviewedServerVersion: primaryConflict!.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(projectEditRow).toHaveBeenCalledTimes(3);
    expect(
      runtime
        .getDraftReviewSnapshot()
        .every((entry) => !entry.projectedRowAvailable && entry.projectedRow === undefined),
    ).toBe(true);
    unsubscribe();
  });

  it.each([
    "projector throw",
    "null result",
    "source reuse",
    "Row Identity reader throw",
    "Row Identity change",
  ] as const)("keeps an admitted Server resolution coherent after a cached %s", (failure) => {
    type InvalidatedProjectionRow = Readonly<{
      readonly id: string;
      readonly primary: string;
      readonly context: string;
      readonly revision: bigint;
    }>;
    const base = Object.freeze({
      id: "row-1",
      primary: "Primary base",
      context: "Context base",
      revision: 1n,
    });
    let current: InvalidatedProjectionRow = base;
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_CONTEXT",
        field: "context",
        headerName: "Context",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<InvalidatedProjectionRow>);
    let projectionCount = 0;
    let rowIdentityReadCount = 0;
    const projectEditRow = vi.fn(({ row, patch }) => {
      projectionCount += 1;
      if (projectionCount === 1) return Object.freeze({ ...row, ...patch });
      if (failure === "projector throw") throw new Error("changed projection failed");
      if (failure === "null result") return null;
      if (failure === "source reuse") return row;
      if (failure === "Row Identity change") {
        return Object.freeze({ ...row, ...patch, id: "row-2" });
      }
      return Object.freeze({ ...row, ...patch });
    });
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => current,
      getRowId: (candidate) => {
        rowIdentityReadCount += 1;
        if (failure === "Row Identity reader throw" && rowIdentityReadCount >= 2) {
          throw new Error("changed identity read failed");
        }
        return (candidate as InvalidatedProjectionRow).id;
      },
      getRowVersion: (candidate) => (candidate as InvalidatedProjectionRow).revision,
      projectEditRow,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: base.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.primary,
          mine: "Primary mine",
        },
        {
          rowId: base.id,
          columnId: "COL_ID_CONTEXT",
          field: "context",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.context,
          mine: "Context mine",
        },
      ]),
    ).toBe(true);
    current = Object.freeze({
      id: base.id,
      primary: "Primary server",
      context: "Context server",
      revision: 2n,
    });
    runtime.reconcileSourceRows(new Set([base.id]));
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    const conflicts = runtime.getDraftReviewSnapshot();
    const contextConflict = conflicts.find((entry) => entry.columnId === "COL_ID_CONTEXT");
    expect(contextConflict?.projectedRowAvailable).toBe(true);

    expect(
      runtime.resolveDraftConflicts([
        {
          id: contextConflict!.id,
          resolution: "server",
          reviewedServer: contextConflict!.conflict!.server,
          reviewedServerVersion: contextConflict!.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);

    expect(projectEditRow).toHaveBeenCalledTimes(2);
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(2);
    expect(
      runtime
        .getDraftReviewSnapshot()
        .every((entry) => !entry.projectedRowAvailable && entry.projectedRow === undefined),
    ).toBe(true);
    const remainingConflict = runtime
      .getDraftReviewSnapshot()
      .find((entry) => entry.columnId === "COL_ID_PRIMARY");
    expect(
      runtime.resolveDraftConflicts([
        {
          id: remainingConflict!.id,
          resolution: "server",
          reviewedServer: remainingConflict!.conflict!.server,
          reviewedServerVersion: remainingConflict!.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(projectEditRow).toHaveBeenCalledTimes(3);
    expect(
      runtime
        .getDraftReviewSnapshot()
        .every((entry) => !entry.projectedRowAvailable && entry.projectedRow === undefined),
    ).toBe(true);
    unsubscribe();
  });

  it("updates an existing review row in place when its resolution lineage changes", () => {
    type ResolutionRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly revision: bigint;
    }>;
    const base = Object.freeze({ id: "row-1", value: "base", revision: 1n });
    let current: ResolutionRow = base;
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<ResolutionRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as ResolutionRow).revision,
      getRowId: (candidate) => (candidate as ResolutionRow).id,
      projectEditRow: ({ row, patch }) => Object.freeze({ ...row, ...patch }),
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: base.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: base,
          expectedVersion: base.revision,
          base: base.value,
          mine: "mine",
        },
      ]),
    ).toBe(true);
    current = Object.freeze({ id: base.id, value: "server", revision: 2n });
    runtime.reconcileSourceRows(new Set([base.id]));
    const membershipListener = vi.fn();
    const unsubscribe = runtime.subscribeDraftReview(membershipListener);
    const source = runtime.getDraftReviewSourceSnapshot()[0];
    const conflict = runtime.getDraftReviewSnapshot()[0];
    if (source === undefined || conflict?.conflict === undefined) {
      throw new Error("Expected one observed conflict review row.");
    }
    membershipListener.mockClear();

    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict!.id,
          resolution: "server",
          reviewedServer: conflict!.conflict!.server,
          reviewedServerVersion: conflict!.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);

    expect(membershipListener).not.toHaveBeenCalled();
    expect(runtime.getDraftReviewSourceSnapshot()[0]).toBe(source);
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(1);

    const drafts = runtime.getDraftMemorySnapshot() as Map<string, unknown>;
    const resolvedEntries = (
      runtime as unknown as {
        readonly resolvedDraftReviewEntriesById: Map<string, unknown>;
      }
    ).resolvedDraftReviewEntriesById;
    const draftIterator = vi.spyOn(drafts, Symbol.iterator);
    const draftKeys = vi.spyOn(drafts, "keys");
    const draftValues = vi.spyOn(drafts, "values");
    const resolvedIterator = vi.spyOn(resolvedEntries, Symbol.iterator);
    const resolvedKeys = vi.spyOn(resolvedEntries, "keys");
    const resolvedValues = vi.spyOn(resolvedEntries, "values");

    runtime.reconcileSourceRows(new Set([base.id]));

    expect(draftIterator).not.toHaveBeenCalled();
    expect(draftKeys).not.toHaveBeenCalled();
    expect(draftValues).not.toHaveBeenCalled();
    expect(resolvedIterator).not.toHaveBeenCalled();
    expect(resolvedKeys).not.toHaveBeenCalled();
    expect(resolvedValues).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("gathers a bounded review projection without iterating unrelated drafts", () => {
    type IndexedProjectionRow = Readonly<{
      readonly id: string;
      readonly value: string;
    }>;
    const rows = new Map<string, IndexedProjectionRow>();
    for (let index = 0; index < 128; index += 1) {
      const rowId = `row-${index}`;
      rows.set(rowId, Object.freeze({ id: rowId, value: `server-${index}` }));
    }
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<IndexedProjectionRow>);
    const projectEditRow = vi.fn(({ row, patch }) => Object.freeze({ ...row, ...patch }));
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: (rowId) => rows.get(rowId),
      getRowId: (candidate) => (candidate as IndexedProjectionRow).id,
      projectEditRow,
    });
    const changes = [...rows.values()].map((candidate, index) => ({
      rowId: candidate.id,
      columnId: "COL_ID_VALUE",
      field: "value",
      baseRow: candidate,
      expectedVersion: 1n,
      base: candidate.value,
      mine: `mine-${index}`,
    }));
    const [firstChange, ...remainingChanges] = changes;
    expect(firstChange).toBeDefined();
    expect(runtime.applyAcceptedDraftGesture([firstChange!, ...remainingChanges])).toBe(true);
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    expect(projectEditRow).toHaveBeenCalledTimes(rows.size);

    const drafts = runtime.getDraftMemorySnapshot() as Map<string, unknown>;
    const originalIterator = drafts[Symbol.iterator].bind(drafts);
    const iterateDrafts = vi.fn(originalIterator);
    Object.defineProperty(drafts, Symbol.iterator, {
      configurable: true,
      value: iterateDrafts,
    });
    rows.set("row-0", Object.freeze({ id: "row-0", value: "server-0" }));

    runtime.reconcileSourceRows(new Set(["row-0"]));

    expect(iterateDrafts).not.toHaveBeenCalled();
    expect(projectEditRow).toHaveBeenCalledTimes(rows.size + 1);
    unsubscribe();
  });

  it("rejects unequal duplicate-column values for one projected field and admits equal values", () => {
    type DuplicateFieldRow = Readonly<{ readonly id: string; readonly value: string }>;
    const source = Object.freeze({ id: "row-1", value: "server" });
    const duplicateColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE_A",
        field: "value",
        headerName: "Value A",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_VALUE_B",
        field: "value",
        headerName: "Value B",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<DuplicateFieldRow>);
    const createRuntime = (secondMine: string) => {
      const runtime = new BrunoTableCellEditRuntime({
        columns: duplicateColumns,
        getRow: () => source,
        getRowId: (candidate) => (candidate as DuplicateFieldRow).id,
        projectEditRow: ({ row, patch }) => Object.freeze({ ...row, ...patch }),
      });
      expect(
        runtime.applyAcceptedDraftGesture([
          {
            rowId: source.id,
            columnId: "COL_ID_VALUE_A",
            field: "value",
            baseRow: source,
            expectedVersion: 1n,
            base: source.value,
            mine: "mine",
          },
          {
            rowId: source.id,
            columnId: "COL_ID_VALUE_B",
            field: "value",
            baseRow: source,
            expectedVersion: 1n,
            base: source.value,
            mine: secondMine,
          },
        ]),
      ).toBe(true);
      return runtime;
    };

    const unequal = createRuntime("different");
    expect(() => unequal.subscribeDraftReview(() => undefined)).toThrow(
      "BrunoTable Edit Row projection cannot collate columns COL_ID_VALUE_A and COL_ID_VALUE_B for row row-1, field value: exact values are not semantically equal.",
    );

    const equal = createRuntime("mine");
    const unsubscribe = equal.subscribeDraftReview(() => undefined);
    expect(equal.getDraftReviewSnapshot()[0]?.projectedRow).toMatchObject({ value: "mine" });
    unsubscribe();
  });

  it.each([
    {
      name: "a null result",
      project: () => null,
      message: "BrunoTable projectEditRow must return a non-null object for row row-1.",
    },
    {
      name: "the authoritative source reference",
      project: ({ row }: { readonly row: object }) => row,
      message: "BrunoTable projectEditRow must return a distinct row for non-empty patch: row-1.",
    },
    {
      name: "a different Row Identity",
      project: ({ row, patch }: { readonly row: object; readonly patch: object }) =>
        Object.freeze({ ...row, ...patch, id: "other" }),
      message: "BrunoTable projectEditRow changed Row Identity from row-1 to other.",
    },
  ])("rejects projected review rows with $name", ({ project, message }) => {
    type ProjectedIdentityRow = Readonly<{ readonly id: string; readonly value: string }>;
    const source = Object.freeze({ id: "row-1", value: "server" });
    const identityColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<ProjectedIdentityRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: identityColumns,
      getRow: () => source,
      getRowId: (candidate) => (candidate as ProjectedIdentityRow).id,
      projectEditRow: project,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: source,
          expectedVersion: 1n,
          base: source.value,
          mine: "mine",
        },
      ]),
    ).toBe(true);

    expect(() => runtime.subscribeDraftReview(() => undefined)).toThrow(message);
  });

  it("preserves projector failures and diagnoses projected Row Identity reader failures", () => {
    type DiagnosticProjectionRow = Readonly<{ readonly id: string; readonly value: string }>;
    const source = Object.freeze({ id: "row-1", value: "server" });
    const diagnosticColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<DiagnosticProjectionRow>);
    const projectorFailure = new Error("consumer projector failed");
    const createRuntime = (
      projectEditRow: (input: {
        readonly row: object;
        readonly patch: Readonly<Record<string, unknown>>;
      }) => unknown,
      getRowId: (candidate: object) => string,
    ) => {
      const runtime = new BrunoTableCellEditRuntime({
        columns: diagnosticColumns,
        getRow: () => source,
        getRowId,
        projectEditRow,
      });
      expect(
        runtime.applyAcceptedDraftGesture([
          {
            rowId: source.id,
            columnId: "COL_ID_VALUE",
            field: "value",
            baseRow: source,
            expectedVersion: 1n,
            base: source.value,
            mine: "mine",
          },
        ]),
      ).toBe(true);
      return runtime;
    };

    const projectorThrows = createRuntime(
      () => {
        throw projectorFailure;
      },
      (candidate) => (candidate as DiagnosticProjectionRow).id,
    );
    let caughtProjectorFailure: unknown;
    try {
      projectorThrows.subscribeDraftReview(() => undefined);
    } catch (error) {
      caughtProjectorFailure = error;
    }
    expect(caughtProjectorFailure).toBe(projectorFailure);

    const getRowIdThrows = createRuntime(
      ({ row, patch }) => Object.freeze({ ...row, ...patch }),
      () => {
        throw new Error("identity reader failed");
      },
    );
    expect(() => getRowIdThrows.subscribeDraftReview(() => undefined)).toThrow(
      "BrunoTable getRowId rejected the projected edit row: row-1.",
    );
  });

  it("marks row-aware projection unavailable when reading the current Row Version fails", () => {
    type VersionFailureRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly revision: bigint;
    }>;
    const source = Object.freeze({ id: "row-1", value: "server", revision: 1n });
    const versionFailureColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<VersionFailureRow>);
    const projectEditRow = vi.fn(({ row, patch }) => Object.freeze({ ...row, ...patch }));
    const runtime = new BrunoTableCellEditRuntime({
      columns: versionFailureColumns,
      getRow: () => source,
      getRowId: (candidate) => (candidate as VersionFailureRow).id,
      getRowVersion: () => {
        throw new Error("version reader failed");
      },
      projectEditRow,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.value,
          mine: "mine",
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    expect(projectEditRow).not.toHaveBeenCalled();
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        baseRow: source,
        mine: "mine",
        projectedRow: undefined,
        projectedRowAvailable: false,
      },
    ]);
    unsubscribe();
  });

  it("invalidates projected rows by source revision, source reference, and projector epoch", () => {
    type EpochRow = { id: string; value: string; revision: bigint };
    let current: EpochRow = { id: "row-1", value: "server", revision: 1n };
    const epochColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<EpochRow>);
    const getRowId = (candidate: object) => (candidate as EpochRow).id;
    const firstProjector = vi.fn(({ row, patch }) => Object.freeze({ ...row, ...patch }));
    const runtime = new BrunoTableCellEditRuntime({
      columns: epochColumns,
      getRow: () => current,
      getRowId,
      getRowVersion: (candidate) => (candidate as EpochRow).revision,
      projectEditRow: firstProjector,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: current.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: current,
          expectedVersion: current.revision,
          base: current.value,
          mine: "mine",
        },
      ]),
    ).toBe(true);
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    expect(firstProjector).toHaveBeenCalledOnce();
    runtime.getDraftReviewSnapshot();
    expect(firstProjector).toHaveBeenCalledOnce();

    current.revision = 2n;
    runtime.reconcileSourceRows(new Set([current.id]));
    expect(firstProjector).toHaveBeenCalledTimes(2);

    current = { ...current, revision: 3n };
    runtime.reconcileSourceRows(new Set([current.id]));
    expect(firstProjector).toHaveBeenCalledTimes(3);

    const secondProjector = vi.fn(({ row, patch }) =>
      Object.freeze({ ...row, ...patch, projectionEpoch: "second" }),
    );
    runtime.setEditRowProjector(secondProjector, getRowId);
    expect(secondProjector).toHaveBeenCalledOnce();
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).toMatchObject({
      projectionEpoch: "second",
      value: "mine",
    });
    unsubscribe();
  });

  it("reprojects ordinary open-review drafts when the Row Version extractor changes", () => {
    type ExtractorProjectionRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly revision: bigint;
    }>;
    const source = Object.freeze({ id: "row-1", value: "server", revision: 1n });
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<ExtractorProjectionRow>);
    let projectionCall = 0;
    const projectEditRow = vi.fn(({ row, patch }) => {
      projectionCall += 1;
      return Object.freeze({ ...row, ...patch, projectionCall });
    });
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => source,
      getRowId: (candidate) => (candidate as ExtractorProjectionRow).id,
      getRowVersion: (candidate) => (candidate as ExtractorProjectionRow).revision,
      projectEditRow,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.value,
          mine: "mine",
        },
      ]),
    ).toBe(true);
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    const firstProjection = runtime.getDraftReviewSnapshot()[0]?.projectedRow;
    expect(firstProjection).toMatchObject({ projectionCall: 1, value: "mine" });

    runtime.setRowVersionExtractor(() => 2n);

    expect(projectEditRow).toHaveBeenCalledTimes(2);
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).toMatchObject({
      projectionCall: 2,
      value: "mine",
    });
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).not.toBe(firstProjection);
    unsubscribe();
  });

  it("passes opaque Row Version evidence to a version-aware edit-row projector", () => {
    type VersionedProjectionRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly revision: bigint;
    }>;
    const source = Object.freeze({ id: "row-1", value: "server", revision: 1n });
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<VersionedProjectionRow>);
    const projectionsByVersion = new Map<unknown, VersionedProjectionRow>();
    const projectEditRow = vi.fn(
      ({
        row,
        patch,
        rowVersion,
      }: {
        readonly row: object;
        readonly patch: Readonly<Record<string, unknown>>;
        readonly rowVersion: unknown;
      }) => {
        const retained = projectionsByVersion.get(rowVersion);
        if (retained !== undefined) return retained;
        const projected = Object.freeze({
          ...(row as VersionedProjectionRow),
          ...patch,
          revision: rowVersion as bigint,
        });
        projectionsByVersion.set(rowVersion, projected);
        return projected;
      },
    );
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => source,
      getRowId: (candidate) => (candidate as VersionedProjectionRow).id,
      getRowVersion: (candidate) => (candidate as VersionedProjectionRow).revision,
      projectEditRow,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.value,
          mine: "mine",
        },
      ]),
    ).toBe(true);
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    const firstProjection = runtime.getDraftReviewSnapshot()[0]?.projectedRow;

    runtime.setRowVersionExtractor(() => 2n);

    expect(projectEditRow).toHaveBeenLastCalledWith({
      row: source,
      patch: { value: "mine" },
      rowVersion: 2n,
    });
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
      projectedRowAvailable: true,
      projectedRow: { revision: 2n, value: "mine" },
    });
    expect(runtime.getDraftReviewSnapshot()[0]?.projectedRow).not.toBe(firstProjection);
    unsubscribe();
  });

  it("marks a cached projected row unavailable when its reference is reused after a sibling patch changes", () => {
    type SiblingProjectionRow = Readonly<{
      readonly id: string;
      readonly primary: string;
      readonly sibling: string;
    }>;
    const source = Object.freeze({ id: "row-1", primary: "server", sibling: "server sibling" });
    const projectionColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_SIBLING",
        field: "sibling",
        headerName: "Sibling",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<SiblingProjectionRow>);
    const reusedProjection = Object.freeze({
      id: source.id,
      primary: "mine",
      sibling: source.sibling,
    });
    const projectEditRow = vi.fn(() => reusedProjection);
    const runtime = new BrunoTableCellEditRuntime({
      columns: projectionColumns,
      getRow: () => source,
      getRowId: (candidate) => (candidate as SiblingProjectionRow).id,
      projectEditRow,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: 1n,
          base: source.primary,
          mine: "mine",
        },
      ]),
    ).toBe(true);
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    runtime.getDraftReviewSnapshot();
    expect(projectEditRow).toHaveBeenCalledOnce();

    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_SIBLING",
          field: "sibling",
          baseRow: source,
          expectedVersion: 1n,
          base: source.sibling,
          mine: "mine sibling",
        },
      ]),
    ).toBe(true);
    expect(projectEditRow).toHaveBeenCalledTimes(2);
    expect(
      runtime
        .getDraftReviewSnapshot()
        .every((entry) => !entry.projectedRowAvailable && entry.projectedRow === undefined),
    ).toBe(true);
    unsubscribe();
  });

  it("publishes the blocking reason for a dirty active candidate whose row disappears", () => {
    let current: Row | undefined = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    runtime.updateActiveCandidate("7", false);
    current = undefined;
    runtime.reconcileActiveRow(new Set([row.id]));
    runtime.reconcileSourceRows(new Set([row.id]));
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);

    expect(runtime.getActivitySnapshot()).toMatchObject({
      activeCandidatePending: true,
      blockedCount: 1,
    });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        rowId: row.id,
        candidateText: "7",
        blockedReason: "This row was removed from the server. Changes cannot be saved.",
      },
    ]);
    unsubscribe();
  });

  it("keeps the immutable admission Base and Row Version across live source replacement", () => {
    const admitted = Object.freeze({ ...row, score: 4 });
    let current: Row = admitted;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate === admitted ? 1n : 2n),
    });

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    current = Object.freeze({ ...row, score: 6 });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.commit("8")).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { baseRow: admitted, expectedVersion: 1n, base: 4, serverNow: 6, mine: 8 },
    ]);
  });

  it("derives and continuously refreshes complete conflict evidence from live rows", () => {
    const admitted = Object.freeze({ ...row, score: 4 });
    const baseVersion = Object.freeze({ token: "base" });
    const firstServerVersion = Object.freeze({ token: "server-first" });
    const secondServerVersion = Object.freeze({ token: "server-second" });
    const sameValueVersion = Object.freeze({ token: "same-value-new-version" });
    const returnedBaseVersion = Object.freeze({ token: "returned-base" });
    const convergedVersion = Object.freeze({ token: "converged" });
    const versions = new WeakMap<object, object>([[admitted, baseVersion]]);
    let current: Row = admitted;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => versions.get(candidate)!,
    });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);

    current = Object.freeze({ ...row, score: 5 });
    versions.set(current, firstServerVersion);
    runtime.reconcileSourceRows(new Set([row.id]));

    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 1,
      conflictCount: 1,
    });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        rowId: row.id,
        columnId: "COL_ID_SCORE",
        field: "score",
        base: 4,
        expectedVersion: baseVersion,
        mine: 7,
        conflict: { server: 5, serverVersion: firstServerVersion },
      },
    ]);
    expect(runtime.createBatchSaveChangeSet()).toBeUndefined();

    current = Object.freeze({ ...row, score: 6 });
    versions.set(current, secondServerVersion);
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { conflict: { server: 6, serverVersion: secondServerVersion } },
    ]);

    current = Object.freeze({ ...row, score: 6 });
    versions.set(current, sameValueVersion);
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { conflict: { server: 6, serverVersion: sameValueVersion } },
    ]);

    current = Object.freeze({ ...row, score: 4 });
    versions.set(current, returnedBaseVersion);
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 0 });
    expect(runtime.getDraftReviewSnapshot()[0]).not.toHaveProperty("conflict");
    expect(runtime.createBatchSaveChangeSet()).toMatchObject([
      { baseRow: current, expectedVersion: returnedBaseVersion },
    ]);

    current = Object.freeze({ ...row, score: 7 });
    versions.set(current, convergedVersion);
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      conflictCount: 0,
      undoCount: 0,
      redoCount: 0,
    });
  });

  it("reconciles a nullable Mine when the live source converges", () => {
    type NullableRow = Readonly<{
      readonly id: string;
      readonly value: number | null | undefined;
    }>;
    for (const blankValue of [null, undefined] as const) {
      let current: NullableRow = Object.freeze({
        id: `nullable-live-${String(blankValue)}`,
        value: 1,
      });
      const nullableColumns = compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: "number",
          isEditable: true,
          blankValue,
        },
      ] satisfies BrunoTableColumns<NullableRow>);
      const runtime = new BrunoTableCellEditRuntime({
        columns: nullableColumns,
        getRow: () => current,
      });
      runtime.setBatchHistoryEnabled(true);

      expect(runtime.start(current.id, "COL_ID_VALUE")).toBe(true);
      expect(runtime.commit("", false, "blank")).toBe(true);
      expect(runtime.getCellSnapshot(current.id, "COL_ID_VALUE")).toMatchObject({
        hasDraft: true,
        draft: blankValue,
      });

      current = Object.freeze({ ...current, value: blankValue });
      runtime.reconcileSourceRows(new Set([current.id]));

      expect(runtime.getActivitySnapshot()).toMatchObject({
        draftCount: 0,
        undoCount: 0,
        redoCount: 0,
      });
      runtime.dispose();
    }
  });

  it("reconciles source divergence captured while the first editor remains open", () => {
    let current: Row = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    runtime.reconcileActiveRow(new Set([row.id]));
    expect(runtime.commit("7")).toBe(true);

    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 1 });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        base: 4,
        mine: 7,
        conflict: { server: 5, serverVersion: row.quantity + 1n },
      },
    ]);
  });

  it("limits active-editor catch-up to the newly committed Cell Identity", () => {
    type TwoCellRow = Readonly<{
      readonly id: string;
      readonly first: string;
      readonly second: string;
      readonly version: number;
    }>;
    const firstEquivalent = vi.fn(Object.is);
    const secondEquivalent = vi.fn(Object.is);
    const textValueType = (
      codecId: string,
      equivalent: (left: string, right: string) => boolean,
    ): BrunoTableValueType<string> => ({
      codecId,
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: String,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: String,
      encodePersisted: String,
      decodePersisted: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected persisted text." },
    });
    const twoCellColumns = compileColumns([
      {
        columnId: "COL_ID_FIRST",
        field: "first",
        headerName: "First",
        valueType: textValueType("test/candidate-first", firstEquivalent),
        isEditable: true,
      },
      {
        columnId: "COL_ID_SECOND",
        field: "second",
        headerName: "Second",
        valueType: textValueType("test/candidate-second", secondEquivalent),
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<TwoCellRow>);
    let current: TwoCellRow = Object.freeze({
      id: "two-cell",
      first: "first-base",
      second: "second-base",
      version: 1,
    });
    const runtime = new BrunoTableCellEditRuntime({
      columns: twoCellColumns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as TwoCellRow).version,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(current.id, "COL_ID_SECOND")).toBe(true);
    expect(runtime.commit("second-mine")).toBe(true);

    expect(runtime.start(current.id, "COL_ID_FIRST")).toBe(true);
    current = Object.freeze({ ...current, first: "first-server", version: 2 });
    runtime.reconcileActiveRow(new Set([current.id]));
    firstEquivalent.mockClear();
    secondEquivalent.mockClear();

    expect(runtime.commit("first-mine")).toBe(true);

    expect(secondEquivalent).not.toHaveBeenCalled();
    expect(runtime.getDraftSnapshot(current.id, "COL_ID_SECOND")).toBe("second-mine");
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 2, conflictCount: 1 });
  });

  it("preserves live conflict evidence when Yours is edited again", () => {
    let current: Row = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot().conflictCount).toBe(1);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);

    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 1 });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        base: 4,
        mine: 8,
        conflict: { server: 5, serverVersion: row.quantity + 1n },
      },
    ]);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { mine: 7, conflict: { server: 5, serverVersion: row.quantity + 1n } },
    ]);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { mine: 8, conflict: { server: 5, serverVersion: row.quantity + 1n } },
    ]);
  });

  it("retains conflicted Batch work while live permission is blocked and recovers sparsely", () => {
    type PermissionRow = Readonly<{
      readonly id: string;
      readonly score: number;
      readonly editable: boolean;
      readonly revision: symbol;
    }>;
    const permissionColumns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
        isEditable: ({ row: candidate }: { readonly row: PermissionRow }) => candidate.editable,
      },
    ]);
    let current: PermissionRow = Object.freeze({
      id: "row-permission",
      score: 4,
      editable: true,
      revision: Symbol("base"),
    });
    const runtime = new BrunoTableCellEditRuntime({
      columns: permissionColumns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as PermissionRow).revision,
    });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(current.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);

    const blockedVersion = Symbol("blocked");
    current = Object.freeze({
      ...current,
      score: 5,
      editable: false,
      revision: blockedVersion,
    });
    runtime.reconcileSourceRows(new Set([current.id]));

    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 1,
      blockedCount: 1,
      conflictCount: 1,
    });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        mine: 7,
        blockedReason: "This cell is no longer editable.",
        conflict: { server: 5, serverVersion: blockedVersion },
      },
    ]);
    expect(runtime.createBatchSaveChangeSet()).toBeUndefined();
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1, conflictCount: 1 });

    current = Object.freeze({ ...current, editable: true, revision: Symbol("allowed") });
    runtime.reconcileSourceRows(new Set([current.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 0, conflictCount: 1 });
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({ blockedReason: undefined });

    current = Object.freeze({ ...current, score: 7, revision: Symbol("converged") });
    runtime.reconcileSourceRows(new Set([current.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      blockedCount: 0,
      conflictCount: 0,
      undoCount: 0,
      redoCount: 0,
    });
  });

  it("preserves missing-row conflict evidence and reconnects by the same Row Identity", () => {
    const admitted = Object.freeze({ ...row, score: 4 });
    let current: Row | undefined = admitted;
    const versions = new WeakMap<object, symbol>([[admitted, Symbol("base")]]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => versions.get(candidate)!,
    });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    current = undefined;
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1, conflictCount: 0 });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { mine: 7, blockedReason: expect.stringContaining("removed") },
    ]);

    const conflictingVersion = Symbol("conflicting");
    current = Object.freeze({ ...row, score: 5 });
    versions.set(current, conflictingVersion);
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 0, conflictCount: 1 });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { mine: 7, conflict: { server: 5, serverVersion: conflictingVersion } },
    ]);

    expect(runtime.undoBatchDraft()).toBe(true);
    current = undefined;
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1, conflictCount: 1 });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        mine: 7,
        blockedReason: expect.stringContaining("removed"),
        conflict: { server: 5, serverVersion: conflictingVersion },
      },
    ]);

    current = Object.freeze({ ...row, score: 7 });
    versions.set(current, Symbol("converged"));
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      blockedCount: 0,
      conflictCount: 0,
      undoCount: 0,
      redoCount: 0,
    });
  });

  it("rebuilds shifted history indexes before reconciling the first retained command", () => {
    const rowA = Object.freeze({ ...row, id: "row-a", score: 1, quantity: 1n });
    const rowB = Object.freeze({ ...row, id: "row-b", score: 2, quantity: 1n });
    const rowC = Object.freeze({ ...row, id: "row-c", score: 3, quantity: 1n });
    const sourceRows = new Map<string, Row>([
      [rowA.id, rowA],
      [rowB.id, rowB],
      [rowC.id, rowC],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => sourceRows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    for (const [candidate, mine] of [
      [rowA, 5],
      [rowB, 6],
      [rowC, 7],
    ] as const) {
      expect(
        runtime.applyAcceptedDraftGesture([
          {
            rowId: candidate.id,
            columnId: "COL_ID_SCORE",
            field: "score",
            baseRow: candidate,
            expectedVersion: candidate.quantity,
            base: candidate.score,
            mine,
          },
        ]),
      ).toBe(true);
    }

    sourceRows.set(rowA.id, Object.freeze({ ...rowA, score: 5, quantity: 2n }));
    runtime.reconcileSourceRows(new Set([rowA.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 2, undoCount: 2 });

    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot(rowC.id, "COL_ID_SCORE")).toBeUndefined();

    const conflictingB = Object.freeze({ ...rowB, score: 9, quantity: 2n });
    sourceRows.set(rowB.id, conflictingB);
    runtime.reconcileSourceRows(new Set([rowB.id]));
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        rowId: rowB.id,
        mine: 6,
        conflict: { server: 9, serverVersion: 2n },
      },
    ]);

    expect(runtime.undoBatchDraft()).toBe(true);
    sourceRows.delete(rowB.id);
    runtime.reconcileSourceRows(new Set([rowB.id]));
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        rowId: rowB.id,
        mine: 6,
        blockedReason: expect.stringContaining("removed"),
        conflict: { server: 9, serverVersion: 2n },
      },
    ]);

    sourceRows.set(rowB.id, Object.freeze({ ...rowB, score: 6, quantity: 3n }));
    runtime.reconcileSourceRows(new Set([rowB.id]));
    expect(runtime.getDraftSnapshot(rowB.id, "COL_ID_SCORE")).toBeUndefined();
    expect(runtime.getActivitySnapshot()).toMatchObject({ undoCount: 0, conflictCount: 0 });
    expect(runtime.undoBatchDraft()).toBe(false);
  });

  it("keeps reverse history locations exact across the 100-command eviction boundary", () => {
    const sourceRows = new Map<string, Row>();
    const admittedRows: Row[] = [];
    for (let index = 0; index <= 100; index += 1) {
      const candidate = Object.freeze({
        ...row,
        id: `row-eviction-${String(index)}`,
        score: index,
        quantity: 1n,
      });
      admittedRows.push(candidate);
      sourceRows.set(candidate.id, candidate);
    }
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => sourceRows.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    for (const candidate of admittedRows) {
      expect(
        runtime.applyAcceptedDraftGesture([
          {
            rowId: candidate.id,
            columnId: "COL_ID_SCORE",
            field: "score",
            baseRow: candidate,
            expectedVersion: candidate.quantity,
            base: candidate.score,
            mine: candidate.score + 1,
          },
        ]),
      ).toBe(true);
    }
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 101, undoCount: 100 });

    const firstRetained = admittedRows[1]!;
    sourceRows.set(
      firstRetained.id,
      Object.freeze({ ...firstRetained, score: firstRetained.score + 1, quantity: 2n }),
    );
    runtime.reconcileSourceRows(new Set([firstRetained.id]));
    expect(runtime.getDraftSnapshot(firstRetained.id, "COL_ID_SCORE")).toBeUndefined();
    expect(runtime.getActivitySnapshot().undoCount).toBe(99);

    const newest = admittedRows[100]!;
    sourceRows.set(newest.id, Object.freeze({ ...newest, score: -1, quantity: 2n }));
    runtime.reconcileSourceRows(new Set([newest.id]));
    expect(runtime.getDraftReviewSnapshot()).toContainEqual(
      expect.objectContaining({
        rowId: newest.id,
        mine: newest.score + 1,
        conflict: { server: -1, serverVersion: 2n },
      }),
    );
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toContainEqual(
      expect.objectContaining({
        rowId: newest.id,
        conflict: { server: -1, serverVersion: 2n },
      }),
    );

    while (runtime.undoBatchDraft()) {
      // Exercise every retained location after eviction and tombstone compaction.
    }
    while (runtime.redoBatchDraft()) {
      // Replaying the retained history must not resurrect the converged boundary cell.
    }
    expect(runtime.getDraftSnapshot(firstRetained.id, "COL_ID_SCORE")).toBeUndefined();
  });

  it("prunes redo-only convergence and revalidates missing-row history before replay", () => {
    let current: Row | undefined = row;
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => current });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);
    current = Object.freeze({ ...row, score: 7 });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ redoCount: 0 });
    expect(runtime.redoBatchDraft()).toBe(false);

    current = row;
    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);
    current = undefined;
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { mine: 8, blockedReason: expect.stringContaining("removed") },
    ]);
    current = row;
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([{ mine: 8, blockedReason: undefined }]);
  });

  it("retains the exact authored value for draft-removal history convergence", () => {
    let current: Row = row;
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => current });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    current = Object.freeze({ ...row, score: 6 });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("6")).toBe(true);
    expect(runtime.getDraftSnapshot("row-1", "COL_ID_SCORE")).toBeUndefined();

    current = row;
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot("row-1", "COL_ID_SCORE")).toBe(7);
  });

  it("prunes undo-only return-to-base history after authoritative convergence", () => {
    let current: Row = row;
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => current });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("4")).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, undoCount: 2 });

    current = Object.freeze({ ...row, score: 4 });
    runtime.reconcileSourceRows(new Set([row.id]));

    expect(runtime.getActivitySnapshot()).toMatchObject({ undoCount: 0, redoCount: 0 });
    expect(runtime.undoBatchDraft()).toBe(false);
  });

  it("prunes undo convergence when unrelated redo history exists", () => {
    const rowA = Object.freeze({ ...row, id: "row-a" });
    const rowB = Object.freeze({ ...row, id: "row-b" });
    const liveRows = new Map<string, Row>([
      [rowA.id, rowA],
      [rowB.id, rowB],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => liveRows.get(rowId),
    });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(rowA.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(rowA.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("4")).toBe(true);
    expect(runtime.start(rowB.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ undoCount: 2, redoCount: 1 });

    liveRows.set(rowA.id, Object.freeze({ ...rowA, score: 4 }));
    runtime.reconcileSourceRows(new Set([rowA.id]));

    expect(runtime.getActivitySnapshot()).toMatchObject({ undoCount: 0, redoCount: 1 });
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot(rowB.id, "COL_ID_SCORE")).toBe(8);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(false);
    expect(runtime.getDraftSnapshot(rowA.id, "COL_ID_SCORE")).toBeUndefined();
  });

  it("rebases an open session when its admitted draft converges authoritatively", () => {
    const admitted = Object.freeze({ ...row, score: 4 });
    const converged = Object.freeze({ ...row, score: 7 });
    let current: Row = admitted;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate === converged ? 2n : 1n),
    });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    runtime.updateActiveCandidate("8", false);

    current = converged;
    runtime.reconcileSourceRows(new Set([row.id]));
    runtime.reconcileActiveRow(new Set([row.id]));
    expect(runtime.commit("8")).toBe(true);

    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        baseRow: converged,
        expectedVersion: 2n,
        base: 7,
        mine: 8,
      },
    ]);
  });

  it("blocks a converged open session until Row Version rebasing succeeds", () => {
    const admitted = Object.freeze({ ...row, score: 4 });
    const converged = Object.freeze({ ...row, score: 7 });
    let current: Row = admitted;
    let extractorAvailable = true;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => {
        if (!extractorAvailable) throw new Error("Row Version unavailable");
        return candidate === converged ? 2n : 1n;
      },
    });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    runtime.updateActiveCandidate("8", false);

    current = converged;
    extractorAvailable = false;
    runtime.reconcileSourceRows(new Set([row.id]));
    runtime.reconcileActiveRow(new Set([row.id]));
    expect(runtime.commit("8")).toBe(false);
    expect(runtime.getActiveCandidateSnapshot()).toMatchObject({ rawText: "8" });
    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      invalidMessage: expect.stringContaining("Row Version"),
    });

    extractorAvailable = true;
    runtime.reconcileActiveRow(new Set([row.id]));
    expect(runtime.commit("8")).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { baseRow: converged, expectedVersion: 2n, base: 7, mine: 8 },
    ]);
  });

  it("keeps the latest Mine when the source publishes an older history value", () => {
    let current: Row = row;
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => current });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);

    current = Object.freeze({ ...row, score: 7 });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBe(8);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, undoCount: 2 });
  });

  it("reconciles redo-only evidence on an unknown source publication", () => {
    let current: Row = row;
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => current });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);
    current = Object.freeze({ ...row, score: 7 });
    runtime.reconcileSourceRows(undefined);

    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, redoCount: 0 });
    expect(runtime.redoBatchDraft()).toBe(false);
  });

  it("prunes redo history when the source reaches the chronologically latest Mine", () => {
    let current: Row = row;
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => current });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ redoCount: 2 });

    current = Object.freeze({ ...row, score: 8 });
    runtime.reconcileSourceRows(new Set([row.id]));

    expect(runtime.getActivitySnapshot()).toMatchObject({ redoCount: 0 });
    expect(runtime.redoBatchDraft()).toBe(false);
  });

  it("does not record a Batch command for distinct but semantically equivalent Mine values", () => {
    type ObjectRow = Readonly<{ readonly id: string; readonly value: Readonly<{ id: string }> }>;
    const objectRow: ObjectRow = Object.freeze({ id: "object-row", value: { id: "base" } });
    const objectValueType: BrunoTableValueType<Readonly<{ id: string }>> = {
      codecId: "test/object-equivalence",
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "object" && input !== null && "id" in input
          ? { _tag: "Success", value: { id: String(input.id) } }
          : { _tag: "Failure", message: "Expected object." },
      equivalent: (left, right) => left.id === right.id,
      compare: (left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1),
      formatCanonicalText: (value) => value.id,
      parseCanonicalText: (text) => ({ _tag: "Success", value: { id: text } }),
      formatDisplay: (value) => value.id,
      encodePersisted: (value) => value.id,
      decodePersisted: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: { id: input } }
          : { _tag: "Failure", message: "Expected string." },
    };
    const objectColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: objectValueType,
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: objectColumns,
      getRow: () => objectRow,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: objectRow.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: objectRow,
          expectedVersion: 1n,
          base: objectRow.value,
          mine: { id: "mine" },
        },
      ]),
    ).toBe(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: objectRow.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: objectRow,
          expectedVersion: 1n,
          base: objectRow.value,
          mine: { id: "mine" },
        },
      ]),
    ).toBe(false);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, undoCount: 1 });
  });

  it("materializes live Reset Review rows only while the review is observed", () => {
    const getRow = vi.fn(() => row);
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow });

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    getRow.mockClear();
    expect(runtime.commit("7")).toBe(true);
    expect(getRow).not.toHaveBeenCalled();

    const reviewSubscriber = vi.fn();
    const unsubscribe = runtime.subscribeDraftReview(reviewSubscriber);
    expect(getRow).toHaveBeenCalledOnce();
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(1);

    unsubscribe();
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(1);
    expect(getRow).toHaveBeenCalledTimes(2);
  });

  it("does not inspect or reconstruct rows while materializing same-row Yours evidence", () => {
    const sourceColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_SECONDARY",
        field: "secondary",
        headerName: "Secondary",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_TERTIARY",
        field: "tertiary",
        headerName: "Tertiary",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const target = Object.freeze({
      id: "row-1",
      primary: "Primary server",
      secondary: "Secondary server",
      tertiary: "Tertiary server",
      revision: 2n,
    });
    let inspectionCount = 0;
    const source = new Proxy(target, {
      getOwnPropertyDescriptor(target, property) {
        inspectionCount += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        inspectionCount += 1;
        return Reflect.ownKeys(target);
      },
    });
    const runtime = new BrunoTableCellEditRuntime({ columns: sourceColumns, getRow: () => source });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.primary,
          mine: "Primary mine",
        },
        {
          rowId: source.id,
          columnId: "COL_ID_SECONDARY",
          field: "secondary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.secondary,
          mine: "Secondary mine",
        },
        {
          rowId: source.id,
          columnId: "COL_ID_TERTIARY",
          field: "tertiary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.tertiary,
          mine: "Tertiary mine",
        },
      ]),
    ).toBe(true);
    inspectionCount = 0;

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());

    expect(runtime.getDraftReviewSnapshot()).toHaveLength(3);
    expect(
      runtime
        .getDraftReviewSnapshot()
        .every((review) => !review.projectedRowAvailable && review.projectedRow === undefined),
    ).toBe(true);
    expect(inspectionCount).toBe(0);
    unsubscribe();
  });

  it("marks projection unavailable without invoking an enumerable own getter", () => {
    const source = Object.defineProperty({ ...row }, "explosive", {
      enumerable: true,
      get: () => {
        throw new Error("Projection getter failed.");
      },
    });
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => source });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: source,
          expectedVersion: row.quantity,
          base: row.score,
          mine: 7,
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());
    const review = runtime.getDraftReviewSnapshot()[0];
    expect(review).toMatchObject({ projectedRowAvailable: false });
    expect(review?.projectedRow).toBeUndefined();
    unsubscribe();
  });

  it("does not claim a synthesized data-class row is authentic without a trusted projector", () => {
    class ProjectedRow {
      public readonly id = row.id;
      public readonly quantity = row.quantity;
      public readonly score!: number;

      public constructor() {
        Object.defineProperty(this, "score", {
          configurable: false,
          enumerable: false,
          value: row.score,
          writable: false,
        });
      }

      public renderScore(): string {
        return `Score ${this.score}`;
      }
    }
    const source = new ProjectedRow();
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => source });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: source,
          expectedVersion: source.quantity,
          base: source.score,
          mine: 7,
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());
    const review = runtime.getDraftReviewSnapshot()[0];
    expect(review).toMatchObject({ projectedRowAvailable: false });
    expect(review?.projectedRow).toBeUndefined();
    unsubscribe();
  });

  it("marks Yours projection unavailable instead of substituting Server state for private-field rows", () => {
    class PrivateProjectedRow {
      readonly #context: string;

      public constructor(
        public readonly id: string,
        public readonly primary: string,
        context: string,
        public readonly revision: bigint,
      ) {
        this.#context = context;
      }

      public get context(): string {
        return this.#context;
      }

      public renderPrimary(value: string): string {
        return `${this.#context}: ${value}`;
      }
    }
    const privateColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_CONTEXT",
        field: "context",
        headerName: "Context",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const source = new PrivateProjectedRow("row-1", "Server primary", "Server context", 2n);
    const runtime = new BrunoTableCellEditRuntime({
      columns: privateColumns,
      getRow: () => source,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.primary,
          mine: "Mine primary",
        },
        {
          rowId: source.id,
          columnId: "COL_ID_CONTEXT",
          field: "context",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.context,
          mine: "Mine context",
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());
    const primary = runtime
      .getDraftReviewSnapshot()
      .find((candidate) => candidate.columnId === "COL_ID_PRIMARY");
    expect(primary).toMatchObject({ projectedRowAvailable: false });
    expect(primary?.projectedRow).toBeUndefined();
    unsubscribe();
  });

  it("marks Yours projection unavailable for rows whose accessors depend on WeakMap identity", () => {
    const contexts = new WeakMap<object, string>();
    class WeakMapProjectedRow {
      public constructor(
        public readonly id: string,
        public readonly primary: string,
        context: string,
        public readonly revision: bigint,
      ) {
        contexts.set(this, context);
      }

      public get context(): string {
        return contexts.get(this) ?? "Missing context";
      }

      public renderPrimary(value: string): string {
        return `${this.context}: ${value}`;
      }
    }
    const weakMapColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
      {
        columnId: "COL_ID_CONTEXT",
        field: "context",
        headerName: "Context",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const source = new WeakMapProjectedRow("row-1", "Server primary", "Server context", 2n);
    const runtime = new BrunoTableCellEditRuntime({
      columns: weakMapColumns,
      getRow: () => source,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.primary,
          mine: "Mine primary",
        },
        {
          rowId: source.id,
          columnId: "COL_ID_CONTEXT",
          field: "context",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.context,
          mine: "Mine context",
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());
    const primary = runtime
      .getDraftReviewSnapshot()
      .find((candidate) => candidate.columnId === "COL_ID_PRIMARY");
    expect(primary).toMatchObject({ projectedRowAvailable: false });
    expect(primary?.projectedRow).toBeUndefined();
    unsubscribe();
  });

  it("marks Yours projection unavailable when an own accessor depends on WeakMap identity", () => {
    type OwnAccessorProjectedRow = Readonly<{
      readonly id: string;
      readonly primary: string;
      readonly context: string;
      readonly revision: bigint;
    }>;
    const contexts = new WeakMap<object, string>();
    const source = Object.defineProperty(
      {
        id: "row-1",
        primary: "Server primary",
        revision: 2n,
      },
      "context",
      {
        configurable: true,
        enumerable: true,
        get(this: object) {
          return contexts.get(this) ?? "Missing context";
        },
      },
    ) as OwnAccessorProjectedRow;
    contexts.set(source, "Server context");
    const ownAccessorColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: ownAccessorColumns,
      getRow: () => source,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.primary,
          mine: "Mine primary",
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());
    const primary = runtime.getDraftReviewSnapshot()[0];
    expect(primary).toMatchObject({ projectedRowAvailable: false });
    expect(primary?.projectedRow).toBeUndefined();
    unsubscribe();
  });

  it("does not infer row-aware presentation safety from a class method's source", () => {
    class HashProjectedRow {
      public constructor(
        public readonly id: string,
        public readonly primary: string,
        private readonly contextValue: string,
        public readonly revision: bigint,
      ) {}

      public get context(): string {
        return this.contextValue;
      }

      public renderPrimary(value: string): string {
        return `# ${this.context}: ${value}`;
      }
    }
    const source = new HashProjectedRow("row-1", "Server primary", "Server context", 2n);
    const hashColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({ columns: hashColumns, getRow: () => source });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.primary,
          mine: "Mine primary",
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());
    const primary = runtime.getDraftReviewSnapshot()[0];
    expect(primary).toMatchObject({ projectedRowAvailable: false });
    expect(primary?.projectedRow).toBeUndefined();
    unsubscribe();
  });

  it("does not infer row-aware presentation safety from built-in method names", () => {
    class StringPresentationProjectedRow {
      public constructor(
        public readonly id: string,
        public readonly primary: string,
        public readonly prefix: string,
        public readonly revision: bigint,
      ) {}

      public presentPrimary(value: string): string {
        return `${this.prefix.toLowerCase()}: ${value.replaceAll(" ", "-")}`;
      }
    }
    const source = new StringPresentationProjectedRow("row-1", "Server primary", "SAFE PREFIX", 2n);
    const stringPresentationColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: stringPresentationColumns,
      getRow: () => source,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.primary,
          mine: "Mine primary",
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());
    const primary = runtime.getDraftReviewSnapshot()[0];
    expect(primary).toMatchObject({ projectedRowAvailable: false });
    expect(primary?.projectedRow).toBeUndefined();
    unsubscribe();
  });

  it("does not trust a safe built-in method name on a non-string row property", () => {
    const contexts = new WeakMap<object, string>();
    const prefix = {
      toLowerCase(): string {
        return contexts.get(this) ?? "Missing context";
      },
    };
    contexts.set(prefix, "Server context");
    class ShadowedStringMethodProjectedRow {
      public constructor(
        public readonly id: string,
        public readonly primary: string,
        public readonly prefix: { readonly toLowerCase: () => string },
        public readonly revision: bigint,
      ) {}

      public presentPrimary(value: string): string {
        return `${this.prefix.toLowerCase()}: ${value}`;
      }
    }
    const source = new ShadowedStringMethodProjectedRow("row-1", "Server primary", prefix, 2n);
    const shadowedStringMethodColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: shadowedStringMethodColumns,
      getRow: () => source,
    });

    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.primary,
          mine: "Mine primary",
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());
    const primary = runtime.getDraftReviewSnapshot()[0];
    expect(primary).toMatchObject({ projectedRowAvailable: false });
    expect(primary?.projectedRow).toBeUndefined();
    unsubscribe();
  });

  it("marks Yours projection unavailable when identity-backed access is helper-indirected", () => {
    const contexts = new WeakMap<object, string>();
    const readContext = (candidate: object): string | undefined => contexts.get(candidate);
    const writeContext = (candidate: object, context: string): void => {
      contexts.set(candidate, context);
    };
    class IndirectWeakMapProjectedRow {
      public constructor(
        public readonly id: string,
        public readonly primary: string,
        context: string,
        public readonly revision: bigint,
      ) {
        writeContext(this, context);
      }

      public get context(): string {
        return readContext(this) ?? "Missing context";
      }

      public renderPrimary(value: string): string {
        return `${this.context}: ${value}`;
      }
    }
    const source = new IndirectWeakMapProjectedRow("row-1", "Server primary", "Server context", 2n);
    const indirectColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: indirectColumns,
      getRow: () => source,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.primary,
          mine: "Mine primary",
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());
    const primary = runtime.getDraftReviewSnapshot()[0];
    expect(primary).toMatchObject({ projectedRowAvailable: false });
    expect(primary?.projectedRow).toBeUndefined();
    unsubscribe();
  });

  it("marks Yours projection unavailable when the row owns its identity registry", () => {
    const contexts = new WeakMap<object, string>();
    class RowOwnedRegistryProjectedRow {
      public readonly contexts = contexts;

      public constructor(
        public readonly id: string,
        public readonly primary: string,
        context: string,
        public readonly revision: bigint,
      ) {
        contexts.set(this, context);
      }

      public get context(): string {
        return this.contexts.get(this) ?? "Missing context";
      }
    }
    const source = new RowOwnedRegistryProjectedRow(
      "row-1",
      "Server primary",
      "Server context",
      2n,
    );
    const rowOwnedRegistryColumns = compileColumns([
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName: "Primary",
        valueType: "text",
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: rowOwnedRegistryColumns,
      getRow: () => source,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: source.id,
          columnId: "COL_ID_PRIMARY",
          field: "primary",
          baseRow: source,
          expectedVersion: source.revision,
          base: source.primary,
          mine: "Mine primary",
        },
      ]),
    ).toBe(true);

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());
    const primary = runtime.getDraftReviewSnapshot()[0];
    expect(primary).toMatchObject({ projectedRowAvailable: false });
    expect(primary?.projectedRow).toBeUndefined();
    unsubscribe();
  });

  it("publishes live Reset Review updates only to the affected row projection", () => {
    const liveRows = new Map<string, Row>([
      ["row-a", Object.freeze({ ...row, id: "row-a" })],
      ["row-b", Object.freeze({ ...row, id: "row-b" })],
    ]);
    const getRow = vi.fn((rowId: string) => liveRows.get(rowId));
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: "row-a",
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: liveRows.get("row-a")!,
          expectedVersion: 1n,
          base: 4,
          mine: 7,
        },
        {
          rowId: "row-b",
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: liveRows.get("row-b")!,
          expectedVersion: 1n,
          base: 4,
          mine: 8,
        },
      ]),
    ).toBe(true);
    const membershipListener = vi.fn();
    const unsubscribeMembership = runtime.subscribeDraftReview(membershipListener);
    const [rowA, rowB] = runtime.getDraftReviewSourceSnapshot();
    if (rowA === undefined || rowB === undefined) throw new Error("Expected two review rows.");
    expect(isBrunoTableCellEditDraftReviewSourceRow(rowA)).toBe(true);
    expect(
      isBrunoTableCellEditDraftReviewSourceRow({
        kind: "bruno-table-cell-edit-draft-review-source",
        getSnapshot: rowA.getSnapshot,
        subscribe: rowA.subscribe,
      }),
    ).toBe(false);
    expect(
      isBrunoTableCellEditDraftReviewSourceRow(
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("consumer getter must not run");
            },
          },
        ),
      ),
    ).toBe(false);
    const rowAListener = vi.fn();
    const rowBListener = vi.fn();
    const unsubscribeRowA = rowA.subscribe(rowAListener);
    const unsubscribeRowB = rowB.subscribe(rowBListener);
    getRow.mockClear();

    liveRows.set("row-a", Object.freeze({ ...row, id: "row-a", score: 5 }));
    runtime.reconcileSourceRows(new Set(["row-a"]));

    expect(getRow).toHaveBeenCalledOnce();
    expect(membershipListener).not.toHaveBeenCalled();
    expect(rowAListener).toHaveBeenCalledOnce();
    expect(rowBListener).not.toHaveBeenCalled();
    expect(rowA.getSnapshot()).toMatchObject({ serverNow: 5, mine: 7 });

    unsubscribeRowA();
    unsubscribeRowB();
    unsubscribeMembership();
  });

  it("publishes coherent candidate activity and Reset Review evidence in one batch", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    const unsubscribeReview = runtime.subscribeDraftReview(vi.fn());
    const observedCandidateText: Array<string | undefined> = [];
    const unsubscribeActivity = runtime.subscribeActivity(() => {
      observedCandidateText.push(runtime.getDraftReviewSnapshot()[0]?.candidateText);
    });

    runtime.updateActiveCandidate("7", false);

    expect(observedCandidateText).toEqual(["7"]);
    unsubscribeActivity();
    unsubscribeReview();
  });

  it("refreshes observed Reset Review rows after compatible presentation changes", () => {
    type TextRow = Readonly<{ readonly id: string; readonly value: string }>;
    const source: TextRow = Object.freeze({ id: "row", value: "server" });
    const makeColumns = (headerName: string) =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName,
          valueType: "text",
          isEditable: true,
          valueFormatter: ({ value }: { readonly value: string }) => `${headerName}:${value}`,
        },
      ] satisfies BrunoTableColumns<TextRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: makeColumns("Before"),
      getRow: () => source,
    });
    expect(runtime.start(source.id, "COL_ID_VALUE")).toBe(true);
    expect(runtime.commit("mine")).toBe(true);
    const membershipListener = vi.fn();
    const unsubscribe = runtime.subscribeDraftReview(membershipListener);
    const sourceRow = runtime.getDraftReviewSourceSnapshot()[0]!;
    const rowListener = vi.fn();
    const unsubscribeRow = sourceRow.subscribe(rowListener);

    runtime.reconcileColumns(makeColumns("After"));

    expect(membershipListener).not.toHaveBeenCalled();
    expect(rowListener).toHaveBeenCalledOnce();
    expect(runtime.getDraftReviewSourceSnapshot()[0]).toBe(sourceRow);
    expect(sourceRow.columnLabel).toBe("After");
    expect(sourceRow.getSnapshot().column.headerName).toBe("After");
    unsubscribeRow();
    unsubscribe();
  });

  it("publishes one traversal invalidation for a multi-draft column reconcile", () => {
    const liveRows = new Map<string, Row>([
      ["row-a", Object.freeze({ ...row, id: "row-a" })],
      ["row-b", Object.freeze({ ...row, id: "row-b" })],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => liveRows.get(rowId),
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: "row-a",
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: liveRows.get("row-a")!,
          expectedVersion: 1n,
          base: 4,
          mine: 7,
        },
        {
          rowId: "row-b",
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: liveRows.get("row-b")!,
          expectedVersion: 1n,
          base: 4,
          mine: 8,
        },
      ]),
    ).toBe(true);
    const listener = vi.fn();
    runtime.subscribeTraversalInvalidation(listener);

    runtime.reconcileColumns(columns.filter((column) => column.columnId !== "COL_ID_SCORE"));

    expect(listener).toHaveBeenCalledOnce();
  });

  it("publishes one traversal invalidation when resetting multiple drafts", () => {
    const liveRows = new Map<string, Row>([
      ["row-a", Object.freeze({ ...row, id: "row-a" })],
      ["row-b", Object.freeze({ ...row, id: "row-b" })],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => liveRows.get(rowId),
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: "row-a",
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: liveRows.get("row-a")!,
          expectedVersion: 1n,
          base: 4,
          mine: 7,
        },
        {
          rowId: "row-b",
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: liveRows.get("row-b")!,
          expectedVersion: 1n,
          base: 4,
          mine: 8,
        },
      ]),
    ).toBe(true);
    const listener = vi.fn();
    runtime.subscribeTraversalInvalidation(listener);

    expect(runtime.resetAllDrafts()).toBe(2);

    expect(listener).toHaveBeenCalledOnce();
  });

  it("bounds Batch history without copying the complete draft store", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    runtime.setBatchHistoryEnabled(true);
    for (let offset = 1n; offset <= 105n; offset += 1n) {
      expect(runtime.start("row-1", "COL_ID_QUANTITY")).toBe(true);
      expect(runtime.commit(String(row.quantity + offset))).toBe(true);
    }
    expect(runtime.getActivitySnapshot()).toMatchObject({ undoCount: 100, redoCount: 0 });
  });

  it("records one reversible sparse history command for a 500-cell accepted gesture", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    runtime.setBatchHistoryEnabled(true);
    const traversalInvalidation = vi.fn();
    runtime.subscribeTraversalInvalidation(traversalInvalidation);
    const changes = Array.from(
      { length: 500 },
      (_unused, index): BrunoTableCellEditDraftSnapshot =>
        Object.freeze({
          rowId: `row-${String(index)}`,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: BigInt(index),
          base: 4,
          mine: 7,
        }),
    );
    const first = changes[0];
    if (first === undefined) throw new Error("Gesture fixture must be non-empty.");
    const gesture: readonly [
      BrunoTableCellEditDraftSnapshot,
      ...BrunoTableCellEditDraftSnapshot[],
    ] = [first, ...changes.slice(1)];

    expect(runtime.applyAcceptedDraftGesture(gesture)).toBe(true);
    expect(traversalInvalidation).toHaveBeenCalledOnce();
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 500, undoCount: 1 });
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(traversalInvalidation).toHaveBeenCalledTimes(2);
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      undoCount: 0,
      redoCount: 1,
    });
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(traversalInvalidation).toHaveBeenCalledTimes(3);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 500, undoCount: 1 });
  });

  it("rejects duplicate Cell Identities without creating phantom Batch history", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    runtime.setBatchHistoryEnabled(true);
    const draft = {
      rowId: row.id,
      columnId: "COL_ID_SCORE",
      field: "score",
      baseRow: row,
      expectedVersion: 1n,
      base: 4,
      mine: 7,
    } as const;
    expect(runtime.applyAcceptedDraftGesture([draft])).toBe(true);
    const before = runtime.getDraftMemorySnapshot();

    expect(
      runtime.applyAcceptedDraftGesture([
        { ...draft, mine: 8 },
        { ...draft, mine: 7 },
      ]),
    ).toBe(false);
    expect(runtime.getDraftMemorySnapshot()).toBe(before);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, undoCount: 1 });
  });

  it("reverses complete validation and conflict evidence as one sparse cell state", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: 1n,
          base: 4,
          mine: 7,
          validationMessage: "Retained validation evidence",
          conflict: { server: 6, serverVersion: 2n, resolution: "mine" },
        },
      ]),
    ).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ validationCount: 1, conflictCount: 1 });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        validationMessage: "Retained validation evidence",
        conflict: { server: 6, serverVersion: 2n, resolution: "mine" },
        status: "Retained validation evidence",
      },
    ]);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ validationCount: 0, conflictCount: 0 });
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ validationCount: 1, conflictCount: 1 });
  });

  it("preserves a conflict decision for identical evidence and clears it for a new version", () => {
    let current: Row = Object.freeze({ ...row, score: 6, quantity: 2n });
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: 4,
          mine: 7,
          conflict: { server: 6, serverVersion: 2n, resolution: "mine" },
        },
      ]),
    ).toBe(true);

    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getDraftReviewSnapshot()[0]?.conflict).toStrictEqual({
      server: 6,
      serverVersion: 2n,
      resolution: "mine",
    });

    current = Object.freeze({ ...current, quantity: 3n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getDraftReviewSnapshot()[0]?.conflict).toStrictEqual({
      server: 6,
      serverVersion: 3n,
    });
  });

  it("prunes draft, conflict, validation, and both history stacks on semantic convergence", () => {
    let current: Row = Object.freeze({ ...row, score: 6, quantity: row.quantity + 1n });
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: 4,
          mine: 7,
          validationMessage: "Retained validation evidence",
          conflict: { server: 6, serverVersion: row.quantity + 1n },
        },
      ]),
    ).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 1,
      validationCount: 1,
      conflictCount: 1,
      undoCount: 1,
      redoCount: 0,
    });

    current = Object.freeze({ ...row, score: 7, quantity: row.quantity + 2n });
    runtime.reconcileSourceRows(new Set([row.id]));

    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      validationCount: 0,
      conflictCount: 0,
      undoCount: 0,
      redoCount: 0,
    });
    expect(runtime.undoBatchDraft()).toBe(false);
    expect(runtime.redoBatchDraft()).toBe(false);
  });

  it("clears stale validation and conflict evidence when Mine changes", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: 1n,
          base: 4,
          mine: 7,
          validationMessage: "Old validation evidence",
          conflict: { server: 6, serverVersion: 2n, resolution: "mine" },
        },
      ]),
    ).toBe(true);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ validationCount: 0, conflictCount: 0 });
    const corrected = runtime.getDraftReviewSnapshot()[0];
    expect(corrected).toMatchObject({ mine: 8 });
    expect(Object.hasOwn(corrected!, "validationMessage")).toBe(false);
    expect(Object.hasOwn(corrected!, "conflict")).toBe(false);

    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        mine: 7,
        validationMessage: "Old validation evidence",
      },
    ]);
    expect(runtime.getDraftReviewSnapshot()[0]).not.toHaveProperty("conflict");
  });

  it("bounds the reverse dependency index to retained draft and history evidence", () => {
    const rows = new Map<string, Row>();
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
    });
    runtime.setBatchHistoryEnabled(true);

    for (let index = 0; index < 105; index += 1) {
      const current = Object.freeze({ ...row, id: `row-${String(index)}` });
      rows.set(current.id, current);
      expect(runtime.start(current.id, "COL_ID_SCORE")).toBe(true);
      expect(runtime.commit("7")).toBe(true);
      expect(runtime.undoBatchDraft()).toBe(true);
    }

    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(1);
  });

  it("prunes only a converged cell from a multi-cell history command", () => {
    const liveRows = new Map<string, Row>([
      ["row-a", Object.freeze({ ...row, id: "row-a" })],
      ["row-b", Object.freeze({ ...row, id: "row-b" })],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => liveRows.get(rowId),
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: "row-a",
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: liveRows.get("row-a")!,
          expectedVersion: 1n,
          base: 4,
          mine: 7,
        },
        {
          rowId: "row-b",
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: liveRows.get("row-b")!,
          expectedVersion: 1n,
          base: 4,
          mine: 8,
        },
      ]),
    ).toBe(true);
    liveRows.set("row-a", Object.freeze({ ...row, id: "row-a", score: 7 }));
    runtime.reconcileSourceRows(new Set(["row-a"]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, undoCount: 1 });
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot("row-a", "COL_ID_SCORE")).toBeUndefined();
    expect(runtime.getDraftSnapshot("row-b", "COL_ID_SCORE")).toBeUndefined();
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot("row-a", "COL_ID_SCORE")).toBeUndefined();
    expect(runtime.getDraftSnapshot("row-b", "COL_ID_SCORE")).toBe(8);
  });

  it("bulk-prunes converged cells while preserving one divergent history patch", () => {
    const liveRows = new Map<string, Row>();
    const changes = Array.from({ length: 34 }, (_, index) => {
      const rowId = `row-${String(index)}`;
      const baseRow = Object.freeze({ ...row, id: rowId });
      liveRows.set(rowId, baseRow);
      return {
        rowId,
        columnId: "COL_ID_SCORE",
        field: "score" as const,
        baseRow,
        expectedVersion: 1n,
        base: 4,
        mine: index < 33 ? 7 : 8,
      };
    });
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => liveRows.get(rowId),
    });
    runtime.setBatchHistoryEnabled(true);
    const firstChange = changes[0];
    if (firstChange === undefined) throw new Error("Expected a non-empty bulk gesture.");
    expect(runtime.applyAcceptedDraftGesture([firstChange, ...changes.slice(1)])).toBe(true);
    for (let index = 0; index < 33; index += 1) {
      const rowId = `row-${String(index)}`;
      liveRows.set(rowId, Object.freeze({ ...row, id: rowId, score: 7 }));
    }

    runtime.reconcileSourceRows(undefined);

    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, undoCount: 1 });
    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(1);
    for (let index = 0; index < 33; index += 1) {
      expect(runtime.getDraftSnapshot(`row-${String(index)}`, "COL_ID_SCORE")).toBeUndefined();
    }
    expect(runtime.getDraftSnapshot("row-33", "COL_ID_SCORE")).toBe(8);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(1);
    expect(runtime.redoBatchDraft()).toBe(true);
    for (let index = 0; index < 33; index += 1) {
      expect(runtime.getDraftSnapshot(`row-${String(index)}`, "COL_ID_SCORE")).toBeUndefined();
    }
    expect(runtime.getDraftSnapshot("row-33", "COL_ID_SCORE")).toBe(8);
  });

  it("prunes redo evidence when its compiled column authority disappears", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);
    runtime.reconcileColumns(columns.filter((column) => column.columnId !== "COL_ID_SCORE"));
    expect(runtime.getActivitySnapshot()).toMatchObject({ redoCount: 0 });
    expect(runtime.redoBatchDraft()).toBe(false);
  });

  it("seeds current-value editing from the canonical source value and rejects unreadable cells", () => {
    const commit = vi.fn();
    const normalizedValueType: BrunoTableValueType<string> = {
      codecId: "test/normalized-edit-source",
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input.trim().toUpperCase() }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: Object.is,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: String,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: String,
      encodePersisted: String,
      decodePersisted: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
    };
    const normalizedColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: normalizedValueType,
        isEditable: ({ value }: { readonly value: string }) => value === "SOURCE",
      },
    ]);
    const normalizedRuntime = new BrunoTableCellEditRuntime({
      columns: normalizedColumns,
      getRow: () => ({ value: "  source  " }),
      onCommit: commit,
    });

    expect(normalizedRuntime.start("row", "COL_ID_VALUE")).toBe(true);
    expect(normalizedRuntime.getSessionSnapshot()).toMatchObject({ initialText: "SOURCE" });
    expect(normalizedRuntime.commit("SOURCE")).toBe(true);
    expect(normalizedRuntime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();

    const unreadable = Object.defineProperty({}, "value", {
      get: () => {
        throw new Error("unreadable");
      },
    });
    const unreadableRuntime = new BrunoTableCellEditRuntime({
      columns: normalizedColumns,
      getRow: () => unreadable,
    });
    let admitted: boolean | undefined;
    expect(() => {
      admitted = unreadableRuntime.start("row", "COL_ID_VALUE");
    }).not.toThrow();
    expect(admitted).toBe(false);
  });

  it("retains invalid raw input and commits exact typed values only after one gate", () => {
    const commit = vi.fn();
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => (rowId === row.id ? row : undefined),
      onCommit: commit,
    });

    expect(runtime.start("row-1", "COL_ID_QUANTITY")).toBe(true);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      initialText: "9007199254740993",
    });
    expect(runtime.commit("9007199254740993.5")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      invalidMessage: "Expected signed base-10 integer digits.",
    });
    expect(runtime.getDraftSnapshot("row-1", "COL_ID_QUANTITY")).toBe(undefined);
    expect(commit).not.toHaveBeenCalled();

    expect(runtime.commit("9007199254740995")).toBe(true);
    expect(runtime.getSessionSnapshot()).toEqual({ kind: "idle" });
    expect(runtime.getDraftSnapshot("row-1", "COL_ID_QUANTITY")).toBe(9_007_199_254_740_995n);
    expect(commit).toHaveBeenCalledWith({
      rowId: "row-1",
      columnId: "COL_ID_QUANTITY",
      field: "quantity",
      before: 9_007_199_254_740_993n,
      after: 9_007_199_254_740_995n,
    });
  });

  it("runs synchronous validation at commit and Escape restores the pre-session draft", () => {
    const commit = vi.fn();
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      onCommit: commit,
    });
    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("11")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      invalidMessage: "Score must be at most 10.",
    });
    expect(runtime.cancel()).toBe(true);
    expect(runtime.getSessionSnapshot()).toEqual({ kind: "idle" });
    expect(runtime.getDraftSnapshot("row-1", "COL_ID_SCORE")).toBe(undefined);
    expect(commit).not.toHaveBeenCalled();

    expect(runtime.start("row-1", "COL_ID_SCORE", "replace", "7")).toBe(true);
    expect(runtime.getSessionSnapshot()).toMatchObject({ initialText: "7" });
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.getSessionSnapshot()).toMatchObject({ initialText: "7" });
    expect(runtime.cancel()).toBe(true);
    expect(runtime.getDraftSnapshot("row-1", "COL_ID_SCORE")).toBe(7);
  });

  it("bounds untrusted candidates and admits native Number validity through the actor gate", () => {
    const validate = vi.fn();
    const guardedColumns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
        isEditable: true,
        validate,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({ columns: guardedColumns, getRow: () => row });

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    runtime.updateActiveCandidate(
      "1".repeat(BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH + 100),
      false,
    );
    expect(runtime.getActiveCandidateSnapshot().rawText).toHaveLength(
      BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH + 1,
    );
    expect(runtime.commit("1".repeat(BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH + 1))).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      invalidMessage: `Enter at most ${String(BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH)} characters.`,
    });
    expect(validate).not.toHaveBeenCalled();
    expect(runtime.commit("4", true)).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({ invalidMessage: "Enter a valid number." });
    expect(validate).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("publishes only the affected cell projection instead of waking the matrix", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    const quantitySubscriber = vi.fn();
    const scoreSubscriber = vi.fn();
    const unsubscribeQuantity = runtime.subscribeCell(
      "row-1",
      "COL_ID_QUANTITY",
      quantitySubscriber,
    );
    const unsubscribeScore = runtime.subscribeCell("row-1", "COL_ID_SCORE", scoreSubscriber);

    expect(runtime.start("row-1", "COL_ID_QUANTITY")).toBe(true);
    expect(quantitySubscriber).toHaveBeenCalledTimes(1);
    expect(scoreSubscriber).not.toHaveBeenCalled();
    expect(runtime.commit("9007199254740995")).toBe(true);
    expect(quantitySubscriber).toHaveBeenCalledTimes(2);
    expect(scoreSubscriber).not.toHaveBeenCalled();

    unsubscribeQuantity();
    unsubscribeScore();
    runtime.dispose();
  });

  it("publishes draft presence independently from an undefined draft value", () => {
    type OptionalRow = Readonly<{ readonly id: string; readonly optional: string | undefined }>;
    const optionalValueType: BrunoTableValueType<string | undefined, "equality", "text"> = {
      codecId: "test/undefined",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 100,
      decodeRuntime: (input) =>
        typeof input === "string" || input === undefined
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected optional text." },
      equivalent: Object.is,
      compare: (left, right) => (Object.is(left, right) ? 0 : left === undefined ? -1 : 1),
      formatCanonicalText: (value) => value ?? "undefined",
      parseCanonicalText: () => ({ _tag: "Success", value: undefined }),
      formatDisplay: (value) => value ?? "undefined",
      encodePersisted: () => null,
      decodePersisted: () => ({ _tag: "Success", value: undefined }),
    };
    const optionalRow: OptionalRow = { id: "optional", optional: "source" };
    const optionalColumns = compileColumns([
      {
        columnId: "COL_ID_OPTIONAL",
        field: "optional",
        headerName: "Optional",
        valueType: optionalValueType,
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: optionalColumns,
      getRow: () => optionalRow,
    });
    const subscriber = vi.fn();
    const unsubscribe = runtime.subscribeCell("optional", "COL_ID_OPTIONAL", subscriber);

    expect(runtime.start("optional", "COL_ID_OPTIONAL")).toBe(true);
    expect(runtime.commit("undefined")).toBe(true);
    const projection = runtime.getCellSnapshot("optional", "COL_ID_OPTIONAL");
    expect(projection).toMatchObject({ active: false, hasDraft: true, draft: undefined });
    expect(Object.hasOwn(projection, "draft")).toBe(true);
    expect(subscriber).toHaveBeenCalledTimes(2);

    unsubscribe();
    runtime.dispose();
  });

  it("invalidates predicate traversal from the store-owned draft revision", () => {
    const draftColumns = compileColumns([
      {
        columnId: "COL_ID_START",
        field: "quantity",
        headerName: "Start",
        valueType: "bigint",
        isEditable: true,
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
        isEditable: ({ value }: { readonly value: number }) => value < 5,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({ columns: draftColumns, getRow: () => row });
    runtime.setBatchHistoryEnabled(true);
    const traversalInvalidation = vi.fn();
    const unsubscribeTraversal = runtime.subscribeTraversalInvalidation(traversalInvalidation);
    runtime.reconcileTraversal(draftColumns, {
      totalRows: 1,
      getRowId: (rowIndex) => (rowIndex === 0 ? row.id : undefined),
    });

    expect(runtime.findTraversalDestination(0, "COL_ID_START", 1)?.columnId).toBe("COL_ID_SCORE");
    const range = Object.freeze({
      axis: "horizontal" as const,
      rowId: row.id,
      columnIds: Object.freeze(["COL_ID_START", "COL_ID_SCORE"]),
    });
    expect(runtime.findRangeTraversalDestination(range, row.id, "COL_ID_START", 1)?.columnId).toBe(
      "COL_ID_SCORE",
    );
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(traversalInvalidation).toHaveBeenCalledOnce();
    expect(runtime.findTraversalDestination(0, "COL_ID_START", 1)).toBeUndefined();
    expect(runtime.findRangeTraversalDestination(range, row.id, "COL_ID_START", 1)).toBeUndefined();
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.findTraversalDestination(0, "COL_ID_START", 1)?.columnId).toBe("COL_ID_SCORE");
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.findTraversalDestination(0, "COL_ID_START", 1)).toBeUndefined();
    runtime.reconcileTraversalRows(undefined);
    expect(traversalInvalidation).toHaveBeenCalledTimes(4);
    unsubscribeTraversal();
    runtime.dispose();
  });

  it("publishes actor-owned invalid, accepted, and cancel decisions coherently", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    const sessionObservations: Array<readonly [string, boolean]> = [];
    const cellObservations: Array<readonly [boolean, string]> = [];
    const unsubscribeSession = runtime.subscribeSession(() => {
      sessionObservations.push([
        runtime.getSessionSnapshot().kind,
        runtime.getCellSnapshot("row-1", "COL_ID_SCORE").active,
      ]);
    });
    const unsubscribeCell = runtime.subscribeCell("row-1", "COL_ID_SCORE", () => {
      cellObservations.push([
        runtime.getCellSnapshot("row-1", "COL_ID_SCORE").active,
        runtime.getSessionSnapshot().kind,
      ]);
    });

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(sessionObservations).toEqual([["editing", true]]);
    expect(cellObservations).toEqual([[true, "editing"]]);
    expect(runtime.commit("11")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      invalidMessage: "Score must be at most 10.",
    });
    expect(runtime.getCellSnapshot("row-1", "COL_ID_SCORE").active).toBe(true);
    expect(runtime.commit("6")).toBe(true);
    expect(sessionObservations.at(-1)).toEqual(["idle", false]);
    expect(cellObservations.at(-1)).toEqual([false, "idle"]);

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.cancel()).toBe(true);
    expect(sessionObservations.at(-1)).toEqual(["idle", false]);
    expect(cellObservations.at(-1)).toEqual([false, "idle"]);

    unsubscribeCell();
    unsubscribeSession();
    runtime.dispose();
  });

  it("applies actor-produced draft patches to store-owned memory in one observable batch", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    const initialDraftMemory = runtime.getDraftMemorySnapshot();
    const observations: Array<readonly [string, number, unknown]> = [];
    const unsubscribe = runtime.subscribeCell("row-1", "COL_ID_SCORE", () => {
      observations.push([
        runtime.getSessionSnapshot().kind,
        runtime.getDraftMemorySnapshot().size,
        runtime.getCellSnapshot("row-1", "COL_ID_SCORE").draft,
      ]);
    });

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("11")).toBe(false);
    expect(runtime.getDraftMemorySnapshot()).toBe(initialDraftMemory);
    expect(runtime.commit("6")).toBe(true);
    expect(runtime.getDraftMemorySnapshot()).not.toBe(initialDraftMemory);
    expect(observations.at(-1)).toEqual(["idle", 1, 6]);

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("4")).toBe(true);
    expect(observations.at(-1)).toEqual(["idle", 0, undefined]);

    unsubscribe();
    runtime.dispose();
  });

  it("keeps snapshot reads observational and bounds stores to live subscriptions or the editor", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    for (let index = 0; index < 1_000; index += 1) {
      runtime.getCellSnapshot(`row-${String(index)}`, "COL_ID_SCORE");
    }
    expect(runtime.getRetainedCellStoreCount()).toBe(0);

    const unsubscribe = runtime.subscribeCell("row-1", "COL_ID_SCORE", () => undefined);
    expect(runtime.getRetainedCellStoreCount()).toBe(1);
    unsubscribe();
    expect(runtime.getRetainedCellStoreCount()).toBe(0);

    for (let index = 0; index < 1_000; index += 1) {
      const release = runtime.subscribeCell(
        `idle-${String(index)}`,
        "COL_ID_SCORE",
        () => undefined,
      );
      release();
    }
    expect(runtime.getRetainedCellStoreCount()).toBe(0);

    const unsubscribeActive = runtime.subscribeCell("row-1", "COL_ID_SCORE", () => undefined);
    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.getRetainedCellStoreCount()).toBe(1);
    unsubscribeActive();
    expect(runtime.getRetainedCellStoreCount()).toBe(1);
    expect(runtime.cancel()).toBe(true);
    expect(runtime.getRetainedCellStoreCount()).toBe(0);

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("6")).toBe(true);
    const first = runtime.getCellSnapshot("row-1", "COL_ID_SCORE");
    expect(runtime.getCellSnapshot("row-1", "COL_ID_SCORE")).toBe(first);
    expect(first).toMatchObject({ active: false, hasDraft: true, draft: 6 });
    expect(runtime.getRetainedCellStoreCount()).toBe(0);
    runtime.dispose();
  });

  it("releases unmounted cell stores while durable save evidence remains", () => {
    vi.useFakeTimers();
    try {
      const changeSet = [
        {
          rowId: row.id,
          baseRow: row,
          expectedVersion: row.quantity,
          changes: [
            {
              columnId: "COL_ID_SCORE",
              field: "score",
              before: row.score,
              after: 7,
            },
          ],
        },
      ] as const;

      let acceptedRow = row;
      const accepted = new BrunoTableCellEditRuntime({
        columns,
        getRow: () => acceptedRow,
        getRowVersion: (candidate) => (candidate as Row).quantity,
      });
      const unsubscribeAccepted = accepted.subscribeCell(row.id, "COL_ID_SCORE", () => undefined);
      expect(accepted.beginSaveOperation("accepted", changeSet, false)).toBe(true);
      accepted.acceptSave("accepted", changeSet, false);
      acceptedRow = Object.freeze({ ...row, score: 7 });
      accepted.reconcileSourceRows(new Set([row.id]));
      unsubscribeAccepted();
      expect(accepted.getRetainedCellStoreCount()).toBe(0);
      vi.advanceTimersByTime(2_000);
      expect(accepted.getRetainedCellStoreCount()).toBe(0);

      const immediate = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
      const unsubscribeImmediate = immediate.subscribeCell(row.id, "COL_ID_SCORE", () => undefined);
      immediate.rejectSave("immediate", changeSet, true);
      unsubscribeImmediate();
      expect(immediate.getRetainedCellStoreCount()).toBe(0);
      vi.advanceTimersByTime(5_000);
      expect(immediate.getRetainedCellStoreCount()).toBe(0);

      let batchRow = row;
      const rejectedBatch = new BrunoTableCellEditRuntime({
        columns,
        getRow: () => batchRow,
      });
      const unsubscribeBatch = rejectedBatch.subscribeCell(row.id, "COL_ID_SCORE", () => undefined);
      rejectedBatch.rejectSave("batch", changeSet, false);
      unsubscribeBatch();
      expect(rejectedBatch.getRetainedCellStoreCount()).toBe(0);
      batchRow = Object.freeze({ ...row, score: 7 });
      rejectedBatch.reconcileSourceRows(new Set([row.id]));
      expect(rejectedBatch.getRetainedCellStoreCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the optional Effect BigDecimal domain without number coercion", () => {
    const before = BigDecimal.fromStringUnsafe("12345678901234567890.00000000000000000001");
    const decimalRow = { id: "decimal", amount: before };
    const decimalColumns = compileColumns([
      {
        columnId: "COL_ID_AMOUNT",
        field: "amount",
        headerName: "Amount",
        valueType: BrunoTableBigDecimalValueType,
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: decimalColumns,
      getRow: () => decimalRow,
    });

    expect(runtime.start("decimal", "COL_ID_AMOUNT")).toBe(true);
    expect(runtime.commit("12345678901234567890.00000000000000000002")).toBe(true);
    const draft = runtime.getDraftSnapshot("decimal", "COL_ID_AMOUNT") as BigDecimal.BigDecimal;
    expect(
      BigDecimal.equals(
        draft,
        BigDecimal.fromStringUnsafe("12345678901234567890.00000000000000000002"),
      ),
    ).toBe(true);
  });

  it("uses compiled exact semantics for BigDecimal conflict detection and convergence", () => {
    type DecimalRow = Readonly<{
      readonly id: string;
      readonly amount: BigDecimal.BigDecimal;
      readonly revision: bigint;
    }>;
    const decimalColumns = compileColumns([
      {
        columnId: "COL_ID_AMOUNT",
        field: "amount",
        headerName: "Amount",
        valueType: BrunoTableBigDecimalValueType,
        isEditable: true,
      },
    ]);
    let current: DecimalRow = Object.freeze({
      id: "decimal-conflict",
      amount: BigDecimal.fromStringUnsafe("1.50"),
      revision: 1n,
    });
    const runtime = new BrunoTableCellEditRuntime({
      columns: decimalColumns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as DecimalRow).revision,
    });
    runtime.setBatchHistoryEnabled(true);

    expect(runtime.start(current.id, "COL_ID_AMOUNT")).toBe(true);
    expect(runtime.commit("2.00")).toBe(true);
    current = Object.freeze({
      ...current,
      amount: BigDecimal.fromStringUnsafe("1.5"),
      revision: 2n,
    });
    runtime.reconcileSourceRows(new Set([current.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 0 });

    current = Object.freeze({
      ...current,
      amount: BigDecimal.fromStringUnsafe("1.75"),
      revision: 3n,
    });
    runtime.reconcileSourceRows(new Set([current.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 1 });
    expect(runtime.getDraftReviewSnapshot()[0]?.conflict).toMatchObject({
      serverVersion: 3n,
    });

    current = Object.freeze({
      ...current,
      amount: BigDecimal.fromStringUnsafe("2.0"),
      revision: 4n,
    });
    runtime.reconcileSourceRows(new Set([current.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      conflictCount: 0,
      undoCount: 0,
      redoCount: 0,
    });
  });

  it("resolves explicit nullish blank representations before scalar parsing", () => {
    type NullableRow = Readonly<{
      readonly id: string;
      readonly nullable: number | null;
      readonly optional: number | undefined;
      readonly required: number;
    }>;
    const nullableRow: NullableRow = {
      id: "nullable",
      nullable: 5,
      optional: 6,
      required: 7,
    };
    const nullableColumns = compileColumns([
      {
        columnId: "COL_ID_NULLABLE",
        field: "nullable",
        headerName: "Nullable",
        valueType: "number",
        isEditable: true,
        blankValue: null,
      },
      {
        columnId: "COL_ID_OPTIONAL",
        field: "optional",
        headerName: "Optional",
        valueType: "number",
        isEditable: true,
        blankValue: undefined,
      },
      {
        columnId: "COL_ID_REQUIRED",
        field: "required",
        headerName: "Required",
        valueType: "number",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<NullableRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: nullableColumns,
      getRow: () => nullableRow,
    });

    expect(runtime.start("nullable", "COL_ID_NULLABLE")).toBe(true);
    expect(runtime.commit("")).toBe(true);
    expect(runtime.getDraftSnapshot("nullable", "COL_ID_NULLABLE")).toBe(null);
    expect(runtime.start("nullable", "COL_ID_OPTIONAL")).toBe(true);
    expect(runtime.commit("")).toBe(true);
    expect(runtime.getCellSnapshot("nullable", "COL_ID_OPTIONAL")).toMatchObject({
      hasDraft: true,
      draft: undefined,
    });
    expect(runtime.start("nullable", "COL_ID_REQUIRED")).toBe(true);
    expect(runtime.commit("")).toBe(false);
    expect(runtime.getDraftSnapshot("nullable", "COL_ID_REQUIRED")).toBeUndefined();
  });

  it("preserves the explicit null versus undefined edit representation", () => {
    type AmbiguousRow = Readonly<{
      readonly id: string;
      readonly value: number | null | undefined;
    }>;
    let ambiguousRow: AmbiguousRow = { id: "ambiguous", value: undefined };
    const nullColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "number",
        isEditable: true,
        blankValue: null,
      },
    ] satisfies BrunoTableColumns<AmbiguousRow>);
    const nullRuntime = new BrunoTableCellEditRuntime({
      columns: nullColumns,
      getRow: () => ambiguousRow,
    });

    expect(nullRuntime.start("ambiguous", "COL_ID_VALUE")).toBe(true);
    expect(nullRuntime.commit("")).toBe(true);
    expect(nullRuntime.getCellSnapshot("ambiguous", "COL_ID_VALUE")).toMatchObject({
      hasDraft: true,
      draft: null,
    });

    ambiguousRow = { id: "ambiguous", value: null };
    const undefinedColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "number",
        isEditable: true,
        blankValue: undefined,
      },
    ] satisfies BrunoTableColumns<AmbiguousRow>);
    const undefinedRuntime = new BrunoTableCellEditRuntime({
      columns: undefinedColumns,
      getRow: () => ambiguousRow,
    });

    expect(undefinedRuntime.start("ambiguous", "COL_ID_VALUE")).toBe(true);
    expect(undefinedRuntime.commit("")).toBe(true);
    expect(undefinedRuntime.getCellSnapshot("ambiguous", "COL_ID_VALUE")).toMatchObject({
      hasDraft: true,
      draft: undefined,
    });
  });

  it("keeps Select and Boolean blank intent distinct from exact scalar values", () => {
    type ChoiceRow = Readonly<{
      readonly id: string;
      readonly flag: boolean | null;
      readonly nullableChoice: "" | "ready" | null;
      readonly requiredChoice: "" | "ready";
    }>;
    const choiceRow: ChoiceRow = {
      id: "choice",
      flag: null,
      nullableChoice: null,
      requiredChoice: "ready",
    };
    const choiceColumns = compileColumns([
      {
        columnId: "COL_ID_FLAG",
        field: "flag",
        headerName: "Flag",
        valueType: "boolean",
        isEditable: true,
        blankValue: null,
      },
      BrunoTableSelectColumn({
        columnId: "COL_ID_NULLABLE_CHOICE",
        field: "nullableChoice",
        headerName: "Nullable choice",
        options: ["", "ready"],
        isEditable: true,
        blankValue: null,
      }),
      BrunoTableSelectColumn({
        columnId: "COL_ID_REQUIRED_CHOICE",
        field: "requiredChoice",
        headerName: "Required choice",
        options: ["", "ready"],
        isEditable: true,
      }),
    ] satisfies BrunoTableColumns<ChoiceRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: choiceColumns,
      getRow: () => choiceRow,
    });

    expect(runtime.start("choice", "COL_ID_FLAG")).toBe(true);
    expect(runtime.getActiveCandidateSnapshot()).toMatchObject({ kind: "blank" });
    expect(runtime.commit("false", false, "scalar")).toBe(true);
    expect(runtime.getDraftSnapshot("choice", "COL_ID_FLAG")).toBe(false);

    expect(runtime.start("choice", "COL_ID_NULLABLE_CHOICE")).toBe(true);
    expect(runtime.commit("", false, "scalar")).toBe(true);
    expect(runtime.getDraftSnapshot("choice", "COL_ID_NULLABLE_CHOICE")).toBe("");
    expect(runtime.start("choice", "COL_ID_NULLABLE_CHOICE")).toBe(true);
    expect(runtime.commit("", false, "blank")).toBe(true);
    expect(runtime.getCellSnapshot("choice", "COL_ID_NULLABLE_CHOICE")).toMatchObject({
      hasDraft: false,
    });

    expect(runtime.start("choice", "COL_ID_REQUIRED_CHOICE")).toBe(true);
    expect(runtime.commit("", false, "scalar")).toBe(true);
    expect(runtime.getDraftSnapshot("choice", "COL_ID_REQUIRED_CHOICE")).toBe("");
    expect(runtime.start("choice", "COL_ID_REQUIRED_CHOICE")).toBe(true);
    expect(runtime.commit("", false, "blank")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({ invalidMessage: "Enter a value." });
  });

  it("rejects policy-free blank input before a custom numeric text parser can coerce zero", () => {
    const parseCanonicalText = vi.fn((text: string) => ({
      _tag: "Success" as const,
      value: BigInt(text),
    }));
    const numericTextValueType: BrunoTableValueType<bigint, "numeric", "text"> = {
      codecId: "test/numeric-text",
      codecVersion: 1,
      filterFamily: "numeric",
      editorFamily: "text",
      cellAlign: "end",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "bigint"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected bigint." },
      equivalent: Object.is,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: String,
      parseCanonicalText,
      formatDisplay: String,
      encodePersisted: String,
      decodePersisted: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: BigInt(input) }
          : { _tag: "Failure", message: "Expected string." },
    };
    const customColumns = compileColumns([
      {
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        headerName: "Quantity",
        valueType: numericTextValueType,
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({ columns: customColumns, getRow: () => row });

    expect(runtime.start("row-1", "COL_ID_QUANTITY")).toBe(true);
    expect(runtime.commit("")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({ invalidMessage: "Enter a value." });
    expect(parseCanonicalText).not.toHaveBeenCalled();
  });

  it("contains throwing and malformed custom parsers as recoverable invalid candidates", () => {
    let parserMode: "throw" | "malformed" | "wrong-domain" = "throw";
    const customValueType: BrunoTableValueType<string> = {
      codecId: "test/throwing-editor-parser",
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected string." },
      equivalent: Object.is,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: String,
      parseCanonicalText: () => {
        if (parserMode === "malformed") return { nope: true } as never;
        if (parserMode === "wrong-domain") return { _tag: "Success", value: 1n } as never;
        throw new Error("parser escaped");
      },
      formatDisplay: String,
      encodePersisted: String,
      decodePersisted: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected string." },
    };
    const parserRow = { id: "parser", value: "before" };
    const parserColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: customValueType,
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: parserColumns,
      getRow: () => parserRow,
    });

    expect(runtime.start("parser", "COL_ID_VALUE")).toBe(true);
    runtime.updateActiveCandidate("candidate", false);
    expect(runtime.commit("candidate")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      invalidMessage: "BrunoTable Value Type parseCanonicalText failed.",
    });
    expect(runtime.getActiveCandidateSnapshot()).toMatchObject({
      kind: "scalar",
      rawText: "candidate",
    });

    parserMode = "malformed";
    expect(runtime.commit("still candidate")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      invalidMessage: "BrunoTable Value Type parseCanonicalText failed.",
    });
    parserMode = "wrong-domain";
    expect(runtime.commit("wrong domain")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({ invalidMessage: "Expected string." });
    expect(runtime.getDraftSnapshot("parser", "COL_ID_VALUE")).toBeUndefined();
    expect(runtime.cancel()).toBe(true);
  });

  it("contains hostile edit equality for both before and live-source comparisons", () => {
    for (const failureAt of [1, 2] as const) {
      let equalityCalls = 0;
      const valueType: BrunoTableValueType<string> = {
        codecId: `test/hostile-edit-equality-${String(failureAt)}`,
        codecVersion: 1,
        filterFamily: "text",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime: (input) =>
          typeof input === "string"
            ? { _tag: "Success", value: input }
            : { _tag: "Failure", message: "Expected text." },
        equivalent: () => {
          equalityCalls += 1;
          if (equalityCalls === failureAt) throw new Error("equality escaped");
          return false;
        },
        compare: () => 0,
        formatCanonicalText: String,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
        formatDisplay: String,
        encodePersisted: String,
        decodePersisted: (input) => ({ _tag: "Success", value: String(input) }),
      };
      const liveRow = { value: "source" };
      const runtime = new BrunoTableCellEditRuntime({
        columns: compileColumns([
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            headerName: "Value",
            valueType,
            isEditable: true,
          },
        ]),
        getRow: () => liveRow,
      });

      expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
      expect(runtime.commit("candidate")).toBe(false);
      expect(runtime.getSessionSnapshot()).toMatchObject({
        kind: "editing",
        invalidMessage: "The value is invalid.",
      });
      expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();
    }
  });

  it("keeps candidate ownership while XState reconciles a live Row Identity tombstone", () => {
    let liveRow: Row | undefined = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => liveRow,
    });

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    runtime.updateActiveCandidate("7", false);
    liveRow = { ...row, score: 5 };
    runtime.reconcileActiveRow();
    expect(runtime.getSessionSnapshot()).toMatchObject({ kind: "editing", rowMissing: false });
    expect(runtime.getActiveCandidateSnapshot()).toEqual({
      kind: "scalar",
      rawText: "7",
      nativeInvalid: false,
    });

    liveRow = undefined;
    runtime.reconcileActiveRow();
    expect(runtime.getSessionSnapshot()).toMatchObject({ kind: "editing", rowMissing: true });
    expect(runtime.commit("7")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      rowMissing: true,
    });
    expect(runtime.getSessionSnapshot()).not.toHaveProperty("invalidMessage");

    liveRow = { ...row, score: 6 };
    runtime.reconcileActiveRow();
    expect(runtime.getSessionSnapshot()).toMatchObject({ kind: "editing", rowMissing: false });
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.getDraftSnapshot("row-1", "COL_ID_SCORE")).toBe(7);
  });

  it("captures one immutable draft command reader while later drafts publish", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("5")).toBe(true);
    const firstCommand = runtime.captureDraftCommandReader();

    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("6")).toBe(true);

    expect(firstCommand("row-1", "COL_ID_SCORE")).toEqual({
      hasDraft: true,
      value: 5,
    });
    expect(runtime.captureDraftCommandReader()("row-1", "COL_ID_SCORE")).toEqual({
      hasDraft: true,
      value: 6,
    });
  });

  it("captures visible Accepted Overlay values ahead of drafts for edit commands", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    expect(runtime.start("row-1", "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("5")).toBe(true);
    runtime.acceptSave(
      "operation-1",
      [
        {
          rowId: row.id,
          baseRow: row,
          expectedVersion: 1n,
          changes: [
            {
              columnId: "COL_ID_SCORE",
              field: "score",
              before: row.score,
              after: 7,
            },
          ],
        },
      ],
      false,
    );
    const firstCommand = runtime.captureEditValueCommandReader();

    runtime.acceptSave(
      "operation-2",
      [
        {
          rowId: row.id,
          baseRow: row,
          expectedVersion: 1n,
          changes: [
            {
              columnId: "COL_ID_SCORE",
              field: "score",
              before: row.score,
              after: 8,
            },
          ],
        },
      ],
      false,
    );

    expect(firstCommand("row-1", "COL_ID_SCORE")).toEqual({
      hasEditValue: true,
      value: 7,
      presentationColumn: columns.find((column) => column.columnId === "COL_ID_SCORE"),
    });
    expect(runtime.captureEditValueCommandReader()("row-1", "COL_ID_SCORE")).toEqual({
      hasEditValue: true,
      value: 8,
      presentationColumn: columns.find((column) => column.columnId === "COL_ID_SCORE"),
    });
  });

  it("preserves compatible drafts across recompiles and prunes a changed value domain", () => {
    const compileTextColumns = () =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: "text",
          isEditable: true,
        },
      ]);
    const textColumns = compileTextColumns();
    const liveRow = { id: "row", value: "source" };
    const runtime = new BrunoTableCellEditRuntime({ columns: textColumns, getRow: () => liveRow });
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    expect(runtime.commit("draft")).toBe(true);

    runtime.reconcileColumns(compileTextColumns());
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBe("draft");

    runtime.reconcileColumns(
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "other",
          headerName: "Other",
          valueType: "text",
          isEditable: true,
        },
      ]),
    );
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();

    const capabilityRuntime = new BrunoTableCellEditRuntime({
      columns: textColumns,
      getRow: () => liveRow,
    });
    expect(capabilityRuntime.start("row", "COL_ID_VALUE")).toBe(true);
    expect(capabilityRuntime.commit("draft")).toBe(true);
    capabilityRuntime.reconcileColumns(
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: "text",
          isEditable: false,
        },
      ]),
    );
    expect(capabilityRuntime.getDraftSnapshot("row", "COL_ID_VALUE")).toBe("draft");
    expect(capabilityRuntime.getDraftReviewSnapshot()).toMatchObject([
      { mine: "draft", blockedReason: "This cell is no longer editable." },
    ]);

    runtime.reconcileColumns(
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: "number",
          isEditable: true,
        },
      ]),
    );
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();
  });

  it("retains Batch history while static column editability is revoked and restored", () => {
    const liveRow = { value: "source" };
    const compileTextColumns = (isEditable: boolean) =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: "text",
          isEditable,
        },
      ]);
    const getRow = vi.fn(() => liveRow);
    const runtime = new BrunoTableCellEditRuntime({
      columns: compileTextColumns(true),
      getRow,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    expect(runtime.commit("draft")).toBe(true);

    const memoryBeforeEquivalentRecompile = runtime.getDraftMemorySnapshot();
    const activity = vi.fn();
    const cell = vi.fn();
    const traversal = vi.fn();
    const unsubscribers = [
      runtime.subscribeActivity(activity),
      runtime.subscribeCell("row", "COL_ID_VALUE", cell),
      runtime.subscribeTraversalInvalidation(traversal),
    ];
    getRow.mockClear();
    runtime.reconcileColumns(compileTextColumns(true));
    expect(runtime.getDraftMemorySnapshot()).toBe(memoryBeforeEquivalentRecompile);
    expect(getRow).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(cell).not.toHaveBeenCalled();
    expect(traversal).not.toHaveBeenCalled();

    runtime.reconcileColumns(compileTextColumns(false));
    expect(getRow).toHaveBeenCalledOnce();
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBe("draft");
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 1,
      undoCount: 1,
      blockedCount: 1,
    });

    runtime.reconcileColumns(compileTextColumns(true));
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { mine: "draft", blockedReason: undefined },
    ]);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBe("draft");
    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  it("retains compatible Batch history across decoder and blank-policy recompiles", () => {
    type OptionalTextRow = Readonly<{ readonly value: string | null | undefined }>;
    const liveRow: OptionalTextRow = { value: "source" };
    const decoder = (input: unknown) =>
      typeof input === "string"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected text." } as const);
    const compileTextColumns = (decodeRuntime: typeof decoder, blankValue: null | undefined) => {
      const valueType: BrunoTableValueType<string> = {
        codecId: "test/history-recompile",
        codecVersion: 1,
        filterFamily: "text",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime,
        equivalent: Object.is,
        compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
        formatCanonicalText: String,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
        formatDisplay: String,
        encodePersisted: String,
        decodePersisted: decodeRuntime,
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType,
          isEditable: true,
          blankValue,
        },
      ] satisfies BrunoTableColumns<OptionalTextRow>);
    };

    for (const replacement of [
      compileTextColumns((input) => decoder(input), undefined),
      compileTextColumns(decoder, null),
    ]) {
      const runtime = new BrunoTableCellEditRuntime({
        columns: compileTextColumns(decoder, undefined),
        getRow: () => liveRow,
      });
      runtime.setBatchHistoryEnabled(true);
      expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
      expect(runtime.commit("draft")).toBe(true);

      runtime.reconcileColumns(replacement);
      expect(runtime.getActivitySnapshot()).toMatchObject({ undoCount: 1, redoCount: 0 });
      expect(runtime.undoBatchDraft()).toBe(true);
      expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();
      expect(runtime.redoBatchDraft()).toBe(true);
      expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBe("draft");
      runtime.dispose();
    }
  });

  it("migrates complete Conflict evidence through compatible column semantics", () => {
    type ConflictRow = Readonly<{ readonly value: string }>;
    const liveRow: ConflictRow = { value: "source-a" };
    const makeColumns = (suffix: "a" | "b") => {
      const decodeRuntime = (input: unknown) =>
        typeof input === "string"
          ? ({
              _tag: "Success",
              value: `${input.replace(/-[ab]$/, "")}-${suffix}`,
            } as const)
          : ({ _tag: "Failure", message: "Expected text." } as const);
      const valueType: BrunoTableValueType<string> = {
        codecId: `test/conflict-migration-${suffix}`,
        codecVersion: 1,
        filterFamily: "text",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime,
        equivalent: Object.is,
        compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
        formatCanonicalText: String,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
        formatDisplay: String,
        encodePersisted: String,
        decodePersisted: decodeRuntime,
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType,
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<ConflictRow>);
    };
    const runtime = new BrunoTableCellEditRuntime({
      columns: makeColumns("a"),
      getRow: () => liveRow,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: "row",
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: liveRow,
          expectedVersion: 1,
          base: "base-a",
          mine: "mine-a",
          conflict: { server: "server-a", serverVersion: 2, resolution: "mine" },
        },
      ]),
    ).toBe(true);

    runtime.reconcileColumns(makeColumns("b"));
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        base: "base-b",
        mine: "mine-b",
        conflict: { server: "server-b", serverVersion: 2, resolution: "mine" },
      },
    ]);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        base: "base-b",
        mine: "mine-b",
        conflict: { server: "server-b", resolution: "mine" },
      },
    ]);
  });

  it("prunes semantic convergence from current and redo-only history on column recompile", () => {
    type CanonicalRow = Readonly<{ readonly value: string }>;
    const liveRow: CanonicalRow = { value: "A" };
    const makeColumns = (canonicalize: boolean) => {
      const decodeRuntime = (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success", value: canonicalize ? input.toLowerCase() : input } as const)
          : ({ _tag: "Failure", message: "Expected text." } as const);
      const valueType: BrunoTableValueType<string> = {
        codecId: canonicalize ? "test/lowercase" : "test/identity",
        codecVersion: 1,
        filterFamily: "text",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime,
        equivalent: Object.is,
        compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
        formatCanonicalText: String,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
        formatDisplay: String,
        encodePersisted: String,
        decodePersisted: decodeRuntime,
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType,
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<CanonicalRow>);
    };

    for (const undoBeforeRecompile of [false, true]) {
      const runtime = new BrunoTableCellEditRuntime({
        columns: makeColumns(false),
        getRow: () => liveRow,
      });
      runtime.setBatchHistoryEnabled(true);
      expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
      expect(runtime.commit("a")).toBe(true);
      if (undoBeforeRecompile) expect(runtime.undoBatchDraft()).toBe(true);
      const cell = vi.fn();
      const traversal = vi.fn();
      const unsubscribeCell = runtime.subscribeCell("row", "COL_ID_VALUE", cell);
      const unsubscribeTraversal = runtime.subscribeTraversalInvalidation(traversal);

      runtime.reconcileColumns(makeColumns(true));

      expect(runtime.getDraftReviewSnapshot()).toHaveLength(0);
      expect(runtime.getActivitySnapshot()).toMatchObject({
        draftCount: 0,
        undoCount: 0,
        redoCount: 0,
      });
      expect(runtime.undoBatchDraft()).toBe(false);
      expect(runtime.redoBatchDraft()).toBe(false);
      if (undoBeforeRecompile) {
        expect(cell).not.toHaveBeenCalled();
        expect(traversal).not.toHaveBeenCalled();
      } else {
        expect(cell).toHaveBeenCalledOnce();
        expect(traversal).toHaveBeenCalledOnce();
      }
      unsubscribeCell();
      unsubscribeTraversal();
      runtime.dispose();
    }
  });

  it("releases retained Server resolution evidence when column reconciliation prunes its Batch lineage", () => {
    type CanonicalRow = Readonly<{ readonly value: string; readonly revision: number }>;
    let liveRow: CanonicalRow = { value: "A", revision: 1 };
    const makeColumns = (caseInsensitive: boolean) => {
      const decodeRuntime = (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success", value: caseInsensitive ? input.toLowerCase() : input } as const)
          : ({ _tag: "Failure", message: "Expected text." } as const);
      const valueType: BrunoTableValueType<string> = {
        codecId: caseInsensitive ? "test/resolution-lowercase" : "test/resolution-identity",
        codecVersion: 1,
        filterFamily: "text",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime,
        equivalent: Object.is,
        compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
        formatCanonicalText: String,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
        formatDisplay: String,
        encodePersisted: String,
        decodePersisted: decodeRuntime,
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType,
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<CanonicalRow>);
    };
    const runtime = new BrunoTableCellEditRuntime({
      columns: makeColumns(false),
      getRow: () => liveRow,
      getRowVersion: (candidate) => (candidate as CanonicalRow).revision,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    expect(runtime.commit("a")).toBe(true);
    liveRow = { value: "B", revision: 2 };
    runtime.reconcileSourceRows(new Set(["row"]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "server",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    const published = vi.fn();
    const unsubscribe = runtime.subscribeRetainedResolutionPublication(published);
    liveRow = { value: "A", revision: 3 };

    runtime.reconcileColumns(makeColumns(true));

    expect(published).toHaveBeenCalledOnce();
    expect([...runtime.getRetainedResolutionPublicationSnapshot()]).toEqual([conflict.id]);
    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(0);
    expect(runtime.getActivitySnapshot()).toMatchObject({ undoCount: 0, redoCount: 0 });
    expect(runtime.reopenResolvedConflicts([conflict.id])).toBe(false);
    unsubscribe();
  });

  it("prunes a draft that becomes semantically equal to its Base on column recompile", () => {
    type CanonicalRow = Readonly<{ readonly value: string }>;
    const liveRow: CanonicalRow = { value: "B" };
    const decodeRuntime = (input: unknown) =>
      typeof input === "string"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected text." } as const);
    const makeColumns = (caseInsensitive: boolean) =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: {
            codecId: "test/base-equivalence-convergence",
            codecVersion: 1,
            filterFamily: "text",
            editorFamily: "text",
            cellAlign: "start",
            editorLayout: "inline",
            defaultWidth: 120,
            decodeRuntime,
            equivalent: caseInsensitive
              ? (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
              : Object.is,
            compare: (left: string, right: string) => (left === right ? 0 : left < right ? -1 : 1),
            formatCanonicalText: String,
            parseCanonicalText: (text: string) => ({ _tag: "Success", value: text }) as const,
            formatDisplay: String,
            encodePersisted: String,
            decodePersisted: decodeRuntime,
          },
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<CanonicalRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: makeColumns(false),
      getRow: () => liveRow,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: "row",
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: { value: "A" },
          expectedVersion: 1,
          base: "A",
          mine: "a",
        },
      ]),
    ).toBe(true);

    runtime.reconcileColumns(makeColumns(true));

    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      undoCount: 0,
      redoCount: 0,
    });
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(0);
    expect(runtime.undoBatchDraft()).toBe(false);
    runtime.dispose();
  });

  it("publishes equivalence-only redo convergence and removes its retained dependency", () => {
    type CanonicalRow = Readonly<{ readonly value: string }>;
    const rows = new Map<string, CanonicalRow>([
      ["drop", { value: "B" }],
      ["keep", { value: "source" }],
    ]);
    const decodeRuntime = (input: unknown) =>
      typeof input === "string"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected text." } as const);
    const makeColumns = (caseInsensitive: boolean) => {
      const valueType: BrunoTableValueType<string> = {
        codecId: "test/equivalence-only-convergence",
        codecVersion: 1,
        filterFamily: "text",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime,
        equivalent: caseInsensitive
          ? (left, right) => left.toLowerCase() === right.toLowerCase()
          : Object.is,
        compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
        formatCanonicalText: String,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
        formatDisplay: String,
        encodePersisted: String,
        decodePersisted: decodeRuntime,
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType,
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<CanonicalRow>);
    };
    const getRow = vi.fn((rowId: string) => rows.get(rowId));
    const runtime = new BrunoTableCellEditRuntime({
      columns: makeColumns(false),
      getRow,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: "drop",
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: { value: "A" },
          expectedVersion: 1,
          base: "A",
          mine: "a",
        },
        {
          rowId: "keep",
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rows.get("keep")!,
          expectedVersion: 1,
          base: "source",
          mine: "draft",
        },
      ]),
    ).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);
    const cell = vi.fn();
    const traversal = vi.fn();
    const unsubscribers = [
      runtime.subscribeCell("drop", "COL_ID_VALUE", cell),
      runtime.subscribeTraversalInvalidation(traversal),
    ];

    runtime.reconcileColumns(makeColumns(true));

    expect(runtime.getActivitySnapshot()).toMatchObject({ redoCount: 1 });
    expect(cell).not.toHaveBeenCalled();
    expect(traversal).not.toHaveBeenCalled();
    getRow.mockClear();
    runtime.reconcileSourceRows(new Set(["drop"]));
    expect(getRow).not.toHaveBeenCalled();
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot("drop", "COL_ID_VALUE")).toBeUndefined();
    expect(runtime.getDraftSnapshot("keep", "COL_ID_VALUE")).toBe("draft");
    for (const unsubscribe of unsubscribers) unsubscribe();

    const singleRuntime = new BrunoTableCellEditRuntime({
      columns: makeColumns(false),
      getRow: () => rows.get("drop"),
    });
    singleRuntime.setBatchHistoryEnabled(true);
    expect(
      singleRuntime.applyAcceptedDraftGesture([
        {
          rowId: "drop",
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: { value: "A" },
          expectedVersion: 1,
          base: "A",
          mine: "a",
        },
      ]),
    ).toBe(true);
    expect(singleRuntime.undoBatchDraft()).toBe(true);
    const activity = vi.fn();
    const singleCell = vi.fn();
    const singleTraversal = vi.fn();
    const singleUnsubscribers = [
      singleRuntime.subscribeActivity(activity),
      singleRuntime.subscribeCell("drop", "COL_ID_VALUE", singleCell),
      singleRuntime.subscribeTraversalInvalidation(singleTraversal),
    ];
    singleRuntime.reconcileColumns(makeColumns(true));
    expect(singleRuntime.getActivitySnapshot()).toMatchObject({ redoCount: 0 });
    expect(singleRuntime.redoBatchDraft()).toBe(false);
    expect(activity).toHaveBeenCalledOnce();
    expect(singleCell).not.toHaveBeenCalled();
    expect(singleTraversal).not.toHaveBeenCalled();
    for (const unsubscribe of singleUnsubscribers) unsubscribe();
  });

  it("partially migrates one multi-cell command with one coherent publication", () => {
    type MigrationRow = Readonly<{ readonly value: string }>;
    const rows = new Map<string, MigrationRow>([
      ["drop", { value: "source-drop-a" }],
      ["keep", { value: "source-keep-a" }],
    ]);
    const makeColumns = (migrate: boolean) => {
      const decodeRuntime = (input: unknown) => {
        if (typeof input !== "string" || (migrate && input.startsWith("reject"))) {
          return { _tag: "Failure", message: "Rejected." } as const;
        }
        return {
          _tag: "Success",
          value: migrate ? `${input.replace(/-[ab]$/, "")}-b` : input,
        } as const;
      };
      const valueType: BrunoTableValueType<string> = {
        codecId: migrate ? "test/partial-b" : "test/partial-a",
        codecVersion: 1,
        filterFamily: "text",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime,
        equivalent: Object.is,
        compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
        formatCanonicalText: String,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
        formatDisplay: String,
        encodePersisted: String,
        decodePersisted: decodeRuntime,
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType,
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<MigrationRow>);
    };
    const runtime = new BrunoTableCellEditRuntime({
      columns: makeColumns(false),
      getRow: (rowId) => rows.get(rowId),
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: "drop",
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rows.get("drop")!,
          expectedVersion: 1,
          base: "base-drop-a",
          mine: "mine-drop-a",
          conflict: { server: "reject-a", serverVersion: 2 },
        },
        {
          rowId: "keep",
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: rows.get("keep")!,
          expectedVersion: 1,
          base: "base-keep-a",
          mine: "mine-keep-a",
        },
      ]),
    ).toBe(true);
    runtime.getDraftReviewSnapshot();
    const activity = vi.fn();
    const review = vi.fn();
    const traversal = vi.fn();
    const droppedCell = vi.fn();
    const keptCell = vi.fn();
    const unsubscribers = [
      runtime.subscribeActivity(activity),
      runtime.subscribeDraftReview(review),
      runtime.subscribeTraversalInvalidation(traversal),
      runtime.subscribeCell("drop", "COL_ID_VALUE", droppedCell),
      runtime.subscribeCell("keep", "COL_ID_VALUE", keptCell),
    ];

    runtime.reconcileColumns(makeColumns(true));

    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { rowId: "keep", base: "base-keep-b", mine: "mine-keep-b" },
    ]);
    expect(activity).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
    expect(traversal).toHaveBeenCalledOnce();
    expect(droppedCell).toHaveBeenCalledOnce();
    expect(keptCell).toHaveBeenCalledOnce();
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot("drop", "COL_ID_VALUE")).toBeUndefined();
    expect(runtime.getDraftSnapshot("keep", "COL_ID_VALUE")).toBeUndefined();
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot("drop", "COL_ID_VALUE")).toBeUndefined();
    expect(runtime.getDraftSnapshot("keep", "COL_ID_VALUE")).toBe("mine-keep-b");
    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  it("preserves nullish blank drafts only across an unchanged explicit blank policy", () => {
    type NullableRow = Readonly<{
      readonly id: string;
      readonly value: number | null | undefined;
    }>;
    const liveRow: NullableRow = { id: "nullable", value: 1 };
    const customNumberValueType = (): BrunoTableValueType<number> => ({
      codecId: "test/non-null-number",
      codecVersion: 1,
      filterFamily: "numeric",
      editorFamily: "number",
      cellAlign: "end",
      editorLayout: "inline",
      defaultWidth: 100,
      decodeRuntime: (input) =>
        typeof input === "number"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected a non-null number." },
      equivalent: Object.is,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: String,
      parseCanonicalText: (text) => ({ _tag: "Success", value: Number(text) }),
      formatDisplay: String,
      encodePersisted: (value) => value,
      decodePersisted: (input) =>
        typeof input === "number"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected a persisted number." },
    });
    const compileNullableColumns = (blankValue: null | undefined) =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: customNumberValueType(),
          isEditable: true,
          blankValue,
        },
      ] satisfies BrunoTableColumns<NullableRow>);

    for (const blankValue of [null, undefined] as const) {
      const runtime = new BrunoTableCellEditRuntime({
        columns: compileNullableColumns(blankValue),
        getRow: () => liveRow,
      });
      expect(runtime.start("nullable", "COL_ID_VALUE")).toBe(true);
      expect(runtime.commit("", false, "blank")).toBe(true);
      expect(runtime.getCellSnapshot("nullable", "COL_ID_VALUE")).toMatchObject({
        hasDraft: true,
        draft: blankValue,
      });

      runtime.reconcileColumns(compileNullableColumns(blankValue));
      expect(runtime.getCellSnapshot("nullable", "COL_ID_VALUE")).toMatchObject({
        hasDraft: true,
        draft: blankValue,
      });
      expect(runtime.captureDraftCommandReader()("nullable", "COL_ID_VALUE")).toEqual({
        hasDraft: true,
        value: blankValue,
      });

      runtime.reconcileColumns(compileNullableColumns(blankValue === null ? undefined : null));
      expect(runtime.getCellSnapshot("nullable", "COL_ID_VALUE")).toMatchObject({
        hasDraft: false,
      });
      runtime.dispose();

      const removedPolicyRuntime = new BrunoTableCellEditRuntime({
        columns: compileNullableColumns(blankValue),
        getRow: () => liveRow,
      });
      expect(removedPolicyRuntime.start("nullable", "COL_ID_VALUE")).toBe(true);
      expect(removedPolicyRuntime.commit("", false, "blank")).toBe(true);
      removedPolicyRuntime.reconcileColumns(
        compileColumns([
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            headerName: "Value",
            valueType: customNumberValueType(),
            isEditable: false,
          },
        ] satisfies BrunoTableColumns<NullableRow>),
      );
      expect(removedPolicyRuntime.getCellSnapshot("nullable", "COL_ID_VALUE")).toMatchObject({
        hasDraft: false,
      });
      removedPolicyRuntime.dispose();
    }

    const compileBuiltInColumns = (blankValue: null | undefined) =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: "number",
          isEditable: true,
          blankValue,
        },
      ] satisfies BrunoTableColumns<NullableRow>);
    const stableAuthorityRuntime = new BrunoTableCellEditRuntime({
      columns: compileBuiltInColumns(null),
      getRow: () => liveRow,
    });
    expect(stableAuthorityRuntime.start("nullable", "COL_ID_VALUE")).toBe(true);
    expect(stableAuthorityRuntime.commit("", false, "blank")).toBe(true);
    stableAuthorityRuntime.reconcileColumns(compileBuiltInColumns(null));
    expect(stableAuthorityRuntime.getDraftSnapshot("nullable", "COL_ID_VALUE")).toBe(null);
    stableAuthorityRuntime.reconcileColumns(compileBuiltInColumns(undefined));
    expect(stableAuthorityRuntime.getCellSnapshot("nullable", "COL_ID_VALUE")).toMatchObject({
      hasDraft: false,
    });
    stableAuthorityRuntime.dispose();
  });

  it("prunes drafts when a recompiled runtime decoder throws or returns malformed evidence", () => {
    const compileTextColumns = () =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: "text",
          isEditable: true,
        },
      ]);
    const liveRow = { value: "source" };
    const hostileValueType = (mode: "throw" | "malformed"): BrunoTableValueType<string> => ({
      codecId: `test/hostile-recompile-${mode}`,
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: () => {
        if (mode === "throw") throw new Error("decoder escaped");
        return { nope: true } as never;
      },
      equivalent: Object.is,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: String,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: String,
      encodePersisted: String,
      decodePersisted: (input) => ({ _tag: "Success", value: String(input) }),
    });

    for (const mode of ["throw", "malformed"] as const) {
      const runtime = new BrunoTableCellEditRuntime({
        columns: compileTextColumns(),
        getRow: () => liveRow,
      });
      expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
      expect(runtime.commit("draft")).toBe(true);

      expect(() =>
        runtime.reconcileColumns(
          compileColumns([
            {
              columnId: "COL_ID_VALUE",
              field: "value",
              headerName: "Value",
              valueType: hostileValueType(mode),
              isEditable: true,
            },
          ]),
        ),
      ).not.toThrow();
      expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();
    }
  });

  it("rebinds an active invalid session across an equivalent column recompile", () => {
    const compileValidatedColumns = () =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: "text",
          isEditable: true,
          validate: ({ value }: { readonly value: string }) =>
            value === "invalid" ? "Invalid value." : undefined,
        },
      ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: compileValidatedColumns(),
      getRow: () => ({ value: "source" }),
    });
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    runtime.updateActiveCandidate("invalid", false);
    expect(runtime.commit("invalid")).toBe(false);

    runtime.reconcileColumns(compileValidatedColumns());

    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      columnId: "COL_ID_VALUE",
      invalidMessage: "Invalid value.",
    });
    expect(runtime.getActiveCandidateSnapshot()).toEqual({
      kind: "scalar",
      rawText: "invalid",
      nativeInvalid: false,
    });
  });

  it("cancels active candidates before an edit-facing column recompile can reinterpret them", () => {
    type OptionalRow = Readonly<{ readonly value: string | null | undefined }>;
    const decodeRuntime = (input: unknown) =>
      typeof input === "string" || input == null
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected nullable text." } as const);
    const formatCanonicalText = (value: string | null | undefined) => value ?? "";
    const parseText = (text: string) => ({ _tag: "Success", value: text }) as const;
    const parseUpper = (text: string) => ({ _tag: "Success", value: text.toUpperCase() }) as const;
    const valueType = (
      parseCanonicalText: typeof parseText,
      editorFamily: "text" | "number" = "text",
    ) => ({
      codecId: "test/active-session-authority",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily,
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime,
      equivalent: Object.is,
      compare: () => 0 as const,
      formatCanonicalText,
      parseCanonicalText,
      formatDisplay: formatCanonicalText,
      encodePersisted: (value: string | null | undefined) => value ?? null,
      decodePersisted: decodeRuntime,
    });
    const compileOptional = (blankValue: null | undefined, parseCanonicalText = parseText) =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: valueType(parseCanonicalText),
          isEditable: true,
          blankValue,
        },
      ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: compileOptional(null),
      getRow: (): OptionalRow => ({ value: null }),
    });

    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    runtime.updateActiveCandidate("", false, "blank");
    runtime.reconcileColumns(compileOptional(undefined));
    expect(runtime.getSessionSnapshot()).toEqual({ kind: "idle" });

    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    runtime.updateActiveCandidate("candidate", false);
    runtime.reconcileColumns(compileOptional(undefined, parseUpper));
    expect(runtime.getSessionSnapshot()).toEqual({ kind: "idle" });

    const familyRuntime = new BrunoTableCellEditRuntime({
      columns: compileOptional(undefined),
      getRow: (): OptionalRow => ({ value: "source" }),
    });
    expect(familyRuntime.start("row", "COL_ID_VALUE")).toBe(true);
    familyRuntime.reconcileColumns(
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: valueType(parseText, "number"),
          isEditable: true,
          blankValue: undefined,
        },
      ]),
    );
    expect(familyRuntime.getSessionSnapshot()).toEqual({ kind: "idle" });

    type SelectRow = Readonly<{ readonly choice: "a" | "b" | "c" }>;
    const compileSelect = (changed: boolean) =>
      changed
        ? compileColumns([
            BrunoTableSelectColumn({
              columnId: "COL_ID_CHOICE",
              field: "choice",
              headerName: "Choice",
              options: ["a", "c", "b"],
              isEditable: true,
            }),
          ] satisfies BrunoTableColumns<SelectRow>)
        : compileColumns([
            BrunoTableSelectColumn({
              columnId: "COL_ID_CHOICE",
              field: "choice",
              headerName: "Choice",
              options: ["a", "b", "c"],
              isEditable: true,
            }),
          ] satisfies BrunoTableColumns<SelectRow>);
    const selectRuntime = new BrunoTableCellEditRuntime({
      columns: compileSelect(false),
      getRow: (): SelectRow => ({ choice: "a" }),
    });
    expect(selectRuntime.start("row", "COL_ID_CHOICE")).toBe(true);
    selectRuntime.updateActiveCandidate("a", false);
    selectRuntime.reconcileColumns(compileSelect(false));
    expect(selectRuntime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      columnId: "COL_ID_CHOICE",
    });
    expect(selectRuntime.getActiveCandidateSnapshot()).toMatchObject({ rawText: "a" });
    selectRuntime.reconcileColumns(compileSelect(true));
    expect(selectRuntime.getSessionSnapshot()).toEqual({ kind: "idle" });

    type ToggleRow = Readonly<{ readonly toggle: "N" | "Y" }>;
    const decodeToggle = (input: unknown) =>
      input === "N" || input === "Y"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected N or Y." } as const);
    const formatToggle = (value: "N" | "Y") => value;
    const parseToggle = (text: string) => decodeToggle(text);
    const compileToggle = (booleanEditorValues: readonly ["N" | "Y", "N" | "Y"]) =>
      compileColumns([
        {
          columnId: "COL_ID_TOGGLE",
          field: "toggle",
          headerName: "Toggle",
          valueType: {
            codecId: "test/toggle-session-authority",
            codecVersion: 1,
            filterFamily: "equality",
            editorFamily: "boolean",
            booleanEditorValues,
            cellAlign: "center",
            editorLayout: "center",
            defaultWidth: 88,
            decodeRuntime: decodeToggle,
            equivalent: Object.is,
            compare: () => 0 as const,
            formatCanonicalText: formatToggle,
            parseCanonicalText: parseToggle,
            formatDisplay: formatToggle,
            encodePersisted: formatToggle,
            decodePersisted: decodeToggle,
          },
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<ToggleRow>);
    const toggleRuntime = new BrunoTableCellEditRuntime({
      columns: compileToggle(["N", "Y"]),
      getRow: (): ToggleRow => ({ toggle: "N" }),
    });
    expect(toggleRuntime.start("row", "COL_ID_TOGGLE")).toBe(true);
    toggleRuntime.reconcileColumns(compileToggle(["N", "Y"]));
    expect(toggleRuntime.getSessionSnapshot()).toMatchObject({ kind: "editing" });
    toggleRuntime.reconcileColumns(compileToggle(["Y", "N"]));
    expect(toggleRuntime.getSessionSnapshot()).toEqual({ kind: "idle" });
  });

  it("blocks an active commit while dynamic edit permission is denied and recovers in place", () => {
    type PermissionRow = Readonly<{ readonly value: string; readonly allowed: boolean }>;
    let liveRow: PermissionRow = { value: "source", allowed: true };
    const compilePermissionColumns = (
      predicate: (context: { readonly row: PermissionRow; readonly value: string }) => boolean,
    ) =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: "text",
          isEditable: predicate,
        },
      ]);
    const sourcePolicy = vi.fn(
      ({ row: candidateRow, value }: { readonly row: PermissionRow; readonly value: string }) =>
        candidateRow.allowed && value !== "locked",
    );
    const runtime = new BrunoTableCellEditRuntime({
      columns: compilePermissionColumns(sourcePolicy),
      getRow: () => liveRow,
    });
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    runtime.updateActiveCandidate("candidate", false);

    const sessionSubscriber = vi.fn();
    const unsubscribe = runtime.subscribeSession(sessionSubscriber);
    sourcePolicy.mockClear();
    runtime.reconcileActiveRow(new Set(["unrelated"]));
    expect(sourcePolicy).not.toHaveBeenCalled();
    expect(sessionSubscriber).not.toHaveBeenCalled();

    liveRow = { value: "locked", allowed: true };
    runtime.reconcileActiveRow(new Set(["row"]));
    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      invalidMessage: "This cell is no longer editable.",
    });
    expect(runtime.commit("candidate")).toBe(false);
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();

    liveRow = { value: "source", allowed: true };
    runtime.reconcileActiveRow();
    expect(runtime.getSessionSnapshot()).toMatchObject({ kind: "editing" });
    expect(runtime.getSessionSnapshot()).not.toHaveProperty("invalidMessage");

    runtime.reconcileColumns(compilePermissionColumns(() => false));
    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      invalidMessage: "This cell is no longer editable.",
    });
    runtime.reconcileColumns(
      compilePermissionColumns(() => {
        throw new Error("policy failed");
      }),
    );
    expect(runtime.commit("candidate")).toBe(false);
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();

    runtime.reconcileColumns(compilePermissionColumns(() => true));
    expect(runtime.getSessionSnapshot()).not.toHaveProperty("invalidMessage");
    expect(runtime.commit("candidate")).toBe(true);
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBe("candidate");

    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    runtime.reconcileColumns(compilePermissionColumns(({ value }) => value === "candidate"));
    liveRow = { value: "locked", allowed: true };
    runtime.reconcileActiveRow();
    expect(runtime.getSessionSnapshot()).not.toHaveProperty("invalidMessage");
    unsubscribe();
  });

  it("clears a row-missing overlay on identity return and reveals prior validation", () => {
    let liveRow: Row | undefined = row;
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => liveRow });
    expect(runtime.start("row-1", "COL_ID_QUANTITY")).toBe(true);
    expect(runtime.commit("not-an-integer")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      invalidMessage: "Expected signed base-10 integer digits.",
    });

    liveRow = undefined;
    runtime.reconcileActiveRow();
    expect(runtime.commit("not-an-integer")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      rowMissing: true,
      invalidMessage: "Expected signed base-10 integer digits.",
    });

    liveRow = row;
    runtime.reconcileActiveRow();
    expect(runtime.getSessionSnapshot()).toMatchObject({
      rowMissing: false,
      invalidMessage: "Expected signed base-10 integer digits.",
    });
  });

  it("does not create a draft for an untouched candidate after a live source change", () => {
    type TextRow = Readonly<{ readonly value: string }>;
    let liveRow: TextRow = { value: "A" };
    const onCommit = vi.fn();
    const textColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<TextRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: textColumns,
      getRow: () => liveRow,
      onCommit,
    });
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    liveRow = { value: "B" };
    runtime.reconcileActiveRow(new Set(["row"]));
    expect(runtime.commit("A")).toBe(true);
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();
    expect(onCommit).not.toHaveBeenCalled();

    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    expect(runtime.commit("C")).toBe(true);
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBe("C");
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("records a draft-backed revert to the canonical source value", () => {
    type TextRow = Readonly<{ readonly value: string }>;
    const liveRow: TextRow = { value: "A" };
    const onCommit = vi.fn();
    const textColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<TextRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: textColumns,
      getRow: () => liveRow,
      onCommit,
    });
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    expect(runtime.commit("C")).toBe(true);
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBe("C");
    onCommit.mockClear();

    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    expect(runtime.commit("A")).toBe(true);
    expect(runtime.getDraftSnapshot("row", "COL_ID_VALUE")).toBeUndefined();
    expect(onCommit).toHaveBeenCalledWith({
      rowId: "row",
      columnId: "COL_ID_VALUE",
      field: "value",
      before: "C",
      after: "A",
    });
  });

  it("rejects Boolean editor admission when the canonical value is outside its mapping", () => {
    type ToggleRow = Readonly<{ readonly toggle: "M" | "N" | "Y" }>;
    let liveRow: ToggleRow = { toggle: "M" };
    const decodeToggle = (input: unknown) =>
      input === "M" || input === "N" || input === "Y"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected M, N, or Y." } as const);
    const toggleColumns = compileColumns([
      {
        columnId: "COL_ID_TOGGLE",
        field: "toggle",
        headerName: "Toggle",
        valueType: {
          codecId: "test/three-state-toggle",
          codecVersion: 1,
          filterFamily: "equality",
          editorFamily: "boolean",
          booleanEditorValues: ["N", "Y"],
          cellAlign: "center",
          editorLayout: "center",
          defaultWidth: 88,
          decodeRuntime: decodeToggle,
          equivalent: Object.is,
          compare: () => 0 as const,
          formatCanonicalText: (value: ToggleRow["toggle"]) => value,
          parseCanonicalText: decodeToggle,
          formatDisplay: (value: ToggleRow["toggle"]) => value,
          encodePersisted: (value: ToggleRow["toggle"]) => value,
          decodePersisted: decodeToggle,
        },
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<ToggleRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: toggleColumns,
      getRow: () => liveRow,
    });
    expect(runtime.start("row", "COL_ID_TOGGLE")).toBe(false);
    liveRow = { toggle: "N" };
    expect(runtime.start("row", "COL_ID_TOGGLE")).toBe(true);
    liveRow = { toggle: "M" };
    runtime.reconcileActiveRow(new Set(["row"]));
    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      invalidMessage: "This cell is no longer editable.",
    });
  });

  it("skips unmapped Boolean values during traversal and reconciles live mapping changes", () => {
    type ToggleRow = Readonly<{ readonly id: string; readonly toggle: "M" | "N" | "Y" }>;
    const decodeToggle = (input: unknown) =>
      input === "M" || input === "N" || input === "Y"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected M, N, or Y." } as const);
    const formatToggle = (value: ToggleRow["toggle"]) => value;
    const makeColumns = (
      booleanEditorValues: readonly [ToggleRow["toggle"], ToggleRow["toggle"]],
    ) =>
      compileColumns([
        {
          columnId: "COL_ID_TOGGLE",
          field: "toggle",
          headerName: "Toggle",
          valueType: {
            codecId: "test/traversal-three-state-toggle",
            codecVersion: 1,
            filterFamily: "equality",
            editorFamily: "boolean",
            booleanEditorValues,
            cellAlign: "center",
            editorLayout: "center",
            defaultWidth: 88,
            decodeRuntime: decodeToggle,
            equivalent: Object.is,
            compare: () => 0 as const,
            formatCanonicalText: formatToggle,
            parseCanonicalText: decodeToggle,
            formatDisplay: formatToggle,
            encodePersisted: formatToggle,
            decodePersisted: decodeToggle,
          },
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<ToggleRow>);
    const rows = new Map<string, ToggleRow>([
      ["mapped-start", { id: "mapped-start", toggle: "N" }],
      ["unmapped", { id: "unmapped", toggle: "M" }],
      ["mapped-end", { id: "mapped-end", toggle: "Y" }],
    ]);
    const columns = makeColumns(["N", "Y"]);
    const rowIds = [...rows.keys()];
    const rowSpace = {
      totalRows: rowIds.length,
      getRowId: (rowIndex: number) => rowIds[rowIndex],
    };
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
    });
    expect(runtime.isEditable("mapped-start", "COL_ID_TOGGLE")).toBe(true);
    expect(runtime.isEditable("unmapped", "COL_ID_TOGGLE")).toBe(false);
    expect(runtime.isEditable("mapped-end", "COL_ID_TOGGLE")).toBe(true);
    runtime.reconcileTraversal(columns, rowSpace);
    expect(runtime.findTraversalDestination(0, "COL_ID_TOGGLE", 1)?.rowId).toBe("mapped-end");
    expect(runtime.findTraversalDestination(2, "COL_ID_TOGGLE", -1)?.rowId).toBe("mapped-start");

    rows.set("unmapped", { id: "unmapped", toggle: "N" });
    runtime.reconcileTraversalRows(new Set(["unmapped"]));
    expect(runtime.findTraversalDestination(0, "COL_ID_TOGGLE", 1)?.rowId).toBe("unmapped");

    rows.set("unmapped", { id: "unmapped", toggle: "M" });
    runtime.reconcileTraversalRows(new Set(["unmapped"]));
    const remappedColumns = makeColumns(["M", "Y"]);
    runtime.reconcileColumns(remappedColumns);
    runtime.reconcileTraversal(remappedColumns, rowSpace);
    expect(runtime.findTraversalDestination(0, "COL_ID_TOGGLE", 1)?.rowId).toBe("unmapped");
  });

  it("rotates canonical source caches when decoder authority changes", () => {
    type CanonicalRow = Readonly<{ readonly value: string }>;
    type Decoder = (
      input: unknown,
    ) => Readonly<{ readonly _tag: "Success"; readonly value: string }>;
    const row: CanonicalRow = { value: "raw" };
    const decodeA = vi.fn<Decoder>(() => ({ _tag: "Success", value: "allow" }));
    const decodeB = vi.fn<Decoder>(() => ({ _tag: "Success", value: "deny" }));
    const makeColumns = (decodeRuntime: Decoder) => {
      const valueType: BrunoTableValueType<string> = {
        codecId: "test/cache-generation",
        codecVersion: 1,
        filterFamily: "equality",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime,
        equivalent: Object.is,
        compare: () => 0 as const,
        formatCanonicalText: (value) => value,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
        formatDisplay: (value) => value,
        encodePersisted: (value) => value,
        decodePersisted: decodeRuntime,
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType,
          isEditable: ({ value }: { readonly value: string }) => value === "allow",
        },
      ] satisfies BrunoTableColumns<CanonicalRow>);
    };
    const columnsA = makeColumns(decodeA);
    const runtime = new BrunoTableCellEditRuntime({ columns: columnsA, getRow: () => row });
    expect(runtime.isEditable("row", "COL_ID_VALUE")).toBe(true);
    expect(runtime.isEditable("row", "COL_ID_VALUE")).toBe(true);
    expect(decodeA).toHaveBeenCalledOnce();

    runtime.reconcileColumns(makeColumns(decodeB));
    expect(runtime.isEditable("row", "COL_ID_VALUE")).toBe(false);
    expect(decodeB).toHaveBeenCalledOnce();

    runtime.reconcileColumns(columnsA);
    expect(runtime.isEditable("row", "COL_ID_VALUE")).toBe(true);
    expect(decodeA).toHaveBeenCalledTimes(2);
  });

  it("re-decodes both Base and Mine when decoder authority changes", () => {
    type CanonicalRow = Readonly<{ readonly value: string }>;
    const makeColumns = (suffix: string, rejectBase = false) => {
      const decodeRuntime = (input: unknown) =>
        rejectBase && String(input).startsWith("base")
          ? ({ _tag: "Failure", message: "rejected" } as const)
          : ({
              _tag: "Success",
              value: `${String(input).replace(/-[ab]$/, "")}-${suffix}`,
            } as const);
      const valueType: BrunoTableValueType<string> = {
        codecId: `test/redecode-${suffix}`,
        codecVersion: 1,
        filterFamily: "equality",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime,
        equivalent: Object.is,
        compare: () => 0 as const,
        formatCanonicalText: (value) => value,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
        formatDisplay: (value) => value,
        encodePersisted: (value) => value,
        decodePersisted: decodeRuntime,
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType,
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<CanonicalRow>);
    };
    const runtime = new BrunoTableCellEditRuntime({
      columns: makeColumns("a"),
      getRow: () => ({ value: "server-a" }),
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: "row",
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: { value: "base-a" },
          expectedVersion: 1,
          base: "base-a",
          mine: "mine-a",
        },
      ]),
    ).toBe(true);

    runtime.reconcileColumns(makeColumns("b"));
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({ base: "base-b", mine: "mine-b" });

    runtime.reconcileColumns(makeColumns("c", true));
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(0);
  });

  it("migrates retained Server-resolution evidence before publishing decoder changes", () => {
    type DecoderRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly revision: bigint;
    }>;
    const makeColumns = (suffix: "a" | "b") => {
      const decodeRuntime = (input: unknown) =>
        ({
          _tag: "Success",
          value: `${String(input).replace(/-[ab]$/, "")}-${suffix}`,
        }) as const;
      const valueType: BrunoTableValueType<string> = {
        codecId: `test/retained-resolution-${suffix}`,
        codecVersion: 1,
        filterFamily: "equality",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime,
        equivalent: Object.is,
        compare: (left, right) => (left < right ? -1 : left > right ? 1 : 0),
        formatCanonicalText: (value) => value,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
        formatDisplay: (value) => value,
        encodePersisted: (value) => value,
        decodePersisted: decodeRuntime,
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType,
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<DecoderRow>);
    };
    let current: DecoderRow = Object.freeze({
      id: "row-decoder",
      value: "base",
      revision: 1n,
    });
    const runtime = new BrunoTableCellEditRuntime({
      columns: makeColumns("a"),
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as DecoderRow).revision,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: current.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: current,
          expectedVersion: current.revision,
          base: "base-a",
          mine: "mine-a",
        },
      ]),
    ).toBe(true);
    current = Object.freeze({ ...current, value: "server", revision: 2n });
    runtime.reconcileSourceRows(new Set([current.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "server",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    const published = vi.fn();
    const unsubscribe = runtime.subscribeRetainedResolutionPublication(published);

    runtime.reconcileColumns(makeColumns("b"));

    expect(published).toHaveBeenCalledOnce();
    expect([...runtime.getRetainedResolutionPublicationSnapshot()]).toEqual([conflict.id]);
    expect([...runtime.reconcileResolvedConflictIds([conflict.id])]).toEqual([conflict.id]);
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
      base: "base-b",
      mine: "mine-b",
      conflict: { server: "server-b", serverVersion: 2n },
    });
    unsubscribe();
  });

  it("drops a draft when a replacement runtime decoder throws", () => {
    type CanonicalRow = Readonly<{ readonly value: string }>;
    const makeColumns = (throws: boolean) => {
      const decodeRuntime = (input: unknown) => {
        if (throws) throw new Error("consumer decoder escaped");
        return { _tag: "Success", value: String(input) } as const;
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: {
            codecId: throws ? "test/throwing-decoder" : "test/stable-decoder",
            codecVersion: 1,
            filterFamily: "text",
            editorFamily: "text",
            cellAlign: "start",
            editorLayout: "inline",
            defaultWidth: 120,
            decodeRuntime,
            equivalent: Object.is,
            compare: () => 0 as const,
            formatCanonicalText: String,
            parseCanonicalText: (text: string) => ({ _tag: "Success", value: text }) as const,
            formatDisplay: String,
            encodePersisted: String,
            decodePersisted: decodeRuntime,
          },
          isEditable: true,
        },
      ] satisfies BrunoTableColumns<CanonicalRow>);
    };
    const source: CanonicalRow = { value: "base" };
    const runtime = new BrunoTableCellEditRuntime({
      columns: makeColumns(false),
      getRow: () => source,
    });
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    expect(runtime.commit("mine")).toBe(true);

    expect(() => runtime.reconcileColumns(makeColumns(true))).not.toThrow();
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(0);
  });

  it("reuses retained invalid-candidate evidence while Reset Review is observed", () => {
    type ValidatedRow = Readonly<{ readonly value: number }>;
    const validate = vi.fn(({ value }: { readonly value: number }) =>
      value <= 10 ? undefined : "Too large.",
    );
    const validatedColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "number",
        isEditable: true,
        validate,
      },
    ] satisfies BrunoTableColumns<ValidatedRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: validatedColumns,
      getRow: () => ({ value: 4 }),
    });
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    runtime.updateActiveCandidate("11", false);
    expect(runtime.commit("11")).toBe(false);
    expect(validate).toHaveBeenCalledOnce();

    const unsubscribe = runtime.subscribeDraftReview(vi.fn());

    expect(validate).toHaveBeenCalledOnce();
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { candidateText: "11", candidateInvalid: true, status: "Too large." },
    ]);
    unsubscribe();
  });

  it("projects retained native-invalid and source-blocking candidate evidence", () => {
    type CandidateRow = Readonly<{ readonly value: number }>;
    let current: CandidateRow | undefined = { value: 4 };
    const validate = vi.fn(() => undefined);
    const candidateColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "number",
        isEditable: ({ value }: { readonly value: number }) => value >= 0,
        validate,
      },
    ] satisfies BrunoTableColumns<CandidateRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: candidateColumns,
      getRow: () => current,
    });
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    runtime.updateActiveCandidate("not-a-number", true);
    const unsubscribe = runtime.subscribeDraftReview(vi.fn());

    expect(validate).not.toHaveBeenCalled();
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        candidateText: "not-a-number",
        candidateInvalid: true,
        status: "Enter a valid number.",
      },
    ]);

    current = undefined;
    runtime.reconcileActiveRow(new Set(["row"]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1 });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { status: "This row was removed from the server. Changes cannot be saved." },
    ]);

    current = { value: -1 };
    runtime.reconcileActiveRow(new Set(["row"]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1 });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { status: "This cell is no longer editable." },
    ]);
    expect(validate).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("does not publish untouched permission loss as candidate work", () => {
    type CandidateRow = Readonly<{ readonly value: number }>;
    let current: CandidateRow = { value: 4 };
    const candidateColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "number",
        isEditable: ({ value }: { readonly value: number }) => value >= 0,
      },
    ] satisfies BrunoTableColumns<CandidateRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: candidateColumns,
      getRow: () => current,
    });
    expect(runtime.start("row", "COL_ID_VALUE")).toBe(true);
    const unsubscribe = runtime.subscribeDraftReview(vi.fn());

    current = { value: -1 };
    runtime.reconcileActiveRow(new Set(["row"]));

    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      invalidMessage: "This cell is no longer editable.",
    });
    expect(runtime.getActivitySnapshot()).toMatchObject({
      activeEditor: true,
      activeCandidatePending: false,
      reviewCount: 0,
      blockedCount: 0,
    });
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(0);
    unsubscribe();
  });

  it("does not double-count a blocked draft and active candidate for the same cell", () => {
    let current: Row | undefined = row;
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => current });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    runtime.updateActiveCandidate("8", false);

    current = undefined;
    runtime.reconcileSourceRows(new Set([row.id]));
    runtime.reconcileActiveRow(new Set([row.id]));

    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1, reviewCount: 1 });
  });

  it("preserves an undefined canonical value in an Accepted Overlay", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    let unsubscribe = (): void => undefined;

    try {
      vi.useFakeTimers();
      unsubscribe = runtime.subscribeCell(row.id, "COL_ID_SCORE", () => undefined);
      runtime.acceptSave(
        "operation-1",
        [
          {
            rowId: row.id,
            baseRow: row,
            expectedVersion: 1n,
            changes: [
              {
                columnId: "COL_ID_SCORE",
                field: "score",
                before: row.score,
                after: undefined,
              },
            ],
          },
        ],
        false,
      );

      expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE")).toStrictEqual({
        active: false,
        hasDraft: false,
        hasAcceptedOverlay: true,
        saveSucceeded: true,
        acceptedOverlay: undefined,
        acceptedOverlayPresentationColumn: columns.find(
          (column) => column.columnId === "COL_ID_SCORE",
        ),
      });
      vi.advanceTimersByTime(1_999);
      expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveSucceeded).toBe(true);
      vi.advanceTimersByTime(1);
      expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveSucceeded).toBeUndefined();
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("invalidates only Immediate operation rows in predicate traversal", () => {
    type SaveRow = Readonly<{
      readonly id: string;
      readonly value: string;
      readonly revision: bigint;
    }>;
    const saveRows = new Map<string, SaveRow>([
      ["row-a", { id: "row-a", value: "source", revision: 1n }],
      ["row-b", { id: "row-b", value: "source", revision: 1n }],
      ["row-c", { id: "row-c", value: "source", revision: 1n }],
    ]);
    const rowReads: string[] = [];
    const saveColumns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: ({ value }: { readonly value: string }) => value.length > 0,
      },
    ] satisfies BrunoTableColumns<SaveRow>);
    const runtime = new BrunoTableCellEditRuntime({
      columns: saveColumns,
      getRow: (rowId) => {
        rowReads.push(rowId);
        return saveRows.get(rowId);
      },
      getRowVersion: (candidate) => (candidate as SaveRow).revision,
    });
    const rowIds = [...saveRows.keys()];
    const rowSpace = {
      totalRows: rowIds.length,
      getRowId: (rowIndex: number) => rowIds[rowIndex],
    };
    runtime.reconcileTraversal(saveColumns, rowSpace);
    const drainTraversal = () => {
      runtime.reconcileTraversal(saveColumns, rowSpace);
      for (let index = 0; !runtime.isTraversalReady() && index < 10; index += 1) {
        runtime.buildTraversalSlice();
      }
      expect(runtime.isTraversalReady()).toBe(true);
    };
    drainTraversal();
    rowReads.length = 0;
    const baseRow = saveRows.get("row-a")!;
    const changeSet: BrunoTableCellEditSaveChangeSet = [
      {
        rowId: "row-a",
        baseRow,
        expectedVersion: baseRow.revision,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: "source",
            after: "saved",
          },
        ],
      },
    ];

    expect(runtime.beginSaveOperation("immediate-row", changeSet, false)).toBe(true);
    drainTraversal();
    expect(rowReads).toEqual(["row-a"]);

    runtime.acceptSave("immediate-row", changeSet, false);
    saveRows.set("row-a", { id: "row-a", value: "saved", revision: 2n });
    runtime.reconcileSourceRows(new Set(["row-a"]));
    rowReads.length = 0;
    drainTraversal();
    expect(rowReads).toEqual(["row-a"]);
  });

  it("retains rejected operation evidence until that operation fully converges", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const activityBeforeRejection = runtime.getActivitySnapshot();
    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toBeDefined();

    runtime.rejectSave("operation-1", changeSet!, false);
    expect(runtime.hasRejectedOperation("operation-1")).toBe(true);
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE")).toMatchObject({
      hasDraft: true,
      draft: 7,
      saveFailed: true,
    });
    expect(runtime.getActivitySnapshot()).toEqual(activityBeforeRejection);

    current = Object.freeze({ ...row, score: 7 });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.hasRejectedOperation("operation-1")).toBe(false);
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE")).toEqual({
      active: false,
      hasDraft: false,
    });
  });

  it("publishes only rejected Cell Identity deltas for precise source convergence", () => {
    const second = Object.freeze({ ...row, id: "row-2", score: 5 });
    const rowsById = new Map([
      [row.id, row],
      [second.id, second],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rowsById.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    const changeSet = Object.freeze(
      [row, second].map((candidate) =>
        Object.freeze({
          rowId: candidate.id,
          baseRow: candidate,
          expectedVersion: candidate.quantity,
          changes: Object.freeze([
            Object.freeze({
              columnId: "COL_ID_SCORE",
              field: "score",
              before: candidate.score,
              after: 7,
            }),
          ]),
        }),
      ),
    ) as BrunoTableCellEditSaveChangeSet;
    expect(runtime.beginSaveOperation("operation-delta", changeSet, false)).toBe(true);
    runtime.rejectSave("operation-delta", changeSet, true);
    runtime.completeSaveOperation("operation-delta");
    const listener = vi.fn();
    const unsubscribe = runtime.subscribeRejectedOperation("operation-delta", listener);

    rowsById.set(row.id, Object.freeze({ ...row, score: 7, quantity: 2n }));
    runtime.reconcileSourceRows(new Set([row.id]));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(runtime.getRejectedOperationUpdateSnapshot("operation-delta")).toEqual({
      remainingCount: 1,
      removedCells: [{ rowId: row.id, columnId: "COL_ID_SCORE" }],
    });

    rowsById.set(second.id, Object.freeze({ ...second, score: 7, quantity: 2n }));
    runtime.reconcileSourceRows(new Set([second.id]));

    expect(listener).toHaveBeenCalledTimes(2);
    expect(runtime.getRejectedOperationUpdateSnapshot("operation-delta")).toEqual({
      remainingCount: 0,
      removedCells: [],
    });
    unsubscribe();
  });

  it("clears only stale Immediate failure presentation when the same cell is retried", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    const first = [
      {
        rowId: row.id,
        baseRow: row,
        expectedVersion: row.quantity,
        changes: [
          {
            columnId: "COL_ID_SCORE",
            field: "score",
            before: row.score,
            after: 7,
          },
        ],
      },
    ] as const;
    expect(runtime.beginSaveOperation("immediate-first", first, false)).toBe(true);
    runtime.rejectSave("immediate-first", first, true);
    runtime.completeSaveOperation("immediate-first");
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBe(true);

    const retry = [
      {
        ...first[0],
        changes: [{ ...first[0].changes[0], after: 8 }] as const,
      },
    ] as const;
    expect(runtime.beginSaveOperation("immediate-retry", retry, false)).toBe(true);
    expect(runtime.hasRejectedOperation("immediate-first")).toBe(true);
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE")).toMatchObject({
      savePending: true,
    });
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBeUndefined();

    const unsubscribe = runtime.subscribeCell(row.id, "COL_ID_SCORE", () => undefined);
    runtime.acceptSave("immediate-retry", retry, false);
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE")).toMatchObject({
      saveSucceeded: true,
    });
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBeUndefined();
    current = Object.freeze({ ...row, score: 8, quantity: 2n });
    runtime.reconcileSourceRows(new Set([row.id]));
    runtime.completeSaveOperation("immediate-retry");
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBeUndefined();
    unsubscribe();
  });

  it("retains an Accepted Overlay across a non-authoritative source gap", () => {
    let current: Row | undefined = row;
    let authoritative = true;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
      isSourceAuthoritative: () => authoritative,
    });
    const changeSet = [
      {
        rowId: row.id,
        baseRow: row,
        expectedVersion: row.quantity,
        changes: [
          {
            columnId: "COL_ID_SCORE",
            field: "score",
            before: row.score,
            after: 7,
          },
        ],
      },
    ] as const;

    expect(runtime.beginSaveOperation("operation-loading", changeSet, false)).toBe(true);
    authoritative = false;
    current = undefined;
    runtime.acceptSave("operation-loading", changeSet, false);
    expect(runtime.getAcceptedOverlayCountForOperation("operation-loading")).toBe(1);
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE")).toMatchObject({
      hasAcceptedOverlay: true,
      acceptedOverlay: 7,
      savePending: true,
    });

    authoritative = true;
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getAcceptedOverlayCountForOperation("operation-loading")).toBe(0);
  });

  it("reconciles an Accepted Overlay with its captured Row Version extractor", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    const changeSet = [
      {
        rowId: row.id,
        baseRow: row,
        expectedVersion: row.quantity,
        changes: [
          {
            columnId: "COL_ID_SCORE",
            field: "score",
            before: row.score,
            after: 7,
          },
        ],
      },
    ] as const;

    expect(runtime.beginSaveOperation("operation-version-domain", changeSet, false)).toBe(true);
    runtime.setRowVersionExtractor(() => 999n);
    runtime.acceptSave("operation-version-domain", changeSet, false);
    expect(runtime.getAcceptedOverlayCountForOperation("operation-version-domain")).toBe(1);

    current = Object.freeze({ ...row, quantity: 2n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getAcceptedOverlayCountForOperation("operation-version-domain")).toBe(0);
  });

  it("visits only pending operations indexed by a precisely changed Row Identity", () => {
    const second = Object.freeze({ ...row, id: "row-2", score: 5 });
    const rowsById = new Map([
      [row.id, row],
      [second.id, second],
    ]);
    const getRow = vi.fn((rowId: string) => rowsById.get(rowId));
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    for (const [operationId, candidate] of [
      ["pending-first", row],
      ["pending-second", second],
    ] as const) {
      expect(
        runtime.beginSaveOperation(
          operationId,
          [
            {
              rowId: candidate.id,
              baseRow: candidate,
              expectedVersion: candidate.quantity,
              changes: [
                {
                  columnId: "COL_ID_SCORE",
                  field: "score",
                  before: candidate.score,
                  after: 7,
                },
              ],
            },
          ],
          false,
        ),
      ).toBe(true);
    }
    rowsById.set(second.id, Object.freeze({ ...second, score: 7, quantity: 2n }));
    getRow.mockClear();

    runtime.reconcileSourceRows(new Set([second.id]));

    expect(getRow).toHaveBeenCalledTimes(1);
    expect(getRow).toHaveBeenCalledWith(second.id);
  });

  it("turns rejected Batch source divergence into reversible conflict evidence", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toBeDefined();
    runtime.rejectSave("operation-diverged", changeSet!, false);

    current = Object.freeze({ ...row, score: 5 });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot().conflictCount).toBe(1);
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
      base: row.score,
      mine: 7,
      serverNow: 5,
      conflict: { server: 5 },
    });

    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot().conflictCount).toBe(0);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot().conflictCount).toBe(1);
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({ conflict: { server: 5 } });

    current = Object.freeze({ ...row, score: row.score, quantity: 3n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot().conflictCount).toBe(0);
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
      base: row.score,
      mine: 7,
      serverNow: row.score,
    });
    expect(runtime.getDraftReviewSnapshot()[0]).not.toHaveProperty("conflict");
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftReviewSnapshot()[0]).not.toHaveProperty("conflict");
  });

  it("records one individual Server resolution as one reversible Batch command", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toBeDefined();
    runtime.rejectSave("operation-resolution", changeSet!, false);
    current = Object.freeze({ ...row, score: 5 });
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0];
    expect(conflict?.conflict).toBeDefined();

    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict!.id,
          resolution: "server",
          reviewedServer: conflict!.conflict!.server,
          reviewedServerVersion: conflict!.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, conflictCount: 0 });
    current = Object.freeze({ ...current, quantity: current.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, undoCount: 2 });
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 1 });
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, conflictCount: 0 });
  });

  it("records one selected conflict set as one reversible Batch command", () => {
    const second = Object.freeze({ ...row, id: "row-2", quantity: row.quantity + 1n });
    const rowsById = new Map<string, Row>([
      [row.id, row],
      [second.id, second],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rowsById.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: row.score,
          mine: 7,
        },
        {
          rowId: second.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: second,
          expectedVersion: second.quantity,
          base: second.score,
          mine: 8,
        },
      ]),
    ).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toBeDefined();
    runtime.rejectSave("operation-selected-resolution", changeSet!, false);
    rowsById.set(row.id, Object.freeze({ ...row, score: 5 }));
    rowsById.set(second.id, Object.freeze({ ...second, score: 6 }));
    runtime.reconcileSourceRows(new Set([row.id, second.id]));
    const conflicts = runtime.getDraftReviewSnapshot();
    expect(conflicts).toHaveLength(2);

    const resolutions = conflicts.map((conflict, index) => ({
      id: conflict.id,
      resolution: index === 0 ? ("server" as const) : ("mine" as const),
      reviewedServer: conflict.conflict!.server,
      reviewedServerVersion: conflict.conflict!.serverVersion,
    }));
    Object.defineProperty(resolutions, "find", {
      value: () => {
        throw new Error("Bulk resolution must not rescan the resolution tuple.");
      },
    });
    expect(
      runtime.resolveDraftConflicts(
        resolutions as [(typeof resolutions)[0], ...typeof resolutions],
      ),
    ).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 0 });
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 2, conflictCount: 2 });
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 0 });
  });

  it("supersedes retained Server resolution evidence when the same cell is edited again", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: row.score,
          mine: 7,
        },
      ]),
    ).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    const unsubscribe = runtime.subscribeDraftReview(() => undefined);
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "server",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(runtime.getDraftReviewSourceSnapshot()).toHaveLength(1);

    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: current,
          expectedVersion: current.quantity,
          base: current.score,
          mine: 9,
        },
      ]),
    ).toBe(true);
    expect(runtime.getDraftReviewSourceSnapshot()).toHaveLength(1);
    expect(
      runtime.isDraftConflictEvidenceCurrent(
        conflict.id,
        "server",
        conflict.conflict!.server,
        conflict.conflict!.serverVersion,
      ),
    ).toBe(false);
    expect(runtime.reopenResolvedConflicts([conflict.id])).toBe(true);
    expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBe(9);
    expect(runtime.getDraftReviewSnapshot()[0]?.conflict).toBeUndefined();
    expect(runtime.getDraftReviewSourceSnapshot()).toHaveLength(1);
    unsubscribe();
  });

  it("prunes a locally undone Server resolution when its source evidence changes", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: row.score,
          mine: 7,
        },
      ]),
    ).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "server",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot().redoCount).toBe(1);

    current = Object.freeze({ ...row, score: 6, quantity: row.quantity + 2n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.isConflictResolutionLocallyUndone(conflict.id, 5, row.quantity + 1n)).toBe(
      false,
    );
    expect(runtime.reopenResolvedConflicts([conflict.id])).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ conflictCount: 1, redoCount: 0 });
    expect(runtime.getDraftReviewSnapshot()[0]?.conflict).toMatchObject({
      server: 6,
      serverVersion: row.quantity + 2n,
    });
  });

  it.each(["mine", "server"] as const)(
    "keeps a safely rebased draft conflict-free when a locally undone %s resolution is invalidated",
    (resolution) => {
      let current = row;
      const runtime = new BrunoTableCellEditRuntime({
        columns,
        getRow: () => current,
        getRowVersion: (candidate) => (candidate as Row).quantity,
      });
      runtime.setBatchHistoryEnabled(true);
      expect(
        runtime.applyAcceptedDraftGesture([
          {
            rowId: row.id,
            columnId: "COL_ID_SCORE",
            field: "score",
            baseRow: row,
            expectedVersion: row.quantity,
            base: row.score,
            mine: 7,
          },
        ]),
      ).toBe(true);
      current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
      runtime.reconcileSourceRows(new Set([row.id]));
      const conflict = runtime.getDraftReviewSnapshot()[0]!;
      expect(
        runtime.resolveDraftConflicts([
          {
            id: conflict.id,
            resolution,
            reviewedServer: conflict.conflict!.server,
            reviewedServerVersion: conflict.conflict!.serverVersion,
          },
        ]),
      ).toBe(true);
      expect(runtime.undoBatchDraft()).toBe(true);

      const retainedResolutionListener = vi.fn();
      const unsubscribeRetainedResolution = runtime.subscribeRetainedResolutionPublication(
        retainedResolutionListener,
      );
      current = Object.freeze({ ...row, quantity: row.quantity + 2n });
      runtime.reconcileSourceRows(new Set([row.id]));
      expect(retainedResolutionListener).toHaveBeenCalled();
      expect(runtime.getRetainedResolutionPublicationSnapshot()).toContain(conflict.id);
      unsubscribeRetainedResolution();
      expect(runtime.getDraftReviewSnapshot()[0]?.conflict).toBeUndefined();
      expect(runtime.reopenResolvedConflicts([conflict.id])).toBe(true);
      expect(runtime.getActivitySnapshot()).toMatchObject({
        draftCount: 1,
        conflictCount: 0,
        undoCount: 1,
        redoCount: 0,
      });
      expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBe(7);
      expect(runtime.undoBatchDraft()).toBe(true);
      expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, undoCount: 0 });
    },
  );

  it("keeps an undone resolution conflict-free when canonical authority catches up after its row", () => {
    let current = row;
    let canonicalScore = row.score;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getCanonicalValue: () => ({ _tag: "Success", value: canonicalScore }),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: row.score,
          mine: 7,
        },
      ]),
    ).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    canonicalScore = current.score;
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "mine",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(runtime.undoBatchDraft()).toBe(true);

    current = Object.freeze({ ...row, quantity: row.quantity + 2n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot().conflictCount).toBe(1);
    canonicalScore = current.score;
    current = Object.freeze({ ...current });
    expect(runtime.reopenResolvedConflicts([conflict.id])).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ conflictCount: 0, redoCount: 0 });
    expect(runtime.reopenResolvedConflicts([conflict.id])).toBe(false);
    expect(runtime.getActivitySnapshot()).toMatchObject({ conflictCount: 0, redoCount: 0 });
  });

  it("reopens multiple invalidated resolutions in one observable transaction", () => {
    const second = Object.freeze({ ...row, id: "row-2", quantity: row.quantity + 1n });
    const rowsById = new Map<string, Row>([
      [row.id, row],
      [second.id, second],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rowsById.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: row.score,
          mine: 7,
        },
        {
          rowId: second.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: second,
          expectedVersion: second.quantity,
          base: second.score,
          mine: 8,
        },
      ]),
    ).toBe(true);
    rowsById.set(row.id, Object.freeze({ ...row, score: 5, quantity: row.quantity + 2n }));
    rowsById.set(second.id, Object.freeze({ ...second, score: 6, quantity: second.quantity + 2n }));
    runtime.reconcileSourceRows(new Set([row.id, second.id]));
    const conflicts = runtime.getDraftReviewSnapshot();
    expect(conflicts).toHaveLength(2);
    expect(
      runtime.resolveDraftConflicts(
        conflicts.map((conflict) => ({
          id: conflict.id,
          resolution: "mine" as const,
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        })) as [BrunoTableCellEditConflictResolution, ...BrunoTableCellEditConflictResolution[]],
      ),
    ).toBe(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: rowsById.get(row.id)!,
          expectedVersion: row.quantity + 2n,
          base: 5,
          mine: 9,
        },
      ]),
    ).toBe(true);
    const reviewPublished = vi.fn();
    const activityPublished = vi.fn();
    const traversalPublished = vi.fn();
    const unsubscribeReview = runtime.subscribeDraftReview(reviewPublished);
    const reviewRowPublished = runtime.getDraftReviewSourceSnapshot().map(() => vi.fn());
    const unsubscribeReviewRows = runtime
      .getDraftReviewSourceSnapshot()
      .map((source, index) => source.subscribe(reviewRowPublished[index]!));
    const unsubscribeActivity = runtime.subscribeActivity(activityPublished);
    const unsubscribeTraversal = runtime.subscribeTraversalInvalidation(traversalPublished);
    rowsById.set(row.id, Object.freeze({ ...row, score: 11, quantity: row.quantity + 3n }));
    rowsById.set(
      second.id,
      Object.freeze({ ...second, score: 10, quantity: second.quantity + 3n }),
    );

    expect(runtime.reopenResolvedConflicts(conflicts.map((conflict) => conflict.id))).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 2,
      conflictCount: 2,
      undoCount: 2,
    });
    expect(reviewPublished).not.toHaveBeenCalled();
    expect(reviewRowPublished).toHaveLength(2);
    expect(reviewRowPublished.every((listener) => listener.mock.calls.length === 1)).toBe(true);
    expect(activityPublished).toHaveBeenCalledOnce();
    expect(traversalPublished).toHaveBeenCalledOnce();
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBe(7);
    expect(runtime.getDraftSnapshot(second.id, "COL_ID_SCORE")).toBe(8);
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 2,
      conflictCount: 2,
      undoCount: 1,
      redoCount: 1,
    });
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      conflictCount: 0,
      undoCount: 0,
      redoCount: 2,
    });
    unsubscribeReview();
    for (const unsubscribe of unsubscribeReviewRows) unsubscribe();
    unsubscribeActivity();
    unsubscribeTraversal();
  });

  it("publishes only row-indexed retained resolution candidates for a source update", () => {
    const sourceRows = Array.from({ length: 64 }, (_, index) =>
      Object.freeze({ ...row, id: `row-${String(index)}`, score: index }),
    );
    const rowsById = new Map<string, Row>(sourceRows.map((sourceRow) => [sourceRow.id, sourceRow]));
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rowsById.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    const drafts = sourceRows.map((sourceRow) => ({
      rowId: sourceRow.id,
      columnId: "COL_ID_SCORE",
      field: "score",
      baseRow: sourceRow,
      expectedVersion: sourceRow.quantity,
      base: sourceRow.score,
      mine: sourceRow.score + 100,
    })) as [BrunoTableCellEditDraftSnapshot, ...BrunoTableCellEditDraftSnapshot[]];
    expect(runtime.applyAcceptedDraftGesture(drafts)).toBe(true);
    for (const sourceRow of sourceRows) {
      rowsById.set(
        sourceRow.id,
        Object.freeze({
          ...sourceRow,
          score: sourceRow.score + 1,
          quantity: sourceRow.quantity + 1n,
        }),
      );
    }
    runtime.reconcileSourceRows(new Set(sourceRows.map((sourceRow) => sourceRow.id)));
    const conflicts = runtime.getDraftReviewSnapshot();
    expect(
      runtime.resolveDraftConflicts(
        conflicts.map((conflict) => ({
          id: conflict.id,
          resolution: "server" as const,
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        })) as [BrunoTableCellEditConflictResolution, ...BrunoTableCellEditConflictResolution[]],
      ),
    ).toBe(true);
    const published = vi.fn();
    const unsubscribe = runtime.subscribeRetainedResolutionPublication(published);

    runtime.reconcileSourceRows(new Set(["unrelated-row"]));
    expect(published).not.toHaveBeenCalled();
    const changed = sourceRows[17]!;
    rowsById.set(
      changed.id,
      Object.freeze({ ...changed, score: changed.score + 2, quantity: changed.quantity + 2n }),
    );
    runtime.reconcileSourceRows(new Set([changed.id]));
    expect(published).toHaveBeenCalledOnce();
    expect([...runtime.getRetainedResolutionPublicationSnapshot()]).toEqual([
      conflicts.find((conflict) => conflict.rowId === changed.id)!.id,
    ]);
    unsubscribe();
  });

  it("resolves an Immediate conflict without requiring Batch history", () => {
    let current = row;
    const onCommitGesture = vi.fn();
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
      onCommitGesture,
    });
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    runtime.updateActiveCandidate("7", false);
    expect(runtime.commit("7")).toBe(true);
    expect(onCommitGesture).not.toHaveBeenCalled();

    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0];
    expect(conflict?.conflict).toBeDefined();

    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict!.id,
          resolution: "mine",
          reviewedServer: conflict!.conflict!.server,
          reviewedServerVersion: conflict!.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(onCommitGesture).toHaveBeenCalledOnce();
    expect(onCommitGesture).toHaveBeenLastCalledWith([
      {
        rowId: row.id,
        columnId: "COL_ID_SCORE",
        field: "score",
        before: 5,
        after: 7,
      },
    ]);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 0 });
  });

  it("restores an Immediate conflict when save admission loses a race", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
      onCommitGesture: () => false,
    });
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    const activityConflictObservations: number[] = [];
    const reviewConflictObservations: boolean[] = [];
    const cellConflictObservations: boolean[] = [];
    const retainedResolutionPublication = vi.fn();
    const traversalInvalidation = vi.fn();
    const unsubscribeActivity = runtime.subscribeActivity(() => {
      activityConflictObservations.push(runtime.getActivitySnapshot().conflictCount);
    });
    const unsubscribeReview = runtime.subscribeDraftReview(() => {
      reviewConflictObservations.push(runtime.getDraftReviewSnapshot()[0]?.conflict !== undefined);
    });
    const unsubscribeCell = runtime.subscribeCell(row.id, "COL_ID_SCORE", () => {
      cellConflictObservations.push(runtime.getDraftReviewSnapshot()[0]?.conflict !== undefined);
    });
    const unsubscribeRetained = runtime.subscribeRetainedResolutionPublication(
      retainedResolutionPublication,
    );
    const unsubscribeTraversal = runtime.subscribeTraversalInvalidation(traversalInvalidation);

    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "mine",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(false);
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
      id: conflict.id,
      conflict: {
        server: conflict.conflict!.server,
        serverVersion: conflict.conflict!.serverVersion,
      },
    });
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 1 });
    expect(activityConflictObservations.every((count) => count === 1)).toBe(true);
    expect(reviewConflictObservations.every(Boolean)).toBe(true);
    expect(cellConflictObservations.every(Boolean)).toBe(true);
    expect(retainedResolutionPublication).not.toHaveBeenCalled();
    expect(traversalInvalidation).not.toHaveBeenCalled();
    unsubscribeActivity();
    unsubscribeReview();
    unsubscribeCell();
    unsubscribeRetained();
    unsubscribeTraversal();
  });

  it("restores an Immediate accepted gesture when save admission loses a race", () => {
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).quantity,
      onCommitGesture: () => false,
    });
    const activityObservations: number[] = [];
    const reviewObservations: number[] = [];
    const cellObservations: boolean[] = [];
    const traversalInvalidation = vi.fn();
    const unsubscribeActivity = runtime.subscribeActivity(() => {
      activityObservations.push(runtime.getActivitySnapshot().draftCount);
    });
    const unsubscribeReview = runtime.subscribeDraftReview(() => {
      reviewObservations.push(runtime.getDraftReviewSnapshot().length);
    });
    const unsubscribeCell = runtime.subscribeCell(row.id, "COL_ID_SCORE", () => {
      cellObservations.push(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").hasDraft);
    });
    const unsubscribeTraversal = runtime.subscribeTraversalInvalidation(traversalInvalidation);

    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: row.score,
          mine: 7,
        },
      ]),
    ).toBe(false);
    expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBeUndefined();
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, reviewCount: 0 });
    expect(activityObservations.every((draftCount) => draftCount === 0)).toBe(true);
    expect(reviewObservations.every((count) => count === 0)).toBe(true);
    expect(cellObservations.every((hasDraft) => !hasDraft)).toBe(true);
    expect(traversalInvalidation).not.toHaveBeenCalled();
    unsubscribeActivity();
    unsubscribeReview();
    unsubscribeCell();
    unsubscribeTraversal();
  });

  it("retains an Immediate gesture when save preflight reconciles a source race", () => {
    let current = row;
    let runtime!: BrunoTableCellEditRuntime;
    runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
      onCommitGesture: (changes) => {
        current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
        const preparation = runtime.createImmediateSaveChangeSet(changes);
        return preparation.kind === "reconciled"
          ? "preflight-reconciled"
          : preparation.kind === "change-set"
            ? "admitted"
            : "rejected";
      },
    });
    const traversalInvalidation = vi.fn();
    const unsubscribeTraversal = runtime.subscribeTraversalInvalidation(traversalInvalidation);

    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: row.score,
          mine: 7,
        },
      ]),
    ).toBe(true);
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
      mine: 7,
      conflict: { server: 5, serverVersion: row.quantity + 1n },
    });
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 1 });
    expect(traversalInvalidation).toHaveBeenCalledOnce();
    unsubscribeTraversal();
  });

  it("rejects permission-blocked Immediate Mine resolution without blocking Server resolution", () => {
    type PermissionRow = Readonly<{
      readonly id: string;
      readonly score: number;
      readonly editable: boolean;
      readonly revision: bigint;
    }>;
    const permissionColumns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
        isEditable: ({ row: candidate }: { readonly row: PermissionRow }) => candidate.editable,
      },
    ] satisfies BrunoTableColumns<PermissionRow>);
    let current: PermissionRow = Object.freeze({
      id: "row-permission",
      score: 4,
      editable: true,
      revision: 1n,
    });
    let resolvePhase = false;
    let runtime!: BrunoTableCellEditRuntime;
    const onCommitGesture = vi.fn((changes: BrunoTableCellEditChangeGesture) => {
      if (!resolvePhase) return "admitted" as const;
      const preparation = runtime.createImmediateSaveChangeSet(changes);
      return preparation.kind === "reconciled"
        ? ("preflight-reconciled" as const)
        : preparation.kind === "change-set"
          ? ("admitted" as const)
          : ("rejected" as const);
    });
    runtime = new BrunoTableCellEditRuntime({
      columns: permissionColumns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as PermissionRow).revision,
      onCommitGesture,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: current.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: current,
          expectedVersion: current.revision,
          base: current.score,
          mine: 7,
        },
      ]),
    ).toBe(true);
    onCommitGesture.mockClear();
    current = Object.freeze({ ...current, score: 5, editable: false, revision: 2n });
    runtime.reconcileSourceRows(new Set([current.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(conflict).toMatchObject({
      mine: 7,
      blockedReason: "This cell is no longer editable.",
      conflict: { server: 5, serverVersion: 2n },
    });
    resolvePhase = true;

    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "mine",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(false);
    expect(onCommitGesture).not.toHaveBeenCalled();
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
      mine: 7,
      blockedReason: "This cell is no longer editable.",
      conflict: { server: 5, serverVersion: 2n },
    });
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "server",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(0);
  });

  it("rolls back an Immediate Mine resolution when save admission throws", () => {
    let current = row;
    let throwOnResolution = false;
    const onCommitGesture = vi.fn(() => {
      if (throwOnResolution) throw new Error("save admission failed");
      return "admitted" as const;
    });
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
      onCommitGesture,
    });
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: row.score,
          mine: 7,
        },
      ]),
    ).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    const reviewObservations: number[] = [];
    const activityObservations: number[] = [];
    const cellObservations: boolean[] = [];
    const unsubscribeReview = runtime.subscribeDraftReview(() => {
      reviewObservations.push(runtime.getDraftReviewSnapshot()[0]?.conflict === undefined ? 0 : 1);
    });
    const unsubscribeActivity = runtime.subscribeActivity(() => {
      activityObservations.push(runtime.getActivitySnapshot().conflictCount);
    });
    const unsubscribeCell = runtime.subscribeCell(row.id, "COL_ID_SCORE", () => {
      cellObservations.push(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").conflicted === true);
    });
    throwOnResolution = true;

    try {
      expect(
        runtime.resolveDraftConflicts([
          {
            id: conflict.id,
            resolution: "mine",
            reviewedServer: conflict.conflict!.server,
            reviewedServerVersion: conflict.conflict!.serverVersion,
          },
        ]),
      ).toBe(false);
      expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
        mine: 7,
        conflict: { server: 5, serverVersion: row.quantity + 1n },
      });
      expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 1 });
      expect(reviewObservations).not.toContain(0);
      expect(activityObservations).not.toContain(0);
      expect(cellObservations).not.toContain(false);
    } finally {
      unsubscribeReview();
      unsubscribeActivity();
      unsubscribeCell();
    }
  });

  it("rolls back a scalar Immediate commit when save admission is rejected", () => {
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).quantity,
      onCommit: () => "rejected",
    });
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    runtime.updateActiveCandidate("7", false);
    const dirtyActivity: number[] = [];
    const dirtyReview: boolean[] = [];
    const dirtyCell: boolean[] = [];
    const traversalInvalidation = vi.fn();
    const unsubscribeActivity = runtime.subscribeActivity(() => {
      dirtyActivity.push(runtime.getActivitySnapshot().draftCount);
    });
    const unsubscribeReview = runtime.subscribeDraftReview(() => {
      dirtyReview.push(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE") !== undefined);
    });
    const unsubscribeCell = runtime.subscribeCell(row.id, "COL_ID_SCORE", () => {
      dirtyCell.push(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").hasDraft);
    });
    const unsubscribeTraversal = runtime.subscribeTraversalInvalidation(traversalInvalidation);

    expect(runtime.commit("7")).toBe(false);
    expect(runtime.getSessionSnapshot()).toMatchObject({
      kind: "editing",
      rowId: row.id,
      columnId: "COL_ID_SCORE",
    });
    expect(runtime.getActiveCandidateSnapshot()).toEqual({
      kind: "scalar",
      rawText: "7",
      nativeInvalid: false,
    });
    expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBeUndefined();
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, conflictCount: 0 });
    expect(dirtyActivity.every((count) => count === 0)).toBe(true);
    expect(dirtyReview.every((hasDraft) => !hasDraft)).toBe(true);
    expect(dirtyCell.every((hasDraft) => !hasDraft)).toBe(true);
    expect(traversalInvalidation).not.toHaveBeenCalled();
    unsubscribeActivity();
    unsubscribeReview();
    unsubscribeCell();
    unsubscribeTraversal();
  });

  it("retains a scalar Immediate commit when save preflight finds a source conflict", () => {
    let current = row;
    let runtime!: BrunoTableCellEditRuntime;
    runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
      onCommit: (change) => {
        current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
        const preparation = runtime.createImmediateSaveChangeSet([change]);
        return preparation.kind === "reconciled"
          ? "preflight-reconciled"
          : preparation.kind === "change-set"
            ? "admitted"
            : "rejected";
      },
    });
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    const traversalInvalidation = vi.fn();
    const unsubscribeTraversal = runtime.subscribeTraversalInvalidation(traversalInvalidation);

    expect(runtime.commit("7")).toBe(true);
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({
      mine: 7,
      conflict: { server: 5, serverVersion: row.quantity + 1n },
    });
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 1 });
    expect(traversalInvalidation).toHaveBeenCalledOnce();
    unsubscribeTraversal();
  });

  it("indexes an Immediate Server resolution for exact source invalidation", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "server",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    const published = vi.fn();
    const unsubscribe = runtime.subscribeRetainedResolutionPublication(published);

    current = Object.freeze({ ...row, score: 6, quantity: row.quantity + 2n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(published).toHaveBeenCalledOnce();
    expect([...runtime.getRetainedResolutionPublicationSnapshot()]).toEqual([conflict.id]);
    unsubscribe();
  });

  it("finalizes exact lineage-free Immediate Server resolution evidence", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "server",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    const published = vi.fn();
    const unsubscribe = runtime.subscribeRetainedResolutionPublication(published);
    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(1);

    expect(runtime.finalizeRetainedConflictResolutions([conflict.id])).toBe(true);

    expect(published).toHaveBeenCalledOnce();
    expect([...runtime.getRetainedResolutionPublicationSnapshot()]).toEqual([conflict.id]);
    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(0);
    expect(runtime.reopenResolvedConflicts([conflict.id])).toBe(false);
    expect(runtime.finalizeRetainedConflictResolutions([conflict.id])).toBe(false);
    published.mockClear();
    current = Object.freeze({ ...row, score: 6, quantity: row.quantity + 2n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(published).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("accepts a fresh Mine decision after source invalidates an older Batch resolution", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    let conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "mine",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);

    current = Object.freeze({ ...current, score: 6 });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.reopenResolvedConflicts([conflict.id])).toBe(true);
    conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(conflict.conflict).toMatchObject({ server: 6 });
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "mine",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(runtime.getActivitySnapshot().conflictCount).toBe(0);
  });

  it("evicts retained Server resolution evidence with its bounded Batch lineage", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "server",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    const published = vi.fn();
    const unsubscribe = runtime.subscribeRetainedResolutionPublication(published);
    for (let index = 0; index < 128; index += 1) {
      expect(
        runtime.applyAcceptedDraftGesture([
          {
            rowId: row.id,
            columnId: "COL_ID_QUANTITY",
            field: "quantity",
            baseRow: current,
            expectedVersion: current.quantity,
            base: current.quantity,
            mine: current.quantity + BigInt(index + 2),
          },
        ]),
      ).toBe(true);
    }
    expect(published).toHaveBeenCalledOnce();
    expect([...runtime.getRetainedResolutionPublicationSnapshot()]).toEqual([conflict.id]);
    published.mockClear();

    current = Object.freeze({ ...current, score: 6, quantity: current.quantity + 200n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(published).not.toHaveBeenCalled();
    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(1);
    unsubscribe();
  });

  it("retains Mine acknowledgement observation after its Batch lineage is evicted", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    const conflict = runtime.getDraftReviewSnapshot()[0]!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflict.id,
          resolution: "mine",
          reviewedServer: conflict.conflict!.server,
          reviewedServerVersion: conflict.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
    const published = vi.fn();
    const unsubscribe = runtime.subscribeRetainedResolutionPublication(published);
    for (let index = 0; index < 128; index += 1) {
      expect(
        runtime.applyAcceptedDraftGesture([
          {
            rowId: row.id,
            columnId: "COL_ID_QUANTITY",
            field: "quantity",
            baseRow: current,
            expectedVersion: current.quantity,
            base: current.quantity,
            mine: current.quantity + BigInt(index + 2),
          },
        ]),
      ).toBe(true);
    }
    expect(published).not.toHaveBeenCalled();

    current = Object.freeze({ ...current, quantity: current.quantity + 200n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(published).toHaveBeenCalledOnce();
    expect([...runtime.getRetainedResolutionPublicationSnapshot()]).toEqual([conflict.id]);
    expect(runtime.reopenResolvedConflicts([conflict.id])).toBe(true);
    expect(runtime.getActivitySnapshot().conflictCount).toBeGreaterThan(0);
    unsubscribe();
  });

  it("accepts only submitted Batch identities and preserves unrelated draft history", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(row.id, "COL_ID_QUANTITY")).toBe(true);
    expect(runtime.commit("9007199254740994")).toBe(true);
    const unsubscribeReview = runtime.subscribeDraftReview(() => undefined);

    runtime.acceptSave(
      "batch-score",
      [
        {
          rowId: row.id,
          baseRow: row,
          expectedVersion: row.quantity,
          changes: [
            {
              columnId: "COL_ID_SCORE",
              field: "score",
              before: row.score,
              after: 7,
            },
          ],
        },
      ],
      true,
    );

    expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBeUndefined();
    expect(runtime.getDraftSnapshot(row.id, "COL_ID_QUANTITY")).toBe(9_007_199_254_740_994n);
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, undoCount: 1 });
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot(row.id, "COL_ID_QUANTITY")).toBeUndefined();
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot(row.id, "COL_ID_QUANTITY")).toBe(9_007_199_254_740_994n);
    expect(runtime.getDraftReviewSnapshot()).toHaveLength(1);
    expect(runtime.getDraftReviewSnapshot()[0]).toMatchObject({ columnId: "COL_ID_QUANTITY" });
    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(1);
    unsubscribeReview();
  });

  it("preserves history for a Server-resolved conflict reopened while another Batch cell saves", () => {
    const second = Object.freeze({
      id: "row-2",
      quantity: row.quantity + 1n,
      score: 3,
    });
    const rowsById = new Map<string, Row>([
      [row.id, row],
      [second.id, second],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rowsById.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(second.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);

    const firstServerB = Object.freeze({
      ...second,
      quantity: second.quantity + 1n,
      score: 5,
    });
    rowsById.set(second.id, firstServerB);
    runtime.reconcileSourceRows(new Set([second.id]));
    const conflictB = runtime
      .getDraftReviewSnapshot()
      .find((candidate) => candidate.rowId === second.id)!;
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflictB.id,
          resolution: "server",
          reviewedServer: conflictB.conflict!.server,
          reviewedServerVersion: conflictB.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);

    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toMatchObject([
      {
        rowId: row.id,
        changes: [{ columnId: "COL_ID_SCORE", after: 7 }],
      },
    ]);
    expect(runtime.beginSaveOperation("batch-a", changeSet!, true)).toBe(true);

    const secondServerB = Object.freeze({
      ...firstServerB,
      quantity: firstServerB.quantity + 1n,
      score: 6,
    });
    rowsById.set(second.id, secondServerB);
    runtime.reconcileSourceRows(new Set([second.id]));
    const retainedCandidates = [...runtime.getRetainedResolutionPublicationSnapshot()];
    expect(retainedCandidates).toEqual([conflictB.id]);
    expect(runtime.reopenResolvedConflicts(retainedCandidates)).toBe(true);
    expect(
      runtime.getDraftReviewSnapshot().find((candidate) => candidate.rowId === second.id),
    ).toMatchObject({
      rowId: second.id,
      mine: 8,
      conflict: { server: 6, serverVersion: secondServerB.quantity },
    });

    runtime.acceptSave("batch-a", changeSet!, true);

    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 1,
      conflictCount: 1,
      undoCount: 1,
    });
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getDraftSnapshot(second.id, "COL_ID_SCORE")).toBeUndefined();
  });

  it("keeps a fully converged pending Batch save locked without resurrecting its draft history", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toBeDefined();
    expect(runtime.beginSaveOperation("pending-converged-batch", changeSet!, true)).toBe(true);

    current = Object.freeze({ ...row, score: 7, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(undefined);

    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      undoCount: 0,
      redoCount: 0,
    });
    expect(runtime.isEditable(row.id, "COL_ID_SCORE")).toBe(false);
    expect(runtime.undoBatchDraft()).toBe(false);
    expect(runtime.redoBatchDraft()).toBe(false);

    runtime.rejectSave("pending-converged-batch", changeSet!, false);
    expect(runtime.getDraftMemorySnapshot()).toHaveLength(0);
    expect(runtime.isEditable(row.id, "COL_ID_SCORE")).toBe(false);
    runtime.completeSaveOperation("pending-converged-batch");

    expect(runtime.getDraftMemorySnapshot()).toHaveLength(0);
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 0,
      undoCount: 0,
      redoCount: 0,
    });
    expect(runtime.isEditable(row.id, "COL_ID_SCORE")).toBe(true);
  });

  it("publishes empty review and classification snapshots when all open conflicts converge", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));

    const reviewPublished = vi.fn();
    const classificationPublished = vi.fn();
    const unsubscribeReview = runtime.subscribeDraftReview(reviewPublished);
    const unsubscribeClassification =
      runtime.subscribeDraftReviewClassification(classificationPublished);
    expect(runtime.getDraftReviewSourceSnapshot()).toHaveLength(1);
    expect(runtime.getDraftReviewClassificationSnapshot().conflictIds.size).toBe(1);
    reviewPublished.mockClear();
    classificationPublished.mockClear();

    current = Object.freeze({ ...current, score: 7, quantity: current.quantity + 1n });
    runtime.reconcileSourceRows(undefined);

    expect(runtime.getDraftMemorySnapshot()).toHaveLength(0);
    expect(runtime.getDraftReviewSourceSnapshot()).toHaveLength(0);
    expect(runtime.getDraftReviewClassificationSnapshot()).toEqual({
      blockedIds: new Set(),
      conflictIds: new Set(),
    });
    expect(reviewPublished).toHaveBeenCalledOnce();
    expect(classificationPublished).toHaveBeenCalledOnce();
    unsubscribeClassification();
    unsubscribeReview();
  });

  it("retains an unrelated Server resolution while every active draft converges", () => {
    const second = Object.freeze({
      id: "row-2",
      quantity: row.quantity + 1n,
      score: 3,
    });
    const rowsById = new Map<string, Row>([
      [row.id, row],
      [second.id, second],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rowsById.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(second.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);

    const firstServerB = Object.freeze({
      ...second,
      score: 5,
      quantity: second.quantity + 1n,
    });
    rowsById.set(second.id, firstServerB);
    runtime.reconcileSourceRows(new Set([second.id]));
    const conflictB = runtime
      .getDraftReviewSnapshot()
      .find((candidate) => candidate.rowId === second.id);
    if (conflictB?.conflict === undefined) throw new Error("Expected row B conflict evidence.");
    expect(
      runtime.resolveDraftConflicts([
        {
          id: conflictB.id,
          resolution: "server",
          reviewedServer: conflictB.conflict.server,
          reviewedServerVersion: conflictB.conflict.serverVersion,
        },
      ]),
    ).toBe(true);
    expect(runtime.hasRetainedConflictResolution(conflictB.id)).toBe(true);

    rowsById.set(row.id, Object.freeze({ ...row, score: 7, quantity: row.quantity + 1n }));
    runtime.reconcileSourceRows(undefined);

    expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBeUndefined();
    expect(runtime.hasRetainedConflictResolution(conflictB.id)).toBe(true);
    expect(runtime.getRetainedDraftDependencyCellCount()).toBe(1);

    const secondServerB = Object.freeze({
      ...firstServerB,
      score: 6,
      quantity: firstServerB.quantity + 1n,
    });
    rowsById.set(second.id, secondServerB);
    runtime.reconcileSourceRows(new Set([second.id]));
    expect([...runtime.getRetainedResolutionPublicationSnapshot()]).toEqual([conflictB.id]);
    expect(runtime.reopenResolvedConflicts([conflictB.id])).toBe(true);
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        rowId: second.id,
        mine: 8,
        conflict: { server: 6, serverVersion: secondServerB.quantity },
      },
    ]);
  });

  it("reconciles a rejected Batch draft immediately after releasing its save lock", () => {
    let current: Row = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toBeDefined();
    expect(runtime.beginSaveOperation("rejected-batch-lock", changeSet!, true)).toBe(true);

    current = Object.freeze({ ...row, score: 5, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot().conflictCount).toBe(0);
    runtime.reconcileColumns(
      compileColumns([
        {
          columnId: "COL_ID_QUANTITY",
          field: "quantity",
          headerName: "Quantity",
          valueType: "bigint",
          isEditable: true,
        },
        {
          columnId: "COL_ID_SCORE",
          field: "score",
          headerName: "Score",
          valueType: "number",
          isEditable: ({ value }: { readonly value: number }) => value >= 0,
          validate: ({ value }: { readonly value: number }) =>
            value <= 10 ? undefined : "Score must be at most 10.",
        },
      ]),
    );

    runtime.rejectSave("rejected-batch-lock", changeSet!, false);
    runtime.completeSaveOperation("rejected-batch-lock");

    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, conflictCount: 1 });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        mine: 7,
        conflict: { server: 5, serverVersion: row.quantity + 1n },
      },
    ]);
  });

  it("makes a selected-style blocked Batch draft discardable after rejection unlocks it", () => {
    let current = row;
    const permissionColumns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
        isEditable: ({ row: candidate }: { readonly row: Row }) =>
          candidate.quantity === row.quantity,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: permissionColumns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet()!;
    expect(runtime.beginSaveOperation("blocked-batch", changeSet, true)).toBe(true);
    current = Object.freeze({ ...row, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));
    const blockedId = runtime.getDraftReviewSnapshot()[0]!.id;
    expect(runtime.isBlockedDraftDiscardable(blockedId)).toBe(false);
    runtime.rejectSave("blocked-batch", changeSet, false);
    runtime.completeSaveOperation("blocked-batch");
    expect(runtime.isBlockedDraftDiscardable(blockedId)).toBe(true);
  });

  it("preserves undefined server values in rejected Batch conflict history", () => {
    type OptionalRow = Readonly<{
      readonly id: string;
      readonly optional: string | undefined;
      readonly version: bigint;
    }>;
    const optionalValueType: BrunoTableValueType<string | undefined, "equality", "text"> = {
      codecId: "test/rejected-batch-undefined",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 100,
      decodeRuntime: (input) =>
        typeof input === "string" || input === undefined
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected optional text." },
      equivalent: Object.is,
      compare: (left, right) => (Object.is(left, right) ? 0 : left === undefined ? -1 : 1),
      formatCanonicalText: (value) => value ?? "undefined",
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value ?? "undefined",
      encodePersisted: (value) => value ?? null,
      decodePersisted: (input) =>
        typeof input === "string" || input === null
          ? { _tag: "Success", value: input ?? undefined }
          : { _tag: "Failure", message: "Expected persisted optional text." },
    };
    const initial: OptionalRow = { id: "optional", optional: "source", version: 1n };
    let current = initial;
    const optionalColumns = compileColumns([
      {
        columnId: "COL_ID_OPTIONAL",
        field: "optional",
        headerName: "Optional",
        valueType: optionalValueType,
        isEditable: true,
      },
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: optionalColumns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as OptionalRow).version,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(initial.id, "COL_ID_OPTIONAL")).toBe(true);
    expect(runtime.commit("mine")).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toBeDefined();
    runtime.rejectSave("operation-undefined", changeSet!, false);

    current = Object.freeze({ ...initial, optional: undefined, version: 2n });
    runtime.reconcileSourceRows(new Set([initial.id]));
    expect(runtime.getActivitySnapshot().conflictCount).toBe(1);
    expect(runtime.getDraftReviewSnapshot()[0]?.conflict).toStrictEqual({
      server: undefined,
      serverVersion: 2n,
    });

    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot().conflictCount).toBe(0);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot().conflictCount).toBe(1);
    expect(runtime.getDraftReviewSnapshot()[0]?.conflict).toStrictEqual({
      server: undefined,
      serverVersion: 2n,
    });
  });

  it("prunes rejected cells independently while retaining the operation remainder", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => current });
    const changeSet = [
      {
        rowId: row.id,
        baseRow: row,
        expectedVersion: 1n,
        changes: [
          {
            columnId: "COL_ID_QUANTITY",
            field: "quantity",
            before: row.quantity,
            after: row.quantity + 1n,
          },
          {
            columnId: "COL_ID_SCORE",
            field: "score",
            before: row.score,
            after: 7,
          },
        ],
      },
    ] as const;

    runtime.rejectSave("operation-partial", changeSet, false);
    current = Object.freeze({ ...row, quantity: row.quantity + 1n });
    runtime.reconcileSourceRows(new Set([row.id]));

    expect(runtime.hasRejectedOperation("operation-partial")).toBe(true);
    expect(runtime.getCellSnapshot(row.id, "COL_ID_QUANTITY").saveFailed).toBeUndefined();
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBe(true);

    current = Object.freeze({ ...current, score: 7 });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.hasRejectedOperation("operation-partial")).toBe(false);
  });

  it("supersedes a rejected Batch operation when its draft is corrected", () => {
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toBeDefined();
    runtime.rejectSave("operation-corrected", changeSet!, false);
    expect(runtime.hasRejectedOperation("operation-corrected")).toBe(true);
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBe(true);
    runtime.subscribeRejectedOperation("operation-corrected", () => undefined)();

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);

    expect(runtime.hasRejectedOperation("operation-corrected")).toBe(false);
    expect(runtime.getRejectedOperationUpdateSnapshot("operation-corrected")).toEqual({
      remainingCount: 0,
      removedCells: [],
    });
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE")).toMatchObject({
      hasDraft: true,
      draft: 8,
    });
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBeUndefined();
  });

  it("retains untouched rejected Batch cells after a partial correction", () => {
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_QUANTITY")).toBe(true);
    expect(runtime.commit(String(row.quantity + 1n))).toBe(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toBeDefined();
    runtime.rejectSave("operation-partial-correction", changeSet!, false);

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);
    expect(runtime.hasRejectedOperation("operation-partial-correction")).toBe(true);
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBeUndefined();
    expect(runtime.getCellSnapshot(row.id, "COL_ID_QUANTITY").saveFailed).toBe(true);

    expect(runtime.start(row.id, "COL_ID_QUANTITY")).toBe(true);
    expect(runtime.commit(String(row.quantity + 2n))).toBe(true);
    expect(runtime.hasRejectedOperation("operation-partial-correction")).toBe(false);
  });

  it("reconciles save evidence with the submitted value equivalence authority", () => {
    type TextRow = Readonly<{ readonly id: string; readonly value: string }>;
    const source: TextRow = { id: "text", value: "foo" };
    const compileTextColumns = (caseInsensitive: boolean) => {
      const valueType: BrunoTableValueType<string> = {
        codecId: "test/submitted-equivalence",
        codecVersion: 1,
        filterFamily: "text",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime: (input) =>
          typeof input === "string"
            ? { _tag: "Success", value: input }
            : { _tag: "Failure", message: "Expected text." },
        equivalent: caseInsensitive
          ? (left, right) => left.toLocaleLowerCase() === right.toLocaleLowerCase()
          : Object.is,
        compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
        formatCanonicalText: String,
        parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
        formatDisplay: String,
        encodePersisted: String,
        decodePersisted: (input) =>
          typeof input === "string"
            ? { _tag: "Success", value: input }
            : { _tag: "Failure", message: "Expected persisted text." },
      };
      return compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType,
          isEditable: true,
        },
      ]);
    };
    const runtime = new BrunoTableCellEditRuntime({
      columns: compileTextColumns(false),
      getRow: () => source,
    });
    const changeSet = [
      {
        rowId: source.id,
        baseRow: source,
        expectedVersion: undefined,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: "foo",
            after: "FOO",
          },
        ],
      },
    ] as const;

    expect(runtime.beginSaveOperation("operation-equivalence", changeSet, false)).toBe(true);
    runtime.acceptSave("operation-equivalence", changeSet, false);
    expect(runtime.getAcceptedOverlayCountForOperation("operation-equivalence")).toBe(1);

    runtime.reconcileColumns(compileTextColumns(true));
    runtime.reconcileSourceRows(new Set([source.id]));
    expect(runtime.getAcceptedOverlayCountForOperation("operation-equivalence")).toBe(1);
  });

  it("reconciles save evidence with the submitted field authority", () => {
    type FieldSwapRow = Readonly<{
      readonly id: string;
      readonly original: string;
      readonly replacement: string;
    }>;
    let source: FieldSwapRow = {
      id: "field-swap",
      original: "before",
      replacement: "saved",
    };
    const compileField = (field: "original" | "replacement") =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field,
          headerName: "Value",
          valueType: "text",
          isEditable: true,
        },
      ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: compileField("original"),
      getRow: () => source,
    });
    const changeSet = [
      {
        rowId: source.id,
        baseRow: source,
        expectedVersion: undefined,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "original",
            before: "before",
            after: "saved",
          },
        ],
      },
    ] as const;

    expect(runtime.beginSaveOperation("operation-field", changeSet, false)).toBe(true);
    runtime.acceptSave("operation-field", changeSet, false);
    runtime.reconcileColumns(compileField("replacement"));
    runtime.reconcileSourceRows(new Set([source.id]));
    expect(runtime.getAcceptedOverlayCountForOperation("operation-field")).toBe(1);

    source = { ...source, original: "saved" };
    runtime.reconcileSourceRows(new Set([source.id]));
    expect(runtime.getAcceptedOverlayCountForOperation("operation-field")).toBe(0);
  });

  it("reconciles save evidence with the submitted decoder authority", () => {
    type DecoderRow = Readonly<{ readonly id: string; readonly value: string }>;
    let source: DecoderRow = { id: "decoder", value: "before" };
    const createValueType = (constantSavedDecoder: boolean): BrunoTableValueType<string> => ({
      codecId: constantSavedDecoder ? "test/replacement-decoder" : "test/submitted-decoder",
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: constantSavedDecoder ? "saved" : input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: Object.is,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: String,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: String,
      encodePersisted: String,
      decodePersisted: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected persisted text." },
    });
    const compileDecoder = (constantSavedDecoder: boolean) =>
      compileColumns([
        {
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          valueType: createValueType(constantSavedDecoder),
          isEditable: true,
        },
      ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns: compileDecoder(false),
      getRow: () => source,
    });
    const changeSet = [
      {
        rowId: source.id,
        baseRow: source,
        expectedVersion: undefined,
        changes: [
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            before: "before",
            after: "saved",
          },
        ],
      },
    ] as const;

    expect(runtime.beginSaveOperation("operation-decoder", changeSet, false)).toBe(true);
    runtime.acceptSave("operation-decoder", changeSet, false);
    runtime.reconcileColumns(compileDecoder(true));
    runtime.reconcileSourceRows(new Set([source.id]));
    expect(runtime.getAcceptedOverlayCountForOperation("operation-decoder")).toBe(1);

    source = { ...source, value: "saved" };
    runtime.reconcileSourceRows(new Set([source.id]));
    expect(runtime.getAcceptedOverlayCountForOperation("operation-decoder")).toBe(0);
  });

  it("keeps Immediate candidates and save preflight closed while the source is non-authoritative", () => {
    let authoritative = true;
    const onCommit = vi.fn();
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      isSourceAuthoritative: () => authoritative,
      onCommit,
    });

    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    authoritative = false;
    expect(runtime.commit("7")).toBe(false);
    expect(runtime.getSessionSnapshot().kind).toBe("editing");
    expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBeUndefined();
    expect(onCommit).not.toHaveBeenCalled();

    authoritative = true;
    expect(runtime.commit("7")).toBe(true);
    expect(onCommit).toHaveBeenCalledOnce();
    const gesture = [onCommit.mock.calls[0]![0]] as BrunoTableCellEditChangeGesture;
    authoritative = false;
    expect(runtime.createImmediateSaveChangeSet(gesture)).toEqual({ kind: "rejected" });
    expect(runtime.createBatchSaveChangeSet()).toBeUndefined();

    const onCommitGesture = vi.fn();
    const gestureRuntime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      isSourceAuthoritative: () => false,
      onCommitGesture,
    });
    expect(
      gestureRuntime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: row.quantity,
          base: row.score,
          mine: 7,
        },
      ]),
    ).toBe(false);
    expect(gestureRuntime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBeUndefined();
    expect(onCommitGesture).not.toHaveBeenCalled();
  });

  it("keeps Immediate save preflight closed after live edit permission is revoked", () => {
    let editable = true;
    const permissionColumns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
        isEditable: () => editable,
      },
    ]);
    const onCommit = vi.fn();
    const runtime = new BrunoTableCellEditRuntime({
      columns: permissionColumns,
      getRow: () => row,
      getRowVersion: () => row.quantity,
      onCommit,
    });
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const gesture = [onCommit.mock.calls[0]![0]] as BrunoTableCellEditChangeGesture;

    editable = false;

    expect(runtime.createImmediateSaveChangeSet(gesture)).toEqual({ kind: "rejected" });
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1 });
  });

  it("expires staggered rejected-cell success flashes independently", () => {
    let unsubscribeA = (): void => undefined;
    let unsubscribeB = (): void => undefined;
    const rows = new Map<string, Row>([
      ["row-a", Object.freeze({ ...row, id: "row-a" })],
      ["row-b", Object.freeze({ ...row, id: "row-b" })],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
    });
    const changeSet = Object.freeze(
      [...rows].map(([rowId, baseRow]) =>
        Object.freeze({
          rowId,
          baseRow,
          expectedVersion: 1n,
          changes: Object.freeze([
            Object.freeze({
              columnId: "COL_ID_SCORE",
              field: "score",
              before: baseRow.score,
              after: 7,
            }),
          ]),
        }),
      ),
    ) as BrunoTableCellEditSaveChangeSet;

    try {
      vi.useFakeTimers();
      unsubscribeA = runtime.subscribeCell("row-a", "COL_ID_SCORE", () => undefined);
      unsubscribeB = runtime.subscribeCell("row-b", "COL_ID_SCORE", () => undefined);
      runtime.rejectSave("operation-staggered", changeSet, false);
      rows.set("row-a", Object.freeze({ ...row, id: "row-a", score: 7 }));
      runtime.reconcileSourceRows(new Set(["row-a"]));
      expect(runtime.getCellSnapshot("row-a", "COL_ID_SCORE").saveSucceeded).toBe(true);

      vi.advanceTimersByTime(1_500);
      rows.set("row-b", Object.freeze({ ...row, id: "row-b", score: 7 }));
      runtime.reconcileSourceRows(new Set(["row-b"]));
      expect(runtime.getCellSnapshot("row-b", "COL_ID_SCORE").saveSucceeded).toBe(true);

      vi.advanceTimersByTime(500);
      expect(runtime.getCellSnapshot("row-a", "COL_ID_SCORE").saveSucceeded).toBeUndefined();
      expect(runtime.getCellSnapshot("row-b", "COL_ID_SCORE").saveSucceeded).toBe(true);
      vi.advanceTimersByTime(1_500);
      expect(runtime.getCellSnapshot("row-b", "COL_ID_SCORE").saveSucceeded).toBeUndefined();
    } finally {
      unsubscribeA();
      unsubscribeB();
      vi.useRealTimers();
    }
  });

  it("bounds Immediate rejection presentation to five seconds without dropping evidence", () => {
    vi.useFakeTimers();
    try {
      const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
      const changeSet = [
        {
          rowId: row.id,
          baseRow: row,
          expectedVersion: 1n,
          changes: [
            {
              columnId: "COL_ID_SCORE",
              field: "score",
              before: row.score,
              after: 7,
            },
          ],
        },
      ] as const;

      runtime.rejectSave("operation-timeout", changeSet, true);
      expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBe(true);
      vi.advanceTimersByTime(4_999);
      expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBe(true);
      vi.advanceTimersByTime(1);
      expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").saveFailed).toBeUndefined();
      expect(runtime.hasRejectedOperation("operation-timeout")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain a rejection deadline for a fully converged Immediate operation", () => {
    vi.useFakeTimers();
    try {
      let source = row;
      const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => source });
      const changeSet = [
        {
          rowId: row.id,
          baseRow: row,
          expectedVersion: 1n,
          changes: [
            {
              columnId: "COL_ID_SCORE",
              field: "score",
              before: row.score,
              after: 7,
            },
          ],
        },
      ] as const;

      expect(runtime.beginSaveOperation("operation-converged", changeSet, false)).toBe(true);
      source = Object.freeze({ ...row, score: 7 });
      runtime.reconcileSourceRows(new Set([row.id]));
      runtime.rejectSave("operation-converged", changeSet, true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds rejected operation evidence to the latest 128 operations", () => {
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => row });
    for (let index = 0; index < 129; index += 1) {
      runtime.rejectSave(
        `operation-${String(index)}`,
        [
          {
            rowId: row.id,
            baseRow: row,
            expectedVersion: 1n,
            changes: [
              {
                columnId: "COL_ID_SCORE",
                field: "score",
                before: row.score,
                after: index + 20,
              },
            ],
          },
        ],
        false,
      );
      if (index === 0) runtime.subscribeRejectedOperation("operation-0", () => undefined)();
    }

    expect(runtime.hasRejectedOperation("operation-0")).toBe(false);
    expect(runtime.getRejectedOperationUpdateSnapshot("operation-0")).toEqual({
      remainingCount: 0,
      removedCells: [],
    });
    expect(runtime.hasRejectedOperation("operation-1")).toBe(true);
    expect(runtime.hasRejectedOperation("operation-128")).toBe(true);
  });

  it("does not retain unmounted cell stores while rejected evidence is bounded", () => {
    const rows = new Map<string, Row>(
      Array.from({ length: 129 }, (_, index) => {
        const id = `row-${String(index)}`;
        return [id, Object.freeze({ ...row, id })];
      }),
    );
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
    });

    for (let index = 0; index < 129; index += 1) {
      const rowId = `row-${String(index)}`;
      const current = rows.get(rowId)!;
      const unsubscribe = runtime.subscribeCell(rowId, "COL_ID_SCORE", () => undefined);
      runtime.rejectSave(
        `operation-${String(index)}`,
        [
          {
            rowId,
            baseRow: current,
            expectedVersion: current.quantity,
            changes: [
              {
                columnId: "COL_ID_SCORE",
                field: "score",
                before: current.score,
                after: index + 20,
              },
            ],
          },
        ],
        false,
      );
      unsubscribe();
    }

    expect(runtime.hasRejectedOperation("operation-0")).toBe(false);
    expect(runtime.getRetainedCellStoreCount()).toBe(0);
  });

  it("traverses changed rows once when sparse rejected operations overlap a large gesture", () => {
    const rowCount = 5_000;
    const rejectedCount = 128;
    const rows = new Map<string, Row>(
      Array.from({ length: rowCount }, (_, index) => {
        const id = `row-${String(index)}`;
        return [id, Object.freeze({ ...row, id })];
      }),
    );
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => rows.get(rowId),
    });
    for (let index = 0; index < rejectedCount; index += 1) {
      const current = rows.get(`row-${String(index)}`)!;
      runtime.rejectSave(
        `operation-${String(index)}`,
        [
          {
            rowId: current.id,
            baseRow: current,
            expectedVersion: current.quantity,
            changes: [
              {
                columnId: "COL_ID_SCORE",
                field: "score",
                before: current.score,
                after: current.score + 1,
              },
            ],
          },
        ],
        false,
      );
    }
    class CountingSet extends Set<string> {
      public iteratorCount = 0;

      public override [Symbol.iterator](): SetIterator<string> {
        this.iteratorCount += 1;
        return super[Symbol.iterator]();
      }
    }
    const changedRowIds = new CountingSet(rows.keys());

    runtime.reconcileSourceRows(changedRowIds);

    expect(changedRowIds.iteratorCount).toBeLessThanOrEqual(4);
  });

  it("retains rejected Batch drafts when their column schema changes after rejection", () => {
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: () => row.quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet()!;
    expect(runtime.beginSaveOperation("rejected-batch", changeSet, true)).toBe(true);
    runtime.rejectSave("rejected-batch", changeSet, false);
    runtime.completeSaveOperation("rejected-batch");

    runtime.reconcileColumns(columns.filter((column) => column.columnId !== "COL_ID_SCORE"));

    expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBe(7);
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 1,
      undoCount: 1,
      blockedCount: 1,
    });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      {
        rowId: row.id,
        columnId: "COL_ID_SCORE",
        mine: 7,
        blockedReason: expect.stringContaining("Changes cannot be saved"),
      },
    ]);
  });

  it("safely rebases an unchanged edited field onto the latest row and Row Version", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);

    current = Object.freeze({ ...row, quantity: row.quantity + 1n });
    expect(runtime.createBatchSaveChangeSet()).toEqual([
      {
        rowId: row.id,
        baseRow: current,
        expectedVersion: current.quantity,
        changes: [
          {
            columnId: "COL_ID_SCORE",
            field: "score",
            before: row.score,
            after: 7,
          },
        ],
      },
    ]);
  });

  it("blocks dirty rows while Row Version extraction fails and clears the block on recovery", () => {
    let extractorAvailable = true;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: () => 1n,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);

    runtime.setRowVersionExtractor(() => {
      if (!extractorAvailable) throw new Error("Row Version unavailable");
      return 2n;
    });
    extractorAvailable = false;
    runtime.reconcileSourceRows(new Set([row.id]));

    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1 });
    expect(runtime.getDraftReviewSnapshot()).toMatchObject([
      { mine: 7, blockedReason: expect.stringContaining("Row Version") },
    ]);
    expect(runtime.createBatchSaveChangeSet()).toBeUndefined();
    expect(runtime.undoBatchDraft()).toBe(true);
    expect(runtime.redoBatchDraft()).toBe(true);
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1 });

    extractorAvailable = true;
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 0 });
    expect(runtime.createBatchSaveChangeSet()?.[0]?.expectedVersion).toBe(2n);
  });

  it("revalidates only Row Version-blocked rows when the extractor changes", () => {
    const second = Object.freeze({ ...row, id: "row-2", score: 5 });
    const byId = new Map([
      [row.id, row],
      [second.id, second],
    ]);
    const getRow = vi.fn((rowId: string) => byId.get(rowId));
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow,
      getRowVersion: () => 1n,
    });
    runtime.setBatchHistoryEnabled(true);
    for (const [rowId, mine] of [
      [row.id, "7"],
      [second.id, "8"],
    ] as const) {
      expect(runtime.start(rowId, "COL_ID_SCORE")).toBe(true);
      expect(runtime.commit(mine)).toBe(true);
    }

    runtime.setRowVersionExtractor((candidate) => {
      if (candidate === row) throw new Error("Row Version unavailable");
      return 1n;
    });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1 });

    getRow.mockClear();
    runtime.setRowVersionExtractor(() => 2n);

    expect(getRow.mock.calls.map(([rowId]) => rowId)).toEqual([row.id]);
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 0, draftCount: 2 });
  });

  it("refreshes unresolved conflict evidence when the Row Version extractor changes", () => {
    let current = row;
    let version = 1n;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: () => version,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);

    current = Object.freeze({ ...row, score: 6 });
    version = 2n;
    runtime.reconcileSourceRows(new Set([row.id]));
    const before = runtime.getDraftReviewSnapshot()[0]!;
    expect(before.conflict).toMatchObject({ server: 6, serverVersion: 2n });

    runtime.setRowVersionExtractor(() => 3n);

    const after = runtime.getDraftReviewSnapshot()[0]!;
    expect(after.conflict).toMatchObject({ server: 6, serverVersion: 3n });
    expect(runtime.canResolveDraftConflict(after.id)).toBe(true);
    expect(
      runtime.resolveDraftConflicts([
        {
          id: after.id,
          resolution: "mine",
          reviewedServer: after.conflict!.server,
          reviewedServerVersion: after.conflict!.serverVersion,
        },
      ]),
    ).toBe(true);
  });

  it("drops a Row Version-blocked row index when its final evidence converges", () => {
    const second = Object.freeze({ ...row, id: "row-2", score: 5 });
    const byId = new Map<string, Row>([
      [row.id, row],
      [second.id, second],
    ]);
    const getRow = vi.fn((rowId: string) => byId.get(rowId));
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow,
      getRowVersion: () => 1n,
    });
    runtime.setBatchHistoryEnabled(true);
    for (const [rowId, mine] of [
      [row.id, "7"],
      [second.id, "8"],
    ] as const) {
      expect(runtime.start(rowId, "COL_ID_SCORE")).toBe(true);
      expect(runtime.commit(mine)).toBe(true);
    }
    runtime.setRowVersionExtractor((candidate) => {
      if (candidate === row) throw new Error("Row Version unavailable");
      return 1n;
    });
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 1, draftCount: 2 });

    byId.set(row.id, Object.freeze({ ...row, score: 7 }));
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getActivitySnapshot()).toMatchObject({ blockedCount: 0, draftCount: 1 });

    getRow.mockClear();
    runtime.setRowVersionExtractor(() => 2n);
    expect(getRow).not.toHaveBeenCalled();
  });

  it("groups a Batch Save Change Set by stable Row Identity", () => {
    const second = Object.freeze({ ...row, id: "row-2", score: 5 });
    const byId = new Map([
      [row.id, row],
      [second.id, second],
    ]);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: (rowId) => byId.get(rowId),
      getRowVersion: (candidate) => (candidate as Row).quantity,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    expect(runtime.start(second.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("8")).toBe(true);

    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet?.map((rowChange) => rowChange.rowId)).toEqual([row.id, second.id]);
    expect(changeSet?.map((rowChange) => rowChange.changes.length)).toEqual([1, 1]);
  });

  it("yields Accepted Overlays on Row Version difference and disappearance", () => {
    let current: Row | undefined = row;
    let version = 1n;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: () => version,
    });
    const changeSet = [
      {
        rowId: row.id,
        baseRow: row,
        expectedVersion: 1n,
        changes: [
          {
            columnId: "COL_ID_SCORE",
            field: "score",
            before: row.score,
            after: 7,
          },
        ],
      },
    ] as const;

    runtime.acceptSave("operation-version", changeSet, false);
    version = 2n;
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getAcceptedOverlayCountForOperation("operation-version")).toBe(0);

    runtime.acceptSave("operation-disappearance", changeSet, false);
    current = undefined;
    runtime.reconcileSourceRows(new Set([row.id]));
    expect(runtime.getAcceptedOverlayCountForOperation("operation-disappearance")).toBe(0);
  });

  it("reconciles rejected evidence when its authoritative row disappears", () => {
    let current: Row | undefined = row;
    const runtime = new BrunoTableCellEditRuntime({ columns, getRow: () => current });
    const changeSet = [
      {
        rowId: row.id,
        baseRow: row,
        expectedVersion: row.quantity,
        changes: [
          {
            columnId: "COL_ID_SCORE",
            field: "score",
            before: row.score,
            after: 7,
          },
        ],
      },
    ] as const;

    runtime.rejectSave("operation-disappearance", changeSet, true);
    expect(runtime.hasRejectedOperation("operation-disappearance")).toBe(true);
    current = undefined;
    runtime.reconcileSourceRows(new Set([row.id]));

    expect(runtime.hasRejectedOperation("operation-disappearance")).toBe(false);
    expect(runtime.getCellSnapshot(row.id, "COL_ID_SCORE")).toEqual({
      active: false,
      hasDraft: false,
    });
  });

  it("refuses a fresh Save preflight and records a conflict when an edited Base diverges", () => {
    let current = row;
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => current,
      getRowVersion: () => 1n,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);

    current = Object.freeze({ ...row, score: 5 });
    expect(runtime.createBatchSaveChangeSet()).toBeUndefined();
    expect(runtime.getActivitySnapshot()).toMatchObject({
      draftCount: 1,
      conflictCount: 1,
      undoCount: 1,
    });
  });

  it("publishes one atomic Immediate operation for a multi-cell accepted gesture", () => {
    const onCommitGesture = vi.fn();
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: () => 1n,
      onCommitGesture,
    });
    const gesture = [
      {
        rowId: row.id,
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        baseRow: row,
        expectedVersion: 1n,
        base: row.quantity,
        mine: row.quantity + 1n,
      },
      {
        rowId: row.id,
        columnId: "COL_ID_SCORE",
        field: "score",
        baseRow: row,
        expectedVersion: 1n,
        base: row.score,
        mine: 7,
      },
    ] as const;

    expect(runtime.applyAcceptedDraftGesture(gesture)).toBe(true);
    expect(onCommitGesture).toHaveBeenCalledOnce();
    const committed = onCommitGesture.mock.calls[0]![0];
    expect(runtime.createImmediateSaveChangeSet(committed)).toEqual({
      kind: "change-set",
      changeSet: [
        {
          rowId: row.id,
          baseRow: row,
          expectedVersion: 1n,
          changes: [
            {
              columnId: "COL_ID_QUANTITY",
              field: "quantity",
              before: row.quantity,
              after: row.quantity + 1n,
            },
            {
              columnId: "COL_ID_SCORE",
              field: "score",
              before: row.score,
              after: 7,
            },
          ],
        },
      ],
    });
  });

  it("does not materialize an Immediate operation for an accepted Batch gesture", () => {
    const onCommitGesture = vi.fn();
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: () => 1n,
      onCommitGesture,
    });
    runtime.setBatchHistoryEnabled(true);

    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_SCORE",
          field: "score",
          baseRow: row,
          expectedVersion: 1n,
          base: row.score,
          mine: 7,
        },
      ]),
    ).toBe(true);
    expect(onCommitGesture).not.toHaveBeenCalled();
    expect(runtime.createBatchSaveChangeSet()).toHaveLength(1);
  });

  it("completes paste availability preflight before invoking any parser or validator", () => {
    const scoreColumn = columns.find((column) => column.columnId === "COL_ID_SCORE")!;
    if (scoreColumn.kind !== "field") throw new Error("score fixture must be a field column");
    const parseCanonicalText = vi.fn(scoreColumn.semantics.parseCanonicalText);
    const validate = vi.fn(scoreColumn.validate);
    const runtime = new BrunoTableCellEditRuntime({
      columns: [
        {
          ...scoreColumn,
          semantics: { ...scoreColumn.semantics, parseCanonicalText },
          validate,
        },
      ],
      getRow: (rowId) => (rowId === row.id ? row : undefined),
      getRowVersion: () => 1n,
    });

    expect(
      runtime.applyCanonicalTextGesture([
        { rowId: row.id, columnId: "COL_ID_SCORE", canonicalText: "7" },
        { rowId: "missing-row", columnId: "COL_ID_SCORE", canonicalText: "8" },
      ]),
    ).toMatchObject({
      kind: "rejected",
      reason: "unavailable",
      rowId: "missing-row",
      columnId: "COL_ID_SCORE",
    });
    expect(parseCanonicalText).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, undoCount: 0 });
  });

  it("treats empty canonical Select paste as the configured nullish blank intent", () => {
    type ChoiceRow = Readonly<{
      readonly id: string;
      readonly choice: "ready" | null | undefined;
    }>;
    const choiceRow: ChoiceRow = { id: "choice", choice: "ready" };

    for (const blankValue of [null, undefined] as const) {
      const runtime = new BrunoTableCellEditRuntime({
        columns: compileColumns([
          BrunoTableSelectColumn({
            columnId: "COL_ID_CHOICE",
            field: "choice",
            headerName: "Choice",
            options: ["ready"] as const,
            isEditable: true,
            blankValue,
          }),
        ] satisfies BrunoTableColumns<ChoiceRow>),
        getRow: () => choiceRow,
      });
      runtime.setBatchHistoryEnabled(true);

      expect(
        runtime.applyCanonicalTextGesture([
          { rowId: choiceRow.id, columnId: "COL_ID_CHOICE", canonicalText: "" },
        ]),
      ).toEqual({ kind: "accepted" });
      const snapshot = runtime.getCellSnapshot(choiceRow.id, "COL_ID_CHOICE");
      expect(snapshot).toMatchObject({
        hasDraft: true,
        draft: blankValue,
      });
      expect(Object.hasOwn(snapshot, "draft")).toBe(true);
      expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, undoCount: 1 });
    }
  });

  it("uses nullish draft presence during complete paste availability preflight", () => {
    type OptionalRow = Readonly<{
      readonly id: string;
      readonly value: string | null | undefined;
    }>;
    const optionalRow: OptionalRow = { id: "optional", value: "source" };

    for (const mine of [null, undefined] as const) {
      const parseCanonicalText = vi.fn((text: string) => ({
        _tag: "Success" as const,
        value: text,
      }));
      const validate = vi.fn(
        (_context: { readonly row: OptionalRow; readonly value: string | null | undefined }) =>
          undefined,
      );
      const optionalValueType: BrunoTableValueType<string> = {
        codecId: `test/paste-nullish-presence-${String(mine)}`,
        codecVersion: 1,
        filterFamily: "text",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        defaultWidth: 120,
        decodeRuntime: (input) =>
          typeof input === "string"
            ? { _tag: "Success", value: input }
            : { _tag: "Failure", message: "Expected text." },
        equivalent: Object.is,
        compare: (left, right) => {
          const comparison = String(left).localeCompare(String(right));
          return comparison === 0 ? 0 : comparison < 0 ? -1 : 1;
        },
        formatCanonicalText: (value) => String(value),
        parseCanonicalText,
        formatDisplay: (value) => String(value),
        encodePersisted: (value) => value,
        decodePersisted: (input) =>
          typeof input === "string"
            ? { _tag: "Success", value: input }
            : { _tag: "Failure", message: "Expected persisted text." },
      };
      const runtime = new BrunoTableCellEditRuntime({
        columns: compileColumns([
          {
            columnId: "COL_ID_VALUE",
            field: "value",
            headerName: "Value",
            valueType: optionalValueType,
            blankValue: mine,
            isEditable: ({
              value,
            }: {
              readonly row: OptionalRow;
              readonly value: string | null | undefined;
            }) => !Object.is(value, mine),
            validate,
          },
        ] satisfies BrunoTableColumns<OptionalRow>),
        getRow: () => optionalRow,
      });
      runtime.setBatchHistoryEnabled(true);
      expect(
        runtime.applyAcceptedDraftGesture([
          {
            rowId: optionalRow.id,
            columnId: "COL_ID_VALUE",
            field: "value",
            baseRow: optionalRow,
            expectedVersion: undefined,
            base: optionalRow.value,
            mine,
          },
        ]),
      ).toBe(true);

      expect(
        runtime.applyCanonicalTextGesture([
          { rowId: optionalRow.id, columnId: "COL_ID_VALUE", canonicalText: "next" },
        ]),
      ).toMatchObject({ kind: "rejected", reason: "read-only" });
      expect(parseCanonicalText).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      expect(runtime.getCellSnapshot(optionalRow.id, "COL_ID_VALUE")).toMatchObject({
        hasDraft: true,
        draft: mine,
      });
      expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 1, undoCount: 1 });
    }
  });

  it("retains nullish Base and Row Version evidence while replacing an existing draft", () => {
    type NullableRow = Readonly<{
      readonly id: string;
      readonly value: "draft" | "server" | null;
    }>;
    const initialRow: NullableRow = { id: "nullable", value: null };
    let liveRow = initialRow;
    let liveVersion: unknown = undefined;
    const runtime = new BrunoTableCellEditRuntime({
      columns: compileColumns([
        BrunoTableSelectColumn({
          columnId: "COL_ID_VALUE",
          field: "value",
          headerName: "Value",
          options: ["draft", "server"] as const,
          blankValue: null,
          isEditable: true,
        }),
      ] satisfies BrunoTableColumns<NullableRow>),
      getRow: () => liveRow,
      getRowVersion: () => liveVersion,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(
      runtime.applyAcceptedDraftGesture([
        {
          rowId: initialRow.id,
          columnId: "COL_ID_VALUE",
          field: "value",
          baseRow: initialRow,
          expectedVersion: undefined,
          base: null,
          mine: "draft",
        },
      ]),
    ).toBe(true);

    liveRow = { id: initialRow.id, value: "server" };
    liveVersion = "version-2";
    expect(
      runtime.applyCanonicalTextGesture([
        { rowId: initialRow.id, columnId: "COL_ID_VALUE", canonicalText: "server" },
      ]),
    ).toEqual({ kind: "accepted" });
    expect(runtime.getCellSnapshot(initialRow.id, "COL_ID_VALUE")).toMatchObject({
      hasDraft: true,
      draft: "server",
    });
    expect(runtime.getDraftReviewSnapshot()).toEqual([
      expect.objectContaining({
        rowId: initialRow.id,
        columnId: "COL_ID_VALUE",
        baseRow: initialRow,
        expectedVersion: undefined,
        base: null,
        mine: "server",
      }),
    ]);
  });

  it("rejects all-no-op Paste gestures with first-target evidence in both edit modes", () => {
    for (const batch of [false, true]) {
      const onCommitGesture = vi.fn();
      const runtime = new BrunoTableCellEditRuntime({
        columns,
        getRow: () => row,
        getRowVersion: () => 1n,
        onCommitGesture,
      });
      runtime.setBatchHistoryEnabled(batch);

      expect(
        runtime.applyCanonicalTextGesture([
          { rowId: row.id, columnId: "COL_ID_SCORE", canonicalText: String(row.score) },
        ]),
      ).toEqual({
        kind: "rejected",
        reason: "unchanged",
        rowId: row.id,
        columnId: "COL_ID_SCORE",
      });
      expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, undoCount: 0 });
      expect(onCommitGesture).not.toHaveBeenCalled();
    }
  });

  it("reports every destination as save-locked during an active Batch Save without mutating edit state", () => {
    const onCommitGesture = vi.fn();
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: () => 1n,
      onCommitGesture,
    });
    runtime.setBatchHistoryEnabled(true);
    expect(runtime.start(row.id, "COL_ID_SCORE")).toBe(true);
    expect(runtime.commit("7")).toBe(true);
    const changeSet = runtime.createBatchSaveChangeSet();
    expect(changeSet).toBeDefined();
    expect(runtime.beginSaveOperation("batch-lock", changeSet!, true)).toBe(true);
    const activityBefore = runtime.getActivitySnapshot();
    const draftsBefore = runtime.getDraftMemorySnapshot();

    expect(
      runtime.applyCanonicalTextGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_QUANTITY",
          canonicalText: "9007199254740994",
        },
        { rowId: row.id, columnId: "COL_ID_SCORE", canonicalText: "8" },
      ]),
    ).toEqual({
      kind: "rejected",
      reason: "save-locked",
      rowId: row.id,
      columnId: "COL_ID_QUANTITY",
      additionalInvalidCount: 1,
    });
    expect(runtime.getActivitySnapshot()).toBe(activityBefore);
    expect(runtime.getDraftMemorySnapshot()).toBe(draftsBefore);
    expect(runtime.hasSaveCellProjection(row.id, "COL_ID_QUANTITY")).toBe(false);
    expect(runtime.hasSaveCellProjection(row.id, "COL_ID_SCORE")).toBe(true);
    expect(onCommitGesture).not.toHaveBeenCalled();
  });

  it("reports a refused Immediate Paste admission as temporarily unavailable", () => {
    const onCommitGesture = vi.fn(() => "rejected" as const);
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: () => 1n,
      onCommitGesture,
    });

    expect(
      runtime.applyCanonicalTextGesture([
        { rowId: row.id, columnId: "COL_ID_SCORE", canonicalText: "7" },
      ]),
    ).toEqual({ kind: "rejected", reason: "temporarily-unavailable" });
    expect(onCommitGesture).toHaveBeenCalledOnce();
    expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, undoCount: 0 });
  });

  it("rolls back an Immediate Paste when save admission throws", () => {
    const runtime = new BrunoTableCellEditRuntime({
      columns,
      getRow: () => row,
      getRowVersion: () => 1n,
      onCommitGesture: () => {
        throw new Error("save admission failed");
      },
    });
    const scoreDraftObservations: boolean[] = [];
    const quantityDraftObservations: boolean[] = [];
    const unsubscribeScore = runtime.subscribeCell(row.id, "COL_ID_SCORE", () => {
      scoreDraftObservations.push(runtime.getCellSnapshot(row.id, "COL_ID_SCORE").hasDraft);
    });
    const unsubscribeQuantity = runtime.subscribeCell(row.id, "COL_ID_QUANTITY", () => {
      quantityDraftObservations.push(runtime.getCellSnapshot(row.id, "COL_ID_QUANTITY").hasDraft);
    });

    try {
      expect(
        runtime.applyCanonicalTextGesture([
          { rowId: row.id, columnId: "COL_ID_SCORE", canonicalText: "7" },
          {
            rowId: row.id,
            columnId: "COL_ID_QUANTITY",
            canonicalText: "9007199254740994",
          },
        ]),
      ).toEqual({ kind: "rejected", reason: "temporarily-unavailable" });
      expect(runtime.getActivitySnapshot()).toMatchObject({ draftCount: 0, undoCount: 0 });
      expect(runtime.getDraftSnapshot(row.id, "COL_ID_SCORE")).toBeUndefined();
      expect(runtime.getDraftSnapshot(row.id, "COL_ID_QUANTITY")).toBeUndefined();
      expect(scoreDraftObservations).not.toContain(true);
      expect(quantityDraftObservations).not.toContain(true);
    } finally {
      unsubscribeScore();
      unsubscribeQuantity();
    }
  });
});
