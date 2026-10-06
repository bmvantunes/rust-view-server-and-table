import {
  compareWireSafeBigDecimalComparisonMetadata,
  inspectWireSafeBigDecimal,
  trustedWireSafeBigDecimalComparisonMetadata,
} from "effect-view-server/value-semantics";
import type { WireSafeBigDecimalComparisonMetadata } from "effect-view-server/value-semantics";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";

import type { ReactNode } from "react";

import { attachBrunoTableColumnHelperProvenance } from "./internal/column-helper-provenance";
import {
  BrunoTableAggregateAlgebra,
  BrunoTableComputedColumn,
  BrunoTableServerBigDecimalValueType,
} from "./public-types";

import type {
  BrunoTableAggregateCellParams,
  BrunoTableAggregateResults,
  BrunoTableCellAlign,
  BrunoTableColumnId,
  BrunoTableColumnHelperOutput,
  BrunoTableColumnIdentityInput,
  BrunoTableComputedColumnDefinition,
  BrunoTableComputedColumnDependencies,
  BrunoTableComputedColumnInput,
  BrunoTableDecodeResult,
  BrunoTableEditorLayout,
  BrunoTableFieldColumnDefinition,
  BrunoTableFieldColumnInput,
  BrunoTableFieldKey,
  BrunoTableGroupKeyCellParams,
  BrunoTableNonEmptyFields,
  BrunoTableNonNullish,
  BrunoTableOrdering,
  BrunoTableServerBigDecimalValueTypeAuthority,
  BrunoTableValueType,
} from "./public-types";
import type {
  EffectiveFieldPresetCapability,
  PresetEditingDefaults,
} from "./internal/preset-capability";

const codecId = "@bruno/table/effect/bigdecimal";
const persistedType = "effect-bigdecimal";
const codecVersion = 1;
const maximumBigDecimalTextCodeUnits = 4_096;

type AdmittedBigDecimalState = {
  readonly comparisonMetadata: WireSafeBigDecimalComparisonMetadata;
  readonly canonicalText: string;
};

const admittedOwnedValues = new WeakMap<object, AdmittedBigDecimalState>();
const admittedSourceValues = new WeakMap<object, BigDecimal.BigDecimal>();

type BigDecimalAggregateResults = {
  readonly countDistinct: "bigint";
  readonly sum: "self";
  readonly min: "self";
  readonly max: "self";
  readonly avg: "self";
};

const bigDecimalAggregateAlgebra = BrunoTableAggregateAlgebra<BigDecimal.BigDecimal>({
  add: BigDecimal.sum,
  divideByCount: (total, count) => BigDecimal.divideUnsafe(total, BigDecimal.fromBigInt(count)),
});

function success<TValue>(value: TValue): BrunoTableDecodeResult<TValue> {
  return { _tag: "Success", value };
}

function failure(message: string): BrunoTableDecodeResult<never> {
  return { _tag: "Failure", message };
}

function admitBigDecimalParts(
  coefficient: bigint,
  sourceScale: number,
): BigDecimal.BigDecimal | undefined {
  const normalized = BigDecimal.normalize(BigDecimal.make(coefficient, sourceScale));
  if (!Number.isSafeInteger(normalized.scale)) return undefined;

  const owned = BigDecimal.make(normalized.value, normalized.scale);
  if (!Reflect.set(owned, "normalized", owned)) return undefined;
  Object.freeze(owned);

  const comparisonMetadata = trustedWireSafeBigDecimalComparisonMetadata(owned);
  if (comparisonMetadata === undefined) return undefined;
  const canonicalText = BigDecimal.format(owned);
  if (canonicalText.length > maximumBigDecimalTextCodeUnits) return undefined;
  admittedOwnedValues.set(owned, {
    canonicalText,
    comparisonMetadata,
  });
  return owned;
}

function admittedRuntimeBigDecimal(input: unknown): BigDecimal.BigDecimal | undefined {
  if (typeof input === "object" && input !== null) {
    if (admittedOwnedValues.has(input)) return input as BigDecimal.BigDecimal;
    const admitted = admittedSourceValues.get(input);
    if (admitted !== undefined) return admitted;
  }
  const inspection = inspectWireSafeBigDecimal(input);
  if (inspection._tag !== "Success") return undefined;
  const admitted = admitBigDecimalParts(inspection.coefficient, inspection.scale);
  if (admitted === undefined) return undefined;
  admittedSourceValues.set(inspection.source, admitted);
  return admitted;
}

function decodeRuntimeBigDecimal(input: unknown): BrunoTableDecodeResult<BigDecimal.BigDecimal> {
  const admitted = admittedRuntimeBigDecimal(input);
  return admitted === undefined
    ? failure("Expected a wire-safe Effect BigDecimal value.")
    : success(admitted);
}

function requireAdmittedBigDecimal(input: unknown): BigDecimal.BigDecimal {
  const admitted = admittedRuntimeBigDecimal(input);
  if (admitted === undefined) {
    throw new TypeError("BrunoTable BigDecimal Value Type received an invalid value.");
  }
  return admitted;
}

function requireAdmittedBigDecimalState(value: BigDecimal.BigDecimal): AdmittedBigDecimalState {
  const state = admittedOwnedValues.get(value);
  if (state === undefined) {
    throw new TypeError("BrunoTable BigDecimal Value Type received an invalid value.");
  }
  return state;
}

function requireCanonicalBigDecimalText(input: unknown): string {
  const admitted = requireAdmittedBigDecimal(input);
  return requireAdmittedBigDecimalState(admitted).canonicalText;
}

function compareBigDecimal(
  left: BigDecimal.BigDecimal,
  right: BigDecimal.BigDecimal,
): BrunoTableOrdering {
  const admittedLeft = requireAdmittedBigDecimal(left);
  const admittedRight = left === right ? admittedLeft : requireAdmittedBigDecimal(right);
  if (admittedLeft === admittedRight) return 0;
  const leftState = requireAdmittedBigDecimalState(admittedLeft);
  const rightState = requireAdmittedBigDecimalState(admittedRight);

  const comparison = compareWireSafeBigDecimalComparisonMetadata(
    leftState.comparisonMetadata,
    rightState.comparisonMetadata,
  );
  if (comparison === undefined || Number.isNaN(comparison)) {
    throw new TypeError("BrunoTable BigDecimal comparison metadata ownership was violated.");
  }
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
}

function parseBigDecimalText(text: string): BrunoTableDecodeResult<BigDecimal.BigDecimal> {
  if (typeof text !== "string") {
    return failure("Expected canonical BigDecimal text input.");
  }
  if (text.length > maximumBigDecimalTextCodeUnits) {
    return failure(
      `BigDecimal text must not exceed ${maximumBigDecimalTextCodeUnits} UTF-16 code units.`,
    );
  }
  if (text.trim().length === 0) {
    return failure("BigDecimal text must not be blank.");
  }

  const parsed = BigDecimal.fromString(text);
  if (Option.isNone(parsed)) {
    return failure("Expected exact decimal text.");
  }
  const decoded = decodeRuntimeBigDecimal(parsed.value);
  return decoded._tag === "Success"
    ? decoded
    : failure("The BigDecimal value is not safe for View Server transport.");
}

function decodePersistedText(input: unknown): BrunoTableDecodeResult<string> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return failure("Persisted Effect BigDecimal value has an invalid tag.");
    }
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== 3 ||
      !keys.includes("$brunoTableValue") ||
      !keys.includes("version") ||
      !keys.includes("value")
    ) {
      return failure("Persisted Effect BigDecimal value has an invalid tag.");
    }
    const values = new Map<PropertyKey, unknown>();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return failure("Persisted Effect BigDecimal value has an invalid tag.");
      }
      values.set(key, descriptor.value);
    }
    const value = values.get("value");
    return values.get("$brunoTableValue") === persistedType &&
      values.get("version") === codecVersion &&
      typeof value === "string"
      ? success(value)
      : failure("Persisted Effect BigDecimal value has an invalid tag.");
  } catch {
    return failure("Persisted Effect BigDecimal value has an invalid tag.");
  }
}

/** Exact Effect BigDecimal semantics compatible with effect-view-server's admitted wire domain. */
export const BrunoTableBigDecimalValueType: BrunoTableValueType<
  BigDecimal.BigDecimal,
  "numeric",
  "bigdecimal",
  BigDecimalAggregateResults
> &
  BrunoTableServerBigDecimalValueTypeAuthority & { readonly codecId: typeof codecId } =
  BrunoTableServerBigDecimalValueType({
    codecId,
    codecVersion,
    filterFamily: "numeric",
    editorFamily: "bigdecimal",
    cellAlign: "end",
    editorLayout: "inline",
    defaultWidth: 140,
    aggregateResults: Object.freeze({
      countDistinct: "bigint",
      sum: "self",
      min: "self",
      max: "self",
      avg: "self",
    } satisfies BrunoTableAggregateResults),
    aggregateAlgebra: bigDecimalAggregateAlgebra,
    decodeRuntime: decodeRuntimeBigDecimal,
    equivalent: (left: BigDecimal.BigDecimal, right: BigDecimal.BigDecimal): boolean =>
      compareBigDecimal(left, right) === 0,
    compare: compareBigDecimal,
    formatCanonicalText: requireCanonicalBigDecimalText,
    parseCanonicalText: parseBigDecimalText,
    formatDisplay: requireCanonicalBigDecimalText,
    encodePersisted: (value: BigDecimal.BigDecimal) => ({
      $brunoTableValue: persistedType,
      version: codecVersion,
      value: requireCanonicalBigDecimalText(value),
    }),
    decodePersisted: (input: unknown): BrunoTableDecodeResult<BigDecimal.BigDecimal> => {
      const decoded = decodePersistedText(input);
      return decoded._tag === "Success" ? parseBigDecimalText(decoded.value) : decoded;
    },
  });

type FieldOfBigDecimal<TRow> = {
  readonly [TField in BrunoTableFieldKey<TRow>]: [BrunoTableNonNullish<TRow[TField]>] extends [
    never,
  ]
    ? never
    : [BrunoTableNonNullish<TRow[TField]>] extends [BigDecimal.BigDecimal]
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

type BigDecimalBuiltInDefaults = {
  readonly valueType: typeof BrunoTableBigDecimalValueType;
  readonly cellAlign: "end";
  readonly editorLayout: "inline";
  readonly width: 140;
};

type BigDecimalFieldInput<
  TRow,
  TField extends FieldOfBigDecimal<TRow>,
  TColumnId extends BrunoTableColumnId,
> = DistributiveOmit<
  BrunoTableFieldColumnInput<TRow, TField, typeof BrunoTableBigDecimalValueType, void, TColumnId>,
  "valueType"
>;

type BigDecimalAggregateFieldInput<
  TRow,
  TField extends FieldOfBigDecimal<TRow>,
  TColumnId extends BrunoTableColumnId,
  TAggFunc extends keyof BigDecimalAggregateResults,
> = Extract<BigDecimalFieldInput<TRow, TField, TColumnId>, { readonly aggFunc: TAggFunc }>;

type BigDecimalGroupedFieldInput<
  TRow,
  TField extends FieldOfBigDecimal<TRow>,
  TColumnId extends BrunoTableColumnId,
> = Extract<BigDecimalFieldInput<TRow, TField, TColumnId>, { readonly groupBy: true }>;

type BigDecimalComputedOptions<TRow, TFields extends BrunoTableNonEmptyFields<TRow>> = Omit<
  BrunoTableComputedColumnInput<
    TRow,
    TFields,
    BigDecimal.BigDecimal,
    typeof BrunoTableBigDecimalValueType
  >,
  "fields" | "valueGetter" | "valueType"
>;

type BigDecimalGroupingPresetDefaults =
  | {
      readonly groupBy?: false | undefined;
      readonly groupKeyValueFormatter?: never;
      readonly groupKeyCellClassName?: never;
      readonly groupKeyCellRenderer?: never;
    }
  | {
      readonly groupBy: true;
      readonly groupKeyValueFormatter?: (
        parameters: BrunoTableGroupKeyCellParams<BigDecimal.BigDecimal, BrunoTableColumnId>,
      ) => string;
      readonly groupKeyCellClassName?:
        | string
        | ((
            parameters: BrunoTableGroupKeyCellParams<BigDecimal.BigDecimal, BrunoTableColumnId>,
          ) => string | undefined);
      readonly groupKeyCellRenderer?: (
        parameters: BrunoTableGroupKeyCellParams<BigDecimal.BigDecimal, BrunoTableColumnId>,
      ) => ReactNode;
    };

type BigDecimalAggregateValue<TAggFunc extends keyof BigDecimalAggregateResults> =
  TAggFunc extends "countDistinct" ? bigint : BigDecimal.BigDecimal;

type BigDecimalAggregationPresetDefaults =
  | {
      readonly aggFunc?: never;
      readonly aggregateValueFormatter?: never;
      readonly aggregateCellClassName?: never;
      readonly aggregateCellRenderer?: never;
    }
  | {
      readonly [TAggFunc in keyof BigDecimalAggregateResults]: {
        readonly aggFunc: TAggFunc;
        readonly aggregateValueFormatter?: (
          parameters: BrunoTableAggregateCellParams<
            TAggFunc,
            BigDecimalAggregateValue<TAggFunc>,
            BrunoTableColumnId
          >,
        ) => string;
        readonly aggregateCellClassName?:
          | string
          | ((
              parameters: BrunoTableAggregateCellParams<
                TAggFunc,
                BigDecimalAggregateValue<TAggFunc>,
                BrunoTableColumnId
              >,
            ) => string | undefined);
        readonly aggregateCellRenderer?: (
          parameters: BrunoTableAggregateCellParams<
            TAggFunc,
            BigDecimalAggregateValue<TAggFunc>,
            BrunoTableColumnId
          >,
        ) => ReactNode;
      };
    }[keyof BigDecimalAggregateResults];

type BigDecimalPresetEditingDefaults = PresetEditingDefaults<BigDecimal.BigDecimal>;

type BigDecimalPresetBaseDefaults = {
  readonly headerName?: string;
  readonly width?: number;
  readonly cellAlign?: BrunoTableCellAlign;
  readonly editorLayout?: BrunoTableEditorLayout;
  readonly enableFilter?: boolean;
  readonly enableSetFilter?: boolean;
  readonly enableSorting?: boolean;
  readonly cellClassName?: string;
} & BigDecimalPresetEditingDefaults;

type BrunoTableBigDecimalColumnPresetDefaults = BigDecimalPresetBaseDefaults &
  BigDecimalGroupingPresetDefaults &
  BigDecimalAggregationPresetDefaults;

type FieldOnlyPresetKey =
  | "enableFilter"
  | "enableSetFilter"
  | "enableSorting"
  | "isEditable"
  | "blankValue"
  | "validate"
  | "groupBy"
  | "groupKeyValueFormatter"
  | "groupKeyCellClassName"
  | "groupKeyCellRenderer"
  | "aggFunc"
  | "aggregateValueFormatter"
  | "aggregateCellClassName"
  | "aggregateCellRenderer";

const fieldOnlyPresetKeyEvidence = {
  enableFilter: true,
  enableSetFilter: true,
  enableSorting: true,
  isEditable: true,
  blankValue: true,
  validate: true,
  groupBy: true,
  groupKeyValueFormatter: true,
  groupKeyCellClassName: true,
  groupKeyCellRenderer: true,
  aggFunc: true,
  aggregateValueFormatter: true,
  aggregateCellClassName: true,
  aggregateCellRenderer: true,
} as const satisfies Readonly<Record<FieldOnlyPresetKey, true>>;

const fieldOnlyPresetKeys = new Set<PropertyKey>(Reflect.ownKeys(fieldOnlyPresetKeyEvidence));
type ComputedPresetDefaults<TDefaults> = Omit<TDefaults, FieldOnlyPresetKey>;

type GroupPresentationKey =
  | "groupKeyValueFormatter"
  | "groupKeyCellClassName"
  | "groupKeyCellRenderer";
type AggregatePresentationKey =
  | "aggregateValueFormatter"
  | "aggregateCellClassName"
  | "aggregateCellRenderer";

type EffectiveGroupingDefaults<TDefaults, TOptions> = TOptions extends {
  readonly groupBy: infer TGroupBy;
}
  ? TGroupBy extends true
    ? TDefaults
    : Omit<TDefaults, GroupPresentationKey>
  : TDefaults;

type EffectiveAggregateDefaults<TDefaults, TOptions> = TOptions extends {
  readonly aggFunc: infer TOptionAggFunc;
}
  ? TDefaults extends { readonly aggFunc: infer TDefaultAggFunc }
    ? [TOptionAggFunc] extends [TDefaultAggFunc]
      ? [TDefaultAggFunc] extends [TOptionAggFunc]
        ? TDefaults
        : Omit<TDefaults, AggregatePresentationKey>
      : Omit<TDefaults, AggregatePresentationKey>
    : TDefaults
  : TDefaults;

type EffectiveFieldPresetDefaults<TDefaults, TOptions> = EffectiveAggregateDefaults<
  EffectiveGroupingDefaults<TDefaults, TOptions>,
  TOptions
>;

type BigDecimalPresetResult<TDefaults, TOptions, TColumn> = BrunoTableColumnHelperOutput<
  Merge<Merge<BigDecimalBuiltInDefaults, TDefaults>, TOptions> & TColumn
>;

type UnreplacedPresetKeys<TDefaults, TOptions, TKeys extends PropertyKey> = Exclude<
  Extract<keyof TDefaults, TKeys>,
  keyof TOptions
>;

type BigDecimalPresetFieldCompatibility<TRow, TField extends keyof TRow, TDefaults, TOptions> = [
  TRow[TField],
] extends [BrunoTableNonNullish<TRow[TField]>]
  ? unknown
  : Merge<EffectiveFieldPresetDefaults<TDefaults, TOptions>, TOptions> extends infer TEffective
    ? TEffective extends { readonly aggFunc: "sum" | "avg" }
      ? { readonly field: never }
      : TEffective extends { readonly aggFunc: "min" | "max" }
        ? UnreplacedPresetKeys<TDefaults, TOptions, AggregatePresentationKey> extends never
          ? TEffective extends { readonly groupBy: true }
            ? UnreplacedPresetKeys<TDefaults, TOptions, GroupPresentationKey> extends never
              ? unknown
              : { readonly field: never }
            : unknown
          : { readonly field: never }
        : TEffective extends { readonly groupBy: true }
          ? UnreplacedPresetKeys<TDefaults, TOptions, GroupPresentationKey> extends never
            ? unknown
            : { readonly field: never }
          : unknown
    : never;

type BigDecimalHelperResult<TOptions, TColumn> = BrunoTableColumnHelperOutput<
  Merge<BigDecimalBuiltInDefaults, TOptions> & TColumn
>;

type BrunoTableBigDecimalColumnPreset<TDefaults extends BrunoTableBigDecimalColumnPresetDefaults> =
  {
    <
      TRow,
      const TField extends FieldOfBigDecimal<TRow>,
      const TColumnId extends BrunoTableColumnId,
      const TOptions extends ApplyDefaults<
        BigDecimalFieldInput<TRow, TField, TColumnId>,
        TDefaults
      >,
    >(
      options: TOptions &
        FieldIdentity<TField, TColumnId> &
        BigDecimalPresetFieldCompatibility<TRow, TField, TDefaults, TOptions> &
        EffectiveFieldPresetCapability<TRow, TField, TDefaults, TOptions> &
        OnlyKnownKeys<TOptions, BigDecimalFieldInput<TRow, TField, TColumnId>>,
    ): BigDecimalPresetResult<
      EffectiveFieldPresetDefaults<TDefaults, TOptions>,
      TOptions,
      BrunoTableFieldColumnDefinition<
        TRow,
        TField,
        typeof BrunoTableBigDecimalValueType,
        Merge<EffectiveFieldPresetDefaults<TDefaults, TOptions>, TOptions>,
        TColumnId
      >
    >;
    <
      TRow,
      const TFields extends BrunoTableNonEmptyFields<TRow>,
      const TOptions extends ApplyDefaults<
        BigDecimalComputedOptions<TRow, TFields>,
        ComputedPresetDefaults<TDefaults>
      >,
    >(
      options: TOptions &
        BrunoTableColumnIdentityInput<TOptions> &
        BrunoTableComputedColumnDependencies<TRow, TFields, BigDecimal.BigDecimal> &
        OnlyKnownKeys<
          TOptions,
          BigDecimalComputedOptions<TRow, TFields> &
            BrunoTableComputedColumnDependencies<TRow, TFields, BigDecimal.BigDecimal>
        >,
    ): BigDecimalPresetResult<
      ComputedPresetDefaults<TDefaults>,
      TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, BigDecimal.BigDecimal>,
      BrunoTableComputedColumnDefinition<
        TRow,
        TFields,
        BigDecimal.BigDecimal,
        typeof BrunoTableBigDecimalValueType
      >
    >;
  };

type BrunoTableBigDecimalColumnHelper = {
  <
    TRow,
    const TField extends FieldOfBigDecimal<TRow>,
    const TColumnId extends BrunoTableColumnId,
    const TAggFunc extends keyof BigDecimalAggregateResults,
    const TOptions extends BigDecimalAggregateFieldInput<TRow, TField, TColumnId, TAggFunc> &
      BigDecimalGroupedFieldInput<TRow, TField, TColumnId>,
  >(
    options: TOptions &
      FieldIdentity<TField, TColumnId> &
      OnlyKnownKeys<TOptions, BigDecimalFieldInput<TRow, TField, TColumnId>>,
  ): BigDecimalHelperResult<
    TOptions,
    BrunoTableFieldColumnDefinition<
      TRow,
      TField,
      typeof BrunoTableBigDecimalValueType,
      TOptions,
      TColumnId
    >
  >;
  <
    TRow,
    const TField extends FieldOfBigDecimal<TRow>,
    const TColumnId extends BrunoTableColumnId,
    const TAggFunc extends keyof BigDecimalAggregateResults,
    const TOptions extends BigDecimalAggregateFieldInput<TRow, TField, TColumnId, TAggFunc>,
  >(
    options: TOptions &
      FieldIdentity<TField, TColumnId> &
      OnlyKnownKeys<TOptions, BigDecimalFieldInput<TRow, TField, TColumnId>>,
  ): BigDecimalHelperResult<
    TOptions,
    BrunoTableFieldColumnDefinition<
      TRow,
      TField,
      typeof BrunoTableBigDecimalValueType,
      TOptions,
      TColumnId
    >
  >;
  <
    TRow,
    const TField extends FieldOfBigDecimal<TRow>,
    const TColumnId extends BrunoTableColumnId,
    const TOptions extends BigDecimalGroupedFieldInput<TRow, TField, TColumnId>,
  >(
    options: TOptions &
      FieldIdentity<TField, TColumnId> &
      OnlyKnownKeys<TOptions, BigDecimalFieldInput<TRow, TField, TColumnId>>,
  ): BigDecimalHelperResult<
    TOptions,
    BrunoTableFieldColumnDefinition<
      TRow,
      TField,
      typeof BrunoTableBigDecimalValueType,
      TOptions,
      TColumnId
    >
  >;
  <
    TRow,
    const TField extends FieldOfBigDecimal<TRow>,
    const TColumnId extends BrunoTableColumnId,
    const TOptions extends BigDecimalFieldInput<TRow, TField, TColumnId>,
  >(
    options: TOptions &
      FieldIdentity<TField, TColumnId> &
      OnlyKnownKeys<TOptions, BigDecimalFieldInput<TRow, TField, TColumnId>>,
  ): BigDecimalHelperResult<
    TOptions,
    BrunoTableFieldColumnDefinition<
      TRow,
      TField,
      typeof BrunoTableBigDecimalValueType,
      TOptions,
      TColumnId
    >
  >;
  <
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TOptions extends BigDecimalComputedOptions<TRow, TFields>,
  >(
    options: TOptions &
      BrunoTableColumnIdentityInput<TOptions> &
      BrunoTableComputedColumnDependencies<TRow, TFields, BigDecimal.BigDecimal> &
      OnlyKnownKeys<
        TOptions,
        BigDecimalComputedOptions<TRow, TFields> &
          BrunoTableComputedColumnDependencies<TRow, TFields, BigDecimal.BigDecimal>
      >,
  ): BigDecimalHelperResult<
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, BigDecimal.BigDecimal>,
    BrunoTableComputedColumnDefinition<
      TRow,
      TFields,
      BigDecimal.BigDecimal,
      typeof BrunoTableBigDecimalValueType
    >
  >;
  readonly withDefaults: <const TDefaults extends BrunoTableBigDecimalColumnPresetDefaults>(
    defaults: TDefaults & OnlyKnownKeys<TDefaults, BrunoTableBigDecimalColumnPresetDefaults>,
  ) => BrunoTableBigDecimalColumnPreset<TDefaults>;
};

type RuntimeColumnOptions = Readonly<Record<PropertyKey, unknown>>;

const builtInDefaults: BigDecimalBuiltInDefaults = {
  valueType: BrunoTableBigDecimalValueType,
  cellAlign: "end",
  editorLayout: "inline",
  width: 140,
};

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
  "groupBy",
  "groupKeyValueFormatter",
  "groupKeyCellClassName",
  "groupKeyCellRenderer",
  "aggFunc",
  "aggregateValueFormatter",
  "aggregateCellClassName",
  "aggregateCellRenderer",
]);

const commonOptionKeys = new Set<PropertyKey>([
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
const fieldOptionKeys = new Set<PropertyKey>([
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
const computedOptionKeys = new Set<PropertyKey>(["fields", "valueGetter"]);

function isRecord(value: unknown): value is RuntimeColumnOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isComputedColumnOptions(options: RuntimeColumnOptions): boolean {
  return Object.hasOwn(options, "fields") || Object.hasOwn(options, "valueGetter");
}

function omitFieldOnlyDefaults(defaults: RuntimeColumnOptions): RuntimeColumnOptions {
  return Object.fromEntries(
    Reflect.ownKeys(defaults)
      .filter((key) => !fieldOnlyPresetKeys.has(key))
      .map((key) => [key, defaults[key]]),
  );
}

function omitIncompatiblePresentationDefaults(
  defaults: RuntimeColumnOptions,
  options: RuntimeColumnOptions,
): RuntimeColumnOptions {
  const groupByChanged =
    Object.hasOwn(options, "groupBy") &&
    options["groupBy"] !== true &&
    defaults["groupBy"] === true;
  const aggFuncChanged =
    Object.hasOwn(options, "aggFunc") &&
    defaults["aggFunc"] !== undefined &&
    options["aggFunc"] !== defaults["aggFunc"];
  if (!groupByChanged && !aggFuncChanged) return defaults;

  return Object.fromEntries(
    Reflect.ownKeys(defaults)
      .filter(
        (key) =>
          (!groupByChanged ||
            (key !== "groupKeyValueFormatter" &&
              key !== "groupKeyCellClassName" &&
              key !== "groupKeyCellRenderer")) &&
          (!aggFuncChanged ||
            (key !== "aggregateValueFormatter" &&
              key !== "aggregateCellClassName" &&
              key !== "aggregateCellRenderer")),
      )
      .map((key) => [key, defaults[key]]),
  );
}

function validateCapabilityCombination(options: RuntimeColumnOptions): void {
  if (
    Object.hasOwn(options, "blankValue") &&
    options["isEditable"] !== true &&
    typeof options["isEditable"] !== "function"
  ) {
    throw new TypeError("BrunoTable BigDecimal blankValue requires potential field editability.");
  }
  if (
    Object.hasOwn(options, "validate") &&
    options["validate"] !== undefined &&
    typeof options["validate"] !== "function"
  ) {
    throw new TypeError("BrunoTable BigDecimal validate must be a function.");
  }
  if (
    typeof options["validate"] === "function" &&
    options["isEditable"] !== true &&
    typeof options["isEditable"] !== "function"
  ) {
    throw new TypeError("BrunoTable BigDecimal validate requires potential field editability.");
  }
  const hasGroupPresentation =
    Object.hasOwn(options, "groupKeyValueFormatter") ||
    Object.hasOwn(options, "groupKeyCellClassName") ||
    Object.hasOwn(options, "groupKeyCellRenderer");
  if (hasGroupPresentation && options["groupBy"] !== true) {
    throw new TypeError("BrunoTable BigDecimal group-key presentation requires groupBy: true.");
  }

  const hasAggregatePresentation =
    Object.hasOwn(options, "aggregateValueFormatter") ||
    Object.hasOwn(options, "aggregateCellClassName") ||
    Object.hasOwn(options, "aggregateCellRenderer");
  if (hasAggregatePresentation && typeof options["aggFunc"] !== "string") {
    throw new TypeError("BrunoTable BigDecimal aggregate presentation requires aggFunc.");
  }
  if (
    options["aggFunc"] !== undefined &&
    options["aggFunc"] !== "countDistinct" &&
    options["aggFunc"] !== "sum" &&
    options["aggFunc"] !== "min" &&
    options["aggFunc"] !== "max" &&
    options["aggFunc"] !== "avg"
  ) {
    throw new TypeError("BrunoTable BigDecimal Column Helper received an unsupported aggFunc.");
  }
}

function validateColumnOptions(options: RuntimeColumnOptions): void {
  if (Object.hasOwn(options, "valueType")) {
    throw new TypeError(
      "BrunoTable BigDecimal Column Helper does not accept a valueType override.",
    );
  }
  const isComputed = isComputedColumnOptions(options);
  const allowed = isComputed
    ? new Set([...commonOptionKeys, ...computedOptionKeys])
    : new Set([...commonOptionKeys, ...fieldOptionKeys]);
  for (const key of Reflect.ownKeys(options)) {
    if (!allowed.has(key)) {
      throw new TypeError(`BrunoTable BigDecimal Column Helper does not accept ${String(key)}.`);
    }
  }
}

function mergeColumnOptions(
  defaults: RuntimeColumnOptions,
  options: RuntimeColumnOptions,
): RuntimeColumnOptions {
  validateColumnOptions(options);
  const isComputed = isComputedColumnOptions(options);
  const effectiveDefaults = isComputed
    ? omitFieldOnlyDefaults(defaults)
    : omitIncompatiblePresentationDefaults(defaults, options);
  const merged = {
    ...builtInDefaults,
    ...effectiveDefaults,
    ...options,
  };
  validateCapabilityCombination(merged);
  if (!isComputed) return attachBrunoTableColumnHelperProvenance(merged);

  const computed: unknown = Reflect.apply(BrunoTableComputedColumn, undefined, [merged]);
  if (!isRecord(computed)) {
    throw new TypeError("BrunoTable BigDecimal computed-column construction failed.");
  }
  return attachBrunoTableColumnHelperProvenance(computed);
}

function snapshotPresetDefaults(input: unknown): RuntimeColumnOptions {
  if (!isRecord(input)) {
    throw new TypeError("BrunoTable BigDecimal Column preset defaults must be an object.");
  }
  for (const key of Reflect.ownKeys(input)) {
    if (!presetDefaultKeys.has(key)) {
      throw new TypeError(`BrunoTable BigDecimal Column preset does not accept ${String(key)}.`);
    }
  }
  const snapshot = { ...input };
  validateCapabilityCombination(snapshot);
  return Object.freeze(snapshot);
}

function BrunoTableBigDecimalColumnBase(options: RuntimeColumnOptions) {
  return mergeColumnOptions({}, options);
}

function BrunoTableBigDecimalColumnWithDefaults<
  const TDefaults extends BrunoTableBigDecimalColumnPresetDefaults,
>(defaults: TDefaults): BrunoTableBigDecimalColumnPreset<TDefaults> {
  const snapshot = snapshotPresetDefaults(defaults);
  function BrunoTableBigDecimalColumnPreset<
    TRow,
    const TField extends FieldOfBigDecimal<TRow>,
    const TColumnId extends BrunoTableColumnId,
    const TOptions extends ApplyDefaults<BigDecimalFieldInput<TRow, TField, TColumnId>, TDefaults>,
  >(
    options: TOptions &
      FieldIdentity<TField, TColumnId> &
      BigDecimalPresetFieldCompatibility<TRow, TField, TDefaults, TOptions> &
      EffectiveFieldPresetCapability<TRow, TField, TDefaults, TOptions> &
      OnlyKnownKeys<TOptions, BigDecimalFieldInput<TRow, TField, TColumnId>>,
  ): BigDecimalPresetResult<
    EffectiveFieldPresetDefaults<TDefaults, TOptions>,
    TOptions,
    BrunoTableFieldColumnDefinition<
      TRow,
      TField,
      typeof BrunoTableBigDecimalValueType,
      Merge<EffectiveFieldPresetDefaults<TDefaults, TOptions>, TOptions>,
      TColumnId
    >
  >;
  function BrunoTableBigDecimalColumnPreset<
    TRow,
    const TFields extends BrunoTableNonEmptyFields<TRow>,
    const TOptions extends ApplyDefaults<
      BigDecimalComputedOptions<TRow, TFields>,
      ComputedPresetDefaults<TDefaults>
    >,
  >(
    options: TOptions &
      BrunoTableComputedColumnDependencies<TRow, TFields, BigDecimal.BigDecimal> &
      OnlyKnownKeys<
        TOptions,
        BigDecimalComputedOptions<TRow, TFields> &
          BrunoTableComputedColumnDependencies<TRow, TFields, BigDecimal.BigDecimal>
      >,
  ): BigDecimalPresetResult<
    ComputedPresetDefaults<TDefaults>,
    TOptions & BrunoTableComputedColumnDependencies<TRow, TFields, BigDecimal.BigDecimal>,
    BrunoTableComputedColumnDefinition<
      TRow,
      TFields,
      BigDecimal.BigDecimal,
      typeof BrunoTableBigDecimalValueType
    >
  >;
  function BrunoTableBigDecimalColumnPreset(options: RuntimeColumnOptions): RuntimeColumnOptions {
    return mergeColumnOptions(snapshot, options);
  }

  return BrunoTableBigDecimalColumnPreset;
}

/** Creates an ordinary exact BigDecimal Column Definition with coherent numeric defaults. */
export const BrunoTableBigDecimalColumn: BrunoTableBigDecimalColumnHelper = Object.assign(
  BrunoTableBigDecimalColumnBase,
  { withDefaults: BrunoTableBigDecimalColumnWithDefaults },
);
