import type { BrunoTableRowId } from "../public-types";
import type { CompiledColumn, CompiledFieldColumn } from "./compile-columns";
import { isBrunoTableInvalidCellValue } from "./grid-runtime";
import { BRUNO_TABLE_ROWS_COLUMN_ID } from "./grouped-row";
import { compileColumnValueSemantics, type CompiledColumnValueSemantics } from "./value-semantics";

export { BRUNO_TABLE_ROWS_COLUMN_ID } from "./grouped-row";

export type BrunoTableGroupedPresence =
  | Readonly<{ readonly _tag: "Missing" }>
  | Readonly<{ readonly _tag: "Present"; readonly value: unknown }>;

export type BrunoTableClientGroupingInputRow = Readonly<{
  readonly raw: unknown;
  readonly rowId: BrunoTableRowId;
  readonly rowIndex: number;
  readonly readValue: (column: CompiledColumn) => unknown;
}>;

export type BrunoTableClientGroupedRow = Readonly<{
  readonly rowId: BrunoTableRowId;
  readonly rowCount: bigint;
  readonly groupKeys: readonly BrunoTableGroupedPresence[];
  readonly values: ReadonlyMap<string, unknown>;
  readonly presences: ReadonlyMap<string, BrunoTableGroupedPresence>;
}>;

type GroupOrderBy = readonly Readonly<{
  readonly columnId: string;
  readonly direction: "asc" | "desc";
}>[];

export type BrunoTableClientGroupedProjection =
  | Readonly<{
      readonly kind: "ready";
      readonly groupBy: readonly string[];
      readonly rows: readonly BrunoTableClientGroupedRow[];
      readonly rowIds: readonly BrunoTableRowId[];
    }>
  | Readonly<{
      readonly kind: "invalid";
      readonly groupBy: readonly string[];
      readonly invalid:
        | Readonly<{
            readonly kind: "source-row";
            readonly rowIndex: number;
            readonly columnId: string;
            readonly message: string;
          }>
        | Readonly<{
            readonly kind: "group";
            readonly columnId: string;
            readonly message: string;
          }>;
    }>;

type AggregateState =
  | Readonly<{
      readonly kind: "countDistinct";
      readonly column: CompiledFieldColumn;
      readonly values: Map<string, true>;
    }>
  | {
      readonly kind: "sum";
      readonly column: CompiledFieldColumn;
      count: bigint;
      total: BrunoTableGroupedPresence;
    }
  | {
      readonly kind: "avg";
      readonly column: CompiledFieldColumn;
      count: bigint;
      total: BrunoTableGroupedPresence;
    }
  | {
      readonly kind: "min";
      readonly column: CompiledFieldColumn;
      selected: BrunoTableGroupedPresence | undefined;
    }
  | {
      readonly kind: "max";
      readonly column: CompiledFieldColumn;
      selected: BrunoTableGroupedPresence | undefined;
    };

type MutableGroup = {
  readonly rowId: BrunoTableRowId;
  readonly insertionIndex: number;
  readonly groupKeys: readonly BrunoTableGroupedPresence[];
  readonly aggregates: Map<string, AggregateState>;
  rowCount: bigint;
};

const MISSING: BrunoTableGroupedPresence = Object.freeze({ _tag: "Missing" });
const COUNT_DISTINCT_RESULT_SEMANTICS = compileColumnValueSemantics("bigint", {});

export function deriveBrunoTableClientGroupedProjection(
  input: Readonly<{
    readonly rows: readonly BrunoTableClientGroupingInputRow[];
    readonly columns: readonly CompiledColumn[];
    readonly participatingAggregateColumnIds?: ReadonlySet<string>;
    readonly groupBy: readonly string[];
    readonly groupOrderBy: GroupOrderBy;
    readonly previous?: BrunoTableClientGroupedProjection;
  }>,
): BrunoTableClientGroupedProjection {
  const groupBy = Object.freeze(Array.from(input.groupBy));
  try {
    const columnsById = new Map<string, CompiledColumn>(
      input.columns.map((column) => [column.columnId, column]),
    );
    const groupColumns: CompiledFieldColumn[] = [];
    for (const columnId of input.groupBy) {
      const column = columnsById.get(columnId);
      if (column?.kind !== "field" || !column.groupBy) {
        return invalidGroup(groupBy, columnId, "Grouping requires an eligible Field Column.");
      }
      groupColumns.push(column);
    }
    if (groupColumns.length === 0) {
      return invalidGroup(
        groupBy,
        BRUNO_TABLE_ROWS_COLUMN_ID,
        "Grouping requires at least one Group Key.",
      );
    }
    const activeGroupIds = new Set(input.groupBy);
    const aggregateColumns = input.columns.filter(
      (column): column is CompiledFieldColumn =>
        column.kind === "field" &&
        column.aggFunc !== undefined &&
        !activeGroupIds.has(column.columnId) &&
        (input.participatingAggregateColumnIds === undefined ||
          input.participatingAggregateColumnIds.has(column.columnId)),
    );
    const groups = new Map<string, MutableGroup>();
    for (const row of input.rows) {
      const groupKeys = groupColumns.map((column) => readPresence(row, column));
      const rowId = groupIdentity(groupColumns, groupKeys);
      let group = groups.get(rowId);
      if (group === undefined) {
        group = {
          rowId,
          insertionIndex: groups.size,
          groupKeys: Object.freeze(groupKeys),
          aggregates: new Map(
            aggregateColumns.map((column) => [column.columnId, createAggregateState(column)]),
          ),
          rowCount: 0n,
        };
        groups.set(rowId, group);
      }
      group.rowCount += 1n;
      for (const state of group.aggregates.values()) {
        const failure = updateAggregate(state, readPresence(row, state.column));
        if (failure !== undefined) {
          return invalidSourceRow(groupBy, row.rowIndex, state.column.columnId, failure);
        }
      }
    }
    const materialized = Array.from(groups.values(), (group) =>
      materializeGroup(group, groupColumns),
    );
    const sorted = materialized.toSorted((left, right) =>
      compareGroups(left, right, input.groupOrderBy, columnsById, activeGroupIds),
    );
    const previousProjection = input.previous?.kind === "ready" ? input.previous : undefined;
    const previousRows =
      previousProjection === undefined
        ? undefined
        : new Map(previousProjection.rows.map((row) => [row.rowId, row]));
    const candidateRows = sorted.map((entry) => {
      const previous = previousRows?.get(entry.row.rowId);
      return previous !== undefined &&
        sameGroupedRow(previous, entry.row, columnsById, activeGroupIds)
        ? previous
        : entry.row;
    });
    const rows =
      previousProjection !== undefined &&
      candidateRows.length === previousProjection.rows.length &&
      candidateRows.every((row, index) => row === previousProjection.rows[index])
        ? previousProjection.rows
        : Object.freeze(candidateRows);
    return Object.freeze({
      kind: "ready",
      groupBy,
      rows,
      rowIds: Object.freeze(rows.map((row) => row.rowId)),
    });
  } catch (error) {
    if (error instanceof GroupingAggregateError) {
      return error.rowIndex === undefined
        ? invalidGroup(groupBy, error.columnId, error.message)
        : invalidSourceRow(groupBy, error.rowIndex, error.columnId, error.message);
    }
    return invalidGroup(
      groupBy,
      BRUNO_TABLE_ROWS_COLUMN_ID,
      error instanceof Error ? error.message : "Grouped projection derivation failed.",
    );
  }
}

function readPresence(
  row: BrunoTableClientGroupingInputRow,
  column: CompiledFieldColumn,
): BrunoTableGroupedPresence {
  const descriptor =
    typeof row.raw === "object" && row.raw !== null
      ? Object.getOwnPropertyDescriptor(row.raw, column.field)
      : undefined;
  if (descriptor === undefined || !descriptor.enumerable) return MISSING;
  const value = row.readValue(column);
  if (isBrunoTableInvalidCellValue(value)) {
    throw new GroupingAggregateError(column.columnId, value.invalid.message, row.rowIndex);
  }
  const normalizedValue = column.valueType === "number" && Object.is(value, -0) ? 0 : value;
  return Object.freeze({ _tag: "Present", value: normalizedValue });
}

function groupIdentity(
  columns: readonly CompiledFieldColumn[],
  values: readonly BrunoTableGroupedPresence[],
): BrunoTableRowId {
  const parts = columns.map((column, index) => {
    const presence = values[index]!;
    const valueKey = canonicalPresenceKey(presence, column);
    return frame(column.columnId) + frame(column.semantics.codecId) + frame(valueKey);
  });
  return `BRUNO_TABLE_GROUP:${parts.join("")}`;
}

function frame(value: string): string {
  return `${String(value.length)}:${value}`;
}

function canonicalPresenceKey(
  presence: BrunoTableGroupedPresence,
  column: CompiledFieldColumn,
): string {
  if (presence._tag === "Missing") return "0";
  if (presence.value === null) return "1";
  if (presence.value === undefined) return "2";
  return `3${frame(column.semantics.formatCanonicalText(presence.value))}`;
}

function createAggregateState(column: CompiledFieldColumn): AggregateState {
  switch (column.aggFunc) {
    case "countDistinct":
      return { kind: "countDistinct", column, values: new Map() };
    case "sum":
    case "avg":
      return { kind: column.aggFunc, column, count: 0n, total: MISSING };
    case "min":
    case "max":
      return { kind: column.aggFunc, column, selected: undefined };
    case undefined:
      throw new TypeError("Aggregate state requires an aggregate function.");
  }
  throw new TypeError("Aggregate state received an unsupported aggregate function.");
}

function updateAggregate(
  state: AggregateState,
  presence: BrunoTableGroupedPresence,
): string | undefined {
  if (state.kind === "countDistinct") {
    state.values.set(canonicalPresenceKey(presence, state.column), true);
    return undefined;
  }
  if (state.kind === "min" || state.kind === "max") {
    if (
      state.selected === undefined ||
      comparePresence(presence, state.selected, state.column) * (state.kind === "min" ? 1 : -1) < 0
    ) {
      state.selected = presence;
    }
    return undefined;
  }
  if (presence._tag === "Missing") return undefined;
  if (state.total._tag === "Missing") {
    state.total = presence;
    state.count = 1n;
    return undefined;
  }
  const result = state.column.semantics.aggregateAlgebra?.add(state.total.value, presence.value);
  if (result === undefined) return "Aggregate Algebra add operation is unavailable.";
  if (result._tag === "Failure") return result.message;
  state.total = Object.freeze({ _tag: "Present", value: result.value });
  state.count += 1n;
  return undefined;
}

function comparePresence(
  left: BrunoTableGroupedPresence,
  right: BrunoTableGroupedPresence,
  column: CompiledFieldColumn,
): number {
  if (left._tag === "Missing") return right._tag === "Missing" ? 0 : -1;
  if (right._tag === "Missing") return 1;
  const leftNullishRank = nullishRank(left.value);
  const rightNullishRank = nullishRank(right.value);
  if (leftNullishRank !== rightNullishRank) return leftNullishRank - rightNullishRank;
  if (leftNullishRank < 2) return 0;
  return column.semantics.compare(left.value, right.value);
}

function nullishRank(value: unknown): 0 | 1 | 2 {
  return value === null ? 0 : value === undefined ? 1 : 2;
}

type MaterializedGroup = Readonly<{
  readonly insertionIndex: number;
  readonly presences: ReadonlyMap<string, BrunoTableGroupedPresence>;
  readonly row: BrunoTableClientGroupedRow;
}>;

function materializeGroup(
  group: MutableGroup,
  groupColumns: readonly CompiledFieldColumn[],
): MaterializedGroup {
  const values = new Map<string, unknown>();
  const presences = new Map<string, BrunoTableGroupedPresence>();
  groupColumns.forEach((column, index) => {
    const presence = group.groupKeys[index]!;
    presences.set(column.columnId, presence);
    values.set(column.columnId, presence._tag === "Present" ? presence.value : undefined);
  });
  const rowsPresence: BrunoTableGroupedPresence = Object.freeze({
    _tag: "Present",
    value: group.rowCount,
  });
  presences.set(BRUNO_TABLE_ROWS_COLUMN_ID, rowsPresence);
  values.set(BRUNO_TABLE_ROWS_COLUMN_ID, group.rowCount);
  for (const [columnId, state] of group.aggregates) {
    const presence = aggregateResult(state);
    presences.set(columnId, presence);
    values.set(columnId, presence._tag === "Present" ? presence.value : undefined);
  }
  return Object.freeze({
    insertionIndex: group.insertionIndex,
    presences,
    row: Object.freeze({
      rowId: group.rowId,
      rowCount: group.rowCount,
      groupKeys: group.groupKeys,
      values,
      presences,
    }),
  });
}

function sameGroupedRow(
  previous: BrunoTableClientGroupedRow,
  next: BrunoTableClientGroupedRow,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  activeGroupIds: ReadonlySet<string>,
): boolean {
  if (previous.rowCount !== next.rowCount || previous.presences.size !== next.presences.size) {
    return false;
  }
  for (const [columnId, nextPresence] of next.presences) {
    const previousPresence = previous.presences.get(columnId);
    if (previousPresence === undefined || previousPresence._tag !== nextPresence._tag) return false;
    if (nextPresence._tag === "Missing" || previousPresence._tag === "Missing") continue;
    if (columnId === BRUNO_TABLE_ROWS_COLUMN_ID) {
      if (previousPresence.value !== nextPresence.value) return false;
      continue;
    }
    const column = columnsById.get(columnId);
    if (column === undefined) return false;
    try {
      if (
        previousPresence.value === null ||
        previousPresence.value === undefined ||
        nextPresence.value === null ||
        nextPresence.value === undefined
      ) {
        if (previousPresence.value !== nextPresence.value) return false;
        continue;
      }
      const semantics = activeGroupIds.has(columnId) ? column.semantics : resultSemantics(column);
      if (!semantics.equivalent(previousPresence.value, nextPresence.value)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function aggregateResult(state: AggregateState): BrunoTableGroupedPresence {
  if (state.kind === "countDistinct") {
    return Object.freeze({ _tag: "Present", value: BigInt(state.values.size) });
  }
  if (state.kind === "min" || state.kind === "max" || state.kind === "sum") {
    return state.kind === "sum" && state.total._tag === "Missing"
      ? MISSING
      : state.kind === "sum"
        ? state.total
        : (state.selected ?? MISSING);
  }
  if (state.total._tag === "Missing") return MISSING;
  const result = state.column.semantics.aggregateAlgebra?.divideByCount?.(
    state.total.value,
    state.count,
  );
  if (result === undefined || result._tag === "Failure") {
    throw new GroupingAggregateError(
      state.column.columnId,
      result?._tag === "Failure" ? result.message : "Aggregate Algebra division is unavailable.",
    );
  }
  return Object.freeze({ _tag: "Present", value: result.value });
}

function compareGroups(
  left: MaterializedGroup,
  right: MaterializedGroup,
  orderBy: GroupOrderBy,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  activeGroupIds: ReadonlySet<string>,
): number {
  for (const order of orderBy) {
    const leftValue = left.presences.get(order.columnId) ?? MISSING;
    const rightValue = right.presences.get(order.columnId) ?? MISSING;
    let comparison: number;
    if (order.columnId === BRUNO_TABLE_ROWS_COLUMN_ID) {
      comparison = compareBigIntPresence(leftValue, rightValue);
    } else {
      const column = columnsById.get(order.columnId);
      if (column?.kind !== "field") continue;
      comparison = comparePresenceWithSemantics(
        leftValue,
        rightValue,
        activeGroupIds.has(column.columnId) ? column.semantics : resultSemantics(column),
      );
    }
    if (comparison !== 0) return order.direction === "asc" ? comparison : -comparison;
  }
  return left.insertionIndex - right.insertionIndex;
}

function resultSemantics(column: CompiledColumn): CompiledColumnValueSemantics {
  return column.kind === "field" && column.aggFunc === "countDistinct"
    ? COUNT_DISTINCT_RESULT_SEMANTICS
    : column.semantics;
}

function comparePresenceWithSemantics(
  left: BrunoTableGroupedPresence,
  right: BrunoTableGroupedPresence,
  semantics: CompiledColumnValueSemantics,
): number {
  if (left._tag === "Missing") return right._tag === "Missing" ? 0 : -1;
  if (right._tag === "Missing") return 1;
  const leftNullishRank = nullishRank(left.value);
  const rightNullishRank = nullishRank(right.value);
  if (leftNullishRank !== rightNullishRank) return leftNullishRank - rightNullishRank;
  if (leftNullishRank < 2) return 0;
  return semantics.compare(left.value, right.value);
}

function compareBigIntPresence(
  left: BrunoTableGroupedPresence,
  right: BrunoTableGroupedPresence,
): number {
  if (left._tag === "Missing") return right._tag === "Missing" ? 0 : -1;
  if (right._tag === "Missing") return 1;
  const leftValue = left.value as bigint;
  const rightValue = right.value as bigint;
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}

class GroupingAggregateError extends Error {
  public constructor(
    public readonly columnId: string,
    message: string,
    public readonly rowIndex?: number,
  ) {
    super(message);
  }
}

function invalidGroup(
  groupBy: readonly string[],
  columnId: string,
  message: string,
): BrunoTableClientGroupedProjection {
  return Object.freeze({
    kind: "invalid",
    groupBy,
    invalid: Object.freeze({ kind: "group", columnId, message }),
  });
}

function invalidSourceRow(
  groupBy: readonly string[],
  rowIndex: number,
  columnId: string,
  message: string,
): BrunoTableClientGroupedProjection {
  return Object.freeze({
    kind: "invalid",
    groupBy,
    invalid: Object.freeze({ kind: "source-row", rowIndex, columnId, message }),
  });
}
