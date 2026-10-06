import type { BrunoTableRowRangeSnapshot } from "./virtual-viewport";

type Identities = Readonly<{ getRowId: (index: number) => string | undefined }>;
type Slot = Readonly<{ rowId: string | undefined; logicalRowIndex: number; key: number }>;
type Snapshot = Readonly<{
  range: BrunoTableRowRangeSnapshot;
  rows: readonly Slot[];
  hasUnloadedRows: boolean;
}>;

/** Mounted shell ownership is published by source events, never by React rendering. */
export class BrunoTableMountedRowSlots {
  private snapshot: Snapshot;
  private readonly listeners = new Set<() => void>();

  public constructor(
    private readonly getRange: () => BrunoTableRowRangeSnapshot,
    private identities: Identities,
  ) {
    this.snapshot = Object.freeze({
      range: getRange(),
      rows: Object.freeze([]),
      hasUnloadedRows: false,
    });
    this.refresh();
  }

  public readonly getSnapshot = (): Snapshot => this.snapshot;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly setIdentities = (identities: Identities): void => {
    this.identities = identities;
    this.refresh();
  };

  public readonly refresh = (): void => {
    const range = this.getRange();
    const previous = this.snapshot.rows;
    const rows = Array.from({ length: range.rowEnd - range.rowStart }, (_, offset) => {
      const logicalRowIndex = range.rowStart + offset;
      return { logicalRowIndex, rowId: this.identities.getRowId(logicalRowIndex) };
    });
    const unchanged =
      previous.length === rows.length &&
      rows.every(
        (row, index) =>
          row.rowId === previous[index]?.rowId &&
          row.logicalRowIndex === previous[index]?.logicalRowIndex,
      );
    if (unchanged && range === this.snapshot.range) return;
    const identity = (row: Omit<Slot, "key">) =>
      row.rowId === undefined ? `loading:${String(row.logicalRowIndex)}` : `row:${row.rowId}`;
    const previousByIdentity = new Map(previous.map((row) => [identity(row), row.key]));
    const retained = new Set(
      rows.flatMap((row) => {
        const key = previousByIdentity.get(identity(row));
        return key === undefined ? [] : [key];
      }),
    );
    const retired = previous.map((row) => row.key).filter((key) => !retained.has(key));
    let retiredIndex = 0;
    let freshKey = previous.reduce((maximum, row) => Math.max(maximum, row.key + 1), 0);
    this.snapshot = Object.freeze({
      range,
      rows: unchanged
        ? previous
        : Object.freeze(
            rows.map((row) =>
              Object.freeze({
                ...row,
                key: previousByIdentity.get(identity(row)) ?? retired[retiredIndex++] ?? freshKey++,
              }),
            ),
          ),
      hasUnloadedRows: rows.some((row) => row.rowId === undefined),
    });
    let failed = false;
    let firstError: unknown;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
    if (failed) throw firstError;
  };
}
