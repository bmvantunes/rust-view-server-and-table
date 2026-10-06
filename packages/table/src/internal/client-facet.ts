import type { CompiledColumn } from "./compile-columns";
import type {
  BrunoTableClientFacetRowsSnapshot,
  BrunoTableClientFacetRowsSource,
} from "./client-source-adapter";
import { type BrunoTableClientFilterCollection, removeClientFilterColumn } from "./grid-query";
import { createClientQueryPredicate, normalizeClientQuickFilterQuery } from "./quick-filter";
import {
  isBrunoTableInvalidCellValue,
  type BrunoTableRowPipelineRuntimeView,
} from "./grid-runtime";
import {
  addBrunoTableSetValueToIndex,
  areBrunoTableSetValuesEquivalent,
  brunoTableSetValueKey,
  createBrunoTableSetValueIndex,
  hasBrunoTableSetValue,
} from "./set-value-identity";

export {
  areBrunoTableSetValuesEquivalent,
  createBrunoTableSetValueIndex,
  hasBrunoTableSetValue,
} from "./set-value-identity";

export type BrunoTableSetFilterIntent =
  | Readonly<{ readonly kind: "all" }>
  | Readonly<{ readonly kind: "include"; readonly values: readonly unknown[] }>
  | Readonly<{ readonly kind: "exclude"; readonly values: readonly unknown[] }>;

export type BrunoTableSetFilterCommand =
  | Readonly<{ readonly type: "select-all" }>
  | Readonly<{ readonly type: "clear-all" }>
  | Readonly<{ readonly type: "toggle"; readonly value: unknown; readonly selected: boolean }>;

export type BrunoTableClientFacetOption = Readonly<{
  readonly value: unknown;
  readonly count: number | bigint;
  readonly display: string;
}>;

export type BrunoTableClientFacetSnapshot = Readonly<{
  readonly intent: BrunoTableSetFilterIntent;
  readonly options: readonly BrunoTableClientFacetOption[];
}>;

export type BrunoTableClientFacetStore = Readonly<{
  readonly getSnapshot: () => BrunoTableClientFacetSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}>;

export type BrunoTableClientFacetSubscriptionEvent = Readonly<{
  readonly columnId: string;
  readonly phase: "subscribe" | "notify" | "unsubscribe";
}>;

let facetSubscriptionListener:
  | ((event: BrunoTableClientFacetSubscriptionEvent) => void)
  | undefined;

export function installBrunoTableClientFacetSubscriptionListener(
  listener: (event: BrunoTableClientFacetSubscriptionEvent) => void,
): () => void {
  facetSubscriptionListener = listener;
  return () => {
    if (facetSubscriptionListener === listener) facetSubscriptionListener = undefined;
  };
}

const ALL_INTENT: BrunoTableSetFilterIntent = Object.freeze({ kind: "all" });

export function createBrunoTableClientFacetStore(
  options: Readonly<{
    readonly column: CompiledColumn;
    readonly rows: BrunoTableClientFacetRowsSource;
    readonly runtime: BrunoTableRowPipelineRuntimeView;
  }>,
): BrunoTableClientFacetStore {
  let previousRows: BrunoTableClientFacetRowsSnapshot | undefined;
  let previousQuery: ReturnType<BrunoTableRowPipelineRuntimeView["getQuerySnapshot"]> | undefined;
  let snapshot: BrunoTableClientFacetSnapshot | undefined;

  function project(): BrunoTableClientFacetSnapshot {
    const rowSnapshot = options.rows.getFacetRowsSnapshot(options.runtime.getRowSpaceSnapshot());
    const rows = rowSnapshot.rows;
    const query = options.runtime.getQuerySnapshot();
    if (
      previousRows?.token === rowSnapshot.token &&
      previousQuery?.columns === query.columns &&
      previousQuery.filterCollection === query.filterCollection &&
      previousQuery.quickFilter === query.quickFilter &&
      snapshot !== undefined
    ) {
      return snapshot;
    }
    if (
      snapshot !== undefined &&
      previousRows?.token === rowSnapshot.token &&
      previousQuery?.columns === query.columns &&
      previousQuery.quickFilter === query.quickFilter &&
      sameOtherFilterReferences(
        previousQuery.filterCollection,
        query.filterCollection,
        options.column.columnId,
      )
    ) {
      previousRows = rowSnapshot;
      previousQuery = query;
      snapshot = completeFacetSnapshot(
        options.column,
        snapshot.options.filter((option) => option.count > 0),
        readBrunoTableSetFilterIntent(
          options.column,
          query.filterCollection.filtersByColumn.get(options.column.columnId),
        ),
      );
      return snapshot;
    }
    if (
      snapshot !== undefined &&
      previousRows !== undefined &&
      previousQuery?.columns === query.columns &&
      previousQuery.filterCollection === query.filterCollection &&
      previousQuery.quickFilter === query.quickFilter &&
      facetDependenciesUnchanged(
        options.column,
        query.columns,
        query.filterCollection,
        normalizeClientQuickFilterQuery(query.quickFilter) === undefined
          ? []
          : options.runtime.getQuickFilterFieldsSnapshot(),
        previousRows,
        rowSnapshot,
      )
    ) {
      previousRows = rowSnapshot;
      previousQuery = query;
      return snapshot;
    }
    previousRows = rowSnapshot;
    previousQuery = query;
    snapshot = createBrunoTableClientFacetSnapshot({
      column: options.column,
      columns: query.columns,
      filterCollection: query.filterCollection,
      quickFilter: query.quickFilter,
      quickFilterFields: options.runtime.getQuickFilterFieldsSnapshot(),
      rows,
      readColumnValue: (column, row) => row.values.read(row.raw, row.rowId, row.rowIndex, column),
      readQuickFilterField: (row, field) => Reflect.get(Object(row.raw), field),
    });
    return snapshot;
  }

  return Object.freeze({
    getSnapshot: project,
    subscribe: (listener) => {
      facetSubscriptionListener?.({ columnId: options.column.columnId, phase: "subscribe" });
      const notify = () => {
        const previousSnapshot = snapshot;
        const nextSnapshot = project();
        if (previousSnapshot === nextSnapshot) return;
        facetSubscriptionListener?.({ columnId: options.column.columnId, phase: "notify" });
        listener();
      };
      const unsubscribeFilter = options.runtime.subscribeFilter(notify);
      const unsubscribeRows = options.runtime.subscribeRowSpace(notify);
      return () => {
        unsubscribeRows();
        unsubscribeFilter();
        facetSubscriptionListener?.({ columnId: options.column.columnId, phase: "unsubscribe" });
      };
    },
  });
}

export function readBrunoTableSetFilterIntent(
  column: CompiledColumn,
  expression: unknown,
): BrunoTableSetFilterIntent {
  const record = asRecord(expression);
  if (record["columnId"] === column.columnId && record["type"] === "matchNone") {
    return Object.freeze({ kind: "include", values: Object.freeze([]) });
  }
  if (record["columnId"] === column.columnId && isExactSetIn(column, record)) {
    const values = readExactValues(column, record["filter"]);
    return values === undefined ? ALL_INTENT : Object.freeze({ kind: "include", values });
  }
  if (record["type"] === "NOT") {
    const condition = asRecord(record["condition"]);
    if (condition["columnId"] === column.columnId && isExactSetIn(column, condition)) {
      const values = readExactValues(column, condition["filter"]);
      return values === undefined ? ALL_INTENT : Object.freeze({ kind: "exclude", values });
    }
  }
  return ALL_INTENT;
}

export function isBrunoTableSetFilterExpression(
  column: CompiledColumn,
  expression: unknown,
): boolean {
  const record = asRecord(expression);
  if (
    record["columnId"] === column.columnId &&
    (isExactSetIn(column, record) || record["type"] === "matchNone")
  ) {
    return true;
  }
  const condition = asRecord(record["condition"]);
  return (
    record["type"] === "NOT" &&
    condition["columnId"] === column.columnId &&
    isExactSetIn(column, condition)
  );
}

export function applyBrunoTableSetFilterCommand(
  column: CompiledColumn,
  intent: BrunoTableSetFilterIntent,
  availableValues: readonly unknown[],
  command: BrunoTableSetFilterCommand,
): Readonly<Record<string, unknown>> | undefined {
  if (command.type === "select-all") return undefined;
  if (command.type === "clear-all") {
    return Object.freeze({ columnId: column.columnId, type: "matchNone" });
  }

  if (intent.kind === "all") {
    if (command.selected) return undefined;
    return exclusionExpression(column, [command.value]);
  }

  if (intent.kind === "exclude") {
    const values = toggleExactValue(column, intent.values, command.value, !command.selected);
    return values.length === 0 ? undefined : exclusionExpression(column, values);
  }
  const values = toggleExactValue(column, intent.values, command.value, command.selected);
  if (includesEveryExactValue(column, values, availableValues)) return undefined;
  return values.length === 0
    ? Object.freeze({ columnId: column.columnId, type: "matchNone" })
    : inclusionExpression(column, values);
}

export function createBrunoTableClientFacetSnapshot<TRow>(
  options: Readonly<{
    readonly column: CompiledColumn;
    readonly columns: readonly CompiledColumn[];
    readonly filterCollection: BrunoTableClientFilterCollection;
    readonly quickFilter: string;
    readonly quickFilterFields: readonly string[];
    readonly rows: readonly TRow[];
    readonly readColumnValue: (column: CompiledColumn, row: TRow) => unknown;
    readonly readQuickFilterField: (row: TRow, field: string) => unknown;
  }>,
): BrunoTableClientFacetSnapshot {
  const ownExpression = options.filterCollection.filtersByColumn.get(options.column.columnId);
  const intent = readBrunoTableSetFilterIntent(options.column, ownExpression);
  const otherFilters = removeClientFilterColumn(options.filterCollection, options.column.columnId);
  const predicate = createClientQueryPredicate(
    options.columns,
    otherFilters.filters,
    options.quickFilter,
    options.quickFilterFields,
    options.readColumnValue,
    options.readQuickFilterField,
    otherFilters,
  );
  const buckets = new Map<string, { value: unknown; count: number }[]>();
  const ordered: { value: unknown; count: number }[] = [];

  for (const row of options.rows) {
    if (predicate !== undefined && !predicate(row)) continue;
    const value = options.readColumnValue(options.column, row);
    if (value === null || value === undefined || isBrunoTableInvalidCellValue(value)) continue;
    addFacetValue(options.column, buckets, ordered, value, 1);
  }
  return completeFacetSnapshot(
    options.column,
    ordered.map(({ value, count }) =>
      Object.freeze({ value, count, display: safeFormatDisplay(options.column, value) }),
    ),
    intent,
    buckets,
  );
}

export function createBrunoTableServerFacetSnapshot(
  options: Readonly<{
    readonly column: CompiledColumn;
    readonly countAlias: string;
    readonly rows: readonly unknown[];
    readonly expression: unknown;
  }>,
): BrunoTableClientFacetSnapshot {
  if (options.column.kind !== "field") {
    throw new TypeError("BrunoTable Server facets require a Field Column.");
  }
  const buckets = new Map<string, { value: unknown; count: bigint }[]>();
  const liveOptions: { value: unknown; count: bigint }[] = [];
  for (const candidate of options.rows) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new TypeError("BrunoTable Server facet delivered an invalid grouped row.");
    }
    const rawValue = Reflect.get(candidate, options.column.field);
    const rawCount = Reflect.get(candidate, options.countAlias);
    if (typeof rawCount !== "bigint" || rawCount < 0n) {
      throw new TypeError("BrunoTable Server facet delivered an invalid aggregate count.");
    }
    const decoded = options.column.semantics.decodeRuntime(rawValue);
    if (decoded._tag !== "Success") continue;
    addServerFacetValue(options.column, buckets, liveOptions, decoded.value, rawCount);
  }
  return completeFacetSnapshot(
    options.column,
    liveOptions.map(({ value, count }) =>
      Object.freeze({
        value,
        count,
        display: safeFormatDisplay(options.column, value),
      }),
    ),
    readBrunoTableSetFilterIntent(options.column, options.expression),
    undefined,
    0n,
  );
}

function facetDependenciesUnchanged(
  facetColumn: CompiledColumn,
  columns: readonly CompiledColumn[],
  filters: BrunoTableClientFilterCollection,
  quickFilterFields: readonly string[],
  previous: BrunoTableClientFacetRowsSnapshot,
  next: BrunoTableClientFacetRowsSnapshot,
): boolean {
  if (
    previous.token !== next.parentToken ||
    previous.rows.length !== next.rows.length ||
    next.changedIndexes.length === 0
  ) {
    return false;
  }
  const relevantColumns = [facetColumn];
  for (const expression of filters.expressions) {
    if (expression.columnId === facetColumn.columnId) continue;
    const column = columns.find((candidate) => candidate.columnId === expression.columnId);
    if (column !== undefined && !relevantColumns.includes(column)) relevantColumns.push(column);
  }
  for (const index of next.changedIndexes) {
    const previousRow = previous.rows[index];
    const nextRow = next.rows[index];
    if (previousRow === undefined || nextRow === undefined || previousRow.rowId !== nextRow.rowId) {
      return false;
    }
    for (const column of relevantColumns) {
      const previousValue = previousRow.values.read(
        previousRow.raw,
        previousRow.rowId,
        previousRow.rowIndex,
        column,
      );
      const nextValue = nextRow.values.read(nextRow.raw, nextRow.rowId, nextRow.rowIndex, column);
      const equivalent =
        !isBrunoTableInvalidCellValue(previousValue) &&
        !isBrunoTableInvalidCellValue(nextValue) &&
        areBrunoTableSetValuesEquivalent(column, previousValue, nextValue);
      if (
        !equivalent ||
        (column === facetColumn &&
          safeFormatDisplay(column, previousValue) !== safeFormatDisplay(column, nextValue))
      ) {
        return false;
      }
    }
    for (const field of quickFilterFields) {
      const previousValue = safeReadQuickFilterField(previousRow.raw, field);
      const nextValue = safeReadQuickFilterField(nextRow.raw, field);
      if (!previousValue.readable || !nextValue.readable) return false;
      if (!Object.is(previousValue.value, nextValue.value)) return false;
    }
  }
  return true;
}

function safeReadQuickFilterField(
  row: unknown,
  field: string,
):
  | Readonly<{ readonly readable: true; readonly value: unknown }>
  | Readonly<{ readonly readable: false }> {
  try {
    return { readable: true, value: Reflect.get(Object(row), field) };
  } catch {
    return { readable: false };
  }
}

function completeFacetSnapshot(
  column: CompiledColumn,
  liveOptions: readonly BrunoTableClientFacetOption[],
  intent: BrunoTableSetFilterIntent,
  liveBuckets?: ReadonlyMap<string, readonly { readonly value: unknown }[]>,
  zeroCount: number | bigint = 0,
): BrunoTableClientFacetSnapshot {
  const options = Array.from(liveOptions);
  const liveIndex =
    liveBuckets === undefined
      ? createBrunoTableSetValueIndex(
          column,
          liveOptions.map((option) => option.value),
        )
      : undefined;
  if (intent.kind !== "all") {
    for (const value of intent.values) {
      const key = facetValueKey(column, value);
      const isLive =
        liveBuckets === undefined
          ? hasBrunoTableSetValue(column, liveIndex!, value)
          : liveBuckets
              .get(key)
              ?.some((candidate) =>
                areBrunoTableSetValuesEquivalent(column, candidate.value, value),
              ) === true;
      if (isLive) continue;
      options.push(
        Object.freeze({ value, count: zeroCount, display: safeFormatDisplay(column, value) }),
      );
    }
  }
  return Object.freeze({ intent, options: Object.freeze(options) });
}

function sameOtherFilterReferences(
  previous: BrunoTableClientFilterCollection,
  next: BrunoTableClientFilterCollection,
  columnId: string,
): boolean {
  const previousExpressions = previous.expressions.filter(
    (expression) => expression.columnId !== columnId,
  );
  const nextExpressions = next.expressions.filter((expression) => expression.columnId !== columnId);
  return (
    previousExpressions.length === nextExpressions.length &&
    previousExpressions.every(
      (expression, index) => expression.filter === nextExpressions[index]?.filter,
    )
  );
}

function addFacetValue(
  column: CompiledColumn,
  buckets: Map<string, { value: unknown; count: number }[]>,
  ordered: { value: unknown; count: number }[],
  value: unknown,
  increment: number,
): void {
  addFacetValueInDomain(column, buckets, ordered, value, increment, addNumberFacetCounts);
}

function addServerFacetValue(
  column: CompiledColumn,
  buckets: Map<string, { value: unknown; count: bigint }[]>,
  ordered: { value: unknown; count: bigint }[],
  value: unknown,
  increment: bigint,
): void {
  addFacetValueInDomain(column, buckets, ordered, value, increment, addBigIntFacetCounts);
}

function addNumberFacetCounts(left: number, right: number): number {
  return left + right;
}

function addBigIntFacetCounts(left: bigint, right: bigint): bigint {
  return left + right;
}

function addFacetValueInDomain<TCount>(
  column: CompiledColumn,
  buckets: Map<string, { value: unknown; count: TCount }[]>,
  ordered: { value: unknown; count: TCount }[],
  value: unknown,
  increment: TCount,
  add: (left: TCount, right: TCount) => TCount,
): void {
  const key = facetValueKey(column, value);
  const bucket = buckets.get(key) ?? [];
  const existing = bucket.find((candidate) =>
    areBrunoTableSetValuesEquivalent(column, candidate.value, value),
  );
  if (existing !== undefined) {
    existing.count = add(existing.count, increment);
    return;
  }
  const entry = { value, count: increment };
  bucket.push(entry);
  buckets.set(key, bucket);
  ordered.push(entry);
}

function facetValueKey(column: CompiledColumn, value: unknown): string {
  return brunoTableSetValueKey(column, value) ?? `${typeof value}:${String(value)}`;
}

function readExactValues(
  column: CompiledColumn,
  candidate: unknown,
): readonly unknown[] | undefined {
  if (!Array.isArray(candidate)) return undefined;
  const values: unknown[] = [];
  const index = new Map<string, unknown[]>();
  for (const value of candidate) {
    if (!addBrunoTableSetValueToIndex(column, index, value)) continue;
    values.push(value);
  }
  return Object.freeze(values);
}

function toggleExactValue(
  column: CompiledColumn,
  values: readonly unknown[],
  value: unknown,
  selected: boolean,
): readonly unknown[] {
  const index = values.findIndex((candidate) =>
    areBrunoTableSetValuesEquivalent(column, candidate, value),
  );
  if (selected === index >= 0) return values;
  if (selected) return Object.freeze([...values, value]);
  return Object.freeze(values.filter((_, candidateIndex) => candidateIndex !== index));
}

function includesEveryExactValue(
  column: CompiledColumn,
  selected: readonly unknown[],
  available: readonly unknown[],
): boolean {
  const selectedIndex = createBrunoTableSetValueIndex(column, selected);
  return (
    available.length > 0 &&
    available.every((value) => hasBrunoTableSetValue(column, selectedIndex, value))
  );
}

function exclusionExpression(
  column: CompiledColumn,
  values: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "NOT",
    condition: inclusionExpression(column, values),
  });
}

function inclusionExpression(
  column: CompiledColumn,
  values: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    columnId: column.columnId,
    type: "in",
    filter: values,
    ...(column.semantics.filterFamily === "text"
      ? { caseSensitive: true, accentSensitive: true }
      : {}),
  });
}

function isExactSetIn(
  column: CompiledColumn,
  expression: Readonly<Record<string, unknown>>,
): boolean {
  if (expression["type"] !== "in") return false;
  return (
    column.semantics.filterFamily !== "text" ||
    (expression["caseSensitive"] === true && expression["accentSensitive"] === true)
  );
}

function safeFormatDisplay(column: CompiledColumn, value: unknown): string {
  try {
    return column.semantics.formatDisplay(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : Object.freeze({});
}
