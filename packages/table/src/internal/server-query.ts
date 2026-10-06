import type { CompiledColumn, CompiledFieldColumn } from "./compile-columns";
import { BRUNO_TABLE_ROWS_COLUMN_ID } from "./grouped-row";

export type BrunoTableServerQueryInput = Readonly<{
  readonly routeBy?: Readonly<Record<string, unknown>>;
  readonly externalFilters?: readonly unknown[];
  readonly filters: readonly unknown[];
  readonly quickFilter: string;
  readonly quickFilterFields: readonly string[];
  readonly visibleColumnIds?: readonly string[];
  readonly orderBy: readonly Readonly<{
    readonly columnId: string;
    readonly direction: "asc" | "desc";
  }>[];
  readonly groupBy?: readonly string[];
  readonly groupOrderBy?: readonly Readonly<{
    readonly columnId: string;
    readonly direction: "asc" | "desc";
  }>[];
}>;

export type BrunoTableCompiledServerRawQuery = Readonly<{
  readonly routeBy?: Readonly<Record<string, unknown>>;
  readonly select: readonly [string, ...string[]];
  readonly where: readonly unknown[];
  readonly orderBy: readonly Readonly<{
    readonly field: string;
    readonly direction: "asc" | "desc";
  }>[];
}>;

export type BrunoTableCompiledServerGroupedQuery = Readonly<{
  readonly routeBy?: Readonly<Record<string, unknown>>;
  readonly groupBy: readonly [string, ...string[]];
  readonly aggregates: Readonly<
    Record<string, Readonly<{ readonly aggFunc: string; readonly field?: string }>>
  >;
  readonly where: readonly unknown[];
  readonly orderBy: readonly Readonly<{
    readonly field?: string;
    readonly aggregate?: string;
    readonly direction: "asc" | "desc";
  }>[];
}>;

export type BrunoTableCompiledServerQuery =
  | BrunoTableCompiledServerRawQuery
  | BrunoTableCompiledServerGroupedQuery;

export type BrunoTableCompiledServerGroupedProjection = Readonly<{
  readonly rowsAlias: string;
  readonly groupKeys: readonly Readonly<{ readonly columnId: string; readonly field: string }>[];
  readonly aggregates: readonly Readonly<{
    readonly alias: string;
    readonly columnId: string;
    readonly field: string;
    readonly aggFunc: string;
  }>[];
}>;

export type BrunoTableCompiledServerRawQueryPlan = Readonly<{
  readonly query: BrunoTableCompiledServerRawQuery;
  readonly grouped?: never;
}>;

export type BrunoTableCompiledServerGroupedQueryPlan = Readonly<{
  readonly query: BrunoTableCompiledServerGroupedQuery;
  readonly grouped: BrunoTableCompiledServerGroupedProjection;
}>;

export type BrunoTableCompiledServerQueryPlan =
  | BrunoTableCompiledServerRawQueryPlan
  | BrunoTableCompiledServerGroupedQueryPlan;

export const BRUNO_TABLE_SERVER_FACET_COUNT_ALIAS = "__bruno_table_facet_count";

export type BrunoTableCompiledServerFacetQuery = Readonly<{
  readonly routeBy?: Readonly<Record<string, unknown>>;
  readonly groupBy: readonly [string];
  readonly aggregates: Readonly<Record<string, Readonly<{ readonly aggFunc: "count" }>>>;
  readonly where: readonly unknown[];
  readonly orderBy: readonly [Readonly<{ readonly field: string; readonly direction: "asc" }>];
}>;

export type BrunoTableCompiledServerFacetQueryPlan = Readonly<{
  readonly countAlias: string;
  readonly query: BrunoTableCompiledServerFacetQuery;
}>;

export function compileBrunoTableServerProjectionFields(
  columns: readonly CompiledColumn[],
  quickFilterFields: readonly string[],
  completeRawSelect: readonly [string, ...string[]] | undefined,
  visibleColumnIds?: readonly string[],
): readonly [string, ...string[]] {
  const visibleIds = visibleColumnIds === undefined ? undefined : new Set(visibleColumnIds);
  const activeColumns =
    visibleIds === undefined
      ? columns
      : columns.filter((column) => visibleIds.has(column.columnId));
  if (activeColumns.some(columnUsesRawRowPresentation)) {
    if (completeRawSelect === undefined) {
      throw new TypeError(
        "BrunoTable Server raw-row presentation requires source-owned completeRawSelect.",
      );
    }
    return completeRawSelect;
  }
  const fields = new Set<string>();
  for (const column of activeColumns) {
    if (column.kind === "field") fields.add(column.field);
    else for (const field of column.fields) fields.add(field);
  }
  for (const field of quickFilterFields) fields.add(field);
  const select = [...fields];
  const first = select[0];
  if (first === undefined) {
    throw new TypeError("BrunoTable Server projection must contain at least one Query Field.");
  }
  return Object.freeze([first, ...select.slice(1)]);
}

export function compileBrunoTableServerQueryPlan(
  columns: readonly CompiledColumn[],
  input: BrunoTableServerQueryInput &
    Readonly<{ readonly groupBy: readonly [string, ...string[]] }>,
  completeRawSelect: readonly [string, ...string[]] | undefined,
): BrunoTableCompiledServerGroupedQueryPlan;
export function compileBrunoTableServerQueryPlan(
  columns: readonly CompiledColumn[],
  input: BrunoTableServerQueryInput & Readonly<{ readonly groupBy?: undefined | readonly [] }>,
  completeRawSelect: readonly [string, ...string[]] | undefined,
): BrunoTableCompiledServerRawQueryPlan;
export function compileBrunoTableServerQueryPlan(
  columns: readonly CompiledColumn[],
  input: BrunoTableServerQueryInput,
  completeRawSelect: readonly [string, ...string[]] | undefined,
): BrunoTableCompiledServerQueryPlan;
export function compileBrunoTableServerQueryPlan(
  columns: readonly CompiledColumn[],
  input: BrunoTableServerQueryInput,
  completeRawSelect: readonly [string, ...string[]] | undefined,
): BrunoTableCompiledServerQueryPlan {
  const fieldColumns = new Map<string, CompiledFieldColumn>();
  for (const column of columns) {
    if (column.kind === "field") {
      fieldColumns.set(column.columnId, column);
    }
  }
  const where = [...(input.externalFilters ?? [])];
  where.push(...input.filters.map((filter) => compileFilter(filter, fieldColumns)));
  if (input.quickFilter.length > 0 && input.quickFilterFields.length > 0) {
    const quickFilterFields = [...input.quickFilterFields].sort();
    where.push(
      Object.freeze({
        type: "OR",
        conditions: Object.freeze(
          quickFilterFields.map((field) =>
            Object.freeze({ field, type: "contains", filter: input.quickFilter }),
          ),
        ),
      }),
    );
  }

  if ((input.groupBy?.length ?? 0) > 0) {
    return compileGroupedQueryPlan(columns, fieldColumns, input, Object.freeze(where));
  }

  const select = compileBrunoTableServerProjectionFields(
    columns,
    input.quickFilterFields,
    completeRawSelect,
    input.visibleColumnIds,
  );
  const orderBy = input.orderBy.map((order) => {
    const column = fieldColumns.get(order.columnId);
    if (column === undefined || !column.enableSorting) {
      throw new TypeError(`BrunoTable Server sort has no Query Field: ${order.columnId}`);
    }
    return Object.freeze({ field: column.field, direction: order.direction });
  });
  if (orderBy.length === 0) {
    throw new TypeError("BrunoTable Server requires a non-empty orderBy query.");
  }

  return Object.freeze({
    query: Object.freeze({
      ...(input.routeBy === undefined ? {} : { routeBy: input.routeBy }),
      select,
      where: Object.freeze(where),
      orderBy: Object.freeze(orderBy),
    }),
  });
}

function compileGroupedQueryPlan(
  columns: readonly CompiledColumn[],
  fieldColumns: ReadonlyMap<string, CompiledFieldColumn>,
  input: BrunoTableServerQueryInput,
  where: readonly unknown[],
): BrunoTableCompiledServerGroupedQueryPlan {
  const groupKeys = (input.groupBy ?? []).map((columnId) => {
    const column = fieldColumns.get(columnId);
    if (column === undefined || !column.groupBy) {
      throw new TypeError(`BrunoTable Server Group By has no eligible Query Field: ${columnId}`);
    }
    return Object.freeze({ columnId, field: column.field });
  });
  const firstGroup = groupKeys[0];
  if (firstGroup === undefined)
    throw new TypeError("BrunoTable Server grouping requires a Group Key.");
  const active = new Set(groupKeys.map(({ columnId }) => columnId));
  const visible =
    input.visibleColumnIds === undefined ? undefined : new Set(input.visibleColumnIds);
  const reservedAliases = new Set<string>([
    "__proto__",
    "prototype",
    "constructor",
    ...groupKeys.map(({ field }) => field),
  ]);
  const nextAlias = (base: string): string => {
    let candidate = base;
    let suffix = 0;
    while (reservedAliases.has(candidate)) candidate = `${base}_${String(++suffix)}`;
    reservedAliases.add(candidate);
    return candidate;
  };
  const rowsAlias = nextAlias("__bruno_table_rows");
  const aggregates = columns
    .filter(
      (column): column is CompiledFieldColumn =>
        column.kind === "field" &&
        column.aggFunc !== undefined &&
        !active.has(column.columnId) &&
        (visible === undefined || visible.has(column.columnId)),
    )
    .toSorted((left, right) => compareColumnIdentity(left.columnId, right.columnId))
    .map((column) =>
      compileServerAggregate(column, nextAlias(stableAggregateAlias(column.columnId))),
    );
  const aliasesByColumn = new Map<string, string>(
    aggregates.map((aggregate) => [aggregate.columnId, aggregate.alias]),
  );
  const groupFieldsByColumn = new Map<string, string>(
    groupKeys.map((group) => [group.columnId, group.field]),
  );
  const groupedOrderBy = input.groupOrderBy ?? [];
  if (groupedOrderBy.length === 0) {
    throw new TypeError("BrunoTable Server grouped sorting requires a non-empty orderBy query.");
  }
  const orderBy = groupedOrderBy.map((order) => {
    if (order.columnId === BRUNO_TABLE_ROWS_COLUMN_ID) {
      return Object.freeze({ aggregate: rowsAlias, direction: order.direction });
    }
    const field = groupFieldsByColumn.get(order.columnId);
    if (field !== undefined) return Object.freeze({ field, direction: order.direction });
    const aggregate = aliasesByColumn.get(order.columnId);
    if (aggregate !== undefined) return Object.freeze({ aggregate, direction: order.direction });
    throw new TypeError(`BrunoTable Server grouped sort is not active: ${order.columnId}`);
  });
  const aggregateQuery: Record<
    string,
    Readonly<{ readonly aggFunc: string; readonly field?: string }>
  > = {
    [rowsAlias]: Object.freeze({ aggFunc: "count" }),
  };
  for (const aggregate of aggregates) {
    aggregateQuery[aggregate.alias] = Object.freeze({
      aggFunc: aggregate.aggFunc,
      field: aggregate.field,
    });
  }
  const groupedFields: readonly [string, ...string[]] = Object.freeze([
    firstGroup.field,
    ...groupKeys.slice(1).map(({ field }) => field),
  ]);
  return Object.freeze({
    grouped: Object.freeze({
      rowsAlias,
      groupKeys: Object.freeze(groupKeys),
      aggregates: Object.freeze(aggregates),
    }),
    query: Object.freeze({
      ...(input.routeBy === undefined ? {} : { routeBy: input.routeBy }),
      groupBy: groupedFields,
      aggregates: Object.freeze(aggregateQuery),
      where,
      orderBy: Object.freeze(orderBy),
    }),
  });
}

function stableAggregateAlias(columnId: string): string {
  let encoded = "";
  for (let index = 0; index < columnId.length; index += 1) {
    encoded += columnId.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return `__bruno_table_aggregate_${encoded}`;
}

function compareColumnIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compileServerAggregate(
  column: CompiledFieldColumn,
  alias: string,
): BrunoTableCompiledServerGroupedProjection["aggregates"][number] {
  assertBrunoTableServerAggregateAuthority(column);
  const aggFunc = column.aggFunc;
  if (aggFunc === undefined) {
    throw new TypeError(`BrunoTable Server aggregate is missing its function: ${column.columnId}`);
  }
  return Object.freeze({
    alias,
    columnId: column.columnId,
    field: column.field,
    aggFunc,
  });
}

export function assertBrunoTableServerAggregateAuthorities(
  columns: readonly CompiledColumn[],
): void {
  for (const column of columns) {
    if (column.kind === "field" && column.aggFunc !== undefined) {
      assertBrunoTableServerAggregateAuthority(column);
    }
  }
}

function assertBrunoTableServerAggregateAuthority(column: CompiledFieldColumn): void {
  const aggFunc = column.aggFunc;
  if (
    (aggFunc === "sum" || aggFunc === "avg") &&
    column.semantics.serverAggregateAuthority !== "effect-bigdecimal" &&
    !(aggFunc === "sum" && column.semantics.serverAggregateAuthority === "core-bigint")
  ) {
    throw new TypeError(
      `BrunoTable Server aggregate has no source-compatible exact result Value Type: ${column.columnId}`,
    );
  }
}

export function compileBrunoTableServerFacetQuery(
  columns: readonly CompiledColumn[],
  columnId: string,
  input: BrunoTableServerQueryInput,
): BrunoTableCompiledServerFacetQueryPlan {
  const fieldColumns = new Map<string, CompiledFieldColumn>();
  for (const column of columns) {
    if (column.kind === "field") fieldColumns.set(column.columnId, column);
  }
  const column = fieldColumns.get(columnId);
  if (column === undefined || !column.enableFilter || !column.enableSetFilter) {
    throw new TypeError(`BrunoTable Server facet has no Query Field: ${columnId}`);
  }
  const where = [...(input.externalFilters ?? [])];
  where.push(
    ...selectBrunoTableServerFacetGridFilters(input.filters, columnId).map((filter) =>
      compileFilter(filter, fieldColumns),
    ),
  );
  if (input.quickFilter.length > 0 && input.quickFilterFields.length > 0) {
    where.push(
      Object.freeze({
        type: "OR",
        conditions: Object.freeze(
          [...input.quickFilterFields]
            .sort()
            .map((field) => Object.freeze({ field, type: "contains", filter: input.quickFilter })),
        ),
      }),
    );
  }
  const groupBy: readonly [string] = Object.freeze([column.field]);
  const countAlias =
    column.field === BRUNO_TABLE_SERVER_FACET_COUNT_ALIAS
      ? `${BRUNO_TABLE_SERVER_FACET_COUNT_ALIAS}_1`
      : BRUNO_TABLE_SERVER_FACET_COUNT_ALIAS;
  const orderBy: readonly [Readonly<{ readonly field: string; readonly direction: "asc" }>] =
    Object.freeze([Object.freeze({ field: column.field, direction: "asc" })]);
  return Object.freeze({
    countAlias,
    query: Object.freeze({
      ...(input.routeBy === undefined ? {} : { routeBy: input.routeBy }),
      groupBy,
      aggregates: Object.freeze({
        [countAlias]: Object.freeze({ aggFunc: "count" }),
      }),
      where: Object.freeze(where),
      orderBy,
    }),
  });
}

export function selectBrunoTableServerFacetGridFilters(
  filters: readonly unknown[],
  columnId: string,
): readonly unknown[] {
  return filters.filter((filter) => !filterContainsColumn(filter, columnId));
}

export function columnUsesRawRowPresentation(column: CompiledColumn): boolean {
  return (
    column.valueFormatter !== undefined ||
    typeof column.cellClassName === "function" ||
    column.cellRenderer !== undefined
  );
}

function compileFilter(
  filter: unknown,
  columns: ReadonlyMap<string, CompiledFieldColumn>,
): unknown {
  if (!isRecord(filter)) throw new TypeError("BrunoTable Server filter must be an object.");
  const type = Reflect.get(filter, "type");
  if (type === "AND" || type === "OR") {
    const conditions = Reflect.get(filter, "conditions");
    if (!Array.isArray(conditions) || conditions.length === 0) {
      throw new TypeError("BrunoTable Server compound filters must be non-empty.");
    }
    return Object.freeze({
      type,
      conditions: Object.freeze(conditions.map((condition) => compileFilter(condition, columns))),
    });
  }
  if (type === "NOT") {
    return Object.freeze({
      type,
      condition: compileFilter(Reflect.get(filter, "condition"), columns),
    });
  }

  const columnId = Reflect.get(filter, "columnId");
  if (typeof columnId !== "string") {
    throw new TypeError("BrunoTable Server filter is missing its Column Identity.");
  }
  const column = columns.get(columnId);
  if (column === undefined || !column.enableFilter) {
    throw new TypeError(`BrunoTable Server filter has no Query Field: ${columnId}`);
  }
  if (type === "matchNone") {
    if (!column.enableSetFilter) {
      throw new TypeError(`BrunoTable Server Match None requires a Set Filter: ${columnId}`);
    }
    return Object.freeze({ type: "FALSE" });
  }
  if (typeof type !== "string" || !FIELD_FILTER_TYPES.has(type)) {
    throw new TypeError(`BrunoTable Server filter operator is unsupported: ${String(type)}`);
  }

  const compiled: Record<PropertyKey, unknown> = { field: column.field, type };
  copyOwn(filter, compiled, "filter");
  copyOwn(filter, compiled, "filterTo");
  copyOwn(filter, compiled, "caseSensitive");
  copyOwn(filter, compiled, "accentSensitive");
  return Object.freeze(compiled);
}

function copyOwn(
  source: Readonly<Record<PropertyKey, unknown>>,
  target: Record<PropertyKey, unknown>,
  property: PropertyKey,
): void {
  if (Object.prototype.hasOwnProperty.call(source, property)) {
    const value = Reflect.get(source, property);
    Reflect.set(target, property, Array.isArray(value) ? Object.freeze([...value]) : value);
  }
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null;
}

function filterContainsColumn(filter: unknown, columnId: string): boolean {
  if (!isRecord(filter)) return false;
  if (Reflect.get(filter, "columnId") === columnId) return true;
  const conditions = Reflect.get(filter, "conditions");
  if (Array.isArray(conditions)) {
    return conditions.some((condition) => filterContainsColumn(condition, columnId));
  }
  return filterContainsColumn(Reflect.get(filter, "condition"), columnId);
}

const FIELD_FILTER_TYPES = new Set([
  "equals",
  "notEqual",
  "in",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "inRange",
  "blank",
  "notBlank",
]);
