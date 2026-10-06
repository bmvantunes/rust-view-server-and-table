import { BrunoTableComputedColumn } from "./public-types";
import { attachBrunoTableColumnHelperProvenance } from "./internal/column-helper-provenance";
import {
  attachBrunoTableSelectValueTypeProvenance,
  getBrunoTableSelectValueTypeFingerprint,
} from "./internal/select-value-type-provenance";

import type {
  BrunoTableBuiltInValueType,
  BrunoTableCellAlign,
  BrunoTableColumnId,
  BrunoTableColumnHelperOutput,
  BrunoTableColumnIdentityInput,
  BrunoTableComputedColumnDependencies,
  BrunoTableComputedColumnDefinition,
  BrunoTableComputedColumnInput,
  BrunoTableEditorLayout,
  BrunoTableFieldColumnDefinition,
  BrunoTableFieldColumnInput,
  BrunoTableFieldKey,
  BrunoTableJsonValue,
  BrunoTableNonEmptyFields,
  BrunoTableNonNullish,
  BrunoTableNumberFormat,
  BrunoTableOrdering,
  BrunoTableValueType,
} from "./public-types";
import type {
  EffectiveFieldPresetCapability,
  PresetEditingDefaults,
} from "./internal/preset-capability";

export type BrunoTableSelectValue = string | number | bigint | boolean;

export { getBrunoTableSelectValueTypeFingerprint };

// Select's configured option order is not an aggregate result contract.
// Keep its capability empty unless the descriptor implements explicit result semantics.
type InternalSelectValueType<TValue> = Omit<
  BrunoTableValueType<TValue, "select", "text", {}>,
  "editorFamily"
> & {
  readonly editorFamily: "select";
};

type FieldOfKind<TRow, TValueKind> = {
  readonly [TField in BrunoTableFieldKey<TRow>]: [BrunoTableNonNullish<TRow[TField]>] extends [
    never,
  ]
    ? never
    : [BrunoTableNonNullish<TRow[TField]>] extends [TValueKind]
      ? TField
      : never;
}[BrunoTableFieldKey<TRow>];

type Merge<TDefaults, TOptions> = Omit<TDefaults, keyof TOptions> & TOptions;

type ApplyDefaults<TOptions, TDefaults> = TOptions extends unknown
  ? Omit<TOptions, Extract<keyof TDefaults, keyof TOptions>> &
      Partial<Pick<TOptions, Extract<keyof TDefaults, keyof TOptions>>>
  : never;

type DistributiveOmit<TValue, TKey extends PropertyKey> = TValue extends unknown
  ? Omit<TValue, TKey>
  : never;

type OnlyKnownKeys<TActual, TAllowed> = {
  readonly [TKey in Exclude<keyof TActual, keyof TAllowed>]: never;
};

type FieldIdentity<TField extends PropertyKey, TColumnId extends BrunoTableColumnId> = {
  readonly columnId: BrunoTableColumnId<TColumnId>;
  readonly field: TField;
};

type NarrowFieldCapabilities<TColumn, TOptions> = TColumn extends { readonly field: string }
  ? TOptions extends { readonly groupBy: true }
    ? TOptions extends { readonly aggFunc: infer TAggFunc }
      ? TColumn extends { readonly groupBy: true; readonly aggFunc: TAggFunc }
        ? TColumn
        : never
      : TColumn extends { readonly groupBy: true; readonly aggFunc?: never }
        ? TColumn
        : never
    : TOptions extends { readonly aggFunc: infer TAggFunc }
      ? TColumn extends {
          readonly groupBy?: false | undefined;
          readonly aggFunc: TAggFunc;
        }
        ? TColumn
        : never
      : TColumn extends {
            readonly groupBy?: false | undefined;
            readonly aggFunc?: never;
          }
        ? TColumn
        : never
  : TColumn;

type HelperResult<TBuiltIn, TOptions, TColumn> = BrunoTableColumnHelperOutput<
  Merge<TBuiltIn, TOptions> & NarrowFieldCapabilities<TColumn, TOptions>
>;

type PresetResult<TBuiltIn, TDefaults, TOptions, TColumn> = BrunoTableColumnHelperOutput<
  Merge<Merge<TBuiltIn, TDefaults>, TOptions> &
    NarrowFieldCapabilities<TColumn, Merge<TDefaults, TOptions>>
>;

type FieldInput<
  TRow,
  TField extends BrunoTableFieldKey<TRow>,
  TValueType extends
    | BrunoTableBuiltInValueType
    | BrunoTableValueType<BrunoTableNonNullish<TRow[TField]>>
    | InternalSelectValueType<BrunoTableNonNullish<TRow[TField]>>,
  TColumnId extends BrunoTableColumnId = BrunoTableColumnId,
> = DistributiveOmit<
  BrunoTableFieldColumnInput<TRow, TField, TValueType, void, TColumnId>,
  "valueType"
>;

type ComputedOptions<
  TRow,
  TFields extends BrunoTableNonEmptyFields<TRow>,
  TValue,
  TValueType extends
    | BrunoTableBuiltInValueType
    | BrunoTableValueType<TValue>
    | InternalSelectValueType<TValue>,
> = Omit<
  BrunoTableComputedColumnInput<TRow, TFields, TValue, TValueType>,
  "fields" | "valueGetter" | "valueType"
>;

type BuiltInDefaults<
  TValueType extends BrunoTableBuiltInValueType,
  TCellAlign extends BrunoTableCellAlign,
  TEditorLayout extends BrunoTableEditorLayout,
  TWidth extends number,
> = {
  readonly valueType: TValueType;
  readonly cellAlign: TCellAlign;
  readonly editorLayout: TEditorLayout;
  readonly width: TWidth;
};

type TextBuiltIn = BuiltInDefaults<"text", "start", "inline", 160>;
type NumberBuiltIn = BuiltInDefaults<"number", "end", "inline", 120>;
type BigIntBuiltIn = BuiltInDefaults<"bigint", "end", "inline", 140>;
type BooleanBuiltIn = BuiltInDefaults<"boolean", "center", "center", 88>;

type PresetDefaults<TValue> = {
  readonly headerName?: string;
  readonly width?: number;
  readonly cellAlign?: BrunoTableCellAlign;
  readonly editorLayout?: BrunoTableEditorLayout;
  readonly enableFilter?: boolean;
  readonly enableSetFilter?: boolean;
  readonly enableSorting?: boolean;
  readonly cellClassName?: string;
} & PresetEditingDefaults<TValue>;

type NumberPresetDefaults = PresetDefaults<number> & {
  readonly format?: BrunoTableNumberFormat;
};

type FieldOnlyPresetKey =
  | "enableFilter"
  | "enableSetFilter"
  | "enableSorting"
  | "isEditable"
  | "blankValue"
  | "validate";

const fieldOnlyPresetKeyEvidence = {
  enableFilter: true,
  enableSetFilter: true,
  enableSorting: true,
  isEditable: true,
  blankValue: true,
  validate: true,
} as const satisfies Readonly<Record<FieldOnlyPresetKey, true>>;

const fieldOnlyPresetKeys = new Set<PropertyKey>(Reflect.ownKeys(fieldOnlyPresetKeyEvidence));

type ComputedPresetDefaults<TDefaults> = Omit<TDefaults, FieldOnlyPresetKey>;

type BuiltInColumnPreset<
  TValue,
  TValueType extends BrunoTableBuiltInValueType,
  TBuiltIn,
  TDefaults extends PresetDefaults<TValue>,
> = {
  <
    TRow,
    const TField extends FieldOfKind<TRow, TValue>,
    const TColumnId extends BrunoTableColumnId,
    const TOptions extends ApplyDefaults<
      FieldInput<TRow, TField, TValueType, TColumnId>,
      TDefaults
    >,
  >(
    options: TOptions &
      FieldIdentity<TField, TColumnId> &
      EffectiveFieldPresetCapability<TRow, TField, TDefaults, TOptions> &
      OnlyKnownKeys<TOptions, FieldInput<TRow, TField, TValueType, TColumnId>>,
  ): PresetResult<
    TBuiltIn,
    TDefaults,
    TOptions,
    BrunoTableFieldColumnDefinition<TRow, TField, TValueType, void, TColumnId>
  >;
  <
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TOptions extends ApplyDefaults<
      ComputedOptions<TRow, TFields, TValue, TValueType>,
      ComputedPresetDefaults<TDefaults>
    >,
  >(
    options: TOptions &
      BrunoTableColumnIdentityInput<TOptions> &
      BrunoTableComputedColumnDependencies<TRow, TFields, TValue> &
      OnlyKnownKeys<
        TOptions,
        ComputedOptions<TRow, TFields, TValue, TValueType> &
          BrunoTableComputedColumnDependencies<TRow, TFields, TValue>
      >,
  ): PresetResult<
    TBuiltIn,
    ComputedPresetDefaults<TDefaults>,
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, TValue>,
    BrunoTableComputedColumnDefinition<TRow, TFields, TValue, TValueType>
  >;
};

type BuiltInColumnHelper<
  TValue,
  TValueType extends BrunoTableBuiltInValueType,
  TBuiltIn,
  TPresetDefaults extends PresetDefaults<TValue>,
> = {
  <
    TRow,
    const TField extends FieldOfKind<TRow, TValue>,
    const TColumnId extends BrunoTableColumnId,
    const TOptions extends FieldInput<TRow, TField, TValueType, TColumnId>,
  >(
    options: TOptions &
      FieldIdentity<TField, TColumnId> &
      OnlyKnownKeys<TOptions, FieldInput<TRow, TField, TValueType, TColumnId>>,
  ): HelperResult<
    TBuiltIn,
    TOptions,
    BrunoTableFieldColumnDefinition<TRow, TField, TValueType, void, TColumnId>
  >;
  <
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TOptions extends ComputedOptions<TRow, TFields, TValue, TValueType>,
  >(
    options: TOptions &
      BrunoTableColumnIdentityInput<TOptions> &
      BrunoTableComputedColumnDependencies<TRow, TFields, TValue> &
      OnlyKnownKeys<
        TOptions,
        ComputedOptions<TRow, TFields, TValue, TValueType> &
          BrunoTableComputedColumnDependencies<TRow, TFields, TValue>
      >,
  ): HelperResult<
    TBuiltIn,
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, TValue>,
    BrunoTableComputedColumnDefinition<TRow, TFields, TValue, TValueType>
  >;
  readonly withDefaults: <const TDefaults extends TPresetDefaults>(
    defaults: TDefaults & OnlyKnownKeys<TDefaults, TPresetDefaults>,
  ) => BuiltInColumnPreset<TValue, TValueType, TBuiltIn, TDefaults>;
};

type RuntimeColumnOptions = Readonly<Record<PropertyKey, unknown>>;

const presetDefaultKeys = new Set<PropertyKey>([
  "headerName",
  "width",
  "cellAlign",
  "editorLayout",
  "enableFilter",
  "enableSetFilter",
  "enableSorting",
  "isEditable",
  "blankValue",
  "validate",
  "cellClassName",
]);
const numberPresetDefaultKeys = new Set<PropertyKey>([...presetDefaultKeys, "format"]);
const selectPresetDefaultKeys = new Set<PropertyKey>([...presetDefaultKeys, "options"]);
const commonColumnOptionKeys = new Set<PropertyKey>([
  "columnId",
  "headerName",
  "width",
  "pinned",
  "cellAlign",
  "editorLayout",
  "valueFormatter",
  "cellClassName",
  "cellRenderer",
]);
const fieldColumnOptionKeys = new Set<PropertyKey>([
  "field",
  "enableFilter",
  "enableSetFilter",
  "enableSorting",
  "isEditable",
  "blankValue",
  "validate",
  "groupBy",
  "groupKeyValueFormatter",
  "groupKeyCellClassName",
  "groupKeyCellRenderer",
  "aggFunc",
  "aggregateValueFormatter",
  "aggregateCellClassName",
  "aggregateCellRenderer",
]);
const computedColumnOptionKeys = new Set<PropertyKey>(["fields", "valueGetter"]);

const textBuiltInDefaults: TextBuiltIn = {
  valueType: "text",
  cellAlign: "start",
  editorLayout: "inline",
  width: 160,
};

const numberBuiltInDefaults: NumberBuiltIn = {
  valueType: "number",
  cellAlign: "end",
  editorLayout: "inline",
  width: 120,
};

const bigIntBuiltInDefaults: BigIntBuiltIn = {
  valueType: "bigint",
  cellAlign: "end",
  editorLayout: "inline",
  width: 140,
};

const booleanBuiltInDefaults: BooleanBuiltIn = {
  valueType: "boolean",
  cellAlign: "center",
  editorLayout: "center",
  width: 88,
};

function mergeRuntimeColumn(
  builtIn: RuntimeColumnOptions,
  defaults: RuntimeColumnOptions,
  options: RuntimeColumnOptions,
): RuntimeColumnOptions {
  if (Object.hasOwn(defaults, "valueType") || Object.hasOwn(options, "valueType")) {
    throw new TypeError("BrunoTable Column Helpers do not accept a valueType override.");
  }
  validateRuntimeColumnOptions(builtIn, options);
  const isComputed = isComputedColumnOptions(options);
  const effectiveDefaults = isComputed ? omitFieldOnlyPresetDefaults(defaults) : defaults;

  const builtInFormat = builtIn["format"];
  const defaultFormat = effectiveDefaults["format"];
  const optionFormat = options["format"];
  const builtInFormatRecord = validateRuntimeFormat(builtInFormat);
  const defaultFormatRecord = validateRuntimeFormat(defaultFormat);
  const optionFormatRecord = validateRuntimeFormat(optionFormat);
  const hasFormat =
    builtInFormat !== undefined || defaultFormat !== undefined || optionFormat !== undefined;
  const merged = {
    ...builtIn,
    ...effectiveDefaults,
    ...options,
    ...(hasFormat
      ? {
          format: {
            ...builtInFormatRecord,
            ...defaultFormatRecord,
            ...optionFormatRecord,
          },
        }
      : {}),
  };
  if (!isComputed) {
    validateRuntimeFieldCapabilities(merged);
  }

  const column = isComputed
    ? (BrunoTableComputedColumn(merged as never) as unknown as RuntimeColumnOptions)
    : merged;
  return attachBrunoTableColumnHelperProvenance(column);
}

function validateRuntimeFieldCapabilities(options: RuntimeColumnOptions): void {
  if (
    Object.hasOwn(options, "blankValue") &&
    options["isEditable"] !== true &&
    typeof options["isEditable"] !== "function"
  ) {
    throw new TypeError("BrunoTable blankValue requires potential field editability.");
  }
  if (
    Object.hasOwn(options, "validate") &&
    options["validate"] !== undefined &&
    typeof options["validate"] !== "function"
  ) {
    throw new TypeError("BrunoTable validate must be a function.");
  }
  if (
    typeof options["validate"] === "function" &&
    options["isEditable"] !== true &&
    typeof options["isEditable"] !== "function"
  ) {
    throw new TypeError("BrunoTable validate requires potential field editability.");
  }
  const hasGroupPresentation =
    Object.hasOwn(options, "groupKeyValueFormatter") ||
    Object.hasOwn(options, "groupKeyCellClassName") ||
    Object.hasOwn(options, "groupKeyCellRenderer");
  if (hasGroupPresentation && options["groupBy"] !== true) {
    throw new TypeError("BrunoTable group-key presentation requires groupBy: true.");
  }

  const hasAggregatePresentation =
    Object.hasOwn(options, "aggregateValueFormatter") ||
    Object.hasOwn(options, "aggregateCellClassName") ||
    Object.hasOwn(options, "aggregateCellRenderer");
  if (hasAggregatePresentation && typeof options["aggFunc"] !== "string") {
    throw new TypeError("BrunoTable aggregate presentation requires aggFunc.");
  }

  const aggFunc = options["aggFunc"];
  if (aggFunc === undefined) return;
  if (typeof aggFunc !== "string") {
    throw new TypeError("BrunoTable Column received an unsupported aggFunc.");
  }
  const valueType = options["valueType"];
  const supported = isRecord(valueType)
    ? isRecord(valueType["aggregateResults"]) &&
      Object.hasOwn(valueType["aggregateResults"], aggFunc)
    : valueType === "bigint"
      ? new Set(["countDistinct", "sum", "min", "max"]).has(aggFunc)
      : new Set(["countDistinct", "min", "max"]).has(aggFunc);
  if (!supported) {
    throw new TypeError(`BrunoTable ${String(valueType)} Column received an unsupported aggFunc.`);
  }
}

function isComputedColumnOptions(options: RuntimeColumnOptions): boolean {
  return Object.hasOwn(options, "fields") || Object.hasOwn(options, "valueGetter");
}

function omitFieldOnlyPresetDefaults(defaults: RuntimeColumnOptions): RuntimeColumnOptions {
  return Object.fromEntries(
    Reflect.ownKeys(defaults)
      .filter(
        (key) =>
          !fieldOnlyPresetKeys.has(key) &&
          key !== "groupBy" &&
          key !== "groupKeyValueFormatter" &&
          key !== "groupKeyCellClassName" &&
          key !== "groupKeyCellRenderer" &&
          key !== "aggFunc" &&
          key !== "aggregateValueFormatter" &&
          key !== "aggregateCellClassName" &&
          key !== "aggregateCellRenderer",
      )
      .map((key) => [key, defaults[key]]),
  );
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function BrunoTableTextColumnBase<
  TRow,
  TField extends FieldOfKind<TRow, string>,
  const TOptions extends FieldInput<TRow, TField, "text">,
>(
  options: TOptions,
): HelperResult<TextBuiltIn, TOptions, BrunoTableFieldColumnDefinition<TRow, TField, "text">>;
function BrunoTableTextColumnBase<
  TRow,
  const TFields extends BrunoTableNonEmptyFields<TRow>,
  const TOptions extends ComputedOptions<TRow, TFields, string, "text">,
>(
  options: TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, string>,
): HelperResult<
  TextBuiltIn,
  TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, string>,
  BrunoTableComputedColumnDefinition<TRow, TFields, string, "text">
>;
function BrunoTableTextColumnBase(options: RuntimeColumnOptions) {
  return mergeRuntimeColumn(textBuiltInDefaults, {}, options);
}

function BrunoTableTextColumnWithDefaults<const TDefaults extends PresetDefaults<string>>(
  defaults: TDefaults,
): BuiltInColumnPreset<string, "text", TextBuiltIn, TDefaults> {
  const defaultsSnapshot = snapshotPresetDefaults(defaults, presetDefaultKeys);
  function BrunoTableTextColumnPreset<
    TRow,
    TField extends FieldOfKind<TRow, string>,
    const TOptions extends ApplyDefaults<FieldInput<TRow, TField, "text">, TDefaults>,
  >(
    options: TOptions & EffectiveFieldPresetCapability<TRow, TField, TDefaults, TOptions>,
  ): PresetResult<
    TextBuiltIn,
    TDefaults,
    TOptions,
    BrunoTableFieldColumnDefinition<TRow, TField, "text">
  >;
  function BrunoTableTextColumnPreset<
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TOptions extends ApplyDefaults<
      ComputedOptions<TRow, TFields, string, "text">,
      ComputedPresetDefaults<TDefaults>
    >,
  >(
    options: TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, string>,
  ): PresetResult<
    TextBuiltIn,
    ComputedPresetDefaults<TDefaults>,
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, string>,
    BrunoTableComputedColumnDefinition<TRow, TFields, string, "text">
  >;
  function BrunoTableTextColumnPreset(options: RuntimeColumnOptions) {
    return mergeRuntimeColumn(textBuiltInDefaults, defaultsSnapshot, options);
  }

  return BrunoTableTextColumnPreset;
}

export const BrunoTableTextColumn: BuiltInColumnHelper<
  string,
  "text",
  TextBuiltIn,
  PresetDefaults<string>
> = Object.assign(BrunoTableTextColumnBase, {
  withDefaults: BrunoTableTextColumnWithDefaults,
});

function BrunoTableNumberColumnBase<
  TRow,
  TField extends FieldOfKind<TRow, number>,
  const TOptions extends FieldInput<TRow, TField, "number">,
>(
  options: TOptions,
): HelperResult<NumberBuiltIn, TOptions, BrunoTableFieldColumnDefinition<TRow, TField, "number">>;
function BrunoTableNumberColumnBase<
  TRow,
  const TFields extends BrunoTableNonEmptyFields<TRow>,
  const TOptions extends ComputedOptions<TRow, TFields, number, "number">,
>(
  options: TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, number>,
): HelperResult<
  NumberBuiltIn,
  TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, number>,
  BrunoTableComputedColumnDefinition<TRow, TFields, number, "number">
>;
function BrunoTableNumberColumnBase(options: RuntimeColumnOptions) {
  return mergeRuntimeColumn(numberBuiltInDefaults, {}, options);
}

function BrunoTableNumberColumnWithDefaults<const TDefaults extends NumberPresetDefaults>(
  defaults: TDefaults,
): BuiltInColumnPreset<number, "number", NumberBuiltIn, TDefaults> {
  const defaultsSnapshot = snapshotPresetDefaults(defaults, numberPresetDefaultKeys);
  function BrunoTableNumberColumnPreset<
    TRow,
    TField extends FieldOfKind<TRow, number>,
    const TOptions extends ApplyDefaults<FieldInput<TRow, TField, "number">, TDefaults>,
  >(
    options: TOptions & EffectiveFieldPresetCapability<TRow, TField, TDefaults, TOptions>,
  ): PresetResult<
    NumberBuiltIn,
    TDefaults,
    TOptions,
    BrunoTableFieldColumnDefinition<TRow, TField, "number">
  >;
  function BrunoTableNumberColumnPreset<
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TOptions extends ApplyDefaults<
      ComputedOptions<TRow, TFields, number, "number">,
      ComputedPresetDefaults<TDefaults>
    >,
  >(
    options: TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, number>,
  ): PresetResult<
    NumberBuiltIn,
    ComputedPresetDefaults<TDefaults>,
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, number>,
    BrunoTableComputedColumnDefinition<TRow, TFields, number, "number">
  >;
  function BrunoTableNumberColumnPreset(options: RuntimeColumnOptions) {
    return mergeRuntimeColumn(numberBuiltInDefaults, defaultsSnapshot, options);
  }

  return BrunoTableNumberColumnPreset;
}

export const BrunoTableNumberColumn: BuiltInColumnHelper<
  number,
  "number",
  NumberBuiltIn,
  NumberPresetDefaults
> = Object.assign(BrunoTableNumberColumnBase, {
  withDefaults: BrunoTableNumberColumnWithDefaults,
});

function BrunoTableBigIntColumnBase<
  TRow,
  TField extends FieldOfKind<TRow, bigint>,
  const TOptions extends FieldInput<TRow, TField, "bigint">,
>(
  options: TOptions,
): HelperResult<BigIntBuiltIn, TOptions, BrunoTableFieldColumnDefinition<TRow, TField, "bigint">>;
function BrunoTableBigIntColumnBase<
  TRow,
  const TFields extends BrunoTableNonEmptyFields<TRow>,
  const TOptions extends ComputedOptions<TRow, TFields, bigint, "bigint">,
>(
  options: TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, bigint>,
): HelperResult<
  BigIntBuiltIn,
  TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, bigint>,
  BrunoTableComputedColumnDefinition<TRow, TFields, bigint, "bigint">
>;
function BrunoTableBigIntColumnBase(options: RuntimeColumnOptions) {
  return mergeRuntimeColumn(bigIntBuiltInDefaults, {}, options);
}

function BrunoTableBigIntColumnWithDefaults<const TDefaults extends PresetDefaults<bigint>>(
  defaults: TDefaults,
): BuiltInColumnPreset<bigint, "bigint", BigIntBuiltIn, TDefaults> {
  const defaultsSnapshot = snapshotPresetDefaults(defaults, presetDefaultKeys);
  function BrunoTableBigIntColumnPreset<
    TRow,
    TField extends FieldOfKind<TRow, bigint>,
    const TOptions extends ApplyDefaults<FieldInput<TRow, TField, "bigint">, TDefaults>,
  >(
    options: TOptions & EffectiveFieldPresetCapability<TRow, TField, TDefaults, TOptions>,
  ): PresetResult<
    BigIntBuiltIn,
    TDefaults,
    TOptions,
    BrunoTableFieldColumnDefinition<TRow, TField, "bigint">
  >;
  function BrunoTableBigIntColumnPreset<
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TOptions extends ApplyDefaults<
      ComputedOptions<TRow, TFields, bigint, "bigint">,
      ComputedPresetDefaults<TDefaults>
    >,
  >(
    options: TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, bigint>,
  ): PresetResult<
    BigIntBuiltIn,
    ComputedPresetDefaults<TDefaults>,
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, bigint>,
    BrunoTableComputedColumnDefinition<TRow, TFields, bigint, "bigint">
  >;
  function BrunoTableBigIntColumnPreset(options: RuntimeColumnOptions) {
    return mergeRuntimeColumn(bigIntBuiltInDefaults, defaultsSnapshot, options);
  }

  return BrunoTableBigIntColumnPreset;
}

export const BrunoTableBigIntColumn: BuiltInColumnHelper<
  bigint,
  "bigint",
  BigIntBuiltIn,
  PresetDefaults<bigint>
> = Object.assign(BrunoTableBigIntColumnBase, {
  withDefaults: BrunoTableBigIntColumnWithDefaults,
});

function BrunoTableBooleanColumnBase<
  TRow,
  TField extends FieldOfKind<TRow, boolean>,
  const TOptions extends FieldInput<TRow, TField, "boolean">,
>(
  options: TOptions,
): HelperResult<BooleanBuiltIn, TOptions, BrunoTableFieldColumnDefinition<TRow, TField, "boolean">>;
function BrunoTableBooleanColumnBase<
  TRow,
  const TFields extends BrunoTableNonEmptyFields<TRow>,
  const TOptions extends ComputedOptions<TRow, TFields, boolean, "boolean">,
>(
  options: TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, boolean>,
): HelperResult<
  BooleanBuiltIn,
  TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, boolean>,
  BrunoTableComputedColumnDefinition<TRow, TFields, boolean, "boolean">
>;
function BrunoTableBooleanColumnBase(options: RuntimeColumnOptions) {
  return mergeRuntimeColumn(booleanBuiltInDefaults, {}, options);
}

function BrunoTableBooleanColumnWithDefaults<const TDefaults extends PresetDefaults<boolean>>(
  defaults: TDefaults,
): BuiltInColumnPreset<boolean, "boolean", BooleanBuiltIn, TDefaults> {
  const defaultsSnapshot = snapshotPresetDefaults(defaults, presetDefaultKeys);
  function BrunoTableBooleanColumnPreset<
    TRow,
    TField extends FieldOfKind<TRow, boolean>,
    const TOptions extends ApplyDefaults<FieldInput<TRow, TField, "boolean">, TDefaults>,
  >(
    options: TOptions & EffectiveFieldPresetCapability<TRow, TField, TDefaults, TOptions>,
  ): PresetResult<
    BooleanBuiltIn,
    TDefaults,
    TOptions,
    BrunoTableFieldColumnDefinition<TRow, TField, "boolean">
  >;
  function BrunoTableBooleanColumnPreset<
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TOptions extends ApplyDefaults<
      ComputedOptions<TRow, TFields, boolean, "boolean">,
      ComputedPresetDefaults<TDefaults>
    >,
  >(
    options: TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, boolean>,
  ): PresetResult<
    BooleanBuiltIn,
    ComputedPresetDefaults<TDefaults>,
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, boolean>,
    BrunoTableComputedColumnDefinition<TRow, TFields, boolean, "boolean">
  >;
  function BrunoTableBooleanColumnPreset(options: RuntimeColumnOptions) {
    return mergeRuntimeColumn(booleanBuiltInDefaults, defaultsSnapshot, options);
  }

  return BrunoTableBooleanColumnPreset;
}

export const BrunoTableBooleanColumn: BuiltInColumnHelper<
  boolean,
  "boolean",
  BooleanBuiltIn,
  PresetDefaults<boolean>
> = Object.assign(BrunoTableBooleanColumnBase, {
  withDefaults: BrunoTableBooleanColumnWithDefaults,
});

type NonEmptySelectOptions<TValue extends BrunoTableSelectValue = BrunoTableSelectValue> =
  readonly [TValue, ...TValue[]];

type SelectValueType<TValue> = InternalSelectValueType<TValue>;

type SelectBuiltIn<TValue> = {
  readonly valueType: SelectValueType<TValue>;
  readonly cellAlign: "start";
  readonly editorLayout: "fullWidth";
  readonly width: 160;
};

type ExactSelectDomain<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? unknown
    : never
  : never;

type SelectFieldInput<
  TRow,
  TField extends BrunoTableFieldKey<TRow>,
  TOptions extends NonEmptySelectOptions,
  TColumnId extends BrunoTableColumnId = BrunoTableColumnId,
> = DistributiveOmit<
  FieldInput<TRow, TField, SelectValueType<BrunoTableNonNullish<TRow[TField]>>, TColumnId>,
  "options"
> & {
  readonly options: TOptions;
};

type SelectComputedInput<
  TRow,
  TFields extends BrunoTableNonEmptyFields<TRow>,
  TOptions extends NonEmptySelectOptions,
> = ComputedOptions<TRow, TFields, TOptions[number], SelectValueType<TOptions[number]>> & {
  readonly options: TOptions;
};

type SelectPresetDefaults<TOptions extends NonEmptySelectOptions> = PresetDefaults<
  TOptions[number]
> & {
  readonly options: TOptions;
};

type SelectColumnPreset<
  TDefaultOptions extends NonEmptySelectOptions,
  TDefaults extends SelectPresetDefaults<TDefaultOptions>,
> = {
  <
    TRow,
    const TField extends FieldOfKind<TRow, TDefaultOptions[number]>,
    const TColumnId extends BrunoTableColumnId,
    const TOptions extends ApplyDefaults<
      SelectFieldInput<TRow, TField, TDefaultOptions, TColumnId>,
      TDefaults
    > & { readonly options?: never },
  >(
    options: TOptions &
      FieldIdentity<TField, TColumnId> &
      EffectiveFieldPresetCapability<TRow, TField, TDefaults, TOptions> &
      ExactSelectDomain<TDefaultOptions[number], BrunoTableNonNullish<TRow[TField]>> &
      OnlyKnownKeys<
        TOptions,
        ApplyDefaults<SelectFieldInput<TRow, TField, TDefaultOptions, TColumnId>, TDefaults>
      >,
  ): PresetResult<
    SelectBuiltIn<BrunoTableNonNullish<TRow[TField]>>,
    TDefaults,
    TOptions,
    BrunoTableFieldColumnDefinition<
      TRow,
      TField,
      SelectValueType<BrunoTableNonNullish<TRow[TField]>>,
      void,
      TColumnId
    >
  >;
  <
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TOptions extends ApplyDefaults<
      ComputedOptions<
        TRow,
        TFields,
        TDefaultOptions[number],
        SelectValueType<TDefaultOptions[number]>
      >,
      ComputedPresetDefaults<TDefaults>
    > & { readonly options?: never },
  >(
    options: TOptions &
      BrunoTableColumnIdentityInput<TOptions> &
      BrunoTableComputedColumnDependencies<TRow, TFields, TDefaultOptions[number]> &
      OnlyKnownKeys<
        TOptions,
        ComputedOptions<
          TRow,
          TFields,
          TDefaultOptions[number],
          SelectValueType<TDefaultOptions[number]>
        > &
          BrunoTableComputedColumnDependencies<TRow, TFields, TDefaultOptions[number]>
      >,
  ): PresetResult<
    SelectBuiltIn<TDefaultOptions[number]>,
    ComputedPresetDefaults<TDefaults>,
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, TDefaultOptions[number]>,
    BrunoTableComputedColumnDefinition<
      TRow,
      TFields,
      TDefaultOptions[number],
      SelectValueType<TDefaultOptions[number]>
    >
  >;
};

type SelectColumnHelper = {
  <
    TRow,
    const TSelectOptions extends NonEmptySelectOptions,
    const TField extends FieldOfKind<TRow, TSelectOptions[number]>,
    const TColumnId extends BrunoTableColumnId,
    const TOptions extends SelectFieldInput<TRow, TField, TSelectOptions, TColumnId>,
  >(
    options: TOptions &
      FieldIdentity<TField, TColumnId> & { readonly options: TSelectOptions } & ExactSelectDomain<
        TSelectOptions[number],
        BrunoTableNonNullish<TRow[TField]>
      > &
      OnlyKnownKeys<TOptions, SelectFieldInput<TRow, TField, TSelectOptions, TColumnId>>,
  ): HelperResult<
    SelectBuiltIn<BrunoTableNonNullish<TRow[TField]>>,
    TOptions,
    BrunoTableFieldColumnDefinition<
      TRow,
      TField,
      SelectValueType<BrunoTableNonNullish<TRow[TField]>>,
      void,
      TColumnId
    >
  >;
  <
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TSelectOptions extends NonEmptySelectOptions,
    const TOptions extends SelectComputedInput<TRow, TFields, TSelectOptions>,
  >(
    options: TOptions & { readonly options: TSelectOptions } & BrunoTableComputedColumnDependencies<
        TRow,
        TFields,
        TSelectOptions[number]
      > &
      BrunoTableColumnIdentityInput<TOptions> &
      OnlyKnownKeys<
        TOptions,
        SelectComputedInput<TRow, TFields, TSelectOptions> &
          BrunoTableComputedColumnDependencies<TRow, TFields, TSelectOptions[number]>
      >,
  ): HelperResult<
    SelectBuiltIn<TSelectOptions[number]>,
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, TSelectOptions[number]>,
    BrunoTableComputedColumnDefinition<
      TRow,
      TFields,
      TSelectOptions[number],
      SelectValueType<TSelectOptions[number]>
    >
  >;
  readonly withDefaults: <
    const TDefaultOptions extends NonEmptySelectOptions,
    const TDefaults extends SelectPresetDefaults<TDefaultOptions>,
  >(
    defaults: TDefaults & { readonly options: TDefaultOptions } & OnlyKnownKeys<
        TDefaults,
        SelectPresetDefaults<TDefaultOptions>
      >,
  ) => SelectColumnPreset<TDefaultOptions, TDefaults>;
};

function BrunoTableSelectColumnBase<
  TRow,
  const TSelectOptions extends NonEmptySelectOptions,
  TField extends FieldOfKind<TRow, TSelectOptions[number]>,
  const TOptions extends SelectFieldInput<TRow, TField, TSelectOptions>,
>(
  options: TOptions & { readonly options: TSelectOptions } & ExactSelectDomain<
      TSelectOptions[number],
      BrunoTableNonNullish<TRow[TField]>
    >,
): HelperResult<
  SelectBuiltIn<BrunoTableNonNullish<TRow[TField]>>,
  TOptions,
  BrunoTableFieldColumnDefinition<TRow, TField, SelectValueType<BrunoTableNonNullish<TRow[TField]>>>
>;
function BrunoTableSelectColumnBase<
  TRow,
  const TFields extends BrunoTableNonEmptyFields<TRow>,
  const TSelectOptions extends NonEmptySelectOptions,
  const TOptions extends SelectComputedInput<TRow, TFields, TSelectOptions>,
>(
  options: TOptions & { readonly options: TSelectOptions } & BrunoTableComputedColumnDependencies<
      TRow,
      TFields,
      TSelectOptions[number]
    >,
): HelperResult<
  SelectBuiltIn<TSelectOptions[number]>,
  TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, TSelectOptions[number]>,
  BrunoTableComputedColumnDefinition<
    TRow,
    TFields,
    TSelectOptions[number],
    SelectValueType<TSelectOptions[number]>
  >
>;
function BrunoTableSelectColumnBase(options: RuntimeColumnOptions) {
  return mergeSelectRuntimeColumn({}, options);
}

function BrunoTableSelectColumnWithDefaults<
  const TDefaultOptions extends NonEmptySelectOptions,
  const TDefaults extends SelectPresetDefaults<TDefaultOptions>,
>(
  defaults: TDefaults & { readonly options: TDefaultOptions },
): SelectColumnPreset<TDefaultOptions, TDefaults> {
  const defaultsSnapshot = snapshotPresetDefaults(defaults, selectPresetDefaultKeys);
  function BrunoTableSelectColumnPreset<
    TRow,
    TField extends FieldOfKind<TRow, TDefaultOptions[number]>,
    const TOptions extends ApplyDefaults<
      SelectFieldInput<TRow, TField, TDefaultOptions>,
      TDefaults
    > & { readonly options?: never },
  >(
    options: TOptions &
      EffectiveFieldPresetCapability<TRow, TField, TDefaults, TOptions> &
      ExactSelectDomain<TDefaultOptions[number], BrunoTableNonNullish<TRow[TField]>>,
  ): PresetResult<
    SelectBuiltIn<BrunoTableNonNullish<TRow[TField]>>,
    TDefaults,
    TOptions,
    BrunoTableFieldColumnDefinition<
      TRow,
      TField,
      SelectValueType<BrunoTableNonNullish<TRow[TField]>>
    >
  >;
  function BrunoTableSelectColumnPreset<
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TOptions extends ApplyDefaults<
      ComputedOptions<
        TRow,
        TFields,
        TDefaultOptions[number],
        SelectValueType<TDefaultOptions[number]>
      >,
      ComputedPresetDefaults<TDefaults>
    > & { readonly options?: never },
  >(
    options: TOptions &
      BrunoTableComputedColumnDependencies<TRow, TFields, TDefaultOptions[number]>,
  ): PresetResult<
    SelectBuiltIn<TDefaultOptions[number]>,
    ComputedPresetDefaults<TDefaults>,
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, TDefaultOptions[number]>,
    BrunoTableComputedColumnDefinition<
      TRow,
      TFields,
      TDefaultOptions[number],
      SelectValueType<TDefaultOptions[number]>
    >
  >;
  function BrunoTableSelectColumnPreset(options: RuntimeColumnOptions) {
    return mergeSelectRuntimeColumn(defaultsSnapshot, options);
  }

  return BrunoTableSelectColumnPreset;
}

export const BrunoTableSelectColumn: SelectColumnHelper = Object.assign(
  BrunoTableSelectColumnBase,
  {
    withDefaults: BrunoTableSelectColumnWithDefaults,
  },
);

function mergeSelectRuntimeColumn(
  defaults: RuntimeColumnOptions,
  options: RuntimeColumnOptions,
): RuntimeColumnOptions {
  if (Object.hasOwn(defaults, "options") && Object.hasOwn(options, "options")) {
    throw new TypeError(
      "BrunoTable Select Column preset options cannot be overridden at the column invocation.",
    );
  }
  const merged = { ...defaults, ...options };
  const selectOptions = merged["options"];

  if (!Array.isArray(selectOptions) || selectOptions.length === 0) {
    throw new TypeError("BrunoTable Select Column options must be a non-empty array.");
  }

  const optionsSnapshot = Object.freeze(Array.from(selectOptions));
  const valueType = createSelectValueType(optionsSnapshot);

  const column = mergeRuntimeColumn(
    {
      valueType,
      cellAlign: "start",
      editorLayout: "fullWidth",
      width: 160,
    },
    defaults,
    { ...options, options: optionsSnapshot },
  );
  return column;
}

function snapshotPresetDefaults(
  defaults: RuntimeColumnOptions,
  allowedKeys: ReadonlySet<PropertyKey>,
): RuntimeColumnOptions {
  for (const key of Reflect.ownKeys(defaults)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`BrunoTable Column Helper preset does not accept ${String(key)}.`);
    }
  }

  if (
    Object.hasOwn(defaults, "blankValue") &&
    defaults["isEditable"] !== true &&
    typeof defaults["isEditable"] !== "function"
  ) {
    throw new TypeError(
      "BrunoTable Column Helper preset blankValue requires potential editability.",
    );
  }
  if (
    Object.hasOwn(defaults, "validate") &&
    defaults["validate"] !== undefined &&
    typeof defaults["validate"] !== "function"
  ) {
    throw new TypeError("BrunoTable Column Helper preset validate must be a function.");
  }
  if (
    typeof defaults["validate"] === "function" &&
    defaults["isEditable"] !== true &&
    typeof defaults["isEditable"] !== "function"
  ) {
    throw new TypeError("BrunoTable Column Helper preset validate requires potential editability.");
  }

  const format = defaults["format"];
  const options = defaults["options"];
  validateRuntimeFormat(format);
  return Object.freeze({
    ...defaults,
    ...(isRecord(format) ? { format: Object.freeze({ ...format }) } : {}),
    ...(Array.isArray(options) ? { options: Object.freeze(Array.from(options)) } : {}),
  });
}

function validateRuntimeFormat(value: unknown): Readonly<Record<PropertyKey, unknown>> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new TypeError("BrunoTable Number Column format must be an object when provided.");
  }
  return value;
}

function validateRuntimeColumnOptions(
  builtIn: RuntimeColumnOptions,
  options: RuntimeColumnOptions,
): void {
  const isComputed = isComputedColumnOptions(options);
  const shapeKeys = isComputed ? computedColumnOptionKeys : fieldColumnOptionKeys;
  const valueType = builtIn["valueType"];
  const acceptsFormat = valueType === "number";
  const acceptsSelectOptions = isRecord(valueType) && valueType["filterFamily"] === "select";

  for (const key of Reflect.ownKeys(options)) {
    if (
      !commonColumnOptionKeys.has(key) &&
      !shapeKeys.has(key) &&
      !(key === "format" && acceptsFormat) &&
      !(key === "options" && acceptsSelectOptions)
    ) {
      throw new TypeError(`BrunoTable Column Helper does not accept ${String(key)}.`);
    }
  }
}

function createSelectValueType(options: readonly unknown[]): SelectValueType<unknown> {
  const kind = typeof options[0];
  if (!isSelectPrimitiveKind(kind) || options.some((option) => typeof option !== kind)) {
    throw new TypeError(
      "BrunoTable Select Column options must use one homogeneous string, number, bigint, or boolean domain.",
    );
  }

  if (
    kind === "number" &&
    options.some((option) => typeof option !== "number" || !Number.isFinite(option))
  ) {
    throw new TypeError("BrunoTable Select Column number options must be finite.");
  }

  const canonicalOptions = options.map(formatSelectCanonicalText);
  if (new Set(canonicalOptions).size !== canonicalOptions.length) {
    throw new TypeError("BrunoTable Select Column options must be semantically unique.");
  }

  type SelectOptionAdmission = Readonly<{
    readonly value: unknown;
    readonly index: number;
    readonly canonicalText: string;
  }>;
  const admissions = options.map(
    (value, index): SelectOptionAdmission =>
      Object.freeze({ value, index, canonicalText: canonicalOptions[index]! }),
  );
  const admissionByValue = new Map(admissions.map((admission) => [admission.value, admission]));
  const admissionByCanonicalText = new Map(
    admissions.map((admission) => [admission.canonicalText, admission]),
  );
  const requireAdmission = (input: unknown): SelectOptionAdmission => {
    const admission = admissionByValue.get(input);
    if (admission === undefined) {
      throw new TypeError("Value is not one of the configured Select options.");
    }
    return admission;
  };
  const decodeOption = (input: unknown) => {
    const admission = admissionByValue.get(input);
    return admission === undefined
      ? ({
          _tag: "Failure",
          message: "Value is not one of the configured Select options.",
        } as const)
      : ({ _tag: "Success", value: admission.value } as const);
  };

  const descriptor: SelectValueType<unknown> = {
    codecId: "@bruno/table/select",
    codecVersion: 1,
    filterFamily: "select",
    editorFamily: "select",
    cellAlign: "start",
    editorLayout: "fullWidth",
    defaultWidth: 160,
    decodeRuntime: decodeOption,
    equivalent: (left, right) => requireAdmission(left) === requireAdmission(right),
    compare: (left, right) =>
      compareIndexes(requireAdmission(left).index, requireAdmission(right).index),
    formatCanonicalText: (value) => requireAdmission(value).canonicalText,
    parseCanonicalText: (text) => {
      const admission = admissionByCanonicalText.get(text);
      return admission === undefined
        ? { _tag: "Failure", message: "Text is not one of the configured Select options." }
        : { _tag: "Success", value: admission.value };
    },
    formatDisplay: (value) => requireAdmission(value).canonicalText,
    encodePersisted: (value) => ({
      $brunoTableValue: "select",
      version: 1,
      value: encodeSelectPrimitive(requireAdmission(value).value),
    }),
    decodePersisted: (input) => {
      if (!isRecord(input) || input["$brunoTableValue"] !== "select" || input["version"] !== 1) {
        return { _tag: "Failure", message: "Persisted Select value has an invalid tag." };
      }
      return decodeOption(decodeSelectPrimitive(input["value"]));
    },
  };
  attachBrunoTableSelectValueTypeProvenance(descriptor, kind, canonicalOptions);
  return Object.freeze(descriptor);
}

function isSelectPrimitiveKind(kind: string): kind is "string" | "number" | "bigint" | "boolean" {
  return kind === "string" || kind === "number" || kind === "bigint" || kind === "boolean";
}

function formatSelectCanonicalText(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "bigint"
      ? value.toString(10)
      : String(value);
}

function compareIndexes(left: number, right: number): BrunoTableOrdering {
  return left === right ? 0 : left < right ? -1 : 1;
}

function encodeSelectPrimitive(value: unknown): BrunoTableJsonValue {
  switch (typeof value) {
    case "string":
      return { type: "string", value };
    case "number":
      return { type: "number", value: String(value) };
    case "bigint":
      return { type: "bigint", value: value.toString(10) };
    case "boolean":
      return { type: "boolean", value };
    default:
      throw new TypeError("BrunoTable Select Column cannot encode an unsupported value.");
  }
}

function decodeSelectPrimitive(input: unknown): unknown {
  if (!isRecord(input) || typeof input["type"] !== "string") {
    return undefined;
  }

  const value = input["value"];
  switch (input["type"]) {
    case "string":
      return typeof value === "string" ? value : undefined;
    case "number": {
      if (typeof value !== "string" || value.trim().length === 0) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case "bigint":
      return typeof value === "string" && /^-?\d+$/u.test(value) ? BigInt(value) : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    default:
      return undefined;
  }
}
