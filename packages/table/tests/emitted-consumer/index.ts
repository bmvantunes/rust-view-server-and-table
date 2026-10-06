import { Schema } from "effect";
import { ViewServerId, defineViewServerConfig } from "effect-view-server/config";
import { createViewServerReact } from "effect-view-server/react";
import { SourceAdapter } from "effect-view-server/source-adapter";
import type {
  LiveQueryViewportBaseRow,
  LiveQueryViewportCompleteRawSelect,
  LiveQueryViewportWhere,
} from "effect-view-server/react/viewport-base-row";
import {
  BrunoTableBigIntColumn,
  BrunoTableBooleanColumn,
  BrunoTableClient,
  BrunoTableActiveFilterCount,
  BrunoTableActiveSortCount,
  BrunoTableAggregateAlgebra,
  BrunoTableComputedColumn,
  BrunoTableFilterControl,
  BrunoTableLoadedRowCount,
  BrunoTableQuickFilter,
  BrunoTableResultRowCount,
  BrunoTableNumberColumn,
  BrunoTableSelectColumn,
  BrunoTableServer,
  BrunoTableTextColumn,
  BrunoTableToolbar,
  type BrunoTableBuiltInValueType,
  type BrunoTableAggregateAlgebra as BrunoTableAggregateAlgebraType,
  type BrunoTableAggregateResults,
  type BrunoTableClientProps,
  type BrunoTableCommonProps,
  type BrunoTableColumnField,
  type BrunoTableColumnId,
  type BrunoTableColumnValue,
  type BrunoTableColumns,
  type BrunoTableDecodeResult,
  type BrunoTableEditRowPatch,
  type BrunoTableEditRowProjectorInput,
  type BrunoTableFilterableColumnId,
  type BrunoTableGridFilterCommandCapability,
  type BrunoTableFilterExpressions,
  type BrunoTablePersistedState,
  type BrunoTableQuickFilterField,
  type BrunoTableQuickFilterFields,
  type BrunoTableGroupKeyCellParams,
  type BrunoTableGroupKeyPresence,
  type BrunoTableGroupRowsColumnOptions,
  type BrunoTableSaveCellChange,
  type BrunoTableSaveChangeSet,
  type BrunoTableServerProps,
  type BrunoTableSortableColumnId,
  type BrunoTableSortBy,
  type BrunoTableValueType,
} from "@bruno/table";
import type { LiveQueryResult } from "effect-view-server/config/query";

type Equal<TLeft, TRight> =
  (<TValue>() => TValue extends TLeft ? 1 : 2) extends <TValue>() => TValue extends TRight ? 1 : 2
    ? true
    : false;

type Expect<TValue extends true> = TValue;

// @ts-expect-error Select editor option provenance is supplied only by BrunoTableSelectColumn.
type EmittedUnsupportedCustomSelect = BrunoTableValueType<string, "select", "select">;
void (0 as unknown as EmittedUnsupportedCustomSelect);

type ExactMoney = Readonly<{ readonly minorUnits: bigint }>;
const emittedExactMoneyAlgebra = BrunoTableAggregateAlgebra<ExactMoney>({
  add: (left, right) => ({ minorUnits: left.minorUnits + right.minorUnits }),
  divideByCount: (total, count) => ({ minorUnits: total.minorUnits / count }),
});
const emittedExactMoneyAlgebraType: BrunoTableAggregateAlgebraType<ExactMoney> =
  emittedExactMoneyAlgebra;
void emittedExactMoneyAlgebraType;

const emittedExactMoneyValueType = {
  codecId: "emitted/exact-money",
  codecVersion: 1,
  filterFamily: "numeric",
  editorFamily: "text",
  cellAlign: "end",
  editorLayout: "inline",
  defaultWidth: 120,
  aggregateResults: { sum: "self", avg: "self" },
  aggregateAlgebra: emittedExactMoneyAlgebra,
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
  { readonly sum: "self"; readonly avg: "self" }
>;
void emittedExactMoneyValueType;

const emittedAddOnlyAlgebra = BrunoTableAggregateAlgebra<ExactMoney>({
  add: (left, right) => ({ minorUnits: left.minorUnits + right.minorUnits }),
});
const emittedAverageWithoutDivision = {
  ...emittedExactMoneyValueType,
  aggregateResults: { avg: "self" as const },
  aggregateAlgebra: emittedAddOnlyAlgebra,
};
// @ts-expect-error Advertising avg requires exact addition and division by bigint count.
const emittedInvalidAverageWithoutDivision: BrunoTableValueType<
  ExactMoney,
  "numeric",
  "text",
  { readonly avg: "self" }
> = emittedAverageWithoutDivision;
void emittedInvalidAverageWithoutDivision;

const {
  aggregateResults: emittedAggregateResults,
  aggregateAlgebra: emittedAggregateAlgebra,
  ...emittedExactMoneyValueTypeBase
} = emittedExactMoneyValueType;
void emittedAggregateResults;
void emittedAggregateAlgebra;
const emittedNonArithmeticSingleGeneric = {
  ...emittedExactMoneyValueTypeBase,
  aggregateResults: { countDistinct: "bigint", min: "self", max: "self" } as const,
} satisfies BrunoTableValueType<ExactMoney>;
void emittedNonArithmeticSingleGeneric;
const emittedArithmeticSingleGeneric = {
  ...emittedExactMoneyValueTypeBase,
  aggregateResults: { sum: "self", avg: "self" } as const,
  aggregateAlgebra: emittedExactMoneyAlgebra,
} satisfies BrunoTableValueType<ExactMoney>;
void emittedArithmeticSingleGeneric;
const emittedSingleGenericSumWithoutAlgebra = {
  ...emittedExactMoneyValueTypeBase,
  aggregateResults: { sum: "self" as const },
};
// @ts-expect-error Emitted single-generic Value Types require exact addition for sum.
const emittedInvalidSingleGenericSum: BrunoTableValueType<ExactMoney> =
  emittedSingleGenericSumWithoutAlgebra;
void emittedInvalidSingleGenericSum;
const emittedSingleGenericAverageWithoutDivision = {
  ...emittedExactMoneyValueTypeBase,
  aggregateResults: { avg: "self" as const },
  aggregateAlgebra: emittedAddOnlyAlgebra,
};
// @ts-expect-error Emitted single-generic Value Types require exact division for avg.
const emittedInvalidSingleGenericAverage: BrunoTableValueType<ExactMoney> =
  emittedSingleGenericAverageWithoutDivision;
void emittedInvalidSingleGenericAverage;

const emittedInvalidAggregateResultPair = {
  // @ts-expect-error countDistinct always produces bigint.
  countDistinct: "self",
} satisfies BrunoTableAggregateResults;
void emittedInvalidAggregateResultPair;

BrunoTableAggregateAlgebra<ExactMoney>({
  // @ts-expect-error Exact arithmetic cannot return a different domain.
  add: (left, right): bigint => left.minorUnits + right.minorUnits,
});

const emittedWhitespaceColumnIdRejected: Expect<Equal<BrunoTableColumnId<"COL_ID_A B">, never>> =
  true;
void emittedWhitespaceColumnIdRejected;
const emittedReservedColumnIdRejected: Expect<
  Equal<BrunoTableColumnId<"COL_ID_BRUNO_TABLE_ROWS">, never>
> = true;
void emittedReservedColumnIdRejected;
const emittedSelectionReservedColumnIdRejected: Expect<
  Equal<BrunoTableColumnId<"COL_ID_BRUNO_TABLE_ROW_SELECTION">, never>
> = true;
void emittedSelectionReservedColumnIdRejected;

type Order = {
  readonly id: string;
  readonly symbol: string;
  readonly price: number;
  readonly quantity: bigint;
  readonly revision: bigint;
  readonly active: boolean;
  readonly status: "open" | "closed";
  readonly multiplier: number;
  readonly hiddenLabel: string;
};

type EmittedNullableEditRow = Readonly<{
  readonly id: string;
  readonly nullable: number | null;
  readonly optional: number | undefined;
  readonly ambiguous: number | null | undefined;
  readonly required: number;
}>;

const emittedNullableEditColumns = [
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
] satisfies BrunoTableColumns<EmittedNullableEditRow>;
void emittedNullableEditColumns;

type EmittedNullableChoiceEditRow = Readonly<{
  readonly id: string;
  readonly flag: boolean | null;
  readonly nullableChoice: "" | "ready" | null;
  readonly requiredChoice: "" | "ready";
}>;
const emittedNullableChoiceEditColumns = [
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
] satisfies BrunoTableColumns<EmittedNullableChoiceEditRow>;
void emittedNullableChoiceEditColumns;

const emittedInvalidNullableEditColumns = [
  // @ts-expect-error emitted nullable fields require their exact blank representation.
  {
    columnId: "COL_ID_NULLABLE",
    field: "nullable",
    headerName: "Nullable",
    valueType: "number",
    isEditable: true,
    blankValue: undefined,
  },
  // @ts-expect-error emitted non-nullish fields reject a blank representation.
  {
    columnId: "COL_ID_REQUIRED",
    field: "required",
    headerName: "Required",
    valueType: "number",
    isEditable: true,
    blankValue: null,
  },
] satisfies BrunoTableColumns<EmittedNullableEditRow>;
void emittedInvalidNullableEditColumns;

const emittedInvalidMissingNullableBlankColumns = [
  // @ts-expect-error emitted editable null fields require blankValue.
  {
    columnId: "COL_ID_NULLABLE",
    field: "nullable",
    headerName: "Nullable",
    valueType: "number",
    isEditable: true,
  },
  // @ts-expect-error emitted editable undefined fields require blankValue.
  {
    columnId: "COL_ID_OPTIONAL",
    field: "optional",
    headerName: "Optional",
    valueType: "number",
    isEditable: true,
  },
  // @ts-expect-error emitted ambiguous nullish fields require an explicit choice.
  {
    columnId: "COL_ID_AMBIGUOUS",
    field: "ambiguous",
    headerName: "Ambiguous",
    valueType: "number",
    isEditable: true,
  },
] satisfies BrunoTableColumns<EmittedNullableEditRow>;
void emittedInvalidMissingNullableBlankColumns;

const emittedInvalidMissingNullableBlankHelperColumns = [
  BrunoTableNumberColumn({
    columnId: "COL_ID_NULLABLE",
    // @ts-expect-error emitted Helper cannot infer nullable editability without blankValue.
    field: "nullable",
    headerName: "Nullable",
    // @ts-expect-error emitted Helper rejects nullable editability without blankValue.
    isEditable: true,
  }),
  BrunoTableNumberColumn({
    columnId: "COL_ID_OPTIONAL",
    // @ts-expect-error emitted Helper cannot infer optional editability without blankValue.
    field: "optional",
    headerName: "Optional",
    // @ts-expect-error emitted Helper rejects optional editability without blankValue.
    isEditable: true,
  }),
  BrunoTableNumberColumn({
    columnId: "COL_ID_AMBIGUOUS",
    // @ts-expect-error emitted Helper cannot infer ambiguous editability without blankValue.
    field: "ambiguous",
    headerName: "Ambiguous",
    // @ts-expect-error emitted Helper rejects ambiguous editability without blankValue.
    isEditable: true,
  }),
] satisfies BrunoTableColumns<EmittedNullableEditRow>;
void emittedInvalidMissingNullableBlankHelperColumns;

const emittedInvalidStaticFalseBlankColumns = [
  // @ts-expect-error emitted literal static-false editability rejects an edit blank policy.
  {
    columnId: "COL_ID_NULLABLE",
    field: "nullable",
    headerName: "Nullable",
    valueType: "number",
    isEditable: false,
    blankValue: null,
  },
] satisfies BrunoTableColumns<EmittedNullableEditRow>;
void emittedInvalidStaticFalseBlankColumns;
const emittedInvalidStaticFalseBlankHelperColumns = [
  BrunoTableNumberColumn({
    columnId: "COL_ID_NULLABLE",
    // @ts-expect-error emitted Helpers cannot infer a compatible field for this invalid capability.
    field: "nullable",
    headerName: "Nullable",
    // @ts-expect-error emitted Helpers reject literal static-false editability with blank policy.
    isEditable: false,
    // @ts-expect-error emitted Helpers reject a blank policy without potential editability.
    blankValue: null,
  }),
] satisfies BrunoTableColumns<EmittedNullableEditRow>;
void emittedInvalidStaticFalseBlankHelperColumns;
const emittedWidenedEditablePolicy: boolean = Math.random() > 0.5;
const emittedWidenedRequiredEditColumns = [
  {
    columnId: "COL_ID_REQUIRED",
    field: "required",
    headerName: "Required",
    valueType: "number",
    isEditable: emittedWidenedEditablePolicy,
  },
] as const satisfies BrunoTableColumns<EmittedNullableEditRow>;
void emittedWidenedRequiredEditColumns;
const emittedWidenedOnlyEditableClientProps = {
  tableId: "emitted-widened-only-editability",
  columns: emittedWidenedRequiredEditColumns,
  initialOrderBy: [{ columnId: "COL_ID_REQUIRED", direction: "asc" }],
  getRowId: (row: EmittedNullableEditRow) => row.id,
  editable: true,
  getRowVersion: () => 1n,
  onSaveEdits: () => Promise.resolve(),
  clientSource: { rows: [], totalRows: 0, version: 1, status: "ready" },
} as const;
// @ts-expect-error emitted widened boolean alone cannot prove Table-level edit capability.
const emittedInvalidWidenedOnlyEditableClient: BrunoTableClientProps<
  EmittedNullableEditRow,
  typeof emittedWidenedRequiredEditColumns,
  bigint
> = emittedWidenedOnlyEditableClientProps;
void emittedInvalidWidenedOnlyEditableClient;
const emittedInvalidWidenedNullableEditColumns = [
  // @ts-expect-error emitted nullable widened booleans cannot choose an exact blank representation.
  {
    columnId: "COL_ID_NULLABLE",
    field: "nullable",
    headerName: "Nullable",
    valueType: "number",
    isEditable: emittedWidenedEditablePolicy,
  },
  // @ts-expect-error emitted nullable widened booleans cannot pair safely with blankValue.
  {
    columnId: "COL_ID_OPTIONAL",
    field: "optional",
    headerName: "Optional",
    valueType: "number",
    isEditable: emittedWidenedEditablePolicy,
    blankValue: undefined,
  },
] satisfies BrunoTableColumns<EmittedNullableEditRow>;
void emittedInvalidWidenedNullableEditColumns;

const emittedHelperGroupedColumns = [
  BrunoTableTextColumn({
    columnId: "COL_ID_EMITTED_HELPER_GROUP",
    field: "symbol",
    headerName: "Emitted helper group",
    groupBy: true,
    groupKeyValueFormatter: ({ columnId, field, value }) => {
      const exactColumnId: "COL_ID_EMITTED_HELPER_GROUP" = columnId;
      const exactField: "symbol" = field;
      const exactValue: string = value;
      return `${exactColumnId}:${exactField}:${exactValue}`;
    },
  }),
  BrunoTableNumberColumn({
    columnId: "COL_ID_EMITTED_HELPER_MAX",
    field: "price",
    headerName: "Emitted helper maximum",
    aggFunc: "max",
    aggregateValueFormatter: ({ columnId, field, value }) => {
      const exactColumnId: "COL_ID_EMITTED_HELPER_MAX" = columnId;
      const exactField: "price" = field;
      const exactValue: number = value;
      return `${exactColumnId}:${exactField}:${exactValue.toFixed(2)}`;
    },
  }),
  {
    columnId: "COL_ID_EMITTED_RAW_STATUS",
    field: "status",
    headerName: "Emitted raw status",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Order>;
void emittedHelperGroupedColumns;

type EmittedHostileGroupParams = BrunoTableGroupKeyCellParams<
  string,
  "COL_ID_EMITTED_HOSTILE_GROUP",
  "symbol"
> & { readonly groupKeys: readonly [{ readonly columnId: "COL_ID_EMITTED_RAW_STATUS" }] };
const emittedHostileGroupFormatter = (_parameters: EmittedHostileGroupParams) => "hostile";
const emittedHostileGroupOptions = {
  columnId: "COL_ID_EMITTED_HOSTILE_GROUP",
  field: "symbol",
  headerName: "Emitted hostile group",
  groupBy: true,
  groupKeyValueFormatter: emittedHostileGroupFormatter,
} as const;
// @ts-expect-error Emitted helper callbacks reject sibling Group Key evidence.
BrunoTableTextColumn(emittedHostileGroupOptions);

const emittedSpreadHelperGroupedSource = [
  BrunoTableTextColumn({
    columnId: "COL_ID_EMITTED_HELPER_GROUP",
    field: "symbol",
    headerName: "Emitted helper group",
    groupBy: true,
    groupKeyValueFormatter: ({ value }) => value,
    valueFormatter: ({ row, value }) => `${row.hiddenLabel}:${value}`,
  }),
] satisfies BrunoTableColumns<Order>;
const emittedValidSpreadHelperColumns = [
  { ...emittedSpreadHelperGroupedSource[0]! },
] satisfies BrunoTableColumns<Order>;
void emittedValidSpreadHelperColumns;
const emittedReplacedSpreadHelperColumns = [
  {
    ...emittedSpreadHelperGroupedSource[0]!,
    groupKeyValueFormatter: ({
      columnId,
      value,
    }: BrunoTableGroupKeyCellParams<string, "COL_ID_EMITTED_HELPER_GROUP", "symbol">) => {
      const exactColumnId: "COL_ID_EMITTED_HELPER_GROUP" = columnId;
      const exactValue: string = value;
      void exactColumnId;
      return exactValue;
    },
  },
] satisfies BrunoTableColumns<Order>;
void emittedReplacedSpreadHelperColumns;

type EmittedIncompatibleHelperRow = Readonly<{ readonly unrelated: string }>;
const emittedCrossRowHelperColumns = [emittedSpreadHelperGroupedSource[0]!];
// @ts-expect-error Emitted helper provenance remains tied to the helper's inferred row type.
const emittedInvalidCrossRowHelperColumns: BrunoTableColumns<EmittedIncompatibleHelperRow> =
  emittedCrossRowHelperColumns;
void emittedInvalidCrossRowHelperColumns;
type EmittedIncompatibleHelperValueRow = Readonly<{ readonly symbol: number }>;
// @ts-expect-error Emitted helper provenance retains the source field value domain.
const emittedInvalidCrossValueHelperColumns: BrunoTableColumns<EmittedIncompatibleHelperValueRow> =
  emittedCrossRowHelperColumns;
void emittedInvalidCrossValueHelperColumns;
type EmittedIncompatibleHelperSiblingRow = Readonly<{ readonly symbol: string }>;
// @ts-expect-error Emitted helper raw callbacks retain their inferred sibling-row evidence.
const emittedInvalidCrossSiblingHelperColumns: BrunoTableColumns<EmittedIncompatibleHelperSiblingRow> =
  emittedCrossRowHelperColumns;
void emittedInvalidCrossSiblingHelperColumns;
type EmittedIncompatibleHelperWidenedRow = Omit<Order, "symbol"> &
  Readonly<{ readonly symbol: string | number }>;
// @ts-expect-error Emitted helper provenance is invariant in the inferred row value domain.
const emittedInvalidWidenedHelperColumns: BrunoTableColumns<EmittedIncompatibleHelperWidenedRow> =
  emittedCrossRowHelperColumns;
void emittedInvalidWidenedHelperColumns;
const emittedComputedHelperForOrder = BrunoTableTextColumn({
  columnId: "COL_ID_EMITTED_COMPUTED_HELPER_SYMBOL",
  fields: ["symbol"] as const,
  headerName: "Computed symbol",
  valueGetter: ({ row }: { readonly row: Pick<Order, "symbol"> }) => row.symbol,
});
const emittedInvalidComputedHelperDependencies: BrunoTableColumns<EmittedIncompatibleHelperValueRow> =
  [
    // @ts-expect-error Emitted computed helper dependencies retain exact source value domains.
    emittedComputedHelperForOrder,
  ];
void emittedInvalidComputedHelperDependencies;

const emittedHostileSpreadHelperGroupedColumns = [
  {
    ...emittedSpreadHelperGroupedSource[0]!,
    groupKeyValueFormatter: emittedHostileGroupFormatter,
  },
];
const emittedUnsupportedHostileSpreadHelperColumns: BrunoTableColumns<Order> =
  emittedHostileSpreadHelperGroupedColumns;
void emittedUnsupportedHostileSpreadHelperColumns;

const emittedChangedIdentitySpreadHelperColumns = [
  {
    ...emittedSpreadHelperGroupedSource[0]!,
    columnId: "COL_ID_EMITTED_CHANGED_HELPER_GROUP",
    groupKeyValueFormatter: ({ value }: { readonly value: string }) => value,
  } as const,
] as const satisfies BrunoTableColumns<Order>;
void emittedChangedIdentitySpreadHelperColumns;

const emittedChangedDomainSpreadHelperColumns = [
  {
    ...emittedSpreadHelperGroupedSource[0]!,
    field: "status",
    valueType: "text",
    groupKeyValueFormatter: ({ value }: { readonly value: string }) => value,
  } as const,
] as const satisfies BrunoTableColumns<Order>;
void emittedChangedDomainSpreadHelperColumns;

const emittedUnsupportedInlineFormatter = (
  parameters: BrunoTableGroupKeyCellParams<string, "COL_ID_EMITTED_INLINE_GROUP", "symbol">,
) => parameters.value;
const emittedRawInlineGroupedPresentation = [
  {
    columnId: "COL_ID_EMITTED_INLINE_GROUP",
    field: "symbol",
    headerName: "Emitted inline group",
    valueType: "text",
    groupBy: true,
    groupKeyValueFormatter: emittedUnsupportedInlineFormatter,
  },
] as const;
// @ts-expect-error Emitted raw inline grouped callbacks must use a global Column Helper.
const emittedInvalidRawInlineGroupedPresentation: BrunoTableColumns<Order> =
  emittedRawInlineGroupedPresentation;
void emittedInvalidRawInlineGroupedPresentation;

const emittedHonestRawInlineGroupedPresentation = [
  {
    columnId: "COL_ID_EMITTED_INLINE_BROAD_GROUP",
    field: "symbol",
    headerName: "Emitted inline broad group",
    valueType: "text",
    groupBy: true,
    groupKeyValueFormatter: ({ columnId, value }) => {
      const broadColumnId: BrunoTableColumnId = columnId;
      // @ts-expect-error Emitted raw inline callbacks cannot claim their sibling literal identity.
      const exactColumnId: "COL_ID_EMITTED_INLINE_BROAD_GROUP" = columnId;
      void broadColumnId;
      void exactColumnId;
      return value;
    },
  },
] satisfies BrunoTableColumns<Order>;
void emittedHonestRawInlineGroupedPresentation;

type EmittedOptionalGroupRow = Readonly<{ readonly optional?: string | null }>;
type EmittedExactGroupPresence = Expect<
  Equal<
    BrunoTableGroupKeyPresence<string | null | undefined>,
    | Readonly<{ readonly _tag: "Missing" }>
    | Readonly<{
        readonly _tag: "Present";
        readonly value: string | null | undefined;
      }>
  >
>;
const emittedExactGroupPresence: EmittedExactGroupPresence = true;
void emittedExactGroupPresence;
const emittedOptionalGroupColumns = [
  {
    columnId: "COL_ID_EMITTED_OPTIONAL",
    field: "optional",
    headerName: "Emitted optional",
    valueType: "text",
    groupBy: true,
  },
] as const satisfies BrunoTableColumns<EmittedOptionalGroupRow>;
const emittedExactRowsPresenceCallbacks = {
  valueFormatter: ({ groupKeys }) => {
    const key = groupKeys[0];
    if (key?._tag === "Present") {
      const exactColumnId: "COL_ID_EMITTED_OPTIONAL" = key.columnId;
      const exactField: "optional" = key.field;
      const exactValue: string | null | undefined = key.value;
      return `${exactColumnId}:${exactField}:${String(exactValue)}`;
    }
    if (key?._tag === "Missing") {
      // @ts-expect-error Missing evidence does not fabricate a value.
      void key.value;
    }
    return "Missing";
  },
} satisfies BrunoTableGroupRowsColumnOptions<
  EmittedOptionalGroupRow,
  typeof emittedOptionalGroupColumns
>;
void emittedExactRowsPresenceCallbacks;

const emittedBuiltInAggregateMatrix = [
  {
    columnId: "COL_ID_TEXT_DISTINCT",
    field: "symbol",
    headerName: "Text distinct",
    valueType: "text",
    aggFunc: "countDistinct",
  },
  {
    columnId: "COL_ID_TEXT_MIN",
    field: "symbol",
    headerName: "Text min",
    valueType: "text",
    aggFunc: "min",
  },
  {
    columnId: "COL_ID_TEXT_MAX",
    field: "symbol",
    headerName: "Text max",
    valueType: "text",
    aggFunc: "max",
  },
  {
    columnId: "COL_ID_BOOLEAN_DISTINCT",
    field: "active",
    headerName: "Boolean distinct",
    valueType: "boolean",
    aggFunc: "countDistinct",
  },
  {
    columnId: "COL_ID_BOOLEAN_MIN",
    field: "active",
    headerName: "Boolean min",
    valueType: "boolean",
    aggFunc: "min",
  },
  {
    columnId: "COL_ID_BOOLEAN_MAX",
    field: "active",
    headerName: "Boolean max",
    valueType: "boolean",
    aggFunc: "max",
  },
  {
    columnId: "COL_ID_NUMBER_DISTINCT",
    field: "price",
    headerName: "Number distinct",
    valueType: "number",
    aggFunc: "countDistinct",
  },
  {
    columnId: "COL_ID_NUMBER_MIN",
    field: "price",
    headerName: "Number min",
    valueType: "number",
    aggFunc: "min",
  },
  {
    columnId: "COL_ID_NUMBER_MAX",
    field: "price",
    headerName: "Number max",
    valueType: "number",
    aggFunc: "max",
  },
  {
    columnId: "COL_ID_BIGINT_DISTINCT",
    field: "quantity",
    headerName: "Bigint distinct",
    valueType: "bigint",
    aggFunc: "countDistinct",
  },
  {
    columnId: "COL_ID_BIGINT_SUM",
    field: "quantity",
    headerName: "Bigint sum",
    valueType: "bigint",
    aggFunc: "sum",
  },
  {
    columnId: "COL_ID_BIGINT_MIN",
    field: "quantity",
    headerName: "Bigint min",
    valueType: "bigint",
    aggFunc: "min",
  },
  {
    columnId: "COL_ID_BIGINT_MAX",
    field: "quantity",
    headerName: "Bigint max",
    valueType: "bigint",
    aggFunc: "max",
  },
] as const satisfies BrunoTableColumns<Order>;
void emittedBuiltInAggregateMatrix;

const emittedForbiddenBuiltInAggregates = [
  // @ts-expect-error Emitted declarations reject Client number sum.
  {
    columnId: "COL_ID_NUMBER_SUM",
    field: "price",
    headerName: "Number sum",
    valueType: "number",
    aggFunc: "sum",
  },
  // @ts-expect-error Emitted declarations reject Client number average.
  {
    columnId: "COL_ID_NUMBER_AVG",
    field: "price",
    headerName: "Number average",
    valueType: "number",
    aggFunc: "avg",
  },
  // @ts-expect-error Emitted declarations reject Client bigint average.
  {
    columnId: "COL_ID_BIGINT_AVG",
    field: "quantity",
    headerName: "Bigint average",
    valueType: "bigint",
    aggFunc: "avg",
  },
] as const satisfies BrunoTableColumns<Order>;
void emittedForbiddenBuiltInAggregates;

const emittedServerConfig = defineViewServerConfig({
  topics: {
    orders: {
      schema: Schema.Struct({
        id: ViewServerId,
        symbol: Schema.String,
        price: Schema.Number,
        quantity: Schema.BigInt,
        revision: Schema.BigInt,
        active: Schema.Boolean,
        status: Schema.Literals(["open", "closed"]),
        multiplier: Schema.Number,
        hiddenLabel: Schema.String,
      }),
    },
    positions: {
      schema: Schema.Struct({
        id: ViewServerId,
        symbol: Schema.String,
        price: Schema.Number,
        quantity: Schema.BigInt,
        revision: Schema.BigInt,
        active: Schema.Boolean,
        status: Schema.Literals(["open", "closed"]),
        multiplier: Schema.Number,
        hiddenLabel: Schema.String,
        account: Schema.String,
      }),
    },
  },
});
const emittedServerReact = createViewServerReact(emittedServerConfig);
const source = emittedServerReact.useLiveQueryViewport("orders");
const mismatchedSource = emittedServerReact.useLiveQueryViewport("positions");
const emittedLeasedAdapter = SourceAdapter.make({
  identity: { name: "emitted-bruno-table-route" },
  failure: Schema.Never,
  materialized: undefined,
  leased: {
    metrics: Schema.Struct({ observed: Schema.BigInt }),
    rejectionLocation: Schema.Struct({ offset: Schema.BigInt }),
    definitionOptions: SourceAdapter.definitionOptions<undefined>(),
  },
});
const emittedLeasedSource = createViewServerReact(
  defineViewServerConfig({
    topics: {
      orders: {
        schema: emittedServerConfig.topics.orders.schema,
        source: emittedLeasedAdapter.leasedSource(["status", "revision"], undefined),
      },
    },
  }),
).useLiveQueryViewport("orders");
declare const emittedUnsafeAnyViewport: any;
declare const emittedUnsafeUnknownViewport: unknown;
declare const emittedUnsafeUnwitnessedViewport: Readonly<{ readonly destroy: () => void }>;
declare const emittedUnsafeBroadViewport: Readonly<Record<string, (_row: Order) => Order>>;

const emittedInvalidWhitespaceHelperOptions = {
  columnId: "COL_ID_UNIT PRICE",
  field: "price",
  headerName: "Unit price",
} as const;
const emittedInvalidWhitespaceHelperColumn = [
  // @ts-expect-error Emitted Column Helper declarations reject whitespace identities.
  BrunoTableNumberColumn(emittedInvalidWhitespaceHelperOptions),
] satisfies BrunoTableColumns<Order>;
void emittedInvalidWhitespaceHelperColumn;
const emittedInvalidReservedHelperOptions = {
  columnId: "COL_ID_BRUNO_TABLE_ROWS",
  field: "price",
  headerName: "Rows",
} as const;
const emittedInvalidReservedHelperColumn = [
  // @ts-expect-error Emitted Column Helper declarations reject the reserved Rows identity.
  BrunoTableNumberColumn(emittedInvalidReservedHelperOptions),
] satisfies BrunoTableColumns<Order>;
void emittedInvalidReservedHelperColumn;
const emittedRawSelectionReservedColumns = [
  {
    columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION",
    field: "price",
    headerName: "Selection",
    valueType: "number",
  },
] as const satisfies BrunoTableColumns<Order>;
void BrunoTableClient({
  tableId: "invalid-emitted-selection-reserved-identity",
  // @ts-expect-error Emitted raw columns reject the private Row Selection identity.
  columns: emittedRawSelectionReservedColumns,
  initialOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION", direction: "asc" }],
  getRowId: (row) => row.id,
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
});
const emittedInvalidSelectionReservedHelperOptions = {
  columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION",
  field: "price",
  headerName: "Selection",
} as const;
const emittedInvalidSelectionReservedHelperColumn = [
  // @ts-expect-error Emitted helpers reject the private Row Selection identity.
  BrunoTableNumberColumn(emittedInvalidSelectionReservedHelperOptions),
] satisfies BrunoTableColumns<Order>;
void emittedInvalidSelectionReservedHelperColumn;

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
    isEditable: true,
    valueFormatter: ({ value }) => value.toFixed(2),
  },
  BrunoTableComputedColumn({
    columnId: "COL_ID_DOUBLE_QUANTITY",
    fields: ["quantity"],
    headerName: "Double quantity",
    valueType: "bigint",
    valueGetter: ({ row }) => row.quantity * 2n,
  }),
] satisfies BrunoTableColumns<Order>;

void BrunoTableClient({
  tableId: "invalid-emitted-selection-reserved-initial-order",
  columns,
  // @ts-expect-error Emitted declarations never admit the private Row Selection identity in sorting.
  initialOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION", direction: "asc" }],
  getRowId: (row) => row.id,
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready",
  },
});

type Columns = typeof columns;

const emittedRowAwareEditableColumns = [
  {
    columnId: "COL_ID_EMITTED_ROW_AWARE_SYMBOL",
    field: "symbol",
    headerName: "Projected symbol",
    valueType: "text",
    isEditable: true,
    valueFormatter: ({ row, value }) => `${row.hiddenLabel}:${value}`,
  },
] as const satisfies BrunoTableColumns<Order>;

type EmittedRowAwareEditPatch = BrunoTableEditRowPatch<
  Order,
  typeof emittedRowAwareEditableColumns
>;
const emittedExactEditPatch: EmittedRowAwareEditPatch = { symbol: "AMD" };
void emittedExactEditPatch;
const emittedInvalidEditPatch: EmittedRowAwareEditPatch = {
  // @ts-expect-error Published patches contain only potentially editable fields.
  hiddenLabel: "server-only",
};
void emittedInvalidEditPatch;

const emittedRowAwareClientProps = {
  tableId: "emitted-row-aware-editable-client",
  columns: emittedRowAwareEditableColumns,
  initialOrderBy: [{ columnId: "COL_ID_EMITTED_ROW_AWARE_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  clientSource: { rows: [] as readonly Order[], totalRows: 0, version: 0, status: "ready" },
  editable: true,
  getRowVersion: (row: Order) => row.revision,
  onSaveEdits: () => Promise.resolve(),
} as const;

// @ts-expect-error Published direct calls require the trusted projection seam.
void BrunoTableClient(emittedRowAwareClientProps);
void BrunoTableClient({
  ...emittedRowAwareClientProps,
  projectEditRow: ({
    row,
    patch,
  }: BrunoTableEditRowProjectorInput<Order, typeof emittedRowAwareEditableColumns, bigint>) => ({
    ...row,
    ...patch,
  }),
});

type EmittedViewportBaseRow = Expect<
  Equal<LiveQueryViewportBaseRow<typeof source.viewport>, Order>
>;
const emittedViewportBaseRow: EmittedViewportBaseRow = true;
void emittedViewportBaseRow;
type EmittedCompleteRawSelect = Expect<
  Equal<typeof source.completeRawSelect, LiveQueryViewportCompleteRawSelect<typeof source.viewport>>
>;
const emittedCompleteRawSelect: EmittedCompleteRawSelect = true;
void emittedCompleteRawSelect;

const emittedWitnessedServerProps = {
  tableId: "TABLE_ID_EMITTED_WITNESSED_SERVER",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  viewportSource: source,
  onPersistChange: (state) => {
    const exactState: Expect<Equal<typeof state, BrunoTablePersistedState<Order, Columns, true>>> =
      true;
    void exactState;
  },
} as const satisfies BrunoTableServerProps<Order, Columns, typeof source.viewport>;
BrunoTableServer(emittedWitnessedServerProps);
BrunoTableServer({
  ...emittedWitnessedServerProps,
  externalFilters: [{ field: "quantity", type: "inRange", filter: 1n, filterTo: 10n }],
});
BrunoTableServer({
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  routeBy: { status: "open", revision: 1n },
});
const emittedAnnotatedLeasedProps: BrunoTableServerProps<
  Order,
  Columns,
  typeof emittedLeasedSource.viewport
> = {
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  routeBy: { status: "open", revision: 1n },
  externalFilters: [{ field: "quantity", type: "inRange", filter: 1n, filterTo: 10n }],
};
void emittedAnnotatedLeasedProps;
// @ts-expect-error emitted Server Props expose exactly Row, Columns, and Viewport generics.
type InvalidEmittedServerRouteOverride = BrunoTableServerProps<
  Order,
  Columns,
  typeof emittedLeasedSource.viewport,
  never
>;
const invalidEmittedServerRouteOverride = null as unknown as InvalidEmittedServerRouteOverride;
void invalidEmittedServerRouteOverride;
void BrunoTableServer<
  // @ts-expect-error emitted Server component exposes no Route/Where override generic.
  typeof emittedLeasedSource.viewport,
  Columns,
  typeof emittedAnnotatedLeasedProps,
  never
>;
// @ts-expect-error the emitted direct three-generic leased Props alias requires Feed Route.
const emittedAnnotatedMissingRoute: BrunoTableServerProps<
  Order,
  Columns,
  typeof emittedLeasedSource.viewport
> = { ...emittedWitnessedServerProps, viewportSource: emittedLeasedSource };
void emittedAnnotatedMissingRoute;
const emittedAnnotatedMissingRouteField: BrunoTableServerProps<
  Order,
  Columns,
  typeof emittedLeasedSource.viewport
> = {
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  // @ts-expect-error emitted direct alias requires every Route field.
  routeBy: { status: "open" },
};
void emittedAnnotatedMissingRouteField;
const emittedAnnotatedExtraRouteField: BrunoTableServerProps<
  Order,
  Columns,
  typeof emittedLeasedSource.viewport
> = {
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  // @ts-expect-error emitted direct alias rejects extra Route fields.
  routeBy: { status: "open", revision: 1n, desk: "rates" },
};
void emittedAnnotatedExtraRouteField;
const emittedAnnotatedWrongRouteValue: BrunoTableServerProps<
  Order,
  Columns,
  typeof emittedLeasedSource.viewport
> = {
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  // @ts-expect-error emitted direct alias preserves exact Route values.
  routeBy: { status: "open", revision: 1 },
};
void emittedAnnotatedWrongRouteValue;
const emittedAnnotatedWrongExternalField: BrunoTableServerProps<
  Order,
  Columns,
  typeof emittedLeasedSource.viewport
> = {
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  routeBy: { status: "open", revision: 1n },
  // @ts-expect-error emitted direct alias rejects unknown External Filter fields.
  externalFilters: [{ field: "missing", type: "equals", filter: "open" }],
};
void emittedAnnotatedWrongExternalField;
const emittedAnnotatedWrongExternalOperand: BrunoTableServerProps<
  Order,
  Columns,
  typeof emittedLeasedSource.viewport
> = {
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  routeBy: { status: "open", revision: 1n },
  // @ts-expect-error emitted direct alias preserves exact operand domains.
  externalFilters: [{ field: "quantity", type: "equals", filter: 1 }],
};
void emittedAnnotatedWrongExternalOperand;
const emittedAnnotatedMixedExternalRange: BrunoTableServerProps<
  Order,
  Columns,
  typeof emittedLeasedSource.viewport
> = {
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  routeBy: { status: "open", revision: 1n },
  // @ts-expect-error emitted direct alias keeps both bigint range bounds exact.
  externalFilters: [{ field: "quantity", type: "inRange", filter: 1n, filterTo: 10 }],
};
void emittedAnnotatedMixedExternalRange;
const emittedAnnotatedMaterializedRoute: BrunoTableServerProps<
  Order,
  Columns,
  typeof source.viewport
> = {
  ...emittedWitnessedServerProps,
  // @ts-expect-error emitted direct source-free alias forbids Feed Route.
  routeBy: { status: "open" },
};
void emittedAnnotatedMaterializedRoute;
// @ts-expect-error emitted leased Server declarations require the exact Route tuple.
BrunoTableServer({ ...emittedWitnessedServerProps, viewportSource: emittedLeasedSource });
BrunoTableServer({
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  // @ts-expect-error emitted leased Server declarations reject missing Route fields.
  routeBy: { status: "open" },
});
BrunoTableServer({
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  // @ts-expect-error emitted leased Server declarations preserve exact Route value domains.
  routeBy: { status: "open", revision: 1 },
});
BrunoTableServer({
  ...emittedWitnessedServerProps,
  viewportSource: emittedLeasedSource,
  // @ts-expect-error emitted leased Server declarations reject extra Route fields.
  routeBy: { status: "open", revision: 1n, desk: "rates" },
});
BrunoTableServer({
  ...emittedWitnessedServerProps,
  // @ts-expect-error emitted External Filters reject unknown source fields.
  externalFilters: [{ field: "missing", type: "equals", filter: "open" }],
});
BrunoTableServer({
  ...emittedWitnessedServerProps,
  // @ts-expect-error emitted External Filters preserve exact known-field operand domains.
  externalFilters: [{ field: "quantity", type: "equals", filter: 1 }],
});
BrunoTableServer({
  ...emittedWitnessedServerProps,
  // @ts-expect-error emitted inRange bounds preserve one exact bigint operand domain.
  externalFilters: [{ field: "quantity", type: "inRange", filter: 1n, filterTo: 10 }],
});

const emittedMismatchedServerProps: BrunoTableServerProps<
  Order,
  Columns,
  typeof mismatchedSource.viewport
> = {
  ...emittedWitnessedServerProps,
  // @ts-expect-error emitted Props reject a different invariant base row, including extensions.
  viewportSource: mismatchedSource,
};
void emittedMismatchedServerProps;

const emittedAnySource = { ...source, viewport: emittedUnsafeAnyViewport };
// @ts-expect-error any erases the emitted authoritative viewport base-row witness.
BrunoTableServer({ ...emittedWitnessedServerProps, viewportSource: emittedAnySource });

const emittedUnknownSource = { ...source, viewport: emittedUnsafeUnknownViewport };
// @ts-expect-error unknown erases the emitted authoritative viewport base-row witness.
BrunoTableServer({ ...emittedWitnessedServerProps, viewportSource: emittedUnknownSource });

const emittedUnwitnessedSource = { ...source, viewport: emittedUnsafeUnwitnessedViewport };
// @ts-expect-error unwitnessed shapes cannot establish the emitted Server base row.
BrunoTableServer({ ...emittedWitnessedServerProps, viewportSource: emittedUnwitnessedSource });

const emittedBroadSource = { ...source, viewport: emittedUnsafeBroadViewport };
// @ts-expect-error broad dictionaries cannot impersonate the bundled source-owned witness.
BrunoTableServer({ ...emittedWitnessedServerProps, viewportSource: emittedBroadSource });

type EmittedRawOnlyViewport = Omit<typeof source.viewport, "semanticKey"> & {
  readonly semanticKey: (query: {
    readonly select: typeof source.completeRawSelect;
    readonly where: LiveQueryViewportWhere<typeof source.viewport>;
    readonly orderBy: readonly [];
  }) => unknown;
};
const emittedRawOnlySource = {
  ...source,
  viewport: null as unknown as EmittedRawOnlyViewport,
};
// @ts-expect-error emitted Server grouping requires source-owned grouped-query authority.
BrunoTableServer({ ...emittedWitnessedServerProps, viewportSource: emittedRawOnlySource });

type EmittedRawQuery = {
  readonly select: typeof source.completeRawSelect;
  readonly where: LiveQueryViewportWhere<typeof source.viewport>;
  readonly orderBy: readonly [];
};
type EmittedRawOnlyReplaceViewport = Omit<typeof source.viewport, "replace"> & {
  readonly replace: (
    request: Omit<Parameters<typeof source.viewport.replace>[0], "query"> & {
      readonly query: EmittedRawQuery;
    },
  ) => ReturnType<typeof source.viewport.replace>;
};
const emittedRawOnlyReplaceSource = {
  ...source,
  viewport: null as unknown as EmittedRawOnlyReplaceViewport,
};
// @ts-expect-error emitted Server grouping requires source-owned grouped replacement authority.
BrunoTableServer({
  ...emittedWitnessedServerProps,
  viewportSource: emittedRawOnlyReplaceSource,
});

const { completeRawSelect: omittedCompleteRawSelect, ...sourceWithoutCompleteRawSelect } = source;
void omittedCompleteRawSelect;
BrunoTableServer({
  ...emittedWitnessedServerProps,
  // @ts-expect-error emitted Server Sources require the source-owned complete raw projection.
  viewportSource: sourceWithoutCompleteRawSelect,
});

const { useWholeResult: omittedUseWholeResult, ...sourceWithoutWholeResult } = source;
void omittedUseWholeResult;
BrunoTableServer({
  ...emittedWitnessedServerProps,
  // @ts-expect-error emitted Server Sources require the source-owned whole-result facet hook.
  viewportSource: sourceWithoutWholeResult,
});

source.viewport.replace({
  window: { firstRow: 0, lastRow: 9 },
  query: {
    select: source.completeRawSelect,
    where: [],
    orderBy: [{ field: "symbol", direction: "asc" }],
  },
  sink: {
    setRowCount: () => undefined,
    setRowData: (rows) => {
      type EmittedCompleteRow = Expect<Equal<(typeof rows)[number], Order>>;
      const emittedCompleteRow: EmittedCompleteRow = true;
      void emittedCompleteRow;
    },
  },
});

source.viewport.replace({
  window: { firstRow: 0, lastRow: 9 },
  query: {
    groupBy: ["status"],
    aggregates: { rowCount: { aggFunc: "count" } },
    where: [],
    orderBy: [{ aggregate: "rowCount", direction: "desc" }],
  },
  sink: { setRowCount: () => undefined, setRowData: () => undefined },
});
type EmittedGroupedViewportBaseRow = Expect<
  Equal<LiveQueryViewportBaseRow<typeof source.viewport>, Order>
>;
const emittedGroupedViewportBaseRow: EmittedGroupedViewportBaseRow = true;
void emittedGroupedViewportBaseRow;

const emittedClientProps = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  quickFilterFields: ["symbol", "hiddenLabel"],
  getRowId: (row: Order) => row.id,
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 1,
    status: "ready" as const,
  },
} satisfies BrunoTableClientProps<Order, Columns>;
const emittedCallableProps: Parameters<typeof BrunoTableClient<Order, Columns>>[0] =
  emittedClientProps;
const emittedNamedProps: BrunoTableClientProps<Order, Columns> = emittedCallableProps;
void BrunoTableClient(emittedNamedProps);
const emittedPersistedState = {
  version: 1,
  tableId: "TABLE_ID_EMITTED_PREFERENCES",
  filters: [],
  orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "desc" }],
  groupBy: [],
  groupOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" }],
  columnOrder: ["COL_ID_PRICE", "COL_ID_SYMBOL", "COL_ID_DOUBLE_QUANTITY"],
  columnVisibility: { COL_ID_SYMBOL: true },
  columnWidths: { COL_ID_PRICE: 222 },
  columnPinning: { start: ["COL_ID_PRICE"], end: [] },
} as const satisfies BrunoTablePersistedState<Order, Columns>;
void emittedPersistedState;
const emittedInvalidPersistedSelectionWidth = {
  ...emittedPersistedState,
  columnWidths: {
    // @ts-expect-error Emitted declarations keep the private Row Selection width out of preferences.
    COL_ID_BRUNO_TABLE_ROW_SELECTION: 40,
  },
} satisfies BrunoTablePersistedState<Order, Columns>;
void emittedInvalidPersistedSelectionWidth;
const emittedInvalidPersistedSelectionGroupOrder = {
  ...emittedPersistedState,
  groupOrderBy: [
    // @ts-expect-error Emitted declarations keep Row Selection out of grouped sorting.
    { columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION", direction: "asc" },
  ],
} satisfies BrunoTablePersistedState<Order, Columns>;
void emittedInvalidPersistedSelectionGroupOrder;
const emittedPersistedTextSearch = {
  ...emittedPersistedState,
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
void emittedPersistedTextSearch;
const emittedInvalidPersistedTextSearch = {
  ...emittedPersistedTextSearch,
  filters: [
    {
      columnId: "COL_ID_SYMBOL",
      type: "contains",
      codecId: "@bruno/table/text",
      codecVersion: 1,
      // @ts-expect-error Emitted persisted Text searches require raw string operands.
      filter: ["AAPL"],
    },
  ],
} as const satisfies BrunoTablePersistedState<Order, Columns>;
void emittedInvalidPersistedTextSearch;
const emittedInvalidPersistedState = {
  ...emittedPersistedState,
  // @ts-expect-error Emitted persisted identities retain exact tuple autocomplete.
  columnPinning: { start: ["COL_ID_UNKNOWN"], end: [] },
} satisfies BrunoTablePersistedState<Order, Columns>;
void emittedInvalidPersistedState;
const emittedInvalidPersistedFilter = {
  ...emittedPersistedState,
  filters: [
    // @ts-expect-error Emitted persisted filters retain operator-family inference.
    {
      columnId: "COL_ID_PRICE",
      type: "contains",
      codecId: "@bruno/table/number",
      codecVersion: 1,
      filter: { value: "10" },
    },
  ],
} satisfies BrunoTablePersistedState<Order, Columns>;
void emittedInvalidPersistedFilter;
const emittedPersistedProps = {
  ...emittedClientProps,
  initialPersistedState: emittedPersistedState,
  onPersistChange: (state) => {
    const exactState: Expect<Equal<typeof state, BrunoTablePersistedState<Order, Columns, true>>> =
      true;
    void exactState;
  },
} satisfies BrunoTableClientProps<Order, Columns>;
void emittedPersistedProps;
const emittedNonGroupingPersistedState = {
  ...emittedPersistedState,
  groupOrderBy: [],
} as const satisfies BrunoTablePersistedState<Order, Columns, false>;
void emittedNonGroupingPersistedState;
const emittedInvalidNonGroupingGroupBy = {
  ...emittedNonGroupingPersistedState,
  // @ts-expect-error Emitted non-grouping persistence rejects Group By intent.
  groupBy: ["COL_ID_SYMBOL"],
} satisfies BrunoTablePersistedState<Order, Columns, false>;
void emittedInvalidNonGroupingGroupBy;
const emittedInvalidNonGroupingRowsWidth = {
  ...emittedNonGroupingPersistedState,
  columnWidths: {
    // @ts-expect-error Emitted non-grouping persistence rejects the Rows width.
    COL_ID_BRUNO_TABLE_ROWS: 144,
  },
} satisfies BrunoTablePersistedState<Order, Columns, false>;
void emittedInvalidNonGroupingRowsWidth;
const emittedQuickFields = [
  "symbol",
  "hiddenLabel",
] as const satisfies BrunoTableQuickFilterFields<Order>;
type EmittedQuickField = Expect<
  Equal<BrunoTableQuickFilterField<Order>, "id" | "symbol" | "status" | "hiddenLabel">
>;
const emittedQuickFieldCheck: EmittedQuickField = true;
const emittedQuickFilter = BrunoTableQuickFilter;
const emittedResultRowCount = BrunoTableResultRowCount;
const emittedLoadedRowCount = BrunoTableLoadedRowCount;
const emittedActiveFilterCount = BrunoTableActiveFilterCount;
const emittedActiveSortCount = BrunoTableActiveSortCount;
const emittedGridCommands = null as unknown as BrunoTableGridFilterCommandCapability<
  Order,
  typeof columns
>;
emittedGridCommands.clear("COL_ID_SYMBOL");
emittedGridCommands.replace({ columnId: "COL_ID_SYMBOL", type: "contains", filter: "A" });
BrunoTableFilterControl<Order, typeof columns>({
  ownership: "grid",
  children: (commands) => commands.clearAll().toString(),
});
BrunoTableFilterControl({ ownership: "external", children: "Application filter" });
void emittedQuickFieldCheck;
void emittedQuickFields;
void emittedQuickFilter;
void emittedResultRowCount;
void emittedLoadedRowCount;
void emittedActiveFilterCount;
void emittedActiveSortCount;
const emittedInvalidQuickFields = {
  ...emittedClientProps,
  // @ts-expect-error Emitted Quick Filter fields reject numeric source fields.
  quickFilterFields: ["price"],
} satisfies BrunoTableClientProps<Order, Columns>;
void emittedInvalidQuickFields;
const emittedEmptyQuickFields = {
  ...emittedClientProps,
  // @ts-expect-error Emitted Quick Filter fields require a non-empty tuple.
  quickFilterFields: [],
} satisfies BrunoTableClientProps<Order, Columns>;
void emittedEmptyQuickFields;
const emittedMisspelledQuickFields = {
  ...emittedClientProps,
  // @ts-expect-error Emitted Quick Filter fields reject misspelled source fields.
  quickFilterFields: ["descrption"],
} satisfies BrunoTableClientProps<Order, Columns>;
void emittedMisspelledQuickFields;
const emittedColumnIdentityQuickFields = {
  ...emittedClientProps,
  // @ts-expect-error Emitted Quick Filter fields reject Column Identity strings.
  quickFilterFields: ["COL_ID_SYMBOL"],
} satisfies BrunoTableClientProps<Order, Columns>;
void emittedColumnIdentityQuickFields;

const emittedViewServerResult = null as unknown as LiveQueryResult<Order>;
const emittedViewServerClient = BrunoTableClient({
  tableId: "view-server-orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row) => row.id,
  clientSource: emittedViewServerResult,
});
void emittedViewServerClient;

const emittedPriceColumn = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  width: 112,
  format: { minimumFractionDigits: 2 },
});

const emittedStatusColumn = BrunoTableSelectColumn.withDefaults({
  headerName: "Status",
  options: ["open", "closed"],
});

type EmittedPresetEditRow = Readonly<{
  readonly nullable: number | null;
  readonly optional: number | undefined;
  readonly required: number;
  readonly nullableStatus: "open" | "closed" | null;
  readonly requiredStatus: "open" | "closed";
}>;
const invalidEmittedRawValidationColumns = [
  // @ts-expect-error emitted validation is edit-only and requires potential editability.
  {
    columnId: "COL_ID_READ_ONLY_VALIDATE",
    field: "required",
    headerName: "Read-only validate",
    valueType: "number",
    validate: () => undefined,
  },
] satisfies BrunoTableColumns<EmittedPresetEditRow>;
void invalidEmittedRawValidationColumns;
// @ts-expect-error emitted preset validation requires literal true or predicate editability.
BrunoTableNumberColumn.withDefaults({
  validate: () => undefined,
});
const emittedNullableNumberPreset = BrunoTableNumberColumn.withDefaults({
  isEditable: true,
  blankValue: null,
  validate: ({ value }) => (value === undefined ? "Unexpected undefined" : undefined),
});
const emittedPresetEditColumns = [
  emittedNullableNumberPreset({
    columnId: "COL_ID_NULLABLE_PRESET",
    field: "nullable",
    headerName: "Nullable preset",
  }),
] satisfies BrunoTableColumns<EmittedPresetEditRow>;
void emittedPresetEditColumns;
const emittedOptionalPresetEditColumns = [
  emittedNullableNumberPreset({
    columnId: "COL_ID_OPTIONAL_PRESET",
    field: "optional",
    headerName: "Optional preset",
    blankValue: undefined,
  }),
] satisfies BrunoTableColumns<EmittedPresetEditRow>;
void emittedOptionalPresetEditColumns;
const emittedPredicateNumberPreset = BrunoTableNumberColumn.withDefaults({
  isEditable: ({ row, value }) => {
    type RowIsUnknown = Expect<Equal<typeof row, unknown>>;
    type ValueIsExact = Expect<Equal<typeof value, number | null | undefined>>;
    void (null as unknown as RowIsUnknown);
    void (null as unknown as ValueIsExact);
    return value !== undefined;
  },
  blankValue: null,
});
const emittedPredicateNumberColumns = [
  emittedPredicateNumberPreset({
    columnId: "COL_ID_PREDICATE_NUMBER_PRESET",
    field: "nullable",
    headerName: "Predicate Number preset",
  }),
] satisfies BrunoTableColumns<EmittedPresetEditRow>;
void emittedPredicateNumberColumns;
const emittedPredicateSelectPreset = BrunoTableSelectColumn.withDefaults({
  options: ["open", "closed"],
  isEditable: ({ row, value }) => {
    type SelectRowIsUnknown = Expect<Equal<typeof row, unknown>>;
    type SelectValueIsExact = Expect<Equal<typeof value, "open" | "closed" | null | undefined>>;
    void (null as unknown as SelectRowIsUnknown);
    void (null as unknown as SelectValueIsExact);
    return value !== undefined;
  },
  blankValue: null,
});
const emittedPredicateSelectColumns = [
  emittedPredicateSelectPreset({
    columnId: "COL_ID_PREDICATE_SELECT_PRESET",
    field: "nullableStatus",
    headerName: "Predicate Select preset",
  }),
] satisfies BrunoTableColumns<EmittedPresetEditRow>;
void emittedPredicateSelectColumns;
const invalidEmittedRequiredSelectPreset = emittedPredicateSelectPreset({
  columnId: "COL_ID_INVALID_REQUIRED_SELECT_PRESET",
  // @ts-expect-error an inherited null blank policy cannot target a required Select field.
  field: "requiredStatus",
  headerName: "Invalid required Select preset",
});
void invalidEmittedRequiredSelectPreset;
const emittedWidenedEditableDefaults: { readonly isEditable?: boolean } = { isEditable: true };
const emittedWidenedNumberPreset = BrunoTableNumberColumn.withDefaults(
  emittedWidenedEditableDefaults,
);
const invalidEmittedWidenedNullablePreset = emittedWidenedNumberPreset({
  columnId: "COL_ID_WIDENED_NULLABLE_PRESET",
  // @ts-expect-error widened editability may be true, so nullable fields require a blank policy.
  field: "nullable",
  headerName: "Widened nullable preset",
});
void invalidEmittedWidenedNullablePreset;
const invalidEmittedWidenedNullablePresetWithBlank = emittedWidenedNumberPreset({
  columnId: "COL_ID_WIDENED_NULLABLE_PRESET_WITH_BLANK",
  // @ts-expect-error widened editability cannot prove the nullable field capability.
  field: "nullable",
  headerName: "Widened nullable preset with blank",
  // @ts-expect-error a blank policy still requires exact true or predicate editability.
  blankValue: null,
});
void invalidEmittedWidenedNullablePresetWithBlank;
const validEmittedWidenedRequiredPreset = [
  emittedWidenedNumberPreset({
    columnId: "COL_ID_WIDENED_REQUIRED_PRESET",
    field: "required",
    headerName: "Widened required preset",
  }),
] satisfies BrunoTableColumns<EmittedPresetEditRow>;
void validEmittedWidenedRequiredPreset;
const emittedComputedFromEditPresetColumns = [
  emittedNullableNumberPreset({
    columnId: "COL_ID_COMPUTED_PRESET",
    fields: ["required"],
    headerName: "Computed preset",
    valueGetter: ({ row }) => row.required,
  }),
] satisfies BrunoTableColumns<EmittedPresetEditRow>;
const emittedComputedFromEditPreset = emittedComputedFromEditPresetColumns[0]!;
type EmittedComputedEditPresetOmitsEditability = Expect<
  Equal<(typeof emittedComputedFromEditPreset)["isEditable"], undefined>
>;
type EmittedComputedEditPresetOmitsBlank = Expect<
  Equal<(typeof emittedComputedFromEditPreset)["blankValue"], undefined>
>;
type EmittedComputedEditPresetOmitsValidation = Expect<
  Equal<(typeof emittedComputedFromEditPreset)["validate"], undefined>
>;
void (null as unknown as EmittedComputedEditPresetOmitsEditability);
void (null as unknown as EmittedComputedEditPresetOmitsBlank);
void (null as unknown as EmittedComputedEditPresetOmitsValidation);
const emittedInvalidPresetField = emittedNullableNumberPreset({
  columnId: "COL_ID_REQUIRED_PRESET",
  // @ts-expect-error emitted null blank preset requires a field containing null.
  field: "required",
  headerName: "Required preset",
});
void emittedInvalidPresetField;
const emittedInvalidDisabledPresetField = emittedNullableNumberPreset({
  columnId: "COL_ID_DISABLED_PRESET",
  // @ts-expect-error emitted inherited blank cannot combine with isEditable false.
  field: "nullable",
  headerName: "Disabled preset",
  // @ts-expect-error emitted effective false-plus-blank shape is rejected.
  isEditable: false,
});
void emittedInvalidDisabledPresetField;
const emittedEditableWithoutBlankPreset = BrunoTableNumberColumn.withDefaults({
  isEditable: true,
});
const emittedValidRequiredEditableWithoutBlank = [
  emittedEditableWithoutBlankPreset({
    columnId: "COL_ID_REQUIRED_EDITABLE_PRESET",
    field: "required",
    headerName: "Required editable preset",
  }),
] satisfies BrunoTableColumns<EmittedPresetEditRow>;
void emittedValidRequiredEditableWithoutBlank;
const emittedValidatedNumberPreset = BrunoTableNumberColumn.withDefaults({
  isEditable: true,
  validate: () => undefined,
});
const emittedInvalidDisabledValidatedPreset = emittedValidatedNumberPreset({
  columnId: "COL_ID_DISABLED_VALIDATED_PRESET",
  // @ts-expect-error emitted inherited validation cannot combine with false editability.
  field: "required",
  headerName: "Disabled validated preset",
  // @ts-expect-error emitted effective false-plus-validation shape is rejected.
  isEditable: false,
});
void emittedInvalidDisabledValidatedPreset;
const emittedInvalidNullableWithoutBlank = emittedEditableWithoutBlankPreset({
  columnId: "COL_ID_NULLABLE_WITHOUT_BLANK",
  // @ts-expect-error emitted nullable editable preset applications require an exact blank policy.
  field: "nullable",
  headerName: "Nullable without blank",
});
void emittedInvalidNullableWithoutBlank;
// @ts-expect-error emitted blank preset requires literal isEditable true.
BrunoTableNumberColumn.withDefaults({
  isEditable: false,
  blankValue: null,
});

const emittedComputedNumberColumn = BrunoTableNumberColumn.withDefaults({
  headerName: "Calculated price",
  enableFilter: true,
  enableSorting: true,
  isEditable: true,
});

const emittedComputedPresetColumns = [
  emittedComputedNumberColumn({
    columnId: "COL_ID_COMPUTED_PRICE",
    fields: ["price", "multiplier"],
    valueGetter: ({ row }) => row.price * row.multiplier,
  }),
] satisfies BrunoTableColumns<Order>;

type ComputedPresetOmitsFiltering = Expect<
  Equal<(typeof emittedComputedPresetColumns)[0]["enableFilter"], undefined>
>;
type ComputedPresetOmitsSetFiltering = Expect<
  Equal<
    "enableSetFilter" extends keyof (typeof emittedComputedPresetColumns)[0] ? true : false,
    false
  >
>;
type ComputedPresetOmitsSorting = Expect<
  Equal<(typeof emittedComputedPresetColumns)[0]["enableSorting"], undefined>
>;
type ComputedPresetOmitsEditing = Expect<
  Equal<(typeof emittedComputedPresetColumns)[0]["isEditable"], undefined>
>;

const helperColumns = [
  BrunoTableTextColumn({
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
  }),
  emittedPriceColumn({
    columnId: "COL_ID_PRICE",
    field: "price",
    width: 144,
    valueFormatter: ({ value }) => value.toFixed(2),
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
  emittedStatusColumn({
    columnId: "COL_ID_STATUS",
    field: "status",
  }),
  BrunoTableNumberColumn({
    columnId: "COL_ID_WEIGHTED_PRICE",
    fields: ["price", "multiplier"],
    headerName: "Weighted price",
    valueGetter: ({ row }) => row.price * row.multiplier,
  }),
] satisfies BrunoTableColumns<Order>;

type HelperColumns = typeof helperColumns;

type NarrowEmittedGroupParams = BrunoTableGroupKeyCellParams<string, "COL_ID_NARROW_GROUP"> & {
  readonly groupKeys: readonly [{ readonly field: "symbol"; readonly value: string }];
};

const narrowEmittedGroupFormatter = (_params: NarrowEmittedGroupParams) => "symbol";

const rawEmittedNarrowGroupedColumn = [
  {
    columnId: "COL_ID_NARROW_GROUP",
    field: "symbol",
    headerName: "Narrow raw group",
    valueType: "text",
    groupBy: true,
    groupKeyValueFormatter: narrowEmittedGroupFormatter,
  },
] as const;

// @ts-expect-error Emitted raw columns reject callbacks requiring sibling Group Key evidence.
const invalidRawEmittedNarrowGroupedColumn: BrunoTableColumns<Order> =
  rawEmittedNarrowGroupedColumn;
void invalidRawEmittedNarrowGroupedColumn;

BrunoTableTextColumn({
  columnId: "COL_ID_NARROW_GROUP",
  // @ts-expect-error Emitted helpers reject callbacks that require unavailable sibling evidence.
  field: "symbol",
  headerName: "Narrow group",
  groupBy: true,
  groupKeyValueFormatter: narrowEmittedGroupFormatter,
});

type HelperPrice = Expect<
  Equal<BrunoTableColumnValue<Order, HelperColumns, "COL_ID_PRICE">, number>
>;
type HelperQuantity = Expect<
  Equal<BrunoTableColumnValue<Order, HelperColumns, "COL_ID_QUANTITY">, bigint>
>;
type HelperStatus = Expect<
  Equal<BrunoTableColumnValue<Order, HelperColumns, "COL_ID_STATUS">, "open" | "closed">
>;
type HelperWeightedPrice = Expect<
  Equal<BrunoTableColumnValue<Order, HelperColumns, "COL_ID_WEIGHTED_PRICE">, number>
>;

type ExactAmount = { readonly minor: bigint };
type AmountRow = { readonly amount: ExactAmount };

const exactAmountValueType = {
  codecId: "consumer/exact-amount",
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
  decodePersisted: (input) =>
    typeof input === "object" &&
    input !== null &&
    "minor" in input &&
    typeof input.minor === "string"
      ? { _tag: "Success", value: { minor: BigInt(input.minor) } }
      : { _tag: "Failure", message: "Expected persisted exact amount." },
} satisfies BrunoTableValueType<ExactAmount, "numeric", "text">;

const exactAmountColumns = [
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

const exactAmountComputedColumns = [
  BrunoTableComputedColumn({
    columnId: "COL_ID_AMOUNT_COPY",
    fields: ["amount"],
    headerName: "Amount copy",
    valueType: exactAmountValueType,
    valueGetter: ({ row }) => row.amount,
    valueFormatter: ({ value }) => value.minor.toString(10),
  }),
] satisfies BrunoTableColumns<AmountRow>;
const emittedComputedWithErasedEditOptions = {
  ...exactAmountComputedColumns[0],
  blankValue: null,
  validate: () => undefined,
};
const emittedInvalidErasedComputedEditOptions = [
  // @ts-expect-error emitted computed columns reject edit-only options after widening.
  emittedComputedWithErasedEditOptions,
] satisfies BrunoTableColumns<AmountRow>;
void emittedInvalidErasedComputedEditOptions;

type ExactComputedAmount = Expect<
  Equal<
    BrunoTableColumnValue<AmountRow, typeof exactAmountComputedColumns, "COL_ID_AMOUNT_COPY">,
    ExactAmount
  >
>;

const exactAmountFilters = [
  { columnId: "COL_ID_AMOUNT", type: "greaterThan", filter: { minor: 10n } },
] satisfies BrunoTableFilterExpressions<AmountRow, typeof exactAmountColumns>;

const exactBuiltInFilters = [
  { columnId: "COL_ID_QUANTITY", type: "greaterThanOrEqual", filter: 10n },
  { columnId: "COL_ID_ACTIVE", type: "equals", filter: true },
  { columnId: "COL_ID_STATUS", type: "equals", filter: "open" },
] satisfies BrunoTableFilterExpressions<Order, HelperColumns>;

const invalidBigIntFilterOperand = [
  // @ts-expect-error Emitted BigInt filters preserve bigint operands.
  { columnId: "COL_ID_QUANTITY", type: "greaterThan", filter: 10 },
] satisfies BrunoTableFilterExpressions<Order, HelperColumns>;

const invalidBooleanFilterOperand = [
  // @ts-expect-error Emitted Boolean filters preserve boolean operands.
  { columnId: "COL_ID_ACTIVE", type: "equals", filter: "true" },
] satisfies BrunoTableFilterExpressions<Order, HelperColumns>;

const invalidSelectFilterOperand = [
  // @ts-expect-error Emitted Select filters admit only the exact configured value union.
  { columnId: "COL_ID_STATUS", type: "equals", filter: "pending" },
] satisfies BrunoTableFilterExpressions<Order, HelperColumns>;

void exactBuiltInFilters;
void invalidBigIntFilterOperand;
void invalidBooleanFilterOperand;
void invalidSelectFilterOperand;

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
    // @ts-expect-error emitted Client component preserves exact Column Identity inference.
    { columnId: "COL_ID_UNKNOWN", direction: "asc" },
  ],
  getRowId: (row) => row.id,
  clientSource: emittedViewServerResult,
});
void BrunoTableClient({
  tableId: "invalid-misspelled-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error emitted Client component rejects misspelled Column Identities.
    { columnId: "COL_ID_SYMBOOL", direction: "asc" },
  ],
  getRowId: (row) => row.id,
  clientSource: emittedViewServerResult,
});
void BrunoTableClient({
  tableId: "invalid-sort-direction",
  columns,
  initialOrderBy: [
    {
      columnId: "COL_ID_SYMBOL",
      // @ts-expect-error emitted Client component admits only asc and desc directions.
      direction: "ascending",
    },
  ],
  getRowId: (row) => row.id,
  clientSource: emittedViewServerResult,
});
void BrunoTableClient({
  tableId: "invalid-computed-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error emitted computed columns have no automatic Client sort mapping.
    { columnId: "COL_ID_DOUBLE_QUANTITY", direction: "asc" },
  ],
  getRowId: (row) => row.id,
  clientSource: emittedViewServerResult,
});
void BrunoTableClient({
  tableId: "invalid-nonsortable-sort",
  columns: capabilityColumns,
  initialOrderBy: [
    // @ts-expect-error emitted Client component excludes explicitly nonsortable identities.
    { columnId: "COL_ID_SYMBOL", direction: "asc" },
  ],
  getRowId: (row) => row.id,
  clientSource: emittedViewServerResult,
});

const emittedSortingTypeTestViewportSource = source;

const invalidEmittedServerUnknownSort = {
  tableId: "invalid-server-unknown-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error emitted Server props preserve exact Column Identity inference.
    { columnId: "COL_ID_UNKNOWN", direction: "asc" },
  ],
  viewportSource: emittedSortingTypeTestViewportSource,
} satisfies BrunoTableServerProps<Order, Columns, typeof source.viewport>;
void invalidEmittedServerUnknownSort;

const invalidEmittedServerMisspelledSort = {
  tableId: "invalid-server-misspelled-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error emitted Server props reject misspelled Column Identities.
    { columnId: "COL_ID_SYMBOOL", direction: "asc" },
  ],
  viewportSource: emittedSortingTypeTestViewportSource,
} satisfies BrunoTableServerProps<Order, Columns, typeof source.viewport>;
void invalidEmittedServerMisspelledSort;

const invalidEmittedServerComputedSort = {
  tableId: "invalid-server-computed-sort",
  columns,
  initialOrderBy: [
    // @ts-expect-error emitted computed columns have no automatic Server sort mapping.
    { columnId: "COL_ID_DOUBLE_QUANTITY", direction: "asc" },
  ],
  viewportSource: emittedSortingTypeTestViewportSource,
} satisfies BrunoTableServerProps<Order, Columns, typeof source.viewport>;
void invalidEmittedServerComputedSort;

const invalidEmittedServerNonsortableSort = {
  tableId: "invalid-server-nonsortable-sort",
  columns: capabilityColumns,
  initialOrderBy: [
    // @ts-expect-error emitted Server props exclude explicitly nonsortable identities.
    { columnId: "COL_ID_SYMBOL", direction: "asc" },
  ],
  viewportSource: emittedSortingTypeTestViewportSource,
} satisfies BrunoTableServerProps<Order, CapabilityColumns, typeof source.viewport>;
void invalidEmittedServerNonsortableSort;

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
type Price = Expect<Equal<BrunoTableColumnValue<Order, Columns, "COL_ID_PRICE">, number>>;
type DoubleQuantity = Expect<
  Equal<BrunoTableColumnValue<Order, Columns, "COL_ID_DOUBLE_QUANTITY">, bigint>
>;
type Filterable = Expect<
  Equal<BrunoTableFilterableColumnId<Columns>, "COL_ID_SYMBOL" | "COL_ID_PRICE">
>;
type OptedFilterable = Expect<
  Equal<BrunoTableFilterableColumnId<CapabilityColumns>, "COL_ID_SYMBOL">
>;
type OptedSortable = Expect<Equal<BrunoTableSortableColumnId<CapabilityColumns>, "COL_ID_PRICE">>;
type NoSortable = Expect<Equal<BrunoTableSortableColumnId<NoSortingColumns>, never>>;
type MixedCaseColumnIdRejected = Expect<
  Equal<"COL_ID_Price" extends import("@bruno/table").BrunoTableColumnId ? true : false, false>
>;
type PriceField = Expect<Equal<BrunoTableColumnField<Columns, "COL_ID_PRICE">, "price">>;
type CorrelatedSaves = Expect<
  Equal<
    BrunoTableSaveCellChange<Order, Columns>,
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
  >
>;

const filters = [
  { columnId: "COL_ID_PRICE", type: "greaterThan", filter: 10 },
  {
    columnId: "COL_ID_SYMBOL",
    type: "equals",
    filter: "AAPL",
    caseSensitive: true,
  },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const props = {
  tableId: "orders",
  columns,
  initialFilters: filters,
  initialOrderBy: [
    { columnId: "COL_ID_SYMBOL", direction: "asc" },
  ] satisfies BrunoTableSortBy<Columns>,
  children: BrunoTableFilterControl({
    ownership: "external",
    children: "Application-controlled filter",
  }),
  viewportSource: source,
} satisfies BrunoTableServerProps<Order, Columns, typeof source.viewport>;

const emittedServerWithExternalFilters = {
  ...props,
  externalFilters: [{ field: "status", type: "equals", filter: "open" }],
} as const satisfies BrunoTableServerProps<Order, Columns, typeof source.viewport>;
void emittedServerWithExternalFilters;

type UnsupportedToolbarCountsStayAbsent = Expect<
  Equal<
    Extract<
      | "BrunoTableSelectedRowCount"
      | "BrunoTableDirtyCellCount"
      | "BrunoTableValidationCount"
      | "BrunoTableConflictCount",
      keyof typeof import("@bruno/table")
    >,
    never
  >
>;
const unsupportedToolbarCountsStayAbsent: UnsupportedToolbarCountsStayAbsent = true;
void unsupportedToolbarCountsStayAbsent;

const emittedServerWithoutInitialOrderBy = {
  tableId: "orders-without-order",
  columns,
  viewportSource: source,
} as const;

// @ts-expect-error emitted Server props always require a typed non-empty Initial Order By.
const invalidEmittedServerWithoutInitialOrderBy: BrunoTableServerProps<
  Order,
  Columns,
  typeof source.viewport
> = emittedServerWithoutInitialOrderBy;
void invalidEmittedServerWithoutInitialOrderBy;

// @ts-expect-error emitted Common props always require a typed non-empty Initial Order By.
const invalidEmittedCommonWithoutInitialOrderBy: BrunoTableCommonProps<Order, Columns> = {
  tableId: "orders-without-order",
  columns,
};
void invalidEmittedCommonWithoutInitialOrderBy;

const invalidEmittedServerWithoutSortingCapability = {
  tableId: "unsortable-server",
  columns: noSortingColumns,
  initialOrderBy: [
    // @ts-expect-error emitted Server props reject definitions without a sortable Column Identity.
    { columnId: "COL_ID_SYMBOL", direction: "asc" },
  ],
  viewportSource: source,
} satisfies BrunoTableServerProps<Order, NoSortingColumns, typeof source.viewport>;
void invalidEmittedServerWithoutSortingCapability;

const invalidEmittedCommonWithoutSortingCapability = {
  tableId: "unsortable-common",
  columns: noSortingColumns,
  initialOrderBy: [
    // @ts-expect-error emitted Common props reject definitions without a sortable Column Identity.
    { columnId: "COL_ID_SYMBOL", direction: "asc" },
  ],
} satisfies BrunoTableCommonProps<Order, NoSortingColumns>;
void invalidEmittedCommonWithoutSortingCapability;

const emittedClient = BrunoTableClient({
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row) => row.id,
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 0,
    status: "ready",
  },
});
void emittedClient;

void BrunoTableClient({
  tableId: "private-runtime",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  clientSource: { rows: [] as readonly Order[], totalRows: 0, version: 0, status: "ready" },
  // @ts-expect-error emitted Client API exposes no table controller.
  table: {},
});
void BrunoTableClient({
  tableId: "orders-no-external-filters",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  clientSource: { rows: [] as readonly Order[], totalRows: 0, version: 0, status: "ready" },
  // @ts-expect-error emitted Client declarations reject Server-only External Filters.
  externalFilters: [{ field: "status", type: "equals", filter: "open" }],
});
void BrunoTableClient({
  tableId: "private-row-model",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  clientSource: { rows: [] as readonly Order[], totalRows: 0, version: 0, status: "ready" },
  // @ts-expect-error emitted Client API exposes no TanStack row-model factory.
  getCoreRowModel: () => ({}),
});

// @ts-expect-error emitted Client component requires tableId.
void BrunoTableClient({
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  clientSource: { rows: [] as readonly Order[], totalRows: 0, version: 0, status: "ready" },
});
// @ts-expect-error emitted Client component requires columns.
void BrunoTableClient({
  tableId: "orders",
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  clientSource: { rows: [] as readonly Order[], totalRows: 0, version: 0, status: "ready" },
});
// @ts-expect-error emitted Client component requires getRowId.
void BrunoTableClient({
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  clientSource: { rows: [] as readonly Order[], totalRows: 0, version: 0, status: "ready" },
});
// @ts-expect-error emitted Client component requires clientSource.
void BrunoTableClient({
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
});
// @ts-expect-error emitted Client component requires initialOrderBy.
void BrunoTableClient({
  tableId: "orders",
  columns,
  getRowId: (row: Order) => row.id,
  clientSource: { rows: [] as readonly Order[], totalRows: 0, version: 0, status: "ready" },
});
void BrunoTableClient({
  tableId: "orders",
  columns,
  // @ts-expect-error emitted Client component rejects an empty initialOrderBy.
  initialOrderBy: [],
  getRowId: (row: Order) => row.id,
  clientSource: { rows: [] as readonly Order[], totalRows: 0, version: 0, status: "ready" },
});
const emittedToolbar = BrunoTableToolbar({ children: "Filters" });
void emittedToolbar;

type EmittedEditableClientProps<TColumns extends BrunoTableColumns<Order>> = BrunoTableClientProps<
  Order,
  TColumns,
  bigint
>;

const editableProps = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  editable: true,
  getRowVersion: (row: Order) => row.revision,
  onSaveEdits: (changes) => {
    const version: bigint = changes[0].expectedVersion;
    const [change] = changes[0].changes;
    const field: "price" | "symbol" = change.field;
    void version;
    void field;
    return Promise.resolve();
  },
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 0,
    status: "ready",
  },
} satisfies EmittedEditableClientProps<Columns>;
// @ts-expect-error Emitted editable named props require the third Row Version authority generic.
const emittedErasedNamedProps: BrunoTableClientProps<Order, Columns> = editableProps;
void emittedErasedNamedProps;
const emittedExactNamedProps: BrunoTableClientProps<Order, Columns, bigint> = editableProps;
const emittedExactNamedVersion: bigint = emittedExactNamedProps.getRowVersion(
  emittedExactNamedProps.clientSource.rows[0]!,
);
void emittedExactNamedVersion;
// @ts-expect-error Explicit editable calls require the third Row Version authority generic.
void BrunoTableClient<Order, Columns>(editableProps);
void BrunoTableClient<Order, Columns, (row: Order) => bigint>(editableProps);
void BrunoTableClient(editableProps);

const noSortingProps = {
  tableId: "unsortable-orders",
  columns: noSortingColumns,
  getRowId: (row: Order) => row.id,
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 0,
    status: "ready",
  },
} as const;

// @ts-expect-error emitted Client props always require a typed non-empty Initial Order By.
const invalidNoSortingProps: BrunoTableClientProps<Order, NoSortingColumns> = noSortingProps;

const widenedColumns: BrunoTableColumns<Order> = columns;
const widenedEditableProps = {
  tableId: "widened-orders",
  columns: widenedColumns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  editable: true,
  getRowVersion: (row: Order) => row.revision,
  onSaveEdits: (changes) => {
    const field: keyof Order = changes[0].changes[0].field;
    void field;
    return Promise.resolve();
  },
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 0,
    status: "ready",
  },
} satisfies EmittedEditableClientProps<typeof widenedColumns>;

const emittedNonEditableColumns = [
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
  },
] as const satisfies BrunoTableColumns<Order>;
const emittedInvalidNamedEditableProps = {
  tableId: "emitted-invalid-editable",
  columns: emittedNonEditableColumns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  editable: true,
  getRowVersion: (row: Order) => row.revision,
  onSaveEdits: () => Promise.resolve(),
  clientSource: { rows: [] as readonly Order[], totalRows: 0, version: 0, status: "ready" },
} as const;
// @ts-expect-error emitted named props preserve the exact potentially-editable tuple proof.
const emittedInvalidNamedEditableAssignment: BrunoTableClientProps<
  Order,
  typeof emittedNonEditableColumns,
  bigint
> = emittedInvalidNamedEditableProps;
void emittedInvalidNamedEditableAssignment;

const invalidProps = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  // @ts-expect-error emitted Server props preserve source-owned row identity.
  getRowId: (row: Order) => row.id,
  viewportSource: source,
} satisfies BrunoTableServerProps<Order, Columns, typeof source.viewport>;

const invalidServerEditing = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  viewportSource: source,
  // @ts-expect-error emitted Server props forbid editing.
  editable: true,
} satisfies BrunoTableServerProps<Order, Columns, typeof source.viewport>;

const emittedServerWithGroupingConfiguration = {
  tableId: "orders",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  viewportSource: source,
  groupRowsColumn: {
    headerName: "Orders",
    width: 144,
    valueFormatter: ({ columnId, value }) => {
      const exactColumnId: "COL_ID_BRUNO_TABLE_ROWS" = columnId;
      const exactValue: bigint = value;
      return `${exactColumnId}:${exactValue.toString()}`;
    },
  },
} as const satisfies BrunoTableServerProps<Order, Columns, typeof source.viewport>;
void emittedServerWithGroupingConfiguration;
const emittedClientOnlyNumberArithmetic =
  emittedExactMoneyValueType as unknown as BrunoTableValueType<
    number,
    "numeric",
    "bigdecimal",
    { readonly sum: "self" }
  >;
const emittedSpoofedBigDecimalCodec = {
  ...emittedClientOnlyNumberArithmetic,
  codecId: "@bruno/table/effect/bigdecimal" as const,
  aggregateResults: { sum: "self" as const },
};
const emittedSpoofedBigDecimalColumns = [
  {
    columnId: "COL_ID_EMITTED_SPOOFED_GROUP",
    field: "symbol",
    headerName: "Group",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_EMITTED_SPOOFED_SUM",
    field: "price",
    headerName: "Spoofed sum",
    valueType: emittedSpoofedBigDecimalCodec,
    aggFunc: "sum",
  },
] as const satisfies BrunoTableColumns<Order>;
const invalidEmittedSpoofedBigDecimalServer: BrunoTableServerProps<
  Order,
  typeof emittedSpoofedBigDecimalColumns,
  typeof source.viewport
> = {
  tableId: "orders-spoofed-bigdecimal",
  // @ts-expect-error Emitted public codec data cannot forge Effect Server authority.
  columns: emittedSpoofedBigDecimalColumns,
  initialOrderBy: [{ columnId: "COL_ID_EMITTED_SPOOFED_GROUP", direction: "asc" }],
  viewportSource: source,
};
void invalidEmittedSpoofedBigDecimalServer;
const emittedClientOnlyServerAggregateColumns = [
  {
    columnId: "COL_ID_EMITTED_CLIENT_ONLY_GROUP",
    field: "symbol",
    headerName: "Group",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_EMITTED_CLIENT_ONLY_SUM",
    field: "price",
    headerName: "Client-only sum",
    valueType: emittedClientOnlyNumberArithmetic,
    aggFunc: "sum",
  },
] as const satisfies BrunoTableColumns<Order>;
const emittedServerWithClientOnlyArithmetic = {
  tableId: "orders-client-only-arithmetic",
  columns: emittedClientOnlyServerAggregateColumns,
  initialOrderBy: [{ columnId: "COL_ID_EMITTED_CLIENT_ONLY_GROUP", direction: "asc" }],
  viewportSource: source,
} as const;
// @ts-expect-error Emitted Server arithmetic preserves source-owned exact result domains.
const invalidEmittedServerClientOnlyArithmetic: BrunoTableServerProps<
  Order,
  typeof emittedClientOnlyServerAggregateColumns,
  typeof source.viewport
> = emittedServerWithClientOnlyArithmetic;
void invalidEmittedServerClientOnlyArithmetic;
const widenedEmittedClientOnlyServerAggregateColumns: readonly (typeof emittedClientOnlyServerAggregateColumns)[number][] =
  emittedClientOnlyServerAggregateColumns;
const widenedEmittedClientOnlyServerProps = {
  ...emittedServerWithClientOnlyArithmetic,
  columns: widenedEmittedClientOnlyServerAggregateColumns,
} as const;
// @ts-expect-error Emitted widened columns cannot bypass Server arithmetic admission.
const invalidWidenedEmittedServerClientOnlyArithmetic: BrunoTableServerProps<
  Order,
  typeof widenedEmittedClientOnlyServerAggregateColumns,
  typeof source.viewport
> = widenedEmittedClientOnlyServerProps;
void invalidWidenedEmittedServerClientOnlyArithmetic;

const editablePropsWithGrouping = {
  ...editableProps,
  groupRowsColumn: { headerName: "Rows" },
} as const;

// @ts-expect-error emitted editable Client props reject grouping for non-fresh objects.
const invalidEditableGrouping: EmittedEditableClientProps<Columns> = editablePropsWithGrouping;

const invalidCrossedSaveCell = {
  columnId: "COL_ID_SYMBOL",
  field: "price",
  before: "AAPL",
  after: "MSFT",
} as const;

// @ts-expect-error emitted declarations preserve Column Identity and field correlation.
const invalidCrossedSaveCellAssignment: BrunoTableSaveCellChange<Order, Columns> =
  invalidCrossedSaveCell;

const invalidWidenedSaveCell = {
  columnId: "COL_ID_PRICE",
  field: "price",
  before: "not a number",
  after: "still not a number",
} as const;

// @ts-expect-error emitted widened columns retain field/value correlation.
const invalidWidenedSaveCellAssignment: BrunoTableSaveCellChange<Order, typeof widenedColumns> =
  invalidWidenedSaveCell;

// @ts-expect-error emitted Save Change Sets are non-empty.
const invalidEmptySave = [] satisfies BrunoTableSaveChangeSet<Order, Columns, bigint>;

const invalidColumn = [
  {
    // @ts-expect-error emitted declarations preserve the uppercase identity contract.
    columnId: "COL_ID_price",
    field: "price",
    headerName: "Price",
    valueType: "number",
  },
] satisfies BrunoTableColumns<Order>;

// @ts-expect-error emitted declarations reject mixed-case Column Identity suffixes.
const invalidMixedCaseColumnId: import("@bruno/table").BrunoTableColumnId = "COL_ID_Price";
void invalidMixedCaseColumnId;

const missingHeaderName = [
  // @ts-expect-error emitted declarations require an explicit header name.
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Order>;

const invalidFilter = [
  // @ts-expect-error emitted declarations keep computed columns out of automatic filtering.
  { columnId: "COL_ID_DOUBLE_QUANTITY", type: "greaterThan", filter: 10n },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const invalidOptedOutFilter = [
  // @ts-expect-error emitted declarations exclude explicitly non-filterable identities.
  { columnId: "COL_ID_PRICE", type: "greaterThan", filter: 10 },
] satisfies BrunoTableFilterExpressions<Order, CapabilityColumns>;

const invalidNumericSensitivity = [
  {
    columnId: "COL_ID_PRICE",
    type: "equals",
    filter: 10,
    // @ts-expect-error emitted numeric filters reject text-only sensitivity flags.
    caseSensitive: true,
  },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

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
    // @ts-expect-error emitted boolean filters reject text-only sensitivity flags.
    accentSensitive: true,
  },
] satisfies BrunoTableFilterExpressions<FeatureFlag, typeof featureFlagColumns>;

const acceptedBooleanSetFilters = [
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
  // @ts-expect-error emitted Match None remains gated by the Set Filter surface.
  { columnId: "COL_ID_ENABLED", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<FeatureFlag, typeof optedOutBooleanSetFilterColumns>;

void acceptedOptedOutBooleanInFilter;
void invalidOptedOutBooleanMatchNone;

const acceptedSelectSetFilters = [
  { columnId: "COL_ID_STATUS", type: "in", filter: ["open"] },
  { columnId: "COL_ID_STATUS", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<Order, HelperColumns>;

const invalidDefaultTextMatchNone = [
  // @ts-expect-error emitted Text Set Filters require explicit opt-in.
  { columnId: "COL_ID_SYMBOL", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const invalidSetFilterCapability = [
  // @ts-expect-error emitted declarations reject Set Filter when filtering is disabled.
  {
    columnId: "COL_ID_SYMBOL",
    enableFilter: false,
    enableSetFilter: true,
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Order>;

const invalidEmptyInFilter = [
  // @ts-expect-error emitted declarations require non-empty `in` operands.
  { columnId: "COL_ID_SYMBOL", type: "in", filter: [] },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const acceptedTextInFilter = [
  { columnId: "COL_ID_SYMBOL", type: "in", filter: ["AAPL"] },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const acceptedNumericInFilter = [
  { columnId: "COL_ID_PRICE", type: "in", filter: [10] },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const invalidMixedColumnCompoundFilter = [
  {
    type: "OR",
    // @ts-expect-error emitted declarations reject mixed-identity compound filters.
    conditions: [
      { columnId: "COL_ID_PRICE", type: "greaterThan", filter: 10 },
      { columnId: "COL_ID_SYMBOL", type: "startsWith", filter: "A" },
    ],
  },
] satisfies BrunoTableFilterExpressions<Order, Columns>;

const invalidEmptyCompoundFilter = [
  {
    type: "OR",
    // @ts-expect-error emitted compound filter conditions are non-empty.
    conditions: [],
  },
] satisfies BrunoTableFilterExpressions<Order, Columns>;
void invalidEmptyCompoundFilter;

// @ts-expect-error emitted declarations preserve the non-empty sorting invariant.
const invalidEmptySort = [] satisfies BrunoTableSortBy<Columns>;

const invalidOptedOutSort = [
  // @ts-expect-error emitted declarations exclude explicitly nonsortable identities.
  { columnId: "COL_ID_SYMBOL", direction: "asc" },
] satisfies BrunoTableSortBy<CapabilityColumns>;

const invalidNoCapabilitySort = [
  // @ts-expect-error every emitted table requires a sortable Column Identity for Initial Order By.
  { columnId: "COL_ID_SYMBOL", direction: "asc" },
] satisfies BrunoTableSortBy<NoSortingColumns>;

const invalidInitialOrderByWithoutSortingCapability = {
  tableId: "unsortable-orders",
  columns: noSortingColumns,
  // @ts-expect-error no mandatory Initial Order By can exist without a sortable Column Identity.
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  getRowId: (row: Order) => row.id,
  clientSource: {
    rows: [] as readonly Order[],
    totalRows: 0,
    version: 0,
    status: "ready",
  },
} satisfies BrunoTableClientProps<Order, NoSortingColumns>;

const invalidComputedDependency = [
  BrunoTableComputedColumn({
    columnId: "COL_ID_DOUBLE_QUANTITY",
    fields: ["quantity"],
    headerName: "Double quantity",
    valueType: "bigint",
    valueGetter: ({ row }) => {
      // @ts-expect-error emitted declarations restrict getters to declared dependencies.
      void row.price;
      return row.quantity * 2n;
    },
  }),
] satisfies BrunoTableColumns<Order>;

const invalidNumberHelperField = [
  BrunoTableNumberColumn({
    columnId: "COL_ID_SYMBOL",
    // @ts-expect-error emitted Number helper rejects a string field.
    field: "symbol",
    headerName: "Symbol",
  }),
] satisfies BrunoTableColumns<Order>;

const invalidHelperWithoutColumnId = [
  // @ts-expect-error emitted helpers still require an explicit Column Identity.
  BrunoTableTextColumn({ field: "symbol", headerName: "Symbol" }),
] satisfies BrunoTableColumns<Order>;

const invalidIdentityPreset = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  // @ts-expect-error emitted presets can never own Column Identity.
  columnId: "COL_ID_PRICE",
});

const invalidFieldPreset = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  // @ts-expect-error emitted presets can never own server field mapping.
  field: "price",
});

const invalidValueTypePreset = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  // @ts-expect-error emitted presets cannot replace exact Value Types.
  valueType: "text",
});

const invalidUnknownPresetOption = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  // @ts-expect-error emitted presets reject unknown configuration.
  mysteryOption: true,
});

const emittedStrictPricePreset = BrunoTableNumberColumn.withDefaults({ headerName: "Price" });
const invalidPresetInvocationWithoutColumnId = emittedStrictPricePreset({
  // @ts-expect-error emitted preset calls still require explicit Column Identity.
  field: "price",
});

const invalidNumberHelperValueType = BrunoTableNumberColumn({
  columnId: "COL_ID_PRICE",
  // @ts-expect-error emitted Number helpers cannot change exact Value Type.
  field: "price",
  headerName: "Price",
  valueType: "text",
});

const narrowPriceFormatter = ({
  row,
  value,
}: {
  readonly row: Order & { readonly secret: string };
  readonly value: number;
}) => `${row.secret}:${value}`;

const invalidNarrowPresentationCallback = [
  // @ts-expect-error emitted presentation callbacks reject narrower row annotations.
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: "number",
    valueFormatter: narrowPriceFormatter,
  },
] satisfies BrunoTableColumns<Order>;

type MixedAmountRow = { readonly amount: ExactAmount | { readonly major: number } };
const invalidNarrowCustomValueType = [
  // @ts-expect-error emitted custom Value Types cover the complete exact field domain.
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
      // @ts-expect-error emitted helper getters expose only declared dependencies.
      void row.status;
      return row.price * row.multiplier;
    },
  }),
] satisfies BrunoTableColumns<Order>;

const invalidCustomComputedDependency = [
  BrunoTableComputedColumn({
    columnId: "COL_ID_AMOUNT_COPY",
    fields: ["amount"],
    headerName: "Amount copy",
    valueType: exactAmountValueType,
    valueGetter: ({ row }) => {
      // @ts-expect-error emitted custom Computed Columns expose only declared dependencies.
      void row.otherAmount;
      return row.amount;
    },
  }),
] satisfies BrunoTableColumns<AmountRow>;

const invalidIncompleteSelectDomain = [
  BrunoTableSelectColumn({
    columnId: "COL_ID_STATUS",
    // @ts-expect-error emitted Select options must cover the exact field domain.
    field: "status",
    headerName: "Status",
    options: ["open"],
  }),
] satisfies BrunoTableColumns<Order>;

const invalidCustomNumericOperand = [
  // @ts-expect-error emitted custom numeric Value Types keep their exact operand domain.
  { columnId: "COL_ID_AMOUNT", type: "greaterThan", filter: 10 },
] satisfies BrunoTableFilterExpressions<AmountRow, typeof exactAmountColumns>;

type EmittedExactToggle = "N" | "Y";
const emittedExactToggleValueType = {
  codecId: "example/emitted-toggle",
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
  equivalent: (left: EmittedExactToggle, right: EmittedExactToggle) => left === right,
  compare: (left: EmittedExactToggle, right: EmittedExactToggle) =>
    left === right ? 0 : left === "N" ? -1 : 1,
  formatCanonicalText: (value: EmittedExactToggle) => value,
  parseCanonicalText: (text: string) =>
    text === "N" || text === "Y"
      ? { _tag: "Success" as const, value: text }
      : { _tag: "Failure" as const, message: "Expected N or Y." },
  formatDisplay: (value: EmittedExactToggle) => value,
  encodePersisted: (value: EmittedExactToggle) => value,
  decodePersisted: (input: unknown) =>
    input === "N" || input === "Y"
      ? { _tag: "Success" as const, value: input }
      : { _tag: "Failure" as const, message: "Expected N or Y." },
} satisfies BrunoTableValueType<EmittedExactToggle, "equality", "boolean">;
const {
  booleanEditorValues: emittedOmittedToggleEditorValues,
  ...emittedToggleWithoutEditorValues
} = emittedExactToggleValueType;
void emittedOmittedToggleEditorValues;
// @ts-expect-error emitted custom Boolean editors require an exact false/true mapping.
const emittedInvalidToggleValueType: BrunoTableValueType<
  EmittedExactToggle,
  "equality",
  "boolean"
> = emittedToggleWithoutEditorValues;

const builtInValueType: BrunoTableBuiltInValueType = "bigint";

void (0 as unknown as Price);
void (0 as unknown as DoubleQuantity);
void (0 as unknown as Filterable);
void (0 as unknown as OptedFilterable);
void (0 as unknown as OptedSortable);
void (0 as unknown as NoSortable);
void (0 as unknown as MixedCaseColumnIdRejected);
void (0 as unknown as PriceField);
void (0 as unknown as CorrelatedSaves);
void (0 as unknown as HelperPrice);
void (0 as unknown as HelperQuantity);
void (0 as unknown as HelperStatus);
void (0 as unknown as HelperWeightedPrice);
void (0 as unknown as ExactComputedAmount);
void (0 as unknown as ComputedPresetOmitsFiltering);
void (0 as unknown as ComputedPresetOmitsSetFiltering);
void (0 as unknown as ComputedPresetOmitsSorting);
void (0 as unknown as ComputedPresetOmitsEditing);
void filters;
void props;
void editableProps;
void noSortingProps;
void invalidNoSortingProps;
void widenedEditableProps;
void invalidProps;
void invalidServerEditing;
void invalidEditableGrouping;
void invalidCrossedSaveCell;
void invalidCrossedSaveCellAssignment;
void invalidWidenedSaveCell;
void invalidWidenedSaveCellAssignment;
void invalidEmptySave;
void invalidColumn;
void missingHeaderName;
void invalidFilter;
void invalidOptedOutFilter;
void invalidNumericSensitivity;
void invalidBooleanSensitivity;
void invalidEmptyInFilter;
void acceptedTextInFilter;
void acceptedNumericInFilter;
void acceptedBooleanSetFilters;
void acceptedSelectSetFilters;
void invalidDefaultTextMatchNone;
void invalidSetFilterCapability;
void invalidMixedColumnCompoundFilter;
void invalidEmptySort;
void invalidOptedOutSort;
void invalidNoCapabilitySort;
void invalidInitialOrderByWithoutSortingCapability;
void invalidComputedDependency;
void helperColumns;
void exactAmountFilters;
void exactAmountComputedColumns;
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
void builtInValueType;
void emittedExactToggleValueType;
void emittedInvalidToggleValueType;
