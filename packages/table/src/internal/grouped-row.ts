export const BRUNO_TABLE_ROWS_COLUMN_ID = "COL_ID_BRUNO_TABLE_ROWS" as const;

type BrunoTableServerGroupedPresence =
  | Readonly<{ readonly _tag: "Missing" }>
  | Readonly<{ readonly _tag: "Present"; readonly value: unknown }>;

export type BrunoTableServerGroupedRowSnapshot = Readonly<{
  readonly rowId: string;
  readonly rowCount: bigint;
  readonly groupKeys: readonly BrunoTableServerGroupedPresence[];
  readonly values: ReadonlyMap<string, unknown>;
  readonly presences: ReadonlyMap<string, BrunoTableServerGroupedPresence>;
}>;

const brunoTableServerGroupedRows = new WeakSet<object>();

export function markBrunoTableServerGroupedRow(row: BrunoTableServerGroupedRowSnapshot): void {
  brunoTableServerGroupedRows.add(row);
}

export function isBrunoTableServerGroupedRow(
  row: unknown,
): row is BrunoTableServerGroupedRowSnapshot {
  return typeof row === "object" && row !== null && brunoTableServerGroupedRows.has(row);
}
