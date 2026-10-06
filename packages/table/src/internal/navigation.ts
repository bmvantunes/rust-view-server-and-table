import type { CompiledColumn } from "./compile-columns";
import type { BrunoTableQueryNavigationMode } from "./grid-runtime";

export type BrunoTableActiveCell = Readonly<{
  readonly region: "header" | "body";
  readonly rowIndex: number;
  readonly rowId?: string;
  readonly columnId: string;
}>;

export type BrunoTableNavigationDirection = "up" | "down" | "left" | "right";

export type BrunoTableNavigationCommand =
  | Readonly<{
      readonly type: "step";
      readonly direction: BrunoTableNavigationDirection;
    }>
  | Readonly<{ readonly type: "page"; readonly rowDelta: number }>
  | Readonly<{ readonly type: "row-edge"; readonly edge: "start" | "end" }>
  | Readonly<{ readonly type: "column-edge"; readonly edge: "start" | "end" }>
  | Readonly<{ readonly type: "grid-edge"; readonly edge: "start" | "end" }>;

export function isBrunoTableCellRangeNavigationCommandAdmitted(
  axis: "horizontal" | "vertical" | undefined,
  command: BrunoTableNavigationCommand,
  currentBodyRowIndex: number,
): boolean {
  if (command.type === "step" && command.direction === "up" && currentBodyRowIndex === 0) {
    return false;
  }
  if (axis === undefined) return command.type !== "grid-edge";
  if (axis === "horizontal") {
    return !(
      command.type === "page" ||
      command.type === "column-edge" ||
      (command.type === "step" && (command.direction === "up" || command.direction === "down"))
    );
  }
  return !(
    command.type === "row-edge" ||
    (command.type === "step" && (command.direction === "left" || command.direction === "right"))
  );
}

type Listener = () => void;

export type BrunoTableNavigationRowSpace = Readonly<{
  readonly totalRows: number;
  readonly getRowId: (index: number) => string | undefined;
  readonly findRowIndex: (rowId: string) => number | undefined;
  readonly missingRowIdentityBehavior?:
    | "clear-conflicting-active-cell"
    | "fallback-to-display-index";
}>;

const EMPTY_ROW_SPACE: BrunoTableNavigationRowSpace = Object.freeze({
  totalRows: 0,
  getRowId: () => undefined,
  findRowIndex: () => undefined,
});

export class BrunoTableNavigationRuntime {
  private readonly listeners = new Set<Listener>();
  private readonly columnListeners = new Map<string, Set<Listener>>();
  private rowSpace = EMPTY_ROW_SPACE;
  private columns: readonly CompiledColumn[] = [];
  private activeCell: BrunoTableActiveCell | undefined;
  private bodyInitializationBlocked = false;
  private pendingQueryFallbackRowIndex: number | undefined;
  private pendingQueryRowId: string | undefined;
  private installedQueryGeneration: number | undefined;

  public readonly getSnapshot = (): BrunoTableActiveCell | undefined => this.activeCell;

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly getColumnSnapshot = (columnId: string): boolean =>
    this.activeCell?.region === "header" && this.activeCell.columnId === columnId;

  public readonly subscribeColumn = (columnId: string, listener: Listener): (() => void) => {
    const listeners = this.columnListeners.get(columnId) ?? new Set<Listener>();
    listeners.add(listener);
    this.columnListeners.set(columnId, listeners);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.columnListeners.get(columnId) !== listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) this.columnListeners.delete(columnId);
    };
  };

  public readonly reset = (): void => {
    this.pendingQueryFallbackRowIndex = undefined;
    this.pendingQueryRowId = undefined;
    this.bodyInitializationBlocked = false;
    this.setActive(undefined);
  };

  public readonly clearForQuery = (): void => {
    this.pendingQueryFallbackRowIndex = undefined;
    this.pendingQueryRowId = undefined;
    this.bodyInitializationBlocked = true;
    this.setActive(undefined);
  };

  /**
   * Consumes one installed query epoch for the table-scoped navigation authority.
   * Initial restored grouping blocks synthetic body activation; later epochs apply once even
   * when their structural projection replaces the keyed viewport boundary.
   */
  public readonly installCommittedQuery = (
    generation: number,
    navigationMode: BrunoTableQueryNavigationMode,
    rows: BrunoTableNavigationRowSpace | readonly (string | undefined)[],
    columns: readonly CompiledColumn[],
  ): boolean => {
    if (this.installedQueryGeneration === undefined) {
      this.installedQueryGeneration = generation;
      if (navigationMode === "restore") {
        this.clearForQuery();
        return false;
      }
      if (navigationMode === "projection-reset") {
        this.resetForProjection(rows, columns);
        return true;
      }
      return false;
    }
    if (this.installedQueryGeneration === generation) return false;
    this.installedQueryGeneration = generation;
    if (navigationMode === "restore") {
      this.clearForQuery();
    } else if (navigationMode === "projection-reset") {
      this.resetForProjection(rows, columns);
    } else if (navigationMode === "reconcile") {
      this.reconcileForQuery(rows, columns);
    } else if (navigationMode === "clear") {
      this.clearForCommittedSort(rows, columns);
    } else {
      this.resetForCommittedQuery(rows, columns);
    }
    return true;
  };

  /**
   * Reset the position owned by a committed query command without retaining a body row identity.
   * Header navigation is not a row position, so a header-originated command keeps its logical
   * header column while a body-originated command starts at row zero (or clears for an empty
   * result).
   */
  public readonly resetForCommittedQuery = (
    rows: BrunoTableNavigationRowSpace | readonly (string | undefined)[],
    columns: readonly CompiledColumn[],
  ): void => {
    const rowSpace = isRowIdArray(rows) ? rowSpaceFromArray(rows) : rows;
    const activeCell = this.activeCell;
    this.pendingQueryFallbackRowIndex = undefined;
    this.pendingQueryRowId = undefined;
    this.rowSpace = rowSpace;
    this.columns = columns;
    const column =
      columns.find((candidate) => candidate.columnId === activeCell?.columnId) ?? columns[0];
    if (column === undefined) {
      this.bodyInitializationBlocked = true;
      this.setActive(undefined);
      return;
    }
    if (activeCell?.region === "header") {
      this.bodyInitializationBlocked = false;
      this.setActive({ region: "header", rowIndex: 0, columnId: column.columnId });
      return;
    }
    if (rowSpace.totalRows === 0) {
      this.bodyInitializationBlocked = true;
      this.setActive(undefined);
      return;
    }
    this.bodyInitializationBlocked = false;
    this.setActive({
      region: "body",
      rowIndex: 0,
      ...rowIdentity(rowSpace, 0),
      columnId: columns[0]!.columnId,
    });
  };

  /** Grouping changes always target body row zero and the first logical column. */
  public readonly resetForProjection = (
    rows: BrunoTableNavigationRowSpace | readonly (string | undefined)[],
    columns: readonly CompiledColumn[],
  ): void => {
    const rowSpace = isRowIdArray(rows) ? rowSpaceFromArray(rows) : rows;
    this.pendingQueryFallbackRowIndex = undefined;
    this.pendingQueryRowId = undefined;
    this.rowSpace = rowSpace;
    this.columns = columns;
    const column = columns[0];
    if (column === undefined || rowSpace.totalRows === 0) {
      this.bodyInitializationBlocked = true;
      this.setActive(undefined);
      return;
    }
    this.bodyInitializationBlocked = false;
    this.setActive({
      region: "body",
      rowIndex: 0,
      ...rowIdentity(rowSpace, 0),
      columnId: column.columnId,
    });
  };

  /** Sorting invalidates a position-based body Active Cell without manufacturing row zero. */
  public readonly clearForCommittedSort = (
    rows: BrunoTableNavigationRowSpace | readonly (string | undefined)[],
    columns: readonly CompiledColumn[],
  ): void => {
    const rowSpace = isRowIdArray(rows) ? rowSpaceFromArray(rows) : rows;
    const activeCell = this.activeCell;
    this.pendingQueryFallbackRowIndex = undefined;
    this.pendingQueryRowId = undefined;
    this.rowSpace = rowSpace;
    this.columns = columns;
    const column = columns.find((candidate) => candidate.columnId === activeCell?.columnId);
    if (activeCell?.region === "header" && column !== undefined) {
      this.bodyInitializationBlocked = false;
      this.setActive({ region: "header", rowIndex: 0, columnId: column.columnId });
      return;
    }
    this.bodyInitializationBlocked = true;
    this.setActive(undefined);
  };

  public readonly reconcileForQuery = (
    rows: BrunoTableNavigationRowSpace | readonly (string | undefined)[],
    columns: readonly CompiledColumn[],
  ): void => {
    const rowSpace = isRowIdArray(rows) ? rowSpaceFromArray(rows) : rows;
    const activeCell = this.activeCell;
    this.pendingQueryFallbackRowIndex = undefined;
    this.pendingQueryRowId = undefined;
    const column = columns.find((candidate) => candidate.columnId === activeCell?.columnId);
    this.rowSpace = rowSpace;
    this.columns = columns;
    if (column === undefined) {
      this.bodyInitializationBlocked = true;
      this.setActive(undefined);
      return;
    }
    if (activeCell?.region === "header") {
      this.bodyInitializationBlocked = false;
      this.setActive({ region: "header", rowIndex: 0, columnId: column.columnId });
      return;
    }
    const rowId = activeCell?.rowId;
    const rowIndex = rowId === undefined ? undefined : rowSpace.findRowIndex(rowId);
    if (activeCell?.region === "body" && rowId !== undefined && rowIndex !== undefined) {
      this.bodyInitializationBlocked = false;
      this.setActive({
        region: "body",
        rowIndex,
        rowId,
        columnId: column.columnId,
      });
      return;
    }
    if (activeCell?.region === "body") {
      const fallbackRowIndex = Math.max(
        0,
        Math.min(Math.max(0, rowSpace.totalRows - 1), activeCell.rowIndex),
      );
      const fallbackRowId = rowSpace.getRowId(fallbackRowIndex);
      if (fallbackRowId !== undefined) {
        this.bodyInitializationBlocked = false;
        this.setActive({
          region: "body",
          rowIndex: fallbackRowIndex,
          rowId: fallbackRowId,
          columnId: column.columnId,
        });
        return;
      }
      this.pendingQueryFallbackRowIndex = fallbackRowIndex;
      this.pendingQueryRowId = rowId;
    }
    this.bodyInitializationBlocked = true;
    this.setActive(undefined);
  };

  public readonly activateForFocus = (): void => {
    if (this.activeCell !== undefined) return;
    const firstColumn = this.columns[0];
    if (firstColumn === undefined) return;
    this.bodyInitializationBlocked = false;
    if (this.rowSpace.totalRows === 0) {
      this.setActive({ region: "header", rowIndex: 0, columnId: firstColumn.columnId });
      return;
    }
    this.setActive({
      region: "body",
      rowIndex: 0,
      ...rowIdentity(this.rowSpace, 0),
      columnId: firstColumn.columnId,
    });
  };

  public readonly activateHeader = (columnId: string): void => {
    if (!this.columns.some((column) => column.columnId === columnId)) return;
    this.bodyInitializationBlocked = false;
    this.setActive({ region: "header", rowIndex: 0, columnId });
  };

  public readonly activateBody = (
    rowIndex: number,
    rowId: string | undefined,
    columnId: string,
  ): boolean => {
    if (
      !Number.isSafeInteger(rowIndex) ||
      rowIndex < 0 ||
      rowIndex >= this.rowSpace.totalRows ||
      !this.columns.some((column) => column.columnId === columnId) ||
      this.rowSpace.getRowId(rowIndex) !== rowId
    ) {
      return false;
    }
    this.bodyInitializationBlocked = false;
    return this.setActive({
      region: "body",
      rowIndex,
      ...(rowId === undefined ? {} : { rowId }),
      columnId,
    });
  };

  public readonly restoreActiveCell = (activeCell: BrunoTableActiveCell | undefined): void => {
    if (activeCell === undefined) {
      this.setActive(undefined);
      return;
    }
    const column = this.columns.find((candidate) => candidate.columnId === activeCell.columnId);
    if (column === undefined) {
      this.setActive(undefined);
      return;
    }
    if (activeCell.region === "header") {
      this.bodyInitializationBlocked = false;
      this.setActive({ region: "header", rowIndex: 0, columnId: column.columnId });
      return;
    }
    const matchingRowIndex =
      activeCell.rowId === undefined ? undefined : this.rowSpace.findRowIndex(activeCell.rowId);
    if (matchingRowIndex === undefined) {
      this.setActive(undefined);
      return;
    }
    const rowIndex = matchingRowIndex;
    const rowId = this.rowSpace.getRowId(rowIndex);
    if (rowId === undefined) {
      this.setActive(undefined);
      return;
    }
    this.bodyInitializationBlocked = false;
    this.setActive({ region: "body", rowIndex, rowId, columnId: column.columnId });
  };

  public readonly setShape = (
    rows: BrunoTableNavigationRowSpace | readonly (string | undefined)[],
    columns: readonly CompiledColumn[],
  ): void => {
    const rowSpace = isRowIdArray(rows) ? rowSpaceFromArray(rows) : rows;
    const previousColumns = this.columns;
    const previousColumnIndex = previousColumns.findIndex(
      (column) => column.columnId === this.activeCell?.columnId,
    );
    this.rowSpace = rowSpace;
    this.columns = columns;
    const firstColumn = this.columns[0];
    if (firstColumn === undefined) {
      this.setActive(undefined);
      return;
    }
    const activeColumnIndex = this.columns.findIndex(
      (column) => column.columnId === this.activeCell?.columnId,
    );
    const fallbackColumnIndex =
      activeColumnIndex >= 0
        ? activeColumnIndex
        : previousColumnIndex >= 0
          ? Math.min(previousColumnIndex, this.columns.length - 1)
          : 0;
    const column = this.columns[fallbackColumnIndex]!;
    const matchingRowIndex =
      this.activeCell?.rowId === undefined
        ? undefined
        : rowSpace.findRowIndex(this.activeCell.rowId);
    const activeSlotRowId =
      this.activeCell?.region === "body" ? rowSpace.getRowId(this.activeCell.rowIndex) : undefined;
    if (
      this.activeCell?.region === "body" &&
      this.activeCell.rowId !== undefined &&
      matchingRowIndex === undefined &&
      rowSpace.missingRowIdentityBehavior === "clear-conflicting-active-cell" &&
      (this.activeCell.rowIndex >= rowSpace.totalRows ||
        (activeSlotRowId !== undefined && activeSlotRowId !== this.activeCell.rowId))
    ) {
      this.pendingQueryFallbackRowIndex = undefined;
      this.pendingQueryRowId = undefined;
      this.bodyInitializationBlocked = true;
      this.setActive(undefined);
      return;
    }
    const preferredRowIndex = Math.max(
      0,
      Math.min(rowSpace.totalRows - 1, matchingRowIndex ?? this.activeCell?.rowIndex ?? 0),
    );
    if (this.activeCell?.region === "header") {
      this.setActive({ region: "header", rowIndex: 0, columnId: column.columnId });
      return;
    }
    if (this.bodyInitializationBlocked) {
      const pendingRowIndex = this.pendingQueryFallbackRowIndex;
      if (pendingRowIndex === undefined || rowSpace.totalRows === 0) return;
      const pendingRowId = this.pendingQueryRowId;
      const matchingPendingRowIndex =
        pendingRowId === undefined ? undefined : rowSpace.findRowIndex(pendingRowId);
      if (pendingRowId !== undefined && matchingPendingRowIndex !== undefined) {
        this.pendingQueryFallbackRowIndex = undefined;
        this.pendingQueryRowId = undefined;
        this.bodyInitializationBlocked = false;
        this.setActive({
          region: "body",
          rowIndex: matchingPendingRowIndex,
          rowId: pendingRowId,
          columnId: column.columnId,
        });
        return;
      }
      const fallbackRowIndex = Math.max(0, Math.min(rowSpace.totalRows - 1, pendingRowIndex));
      const fallbackRowId = rowSpace.getRowId(fallbackRowIndex);
      if (fallbackRowId === undefined) return;
      this.pendingQueryFallbackRowIndex = undefined;
      this.pendingQueryRowId = undefined;
      this.bodyInitializationBlocked = false;
      this.setActive({
        region: "body",
        rowIndex: fallbackRowIndex,
        rowId: fallbackRowId,
        columnId: column.columnId,
      });
      return;
    }
    if (rowSpace.totalRows === 0) {
      if (this.activeCell?.region === "body") this.bodyInitializationBlocked = true;
      this.setActive(undefined);
      return;
    }
    const retainedUnloadedRowId =
      this.activeCell?.region === "body" &&
      this.activeCell.rowId !== undefined &&
      matchingRowIndex === undefined &&
      this.activeCell.rowIndex < rowSpace.totalRows &&
      activeSlotRowId === undefined &&
      rowSpace.missingRowIdentityBehavior !== undefined
        ? this.activeCell.rowId
        : undefined;
    this.setActive({
      region: "body",
      rowIndex: preferredRowIndex,
      ...(retainedUnloadedRowId === undefined
        ? rowIdentity(rowSpace, preferredRowIndex)
        : { rowId: retainedUnloadedRowId }),
      columnId: column.columnId,
    });
  };

  public readonly navigate = (command: BrunoTableNavigationCommand): boolean => {
    if (this.activeCell === undefined || this.columns.length === 0) return false;
    if (command.type === "step") {
      return this.resolveStep(command.direction);
    }
    if (command.type === "page") return this.resolvePage(command.rowDelta);
    if (command.type === "row-edge") return this.resolveRowEdge(command.edge);
    if (command.type === "column-edge") return this.resolveColumnEdge(command.edge);
    return this.resolveGridEdge(command.edge);
  };

  public readonly move = (direction: BrunoTableNavigationDirection): boolean =>
    this.navigate({ type: "step", direction });

  public readonly movePage = (rowDelta: number): boolean =>
    this.navigate({ type: "page", rowDelta });

  public readonly moveToRowEdge = (edge: "start" | "end"): boolean =>
    this.navigate({ type: "row-edge", edge });

  public readonly moveToColumnEdge = (edge: "start" | "end"): boolean =>
    this.navigate({ type: "column-edge", edge });

  public readonly moveToGridEdge = (edge: "start" | "end"): boolean =>
    this.navigate({ type: "grid-edge", edge });

  private readonly resolveStep = (direction: BrunoTableNavigationDirection): boolean => {
    if (this.activeCell === undefined || this.columns.length === 0) return false;
    const rowDelta = direction === "up" ? -1 : direction === "down" ? 1 : 0;
    const columnDelta = direction === "left" ? -1 : direction === "right" ? 1 : 0;
    const currentColumn = Math.max(
      this.columns.findIndex((column) => column.columnId === this.activeCell?.columnId),
      0,
    );
    const nextColumn = Math.max(0, Math.min(this.columns.length - 1, currentColumn + columnDelta));
    if (this.activeCell.region === "header") {
      if (rowDelta > 0 && this.rowSpace.totalRows > 0) {
        return this.setActive({
          region: "body",
          rowIndex: 0,
          ...rowIdentity(this.rowSpace, 0),
          columnId: this.columns[nextColumn]!.columnId,
        });
      }
      if (rowDelta === 0 && columnDelta !== 0) {
        return this.setActive({
          region: "header",
          rowIndex: 0,
          columnId: this.columns[nextColumn]!.columnId,
        });
      }
      return false;
    }
    if (this.rowSpace.totalRows === 0) {
      return this.setActive(undefined);
    }
    const nextBodyRow = this.activeCell.rowIndex + rowDelta;
    if (rowDelta < 0 && nextBodyRow < 0) {
      return this.setActive({
        region: "header",
        rowIndex: 0,
        columnId: this.columns[nextColumn]!.columnId,
      });
    }
    const rowIndex = Math.max(0, Math.min(this.rowSpace.totalRows - 1, nextBodyRow));
    const retainedUnloadedRowId =
      rowDelta === 0 &&
      this.activeCell.rowId !== undefined &&
      this.rowSpace.getRowId(rowIndex) === undefined
        ? this.activeCell.rowId
        : undefined;
    return this.setActive({
      region: "body",
      rowIndex,
      ...(retainedUnloadedRowId === undefined
        ? rowIdentity(this.rowSpace, rowIndex)
        : { rowId: retainedUnloadedRowId }),
      columnId: this.columns[nextColumn]!.columnId,
    });
  };

  private readonly resolvePage = (rowDelta: number): boolean => {
    if (this.activeCell === undefined || this.rowSpace.totalRows === 0) return false;
    if (this.activeCell.region === "header" && rowDelta < 0) return false;
    const target =
      this.activeCell.region === "header"
        ? Math.max(0, Math.min(this.rowSpace.totalRows - 1, rowDelta > 0 ? rowDelta - 1 : 0))
        : Math.max(0, Math.min(this.rowSpace.totalRows - 1, this.activeCell.rowIndex + rowDelta));
    return this.setActive({
      region: "body",
      rowIndex: target,
      ...rowIdentity(this.rowSpace, target),
      columnId: this.activeCell.columnId,
    });
  };

  private readonly resolveRowEdge = (edge: "start" | "end"): boolean => {
    if (this.activeCell === undefined || this.columns.length === 0) return false;
    return this.setActive({
      ...this.activeCell,
      columnId: this.columns[edge === "start" ? 0 : this.columns.length - 1]!.columnId,
    });
  };

  private readonly resolveColumnEdge = (edge: "start" | "end"): boolean => {
    if (this.activeCell === undefined || this.columns.length === 0) return false;
    if (edge === "start" || this.rowSpace.totalRows === 0) {
      return this.setActive({
        region: "header",
        rowIndex: 0,
        columnId: this.activeCell.columnId,
      });
    }
    const rowIndex = this.rowSpace.totalRows - 1;
    return this.setActive({
      region: "body",
      rowIndex,
      ...rowIdentity(this.rowSpace, rowIndex),
      columnId: this.activeCell.columnId,
    });
  };

  private readonly resolveGridEdge = (edge: "start" | "end"): boolean => {
    if (this.columns.length === 0) return false;
    if (edge === "start" || this.rowSpace.totalRows === 0) {
      return this.setActive({
        region: "header",
        rowIndex: 0,
        columnId: this.columns[edge === "start" ? 0 : this.columns.length - 1]!.columnId,
      });
    }
    const rowIndex = this.rowSpace.totalRows - 1;
    return this.setActive({
      region: "body",
      rowIndex,
      ...rowIdentity(this.rowSpace, rowIndex),
      columnId: this.columns[this.columns.length - 1]!.columnId,
    });
  };

  private readonly setActive = (next: BrunoTableActiveCell | undefined): boolean => {
    if (
      this.activeCell?.region === next?.region &&
      this.activeCell?.rowIndex === next?.rowIndex &&
      this.activeCell?.rowId === next?.rowId &&
      this.activeCell?.columnId === next?.columnId
    ) {
      return false;
    }
    const previousHeaderColumnId =
      this.activeCell?.region === "header" ? this.activeCell.columnId : undefined;
    const nextHeaderColumnId = next?.region === "header" ? next.columnId : undefined;
    this.activeCell = next === undefined ? undefined : Object.freeze(next);
    for (const listener of this.listeners) listener();
    const changedColumnIds = new Set(
      [previousHeaderColumnId, nextHeaderColumnId].filter(
        (columnId): columnId is string => columnId !== undefined,
      ),
    );
    for (const columnId of changedColumnIds) {
      const listeners = this.columnListeners.get(columnId);
      if (listeners !== undefined) {
        for (const listener of listeners) listener();
      }
    }
    return true;
  };
}

function rowIdentity(rowSpace: BrunoTableNavigationRowSpace, index: number) {
  const rowId = rowSpace.getRowId(index);
  return rowId === undefined ? {} : { rowId };
}

function rowSpaceFromArray(rowIds: readonly (string | undefined)[]): BrunoTableNavigationRowSpace {
  return Object.freeze({
    totalRows: rowIds.length,
    getRowId: (index: number) => rowIds[index],
    findRowIndex: (rowId: string) => {
      const index = rowIds.indexOf(rowId);
      return index < 0 ? undefined : index;
    },
  });
}

function isRowIdArray(
  rows: BrunoTableNavigationRowSpace | readonly (string | undefined)[],
): rows is readonly (string | undefined)[] {
  return Array.isArray(rows);
}
