import { describe, expectTypeOf, it } from "vitest";

import { Schema } from "effect";
import { ViewServerId, defineViewServerConfig } from "effect-view-server/config";
import { createViewServerReact } from "effect-view-server/react";
import { SourceAdapter } from "effect-view-server/source-adapter";
import type {
  LiveQueryViewportBaseRow,
  LiveQueryViewportCompleteRawSelect,
  LiveQueryViewportWhere,
} from "effect-view-server/react/viewport-base-row";
import type { ReactElement, ReactNode } from "react";
import type { LiveQueryResult } from "effect-view-server/config/query";

import {
  BrunoTableBigIntColumn,
  BrunoTableBooleanColumn,
  BrunoTableClient,
  BrunoTableComputedColumn,
  BrunoTableQuickFilter,
  BrunoTableActiveFilterCount,
  BrunoTableActiveSortCount,
  BrunoTableAggregateAlgebra,
  BrunoTableFilterControl,
  BrunoTableLoadedRowCount,
  BrunoTableResultRowCount,
  BrunoTableNumberColumn,
  BrunoTableSelectColumn,
  BrunoTableServer,
  BrunoTableTextColumn,
  BrunoTableToolbar,
} from "./index";
import * as BrunoTablePublic from "./index";

import type {
  BrunoTableAggregateAlgebra as BrunoTableAggregateAlgebraType,
  BrunoTableAggregateResults,
  BrunoTableClientProps,
  BrunoTableClientSource,
  BrunoTableCommonProps,
  BrunoTableColumnField,
  BrunoTableColumnId,
  BrunoTableColumnIdOf,
  BrunoTableColumns,
  BrunoTableColumnValue,
  BrunoTableDecodeResult,
  BrunoTableEditableColumnId,
  BrunoTableEditRowPatch,
  BrunoTableEditRowProjector,
  BrunoTableEditRowProjectorInput,
  BrunoTableEditingCapability,
  BrunoTableFilterableColumnId,
  BrunoTableFilterExpression,
  BrunoTableFilterExpressions,
  BrunoTableQuickFilterField,
  BrunoTableQuickFilterFields,
  BrunoTableGroupKeyCellParams,
  BrunoTableGroupKeyPresence,
  BrunoTableGroupRowsColumnOptions,
  BrunoTablePersistedState,
  BrunoTableSaveCellChange,
  BrunoTableSaveChangeSet,
  BrunoTableServerProps,
  BrunoTableSortableColumnId,
  BrunoTableSortBy,
  BrunoTableValueType,
} from "./index";

type ExactMoney = Readonly<{ readonly minorUnits: bigint }>;

const exactMoneyAlgebra = BrunoTableAggregateAlgebra<ExactMoney>({
  add: (left, right) => ({ minorUnits: left.minorUnits + right.minorUnits }),
  divideByCount: (total, count) => ({ minorUnits: total.minorUnits / count }),
});
expectTypeOf(exactMoneyAlgebra).toMatchTypeOf<BrunoTableAggregateAlgebraType<ExactMoney>>();

const exactMoneyValueType = {
  codecId: "example/exact-money",
  codecVersion: 1,
  filterFamily: "numeric",
  editorFamily: "text",
  cellAlign: "end",
  editorLayout: "inline",
  defaultWidth: 120,
  aggregateResults: { countDistinct: "bigint", sum: "self", avg: "self" },
  aggregateAlgebra: exactMoneyAlgebra,
  decodeRuntime: (input: unknown) =>
    typeof input === "object" && input !== null && "minorUnits" in input
      ? { _tag: "Success" as const, value: input as ExactMoney }
      : { _tag: "Failure" as const, message: "Expected exact money." },
  equivalent: (left: ExactMoney, right: ExactMoney) => left.minorUnits === right.minorUnits,
  compare: (left: ExactMoney, right: ExactMoney) =>
    left.minorUnits === right.minorUnits ? 0 : left.minorUnits < right.minorUnits ? -1 : 1,
  formatCanonicalText: (value: ExactMoney) => value.minorUnits.toString(),
  parseCanonicalText: (text: string) => ({
    _tag: "Success" as const,
    value: { minorUnits: BigInt(text) },
  }),
  formatDisplay: (value: ExactMoney) => value.minorUnits.toString(),
  encodePersisted: (value: ExactMoney) => value.minorUnits.toString(),
  decodePersisted: (input: unknown) =>
    typeof input === "string"
      ? { _tag: "Success" as const, value: { minorUnits: BigInt(input) } }
      : { _tag: "Failure" as const, message: "Expected persisted exact money." },
} satisfies BrunoTableValueType<
  ExactMoney,
  "numeric",
  "text",
  { readonly countDistinct: "bigint"; readonly sum: "self"; readonly avg: "self" }
>;
void exactMoneyValueType;

const sumWithoutAlgebra = {
  ...exactMoneyValueType,
  aggregateResults: { sum: "self" as const },
  aggregateAlgebra: undefined,
};
// @ts-expect-error Advertising sum requires an exact add operation.
const invalidSumWithoutAlgebra: BrunoTableValueType<
  ExactMoney,
  "numeric",
  "text",
  { readonly sum: "self" }
> = sumWithoutAlgebra;
void invalidSumWithoutAlgebra;

const invalidAggregateResultPair = {
  // @ts-expect-error countDistinct always produces bigint.
  countDistinct: "self",
} satisfies BrunoTableAggregateResults;
void invalidAggregateResultPair;

const exactMoneyValueTypeBase = {
  codecId: "example/single-generic-exact-money",
  codecVersion: 1,
  filterFamily: "numeric" as const,
  editorFamily: "text" as const,
  cellAlign: "end" as const,
  editorLayout: "inline" as const,
  defaultWidth: 120,
  decodeRuntime: exactMoneyValueType.decodeRuntime,
  equivalent: exactMoneyValueType.equivalent,
  compare: exactMoneyValueType.compare,
  formatCanonicalText: exactMoneyValueType.formatCanonicalText,
  parseCanonicalText: exactMoneyValueType.parseCanonicalText,
  formatDisplay: exactMoneyValueType.formatDisplay,
  encodePersisted: exactMoneyValueType.encodePersisted,
  decodePersisted: exactMoneyValueType.decodePersisted,
};

const exactMoneyNonArithmeticAggregates = {
  ...exactMoneyValueTypeBase,
  aggregateResults: { countDistinct: "bigint", min: "self", max: "self" },
} satisfies BrunoTableValueType<ExactMoney>;
void exactMoneyNonArithmeticAggregates;

const exactMoneySingleGenericArithmetic = {
  ...exactMoneyValueTypeBase,
  aggregateResults: { sum: "self", avg: "self" },
  aggregateAlgebra: exactMoneyAlgebra,
} satisfies BrunoTableValueType<ExactMoney>;
void exactMoneySingleGenericArithmetic;

const exactMoneySingleGenericSumWithoutAlgebra = {
  ...exactMoneyValueTypeBase,
  aggregateResults: { sum: "self" as const },
};
// @ts-expect-error The single-generic form still requires exact addition for sum.
const invalidSingleGenericSumWithoutAlgebra: BrunoTableValueType<ExactMoney> =
  exactMoneySingleGenericSumWithoutAlgebra;
void invalidSingleGenericSumWithoutAlgebra;

const exactMoneySingleGenericAverageWithoutDivision = {
  ...exactMoneyValueTypeBase,
  aggregateResults: { avg: "self" as const },
  aggregateAlgebra: BrunoTableAggregateAlgebra<ExactMoney>({
    add: (left, right) => ({ minorUnits: left.minorUnits + right.minorUnits }),
  }),
};
// @ts-expect-error The single-generic form requires exact division for avg.
const invalidSingleGenericAverageWithoutDivision: BrunoTableValueType<ExactMoney> =
  exactMoneySingleGenericAverageWithoutDivision;
void invalidSingleGenericAverageWithoutDivision;

type Order = {
  readonly id: string;
  readonly symbol: string;
  readonly price: number;
  readonly quantity: bigint;
  readonly status: "open" | "closed";
  readonly revision: bigint;
  readonly hiddenLabel: string;
};

type OptionalGroupRow = Readonly<{ readonly optional?: string | null }>;
expectTypeOf<BrunoTableGroupKeyPresence<string | null | undefined>>().toEqualTypeOf<
  | Readonly<{ readonly _tag: "Missing" }>
  | Readonly<{
      readonly _tag: "Present";
      readonly value: string | null | undefined;
    }>
>();
const optionalGroupColumns = [
  {
    columnId: "COL_ID_OPTIONAL",
    field: "optional",
    headerName: "Optional",
    valueType: "text",
    groupBy: true,
  },
] as const satisfies BrunoTableColumns<OptionalGroupRow>;
const exactRowsPresenceCallbacks = {
  valueFormatter: ({ groupKeys }) => {
    const key = groupKeys[0];
    if (key?._tag === "Present") {
      expectTypeOf(key.columnId).toEqualTypeOf<"COL_ID_OPTIONAL">();
      expectTypeOf(key.field).toEqualTypeOf<"optional">();
      expectTypeOf(key.value).toEqualTypeOf<string | null | undefined>();
      return String(key.value);
    }
    if (key?._tag === "Missing") {
      // @ts-expect-error Missing evidence owns no fabricated value.
      void key.value;
    }
    return "Missing";
  },
} satisfies BrunoTableGroupRowsColumnOptions<OptionalGroupRow, typeof optionalGroupColumns>;
void exactRowsPresenceCallbacks;

type AggregateMatrixRow = Readonly<{
  text: string;
  boolean: boolean;
  number: number;
  bigint: bigint;
}>;

const builtInAggregateMatrix = [
  {
    columnId: "COL_ID_TEXT_DISTINCT",
    field: "text",
    headerName: "Text distinct",
    valueType: "text",
    aggFunc: "countDistinct",
  },
  {
    columnId: "COL_ID_TEXT_MIN",
    field: "text",
    headerName: "Text min",
    valueType: "text",
    aggFunc: "min",
  },
  {
    columnId: "COL_ID_TEXT_MAX",
    field: "text",
    headerName: "Text max",
    valueType: "text",
    aggFunc: "max",
  },
  {
    columnId: "COL_ID_BOOLEAN_DISTINCT",
    field: "boolean",
    headerName: "Boolean distinct",
    valueType: "boolean",
    aggFunc: "countDistinct",
  },
  {
    columnId: "COL_ID_BOOLEAN_MIN",
    field: "boolean",
    headerName: "Boolean min",
    valueType: "boolean",
    aggFunc: "min",
  },
  {
    columnId: "COL_ID_BOOLEAN_MAX",
    field: "boolean",
    headerName: "Boolean max",
    valueType: "boolean",
    aggFunc: "max",
  },
  {
    columnId: "COL_ID_NUMBER_DISTINCT",
    field: "number",
    headerName: "Number distinct",
    valueType: "number",
    aggFunc: "countDistinct",
  },
  {
    columnId: "COL_ID_NUMBER_MIN",
    field: "number",
    headerName: "Number min",
    valueType: "number",
    aggFunc: "min",
  },
  {
    columnId: "COL_ID_NUMBER_MAX",
    field: "number",
    headerName: "Number max",
    valueType: "number",
    aggFunc: "max",
  },
  {
    columnId: "COL_ID_BIGINT_DISTINCT",
    field: "bigint",
    headerName: "Bigint distinct",
    valueType: "bigint",
    aggFunc: "countDistinct",
  },
  {
    columnId: "COL_ID_BIGINT_SUM",
    field: "bigint",
    headerName: "Bigint sum",
    valueType: "bigint",
    aggFunc: "sum",
  },
  {
    columnId: "COL_ID_BIGINT_MIN",
    field: "bigint",
    headerName: "Bigint min",
    valueType: "bigint",
    aggFunc: "min",
  },
  {
    columnId: "COL_ID_BIGINT_MAX",
    field: "bigint",
    headerName: "Bigint max",
    valueType: "bigint",
    aggFunc: "max",
  },
] as const satisfies BrunoTableColumns<AggregateMatrixRow>;
void builtInAggregateMatrix;

const forbiddenBuiltInAggregates = [
  // @ts-expect-error Number sum is Server-owned BigDecimal semantics, not a Client number result.
  {
    columnId: "COL_ID_NUMBER_SUM",
    field: "number",
    headerName: "Number sum",
    valueType: "number",
    aggFunc: "sum",
  },
  // @ts-expect-error Number average is Server-owned BigDecimal semantics.
  {
    columnId: "COL_ID_NUMBER_AVG",
    field: "number",
    headerName: "Number average",
    valueType: "number",
    aggFunc: "avg",
  },
  // @ts-expect-error Bigint average is Server-owned BigDecimal semantics.
  {
    columnId: "COL_ID_BIGINT_AVG",
    field: "bigint",
    headerName: "Bigint average",
    valueType: "bigint",
    aggFunc: "avg",
  },
] as const satisfies BrunoTableColumns<AggregateMatrixRow>;
void forbiddenBuiltInAggregates;

const columns = [
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
    isEditable: true,
  },
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: "number",
    isEditable: ({ row, value }) => row.status === "open" && value > 0,
    valueFormatter: ({ value }) => value.toFixed(2),
  },
  BrunoTableComputedColumn({
    columnId: "COL_ID_DOUBLE_QUANTITY",
    fields: ["quantity"],
    headerName: "Double quantity",
    valueType: "bigint",
    valueGetter: ({ row }) => row.quantity * 2n,
  }),
] as const satisfies BrunoTableColumns<Order>;

type Columns = typeof columns;

const rowAwareEditableColumns = [
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
    isEditable: true,
    valueFormatter: ({ row, value }) => `${row.hiddenLabel}:${value}`,
  },
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: "number",
    isEditable: true,
    cellClassName: ({ row }) => (row.status === "open" ? "open" : undefined),
  },
  {
    columnId: "COL_ID_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
    valueType: "bigint",
    isEditable: true,
    cellRenderer: ({ row, value }) => `${row.symbol}:${value}`,
  },
  {
    columnId: "COL_ID_REVISION",
    field: "revision",
    headerName: "Revision",
    valueType: "bigint",
    valueFormatter: ({ row, value }) => `${row.id}:${value}`,
  },
] as const satisfies BrunoTableColumns<Order>;

const serverWitnessConfig = defineViewServerConfig({
  topics: {
    orders: {
      schema: Schema.Struct({
        id: ViewServerId,
        symbol: Schema.String,
        price: Schema.Number,
        quantity: Schema.BigInt,
        status: Schema.Literals(["open", "closed"]),
        revision: Schema.BigInt,
        hiddenLabel: Schema.String,
      }),
    },
    positions: {
      schema: Schema.Struct({
        id: ViewServerId,
        symbol: Schema.String,
        price: Schema.Number,
        quantity: Schema.BigInt,
        status: Schema.Literals(["open", "closed"]),
        revision: Schema.BigInt,
        hiddenLabel: Schema.String,
        account: Schema.String,
      }),
    },
  },
});
const serverWitnessReact = createViewServerReact(serverWitnessConfig);
const orderViewportSource = serverWitnessReact.useLiveQueryViewport("orders");
const positionViewportSource = serverWitnessReact.useLiveQueryViewport("positions");
const leasedTypeSourceAdapter = SourceAdapter.make({
  identity: { name: "bruno-table-route-type-tests" },
  failure: Schema.Never,
  materialized: undefined,
  leased: {
    metrics: Schema.Struct({ observed: Schema.BigInt }),
    rejectionLocation: Schema.Struct({ offset: Schema.BigInt }),
    definitionOptions: SourceAdapter.definitionOptions<undefined>(),
  },
});
const leasedServerWitnessConfig = defineViewServerConfig({
  topics: {
    orders: {
      schema: serverWitnessConfig.topics.orders.schema,
      source: leasedTypeSourceAdapter.leasedSource(["status", "revision"], undefined),
    },
  },
});
const leasedServerWitnessReact = createViewServerReact(leasedServerWitnessConfig);
const leasedOrderViewportSource = leasedServerWitnessReact.useLiveQueryViewport("orders");
declare const unsafeAnyViewport: any;
declare const unsafeUnknownViewport: unknown;
declare const unsafeUnwitnessedViewport: Readonly<{ readonly destroy: () => void }>;
declare const unsafeBroadViewport: Readonly<Record<string, (_row: Order) => Order>>;

describe("BrunoTableServer viewport row witness", () => {
  it("derives the exact base row and rejects mismatched or erased sources", () => {
    expectTypeOf<
      LiveQueryViewportBaseRow<typeof orderViewportSource.viewport>
    >().toEqualTypeOf<Order>();
    expectTypeOf(orderViewportSource.completeRawSelect).toEqualTypeOf<
      LiveQueryViewportCompleteRawSelect<typeof orderViewportSource.viewport>
    >();

    const matchingProps = {
      tableId: "TABLE_ID_WITNESSED_SERVER",
      columns,
      initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
      viewportSource: orderViewportSource,
      onPersistChange: (state) =>
        expectTypeOf(state).toEqualTypeOf<BrunoTablePersistedState<Order, Columns, true>>(),
    } as const satisfies BrunoTableServerProps<Order, Columns, typeof orderViewportSource.viewport>;
    void BrunoTableServer(matchingProps);

    const mismatchedProps: BrunoTableServerProps<
      Order,
      Columns,
      typeof positionViewportSource.viewport
    > = {
      ...matchingProps,
      // @ts-expect-error the Props row must exactly match the viewport base row for extensions.
      viewportSource: positionViewportSource,
    };
    void mismatchedProps;

    const anySource = { ...orderViewportSource, viewport: unsafeAnyViewport };
    // @ts-expect-error any erases the authoritative viewport base-row witness.
    void BrunoTableServer({ ...matchingProps, viewportSource: anySource });

    const unknownSource = { ...orderViewportSource, viewport: unsafeUnknownViewport };
    // @ts-expect-error unknown erases the authoritative viewport base-row witness.
    void BrunoTableServer({ ...matchingProps, viewportSource: unknownSource });

    const unwitnessedSource = { ...orderViewportSource, viewport: unsafeUnwitnessedViewport };
    // @ts-expect-error an unwitnessed viewport cannot establish the Server base row.
    void BrunoTableServer({ ...matchingProps, viewportSource: unwitnessedSource });

    const broadSource = { ...orderViewportSource, viewport: unsafeBroadViewport };
    // @ts-expect-error broad dictionaries cannot impersonate the source-owned viewport witness.
    void BrunoTableServer({ ...matchingProps, viewportSource: broadSource });

    type RawOnlyViewport = Omit<typeof orderViewportSource.viewport, "semanticKey"> & {
      readonly semanticKey: (query: {
        readonly select: typeof orderViewportSource.completeRawSelect;
        readonly where: LiveQueryViewportWhere<typeof orderViewportSource.viewport>;
        readonly orderBy: readonly [];
      }) => unknown;
    };
    const rawOnlySource = {
      ...orderViewportSource,
      viewport: null as unknown as RawOnlyViewport,
    };
    // @ts-expect-error Server grouping requires the source-owned grouped-query authority.
    void BrunoTableServer({ ...matchingProps, viewportSource: rawOnlySource });

    type RawQuery = {
      readonly select: typeof orderViewportSource.completeRawSelect;
      readonly where: LiveQueryViewportWhere<typeof orderViewportSource.viewport>;
      readonly orderBy: readonly [];
    };
    type RawOnlyReplaceViewport = Omit<typeof orderViewportSource.viewport, "replace"> & {
      readonly replace: (
        request: Omit<Parameters<typeof orderViewportSource.viewport.replace>[0], "query"> & {
          readonly query: RawQuery;
        },
      ) => ReturnType<typeof orderViewportSource.viewport.replace>;
    };
    const rawOnlyReplaceSource = {
      ...orderViewportSource,
      viewport: null as unknown as RawOnlyReplaceViewport,
    };
    // @ts-expect-error Server grouping requires source-owned grouped replacement authority.
    void BrunoTableServer({ ...matchingProps, viewportSource: rawOnlyReplaceSource });

    const { completeRawSelect: omittedCompleteRawSelect, ...sourceWithoutCompleteRawSelect } =
      orderViewportSource;
    void omittedCompleteRawSelect;
    // @ts-expect-error Server Sources must carry their source-owned complete raw projection.
    void BrunoTableServer({ ...matchingProps, viewportSource: sourceWithoutCompleteRawSelect });

    const { useWholeResult: omittedUseWholeResult, ...sourceWithoutWholeResult } =
      orderViewportSource;
    void omittedUseWholeResult;
    // @ts-expect-error Server Sources must carry their source-owned whole-result facet hook.
    void BrunoTableServer({ ...matchingProps, viewportSource: sourceWithoutWholeResult });

    void orderViewportSource.viewport.replace({
      window: { firstRow: 0, lastRow: 9 },
      query: {
        select: orderViewportSource.completeRawSelect,
        where: [],
        orderBy: [{ field: "symbol", direction: "asc" }],
      },
      sink: {
        setRowCount: () => undefined,
        setRowData: (rows) => {
          // Native TypeScript 7 retains the mapped projection identity; check both assignment directions.
          expectTypeOf(rows[0]).toExtend<Order | undefined>();
          expectTypeOf<Order | undefined>().toExtend<(typeof rows)[number] | undefined>();
        },
      },
    });

    void orderViewportSource.viewport.replace({
      window: { firstRow: 0, lastRow: 9 },
      query: {
        select: ["symbol"],
        where: [],
        orderBy: [{ field: "symbol", direction: "asc" }],
      },
      sink: { setRowCount: () => undefined, setRowData: () => undefined },
    });
    void orderViewportSource.viewport.replace({
      window: { firstRow: 0, lastRow: 9 },
      query: {
        groupBy: ["status"],
        aggregates: { rowCount: { aggFunc: "count" } },
        where: [],
        orderBy: [{ aggregate: "rowCount", direction: "desc" }],
      },
      sink: { setRowCount: () => undefined, setRowData: () => undefined },
    });
    expectTypeOf<
      LiveQueryViewportBaseRow<typeof orderViewportSource.viewport>
    >().toEqualTypeOf<Order>();
  });
});

const persistedPreferences = {
  version: 1,
  tableId: "TABLE_ID_ORDERS",
  filters: [
    {
      columnId: "COL_ID_PRICE",
      type: "greaterThan",
      codecId: "@bruno/table/number",
      codecVersion: 1,
      filter: { $brunoTableValue: "number", version: 1, value: "10" },
    },
  ],
  orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  groupBy: [],
  groupOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" }],
  columnOrder: ["COL_ID_SYMBOL", "COL_ID_PRICE", "COL_ID_DOUBLE_QUANTITY"],
  columnVisibility: { COL_ID_SYMBOL: true },
  columnWidths: { COL_ID_PRICE: 144 },
  columnPinning: { start: ["COL_ID_SYMBOL"], end: [] },
} as const satisfies BrunoTablePersistedState<Order, Columns>;

const invalidPersistedSelectionWidth = {
  ...persistedPreferences,
  columnWidths: {
    // @ts-expect-error The private Row Selection width is implementation-owned.
    COL_ID_BRUNO_TABLE_ROW_SELECTION: 40,
  },
} satisfies BrunoTablePersistedState<Order, Columns>;
void invalidPersistedSelectionWidth;

const invalidPersistedSelectionGroupOrder = {
  ...persistedPreferences,
  groupOrderBy: [
    // @ts-expect-error The private Row Selection identity is never grouped-sortable.
    { columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION", direction: "asc" },
  ],
} satisfies BrunoTablePersistedState<Order, Columns>;
void invalidPersistedSelectionGroupOrder;

expectTypeOf(persistedPreferences.filters[0]!.columnId).toEqualTypeOf<"COL_ID_PRICE">();

const persistedTextSearch = {
  ...persistedPreferences,
  filters: [
    {
      columnId: "COL_ID_SYMBOL",
      type: "contains",
      codecId: "@bruno/table/text",
      codecVersion: 1,
      filter: "AAPL",
    },
  ],
} as const satisfies BrunoTablePersistedState<Order, Columns>;
void persistedTextSearch;

const invalidPersistedTextSearch = {
  ...persistedTextSearch,
  filters: [
    {
      columnId: "COL_ID_SYMBOL",
      type: "contains",
      codecId: "@bruno/table/text",
      codecVersion: 1,
      // @ts-expect-error Persisted Text search operands are raw strings, not codec payloads.
      filter: { value: "AAPL" },
    },
  ],
} as const satisfies BrunoTablePersistedState<Order, Columns>;
void invalidPersistedTextSearch;

const invalidPersistedNumericOperator = {
  ...persistedPreferences,
  filters: [
    // @ts-expect-error Numeric persisted filters reject Text operators.
    {
      columnId: "COL_ID_PRICE",
      type: "contains",
      codecId: "@bruno/table/number",
      codecVersion: 1,
      filter: { value: "10" },
    },
  ],
} satisfies BrunoTablePersistedState<Order, Columns>;
void invalidPersistedNumericOperator;

const invalidPersistedInOperand = {
  ...persistedPreferences,
  filters: [
    {
      columnId: "COL_ID_PRICE",
      type: "in",
      codecId: "@bruno/table/number",
      codecVersion: 1,
      // @ts-expect-error Persisted in operands are a non-empty JSON tuple.
      filter: { value: "10" },
    },
  ],
} satisfies BrunoTablePersistedState<Order, Columns>;
void invalidPersistedInOperand;

const invalidPersistedCompound = {
  ...persistedPreferences,
  filters: [
    {
      type: "AND",
      // @ts-expect-error Persisted compound leaves retain one Column Identity.
      conditions: [
        {
          columnId: "COL_ID_PRICE",
          type: "equals",
          codecId: "@bruno/table/number",
          codecVersion: 1,
          filter: { value: "10" },
        },
        {
          columnId: "COL_ID_SYMBOL",
          type: "equals",
          codecId: "@bruno/table/text",
          codecVersion: 1,
          filter: { value: "Ada" },
        },
      ],
    },
  ],
} satisfies BrunoTablePersistedState<Order, Columns>;
void invalidPersistedCompound;

const invalidPersistedSetCapability = {
  ...persistedPreferences,
  filters: [
    // @ts-expect-error Match None requires an enabled Set Filter capability.
    { columnId: "COL_ID_PRICE", type: "matchNone" },
  ],
} satisfies BrunoTablePersistedState<Order, Columns>;
void invalidPersistedSetCapability;

const invalidPersistedSensitivity = {
  ...persistedPreferences,
  filters: [
    {
      columnId: "COL_ID_PRICE",
      type: "equals",
      codecId: "@bruno/table/number",
      codecVersion: 1,
      filter: { value: "10" },
      // @ts-expect-error Numeric persisted filters reject Text sensitivity flags.
      caseSensitive: true,
    },
  ],
} satisfies BrunoTablePersistedState<Order, Columns>;
void invalidPersistedSensitivity;

const invalidPersistedColumn = {
  ...persistedPreferences,
  // @ts-expect-error Persisted layout identities autocomplete from the exact columns tuple.
  columnOrder: ["COL_ID_UNKNOWN"],
} satisfies BrunoTablePersistedState<Order, Columns>;
void invalidPersistedColumn;

const persistedClientProps = {
  tableId: "TABLE_ID_PERSISTED_PROPS",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  clientSource: { rows: [], totalRows: 0, version: 1, status: "ready" as const },
  initialPersistedState: persistedPreferences,
  onPersistChange: (state) =>
    expectTypeOf(state).toEqualTypeOf<BrunoTablePersistedState<Order, Columns, true>>(),
} satisfies BrunoTableClientProps<Order, Columns>;
void persistedClientProps;

const nonGroupingPersistedPreferences = {
  ...persistedPreferences,
  groupOrderBy: [],
} as const satisfies BrunoTablePersistedState<Order, Columns, false>;
void nonGroupingPersistedPreferences;
const invalidNonGroupingPersistedGroupBy = {
  ...nonGroupingPersistedPreferences,
  // @ts-expect-error Non-grouping persistence rejects active Group By intent.
  groupBy: ["COL_ID_SYMBOL"],
} satisfies BrunoTablePersistedState<Order, Columns, false>;
void invalidNonGroupingPersistedGroupBy;
const invalidNonGroupingPersistedRowsWidth = {
  ...nonGroupingPersistedPreferences,
  columnWidths: {
    // @ts-expect-error Non-grouping persistence rejects the dormant Rows width.
    COL_ID_BRUNO_TABLE_ROWS: 144,
  },
} satisfies BrunoTablePersistedState<Order, Columns, false>;
void invalidNonGroupingPersistedRowsWidth;
const invalidGroupingPersistedPreferences = {
  ...persistedPreferences,
  // @ts-expect-error Grouping-capable Client persistence always retains one grouped sort.
  groupOrderBy: [],
} as const satisfies BrunoTablePersistedState<Order, Columns, true>;
void invalidGroupingPersistedPreferences;

const directViewServerResult = null as unknown as LiveQueryResult<Order>;
const directClientSource: BrunoTableClientSource<Order> = directViewServerResult;
const directViewServerClient = BrunoTableClient({
  tableId: "view-server-orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row) => row.id,
  clientSource: directViewServerResult,
});
void directClientSource;
void directViewServerClient;

const rawGroupedColumns = [
  BrunoTableTextColumn({
    columnId: "COL_ID_GROUP_SYMBOL",
    field: "symbol",
    headerName: "Symbol group",
    groupBy: true,
    groupKeyValueFormatter: ({ columnId, field, value }) => {
      expectTypeOf(columnId).toEqualTypeOf<"COL_ID_GROUP_SYMBOL">();
      expectTypeOf(field).toEqualTypeOf<"symbol">();
      expectTypeOf(value).toEqualTypeOf<string>();
      return value;
    },
  }),
  BrunoTableNumberColumn({
    columnId: "COL_ID_MAX_PRICE",
    field: "price",
    headerName: "Maximum price",
    aggFunc: "max",
    aggregateValueFormatter: ({ columnId, field, value }) => {
      expectTypeOf(columnId).toEqualTypeOf<"COL_ID_MAX_PRICE">();
      expectTypeOf(field).toEqualTypeOf<"price">();
      expectTypeOf(value).toEqualTypeOf<number>();
      return value.toFixed(2);
    },
  }),
  {
    columnId: "COL_ID_RAW_STATUS",
    field: "status",
    headerName: "Raw status",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Order>;
void rawGroupedColumns;

type HostileSymbolGroupParams = BrunoTableGroupKeyCellParams<
  string,
  "COL_ID_HOSTILE_SYMBOL",
  "symbol"
> & {
  readonly groupKeys: readonly [{ readonly columnId: "COL_ID_GROUP_SYMBOL" }];
};
const hostileSymbolGroupFormatter = (_parameters: HostileSymbolGroupParams) => "hostile";
const hostileHelperGroupedOptions = {
  columnId: "COL_ID_HOSTILE_SYMBOL",
  field: "symbol",
  headerName: "Hostile symbol",
  groupBy: true,
  groupKeyValueFormatter: hostileSymbolGroupFormatter,
} as const;
// @ts-expect-error Column-level helper callbacks cannot require sibling Group Key evidence.
const hostileHelperGroupedColumn = BrunoTableTextColumn(hostileHelperGroupedOptions);
void hostileHelperGroupedColumn;

const spreadHelperGroupedSource = [
  BrunoTableTextColumn({
    columnId: "COL_ID_GROUP_SYMBOL",
    field: "symbol",
    headerName: "Group symbol",
    groupBy: true,
    groupKeyValueFormatter: ({ value }) => value,
    valueFormatter: ({ row, value }) => `${row.hiddenLabel}:${value}`,
  }),
] satisfies BrunoTableColumns<Order>;
const validSpreadHelperGroupedColumns = [
  { ...spreadHelperGroupedSource[0]! },
] satisfies BrunoTableColumns<Order>;
void validSpreadHelperGroupedColumns;
type IncompatibleHelperRow = Readonly<{ readonly unrelated: string }>;
const crossRowHelperColumns = [spreadHelperGroupedSource[0]!];
// @ts-expect-error A helper column remains tied to the row type inferred by that helper call.
const invalidCrossRowHelperColumns: BrunoTableColumns<IncompatibleHelperRow> =
  crossRowHelperColumns;
void invalidCrossRowHelperColumns;
type IncompatibleHelperValueRow = Readonly<{ readonly symbol: number }>;
// @ts-expect-error A same-name field with a different value domain is not helper-compatible.
const invalidCrossValueHelperColumns: BrunoTableColumns<IncompatibleHelperValueRow> =
  crossRowHelperColumns;
void invalidCrossValueHelperColumns;
type IncompatibleHelperSiblingRow = Readonly<{ readonly symbol: string }>;
// @ts-expect-error Helper raw callbacks remain tied to sibling evidence from the inferred row.
const invalidCrossSiblingHelperColumns: BrunoTableColumns<IncompatibleHelperSiblingRow> =
  crossRowHelperColumns;
void invalidCrossSiblingHelperColumns;
type IncompatibleHelperWidenedRow = Omit<Order, "symbol"> &
  Readonly<{ readonly symbol: string | number }>;
// @ts-expect-error Helper provenance is invariant in the complete inferred row value domain.
const invalidWidenedHelperColumns: BrunoTableColumns<IncompatibleHelperWidenedRow> =
  crossRowHelperColumns;
void invalidWidenedHelperColumns;
const computedHelperForOrder = BrunoTableTextColumn({
  columnId: "COL_ID_COMPUTED_HELPER_SYMBOL",
  fields: ["symbol"] as const,
  headerName: "Computed symbol",
  valueGetter: ({ row }: { readonly row: Pick<Order, "symbol"> }) => row.symbol,
});
const invalidComputedHelperDependencies: BrunoTableColumns<IncompatibleHelperValueRow> = [
  // @ts-expect-error Computed helper dependencies retain their exact source value domains.
  computedHelperForOrder,
];
void invalidComputedHelperDependencies;
const replacedSpreadHelperGroupedColumns = [
  {
    ...spreadHelperGroupedSource[0]!,
    groupKeyValueFormatter: ({
      columnId,
      value,
    }: BrunoTableGroupKeyCellParams<string, "COL_ID_GROUP_SYMBOL", "symbol">) => {
      expectTypeOf(columnId).toEqualTypeOf<"COL_ID_GROUP_SYMBOL">();
      expectTypeOf(value).toEqualTypeOf<string>();
      return value;
    },
  },
] satisfies BrunoTableColumns<Order>;
void replacedSpreadHelperGroupedColumns;

const hostileSpreadHelperGroupedColumns = [
  {
    ...spreadHelperGroupedSource[0]!,
    groupKeyValueFormatter: hostileSymbolGroupFormatter,
  },
];
// TypeScript preserves the helper's column-level provenance through object spread, but cannot
// re-contextualize a separately declared replacement callback against its sibling properties.
const unsupportedHostileSpreadHelperColumns: BrunoTableColumns<Order> =
  hostileSpreadHelperGroupedColumns;
void unsupportedHostileSpreadHelperColumns;

const changedIdentitySpreadHelperGroupedColumns = [
  {
    ...spreadHelperGroupedSource[0]!,
    columnId: "COL_ID_CHANGED_HELPER_SYMBOL",
    groupKeyValueFormatter: ({ value }: { readonly value: string }) => value,
  } as const,
] as const satisfies BrunoTableColumns<Order>;
void changedIdentitySpreadHelperGroupedColumns;

const changedDomainSpreadHelperGroupedColumns = [
  {
    ...spreadHelperGroupedSource[0]!,
    field: "status",
    valueType: "text",
    groupKeyValueFormatter: ({ value }: { readonly value: string }) => value,
  } as const,
] as const satisfies BrunoTableColumns<Order>;
void changedDomainSpreadHelperGroupedColumns;

const unsupportedInlineGroupFormatter = (
  parameters: BrunoTableGroupKeyCellParams<string, "COL_ID_INLINE_GROUP", "symbol">,
) => parameters.value;
const rawInlineGroupedPresentation = [
  {
    columnId: "COL_ID_INLINE_GROUP",
    field: "symbol",
    headerName: "Inline group",
    valueType: "text",
    groupBy: true,
    groupKeyValueFormatter: unsupportedInlineGroupFormatter,
  },
] as const;
// @ts-expect-error Exact grouped callbacks cross a global Column Helper, not a raw inline definition.
const invalidRawInlineGroupedPresentation: BrunoTableColumns<Order> = rawInlineGroupedPresentation;
void invalidRawInlineGroupedPresentation;

const honestRawInlineGroupedPresentation = [
  {
    columnId: "COL_ID_INLINE_BROAD_GROUP",
    field: "symbol",
    headerName: "Inline broad group",
    valueType: "text",
    groupBy: true,
    groupKeyValueFormatter: ({ columnId, value }) => {
      expectTypeOf(columnId).toEqualTypeOf<BrunoTableColumnId>();
      expectTypeOf(value).toEqualTypeOf<string>();
      // @ts-expect-error A raw inline callback cannot claim its sibling Column Identity literal.
      const exactColumnId: "COL_ID_INLINE_BROAD_GROUP" = columnId;
      void exactColumnId;
      return value;
    },
  },
] satisfies BrunoTableColumns<Order>;
void honestRawInlineGroupedPresentation;
const groupRowsColumn = {
  headerName: "Orders",
  width: 112,
  valueFormatter: ({ columnId, value, groupKeys }) => {
    expectTypeOf(columnId).toEqualTypeOf<"COL_ID_BRUNO_TABLE_ROWS">();
    expectTypeOf(value).toEqualTypeOf<bigint>();
    expectTypeOf<(typeof groupKeys)[number]>().toMatchTypeOf<{
      readonly columnId: "COL_ID_GROUP_SYMBOL";
      readonly field: "symbol";
      readonly _tag: "Missing" | "Present";
    }>();
    return value.toString();
  },
} satisfies BrunoTableGroupRowsColumnOptions<Order, typeof rawGroupedColumns>;

const groupedClientProps = {
  tableId: "TABLE_ID_GROUPED_CLIENT",
  columns: rawGroupedColumns,
  initialOrderBy: [{ columnId: "COL_ID_GROUP_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  clientSource: { rows: [], totalRows: 0, version: 1, status: "ready" as const },
  groupRowsColumn,
} satisfies BrunoTableClientProps<Order, typeof rawGroupedColumns>;
void groupedClientProps;

const serverWithGroupingConfiguration = {
  tableId: "TABLE_ID_SERVER_GROUPING",
  columns: rawGroupedColumns,
  initialOrderBy: [{ columnId: "COL_ID_GROUP_SYMBOL", direction: "asc" }],
  viewportSource: orderViewportSource,
  groupRowsColumn,
} as const;
const validServerGroupingConfiguration: BrunoTableServerProps<
  Order,
  typeof rawGroupedColumns,
  typeof orderViewportSource.viewport
> = serverWithGroupingConfiguration;
void validServerGroupingConfiguration;
const clientOnlyNumberArithmetic = exactMoneyValueType as unknown as BrunoTableValueType<
  number,
  "numeric",
  "bigdecimal",
  { readonly sum: "self" }
>;
const spoofedBigDecimalCodec = {
  ...clientOnlyNumberArithmetic,
  codecId: "@bruno/table/effect/bigdecimal" as const,
  aggregateResults: { sum: "self" as const },
};
const spoofedBigDecimalServerAggregateColumns = [
  {
    columnId: "COL_ID_SPOOFED_GROUP",
    field: "symbol",
    headerName: "Group",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_SPOOFED_SUM",
    field: "price",
    headerName: "Spoofed sum",
    valueType: spoofedBigDecimalCodec,
    aggFunc: "sum",
  },
] as const satisfies BrunoTableColumns<Order>;
const rejectedSpoofedBigDecimalServerProps: BrunoTableServerProps<
  Order,
  typeof spoofedBigDecimalServerAggregateColumns,
  typeof orderViewportSource.viewport
> = {
  tableId: "TABLE_ID_SPOOFED_SERVER_ARITHMETIC",
  // @ts-expect-error A public codecId literal is not Effect BigDecimal Server authority.
  columns: spoofedBigDecimalServerAggregateColumns,
  initialOrderBy: [{ columnId: "COL_ID_SPOOFED_GROUP", direction: "asc" }],
  viewportSource: orderViewportSource,
};
void rejectedSpoofedBigDecimalServerProps;
const clientOnlyServerAggregateColumns = [
  {
    columnId: "COL_ID_CLIENT_ONLY_GROUP",
    field: "symbol",
    headerName: "Group",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_CLIENT_ONLY_PRICE_SUM",
    field: "price",
    headerName: "Client-only price sum",
    valueType: clientOnlyNumberArithmetic,
    aggFunc: "sum",
  },
] as const satisfies BrunoTableColumns<Order>;
const invalidClientArithmeticServerProps = {
  tableId: "TABLE_ID_INVALID_SERVER_ARITHMETIC",
  columns: clientOnlyServerAggregateColumns,
  initialOrderBy: [{ columnId: "COL_ID_CLIENT_ONLY_GROUP", direction: "asc" }],
  viewportSource: orderViewportSource,
} as const;
// @ts-expect-error Server arithmetic must use effect-view-server's exact result Value Types.
const rejectedClientArithmeticServerProps: BrunoTableServerProps<
  Order,
  typeof clientOnlyServerAggregateColumns,
  typeof orderViewportSource.viewport
> = invalidClientArithmeticServerProps;
void rejectedClientArithmeticServerProps;
const widenedClientOnlyServerAggregateColumns: readonly (typeof clientOnlyServerAggregateColumns)[number][] =
  clientOnlyServerAggregateColumns;
const widenedClientOnlyServerProps = {
  ...invalidClientArithmeticServerProps,
  columns: widenedClientOnlyServerAggregateColumns,
} as const;
// @ts-expect-error Widening an unsupported arithmetic column must not bypass Server admission.
const rejectedWidenedClientArithmeticServerProps: BrunoTableServerProps<
  Order,
  typeof widenedClientOnlyServerAggregateColumns,
  typeof orderViewportSource.viewport
> = widenedClientOnlyServerProps;
void rejectedWidenedClientArithmeticServerProps;
const groupedPersistedPreferences = {
  version: 1,
  tableId: "TABLE_ID_GROUPED_PREFERENCES",
  filters: [],
  orderBy: [{ columnId: "COL_ID_GROUP_SYMBOL", direction: "asc" }],
  groupBy: ["COL_ID_GROUP_SYMBOL"],
  groupOrderBy: [
    { columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "desc" },
    { columnId: "COL_ID_MAX_PRICE", direction: "asc" },
  ],
  columnOrder: ["COL_ID_GROUP_SYMBOL", "COL_ID_MAX_PRICE"],
  columnVisibility: {},
  columnWidths: { COL_ID_BRUNO_TABLE_ROWS: 144 },
  columnPinning: { start: [], end: [] },
} as const satisfies BrunoTablePersistedState<Order, typeof rawGroupedColumns>;
void groupedPersistedPreferences;
const invalidGroupedPersistedPreferences = {
  ...groupedPersistedPreferences,
  // @ts-expect-error Group By intent rejects columns without groupBy: true.
  groupBy: ["COL_ID_MAX_PRICE"],
} satisfies BrunoTablePersistedState<Order, typeof rawGroupedColumns>;
void invalidGroupedPersistedPreferences;

type OnlySymbolGroupEvidence = readonly [
  {
    readonly columnId: "COL_ID_GROUP_SYMBOL";
    readonly field: "symbol";
    readonly groupBy: true;
  },
];

type UnsafelyNarrowGroupedCallbackParams = BrunoTableGroupKeyCellParams<
  string,
  "COL_ID_GROUP_SYMBOL"
> & { readonly groupKeys: OnlySymbolGroupEvidence };

const unsafelyNarrowGroupedCallback = (_params: UnsafelyNarrowGroupedCallbackParams) => "symbol";

const rawColumnWithUnsafelyNarrowGroupedCallback = [
  {
    columnId: "COL_ID_GROUP_SYMBOL",
    field: "symbol",
    headerName: "Unsafe raw symbol group",
    valueType: "text",
    groupBy: true,
    groupKeyValueFormatter: unsafelyNarrowGroupedCallback,
  },
] as const;

// @ts-expect-error Raw columns cannot require sibling Group Key evidence.
const invalidRawNarrowGroupedCallback: BrunoTableColumns<Order> =
  rawColumnWithUnsafelyNarrowGroupedCallback;
void invalidRawNarrowGroupedCallback;

BrunoTableTextColumn({
  columnId: "COL_ID_UNSAFE_GROUP_SYMBOL",
  // @ts-expect-error Narrow sibling evidence makes the grouped callback overload invalid.
  field: "symbol",
  headerName: "Unsafe symbol group",
  groupBy: true,
  groupKeyValueFormatter: unsafelyNarrowGroupedCallback,
});

const capabilityColumns = [
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
    enableSorting: false,
  },
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: "number",
    enableFilter: false,
  },
] satisfies BrunoTableColumns<Order>;

type CapabilityColumns = typeof capabilityColumns;

void BrunoTableClient({
  tableId: "invalid-unknown-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error Client component preserves exact Column Identity inference.
    { columnId: "COL_ID_UNKNOWN", direction: "asc" },
  ],
  getRowId: (row) => row.id,
  clientSource: directViewServerResult,
});
void BrunoTableClient({
  tableId: "invalid-misspelled-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error Client component rejects misspelled Column Identities.
    { columnId: "COL_ID_SYMBOOL", direction: "asc" },
  ],
  getRowId: (row) => row.id,
  clientSource: directViewServerResult,
});
void BrunoTableClient({
  tableId: "invalid-sort-direction",
  columns,
  initialOrderBy: [
    {
      columnId: "COL_ID_SYMBOL",
      // @ts-expect-error Client component admits only asc and desc directions.
      direction: "ascending",
    },
  ],
  getRowId: (row) => row.id,
  clientSource: directViewServerResult,
});
void BrunoTableClient({
  tableId: "invalid-computed-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error Computed columns have no automatic Client sort mapping.
    { columnId: "COL_ID_DOUBLE_QUANTITY", direction: "asc" },
  ],
  getRowId: (row) => row.id,
  clientSource: directViewServerResult,
});
void BrunoTableClient({
  tableId: "invalid-nonsortable-sort",
  columns: capabilityColumns,
  initialOrderBy: [
    // @ts-expect-error Client component excludes explicitly nonsortable identities.
    { columnId: "COL_ID_SYMBOL", direction: "asc" },
  ],
  getRowId: (row) => row.id,
  clientSource: directViewServerResult,
});

const sortingTypeTestViewportSource = orderViewportSource;

const invalidServerUnknownSort = {
  tableId: "invalid-server-unknown-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error Server props preserve exact Column Identity inference.
    { columnId: "COL_ID_UNKNOWN", direction: "asc" },
  ],
  viewportSource: sortingTypeTestViewportSource,
} satisfies BrunoTableServerProps<Order, Columns, typeof orderViewportSource.viewport>;
void invalidServerUnknownSort;

const invalidServerMisspelledSort = {
  tableId: "invalid-server-misspelled-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error Server props reject misspelled Column Identities.
    { columnId: "COL_ID_SYMBOOL", direction: "asc" },
  ],
  viewportSource: sortingTypeTestViewportSource,
} satisfies BrunoTableServerProps<Order, Columns, typeof orderViewportSource.viewport>;
void invalidServerMisspelledSort;

const invalidServerComputedSort = {
  tableId: "invalid-server-computed-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error Computed columns have no automatic Server sort mapping.
    { columnId: "COL_ID_DOUBLE_QUANTITY", direction: "asc" },
  ],
  viewportSource: sortingTypeTestViewportSource,
} satisfies BrunoTableServerProps<Order, Columns, typeof orderViewportSource.viewport>;
void invalidServerComputedSort;

const invalidServerNonsortableSort = {
  tableId: "invalid-server-nonsortable-sort",
  columns: capabilityColumns,
  initialOrderBy: [
    // @ts-expect-error Server props exclude explicitly nonsortable identities.
    { columnId: "COL_ID_SYMBOL", direction: "asc" },
  ],
  viewportSource: sortingTypeTestViewportSource,
} satisfies BrunoTableServerProps<Order, CapabilityColumns, typeof orderViewportSource.viewport>;
void invalidServerNonsortableSort;

const noSortingColumns = [
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
    enableSorting: false,
  },
] satisfies BrunoTableColumns<Order>;

type NoSortingColumns = typeof noSortingColumns;

const validColumnId: BrunoTableColumnId = "COL_ID_PRICE";
void validColumnId;

const validUnicodeColumnId: BrunoTableColumnId = "COL_ID_AÉTAT";
void validUnicodeColumnId;

expectTypeOf<BrunoTableColumnId<"COL_ID_A B">>().toEqualTypeOf<never>();
expectTypeOf<BrunoTableColumnId<"COL_ID_A\tB">>().toEqualTypeOf<never>();
expectTypeOf<BrunoTableColumnId<"COL_ID_A\u3000B">>().toEqualTypeOf<never>();
expectTypeOf<BrunoTableColumnId<"COL_ID_BRUNO_TABLE_ROWS">>().toEqualTypeOf<never>();
expectTypeOf<BrunoTableColumnId<"COL_ID_BRUNO_TABLE_ROW_SELECTION">>().toEqualTypeOf<never>();

const rawWhitespaceIdentityColumns = [
  {
    columnId: "COL_ID_UNIT PRICE",
    field: "price",
    headerName: "Unit price",
    valueType: "number",
  },
] satisfies BrunoTableColumns<Order>;
void BrunoTableClient({
  tableId: "invalid-raw-whitespace-identity",
  // @ts-expect-error Raw Column Identity literals are validated after tuple inference.
  columns: rawWhitespaceIdentityColumns,
  initialOrderBy: [{ columnId: "COL_ID_UNIT PRICE", direction: "asc" }],
  getRowId: (row) => row.id,
  clientSource: directViewServerResult,
});

const invalidWhitespaceHelperOptions = {
  columnId: "COL_ID_UNIT PRICE",
  field: "price",
  headerName: "Unit price",
} as const;
const invalidWhitespaceHelperColumn = [
  // @ts-expect-error Column Helper inputs reject whitespace in literal identities.
  BrunoTableNumberColumn(invalidWhitespaceHelperOptions),
] satisfies BrunoTableColumns<Order>;
void invalidWhitespaceHelperColumn;

const invalidWhitespaceComputedOptions = {
  columnId: "COL_ID_UNIT\u3000PRICE",
  fields: ["price"],
  headerName: "Unit price",
  valueType: "number",
  valueGetter: ({ row }: { readonly row: Pick<Order, "price"> }) => row.price,
} as const;
const invalidWhitespaceComputedColumn = [
  // @ts-expect-error Computed Column inputs reject Unicode whitespace in literal identities.
  BrunoTableComputedColumn(invalidWhitespaceComputedOptions),
] satisfies BrunoTableColumns<Order>;
void invalidWhitespaceComputedColumn;

const rawReservedIdentityColumns = [
  {
    columnId: "COL_ID_BRUNO_TABLE_ROWS",
    field: "price",
    headerName: "Rows",
    valueType: "number",
  },
] as const satisfies BrunoTableColumns<Order>;
void BrunoTableClient({
  tableId: "invalid-raw-reserved-identity",
  // @ts-expect-error Consumers cannot claim the Rows System Column identity.
  columns: rawReservedIdentityColumns,
  initialOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" }],
  getRowId: (row) => row.id,
  clientSource: directViewServerResult,
});

const rawSelectionReservedIdentityColumns = [
  {
    columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION",
    field: "price",
    headerName: "Selection",
    valueType: "number",
  },
] as const satisfies BrunoTableColumns<Order>;
void BrunoTableClient({
  tableId: "invalid-raw-selection-reserved-identity",
  // @ts-expect-error Consumers cannot claim the private Row Selection identity.
  columns: rawSelectionReservedIdentityColumns,
  initialOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION", direction: "asc" }],
  getRowId: (row) => row.id,
  clientSource: directViewServerResult,
});
void BrunoTableClient({
  tableId: "invalid-selection-reserved-initial-order",
  columns,
  // @ts-expect-error The private Row Selection identity is never sortable.
  initialOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION", direction: "asc" }],
  getRowId: (row) => row.id,
  clientSource: directViewServerResult,
});

const invalidReservedHelperOptions = {
  columnId: "COL_ID_BRUNO_TABLE_ROWS",
  field: "price",
  headerName: "Rows",
} as const;
const invalidReservedHelperColumn = [
  // @ts-expect-error Column Helper inputs reject the reserved Rows identity.
  BrunoTableNumberColumn(invalidReservedHelperOptions),
] satisfies BrunoTableColumns<Order>;
void invalidReservedHelperColumn;

const invalidSelectionReservedHelperOptions = {
  columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION",
  field: "price",
  headerName: "Selection",
} as const;
const invalidSelectionReservedHelperColumn = [
  // @ts-expect-error Column Helper inputs reject the private Row Selection identity.
  BrunoTableNumberColumn(invalidSelectionReservedHelperOptions),
] satisfies BrunoTableColumns<Order>;
void invalidSelectionReservedHelperColumn;

// @ts-expect-error A stable column identity must have a non-empty suffix.
const emptyColumnId: BrunoTableColumnId = "COL_ID_";
void emptyColumnId;

// @ts-expect-error The suffix must begin with an ASCII uppercase letter, digit, or underscore.
const invalidUnicodeStartColumnId: BrunoTableColumnId = "COL_ID_ÉTAT";
void invalidUnicodeStartColumnId;

// @ts-expect-error Every character after the prefix must already be uppercase.
const invalidMixedCaseColumnId: BrunoTableColumnId = "COL_ID_Price";
void invalidMixedCaseColumnId;

describe("BrunoTable public types", () => {
  it("infers the strict live Client component surface without exposing a table object", () => {
    expectTypeOf<
      "BrunoTableSelectedRowCount" extends keyof typeof BrunoTablePublic ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "BrunoTableDirtyCellCount" extends keyof typeof BrunoTablePublic ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "BrunoTableValidationCount" extends keyof typeof BrunoTablePublic ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "BrunoTableConflictCount" extends keyof typeof BrunoTablePublic ? true : false
    >().toEqualTypeOf<false>();
    const props = {
      tableId: "orders",
      columns,
      initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
      getRowId: (row: Order) => row.id,
      clientSource: {
        rows: [] as readonly Order[],
        totalRows: 0,
        version: 1,
        status: "ready",
      },
    } satisfies BrunoTableClientProps<Order, Columns>;
    const callableProps: Parameters<typeof BrunoTableClient<Order, Columns>>[0] = props;
    const namedProps: BrunoTableClientProps<Order, Columns> = callableProps;
    const rendered = BrunoTableClient(namedProps);

    expectTypeOf(rendered).toEqualTypeOf<ReactNode>();
    expectTypeOf(callableProps).toMatchTypeOf<BrunoTableClientProps<Order, Columns>>();
    expectTypeOf(BrunoTableToolbar({ children: "Filters" })).toEqualTypeOf<ReactNode>();
    expectTypeOf(BrunoTableQuickFilter).toExtend<() => ReactNode>();
    expectTypeOf(BrunoTableQuickFilter).toEqualTypeOf<() => ReactElement | null>();
    expectTypeOf(BrunoTableResultRowCount({})).toEqualTypeOf<ReactNode>();
    expectTypeOf(BrunoTableLoadedRowCount({})).toEqualTypeOf<ReactNode>();
    expectTypeOf(BrunoTableActiveFilterCount({})).toEqualTypeOf<ReactNode>();
    expectTypeOf(BrunoTableActiveSortCount({})).toEqualTypeOf<ReactNode>();

    void BrunoTableFilterControl<Order, Columns>({
      ownership: "grid",
      children: (commands) => {
        expectTypeOf(commands.clearAll).toEqualTypeOf<() => boolean>();
        expectTypeOf(commands.clear)
          .parameter(0)
          .toEqualTypeOf<BrunoTableFilterableColumnId<Columns>>();
        expectTypeOf(commands.reset)
          .parameter(0)
          .toEqualTypeOf<BrunoTableFilterableColumnId<Columns>>();
        expectTypeOf(commands.reset).returns.toEqualTypeOf<boolean>();
        expectTypeOf(commands.replace)
          .parameter(0)
          .toEqualTypeOf<BrunoTableFilterExpression<Order, Columns>>();
        return null;
      },
    });
    void BrunoTableFilterControl({
      ownership: "external",
      children: "Application-owned filter",
    });

    const validQuickFilterFields = [
      "symbol",
      "status",
      "hiddenLabel",
    ] as const satisfies BrunoTableQuickFilterFields<Order>;
    expectTypeOf(validQuickFilterFields).toEqualTypeOf<
      readonly ["symbol", "status", "hiddenLabel"]
    >();
    expectTypeOf<BrunoTableQuickFilterField<Order>>().toEqualTypeOf<
      "id" | "symbol" | "status" | "hiddenLabel"
    >();
    void BrunoTableClient({
      ...props,
      quickFilterFields: validQuickFilterFields,
    });
    void BrunoTableClient({
      ...props,
      // @ts-expect-error External Filters are Server-only application state.
      externalFilters: [],
    });
    void BrunoTableClient({
      ...props,
      // @ts-expect-error Quick Filter fields must be a non-empty tuple.
      quickFilterFields: [],
    });
    void BrunoTableClient({
      ...props,
      // @ts-expect-error Numeric row fields are not Quick Filter fields.
      quickFilterFields: ["price"],
    });
    void BrunoTableClient({
      ...props,
      // @ts-expect-error Misspelled source fields are rejected.
      quickFilterFields: ["descrption"],
    });
    void BrunoTableClient({
      ...props,
      // @ts-expect-error Column Identities are not source fields.
      quickFilterFields: ["COL_ID_SYMBOL"],
    });

    const missingTableId = {
      columns,
      initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
      getRowId: (row: Order) => row.id,
      clientSource: {
        rows: [] as readonly Order[],
        totalRows: 0,
        version: 1,
        status: "ready",
      },
    };
    // @ts-expect-error tableId is mandatory for every public Client Table.
    const invalidMissingTableId: BrunoTableClientProps<Order, Columns> = missingTableId;
    void invalidMissingTableId;

    const missingRowIdentity = {
      tableId: "orders",
      columns,
      initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }] as const,
      clientSource: {
        rows: [] as readonly Order[],
        totalRows: 0,
        version: 1,
        status: "ready",
      },
    };
    // @ts-expect-error Client identity is mandatory and cannot be replaced by a row index.
    const invalidMissingRowIdentity: BrunoTableClientProps<Order, Columns> = missingRowIdentity;
    void invalidMissingRowIdentity;

    // @ts-expect-error the first Client renderer requires a non-empty typed order baseline.
    void BrunoTableClient({
      tableId: "orders",
      columns,
      getRowId: (row: Order) => row.id,
      clientSource: {
        rows: [] as readonly Order[],
        totalRows: 0,
        version: 1,
        status: "ready",
      },
    });

    void BrunoTableClient({
      ...props,
      // @ts-expect-error BrunoTable owns the table runtime and exposes no controller prop.
      table: {},
    });
    void BrunoTableClient({
      ...props,
      // @ts-expect-error BrunoTable exposes no row-model option.
      rowModel: {},
    });
  });

  it("preserves exact identities and values", () => {
    expectTypeOf<"COL_ID_Price" extends BrunoTableColumnId ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<BrunoTableColumnIdOf<Columns>>().toEqualTypeOf<
      "COL_ID_SYMBOL" | "COL_ID_PRICE" | "COL_ID_DOUBLE_QUANTITY"
    >();
    expectTypeOf<BrunoTableColumnValue<Order, Columns, "COL_ID_SYMBOL">>().toEqualTypeOf<string>();
    expectTypeOf<BrunoTableColumnValue<Order, Columns, "COL_ID_PRICE">>().toEqualTypeOf<number>();
    expectTypeOf<
      BrunoTableColumnValue<Order, Columns, "COL_ID_DOUBLE_QUANTITY">
    >().toEqualTypeOf<bigint>();
  });

  it("derives capabilities instead of guessing computed server semantics", () => {
    expectTypeOf<BrunoTableFilterableColumnId<Columns>>().toEqualTypeOf<
      "COL_ID_SYMBOL" | "COL_ID_PRICE"
    >();
    expectTypeOf<BrunoTableSortableColumnId<Columns>>().toEqualTypeOf<
      "COL_ID_SYMBOL" | "COL_ID_PRICE"
    >();
    expectTypeOf<BrunoTableEditableColumnId<Columns>>().toEqualTypeOf<
      "COL_ID_SYMBOL" | "COL_ID_PRICE"
    >();
    expectTypeOf<
      BrunoTableFilterableColumnId<CapabilityColumns>
    >().toEqualTypeOf<"COL_ID_SYMBOL">();
    expectTypeOf<BrunoTableSortableColumnId<CapabilityColumns>>().toEqualTypeOf<"COL_ID_PRICE">();
    expectTypeOf<BrunoTableSortableColumnId<NoSortingColumns>>().toBeNever();
  });

  it("rejects a Client renderer when no column can supply its required order", () => {
    const props = {
      tableId: "unsortable-orders",
      columns: noSortingColumns,
      getRowId: (row: Order) => row.id,
      clientSource: {
        rows: [] as readonly Order[],
        totalRows: 0,
        version: 1,
        status: "ready",
      },
    } as const;

    // @ts-expect-error BrunoTableClient always requires a typed non-empty Initial Order By.
    const invalidProps: BrunoTableClientProps<Order, NoSortingColumns> = props;

    expectTypeOf(invalidProps).toEqualTypeOf<BrunoTableClientProps<Order, NoSortingColumns>>();
  });

  it("keeps widened runtime columns conservatively editable", () => {
    const widenedColumns: BrunoTableColumns<Order> = columns;

    expectTypeOf<
      BrunoTableEditableColumnId<typeof widenedColumns>
    >().toEqualTypeOf<BrunoTableColumnId>();

    const widenedEditableCapability = {
      editable: true,
      getRowVersion: (row: Order) => row.revision,
      onSaveEdits: (changes) => {
        expectTypeOf(changes[0].changes[0]).not.toBeNever();
        return Promise.resolve();
      },
    } satisfies BrunoTableEditingCapability<Order, typeof widenedColumns, bigint>;

    expectTypeOf(widenedEditableCapability.getRowVersion).returns.toEqualTypeOf<bigint>();
  });

  it("types the edit-row projector from exact potentially editable fields", () => {
    expectTypeOf<BrunoTableEditRowPatch<Order, typeof rowAwareEditableColumns>>().toEqualTypeOf<
      Readonly<Partial<Pick<Order, "symbol" | "price" | "quantity">>>
    >();

    const input: BrunoTableEditRowProjectorInput<Order, typeof rowAwareEditableColumns, bigint> = {
      row: {} as Order,
      patch: { symbol: "AMD", price: 128, quantity: 4n },
      rowVersion: 1n,
    };
    const projector: BrunoTableEditRowProjector<Order, typeof rowAwareEditableColumns, bigint> = ({
      row,
      patch,
    }) => ({ ...row, ...patch });

    expectTypeOf(input.row).toEqualTypeOf<Order>();
    expectTypeOf(input.patch).toEqualTypeOf<
      BrunoTableEditRowPatch<Order, typeof rowAwareEditableColumns>
    >();
    expectTypeOf(input.rowVersion).toEqualTypeOf<bigint>();
    expectTypeOf(projector).returns.toEqualTypeOf<Order>();

    const invalidPatch: BrunoTableEditRowPatch<Order, typeof rowAwareEditableColumns> = {
      // @ts-expect-error Non-editable fields are not part of the exact edit projection patch.
      revision: 2n,
    };
    void invalidPatch;
    const invalidValuePatch: BrunoTableEditRowPatch<Order, typeof rowAwareEditableColumns> = {
      // @ts-expect-error Edit projection values retain their exact source field types.
      quantity: 4,
    };
    void invalidValuePatch;
  });

  it("requires a projector when an exact editable tuple declares row-aware presentation", () => {
    const missingProjector = {
      editable: true,
      getRowVersion: (row: Order) => row.revision,
      onSaveEdits: () => Promise.resolve(),
    } as const;

    // @ts-expect-error Row-aware editable presentation requires a trusted projected Row seam.
    const invalidCapability: BrunoTableEditingCapability<
      Order,
      typeof rowAwareEditableColumns,
      bigint
    > = missingProjector;
    void invalidCapability;

    const validCapability = {
      ...missingProjector,
      projectEditRow: ({
        row,
        patch,
      }: BrunoTableEditRowProjectorInput<Order, typeof rowAwareEditableColumns, bigint>) => ({
        ...row,
        ...patch,
      }),
    } satisfies BrunoTableEditingCapability<Order, typeof rowAwareEditableColumns, bigint>;
    expectTypeOf(validCapability.projectEditRow).toMatchTypeOf<
      BrunoTableEditRowProjector<Order, typeof rowAwareEditableColumns, bigint>
    >();

    const widened: BrunoTableColumns<Order> = rowAwareEditableColumns;
    const widenedCapabilityWithoutStaticProof = {
      editable: true,
      getRowVersion: (row: Order) => row.revision,
      onSaveEdits: () => Promise.resolve(),
    } satisfies BrunoTableEditingCapability<Order, typeof widened, bigint>;
    void widenedCapabilityWithoutStaticProof;

    const directClientProps = {
      tableId: "row-aware-editable-client",
      columns: rowAwareEditableColumns,
      initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
      getRowId: (row: Order) => row.id,
      clientSource: directViewServerResult,
      editable: true,
      getRowVersion: (row: Order) => row.revision,
      onSaveEdits: () => Promise.resolve(),
    } as const;

    // @ts-expect-error Direct Editable Client calls require the trusted projection seam.
    void BrunoTableClient(directClientProps);
    void BrunoTableClient({
      ...directClientProps,
      projectEditRow: ({ row, patch }) => ({ ...row, ...patch }),
    });
  });

  it("detects each row-aware callback without widening value-only edit capabilities", () => {
    const formatterColumns = [
      {
        columnId: "COL_ID_SYMBOL",
        field: "symbol",
        headerName: "Symbol",
        valueType: "text",
        isEditable: true,
        valueFormatter: ({ value }) => value,
      },
    ] as const satisfies BrunoTableColumns<Order>;
    const classColumns = [
      {
        columnId: "COL_ID_PRICE",
        field: "price",
        headerName: "Price",
        valueType: "number",
        isEditable: true,
        cellClassName: ({ value }) => (value > 0 ? "positive" : undefined),
      },
    ] as const satisfies BrunoTableColumns<Order>;
    const rendererColumns = [
      {
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        headerName: "Quantity",
        valueType: "bigint",
        isEditable: true,
        cellRenderer: ({ value }) => value.toString(10),
      },
    ] as const satisfies BrunoTableColumns<Order>;
    const capabilityWithoutProjector = {
      editable: true,
      getRowVersion: (row: Order) => row.revision,
      onSaveEdits: () => Promise.resolve(),
    } as const;

    // @ts-expect-error An editable value formatter can consume the projected Row.
    const invalidFormatter: BrunoTableEditingCapability<Order, typeof formatterColumns, bigint> =
      capabilityWithoutProjector;
    // @ts-expect-error An editable Cell Class callback can consume the projected Row.
    const invalidClass: BrunoTableEditingCapability<Order, typeof classColumns, bigint> =
      capabilityWithoutProjector;
    // @ts-expect-error An editable Cell Renderer can consume the projected Row.
    const invalidRenderer: BrunoTableEditingCapability<Order, typeof rendererColumns, bigint> =
      capabilityWithoutProjector;
    void invalidFormatter;
    void invalidClass;
    void invalidRenderer;

    const valueOnlyColumns = [
      {
        columnId: "COL_ID_SYMBOL",
        field: "symbol",
        headerName: "Symbol",
        valueType: "text",
        isEditable: true,
        cellClassName: "tabular-nums",
      },
      {
        columnId: "COL_ID_REVISION",
        field: "revision",
        headerName: "Revision",
        valueType: "bigint",
        valueFormatter: ({ row, value }) => `${row.id}:${value}`,
      },
    ] as const satisfies BrunoTableColumns<Order>;
    const valueOnlyCapability = {
      ...capabilityWithoutProjector,
    } satisfies BrunoTableEditingCapability<Order, typeof valueOnlyColumns, bigint>;
    void valueOnlyCapability;

    const readOnlyWithProjector = {
      editable: false,
      projectEditRow: ({ row }: BrunoTableEditRowProjectorInput<Order, typeof valueOnlyColumns>) =>
        row,
    } as const;
    // @ts-expect-error Read-only Tables reject the edit-only Row projection seam.
    const invalidReadOnly: BrunoTableEditingCapability<Order, typeof valueOnlyColumns, bigint> =
      readOnlyWithProjector;
    void invalidReadOnly;
  });

  it("correlates row-grouped saves with source fields and exact row versions", () => {
    expectTypeOf<BrunoTableColumnField<Columns, "COL_ID_PRICE">>().toEqualTypeOf<"price">();
    expectTypeOf<BrunoTableSaveCellChange<Order, Columns>>().toEqualTypeOf<
      | {
          readonly columnId: "COL_ID_SYMBOL";
          readonly field: "symbol";
          readonly before: string;
          readonly after: string;
        }
      | {
          readonly columnId: "COL_ID_PRICE";
          readonly field: "price";
          readonly before: number;
          readonly after: number;
        }
    >();
    expectTypeOf<BrunoTableSaveChangeSet<Order, Columns, bigint>[number]>().toEqualTypeOf<{
      readonly rowId: string;
      readonly baseRow: Order;
      readonly expectedVersion: bigint;
      readonly changes: readonly [
        BrunoTableSaveCellChange<Order, Columns>,
        ...BrunoTableSaveCellChange<Order, Columns>[],
      ];
    }>();
  });

  it("requires explicit editable component generics to name the Row Version authority", () => {
    const editableProps = {
      tableId: "explicit-editable-version",
      columns,
      initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
      getRowId: (row: Order) => row.id,
      clientSource: directViewServerResult,
      editable: true,
      getRowVersion: (row: Order) => row.revision,
      onSaveEdits: (changes: BrunoTableSaveChangeSet<Order, Columns, bigint>) => {
        expectTypeOf(changes[0].expectedVersion).toEqualTypeOf<bigint>();
        return Promise.resolve();
      },
      projectEditRow: ({
        row,
        patch,
      }: BrunoTableEditRowProjectorInput<Order, Columns, bigint>) => ({
        ...row,
        ...patch,
      }),
    } as const;

    // @ts-expect-error Explicit editable calls require the third Row Version authority generic.
    void BrunoTableClient<Order, Columns>(editableProps);
    void BrunoTableClient<Order, Columns, (row: Order) => bigint>(editableProps);
    void BrunoTableClient(editableProps);

    // @ts-expect-error Editable named props require the third Row Version authority generic.
    const erasedNamedProps: BrunoTableClientProps<Order, Columns> = editableProps;
    void erasedNamedProps;
    const exactNamedProps: BrunoTableClientProps<Order, Columns, bigint> = editableProps;
    expectTypeOf(exactNamedProps.getRowVersion).returns.toEqualTypeOf<bigint>();
  });

  it("types recursive filters and ordered sorts", () => {
    const filters = [
      { columnId: "COL_ID_PRICE", type: "greaterThanOrEqual", filter: 100 },
      {
        columnId: "COL_ID_SYMBOL",
        type: "equals",
        filter: "AAPL",
        caseSensitive: true,
      },
      {
        type: "OR",
        conditions: [
          { columnId: "COL_ID_SYMBOL", type: "startsWith", filter: "A" },
          { type: "NOT", condition: { columnId: "COL_ID_SYMBOL", type: "blank" } },
        ],
      },
    ] satisfies BrunoTableFilterExpressions<Order, Columns>;

    const sorting = [
      { columnId: "COL_ID_PRICE", direction: "desc" },
      { columnId: "COL_ID_SYMBOL", direction: "asc" },
    ] satisfies BrunoTableSortBy<Columns>;

    expectTypeOf(filters).toBeArray();
    expectTypeOf(sorting).toBeArray();

    const emptyCompound = [
      {
        type: "OR",
        // @ts-expect-error Compound filter conditions are non-empty.
        conditions: [],
      },
    ] satisfies BrunoTableFilterExpressions<Order, Columns>;
    void emptyCompound;
  });

  it("accepts direct client and witnessed server viewport source envelopes", () => {
    const common = {
      tableId: "orders",
      columns,
      initialFilters: [
        { columnId: "COL_ID_SYMBOL", type: "startsWith", filter: "A" },
      ] satisfies BrunoTableFilterExpressions<Order, Columns>,
      initialOrderBy: [
        { columnId: "COL_ID_PRICE", direction: "desc" },
      ] satisfies BrunoTableSortBy<Columns>,
    } as const;

    const clientProps = {
      ...common,
      getRowId: (row: Order) => row.id,
      children: "Page-specific toolbar content",
      clientSource: {
        rows: [] as readonly Order[],
        totalRows: 0,
        version: 1,
        status: "ready",
      },
    } satisfies BrunoTableClientProps<Order, Columns>;

    const serverProps = {
      ...common,
      children: BrunoTableFilterControl({
        ownership: "external",
        children: "Application-controlled working set",
      }),
      viewportSource: { ...orderViewportSource, status: "loading" },
    } satisfies BrunoTableServerProps<Order, Columns, typeof orderViewportSource.viewport>;

    expectTypeOf(clientProps.clientSource.rows).toEqualTypeOf<readonly Order[]>();
    expectTypeOf(clientProps.initialFilters[0]!.columnId).toEqualTypeOf<"COL_ID_SYMBOL">();
    expectTypeOf(clientProps.children).toEqualTypeOf<string>();
    expectTypeOf(serverProps.viewportSource.viewport).toEqualTypeOf<
      typeof orderViewportSource.viewport
    >();
    expectTypeOf(serverProps.children).toEqualTypeOf<ReactNode>();

    const annotatedLeasedProps: BrunoTableServerProps<
      Order,
      Columns,
      typeof leasedOrderViewportSource.viewport
    > = {
      ...common,
      viewportSource: leasedOrderViewportSource,
      routeBy: { status: "open", revision: 1n },
      externalFilters: [{ field: "quantity", type: "inRange", filter: 1n, filterTo: 10n }],
    };
    void annotatedLeasedProps;

    // @ts-expect-error Server Props derive Route and External Filter authority from the viewport.
    type InvalidServerRouteOverride = BrunoTableServerProps<
      Order,
      Columns,
      typeof leasedOrderViewportSource.viewport,
      never
    >;
    expectTypeOf<InvalidServerRouteOverride>();
    void BrunoTableServer<
      // @ts-expect-error the Server component exposes no caller-selectable Route/Where generics.
      typeof leasedOrderViewportSource.viewport,
      Columns,
      typeof annotatedLeasedProps,
      never
    >;

    // @ts-expect-error the direct three-generic leased Props alias requires Feed Route.
    const annotatedMissingRoute: BrunoTableServerProps<
      Order,
      Columns,
      typeof leasedOrderViewportSource.viewport
    > = { ...common, viewportSource: leasedOrderViewportSource };
    void annotatedMissingRoute;
    const annotatedMissingRouteField: BrunoTableServerProps<
      Order,
      Columns,
      typeof leasedOrderViewportSource.viewport
    > = {
      ...common,
      viewportSource: leasedOrderViewportSource,
      // @ts-expect-error the direct alias requires every source-owned Route field.
      routeBy: { status: "open" },
    };
    void annotatedMissingRouteField;
    const annotatedExtraRouteField: BrunoTableServerProps<
      Order,
      Columns,
      typeof leasedOrderViewportSource.viewport
    > = {
      ...common,
      viewportSource: leasedOrderViewportSource,
      // @ts-expect-error the direct alias rejects fields outside the source-owned Route tuple.
      routeBy: { status: "open", revision: 1n, desk: "rates" },
    };
    void annotatedExtraRouteField;
    const annotatedWrongRouteValue: BrunoTableServerProps<
      Order,
      Columns,
      typeof leasedOrderViewportSource.viewport
    > = {
      ...common,
      viewportSource: leasedOrderViewportSource,
      // @ts-expect-error the direct alias preserves exact Route scalar domains.
      routeBy: { status: "open", revision: 1 },
    };
    void annotatedWrongRouteValue;
    const annotatedWrongExternalField: BrunoTableServerProps<
      Order,
      Columns,
      typeof leasedOrderViewportSource.viewport
    > = {
      ...common,
      viewportSource: leasedOrderViewportSource,
      routeBy: { status: "open", revision: 1n },
      // @ts-expect-error the direct alias rejects unknown External Filter fields.
      externalFilters: [{ field: "missing", type: "equals", filter: "open" }],
    };
    void annotatedWrongExternalField;
    const annotatedWrongExternalOperand: BrunoTableServerProps<
      Order,
      Columns,
      typeof leasedOrderViewportSource.viewport
    > = {
      ...common,
      viewportSource: leasedOrderViewportSource,
      routeBy: { status: "open", revision: 1n },
      // @ts-expect-error the direct alias preserves exact known-field operand domains.
      externalFilters: [{ field: "quantity", type: "equals", filter: 1 }],
    };
    void annotatedWrongExternalOperand;
    const annotatedMixedExternalRange: BrunoTableServerProps<
      Order,
      Columns,
      typeof leasedOrderViewportSource.viewport
    > = {
      ...common,
      viewportSource: leasedOrderViewportSource,
      routeBy: { status: "open", revision: 1n },
      // @ts-expect-error the direct alias keeps both bigint range bounds in one exact domain.
      externalFilters: [{ field: "quantity", type: "inRange", filter: 1n, filterTo: 10 }],
    };
    void annotatedMixedExternalRange;
    const annotatedMaterializedRoute: BrunoTableServerProps<
      Order,
      Columns,
      typeof orderViewportSource.viewport
    > = {
      ...common,
      viewportSource: orderViewportSource,
      // @ts-expect-error the direct source-free alias forbids Feed Route.
      routeBy: { status: "open" },
    };
    void annotatedMaterializedRoute;

    void BrunoTableServer({
      ...serverProps,
      externalFilters: [{ field: "status", type: "equals", filter: "open" }],
    });
    void BrunoTableServer({
      ...common,
      viewportSource: leasedOrderViewportSource,
      routeBy: { status: "open", revision: 1n },
      externalFilters: [{ field: "quantity", type: "inRange", filter: 1n, filterTo: 10n }],
    });
    // @ts-expect-error leased sources require their complete exact Route tuple.
    void BrunoTableServer({ ...common, viewportSource: leasedOrderViewportSource });
    void BrunoTableServer({
      ...common,
      viewportSource: leasedOrderViewportSource,
      // @ts-expect-error leased sources reject missing Route fields.
      routeBy: { status: "open" },
    });
    void BrunoTableServer({
      ...common,
      viewportSource: leasedOrderViewportSource,
      // @ts-expect-error leased sources reject extra Route fields.
      routeBy: { status: "open", revision: 1n, desk: "rates" },
    });
    void BrunoTableServer({
      ...common,
      viewportSource: leasedOrderViewportSource,
      // @ts-expect-error exact Route values reject the wrong scalar domain.
      routeBy: { status: "open", revision: 1 },
    });
    // @ts-expect-error source-free topics forbid Feed Route.
    void BrunoTableServer({ ...serverProps, routeBy: { status: "open" } });
    void BrunoTableServer({
      ...serverProps,
      // @ts-expect-error External Filters reject unknown fields.
      externalFilters: [{ field: "missing", type: "equals", filter: "open" }],
    });
    void BrunoTableServer({
      ...serverProps,
      // @ts-expect-error External Filters preserve exact field operand domains.
      externalFilters: [{ field: "quantity", type: "equals", filter: 1 }],
    });
    void BrunoTableServer({
      ...serverProps,
      // @ts-expect-error inRange bounds preserve one exact bigint operand domain.
      externalFilters: [{ field: "quantity", type: "inRange", filter: 1n, filterTo: 10 }],
    });

    void BrunoTableClient({
      ...clientProps,
      initialOrderBy: [{ columnId: "COL_ID_PRICE", direction: "asc" }],
    });
    const missingColumns = {
      tableId: "orders",
      getRowId: (row: Order) => row.id,
      initialOrderBy: [{ columnId: "COL_ID_PRICE", direction: "asc" }] as const,
      clientSource: clientProps.clientSource,
    };
    // @ts-expect-error A Client Table cannot omit its column definitions.
    const invalidMissingColumns: BrunoTableClientProps<Order, Columns> = missingColumns;
    void invalidMissingColumns;

    const missingClientSource = {
      tableId: "orders",
      columns,
      getRowId: (row: Order) => row.id,
      initialOrderBy: [{ columnId: "COL_ID_PRICE", direction: "asc" }] as const,
    };
    // @ts-expect-error A Client Table cannot omit its live Client Source.
    const invalidMissingClientSource: BrunoTableClientProps<Order, Columns> = missingClientSource;
    void invalidMissingClientSource;
    void BrunoTableClient({
      ...clientProps,
      // @ts-expect-error initialOrderBy is a non-empty typed tuple.
      initialOrderBy: [],
    });

    const noSortColumns = [
      {
        columnId: "COL_ID_SYMBOL",
        field: "symbol",
        headerName: "Symbol",
        valueType: "text",
        isEditable: true,
        enableSorting: false,
      },
    ] as const satisfies BrunoTableColumns<Order>;
    // @ts-expect-error BrunoTableClient cannot omit its required non-empty Initial Order By.
    void BrunoTableClient<Order, typeof noSortColumns>({
      tableId: "orders-no-sort",
      columns: noSortColumns,
      getRowId: (row: Order) => row.id,
      clientSource: clientProps.clientSource,
    });
    void BrunoTableClient<Order, typeof noSortColumns>({
      tableId: "orders-no-sort",
      columns: noSortColumns,
      // @ts-expect-error a Client definition without a sortable Column Identity is invalid.
      initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
      getRowId: (row: Order) => row.id,
      clientSource: clientProps.clientSource,
    });
  });
});

type HelperRow = {
  readonly symbol: string;
  readonly price: number;
  readonly quantity: bigint;
  readonly active: boolean;
  readonly status: "open" | "closed";
  readonly multiplier: number;
};

const priceColumn = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  width: 112,
  format: {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  },
});

const statusColumn = BrunoTableSelectColumn.withDefaults({
  headerName: "Status",
  options: ["open", "closed"],
});

type PresetEditRow = Readonly<{
  readonly nullable: number | null;
  readonly optional: number | undefined;
  readonly required: number;
  readonly nullableStatus: "open" | "closed" | null;
  readonly requiredStatus: "open" | "closed";
}>;
const invalidRawValidationColumns = [
  // @ts-expect-error validation is edit-only and requires statically potential editability.
  {
    columnId: "COL_ID_READ_ONLY_VALIDATE",
    field: "required",
    headerName: "Read-only validate",
    valueType: "number",
    validate: () => undefined,
  },
] satisfies BrunoTableColumns<PresetEditRow>;
void invalidRawValidationColumns;
// @ts-expect-error preset validation requires literal true or predicate editability.
BrunoTableNumberColumn.withDefaults({
  validate: () => undefined,
});
const nullableNumberPreset = BrunoTableNumberColumn.withDefaults({
  isEditable: true,
  blankValue: null,
  validate: ({ value }) => (value === undefined ? "Unexpected undefined" : undefined),
});
const presetEditColumns = [
  nullableNumberPreset({
    columnId: "COL_ID_NULLABLE_PRESET",
    field: "nullable",
    headerName: "Nullable preset",
  }),
] satisfies BrunoTableColumns<PresetEditRow>;
void presetEditColumns;
const optionalPresetEditColumns = [
  nullableNumberPreset({
    columnId: "COL_ID_OPTIONAL_PRESET",
    field: "optional",
    headerName: "Optional preset",
    blankValue: undefined,
  }),
] satisfies BrunoTableColumns<PresetEditRow>;
void optionalPresetEditColumns;
const predicateNumberPreset = BrunoTableNumberColumn.withDefaults({
  isEditable: ({ row, value }) => {
    expectTypeOf(row).toEqualTypeOf<unknown>();
    expectTypeOf(value).toEqualTypeOf<number | null | undefined>();
    return value !== undefined;
  },
  blankValue: null,
});
const predicateNumberPresetColumns = [
  predicateNumberPreset({
    columnId: "COL_ID_PREDICATE_NULLABLE_PRESET",
    field: "nullable",
    headerName: "Predicate nullable preset",
  }),
] satisfies BrunoTableColumns<PresetEditRow>;
void predicateNumberPresetColumns;
const predicateSelectPreset = BrunoTableSelectColumn.withDefaults({
  options: ["open", "closed"],
  isEditable: ({ row, value }) => {
    expectTypeOf(row).toEqualTypeOf<unknown>();
    expectTypeOf(value).toEqualTypeOf<"open" | "closed" | null | undefined>();
    return value !== undefined;
  },
  blankValue: null,
});
const predicateSelectPresetColumns = [
  predicateSelectPreset({
    columnId: "COL_ID_PREDICATE_SELECT_PRESET",
    field: "nullableStatus",
    headerName: "Predicate Select preset",
  }),
] satisfies BrunoTableColumns<PresetEditRow>;
void predicateSelectPresetColumns;
const invalidRequiredSelectPreset = predicateSelectPreset({
  columnId: "COL_ID_INVALID_REQUIRED_SELECT_PRESET",
  // @ts-expect-error an inherited null blank policy cannot target a required Select field.
  field: "requiredStatus",
  headerName: "Invalid required Select preset",
});
void invalidRequiredSelectPreset;
const widenedEditableDefaults: { readonly isEditable?: boolean } = { isEditable: true };
const widenedEditableNumberPreset = BrunoTableNumberColumn.withDefaults(widenedEditableDefaults);
const invalidWidenedNullablePreset = widenedEditableNumberPreset({
  columnId: "COL_ID_WIDENED_NULLABLE_PRESET",
  // @ts-expect-error widened editability may be true, so nullable fields require a blank policy.
  field: "nullable",
  headerName: "Widened nullable preset",
});
void invalidWidenedNullablePreset;
const invalidWidenedNullablePresetWithBlank = widenedEditableNumberPreset({
  columnId: "COL_ID_WIDENED_NULLABLE_PRESET_WITH_BLANK",
  // @ts-expect-error widened editability cannot prove the nullable field capability.
  field: "nullable",
  headerName: "Widened nullable preset with blank",
  // @ts-expect-error a blank policy still requires exact true or predicate editability.
  blankValue: null,
});
void invalidWidenedNullablePresetWithBlank;
const validWidenedRequiredPreset = [
  widenedEditableNumberPreset({
    columnId: "COL_ID_WIDENED_REQUIRED_PRESET",
    field: "required",
    headerName: "Widened required preset",
  }),
] satisfies BrunoTableColumns<PresetEditRow>;
void validWidenedRequiredPreset;
const computedFromEditPresetColumns = [
  nullableNumberPreset({
    columnId: "COL_ID_COMPUTED_PRESET",
    fields: ["required"],
    headerName: "Computed preset",
    valueGetter: ({ row }) => row.required,
  }),
] satisfies BrunoTableColumns<PresetEditRow>;
const computedFromEditPreset = computedFromEditPresetColumns[0]!;
expectTypeOf(computedFromEditPreset["isEditable"]).toEqualTypeOf<undefined>();
expectTypeOf(computedFromEditPreset["blankValue"]).toEqualTypeOf<undefined>();
expectTypeOf(computedFromEditPreset["validate"]).toEqualTypeOf<undefined>();
const invalidPresetField = nullableNumberPreset({
  columnId: "COL_ID_REQUIRED_PRESET",
  // @ts-expect-error a null blank preset can target only a field whose domain contains null.
  field: "required",
  headerName: "Required preset",
});
void invalidPresetField;
const invalidDisabledPresetField = nullableNumberPreset({
  columnId: "COL_ID_DISABLED_PRESET",
  // @ts-expect-error an inherited blank cannot be combined with an isEditable false override.
  field: "nullable",
  headerName: "Disabled preset",
  // @ts-expect-error the effective false-plus-blank shape is rejected.
  isEditable: false,
});
void invalidDisabledPresetField;
const editableWithoutBlankPreset = BrunoTableNumberColumn.withDefaults({ isEditable: true });
const validRequiredEditableWithoutBlank = [
  editableWithoutBlankPreset({
    columnId: "COL_ID_REQUIRED_EDITABLE_PRESET",
    field: "required",
    headerName: "Required editable preset",
  }),
] satisfies BrunoTableColumns<PresetEditRow>;
void validRequiredEditableWithoutBlank;
const validatedNumberPreset = BrunoTableNumberColumn.withDefaults({
  isEditable: true,
  validate: () => undefined,
});
const invalidDisabledValidatedPreset = validatedNumberPreset({
  columnId: "COL_ID_DISABLED_VALIDATED_PRESET",
  // @ts-expect-error inherited validation cannot combine with a false editability override.
  field: "required",
  headerName: "Disabled validated preset",
  // @ts-expect-error the effective false-plus-validation shape is rejected.
  isEditable: false,
});
void invalidDisabledValidatedPreset;
const invalidNullableEditableWithoutBlank = editableWithoutBlankPreset({
  columnId: "COL_ID_NULLABLE_EDITABLE_PRESET",
  // @ts-expect-error nullable editable preset applications require an exact blank policy.
  field: "nullable",
  headerName: "Nullable editable preset",
});
void invalidNullableEditableWithoutBlank;
// @ts-expect-error a blank preset requires literal isEditable true.
BrunoTableNumberColumn.withDefaults({
  isEditable: false,
  blankValue: null,
});

const computedPriceColumn = BrunoTableNumberColumn.withDefaults({
  headerName: "Calculated price",
  enableFilter: true,
  enableSorting: true,
  isEditable: true,
});

const computedPresetColumns = [
  computedPriceColumn({
    columnId: "COL_ID_COMPUTED_PRICE",
    fields: ["price", "multiplier"],
    valueGetter: ({ row }) => row.price * row.multiplier,
  }),
] satisfies BrunoTableColumns<HelperRow>;

expectTypeOf<(typeof computedPresetColumns)[0]["enableFilter"]>().toEqualTypeOf<undefined>();
expectTypeOf<(typeof computedPresetColumns)[0]["enableSorting"]>().toEqualTypeOf<undefined>();
expectTypeOf<(typeof computedPresetColumns)[0]["isEditable"]>().toEqualTypeOf<undefined>();

const helperColumns = [
  BrunoTableTextColumn({
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
  }),
  priceColumn({
    columnId: "COL_ID_PRICE",
    field: "price",
    width: 144,
    format: { maximumFractionDigits: 4 },
    isEditable: ({ row, value }) => {
      expectTypeOf(row).toEqualTypeOf<HelperRow>();
      expectTypeOf(value).toEqualTypeOf<number>();
      return row.status === "open" && value >= 0;
    },
    valueFormatter: ({ row, value }) => `${row.symbol} ${value.toFixed(2)}`,
    cellClassName: ({ value }) => (value < 0 ? "text-destructive" : undefined),
    cellRenderer: ({ row, value }) => `${row.symbol}:${value}`,
  }),
  BrunoTableBigIntColumn({
    columnId: "COL_ID_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
  }),
  BrunoTableBooleanColumn({
    columnId: "COL_ID_ACTIVE",
    field: "active",
    headerName: "Active",
  }),
  statusColumn({
    columnId: "COL_ID_STATUS",
    field: "status",
  }),
  BrunoTableNumberColumn({
    columnId: "COL_ID_WEIGHTED_PRICE",
    fields: ["price", "multiplier"],
    headerName: "Weighted price",
    valueGetter: ({ row }) => {
      expectTypeOf(row).toEqualTypeOf<Pick<HelperRow, "price" | "multiplier">>();
      return row.price * row.multiplier;
    },
    valueFormatter: ({ value }) => value.toFixed(2),
  }),
] satisfies BrunoTableColumns<HelperRow>;

type HelperColumns = typeof helperColumns;
type PriceHelperColumn = Extract<HelperColumns[number], { readonly columnId: "COL_ID_PRICE" }>;
type QuantityHelperColumn = Extract<
  HelperColumns[number],
  { readonly columnId: "COL_ID_QUANTITY" }
>;
type ActiveHelperColumn = Extract<HelperColumns[number], { readonly columnId: "COL_ID_ACTIVE" }>;
type StatusHelperColumn = Extract<HelperColumns[number], { readonly columnId: "COL_ID_STATUS" }>;

describe("BrunoTable Column Helpers", () => {
  it("preserves identities, values, defaults, presets, and individual overrides", () => {
    expectTypeOf<BrunoTableColumnIdOf<HelperColumns>>().toEqualTypeOf<
      | "COL_ID_SYMBOL"
      | "COL_ID_PRICE"
      | "COL_ID_QUANTITY"
      | "COL_ID_ACTIVE"
      | "COL_ID_STATUS"
      | "COL_ID_WEIGHTED_PRICE"
    >();
    expectTypeOf<
      BrunoTableColumnValue<HelperRow, HelperColumns, "COL_ID_PRICE">
    >().toEqualTypeOf<number>();
    expectTypeOf<
      BrunoTableColumnValue<HelperRow, HelperColumns, "COL_ID_QUANTITY">
    >().toEqualTypeOf<bigint>();
    expectTypeOf<BrunoTableColumnValue<HelperRow, HelperColumns, "COL_ID_STATUS">>().toEqualTypeOf<
      "open" | "closed"
    >();
    expectTypeOf<
      BrunoTableColumnValue<HelperRow, HelperColumns, "COL_ID_WEIGHTED_PRICE">
    >().toEqualTypeOf<number>();

    expectTypeOf<PriceHelperColumn["width"]>().toEqualTypeOf<144>();
    expectTypeOf<PriceHelperColumn["cellAlign"]>().toEqualTypeOf<"end">();
    expectTypeOf<QuantityHelperColumn["cellAlign"]>().toEqualTypeOf<"end">();
    expectTypeOf<ActiveHelperColumn["cellAlign"]>().toEqualTypeOf<"center">();
    expectTypeOf<StatusHelperColumn["editorLayout"]>().toEqualTypeOf<"fullWidth">();
  });
});

type ExactAmount = { readonly minor: bigint };
type AmountRow = { readonly amount: ExactAmount };

const exactAmountValueType = {
  codecId: "test/exact-amount",
  codecVersion: 1,
  filterFamily: "numeric",
  editorFamily: "text",
  cellAlign: "end",
  editorLayout: "inline",
  defaultWidth: 120,
  decodeRuntime: (input): BrunoTableDecodeResult<ExactAmount> =>
    typeof input === "object" &&
    input !== null &&
    "minor" in input &&
    typeof input.minor === "bigint"
      ? { _tag: "Success", value: { minor: input.minor } }
      : { _tag: "Failure", message: "Expected an exact amount." },
  equivalent: (left, right) => left.minor === right.minor,
  compare: (left, right) => (left.minor === right.minor ? 0 : left.minor < right.minor ? -1 : 1),
  formatCanonicalText: (value) => value.minor.toString(10),
  parseCanonicalText: (text) =>
    /^-?\d+$/u.test(text)
      ? { _tag: "Success", value: { minor: BigInt(text) } }
      : { _tag: "Failure", message: "Expected integer minor units." },
  formatDisplay: (value) => value.minor.toString(10),
  encodePersisted: (value) => ({ minor: value.minor.toString(10) }),
  decodePersisted: () => ({ _tag: "Failure", message: "Not used in this type proof." }),
} satisfies BrunoTableValueType<ExactAmount, "numeric", "text">;

const customValueColumns = [
  {
    columnId: "COL_ID_AMOUNT",
    field: "amount",
    headerName: "Amount",
    valueType: exactAmountValueType,
  },
] satisfies BrunoTableColumns<AmountRow>;

const exactEqualityValueType = {
  ...exactAmountValueType,
  filterFamily: "equality",
} satisfies BrunoTableValueType<ExactAmount, "equality", "text">;

// @ts-expect-error Select editor option provenance is supplied only by BrunoTableSelectColumn.
type UnsupportedCustomSelect = BrunoTableValueType<string, "select", "select">;
void (0 as unknown as UnsupportedCustomSelect);

const optedInEqualitySetColumns = [
  {
    columnId: "COL_ID_AMOUNT",
    enableSetFilter: true,
    field: "amount",
    headerName: "Amount",
    valueType: exactEqualityValueType,
  },
] satisfies BrunoTableColumns<AmountRow>;

const acceptedEqualitySetFilters = [
  { columnId: "COL_ID_AMOUNT", type: "in", filter: [{ minor: 1n }] },
  { columnId: "COL_ID_AMOUNT", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<AmountRow, typeof optedInEqualitySetColumns>;

void acceptedEqualitySetFilters;

const customComputedValueColumns = [
  BrunoTableComputedColumn({
    columnId: "COL_ID_AMOUNT_COPY",
    fields: ["amount"],
    headerName: "Amount copy",
    valueType: exactAmountValueType,
    valueGetter: ({ row }) => {
      expectTypeOf(row).toEqualTypeOf<Pick<AmountRow, "amount">>();
      return row.amount;
    },
    valueFormatter: ({ value }) => value.minor.toString(10),
  }),
] satisfies BrunoTableColumns<AmountRow>;
const computedWithErasedEditOptions = {
  ...customComputedValueColumns[0],
  blankValue: null,
  validate: () => undefined,
};
const invalidErasedComputedEditOptions = [
  // @ts-expect-error computed columns reject edit-only options after intermediate widening.
  computedWithErasedEditOptions,
] satisfies BrunoTableColumns<AmountRow>;

expectTypeOf<
  BrunoTableColumnValue<AmountRow, typeof customComputedValueColumns, "COL_ID_AMOUNT_COPY">
>().toEqualTypeOf<ExactAmount>();

const customNumericFilter = [
  { columnId: "COL_ID_AMOUNT", type: "greaterThan", filter: { minor: 10n } },
] satisfies BrunoTableFilterExpressions<AmountRow, typeof customValueColumns>;

void customNumericFilter;
void customComputedValueColumns;
void invalidErasedComputedEditOptions;

const invalidColumnIds = [
  {
    // @ts-expect-error column identities are namespaced and uppercase.
    columnId: "price",
    field: "price",
    headerName: "Price",
    valueType: "number",
  },
  {
    // @ts-expect-error lowercase suffixes are rejected.
    columnId: "COL_ID_price",
    field: "price",
    headerName: "Price",
    valueType: "number",
  },
] satisfies BrunoTableColumns<Order>;

const invalidField = [
  // @ts-expect-error field must be a real row key.
  {
    columnId: "COL_ID_PRICES",
    field: "prices",
    headerName: "Price",
    valueType: "number",
  },
] satisfies BrunoTableColumns<Order>;

const ambiguousColumn = [
  // @ts-expect-error field and valueGetter are mutually exclusive.
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: "number",
    valueGetter: ({ row }: { readonly row: Order }) => row.price,
  },
] satisfies BrunoTableColumns<Order>;

const missingHeaderName = [
  // @ts-expect-error every leaf column requires an explicit header name.
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Order>;

const invalidValueType = [
  // @ts-expect-error a number field requires number Value Semantics.
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Order>;

const invalidCapabilityFlags = [
  // @ts-expect-error filtering capability accepts only a boolean opt-out.
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: "number",
    enableFilter: "no",
  },
  // @ts-expect-error sorting capability accepts only a boolean opt-out.
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
    enableSorting: 0,
  },
] satisfies BrunoTableColumns<Order>;

const invalidComputedDependency = [
  BrunoTableComputedColumn({
    columnId: "COL_ID_DOUBLE_QUANTITY",
    fields: ["quantity"],
    headerName: "Double quantity",
    valueType: "bigint",
    valueGetter: ({ row }) => {
      // @ts-expect-error undeclared fields are absent from the Computed Column getter row.
      void row.price;
      return row.quantity * 2n;
    },
  }),
] satisfies BrunoTableColumns<Order>;

const invalidEmptyComputedDependencies = [
  BrunoTableComputedColumn({
    columnId: "COL_ID_DOUBLE_QUANTITY",
    // @ts-expect-error a Computed Column requires a non-empty dependency tuple.
    fields: [],
    headerName: "Double quantity",
    // @ts-expect-error no Value Type overload accepts an empty dependency tuple.
    valueType: "bigint",
    // @ts-expect-error no getter overload accepts an empty dependency tuple.
    valueGetter: () => 0n,
  }),
] satisfies BrunoTableColumns<Order>;

const invalidNumericFilter = [
  // @ts-expect-error contains is not a numeric operator.
  { columnId: "COL_ID_PRICE", type: "contains", filter: "10" },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const invalidNumericSensitivity = [
  {
    columnId: "COL_ID_PRICE",
    type: "equals",
    filter: 10,
    // @ts-expect-error case sensitivity belongs only to text filters.
    caseSensitive: true,
  },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const exactBuiltInFilters = [
  { columnId: "COL_ID_QUANTITY", type: "greaterThanOrEqual", filter: 10n },
  { columnId: "COL_ID_ACTIVE", type: "equals", filter: true },
  { columnId: "COL_ID_STATUS", type: "equals", filter: "open" },
] satisfies BrunoTableFilterExpressions<HelperRow, HelperColumns>;

const invalidBigIntFilterOperand = [
  // @ts-expect-error BigInt filters preserve bigint operands instead of accepting number values.
  { columnId: "COL_ID_QUANTITY", type: "greaterThan", filter: 10 },
] satisfies BrunoTableFilterExpressions<HelperRow, HelperColumns>;

const invalidBooleanFilterOperand = [
  // @ts-expect-error Boolean filters preserve boolean operands instead of accepting text labels.
  { columnId: "COL_ID_ACTIVE", type: "equals", filter: "true" },
] satisfies BrunoTableFilterExpressions<HelperRow, HelperColumns>;

const invalidSelectFilterOperand = [
  // @ts-expect-error Select filters admit only the exact configured value union.
  { columnId: "COL_ID_STATUS", type: "equals", filter: "pending" },
] satisfies BrunoTableFilterExpressions<HelperRow, HelperColumns>;

void exactBuiltInFilters;
void invalidBigIntFilterOperand;
void invalidBooleanFilterOperand;
void invalidSelectFilterOperand;

type FeatureFlag = { readonly enabled: boolean };

const featureFlagColumns = [
  {
    columnId: "COL_ID_ENABLED",
    field: "enabled",
    headerName: "Enabled",
    valueType: "boolean",
  },
] satisfies BrunoTableColumns<FeatureFlag>;

const invalidBooleanSensitivity = [
  {
    columnId: "COL_ID_ENABLED",
    type: "equals",
    filter: true,
    // @ts-expect-error accent sensitivity belongs only to text filters.
    accentSensitive: true,
  },
] satisfies BrunoTableFilterExpressions<FeatureFlag, typeof featureFlagColumns>;

const acceptedBooleanSetFilter = [
  { columnId: "COL_ID_ENABLED", type: "in", filter: [true] },
  { columnId: "COL_ID_ENABLED", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<FeatureFlag, typeof featureFlagColumns>;

const optedOutBooleanSetFilterColumns = [
  {
    columnId: "COL_ID_ENABLED",
    enableSetFilter: false,
    field: "enabled",
    headerName: "Enabled",
    valueType: "boolean",
  },
] satisfies BrunoTableColumns<FeatureFlag>;

const acceptedOptedOutBooleanInFilter = [
  { columnId: "COL_ID_ENABLED", type: "in", filter: [true] },
] satisfies BrunoTableFilterExpressions<FeatureFlag, typeof optedOutBooleanSetFilterColumns>;

const invalidOptedOutBooleanMatchNone = [
  // @ts-expect-error Match None belongs to the explicitly disabled Set Filter surface.
  { columnId: "COL_ID_ENABLED", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<FeatureFlag, typeof optedOutBooleanSetFilterColumns>;

void acceptedOptedOutBooleanInFilter;
void invalidOptedOutBooleanMatchNone;

const setFilterColumns = [
  {
    columnId: "COL_ID_SYMBOL",
    enableSetFilter: true,
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
  },
  {
    columnId: "COL_ID_PRICE",
    enableSetFilter: true,
    field: "price",
    headerName: "Price",
    valueType: "number",
  },
] as const satisfies BrunoTableColumns<Order>;

const invalidEmptyInFilter = [
  // @ts-expect-error `in` operands must be a non-empty tuple.
  { columnId: "COL_ID_SYMBOL", type: "in", filter: [] },
] satisfies BrunoTableFilterExpressions<Order, typeof setFilterColumns>;

const acceptedTextInFilter = [
  { columnId: "COL_ID_SYMBOL", type: "in", filter: ["AAPL"] },
] satisfies BrunoTableFilterExpressions<Order, typeof setFilterColumns>;

const acceptedNumericInFilter = [
  { columnId: "COL_ID_PRICE", type: "in", filter: [10] },
] satisfies BrunoTableFilterExpressions<Order, typeof setFilterColumns>;

const invalidDefaultTextSetFilter = [
  // @ts-expect-error Text Set Filter requires explicit opt-in.
  { columnId: "COL_ID_SYMBOL", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const invalidDefaultNumberSetFilter = [
  // @ts-expect-error Number Set Filter requires explicit opt-in.
  { columnId: "COL_ID_PRICE", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const invalidSetFilterCapability = [
  // @ts-expect-error Set Filter cannot be enabled when filtering is disabled.
  {
    columnId: "COL_ID_SYMBOL",
    enableFilter: false,
    enableSetFilter: true,
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Order>;

const acceptedSelectSetFilter = [
  { columnId: "COL_ID_STATUS", type: "in", filter: ["open"] },
  { columnId: "COL_ID_STATUS", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<HelperRow, HelperColumns>;

const invalidComputedFilter = [
  // @ts-expect-error computed columns have no automatic filter mapping.
  { columnId: "COL_ID_DOUBLE_QUANTITY", type: "greaterThan", filter: 10n },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const invalidOptedOutFilter = [
  // @ts-expect-error an explicitly non-filterable Field Column is absent from filter identities.
  { columnId: "COL_ID_PRICE", type: "greaterThan", filter: 10 },
] satisfies BrunoTableFilterExpressions<Order, CapabilityColumns>;

const invalidMixedColumnCompoundFilter = [
  {
    type: "OR",
    // @ts-expect-error compound filters may combine leaves from only one Column Identity.
    conditions: [
      { columnId: "COL_ID_PRICE", type: "greaterThan", filter: 10 },
      { columnId: "COL_ID_SYMBOL", type: "startsWith", filter: "A" },
    ],
  },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const invalidSort = [
  // @ts-expect-error computed columns have no automatic sort mapping.
  { columnId: "COL_ID_DOUBLE_QUANTITY", direction: "asc" },
] satisfies BrunoTableSortBy<Columns>;

const invalidOptedOutSort = [
  // @ts-expect-error an explicitly nonsortable Field Column is absent from sort identities.
  { columnId: "COL_ID_SYMBOL", direction: "asc" },
] satisfies BrunoTableSortBy<CapabilityColumns>;

const invalidNoCapabilitySort = [
  // @ts-expect-error no sortable Column Identity exists for this table.
  { columnId: "COL_ID_SYMBOL", direction: "asc" },
] satisfies BrunoTableSortBy<NoSortingColumns>;

// @ts-expect-error a table can never have an empty normal sort order.
const invalidEmptySort = [] satisfies BrunoTableSortBy<Columns>;

const invalidPaginatedClient = {
  tableId: "orders",
  getRowId: (row: Order) => row.id,
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
  // @ts-expect-error Client Tables expose one continuous row space, not page size.
  pageSize: 100,
} satisfies BrunoTableClientProps<Order, Columns>;

const invalidPaginatedServer = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  viewportSource: orderViewportSource,
  // @ts-expect-error Server Tables expose one continuous row space, not page index.
  pageIndex: 0,
} satisfies BrunoTableServerProps<Order, Columns, typeof orderViewportSource.viewport>;

const clientWithoutRowId = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
} as const;

// @ts-expect-error Client identity must be derived from the complete resident rows.
const invalidClientWithoutRowId: BrunoTableClientProps<Order, Columns> = clientWithoutRowId;

const invalidServerWithRowId = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  // @ts-expect-error Server identity is supplied by the Viewport Source, not the consumer.
  getRowId: (row: Order) => row.id,
  viewportSource: orderViewportSource,
} satisfies BrunoTableServerProps<Order, Columns, typeof orderViewportSource.viewport>;

const validClientRowSelection = {
  tableId: "orders-selection",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  rowSelection: true,
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
} as const satisfies BrunoTableClientProps<Order, Columns>;
void validClientRowSelection;

const invalidClientRowSelectionValue = {
  ...validClientRowSelection,
  rowSelection: false,
} as const;
// @ts-expect-error Row Selection is an exact opt-in capability, not controlled state.
const invalidClientRowSelectionValueAssignment: BrunoTableClientProps<Order, Columns> =
  invalidClientRowSelectionValue;
void invalidClientRowSelectionValueAssignment;

const invalidServerEditing = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  viewportSource: orderViewportSource,
  // @ts-expect-error Server Tables cannot enable editing.
  editable: true,
} satisfies BrunoTableServerProps<Order, Columns, typeof orderViewportSource.viewport>;

const editableClientWithoutSave = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  editable: true,
  getRowVersion: (row: Order) => row.revision,
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
} as const;

// @ts-expect-error editable Client Tables require an onSaveEdits operation.
const invalidEditableClientWithoutSave: BrunoTableEditingCapability<Order, Columns, bigint> =
  editableClientWithoutSave;

const readOnlyClientWithSave = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  editable: false,
  getRowVersion: (row: Order) => row.revision,
  onSaveEdits: () => Promise.resolve(),
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
} as const;

// @ts-expect-error read-only Client Tables reject edit-only operations.
const invalidReadOnlyClientWithSave: BrunoTableClientProps<Order, Columns> = readOnlyClientWithSave;

const nonEditableColumns = [
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Order>;

const invalidClientWithoutEditableColumns = {
  tableId: "orders",
  columns: nonEditableColumns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  editable: true,
  getRowVersion: (row: Order) => row.revision,
  onSaveEdits: () => Promise.resolve(),
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
} as const;

// @ts-expect-error no column exposes editable capability.
const invalidClientWithoutEditableColumnsAssignment: BrunoTableEditingCapability<
  Order,
  typeof nonEditableColumns,
  bigint
> = invalidClientWithoutEditableColumns;
void invalidClientWithoutEditableColumnsAssignment;

// @ts-expect-error the named Client props alias preserves the exact potentially-editable tuple proof.
const invalidNamedClientWithoutEditableColumns: BrunoTableClientProps<
  Order,
  typeof nonEditableColumns,
  bigint
> = invalidClientWithoutEditableColumns;
void invalidNamedClientWithoutEditableColumns;

const editableClientWithGrouping = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  editable: true,
  getRowVersion: (row: Order) => row.revision,
  onSaveEdits: () => Promise.resolve(),
  groupRowsColumn: { headerName: "Rows" },
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
} as const;

// @ts-expect-error editable Client Tables reject grouping even for non-fresh props objects.
const invalidEditableClientWithGrouping: BrunoTableEditingCapability<Order, Columns, bigint> =
  editableClientWithGrouping;

const invalidCrossedSaveCell = {
  columnId: "COL_ID_PRICE",
  field: "symbol",
  before: 1,
  after: 2,
} as const;

// @ts-expect-error a Column Identity is correlated with its exact source field.
const invalidCrossedSaveCellAssignment: BrunoTableSaveCellChange<Order, Columns> =
  invalidCrossedSaveCell;

const widenedColumns: BrunoTableColumns<Order> = columns;
const invalidWidenedSaveCell = {
  columnId: "COL_ID_PRICE",
  field: "price",
  before: "not a number",
  after: "still not a number",
} as const;

// @ts-expect-error widened columns retain field/value correlation for runtime validation.
const invalidWidenedSaveCellAssignment: BrunoTableSaveCellChange<Order, typeof widenedColumns> =
  invalidWidenedSaveCell;

// @ts-expect-error a Save Change Set is never empty.
const invalidEmptySaveChangeSet = [] satisfies BrunoTableSaveChangeSet<Order, Columns, bigint>;

// @ts-expect-error a row Save Cell Change Set is never empty.
const invalidEmptySaveCellChangeSet = [] satisfies BrunoTableSaveChangeSet<
  Order,
  Columns,
  bigint
>[number]["changes"];

const clientWithoutInitialOrderBy = {
  tableId: "orders",
  columns,
  getRowId: (row: Order) => row.id,
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
} as const;

// @ts-expect-error every table requires a non-empty Initial Order By baseline.
const invalidClientWithoutInitialOrderBy: BrunoTableClientProps<Order, Columns> =
  clientWithoutInitialOrderBy;

const serverWithoutInitialOrderBy = {
  tableId: "orders",
  columns,
  viewportSource: orderViewportSource,
} as const;

// @ts-expect-error every Server Table requires a non-empty Initial Order By baseline.
const invalidServerWithoutInitialOrderBy: BrunoTableServerProps<
  Order,
  Columns,
  typeof orderViewportSource.viewport
> = serverWithoutInitialOrderBy;
void invalidServerWithoutInitialOrderBy;

// @ts-expect-error exported Common props also require a non-empty Initial Order By baseline.
const invalidCommonWithoutInitialOrderBy: BrunoTableCommonProps<Order, Columns> = {
  tableId: "orders",
  columns,
};
void invalidCommonWithoutInitialOrderBy;

const invalidInitialOrderByWithoutSortingCapability = {
  tableId: "unsortable-orders",
  columns: noSortingColumns,
  // @ts-expect-error every table requires a sortable Column Identity for Initial Order By.
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
} satisfies BrunoTableClientProps<Order, NoSortingColumns>;

const invalidServerWithoutSortingCapability = {
  tableId: "unsortable-orders",
  columns: noSortingColumns,
  initialOrderBy: [
    // @ts-expect-error every Server Table requires a sortable Column Identity.
    { columnId: "COL_ID_SYMBOL", direction: "asc" },
  ],
  viewportSource: orderViewportSource,
} satisfies BrunoTableServerProps<Order, NoSortingColumns, typeof orderViewportSource.viewport>;
void invalidServerWithoutSortingCapability;

const invalidCommonWithoutSortingCapability = {
  tableId: "unsortable-orders",
  columns: noSortingColumns,
  initialOrderBy: [
    // @ts-expect-error public Common props reject definitions without a sortable Column Identity.
    { columnId: "COL_ID_SYMBOL", direction: "asc" },
  ],
} satisfies BrunoTableCommonProps<Order, NoSortingColumns>;
void invalidCommonWithoutSortingCapability;

const invalidNumberHelperField = [
  BrunoTableNumberColumn({
    columnId: "COL_ID_SYMBOL",
    // @ts-expect-error the Number helper cannot target a string field.
    field: "symbol",
    headerName: "Symbol",
  }),
] satisfies BrunoTableColumns<HelperRow>;

const invalidHelperWithoutColumnId = [
  // @ts-expect-error every helper invocation still requires an explicit Column Identity.
  BrunoTableTextColumn({ field: "symbol", headerName: "Symbol" }),
] satisfies BrunoTableColumns<HelperRow>;

const invalidIdentityPreset = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  // @ts-expect-error a reusable preset can never own Column Identity.
  columnId: "COL_ID_PRICE",
});

const invalidFieldPreset = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  // @ts-expect-error a reusable preset can never own server field mapping.
  field: "price",
});

const invalidValueTypePreset = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  // @ts-expect-error a reusable preset cannot replace a helper's exact Value Type.
  valueType: "text",
});

const invalidUnknownPresetOption = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  // @ts-expect-error presets reject configuration outside their explicit surface.
  mysteryOption: true,
});

const strictPricePreset = BrunoTableNumberColumn.withDefaults({ headerName: "Price" });
const invalidPresetInvocationWithoutColumnId = strictPricePreset({
  // @ts-expect-error the final preset invocation still requires Column Identity.
  field: "price",
});

const invalidNumberHelperValueType = BrunoTableNumberColumn({
  columnId: "COL_ID_PRICE",
  // @ts-expect-error a Number helper cannot be changed into another Value Type.
  field: "price",
  headerName: "Price",
  valueType: "text",
});

const narrowPriceFormatter = ({
  row,
  value,
}: {
  readonly row: HelperRow & { readonly secret: string };
  readonly value: number;
}) => `${row.secret}:${value}`;

const invalidNarrowPresentationCallback = [
  // @ts-expect-error BrunoTable may pass any HelperRow, not a narrower row subtype.
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: "number",
    valueFormatter: narrowPriceFormatter,
  },
] satisfies BrunoTableColumns<HelperRow>;

type MixedAmountRow = { readonly amount: ExactAmount | { readonly major: number } };
const invalidNarrowCustomValueType = [
  // @ts-expect-error a custom Value Type must accept the field's complete exact value domain.
  {
    columnId: "COL_ID_AMOUNT",
    field: "amount",
    headerName: "Amount",
    valueType: exactAmountValueType,
  },
] satisfies BrunoTableColumns<MixedAmountRow>;

const invalidHelperComputedDependency = [
  BrunoTableNumberColumn({
    columnId: "COL_ID_WEIGHTED_PRICE",
    fields: ["price", "multiplier"],
    headerName: "Weighted price",
    valueGetter: ({ row }) => {
      // @ts-expect-error only declared dependencies exist in a Computed getter row.
      void row.status;
      return row.price * row.multiplier;
    },
  }),
] satisfies BrunoTableColumns<HelperRow>;

const invalidCustomComputedDependency = [
  BrunoTableComputedColumn({
    columnId: "COL_ID_AMOUNT_COPY",
    fields: ["amount"],
    headerName: "Amount copy",
    valueType: exactAmountValueType,
    valueGetter: ({ row }) => {
      // @ts-expect-error custom Computed Columns expose only declared dependencies.
      void row.otherAmount;
      return row.amount;
    },
  }),
] satisfies BrunoTableColumns<AmountRow>;

const invalidIncompleteSelectDomain = [
  BrunoTableSelectColumn({
    columnId: "COL_ID_STATUS",
    // @ts-expect-error Select options must cover the field's exact non-nullish value domain.
    field: "status",
    headerName: "Status",
    options: ["open"],
  }),
] satisfies BrunoTableColumns<HelperRow>;

const invalidCustomNumericOperand = [
  // @ts-expect-error a custom numeric Value Type retains its exact operand domain.
  { columnId: "COL_ID_AMOUNT", type: "greaterThan", filter: 10 },
] satisfies BrunoTableFilterExpressions<AmountRow, typeof customValueColumns>;

type NullableEditRow = Readonly<{
  readonly id: string;
  readonly nullable: number | null;
  readonly optional: number | undefined;
  readonly ambiguous: number | null | undefined;
  readonly required: number;
}>;
const nullableEditColumns = [
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
    columnId: "COL_ID_AMBIGUOUS",
    field: "ambiguous",
    headerName: "Ambiguous",
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
] satisfies BrunoTableColumns<NullableEditRow>;

type NullableChoiceEditRow = Readonly<{
  readonly id: string;
  readonly flag: boolean | null;
  readonly nullableChoice: "" | "ready" | null;
  readonly requiredChoice: "" | "ready";
}>;
const nullableChoiceEditColumns = [
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
] satisfies BrunoTableColumns<NullableChoiceEditRow>;
void nullableChoiceEditColumns;
const invalidNullableEditColumns = [
  // @ts-expect-error editable nullable fields require their exact blank representation.
  {
    columnId: "COL_ID_NULLABLE",
    field: "nullable",
    headerName: "Nullable",
    valueType: "number",
    isEditable: true,
    blankValue: undefined,
  },
  // @ts-expect-error non-nullish fields cannot declare a blank representation.
  {
    columnId: "COL_ID_REQUIRED",
    field: "required",
    headerName: "Required",
    valueType: "number",
    isEditable: true,
    blankValue: null,
  },
] satisfies BrunoTableColumns<NullableEditRow>;
const invalidMissingNullableBlankColumns = [
  // @ts-expect-error editable null fields require an explicit blank representation.
  {
    columnId: "COL_ID_NULLABLE",
    field: "nullable",
    headerName: "Nullable",
    valueType: "number",
    isEditable: true,
  },
  // @ts-expect-error editable undefined fields require an explicit blank representation.
  {
    columnId: "COL_ID_OPTIONAL",
    field: "optional",
    headerName: "Optional",
    valueType: "number",
    isEditable: true,
  },
  // @ts-expect-error ambiguous nullish fields require an explicit consumer choice.
  {
    columnId: "COL_ID_AMBIGUOUS",
    field: "ambiguous",
    headerName: "Ambiguous",
    valueType: "number",
    isEditable: true,
  },
] satisfies BrunoTableColumns<NullableEditRow>;
const invalidMissingNullableBlankHelperColumns = [
  BrunoTableNumberColumn({
    columnId: "COL_ID_NULLABLE",
    // @ts-expect-error Number Helper cannot infer a nullable editable field without blankValue.
    field: "nullable",
    headerName: "Nullable",
    // @ts-expect-error Number Helper rejects nullable editability without blankValue.
    isEditable: true,
  }),
  BrunoTableNumberColumn({
    columnId: "COL_ID_OPTIONAL",
    // @ts-expect-error Number Helper cannot infer an optional editable field without blankValue.
    field: "optional",
    headerName: "Optional",
    // @ts-expect-error Number Helper rejects optional editability without blankValue.
    isEditable: true,
  }),
  BrunoTableNumberColumn({
    columnId: "COL_ID_AMBIGUOUS",
    // @ts-expect-error Number Helper cannot infer an ambiguous editable field without blankValue.
    field: "ambiguous",
    headerName: "Ambiguous",
    // @ts-expect-error Number Helper rejects ambiguous editability without blankValue.
    isEditable: true,
  }),
] satisfies BrunoTableColumns<NullableEditRow>;
const invalidStaticFalseBlankColumns = [
  // @ts-expect-error literal static-false editability cannot declare an edit blank policy.
  {
    columnId: "COL_ID_NULLABLE",
    field: "nullable",
    headerName: "Nullable",
    valueType: "number",
    isEditable: false,
    blankValue: null,
  },
] satisfies BrunoTableColumns<NullableEditRow>;
const invalidStaticFalseBlankHelperColumns = [
  BrunoTableNumberColumn({
    columnId: "COL_ID_NULLABLE",
    // @ts-expect-error Column Helpers cannot infer a compatible field for this invalid capability.
    field: "nullable",
    headerName: "Nullable",
    // @ts-expect-error Column Helpers reject literal static-false editability with blank policy.
    isEditable: false,
    // @ts-expect-error Column Helpers reject a blank policy without potential editability.
    blankValue: null,
  }),
] satisfies BrunoTableColumns<NullableEditRow>;
const widenedEditablePolicy: boolean = Math.random() > 0.5;
const widenedRequiredEditColumns = [
  {
    columnId: "COL_ID_REQUIRED",
    field: "required",
    headerName: "Required",
    valueType: "number",
    isEditable: widenedEditablePolicy,
  },
] as const satisfies BrunoTableColumns<NullableEditRow>;
const widenedOnlyEditableClientProps = {
  tableId: "widened-only-editability",
  columns: widenedRequiredEditColumns,
  initialOrderBy: [{ columnId: "COL_ID_REQUIRED", direction: "asc" }],
  getRowId: (row: NullableEditRow) => row.id,
  editable: true,
  getRowVersion: () => 1n,
  onSaveEdits: () => Promise.resolve(),
  clientSource: { rows: [], totalRows: 0, version: 1, status: "ready" },
} as const;
// @ts-expect-error widened boolean alone cannot prove the Table-level editable capability.
const invalidWidenedOnlyEditableClient: BrunoTableClientProps<
  NullableEditRow,
  typeof widenedRequiredEditColumns,
  bigint
> = widenedOnlyEditableClientProps;
const invalidWidenedNullableEditColumns = [
  // @ts-expect-error nullable widened booleans cannot choose an exact blank representation.
  {
    columnId: "COL_ID_NULLABLE",
    field: "nullable",
    headerName: "Nullable",
    valueType: "number",
    isEditable: widenedEditablePolicy,
  },
  // @ts-expect-error nullable widened booleans cannot safely pair with blankValue in plain arrays.
  {
    columnId: "COL_ID_OPTIONAL",
    field: "optional",
    headerName: "Optional",
    valueType: "number",
    isEditable: widenedEditablePolicy,
    blankValue: undefined,
  },
] satisfies BrunoTableColumns<NullableEditRow>;

type ExactToggle = "N" | "Y";
const exactToggleValueType = {
  codecId: "example/toggle",
  codecVersion: 1,
  filterFamily: "equality",
  editorFamily: "boolean",
  booleanEditorValues: ["N", "Y"],
  cellAlign: "center",
  editorLayout: "center",
  defaultWidth: 88,
  decodeRuntime: (input: unknown) =>
    input === "N" || input === "Y"
      ? { _tag: "Success" as const, value: input }
      : { _tag: "Failure" as const, message: "Expected N or Y." },
  equivalent: (left: ExactToggle, right: ExactToggle) => left === right,
  compare: (left: ExactToggle, right: ExactToggle) => (left === right ? 0 : left === "N" ? -1 : 1),
  formatCanonicalText: (value: ExactToggle) => value,
  parseCanonicalText: (text: string) =>
    text === "N" || text === "Y"
      ? { _tag: "Success" as const, value: text }
      : { _tag: "Failure" as const, message: "Expected N or Y." },
  formatDisplay: (value: ExactToggle) => value,
  encodePersisted: (value: ExactToggle) => value,
  decodePersisted: (input: unknown) =>
    input === "N" || input === "Y"
      ? { _tag: "Success" as const, value: input }
      : { _tag: "Failure" as const, message: "Expected N or Y." },
} satisfies BrunoTableValueType<ExactToggle, "equality", "boolean">;
const { booleanEditorValues: omittedToggleEditorValues, ...toggleWithoutEditorValues } =
  exactToggleValueType;
void omittedToggleEditorValues;
// @ts-expect-error custom Boolean editors require an exact false/true domain mapping.
const invalidToggleValueType: BrunoTableValueType<ExactToggle, "equality", "boolean"> =
  toggleWithoutEditorValues;

void invalidColumnIds;
void invalidField;
void ambiguousColumn;
void missingHeaderName;
void invalidValueType;
void invalidCapabilityFlags;
void invalidComputedDependency;
void invalidEmptyComputedDependencies;
void invalidNumericFilter;
void invalidNumericSensitivity;
void invalidBooleanSensitivity;
void acceptedBooleanSetFilter;
void acceptedSelectSetFilter;
void invalidDefaultTextSetFilter;
void invalidDefaultNumberSetFilter;
void invalidSetFilterCapability;
void invalidEmptyInFilter;
void acceptedTextInFilter;
void acceptedNumericInFilter;
void invalidComputedFilter;
void invalidOptedOutFilter;
void invalidMixedColumnCompoundFilter;
void invalidSort;
void invalidOptedOutSort;
void invalidNoCapabilitySort;
void invalidEmptySort;
void invalidPaginatedClient;
void invalidPaginatedServer;
void invalidClientWithoutRowId;
void invalidServerWithRowId;
void invalidServerEditing;
void invalidEditableClientWithoutSave;
void invalidReadOnlyClientWithSave;
void invalidClientWithoutEditableColumns;
void invalidEditableClientWithGrouping;
void invalidCrossedSaveCell;
void invalidCrossedSaveCellAssignment;
void invalidWidenedSaveCell;
void invalidWidenedSaveCellAssignment;
void invalidEmptySaveChangeSet;
void invalidEmptySaveCellChangeSet;
void invalidClientWithoutInitialOrderBy;
void invalidInitialOrderByWithoutSortingCapability;
void invalidNumberHelperField;
void invalidHelperWithoutColumnId;
void invalidIdentityPreset;
void invalidFieldPreset;
void invalidValueTypePreset;
void invalidUnknownPresetOption;
void invalidPresetInvocationWithoutColumnId;
void invalidNumberHelperValueType;
void invalidNarrowPresentationCallback;
void invalidNarrowCustomValueType;
void invalidHelperComputedDependency;
void invalidCustomComputedDependency;
void invalidIncompleteSelectDomain;
void invalidCustomNumericOperand;
void nullableEditColumns;
void invalidNullableEditColumns;
void invalidStaticFalseBlankColumns;
void invalidStaticFalseBlankHelperColumns;
void widenedRequiredEditColumns;
void invalidWidenedOnlyEditableClient;
void invalidWidenedNullableEditColumns;
void invalidMissingNullableBlankColumns;
void invalidMissingNullableBlankHelperColumns;
void exactToggleValueType;
void invalidToggleValueType;
