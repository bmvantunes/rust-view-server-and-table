import * as BigDecimal from "effect/BigDecimal";
import { expectTypeOf } from "vitest";

import { BrunoTableBigDecimalColumn, BrunoTableBigDecimalValueType } from "@bruno/table/effect";
import type {
  BrunoTableAggregateCellParams,
  BrunoTableColumnValue,
  BrunoTableColumns,
  BrunoTableFilterExpressions,
  BrunoTableGroupKeyValues,
  BrunoTableValueType,
} from "@bruno/table";

type PriceRow = {
  readonly price: BigDecimal.BigDecimal;
  readonly referencePrice?: BigDecimal.BigDecimal;
  readonly symbol: string;
};

type EditableBigDecimalRow = {
  readonly required: BigDecimal.BigDecimal;
  readonly nullable: BigDecimal.BigDecimal | null;
  readonly optional: BigDecimal.BigDecimal | undefined;
};

const directEditableBigDecimalColumns = [
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_NULLABLE_BIGDECIMAL",
    field: "nullable",
    headerName: "Nullable BigDecimal",
    isEditable: true,
    blankValue: null,
    validate: ({ value }) => (value === undefined ? "Unexpected undefined" : undefined),
  }),
] satisfies BrunoTableColumns<EditableBigDecimalRow>;
void directEditableBigDecimalColumns;

const nullableBigDecimalPreset = BrunoTableBigDecimalColumn.withDefaults({
  isEditable: true,
  blankValue: null,
  validate: ({ value }) => (value === undefined ? "Unexpected undefined" : undefined),
});
const nullableBigDecimalPresetColumns = [
  nullableBigDecimalPreset({
    columnId: "COL_ID_NULLABLE_BIGDECIMAL_PRESET",
    field: "nullable",
    headerName: "Nullable BigDecimal preset",
  }),
  nullableBigDecimalPreset({
    columnId: "COL_ID_OPTIONAL_BIGDECIMAL_PRESET",
    field: "optional",
    headerName: "Optional BigDecimal preset",
    blankValue: undefined,
  }),
] satisfies BrunoTableColumns<EditableBigDecimalRow>;
void nullableBigDecimalPresetColumns;
const predicateBigDecimalPreset = BrunoTableBigDecimalColumn.withDefaults({
  isEditable: ({ row, value }) => {
    expectTypeOf(row).toEqualTypeOf<unknown>();
    expectTypeOf(value).toEqualTypeOf<BigDecimal.BigDecimal | null | undefined>();
    return value !== undefined;
  },
  blankValue: null,
});
const predicateBigDecimalColumns = [
  predicateBigDecimalPreset({
    columnId: "COL_ID_PREDICATE_BIGDECIMAL_PRESET",
    field: "nullable",
    headerName: "Predicate BigDecimal preset",
  }),
] satisfies BrunoTableColumns<EditableBigDecimalRow>;
void predicateBigDecimalColumns;
const invalidDisabledBigDecimalPreset = nullableBigDecimalPreset({
  columnId: "COL_ID_DISABLED_BIGDECIMAL_PRESET",
  // @ts-expect-error inherited blank cannot combine with isEditable false.
  field: "nullable",
  headerName: "Disabled BigDecimal preset",
  // @ts-expect-error the effective false-plus-blank shape is rejected.
  isEditable: false,
});
void invalidDisabledBigDecimalPreset;
const editableBigDecimalWithoutBlank = BrunoTableBigDecimalColumn.withDefaults({
  isEditable: true,
});
const invalidNullableBigDecimalWithoutBlank = editableBigDecimalWithoutBlank({
  columnId: "COL_ID_NULLABLE_BIGDECIMAL_WITHOUT_BLANK",
  // @ts-expect-error nullable editable BigDecimal applications require a blank policy.
  field: "nullable",
  headerName: "Nullable BigDecimal without blank",
});
void invalidNullableBigDecimalWithoutBlank;
const widenedBigDecimalDefaults: { readonly isEditable?: boolean } = { isEditable: true };
const widenedBigDecimalPreset = BrunoTableBigDecimalColumn.withDefaults(widenedBigDecimalDefaults);
const invalidWidenedNullableBigDecimal = widenedBigDecimalPreset({
  columnId: "COL_ID_WIDENED_NULLABLE_BIGDECIMAL",
  // @ts-expect-error widened editability may be true, so nullable fields require a blank policy.
  field: "nullable",
  headerName: "Widened nullable BigDecimal",
});
void invalidWidenedNullableBigDecimal;
const invalidWidenedNullableBigDecimalWithBlank = widenedBigDecimalPreset({
  columnId: "COL_ID_WIDENED_NULLABLE_BIGDECIMAL_WITH_BLANK",
  // @ts-expect-error widened editability cannot prove the nullable field capability.
  field: "nullable",
  headerName: "Widened nullable BigDecimal with blank",
  // @ts-expect-error a blank policy still requires exact true or predicate editability.
  blankValue: null,
});
void invalidWidenedNullableBigDecimalWithBlank;
const validWidenedRequiredBigDecimal = [
  widenedBigDecimalPreset({
    columnId: "COL_ID_WIDENED_REQUIRED_BIGDECIMAL",
    field: "required",
    headerName: "Widened required BigDecimal",
  }),
] satisfies BrunoTableColumns<EditableBigDecimalRow>;
void validWidenedRequiredBigDecimal;

const priceColumn = BrunoTableBigDecimalColumn.withDefaults({
  headerName: "Price",
  width: 128,
  cellClassName: "tabular-nums",
});

const columns = [
  priceColumn({
    columnId: "COL_ID_PRICE",
    enableSetFilter: true,
    field: "price",
    valueFormatter: ({ row, value }) =>
      `${row.symbol}: ${value === undefined ? "" : BigDecimal.format(value)}`,
    cellClassName: ({ value }) =>
      value !== undefined && value.value < 0n ? "text-destructive" : undefined,
  }),
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_REFERENCE_PRICE",
    field: "referencePrice",
    headerName: "Reference price",
  }),
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_SPREAD",
    headerName: "Spread",
    fields: ["price", "referencePrice"],
    valueGetter: ({ row }) => row.referencePrice ?? row.price,
  }),
] satisfies BrunoTableColumns<PriceRow>;

const rawColumns = [
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: BrunoTableBigDecimalValueType,
  },
] satisfies BrunoTableColumns<PriceRow>;

type PriceValue = BrunoTableColumnValue<PriceRow, typeof columns, "COL_ID_PRICE">;
const exactPrice: PriceValue = BigDecimal.make(123n, 2);
void exactPrice;
void rawColumns;

const filters = [
  {
    columnId: "COL_ID_PRICE",
    type: "greaterThanOrEqual",
    filter: BigDecimal.make(100n, 2),
  },
  {
    columnId: "COL_ID_REFERENCE_PRICE",
    type: "inRange",
    filter: BigDecimal.make(100n, 2),
    filterTo: BigDecimal.make(200n, 2),
  },
  {
    columnId: "COL_ID_PRICE",
    type: "in",
    filter: [BigDecimal.make(100n, 2)],
  },
  { columnId: "COL_ID_PRICE", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<PriceRow, typeof columns>;
void filters;

const invalidDefaultBigDecimalSetFilter = [
  // @ts-expect-error BigDecimal Set Filter requires explicit opt-in.
  { columnId: "COL_ID_REFERENCE_PRICE", type: "matchNone" },
] satisfies BrunoTableFilterExpressions<PriceRow, typeof columns>;
void invalidDefaultBigDecimalSetFilter;

const invalidFilter: BrunoTableFilterExpressions<PriceRow, typeof columns> = [
  // @ts-expect-error BigDecimal numeric filters never accept JavaScript number operands.
  { columnId: "COL_ID_PRICE", type: "greaterThan", filter: 1 },
];
void invalidFilter;

const invalidComputed = [
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_INVALID_SPREAD",
    headerName: "Invalid spread",
    fields: ["price"],
    valueGetter: ({ row }) => {
      // @ts-expect-error Computed getters may read only their declared fields.
      void row.symbol;
      return row.price;
    },
  }),
] satisfies BrunoTableColumns<PriceRow>;
void invalidComputed;

// @ts-expect-error BigDecimal helpers reject fields from another value domain.
const invalidField = BrunoTableBigDecimalColumn<PriceRow, "symbol">({
  columnId: "COL_ID_SYMBOL",
  field: "symbol",
  headerName: "Symbol",
});
void invalidField;

type GroupedPriceRow = {
  readonly price: BigDecimal.BigDecimal;
  readonly optionalPrice?: BigDecimal.BigDecimal;
  readonly nullablePrice: BigDecimal.BigDecimal | null;
  readonly absent?: never;
};

const groupedColumns = [
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_GROUP_PRICE",
    field: "price",
    headerName: "Price group",
    groupBy: true,
    groupKeyValueFormatter: ({ columnId, field, value, rowCount }) => {
      columnId satisfies "COL_ID_GROUP_PRICE";
      field satisfies "price";
      BigDecimal.format(value);
      rowCount satisfies bigint;
      return BigDecimal.format(value);
    },
  }),
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_TOTAL_PRICE",
    field: "price",
    headerName: "Total price",
    aggFunc: "sum",
    aggregateValueFormatter: (parameters) => {
      const { aggFunc, columnId, field, value, rowCount } = parameters;
      aggFunc satisfies "sum";
      columnId satisfies "COL_ID_TOTAL_PRICE";
      field satisfies "price";
      rowCount satisfies bigint;
      // @ts-expect-error Aggregate cells never fabricate one raw source row.
      void parameters.row;
      return BigDecimal.format(value);
    },
  }),
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_DISTINCT_PRICE",
    field: "price",
    headerName: "Distinct prices",
    aggFunc: "countDistinct",
    aggregateValueFormatter: ({ value }) => value.toString(),
  }),
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_OPTIONAL_MIN_PRICE",
    field: "optionalPrice",
    headerName: "Minimum optional price",
    aggFunc: "min",
    aggregateValueFormatter: ({ value }) => {
      value satisfies BigDecimal.BigDecimal | undefined;
      return value === undefined ? "" : BigDecimal.format(value);
    },
  }),
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_NULLABLE_MIN_PRICE",
    field: "nullablePrice",
    headerName: "Minimum nullable price",
    aggFunc: "min",
    aggregateValueFormatter: ({ value }) => {
      value satisfies BigDecimal.BigDecimal | null;
      return value === null ? "" : BigDecimal.format(value);
    },
  }),
] satisfies BrunoTableColumns<GroupedPriceRow>;
void groupedColumns;

const groupEvidenceColumns = [
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_PRIMARY_PRICE_GROUP",
    field: "price",
    headerName: "Primary price group",
    groupBy: true,
  }),
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_SECONDARY_PRICE_GROUP",
    field: "price",
    headerName: "Secondary price group",
    groupBy: true,
  }),
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_NOT_GROUPABLE_PRICE",
    field: "price",
    headerName: "Not groupable price",
  }),
] satisfies BrunoTableColumns<GroupedPriceRow>;
const exactGroupKeyValues: BrunoTableGroupKeyValues<GroupedPriceRow, typeof groupEvidenceColumns> =
  [
    {
      columnId: "COL_ID_PRIMARY_PRICE_GROUP",
      field: "price",
      _tag: "Present",
      value: BigDecimal.make(1n, 0),
    },
    {
      columnId: "COL_ID_SECONDARY_PRICE_GROUP",
      field: "price",
      _tag: "Present",
      value: BigDecimal.make(2n, 0),
    },
  ];
void exactGroupKeyValues;
const invalidGroupKeyValues: BrunoTableGroupKeyValues<
  GroupedPriceRow,
  typeof groupEvidenceColumns
> = [
  {
    // @ts-expect-error Exact group-key evidence excludes non-groupable Column Identities.
    columnId: "COL_ID_NOT_GROUPABLE_PRICE",
    field: "price",
    value: BigDecimal.make(1n, 0),
  },
];
void invalidGroupKeyValues;

const [rawGroupedPrice] = [
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_RAW_GROUP_PRICE",
    field: "price",
    headerName: "Raw grouped price",
    groupBy: true,
    aggFunc: "max",
    aggregateValueFormatter: ({ value }) => BigDecimal.format(value),
  }),
] satisfies BrunoTableColumns<GroupedPriceRow>;
void rawGroupedPrice;

const validSpreadBigDecimalGroupedColumn = [
  { ...rawGroupedPrice! },
] satisfies BrunoTableColumns<GroupedPriceRow>;
void validSpreadBigDecimalGroupedColumn;
const replacedSpreadBigDecimalGroupedColumn = [
  {
    ...rawGroupedPrice!,
    aggregateValueFormatter: ({
      value,
    }: BrunoTableAggregateCellParams<
      "max",
      BigDecimal.BigDecimal,
      "COL_ID_RAW_GROUP_PRICE",
      "price"
    >) => BigDecimal.format(value),
  },
] satisfies BrunoTableColumns<GroupedPriceRow>;
void replacedSpreadBigDecimalGroupedColumn;

const { aggregateResults: ignoredAggregateResults, ...noAggregateBigDecimalValueType } =
  BrunoTableBigDecimalValueType;
void ignoredAggregateResults;
noAggregateBigDecimalValueType satisfies BrunoTableValueType<
  BigDecimal.BigDecimal,
  "numeric",
  "bigdecimal"
>;
const invalidRawAggregate = [
  // @ts-expect-error A raw custom Value Type must declare the selected aggregate capability.
  {
    columnId: "COL_ID_INVALID_RAW_AGGREGATE",
    field: "price",
    headerName: "Invalid raw aggregate",
    valueType: noAggregateBigDecimalValueType,
    aggFunc: "sum",
  },
] satisfies BrunoTableColumns<GroupedPriceRow>;
void invalidRawAggregate;

const invalidOptionalSum = BrunoTableBigDecimalColumn({
  columnId: "COL_ID_INVALID_OPTIONAL_SUM",
  // @ts-expect-error View Server sum and avg reject optional or nullish fields.
  field: "optionalPrice",
  headerName: "Invalid optional sum",
  aggFunc: "sum",
});
void invalidOptionalSum;

const invalidNullableAverage = BrunoTableBigDecimalColumn({
  columnId: "COL_ID_INVALID_NULLABLE_AVERAGE",
  // @ts-expect-error View Server sum and avg reject optional or nullish fields.
  field: "nullablePrice",
  headerName: "Invalid nullable average",
  aggFunc: "avg",
});
void invalidNullableAverage;

const aggregatePreset = BrunoTableBigDecimalColumn.withDefaults({
  headerName: "Total price",
  aggFunc: "sum",
  aggregateValueFormatter: ({ value }) => BigDecimal.format(value),
});
const [distinctFromPreset] = [
  aggregatePreset({
    columnId: "COL_ID_PRESET_DISTINCT",
    field: "price",
    aggFunc: "countDistinct",
  }),
] satisfies BrunoTableColumns<GroupedPriceRow>;
// @ts-expect-error Changing aggFunc removes the incompatible preset formatter capability.
distinctFromPreset.aggregateValueFormatter({});

const invalidOptionalAggregatePreset = [
  aggregatePreset({
    columnId: "COL_ID_INVALID_OPTIONAL_PRESET",
    // @ts-expect-error Capability-bearing presets conservatively reject optional fields.
    field: "optionalPrice",
  }),
] satisfies BrunoTableColumns<GroupedPriceRow>;
void invalidOptionalAggregatePreset;

const nullableMinPreset = BrunoTableBigDecimalColumn.withDefaults({
  headerName: "Nullable minimum",
  aggFunc: "min",
});
const nullableMinFromPreset = [
  nullableMinPreset({
    columnId: "COL_ID_NULLABLE_MIN_PRESET",
    field: "nullablePrice",
  }),
] satisfies BrunoTableColumns<GroupedPriceRow>;
void nullableMinFromPreset;

const unsafeNullableMinPreset = BrunoTableBigDecimalColumn.withDefaults({
  headerName: "Unsafe nullable minimum",
  aggFunc: "min",
  aggregateValueFormatter: ({ value }) => BigDecimal.format(value),
});
const invalidUnsafeNullableMinPreset = [
  unsafeNullableMinPreset({
    columnId: "COL_ID_INVALID_NULLABLE_MIN_PRESET",
    // @ts-expect-error Inherited min presentation must be replaced for a nullable field.
    field: "nullablePrice",
  }),
] satisfies BrunoTableColumns<GroupedPriceRow>;
void invalidUnsafeNullableMinPreset;
const groupPreset = BrunoTableBigDecimalColumn.withDefaults({
  headerName: "Grouped price",
  groupBy: true,
  groupKeyValueFormatter: ({ value }) => BigDecimal.format(value),
});
const [ungroupedFromPreset] = [
  groupPreset({
    columnId: "COL_ID_PRESET_UNGROUPED",
    field: "price",
    groupBy: false,
  }),
] satisfies BrunoTableColumns<GroupedPriceRow>;
// @ts-expect-error Disabling groupBy removes the inherited group presentation capability.
ungroupedFromPreset.groupKeyValueFormatter({});

const invalidNullableGroupPreset = [
  groupPreset({
    columnId: "COL_ID_INVALID_NULLABLE_GROUP_PRESET",
    // @ts-expect-error Capability-bearing presets conservatively reject nullable fields.
    field: "nullablePrice",
  }),
] satisfies BrunoTableColumns<GroupedPriceRow>;
void invalidNullableGroupPreset;

const presentationFreeGroupPreset = BrunoTableBigDecimalColumn.withDefaults({
  headerName: "Nullable group",
  groupBy: true,
});
const nullableGroupFromPreset = [
  presentationFreeGroupPreset({
    columnId: "COL_ID_NULLABLE_GROUP_PRESET",
    field: "nullablePrice",
  }),
] satisfies BrunoTableColumns<GroupedPriceRow>;
void nullableGroupFromPreset;

const invalidAggregatePresentation = BrunoTableBigDecimalColumn({
  columnId: "COL_ID_INVALID_AGGREGATE",
  // @ts-expect-error Aggregate presentation requires one supported aggFunc.
  field: "price",
  headerName: "Invalid aggregate",
  aggregateCellClassName: "invalid",
});
void invalidAggregatePresentation;

// @ts-expect-error Effect-specific exports are isolated from the root package.
import { BrunoTableBigDecimalColumn as InvalidRootImport } from "@bruno/table";
void InvalidRootImport;
