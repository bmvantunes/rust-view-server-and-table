import type { BrunoTableRowSpaceSnapshot } from "./grid-runtime";

export type BrunoTableServerViewportWindow = Readonly<{
  readonly firstRow: number;
  readonly lastRow: number;
}>;

export type BrunoTableServerViewportDeliverySnapshot<TRow> = readonly Readonly<{
  readonly index: number;
  readonly row: TRow;
  readonly rowId: string;
}>[];

export type BrunoTableServerViewportAdmissionPlan<TRow> = Readonly<{
  readonly generation: number;
  readonly admissionRevision: number;
  readonly requiredWindow: BrunoTableServerViewportWindow;
  readonly authoritativeTotalRows: boolean;
  readonly totalRows: number;
  readonly delivery: BrunoTableServerViewportDeliverySnapshot<TRow>;
}>;

export type BrunoTableServerViewportStoreSnapshot<TRow> = Readonly<{
  readonly generation: number;
  readonly structureVersion: number;
  readonly authoritativeTotalRows: boolean;
  readonly requiredWindow: BrunoTableServerViewportWindow;
  readonly rowSpace: BrunoTableRowSpaceSnapshot<TRow>;
  readonly findRowIndex: (rowId: string) => number | undefined;
  readonly affectedRowIds?: ReadonlySet<string>;
}>;

type Listener = () => void;

const EMPTY_ROW_SPACE: BrunoTableRowSpaceSnapshot<never> = Object.freeze({
  totalRows: 0,
  loadedRows: 0,
  getRowId: () => undefined,
  getRow: () => undefined,
  getCellValue: () => undefined,
});
const EMPTY_AFFECTED_ROW_IDS: ReadonlySet<string> = new Set();

export class BrunoTableServerViewportStore<TRow> {
  private generation = 0;
  private admissionRevision = 0;
  private structureVersion = 0;
  private authoritativeTotalRows = false;
  private requiredWindow: BrunoTableServerViewportWindow = Object.freeze({
    firstRow: 0,
    lastRow: 0,
  });
  private indexToRowId = new Map<number, string>();
  private rowIndexById = new Map<string, number>();
  private rowsById = new Map<string, TRow>();
  private readonly listeners = new Set<Listener>();
  private readonly admissionPlans = new WeakSet<object>();
  private snapshot: BrunoTableServerViewportStoreSnapshot<TRow> = Object.freeze({
    generation: 0,
    structureVersion: 0,
    authoritativeTotalRows: false,
    requiredWindow: this.requiredWindow,
    rowSpace: EMPTY_ROW_SPACE,
    findRowIndex: () => undefined,
  });

  public constructor(
    private readonly readCell: (row: TRow, columnId: string) => unknown = () => undefined,
    private readonly rowsEquivalent: (previous: TRow, next: TRow) => boolean = rowsShallowlyEqual,
  ) {}

  public readonly getSnapshot = (): BrunoTableServerViewportStoreSnapshot<TRow> => this.snapshot;

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly findRowIndex = (rowId: string): number | undefined =>
    this.rowIndexById.get(rowId);

  public beginGeneration(window: BrunoTableServerViewportWindow): number {
    const requiredWindow = sanitizeBrunoTableServerViewportWindow(window);
    this.generation += 1;
    this.authoritativeTotalRows = false;
    this.requiredWindow = requiredWindow;
    this.indexToRowId = new Map();
    this.rowIndexById = new Map();
    this.rowsById = new Map();
    this.publish(Math.max(requiredWindow.lastRow + 1, 0), true);
    return this.generation;
  }

  public setRequiredRange(
    generation: number,
    window: BrunoTableServerViewportWindow,
    beforePublish?: (requiredWindow: BrunoTableServerViewportWindow) => void,
  ): boolean {
    if (generation !== this.generation) return false;
    const requiredWindow = sanitizeBrunoTableServerViewportWindow(window);
    if (
      requiredWindow.firstRow === this.requiredWindow.firstRow &&
      requiredWindow.lastRow === this.requiredWindow.lastRow
    ) {
      return false;
    }
    let prunedRows = false;
    const affectedRowIds = new Set<string>();
    let nextIndexToRowId = this.indexToRowId;
    let nextRowIndexById = this.rowIndexById;
    let nextRowsById = this.rowsById;
    if (this.indexToRowId.size > 0) {
      const indexToRowId = new Map<number, string>();
      const rowIndexById = new Map<string, number>();
      const rowsById = new Map<string, TRow>();
      for (const [index, rowId] of this.indexToRowId) {
        if (index < requiredWindow.firstRow || index > requiredWindow.lastRow) continue;
        const row = this.rowsById.get(rowId);
        if (row === undefined) continue;
        indexToRowId.set(index, rowId);
        rowIndexById.set(rowId, index);
        rowsById.set(rowId, row);
      }
      if (indexToRowId.size !== this.indexToRowId.size) {
        for (const rowId of this.rowIndexById.keys()) {
          if (!rowIndexById.has(rowId)) affectedRowIds.add(rowId);
        }
        nextIndexToRowId = indexToRowId;
        nextRowIndexById = rowIndexById;
        nextRowsById = rowsById;
        prunedRows = true;
      }
    }
    beforePublish?.(requiredWindow);
    this.admissionRevision += 1;
    this.requiredWindow = requiredWindow;
    this.indexToRowId = nextIndexToRowId;
    this.rowIndexById = nextRowIndexById;
    this.rowsById = nextRowsById;
    if (prunedRows) this.publish(this.snapshot.rowSpace.totalRows, true, affectedRowIds);
    else this.publishRequiredWindow();
    return true;
  }

  public invalidateGeneration(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.generation += 1;
    return true;
  }

  public isActiveGeneration(generation: number): boolean {
    return generation === this.generation;
  }

  public setRowCount(
    generation: number,
    totalRows: number,
    keepRenderedRows?: boolean,
    beforePublish?: (totalRows: number) => void,
  ): boolean {
    if (generation !== this.generation || !isValidRowCount(totalRows)) return false;
    // effect-view-server uses this activation/deactivation callback as lifecycle chrome. It is not
    // authoritative query data and must not collapse provisional loading geometry or bridge rows.
    if (keepRenderedRows === false) return true;
    if (this.authoritativeTotalRows && totalRows === this.snapshot.rowSpace.totalRows) {
      return true;
    }
    const previousTotalRows = this.snapshot.rowSpace.totalRows;
    let prunedRows = false;
    const affectedRowIds = new Set<string>();
    let nextIndexToRowId = this.indexToRowId;
    let nextRowIndexById = this.rowIndexById;
    let nextRowsById = this.rowsById;
    if (this.indexToRowId.size > 0) {
      const indexToRowId = new Map(this.indexToRowId);
      const rowIndexById = new Map(this.rowIndexById);
      const rowsById = new Map(this.rowsById);
      for (const [index, rowId] of indexToRowId) {
        if (index < totalRows) continue;
        prunedRows = true;
        affectedRowIds.add(rowId);
        indexToRowId.delete(index);
        if (rowIndexById.get(rowId) === index) {
          rowIndexById.delete(rowId);
          rowsById.delete(rowId);
        }
      }
      nextIndexToRowId = indexToRowId;
      nextRowIndexById = rowIndexById;
      nextRowsById = rowsById;
    }
    beforePublish?.(totalRows);
    this.admissionRevision += 1;
    this.authoritativeTotalRows = true;
    this.indexToRowId = nextIndexToRowId;
    this.rowIndexById = nextRowIndexById;
    this.rowsById = nextRowsById;
    this.publish(totalRows, prunedRows || totalRows !== previousTotalRows, affectedRowIds);
    return true;
  }

  public setRowData(
    generation: number,
    rowsByIndex: Readonly<Record<number, TRow>>,
    rowKeysByIndex: Readonly<Record<number, string>>,
  ): boolean {
    if (generation !== this.generation) return false;
    const delivery = snapshotBrunoTableServerViewportDelivery(rowsByIndex, rowKeysByIndex);
    if (delivery === undefined) return false;
    return this.setRowDataSnapshot(generation, delivery);
  }

  public planRowDataSnapshot(
    generation: number,
    delivery: BrunoTableServerViewportDeliverySnapshot<TRow>,
  ): BrunoTableServerViewportAdmissionPlan<TRow> | undefined {
    if (generation !== this.generation) return undefined;
    const admitted: Array<
      Readonly<{ readonly index: number; readonly row: TRow; readonly rowId: string }>
    > = [];
    for (const { index, row, rowId } of delivery) {
      if (this.authoritativeTotalRows && index >= this.snapshot.rowSpace.totalRows)
        return undefined;
      if (index >= this.requiredWindow.firstRow && index <= this.requiredWindow.lastRow) {
        admitted.push(Object.freeze({ index, row, rowId }));
      }
    }
    const plan = Object.freeze({
      generation,
      admissionRevision: ++this.admissionRevision,
      requiredWindow: this.requiredWindow,
      authoritativeTotalRows: this.authoritativeTotalRows,
      totalRows: this.snapshot.rowSpace.totalRows,
      delivery: Object.freeze(admitted),
    });
    this.admissionPlans.add(plan);
    return plan;
  }

  public isSupersededRowDataPlan(plan: BrunoTableServerViewportAdmissionPlan<TRow>): boolean {
    return !this.isCurrentAdmissionPlan(plan);
  }

  public setRowDataSnapshot(
    generation: number,
    delivery: BrunoTableServerViewportDeliverySnapshot<TRow>,
  ): boolean {
    const plan = this.planRowDataSnapshot(generation, delivery);
    return plan !== undefined && this.commitRowDataPlan(plan, plan.delivery);
  }

  public commitRowDataPlan(
    plan: BrunoTableServerViewportAdmissionPlan<TRow>,
    delivery: BrunoTableServerViewportDeliverySnapshot<TRow>,
    beforePublish?: (
      admitted: readonly Readonly<{
        readonly index: number;
        readonly row: TRow;
        readonly rowId: string;
      }>[],
    ) => void,
  ): boolean {
    if (!this.admissionPlans.delete(plan)) return false;
    if (!this.isCurrentAdmissionPlan(plan)) return false;
    if (
      delivery.length !== plan.delivery.length ||
      delivery.some(
        ({ index, rowId }, position) =>
          index !== plan.delivery[position]?.index || rowId !== plan.delivery[position]?.rowId,
      )
    ) {
      return false;
    }
    const admitted = delivery;
    if (admitted.length === 0) return true;

    const previousRowsById = this.rowsById;
    const affectedRowIds = new Set<string>();
    const structureChanged = admitted.some(
      (entry) =>
        this.indexToRowId.get(entry.index) !== entry.rowId ||
        this.rowIndexById.get(entry.rowId) !== entry.index,
    );
    const indexToRowId = new Map(this.indexToRowId);
    const rowIndexById = new Map(this.rowIndexById);
    for (const entry of admitted) {
      const replacedRowId = indexToRowId.get(entry.index);
      if (replacedRowId !== undefined) {
        rowIndexById.delete(replacedRowId);
        if (replacedRowId !== entry.rowId) affectedRowIds.add(replacedRowId);
      }
      indexToRowId.delete(entry.index);
      const previousIndex = rowIndexById.get(entry.rowId);
      if (previousIndex !== undefined) indexToRowId.delete(previousIndex);
      rowIndexById.delete(entry.rowId);
    }
    for (const entry of admitted) {
      indexToRowId.set(entry.index, entry.rowId);
      rowIndexById.set(entry.rowId, entry.index);
    }
    const deliveredById = new Map(admitted.map((entry) => [entry.rowId, entry.row]));
    const rowsById = new Map<string, TRow>();
    for (const rowId of rowIndexById.keys()) {
      const delivered = deliveredById.get(rowId);
      const previous = previousRowsById.get(rowId);
      const row =
        delivered === undefined
          ? previous
          : previous !== undefined && this.rowsEquivalent(previous, delivered)
            ? previous
            : delivered;
      if (delivered !== undefined && row !== previous) affectedRowIds.add(rowId);
      if (row !== undefined) rowsById.set(rowId, row);
    }
    if (!this.isCurrentAdmissionPlan(plan)) return false;
    const totalRows = this.authoritativeTotalRows
      ? this.snapshot.rowSpace.totalRows
      : admitted.reduce(
          (maximum, entry) => Math.max(maximum, entry.index + 1),
          this.snapshot.rowSpace.totalRows,
        );
    beforePublish?.(admitted);
    if (!this.isCurrentAdmissionPlan(plan)) return false;
    this.indexToRowId = indexToRowId;
    this.rowIndexById = rowIndexById;
    this.rowsById = rowsById;
    if (
      affectedRowIds.size === 0 &&
      !structureChanged &&
      totalRows === this.snapshot.rowSpace.totalRows
    ) {
      return true;
    }
    this.publish(
      totalRows,
      structureChanged || totalRows !== this.snapshot.rowSpace.totalRows,
      affectedRowIds,
    );
    return true;
  }

  private isCurrentAdmissionPlan(plan: BrunoTableServerViewportAdmissionPlan<TRow>): boolean {
    return (
      plan.generation === this.generation &&
      plan.admissionRevision === this.admissionRevision &&
      plan.requiredWindow === this.requiredWindow &&
      plan.authoritativeTotalRows === this.authoritativeTotalRows &&
      plan.totalRows === this.snapshot.rowSpace.totalRows
    );
  }

  private publish(
    totalRows: number,
    structureChanged = false,
    affectedRowIds?: ReadonlySet<string>,
  ): void {
    if (structureChanged) this.structureVersion += 1;
    const indexToRowId = this.indexToRowId;
    const rowIndexById = this.rowIndexById;
    const rowsById = this.rowsById;
    const readCell = this.readCell;
    const rowSpace: BrunoTableRowSpaceSnapshot<TRow> = Object.freeze({
      totalRows,
      loadedRows: rowsById.size,
      getRowId: (index) => indexToRowId.get(index),
      getRow: (rowId) => rowsById.get(rowId),
      getCellValue: (rowId, columnId) => {
        const row = rowsById.get(rowId);
        return row === undefined ? undefined : readCell(row, columnId);
      },
    });
    this.snapshot = Object.freeze({
      generation: this.generation,
      structureVersion: this.structureVersion,
      authoritativeTotalRows: this.authoritativeTotalRows,
      requiredWindow: this.requiredWindow,
      rowSpace,
      findRowIndex: (rowId: string) => rowIndexById.get(rowId),
      ...(affectedRowIds === undefined ? {} : { affectedRowIds }),
    });
    notify(this.listeners);
  }

  private publishRequiredWindow(): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      requiredWindow: this.requiredWindow,
      affectedRowIds: EMPTY_AFFECTED_ROW_IDS,
    });
    notify(this.listeners);
  }
}

export function validateBrunoTableServerViewportRowKeys<TRow>(
  rowsByIndex: Readonly<Record<number, TRow>>,
  rowKeysByIndex: Readonly<Record<number, string>>,
): boolean {
  return snapshotBrunoTableServerViewportDelivery(rowsByIndex, rowKeysByIndex) !== undefined;
}

export function snapshotBrunoTableServerViewportDelivery<TRow>(
  rowsByIndex: Readonly<Record<number, TRow>>,
  rowKeysByIndex: Readonly<Record<number, string>>,
): BrunoTableServerViewportDeliverySnapshot<TRow> | undefined {
  const rowEntries = Object.entries(rowsByIndex);
  const keyEntries = Object.entries(rowKeysByIndex);
  const validatedRowKeys = snapshotValidatedViewportRowKeys(rowEntries, keyEntries);
  if (validatedRowKeys === undefined) return undefined;
  return Object.freeze(
    rowEntries.map(([rawIndex, row]) => {
      const index = parseAbsoluteIndex(rawIndex)!;
      return Object.freeze({ index, row, rowId: validatedRowKeys.get(index)! });
    }),
  );
}

function snapshotValidatedViewportRowKeys<TRow>(
  rowEntries: [string, TRow][],
  keyEntries: [string, string][],
): ReadonlyMap<number, string> | undefined {
  if (rowEntries.length !== keyEntries.length) return undefined;
  const indexes = new Set<number>();
  for (const [rawIndex] of rowEntries) {
    const index = parseAbsoluteIndex(rawIndex);
    if (index === undefined || indexes.has(index)) return undefined;
    indexes.add(index);
  }
  const validatedRowKeys = new Map<number, string>();
  const rowIds = new Set<string>();
  for (const [rawIndex, rowId] of keyEntries) {
    const index = parseAbsoluteIndex(rawIndex);
    if (
      index === undefined ||
      !indexes.has(index) ||
      typeof rowId !== "string" ||
      rowId.length === 0 ||
      rowIds.has(rowId)
    ) {
      return undefined;
    }
    validatedRowKeys.set(index, rowId);
    rowIds.add(rowId);
  }
  return validatedRowKeys;
}

export function sanitizeBrunoTableServerViewportWindow(
  window: BrunoTableServerViewportWindow,
): BrunoTableServerViewportWindow {
  if (
    !Number.isSafeInteger(window.firstRow) ||
    !Number.isSafeInteger(window.lastRow) ||
    window.firstRow < 0 ||
    window.lastRow < window.firstRow ||
    window.lastRow === Number.MAX_SAFE_INTEGER
  ) {
    return Object.freeze({ firstRow: 0, lastRow: 0 });
  }
  return Object.freeze({ firstRow: window.firstRow, lastRow: window.lastRow });
}

function parseAbsoluteIndex(rawIndex: string): number | undefined {
  const index = Number(rawIndex);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex
    ? index
    : undefined;
}

function isValidRowCount(totalRows: number): boolean {
  return Number.isSafeInteger(totalRows) && totalRows >= 0;
}

function rowsShallowlyEqual<TRow>(previous: TRow, next: TRow): boolean {
  if (Object.is(previous, next)) return true;
  if (
    typeof previous !== "object" ||
    previous === null ||
    typeof next !== "object" ||
    next === null
  ) {
    return false;
  }
  const previousKeys = Reflect.ownKeys(previous);
  const nextKeys = Reflect.ownKeys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(next, key) &&
      Object.is(Reflect.get(previous, key), Reflect.get(next, key)),
  );
}

function notify(listeners: ReadonlySet<Listener>): void {
  let firstError: unknown;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}
