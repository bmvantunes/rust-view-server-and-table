import type { CompiledColumn, CompiledFieldColumn } from "./compile-columns";

export type BrunoTableCellEditTraversalRowSpace = Readonly<{
  readonly totalRows: number;
  readonly getRowId: (rowIndex: number) => string | undefined;
}>;

export type BrunoTableCellEditTraversalDestination = Readonly<{
  readonly rowIndex: number;
  readonly rowId: string;
  readonly columnId: string;
}>;

export type BrunoTableCellEditTraversalRange =
  | Readonly<{
      readonly axis: "horizontal";
      readonly rowId: string;
      readonly columnIds: readonly string[];
    }>
  | Readonly<{
      readonly axis: "vertical";
      readonly columnId: string;
      readonly rowIds: readonly string[];
    }>;

type RowCache = {
  row: object;
  validationGeneration: number;
  eligiblePredicateColumnIds: Set<string> | undefined;
};

type UnknownProjection = {
  readonly rowSpace: BrunoTableCellEditTraversalRowSpace;
  readonly rowIds: (string | undefined)[];
  readonly rowIndexById: Map<string, number>;
  readonly validRowIndexes: number[];
  readonly eligiblePredicateRowIndexes: number[];
  readonly pendingRowIndexes: number[];
  readonly pendingRowIndexSet: Set<number>;
  readonly pendingDetachedRowIds: string[];
  readonly pendingDetachedRowIdSet: Set<string>;
  readonly claimedDirtyRowIds: Set<string>;
  claimedCachedRowCount: number;
  dirtyRowIterator: IterableIterator<string> | undefined;
  rowIndex: number;
};

const SYNCHRONOUS_INITIAL_PREDICATE_CELL_LIMIT = 1_024;
export const BRUNO_TABLE_CELL_EDIT_TRAVERSAL_SLICE_PREDICATE_CELL_LIMIT = 4_096;
export const BRUNO_TABLE_CELL_EDIT_TRAVERSAL_SLICE_TIME_LIMIT_MS = 2;
// Conservatively charge native row reads and projection writes against the predicate-cell budget.
export const BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST = 16;

function hasValueDependentEditEligibility(column: CompiledFieldColumn): boolean {
  return (
    column.semantics.editorFamily === "boolean" &&
    column.semantics.booleanEditorCanonicalValues !== undefined &&
    column.semantics.booleanEditorDomainExhaustive !== true
  );
}

function hasSameValueEligibilityAuthority(
  left: CompiledFieldColumn,
  right: CompiledFieldColumn,
): boolean {
  if (left.semantics.decodeRuntimeAuthority !== right.semantics.decodeRuntimeAuthority)
    return false;
  const leftValues = left.semantics.booleanEditorCanonicalValues;
  const rightValues = right.semantics.booleanEditorCanonicalValues;
  if (leftValues === undefined && rightValues === undefined) return true;
  return (
    leftValues !== undefined &&
    rightValues !== undefined &&
    leftValues[0] === rightValues[0] &&
    leftValues[1] === rightValues[1] &&
    left.semantics.booleanEditorDomainExhaustive ===
      right.semantics.booleanEditorDomainExhaustive &&
    left.semantics.editSessionAuthority.formatCanonicalText ===
      right.semantics.editSessionAuthority.formatCanonicalText &&
    (left.blankValue !== undefined) === (right.blankValue !== undefined) &&
    Object.is(left.blankValue?.value, right.blankValue?.value)
  );
}

function hasSamePredicateAuthority(
  left: CompiledFieldColumn,
  right: CompiledFieldColumn | undefined,
): boolean {
  return (
    right !== undefined &&
    left.field === right.field &&
    left.isEditable === right.isEditable &&
    hasSameValueEligibilityAuthority(left, right)
  );
}

function hasSameTraversalAuthority(
  previous: readonly CompiledColumn[] | undefined,
  next: readonly CompiledColumn[],
): boolean {
  if (previous === undefined || previous.length !== next.length) return false;
  return previous.every((column, columnIndex) => {
    const nextColumn = next[columnIndex];
    if (
      nextColumn === undefined ||
      column.columnId !== nextColumn.columnId ||
      column.kind !== nextColumn.kind
    ) {
      return false;
    }
    return (
      column.kind !== "field" ||
      (nextColumn.kind === "field" &&
        column.field === nextColumn.field &&
        column.isEditable === nextColumn.isEditable &&
        hasSameValueEligibilityAuthority(column, nextColumn))
    );
  });
}

function enqueueUnknownProjectionRow(projection: UnknownProjection, rowIndex: number): void {
  if (projection.pendingRowIndexSet.has(rowIndex)) return;
  projection.pendingRowIndexSet.add(rowIndex);
  projection.pendingRowIndexes.push(rowIndex);
}

function* dirtyRowAuthorities(
  pendingRowIds: ReadonlySet<string>,
  incomingRowIds: ReadonlySet<string>,
): IterableIterator<string> {
  yield* pendingRowIds;
  yield* incomingRowIds;
}

export class BrunoTableCellEditTraversalIndex {
  private columns: readonly CompiledColumn[] | undefined;
  private rowSpace: BrunoTableCellEditTraversalRowSpace | undefined;
  private rowIds: readonly (string | undefined)[] = [];
  private rowIndexById = new Map<string, number>();
  private readonly columnIndexById = new Map<string, number>();
  private readonly rowCacheById = new Map<string, RowCache>();
  private readonly eligiblePredicateRowIdsByColumnId = new Map<string, Set<string>>();
  private staticColumnIndexes: readonly number[] = [];
  private predicateColumns: readonly Readonly<{
    readonly column: CompiledFieldColumn;
    readonly columnIndex: number;
  }>[] = [];
  private predicateColumnsById = new Map<string, CompiledFieldColumn>();
  private validRowIndexes: number[] = [];
  private eligiblePredicateRowIndexes: number[] = [];
  private readonly dirtyColumnIdsByRowId = new Map<string, string | Set<string>>();
  private dirtyRowIds = new Set<string>();
  private verticalRangeCache:
    | {
        readonly range: Extract<BrunoTableCellEditTraversalRange, { readonly axis: "vertical" }>;
        readonly rangeIndexByRowId: ReadonlyMap<string, number>;
        readonly destinations: BrunoTableCellEditTraversalDestination[];
      }
    | undefined;
  private allRowsDirty = false;
  private validationGeneration = 0;
  private pendingRowIndexes: number[] = [];
  private pendingRowIndexSet = new Set<number>();
  private pendingRowCursor = 0;
  private pendingDetachedRowIds: string[] = [];
  private pendingDetachedRowIdSet = new Set<string>();
  private pendingDetachedRowCursor = 0;
  private pendingDirtyRowIds = new Set<string>();
  private pendingPredicateAuthorityRowIterator: IterableIterator<string> | undefined;
  private readonly pendingPredicateAuthorityColumnIds = new Set<string>();
  private pendingPredicateAuthorityEligibleRowIndexes: number[] | undefined;
  private pendingPredicateAuthorityProjectionRowIndex = 0;
  private unknownDiscoveryIterator: IterableIterator<[string, RowCache]> | undefined;
  private unknownDirtyRestorationIterator: IterableIterator<string> | undefined;
  private unknownProjection: UnknownProjection | undefined;
  private unknownDiscoveryRequired = false;

  public constructor(
    private readonly getRow: (rowId: string) => unknown,
    private readonly evaluatePredicate: (
      rowId: string,
      row: object,
      column: CompiledFieldColumn,
    ) => boolean,
    private readonly incrementalBuild = false,
  ) {}

  public readonly reconcile = (
    columns: readonly CompiledColumn[],
    rowSpace: BrunoTableCellEditTraversalRowSpace,
  ): boolean => {
    const columnsChanged = this.columns !== columns;
    const projectionChanged = this.rowSpace !== rowSpace;
    const traversalAuthorityChanged = !hasSameTraversalAuthority(this.columns, columns);
    const hadPredicateColumns = this.predicateColumns.length > 0;
    const hadPendingProjection = this.allRowsDirty || this.unknownProjection !== undefined;
    if (
      !columnsChanged &&
      !projectionChanged &&
      !this.allRowsDirty &&
      this.dirtyRowIds.size === 0 &&
      this.dirtyColumnIdsByRowId.size === 0
    ) {
      return !this.isReady();
    }
    this.columns = columns;
    this.rowSpace = rowSpace;
    if (projectionChanged && this.pendingPredicateAuthorityEligibleRowIndexes !== undefined) {
      this.pendingPredicateAuthorityEligibleRowIndexes = undefined;
      this.pendingPredicateAuthorityProjectionRowIndex = 0;
    }
    if (columnsChanged) {
      const previousPredicateColumns = this.predicateColumnsById;
      this.columnIndexById.clear();
      for (const [columnIndex, column] of columns.entries()) {
        this.columnIndexById.set(column.columnId, columnIndex);
      }
      this.staticColumnIndexes = columns.flatMap((column, columnIndex) =>
        column.kind === "field" &&
        column.isEditable === true &&
        !hasValueDependentEditEligibility(column)
          ? [columnIndex]
          : [],
      );
      this.predicateColumns = columns.flatMap((column, columnIndex) =>
        column.kind === "field" &&
        (typeof column.isEditable === "function" ||
          (column.isEditable === true && hasValueDependentEditEligibility(column)))
          ? [{ column, columnIndex }]
          : [],
      );
      this.predicateColumnsById = new Map(
        this.predicateColumns.map(({ column }) => [column.columnId, column]),
      );
      if (this.predicateColumns.length === 0) this.clearPredicateEvidence();
      else this.reconcilePredicateColumns(previousPredicateColumns);
    }

    if (this.allRowsDirty) {
      if (
        this.unknownProjection !== undefined &&
        (projectionChanged ||
          (traversalAuthorityChanged && hadPredicateColumns !== this.predicateColumns.length > 0))
      ) {
        this.unknownDirtyRestorationIterator = this.unknownProjection.claimedDirtyRowIds.values();
        this.unknownProjection = undefined;
      }
      if (
        this.unknownDirtyRestorationIterator === undefined &&
        this.unknownDiscoveryIterator === undefined &&
        this.unknownProjection === undefined
      ) {
        if (this.unknownDiscoveryRequired) {
          this.unknownDiscoveryIterator = this.rowCacheById.entries();
        } else {
          this.unknownProjection = this.createUnknownProjection(rowSpace);
        }
      }
      if (!this.incrementalBuild) {
        this.buildNextSlice(Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY);
      }
      return true;
    }

    if (!columnsChanged && !projectionChanged && !this.allRowsDirty) {
      this.stageDirtyRows();
      this.reconcileDirtyCells();
      if (!this.incrementalBuild) {
        this.buildNextSlice(Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY);
      }
      return !this.isReady();
    }

    const requiresProjectionRebuild =
      projectionChanged ||
      hadPendingProjection ||
      (traversalAuthorityChanged && hadPredicateColumns !== this.predicateColumns.length > 0);
    if (!requiresProjectionRebuild) {
      if (
        !this.incrementalBuild ||
        this.pendingWorkCount() * this.predicateColumns.length <=
          SYNCHRONOUS_INITIAL_PREDICATE_CELL_LIMIT
      ) {
        this.buildNextSlice(Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY);
      }
      return !this.isReady();
    }

    if (this.incrementalBuild) {
      this.allRowsDirty = true;
      this.unknownDiscoveryRequired = false;
      this.unknownDiscoveryIterator = undefined;
      this.unknownProjection = this.createUnknownProjection(rowSpace);
      this.verticalRangeCache = undefined;
      return true;
    }

    const dirtyWorkRowIds = new Set([
      ...this.pendingDirtyRowIds,
      ...this.dirtyRowIds,
      ...this.dirtyColumnIdsByRowId.keys(),
    ]);

    const rowIds = Array.from({ length: rowSpace.totalRows }, (_, rowIndex) =>
      rowSpace.getRowId(rowIndex),
    );
    this.rowIndexById.clear();
    const validRowIndexes: number[] = [];
    const eligiblePredicateRowIndexes: number[] = [];
    const pendingRowIndexes: number[] = [];
    for (const [rowIndex, rowId] of rowIds.entries()) {
      if (rowId === undefined) continue;
      this.rowIndexById.set(rowId, rowIndex);
      if (dirtyWorkRowIds.has(rowId)) {
        pendingRowIndexes.push(rowIndex);
        continue;
      }
      if (this.predicateColumns.length === 0) {
        validRowIndexes.push(rowIndex);
        continue;
      }
      let rowCache = this.rowCacheById.get(rowId);
      if (rowCache === undefined || rowCache.validationGeneration !== this.validationGeneration) {
        const row = this.getRow(rowId);
        if (typeof row !== "object" || row === null) {
          this.removeRowCache(rowId);
          continue;
        }
        if (rowCache === undefined || rowCache.row !== row) {
          this.removeRowCache(rowId);
          pendingRowIndexes.push(rowIndex);
          continue;
        } else {
          rowCache.validationGeneration = this.validationGeneration;
        }
      }
      validRowIndexes.push(rowIndex);
      if ((rowCache.eligiblePredicateColumnIds?.size ?? 0) > 0)
        eligiblePredicateRowIndexes.push(rowIndex);
    }
    this.rowIds = rowIds;
    this.validRowIndexes = validRowIndexes;
    this.eligiblePredicateRowIndexes = eligiblePredicateRowIndexes;
    this.pendingRowIndexes = pendingRowIndexes;
    this.pendingRowIndexSet = new Set(pendingRowIndexes);
    this.pendingRowCursor = 0;
    this.pendingDetachedRowIds = [...dirtyWorkRowIds].filter(
      (rowId) => !this.rowIndexById.has(rowId),
    );
    this.pendingDetachedRowIdSet = new Set(this.pendingDetachedRowIds);
    this.pendingDetachedRowCursor = 0;
    this.pendingDirtyRowIds.clear();
    for (const rowId of dirtyWorkRowIds) this.pendingDirtyRowIds.add(rowId);
    this.allRowsDirty = false;
    this.dirtyRowIds.clear();
    this.dirtyColumnIdsByRowId.clear();
    this.verticalRangeCache = undefined;
    if (
      !this.incrementalBuild ||
      this.pendingWorkCount() * this.predicateColumns.length <=
        SYNCHRONOUS_INITIAL_PREDICATE_CELL_LIMIT
    ) {
      this.buildNextSlice(Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY);
    }
    return !this.isReady();
  };

  public readonly buildNextSlice = (
    maximumPredicateCells: number = BRUNO_TABLE_CELL_EDIT_TRAVERSAL_SLICE_PREDICATE_CELL_LIMIT,
    maximumDurationMs: number = BRUNO_TABLE_CELL_EDIT_TRAVERSAL_SLICE_TIME_LIMIT_MS,
  ): boolean => {
    const predicateColumnCount = Math.max(this.predicateColumns.length, 1);
    let remainingPredicateCells = Math.max(1, maximumPredicateCells);
    const startedAt = performance.now();
    let built = 0;
    while (remainingPredicateCells > 0) {
      if (built > 0 && performance.now() - startedAt >= maximumDurationMs) break;
      if (this.allRowsDirty) {
        const restoredDirtyRow = this.unknownDirtyRestorationIterator?.next();
        if (restoredDirtyRow?.done === false) {
          this.pendingDirtyRowIds.add(restoredDirtyRow.value);
          remainingPredicateCells -= BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST;
          built += 1;
          continue;
        }
        if (restoredDirtyRow?.done === true) {
          this.unknownDirtyRestorationIterator = undefined;
          continue;
        }
        const projection = this.unknownProjection;
        if (projection !== undefined) {
          if (projection.rowIndex >= projection.rowSpace.totalRows) {
            projection.dirtyRowIterator ??= dirtyRowAuthorities(
              this.pendingDirtyRowIds,
              this.dirtyRowIds,
            );
            const dirtyRow = projection.dirtyRowIterator.next();
            if (!dirtyRow.done) {
              const rowId = dirtyRow.value;
              this.pendingDirtyRowIds.add(rowId);
              this.dirtyRowIds.delete(rowId);
              this.claimUnknownProjectionRow(projection, rowId);
              const rowIndex = projection.rowIndexById.get(rowId);
              if (rowIndex !== undefined) {
                enqueueUnknownProjectionRow(projection, rowIndex);
              } else if (!projection.pendingDetachedRowIdSet.has(rowId)) {
                projection.pendingDetachedRowIdSet.add(rowId);
                projection.pendingDetachedRowIds.push(rowId);
              }
              remainingPredicateCells -= BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST;
              built += 1;
              continue;
            }
            this.installUnknownProjection(projection);
            continue;
          }
          this.buildUnknownProjectionRow(projection);
          remainingPredicateCells -= BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST;
          built += 1;
          continue;
        }
        const discovery = this.unknownDiscoveryIterator?.next();
        if (discovery?.done === false) {
          const [rowId, rowCache] = discovery.value;
          const row = this.getRow(rowId);
          if (typeof row !== "object" || row === null || rowCache.row !== row) {
            this.dirtyRowIds.add(rowId);
          } else {
            rowCache.validationGeneration = this.validationGeneration;
          }
          remainingPredicateCells -= BRUNO_TABLE_CELL_EDIT_TRAVERSAL_UNKNOWN_DISCOVERY_ROW_COST;
          built += 1;
          continue;
        }
        const rowSpace = this.rowSpace;
        if (rowSpace === undefined) break;
        this.unknownDiscoveryIterator = undefined;
        this.unknownProjection = this.createUnknownProjection(rowSpace);
        continue;
      }
      const authorityIterator = this.pendingPredicateAuthorityRowIterator;
      if (authorityIterator !== undefined) {
        const authorityCellCount = Math.max(this.pendingPredicateAuthorityColumnIds.size, 1);
        if (built > 0 && remainingPredicateCells < authorityCellCount) break;
        const authorityRow = authorityIterator.next();
        if (authorityRow.done) {
          this.pendingPredicateAuthorityRowIterator = undefined;
          continue;
        }
        const authorityRowId = authorityRow.value;
        remainingPredicateCells -= authorityCellCount;
        built += 1;
        const rowCache = this.rowCacheById.get(authorityRowId);
        if (rowCache !== undefined) {
          for (const columnId of this.pendingPredicateAuthorityColumnIds) {
            const column = this.predicateColumnsById.get(columnId);
            if (column !== undefined) this.evaluateCell(authorityRowId, rowCache, column);
            else rowCache.eligiblePredicateColumnIds?.delete(columnId);
          }
        }
        continue;
      }
      const authorityProjection = this.pendingPredicateAuthorityEligibleRowIndexes;
      if (authorityProjection !== undefined) {
        const rowIndex = this.pendingPredicateAuthorityProjectionRowIndex;
        if (rowIndex < this.rowIds.length) {
          if (built > 0 && remainingPredicateCells < 1) break;
          this.pendingPredicateAuthorityProjectionRowIndex += 1;
          remainingPredicateCells -= 1;
          built += 1;
          const rowId = this.rowIds[rowIndex];
          if (
            rowId !== undefined &&
            (this.rowCacheById.get(rowId)?.eligiblePredicateColumnIds?.size ?? 0) !== 0
          ) {
            authorityProjection.push(rowIndex);
          }
          continue;
        }
        this.eligiblePredicateRowIndexes = authorityProjection;
        this.pendingPredicateAuthorityEligibleRowIndexes = undefined;
        this.pendingPredicateAuthorityProjectionRowIndex = 0;
        continue;
      }
      if (this.pendingPredicateAuthorityColumnIds.size > 0) {
        this.pendingPredicateAuthorityEligibleRowIndexes = [];
        this.pendingPredicateAuthorityProjectionRowIndex = 0;
        for (const columnId of this.pendingPredicateAuthorityColumnIds) {
          if (!this.predicateColumnsById.has(columnId)) {
            this.eligiblePredicateRowIdsByColumnId.delete(columnId);
          }
        }
        this.pendingPredicateAuthorityColumnIds.clear();
        continue;
      }
      const rowIndex = this.pendingRowIndexes[this.pendingRowCursor];
      const detachedRowId = this.pendingDetachedRowIds[this.pendingDetachedRowCursor];
      if (rowIndex === undefined && detachedRowId === undefined) break;
      if (built > 0 && remainingPredicateCells < predicateColumnCount) break;
      if (rowIndex === undefined) {
        this.pendingDetachedRowCursor += 1;
        this.pendingDetachedRowIdSet.delete(detachedRowId!);
        remainingPredicateCells -= predicateColumnCount;
        built += 1;
        const rowId = detachedRowId!;
        this.removeRowCache(rowId);
        this.pendingDirtyRowIds.delete(rowId);
        continue;
      }
      this.pendingRowCursor += 1;
      this.pendingRowIndexSet.delete(rowIndex);
      remainingPredicateCells -= predicateColumnCount;
      built += 1;
      const rowId = this.rowIds[rowIndex];
      if (rowId === undefined) continue;
      removeSorted(this.validRowIndexes, rowIndex);
      removeSorted(this.eligiblePredicateRowIndexes, rowIndex);
      this.pendingDirtyRowIds.delete(rowId);
      this.removeRowCache(rowId);
      const row = this.getRow(rowId);
      if (typeof row !== "object" || row === null) continue;
      const existing = this.rowCacheById.get(rowId);
      const rowCache =
        existing?.row === row && existing.validationGeneration === this.validationGeneration
          ? existing
          : this.createRowCache(rowId, row);
      if (rowCache !== existing) this.rowCacheById.set(rowId, rowCache);
      insertSorted(this.validRowIndexes, rowIndex);
      if ((rowCache.eligiblePredicateColumnIds?.size ?? 0) > 0) {
        insertSorted(this.eligiblePredicateRowIndexes, rowIndex);
      }
    }
    if (this.pendingRowCursor >= this.pendingRowIndexes.length) {
      this.pendingRowIndexes = [];
      this.pendingRowIndexSet.clear();
      this.pendingRowCursor = 0;
    }
    if (this.pendingDetachedRowCursor >= this.pendingDetachedRowIds.length) {
      this.pendingDetachedRowIds = [];
      this.pendingDetachedRowIdSet.clear();
      this.pendingDetachedRowCursor = 0;
    }
    return !this.isReady();
  };

  public readonly isReady = (): boolean =>
    !this.allRowsDirty &&
    this.dirtyRowIds.size === 0 &&
    this.dirtyColumnIdsByRowId.size === 0 &&
    this.pendingPredicateAuthorityRowIterator === undefined &&
    this.pendingPredicateAuthorityEligibleRowIndexes === undefined &&
    this.pendingPredicateAuthorityColumnIds.size === 0 &&
    this.pendingRowCursor >= this.pendingRowIndexes.length &&
    this.pendingDetachedRowCursor >= this.pendingDetachedRowIds.length;

  public readonly reconcileRows = (changedRowIds: ReadonlySet<string> | undefined): boolean => {
    if (this.predicateColumns.length === 0) return false;
    if (changedRowIds === undefined) {
      this.validationGeneration += 1;
      this.allRowsDirty = true;
      this.unknownDiscoveryRequired = true;
      this.pendingRowIndexes = [];
      this.pendingRowIndexSet.clear();
      this.pendingRowCursor = 0;
      this.pendingDetachedRowIds = [];
      this.pendingDetachedRowIdSet.clear();
      this.pendingDetachedRowCursor = 0;
      this.unknownDiscoveryIterator = undefined;
      this.unknownDirtyRestorationIterator = undefined;
      this.unknownProjection = undefined;
      this.verticalRangeCache = undefined;
      return true;
    }
    for (const rowId of changedRowIds) {
      this.dirtyRowIds.add(rowId);
      this.mergeLateUnknownInvalidation(rowId);
    }
    if (changedRowIds.size > 0) this.verticalRangeCache = undefined;
    return changedRowIds.size > 0;
  };

  public readonly invalidateCell = (rowId: string, columnId: string): void => {
    if (this.allRowsDirty) {
      this.dirtyRowIds.add(rowId);
      this.mergeLateUnknownInvalidation(rowId);
      return;
    }
    const columnIds = this.dirtyColumnIdsByRowId.get(rowId);
    if (columnIds === undefined) {
      this.dirtyColumnIdsByRowId.set(rowId, columnId);
    } else if (typeof columnIds === "string") {
      if (columnIds !== columnId)
        this.dirtyColumnIdsByRowId.set(rowId, new Set([columnIds, columnId]));
    } else columnIds.add(columnId);
  };

  public readonly reconcileRange = (range: BrunoTableCellEditTraversalRange | undefined): void => {
    if (range?.axis !== "vertical" || this.verticalRangeCache?.range !== range) {
      this.verticalRangeCache = undefined;
    }
  };

  public readonly find = (
    rowIndex: number,
    columnId: string,
    direction: -1 | 1,
  ): BrunoTableCellEditTraversalDestination | undefined => {
    const columns = this.columns;
    const rowSpace = this.rowSpace;
    if (columns === undefined || rowSpace === undefined) return undefined;
    if (this.allRowsDirty || this.dirtyRowIds.size > 0 || this.dirtyColumnIdsByRowId.size > 0)
      this.reconcile(columns, rowSpace);
    if (!this.isReady()) return undefined;
    const columnIndex = this.columnIndexById.get(columnId);
    if (columnIndex === undefined || this.rowIds[rowIndex] === undefined) return undefined;
    const staticCandidate = this.findStaticCandidate(rowIndex, columnIndex, direction);
    const predicateCandidate = this.findPredicateCandidate(rowIndex, columnIndex, direction);
    const destination = nearerCandidate(
      staticCandidate,
      predicateCandidate,
      columns.length,
      direction,
    );
    if (destination === undefined) return undefined;
    const rowId = this.rowIds[destination.rowIndex];
    const column = columns[destination.columnIndex];
    return rowId === undefined || column === undefined
      ? undefined
      : Object.freeze({ rowIndex: destination.rowIndex, rowId, columnId: column.columnId });
  };

  public readonly findFromRowBoundary = (
    rowIndex: number,
    direction: -1 | 1,
  ): BrunoTableCellEditTraversalDestination | undefined => {
    const columns = this.columns;
    const rowSpace = this.rowSpace;
    if (columns === undefined || rowSpace === undefined) return undefined;
    if (this.allRowsDirty || this.dirtyRowIds.size > 0 || this.dirtyColumnIdsByRowId.size > 0)
      this.reconcile(columns, rowSpace);
    if (!this.isReady()) return undefined;
    const boundaryRowIndex = direction > 0 ? rowIndex : rowIndex - 1;
    if (this.rowIds[boundaryRowIndex] === undefined) return undefined;
    const boundaryColumnIndex = direction > 0 ? -1 : columns.length;
    const destination = nearerCandidate(
      this.findStaticCandidate(boundaryRowIndex, boundaryColumnIndex, direction),
      this.findPredicateCandidate(boundaryRowIndex, boundaryColumnIndex, direction),
      columns.length,
      direction,
    );
    if (destination === undefined) return undefined;
    const rowId = this.rowIds[destination.rowIndex];
    const column = columns[destination.columnIndex];
    return rowId === undefined || column === undefined
      ? undefined
      : Object.freeze({ rowIndex: destination.rowIndex, rowId, columnId: column.columnId });
  };

  public readonly findRange = (
    range: BrunoTableCellEditTraversalRange,
    currentRowId: string,
    currentColumnId: string,
    direction: -1 | 1,
  ): BrunoTableCellEditTraversalDestination | undefined => {
    const columns = this.columns;
    const rowSpace = this.rowSpace;
    if (columns === undefined || rowSpace === undefined) return undefined;
    if (this.allRowsDirty || this.dirtyRowIds.size > 0 || this.dirtyColumnIdsByRowId.size > 0)
      this.reconcile(columns, rowSpace);
    if (!this.isReady()) return undefined;
    if (range.axis === "vertical")
      return this.findVerticalRangeDestination(range, currentRowId, currentColumnId, direction);
    const destinations = this.horizontalRangeDestinations(range);
    if (destinations.length < 2) return undefined;
    const currentIndex = destinations.findIndex(
      (destination) =>
        destination.rowId === currentRowId && destination.columnId === currentColumnId,
    );
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : destinations.length - 1
        : (currentIndex + direction + destinations.length) % destinations.length;
    return destinations[nextIndex];
  };

  public readonly getCachedRowCount = (): number => this.rowCacheById.size;

  public readonly getCachedVerticalRangeDestinationCount = (): number =>
    this.verticalRangeCache?.destinations.length ?? 0;

  private readonly mergeLateUnknownInvalidation = (rowId: string): void => {
    if (!this.allRowsDirty) return;
    const projection = this.unknownProjection;
    const rowIndex = projection?.rowIndexById.get(rowId);
    if (projection !== undefined && rowIndex !== undefined) {
      enqueueUnknownProjectionRow(projection, rowIndex);
      this.claimUnknownProjectionRow(projection, rowId);
      this.pendingDirtyRowIds.delete(rowId);
      this.dirtyRowIds.delete(rowId);
    }
  };

  private readonly buildUnknownProjectionRow = (projection: UnknownProjection): void => {
    const rowIndex = projection.rowIndex;
    projection.rowIndex += 1;
    const rowId = projection.rowSpace.getRowId(rowIndex);
    projection.rowIds[rowIndex] = rowId;
    if (rowId === undefined) return;
    projection.rowIndexById.set(rowId, rowIndex);
    if (this.predicateColumns.length === 0) {
      projection.validRowIndexes.push(rowIndex);
      return;
    }
    if (this.pendingDirtyRowIds.has(rowId) || this.dirtyRowIds.has(rowId)) {
      enqueueUnknownProjectionRow(projection, rowIndex);
      this.claimUnknownProjectionRow(projection, rowId);
      this.pendingDirtyRowIds.delete(rowId);
      this.dirtyRowIds.delete(rowId);
      return;
    }
    const rowCache = this.rowCacheById.get(rowId);
    if (rowCache === undefined || rowCache.validationGeneration !== this.validationGeneration) {
      enqueueUnknownProjectionRow(projection, rowIndex);
      return;
    }
    projection.validRowIndexes.push(rowIndex);
    if ((rowCache.eligiblePredicateColumnIds?.size ?? 0) > 0) {
      projection.eligiblePredicateRowIndexes.push(rowIndex);
    }
  };

  private readonly installUnknownProjection = (projection: UnknownProjection): void => {
    // Every old cached identity is queued for replacement/removal. Dropping the
    // obsolete indexes together avoids repeatedly shrinking each column's Set.
    if (
      projection.claimedCachedRowCount === this.rowCacheById.size &&
      this.pendingPredicateAuthorityRowIterator === undefined &&
      this.pendingPredicateAuthorityEligibleRowIndexes === undefined &&
      this.pendingPredicateAuthorityColumnIds.size === 0
    ) {
      this.rowCacheById.clear();
      this.eligiblePredicateRowIdsByColumnId.clear();
    }
    this.rowIds = projection.rowIds;
    this.rowIndexById = projection.rowIndexById;
    this.validRowIndexes = projection.validRowIndexes;
    this.eligiblePredicateRowIndexes = projection.eligiblePredicateRowIndexes;
    this.pendingRowIndexes = projection.pendingRowIndexes;
    this.pendingRowIndexSet = projection.pendingRowIndexSet;
    this.pendingRowCursor = 0;
    this.pendingDetachedRowIds = projection.pendingDetachedRowIds;
    this.pendingDetachedRowIdSet = projection.pendingDetachedRowIdSet;
    this.pendingDetachedRowCursor = 0;
    this.dirtyColumnIdsByRowId.clear();
    this.allRowsDirty = false;
    this.unknownDiscoveryRequired = false;
    this.unknownProjection = undefined;
    this.verticalRangeCache = undefined;
  };

  private readonly claimUnknownProjectionRow = (
    projection: UnknownProjection,
    rowId: string,
  ): void => {
    if (projection.claimedDirtyRowIds.has(rowId)) return;
    projection.claimedDirtyRowIds.add(rowId);
    if (this.rowCacheById.has(rowId)) projection.claimedCachedRowCount += 1;
  };

  private readonly createUnknownProjection = (
    rowSpace: BrunoTableCellEditTraversalRowSpace,
  ): UnknownProjection => ({
    rowSpace,
    rowIds: [],
    rowIndexById: new Map(),
    validRowIndexes: [],
    eligiblePredicateRowIndexes: [],
    pendingRowIndexes: [],
    pendingRowIndexSet: new Set(),
    pendingDetachedRowIds: [],
    pendingDetachedRowIdSet: new Set(),
    claimedDirtyRowIds: new Set(),
    claimedCachedRowCount: 0,
    dirtyRowIterator: undefined,
    rowIndex: 0,
  });

  private readonly clearPredicateEvidence = (): void => {
    this.rowCacheById.clear();
    this.eligiblePredicateRowIdsByColumnId.clear();
    this.dirtyRowIds.clear();
    this.dirtyColumnIdsByRowId.clear();
    this.pendingRowIndexes = [];
    this.pendingRowIndexSet.clear();
    this.pendingRowCursor = 0;
    this.pendingDetachedRowIds = [];
    this.pendingDetachedRowIdSet.clear();
    this.pendingDetachedRowCursor = 0;
    this.pendingDirtyRowIds.clear();
    this.pendingPredicateAuthorityRowIterator = undefined;
    this.pendingPredicateAuthorityColumnIds.clear();
    this.pendingPredicateAuthorityEligibleRowIndexes = undefined;
    this.pendingPredicateAuthorityProjectionRowIndex = 0;
    this.unknownDiscoveryIterator = undefined;
    this.unknownDirtyRestorationIterator = undefined;
    this.unknownProjection = undefined;
    this.allRowsDirty = false;
    this.unknownDiscoveryRequired = false;
    this.verticalRangeCache = undefined;
  };

  private readonly stageDirtyRows = (): void => {
    if (this.dirtyRowIds.size === 0) return;
    let invalidatedCachedRowCount = 0;
    for (const rowId of this.dirtyRowIds) {
      if (this.rowCacheById.has(rowId)) invalidatedCachedRowCount += 1;
      const rowIndex = this.rowIndexById.get(rowId);
      this.pendingDirtyRowIds.add(rowId);
      this.dirtyColumnIdsByRowId.delete(rowId);
      if (rowIndex === undefined) {
        if (!this.pendingDetachedRowIdSet.has(rowId)) {
          this.pendingDetachedRowIdSet.add(rowId);
          this.pendingDetachedRowIds.push(rowId);
        }
      } else if (!this.pendingRowIndexSet.has(rowIndex)) {
        this.pendingRowIndexSet.add(rowIndex);
        this.pendingRowIndexes.push(rowIndex);
      }
    }
    // Count cached identities, not batch size: new rows must never authorize
    // discarding unchanged eligibility. Preserve any in-flight authority pass.
    if (
      invalidatedCachedRowCount === this.rowCacheById.size &&
      this.pendingPredicateAuthorityRowIterator === undefined &&
      this.pendingPredicateAuthorityEligibleRowIndexes === undefined &&
      this.pendingPredicateAuthorityColumnIds.size === 0
    ) {
      this.rowCacheById.clear();
      this.eligiblePredicateRowIdsByColumnId.clear();
    }
    this.dirtyRowIds.clear();
    this.verticalRangeCache = undefined;
  };

  private readonly pendingWorkCount = (): number =>
    this.pendingRowIndexes.length -
    this.pendingRowCursor +
    (this.pendingDetachedRowIds.length - this.pendingDetachedRowCursor) +
    (this.pendingPredicateAuthorityRowIterator === undefined
      ? 0
      : SYNCHRONOUS_INITIAL_PREDICATE_CELL_LIMIT + 1) +
    (this.pendingPredicateAuthorityEligibleRowIndexes === undefined
      ? 0
      : SYNCHRONOUS_INITIAL_PREDICATE_CELL_LIMIT + 1);

  private readonly refreshRow = (rowId: string): void => {
    const rowIndex = this.rowIndexById.get(rowId);
    if (rowIndex === undefined) {
      this.removeRowCache(rowId);
      return;
    }
    if (this.predicateColumns.length === 0) return;
    const row = this.getRow(rowId);
    if (typeof row !== "object" || row === null) {
      this.removeRowCache(rowId);
      removeSorted(this.validRowIndexes, rowIndex);
      removeSorted(this.eligiblePredicateRowIndexes, rowIndex);
      return;
    }
    let rowCache = this.rowCacheById.get(rowId);
    if (rowCache === undefined || rowCache.row !== row) {
      this.removeRowCache(rowId);
      rowCache = this.createRowCache(rowId, row);
      this.rowCacheById.set(rowId, rowCache);
    }
    insertSorted(this.validRowIndexes, rowIndex);
    if ((rowCache.eligiblePredicateColumnIds?.size ?? 0) === 0) {
      removeSorted(this.eligiblePredicateRowIndexes, rowIndex);
      return;
    }
    insertSorted(this.eligiblePredicateRowIndexes, rowIndex);
  };

  private readonly createRowCache = (rowId: string, row: object): RowCache => {
    const cache: RowCache = {
      row,
      validationGeneration: this.validationGeneration,
      eligiblePredicateColumnIds: undefined,
    };
    for (const { column } of this.predicateColumns) this.evaluateCell(rowId, cache, column);
    return cache;
  };

  private readonly evaluateCell = (
    rowId: string,
    rowCache: RowCache,
    column: CompiledFieldColumn,
  ): void => {
    const eligible = this.evaluatePredicate(rowId, rowCache.row, column);
    if (eligible) {
      (rowCache.eligiblePredicateColumnIds ??= new Set()).add(column.columnId);
      let rowIds = this.eligiblePredicateRowIdsByColumnId.get(column.columnId);
      if (rowIds === undefined) {
        rowIds = new Set();
        this.eligiblePredicateRowIdsByColumnId.set(column.columnId, rowIds);
      }
      rowIds.add(rowId);
    } else {
      rowCache.eligiblePredicateColumnIds?.delete(column.columnId);
      this.eligiblePredicateRowIdsByColumnId.get(column.columnId)?.delete(rowId);
    }
  };

  private readonly reconcilePredicateColumns = (
    previousColumns: ReadonlyMap<string, CompiledFieldColumn>,
  ): void => {
    const nextColumns = new Map<string, CompiledFieldColumn>(
      this.predicateColumns.map(({ column }) => [column.columnId, column]),
    );
    const changedColumnIds = new Set<string>();
    for (const [columnId, column] of previousColumns) {
      if (!hasSamePredicateAuthority(column, nextColumns.get(columnId))) {
        changedColumnIds.add(columnId);
      }
    }
    for (const [columnId, column] of nextColumns) {
      if (!hasSamePredicateAuthority(column, previousColumns.get(columnId))) {
        changedColumnIds.add(columnId);
      }
    }
    if (changedColumnIds.size === 0) return;
    for (const columnId of changedColumnIds) {
      this.pendingPredicateAuthorityColumnIds.add(columnId);
      // This column's complete reverse index is obsolete. Rebuild it during
      // the pending pass instead of deleting the old membership row by row.
      this.eligiblePredicateRowIdsByColumnId.delete(columnId);
    }
    this.pendingPredicateAuthorityRowIterator = this.rowCacheById.keys();
    this.pendingPredicateAuthorityEligibleRowIndexes = undefined;
    this.pendingPredicateAuthorityProjectionRowIndex = 0;
    this.verticalRangeCache = undefined;
  };

  private readonly reconcileDirtyCells = (): void => {
    const eligibilityChanged = this.dirtyColumnIdsByRowId.size > 0;
    for (const [rowId, columnIds] of this.dirtyColumnIdsByRowId) {
      const rowIndex = this.rowIndexById.get(rowId);
      const rowCache = this.rowCacheById.get(rowId);
      const row = this.getRow(rowId);
      if (rowIndex === undefined || typeof row !== "object" || row === null) {
        this.refreshRow(rowId);
        continue;
      }
      if (rowCache === undefined || rowCache.row !== row) {
        this.refreshRow(rowId);
        continue;
      }
      if (typeof columnIds === "string") {
        const column = this.predicateColumnsById.get(columnIds);
        if (column !== undefined) this.evaluateCell(rowId, rowCache, column);
      } else {
        for (const columnId of columnIds) {
          const column = this.predicateColumnsById.get(columnId);
          if (column !== undefined) this.evaluateCell(rowId, rowCache, column);
        }
      }
      if ((rowCache.eligiblePredicateColumnIds?.size ?? 0) === 0)
        removeSorted(this.eligiblePredicateRowIndexes, rowIndex);
      else insertSorted(this.eligiblePredicateRowIndexes, rowIndex);
    }
    for (const rowId of this.dirtyColumnIdsByRowId.keys()) this.reconcileVerticalRangeRow(rowId);
    this.dirtyColumnIdsByRowId.clear();
    if (eligibilityChanged && this.pendingPredicateAuthorityEligibleRowIndexes !== undefined) {
      this.pendingPredicateAuthorityEligibleRowIndexes = [];
      this.pendingPredicateAuthorityProjectionRowIndex = 0;
    }
  };

  private readonly removeRowCache = (rowId: string): void => {
    const cache = this.rowCacheById.get(rowId);
    if (cache === undefined) return;
    if (cache.eligiblePredicateColumnIds !== undefined) {
      for (const columnId of cache.eligiblePredicateColumnIds)
        this.eligiblePredicateRowIdsByColumnId.get(columnId)?.delete(rowId);
    }
    this.rowCacheById.delete(rowId);
  };

  private readonly findStaticCandidate = (
    rowIndex: number,
    columnIndex: number,
    direction: -1 | 1,
  ): TraversalCoordinate | undefined => {
    if (this.staticColumnIndexes.length === 0) return undefined;
    const sameRowColumn = adjacentValue(this.staticColumnIndexes, columnIndex, direction);
    if (sameRowColumn !== undefined && binaryIncludes(this.validRowIndexes, rowIndex)) {
      return { rowIndex, columnIndex: sameRowColumn };
    }
    const destinationRow = adjacentValue(this.validRowIndexes, rowIndex, direction);
    const destinationColumn =
      direction > 0 ? this.staticColumnIndexes[0] : this.staticColumnIndexes.at(-1);
    return destinationRow === undefined || destinationColumn === undefined
      ? undefined
      : { rowIndex: destinationRow, columnIndex: destinationColumn };
  };

  private readonly findPredicateCandidate = (
    rowIndex: number,
    columnIndex: number,
    direction: -1 | 1,
  ): TraversalCoordinate | undefined => {
    const sameRowColumn = this.findPredicateColumn(rowIndex, columnIndex, direction);
    if (sameRowColumn !== undefined) return { rowIndex, columnIndex: sameRowColumn };
    const destinationRow = adjacentValue(this.eligiblePredicateRowIndexes, rowIndex, direction);
    if (destinationRow === undefined) return undefined;
    const destinationColumn = this.findPredicateColumn(
      destinationRow,
      direction > 0 ? -1 : (this.columns?.length ?? 0),
      direction,
    );
    return destinationColumn === undefined
      ? undefined
      : { rowIndex: destinationRow, columnIndex: destinationColumn };
  };

  private readonly findPredicateColumn = (
    rowIndex: number,
    columnIndex: number,
    direction: -1 | 1,
  ): number | undefined => {
    const columns = this.columns ?? [];
    const rowId = this.rowIds[rowIndex];
    if (rowId === undefined) return undefined;
    for (
      let candidate = columnIndex + direction;
      candidate >= 0 && candidate < columns.length;
      candidate += direction
    ) {
      const column = columns[candidate];
      if (
        column?.kind === "field" &&
        this.predicateColumnsById.has(column.columnId) &&
        this.eligiblePredicateRowIdsByColumnId.get(column.columnId)?.has(rowId) === true
      ) {
        return candidate;
      }
    }
    return undefined;
  };

  private readonly horizontalRangeDestinations = (
    range: Extract<BrunoTableCellEditTraversalRange, { readonly axis: "horizontal" }>,
  ): readonly BrunoTableCellEditTraversalDestination[] => {
    const rowIndex = this.rowIndexById.get(range.rowId);
    if (rowIndex === undefined) return [];
    return range.columnIds.flatMap((columnId) =>
      this.isCellEligible(range.rowId, columnId)
        ? [Object.freeze({ rowIndex, rowId: range.rowId, columnId })]
        : [],
    );
  };

  private readonly verticalRangeDestinations = (
    range: Extract<BrunoTableCellEditTraversalRange, { readonly axis: "vertical" }>,
  ): readonly BrunoTableCellEditTraversalDestination[] => {
    if (this.verticalRangeCache?.range === range) return this.verticalRangeCache.destinations;
    const destinations = range.rowIds.flatMap((rowId) => {
      const rowIndex = this.rowIndexById.get(rowId);
      return rowIndex !== undefined && this.isCellEligible(rowId, range.columnId)
        ? [Object.freeze({ rowIndex, rowId, columnId: range.columnId })]
        : [];
    });
    this.verticalRangeCache = {
      range,
      rangeIndexByRowId: new Map(range.rowIds.map((rowId, index) => [rowId, index])),
      destinations,
    };
    return destinations;
  };

  private readonly findVerticalRangeDestination = (
    range: Extract<BrunoTableCellEditTraversalRange, { readonly axis: "vertical" }>,
    currentRowId: string,
    currentColumnId: string,
    direction: -1 | 1,
  ): BrunoTableCellEditTraversalDestination | undefined => {
    const destinations = this.verticalRangeDestinations(range);
    const cache = this.verticalRangeCache;
    if (cache === undefined || destinations.length < 2) return undefined;
    const rangeIndex = cache.rangeIndexByRowId.get(currentRowId);
    if (rangeIndex === undefined || currentColumnId !== range.columnId)
      return direction > 0 ? destinations[0] : destinations.at(-1);
    let low = 0;
    let high = destinations.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const middleRangeIndex = cache.rangeIndexByRowId.get(destinations[middle]!.rowId);
      if ((middleRangeIndex ?? Number.POSITIVE_INFINITY) < rangeIndex) low = middle + 1;
      else high = middle;
    }
    const present = destinations[low]?.rowId === currentRowId;
    if (!present) return direction > 0 ? destinations[0] : destinations.at(-1);
    const nextIndex = (low + direction + destinations.length) % destinations.length;
    return destinations[nextIndex];
  };

  private readonly reconcileVerticalRangeRow = (rowId: string): void => {
    const cache = this.verticalRangeCache;
    const rangeIndex = cache?.rangeIndexByRowId.get(rowId);
    if (cache === undefined || rangeIndex === undefined) return;
    let low = 0;
    let high = cache.destinations.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const middleRangeIndex = cache.rangeIndexByRowId.get(cache.destinations[middle]!.rowId);
      if ((middleRangeIndex ?? Number.POSITIVE_INFINITY) < rangeIndex) low = middle + 1;
      else high = middle;
    }
    const present = cache.destinations[low]?.rowId === rowId;
    const rowIndex = this.rowIndexById.get(rowId);
    const eligible = rowIndex !== undefined && this.isCellEligible(rowId, cache.range.columnId);
    if (!eligible && present) {
      cache.destinations.splice(low, 1);
      return;
    }
    if (!eligible || rowIndex === undefined) return;
    const destination = Object.freeze({ rowIndex, rowId, columnId: cache.range.columnId });
    if (present) cache.destinations[low] = destination;
    else cache.destinations.splice(low, 0, destination);
  };

  private readonly isCellEligible = (rowId: string, columnId: string): boolean => {
    if (!this.rowIndexById.has(rowId)) return false;
    const columnIndex = this.columnIndexById.get(columnId);
    const column = columnIndex === undefined ? undefined : this.columns?.[columnIndex];
    if (column?.kind !== "field") return false;
    if (column.isEditable === true && !this.predicateColumnsById.has(columnId)) return true;
    return (
      this.predicateColumnsById.has(columnId) &&
      this.eligiblePredicateRowIdsByColumnId.get(columnId)?.has(rowId) === true
    );
  };
}

type TraversalCoordinate = Readonly<{ readonly rowIndex: number; readonly columnIndex: number }>;

function nearerCandidate(
  left: TraversalCoordinate | undefined,
  right: TraversalCoordinate | undefined,
  columnCount: number,
  direction: -1 | 1,
): TraversalCoordinate | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const leftOffset = left.rowIndex * columnCount + left.columnIndex;
  const rightOffset = right.rowIndex * columnCount + right.columnIndex;
  return direction > 0
    ? leftOffset <= rightOffset
      ? left
      : right
    : leftOffset >= rightOffset
      ? left
      : right;
}

function adjacentValue(
  values: readonly number[],
  current: number,
  direction: -1 | 1,
): number | undefined {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (
      (values[middle] ?? Number.POSITIVE_INFINITY) < current ||
      (direction > 0 && values[middle] === current)
    ) {
      low = middle + 1;
    } else high = middle;
  }
  return direction > 0 ? values[low] : values[low - 1];
}

function binaryIncludes(values: readonly number[], candidate: number): boolean {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = values[middle];
    if (value === candidate) return true;
    if ((value ?? Number.POSITIVE_INFINITY) < candidate) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

function insertSorted(values: number[], candidate: number): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < candidate) low = middle + 1;
    else high = middle;
  }
  if (values[low] !== candidate) values.splice(low, 0, candidate);
}

function removeSorted(values: number[], candidate: number): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < candidate) low = middle + 1;
    else high = middle;
  }
  if (values[low] === candidate) values.splice(low, 1);
}
