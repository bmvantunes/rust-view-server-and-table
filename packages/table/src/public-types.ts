import type {
  LiveQueryViewportBaseRow,
  LiveQueryViewportCompleteRawSelect,
  LiveQueryViewportQueryAuthority,
  LiveQueryViewportRouteBy,
  LiveQueryViewportWhere,
} from "effect-view-server/react/viewport-base-row";
import type { ReactNode } from "react";

import type { BrunoTableColumnHelperProvenanceCarrier } from "./internal/column-helper-provenance";

type ColumnIdFirstCharacter =
  | "_"
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z";

type ColumnIdWhitespace =
  | "\t"
  | "\n"
  | "\v"
  | "\f"
  | "\r"
  | " "
  | "\u00a0"
  | "\u1680"
  | "\u2000"
  | "\u2001"
  | "\u2002"
  | "\u2003"
  | "\u2004"
  | "\u2005"
  | "\u2006"
  | "\u2007"
  | "\u2008"
  | "\u2009"
  | "\u200a"
  | "\u2028"
  | "\u2029"
  | "\u202f"
  | "\u205f"
  | "\u3000"
  | "\ufeff";
type ColumnIdPattern = `COL_ID_${ColumnIdFirstCharacter}${Uppercase<string>}`;
type BrunoTableRowsSystemColumnId = "COL_ID_BRUNO_TABLE_ROWS";
type BrunoTableReservedColumnId = BrunoTableRowsSystemColumnId | "COL_ID_BRUNO_TABLE_ROW_SELECTION";

export type BrunoTableColumnId<TColumnId extends ColumnIdPattern = ColumnIdPattern> =
  TColumnId extends BrunoTableReservedColumnId
    ? never
    : TColumnId extends `${string}${ColumnIdWhitespace}${string}`
      ? never
      : TColumnId;

/** @internal Applies literal Column Identity validation at inference boundaries. */
export type BrunoTableColumnIdentityInput<TOptions> = TOptions extends {
  readonly columnId: infer TColumnId extends ColumnIdPattern;
}
  ? { readonly columnId: BrunoTableColumnId<TColumnId> }
  : unknown;

export type BrunoTableRowId = string;

export type BrunoTableBuiltInValueType = "text" | "number" | "bigint" | "boolean";

export type BrunoTableOrdering = -1 | 0 | 1;

export type BrunoTableAggFunc = "countDistinct" | "sum" | "min" | "max" | "avg";

export type BrunoTableAggregateResultKind = "self" | "bigint";

export type BrunoTableAggregateResults = Readonly<{
  readonly countDistinct?: "bigint";
  readonly sum?: "self";
  readonly min?: "self";
  readonly max?: "self";
  readonly avg?: "self";
}>;

const brunoTableAggregateAlgebraBrand: unique symbol = Symbol("BrunoTableAggregateAlgebra");

const brunoTableServerBigDecimalValueTypes = new WeakSet<object>();

/** @internal Nominal authority installed only by the optional Effect entry point. */
export declare class BrunoTableServerBigDecimalValueTypeAuthority {
  private readonly brunoTableServerBigDecimalValueTypeAuthority;
}

/** @internal Brands the one source-compatible Effect BigDecimal descriptor. */
export function BrunoTableServerBigDecimalValueType<TValueType extends object>(
  valueType: TValueType,
): TValueType & BrunoTableServerBigDecimalValueTypeAuthority {
  brunoTableServerBigDecimalValueTypes.add(valueType);
  return Object.freeze(valueType) as TValueType & BrunoTableServerBigDecimalValueTypeAuthority;
}

/** @internal Tests runtime source-compatible aggregate authority without trusting public data. */
export function isBrunoTableServerBigDecimalValueType(
  valueType: unknown,
): valueType is BrunoTableServerBigDecimalValueTypeAuthority {
  return (
    typeof valueType === "object" &&
    valueType !== null &&
    brunoTableServerBigDecimalValueTypes.has(valueType)
  );
}

/** Exact arithmetic owned by a custom Value Type rather than a Column Definition. */
export type BrunoTableAggregateAlgebra<TValue> = Readonly<{
  readonly [brunoTableAggregateAlgebraBrand]: true;
  readonly add: (this: void, left: TValue, right: TValue) => TValue;
  readonly divideByCount?: (this: void, total: TValue, count: bigint) => TValue;
}>;

type BrunoTableAggregateAlgebraInput<TValue> = Readonly<{
  readonly add: (this: void, left: TValue, right: TValue) => TValue;
  readonly divideByCount?: (this: void, total: TValue, count: bigint) => TValue;
}>;

/** Brands and snapshots one exact Value-Type aggregate algebra. */
export function BrunoTableAggregateAlgebra<TValue>(
  algebra: BrunoTableAggregateAlgebraInput<TValue> &
    Required<Pick<BrunoTableAggregateAlgebraInput<TValue>, "divideByCount">>,
): BrunoTableAggregateAlgebra<TValue> &
  Required<Pick<BrunoTableAggregateAlgebra<TValue>, "divideByCount">>;
export function BrunoTableAggregateAlgebra<TValue>(
  algebra: BrunoTableAggregateAlgebraInput<TValue>,
): BrunoTableAggregateAlgebra<TValue>;
export function BrunoTableAggregateAlgebra<TValue>(
  algebra: BrunoTableAggregateAlgebraInput<TValue>,
): BrunoTableAggregateAlgebra<TValue> {
  if (typeof algebra !== "object" || algebra === null || Array.isArray(algebra)) {
    throw new TypeError("BrunoTable Aggregate Algebra must be an object.");
  }
  const add = ownDataFunction(algebra, "add");
  const divideByCount = ownOptionalDataFunction(algebra, "divideByCount");
  if (add === undefined) {
    throw new TypeError("BrunoTable Aggregate Algebra requires an exact add operation.");
  }
  const snapshot = { add, ...(divideByCount === undefined ? {} : { divideByCount }) };
  Object.defineProperty(snapshot, brunoTableAggregateAlgebraBrand, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return Object.freeze(snapshot) as BrunoTableAggregateAlgebra<TValue>;
}

function ownDataFunction(
  value: object,
  key: "add",
): ((this: void, ...parameters: never[]) => unknown) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function"
    ? descriptor.value
    : undefined;
}

function ownOptionalDataFunction(
  value: object,
  key: "divideByCount",
): ((this: void, ...parameters: never[]) => unknown) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  return "value" in descriptor && typeof descriptor.value === "function"
    ? descriptor.value
    : undefined;
}

export type BrunoTableDecodeResult<TValue> =
  | { readonly _tag: "Success"; readonly value: TValue }
  | { readonly _tag: "Failure"; readonly message: string };

export type BrunoTableJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly BrunoTableJsonValue[]
  | { readonly [key: string]: BrunoTableJsonValue };

export type BrunoTableFilterFamily = "boolean" | "equality" | "numeric" | "select" | "text";

export type BrunoTableEditorFamily =
  | "bigdecimal"
  | "bigint"
  | "boolean"
  | "number"
  | "select"
  | "text";

export type BrunoTableCellAlign = "start" | "center" | "end";

export type BrunoTableEditorLayout = "inline" | "center" | "fullWidth";

export type BrunoTableNumberFormat = Intl.NumberFormatOptions;

/**
 * One explicit runtime value domain. BrunoTable snapshots this descriptor into a private compiled
 * plan during column normalization; mounted cells never discover or dispatch value kinds.
 */
type BrunoTableEditorCapability<
  TValue,
  TEditorFamily extends Exclude<BrunoTableEditorFamily, "select">,
> = TEditorFamily extends "boolean"
  ? {
      readonly editorFamily: "boolean";
      /** Exact false-state and true-state values used by the native Boolean editor. */
      readonly booleanEditorValues: readonly [falseValue: TValue, trueValue: TValue];
    }
  : {
      readonly editorFamily: TEditorFamily;
      readonly booleanEditorValues?: never;
    };

export type BrunoTableValueType<
  TValue,
  TFilterFamily extends BrunoTableFilterFamily = BrunoTableFilterFamily,
  TEditorFamily extends Exclude<BrunoTableEditorFamily, "select"> = Exclude<
    BrunoTableEditorFamily,
    "select"
  >,
  TAggregateResults extends BrunoTableAggregateResults = never,
> = {
  readonly codecId: string;
  readonly codecVersion: number;
  readonly filterFamily: TFilterFamily;
  readonly cellAlign: BrunoTableCellAlign;
  readonly editorLayout: BrunoTableEditorLayout;
  readonly defaultWidth: number;
  readonly decodeRuntime: (this: void, input: unknown) => BrunoTableDecodeResult<TValue>;
  /** Must agree exactly with both zero ordering and canonical-text identity. */
  readonly equivalent: (this: void, left: TValue, right: TValue) => boolean;
  /** Must return zero exactly when `equivalent(left, right)` is true. */
  readonly compare: (this: void, left: TValue, right: TValue) => BrunoTableOrdering;
  /** Must return equal text exactly when two values are semantically equivalent. */
  readonly formatCanonicalText: (this: void, value: TValue) => string;
  readonly parseCanonicalText: (this: void, text: string) => BrunoTableDecodeResult<TValue>;
  readonly formatDisplay: (this: void, value: TValue) => string;
  readonly encodePersisted: (this: void, value: TValue) => BrunoTableJsonValue;
  readonly decodePersisted: (this: void, input: unknown) => BrunoTableDecodeResult<TValue>;
} & BrunoTableEditorCapability<TValue, TEditorFamily> &
  ([TAggregateResults] extends [never]
    ? InferredAggregateCapability<TValue>
    : AggregateAlgebraRequirement<TValue, TAggregateResults> &
        ([keyof TAggregateResults] extends [never]
          ? { readonly aggregateResults?: TAggregateResults }
          : { readonly aggregateResults: TAggregateResults }));

type NonArithmeticAggregateResults = Readonly<{
  readonly countDistinct?: "bigint";
  readonly min?: "self";
  readonly max?: "self";
  readonly sum?: never;
  readonly avg?: never;
}>;

type SumAggregateResults = Readonly<{
  readonly countDistinct?: "bigint";
  readonly sum: "self";
  readonly min?: "self";
  readonly max?: "self";
  readonly avg?: never;
}>;

type AverageAggregateResults = Readonly<{
  readonly countDistinct?: "bigint";
  readonly sum?: "self";
  readonly min?: "self";
  readonly max?: "self";
  readonly avg: "self";
}>;

type InferredAggregateCapability<TValue> =
  | {
      readonly aggregateResults?: never;
      readonly aggregateAlgebra?: BrunoTableAggregateAlgebra<TValue>;
    }
  | {
      readonly aggregateResults: NonArithmeticAggregateResults;
      readonly aggregateAlgebra?: BrunoTableAggregateAlgebra<TValue>;
    }
  | {
      readonly aggregateResults: SumAggregateResults;
      readonly aggregateAlgebra: BrunoTableAggregateAlgebra<TValue>;
    }
  | {
      readonly aggregateResults: AverageAggregateResults;
      readonly aggregateAlgebra: BrunoTableAggregateAlgebra<TValue> &
        Required<Pick<BrunoTableAggregateAlgebra<TValue>, "divideByCount">>;
    };

type AggregateAlgebraRequirement<
  TValue,
  TAggregateResults extends BrunoTableAggregateResults,
> = "avg" extends keyof TAggregateResults
  ? {
      readonly aggregateAlgebra: BrunoTableAggregateAlgebra<TValue> &
        Required<Pick<BrunoTableAggregateAlgebra<TValue>, "divideByCount">>;
    }
  : "sum" extends keyof TAggregateResults
    ? { readonly aggregateAlgebra: BrunoTableAggregateAlgebra<TValue> }
    : {};

export type BrunoTableValueTypeValue<TValueType> = TValueType extends {
  readonly decodeRuntime: (this: void, input: unknown) => BrunoTableDecodeResult<infer TValue>;
}
  ? TValue
  : never;

export type BrunoTableSourceStatus = "loading" | "ready" | "stale" | "closed" | "error";

export type BrunoTableSourceRetry = {
  readonly run: (this: void) => void;
  readonly pending: boolean;
};

export type BrunoTableSourceChrome = {
  readonly totalRows: number;
  readonly version: number;
  readonly status: BrunoTableSourceStatus;
  readonly statusCode?: string | undefined;
  readonly message?: string | undefined;
  readonly retry?: BrunoTableSourceRetry | undefined;
};

export type BrunoTableClientSource<TRow> = BrunoTableSourceChrome & {
  readonly rows: readonly TRow[];
};

/**
 * The lifecycle envelope returned by a long-lived server viewport hook.
 *
 * `TViewport` stays opaque at the public interface. The private server adapter is responsible for
 * narrowing it to the transport it supports; consumers never depend on rendering-engine state or
 * types.
 */
export type BrunoTableServerSource<TViewport = unknown> = BrunoTableSourceChrome & {
  readonly viewport: TViewport;
  /** Source-owned whole-result hook used only while a Server Set Filter overlay is open. */
  readonly useWholeResult: (...arguments_: never[]) => unknown;
  readonly completeRawSelect: LiveQueryViewportCompleteRawSelect<TViewport>;
};

type FieldKey<TRow> = Extract<keyof TRow, string>;

type NonNullish<TValue> = Exclude<TValue, null | undefined>;

type NonEmptyFields<TRow> = readonly [FieldKey<TRow>, ...FieldKey<TRow>[]];

type ValueForBuiltInType<TValueType extends BrunoTableBuiltInValueType> = TValueType extends "text"
  ? string
  : TValueType extends "number"
    ? number
    : TValueType extends "bigint"
      ? bigint
      : boolean;

type ValueParams<TRow, TValue> = {
  readonly row: TRow;
  readonly value: TValue;
};

type GroupKeyCallback<
  TValue,
  TColumnId extends BrunoTableColumnId,
  TField extends string,
  TResult,
> = (parameters: BrunoTableGroupKeyCellParams<TValue, TColumnId, TField>) => TResult;

type AggregateCallback<
  TValue,
  TColumnId extends BrunoTableColumnId,
  TField extends string,
  TAggFunc extends BrunoTableAggFunc,
  TResult,
> = (parameters: BrunoTableAggregateCellParams<TAggFunc, TValue, TColumnId, TField>) => TResult;

export type BrunoTableGroupKeyPresence<TValue> =
  | Readonly<{ readonly _tag: "Missing" }>
  | Readonly<{ readonly _tag: "Present"; readonly value: TValue }>;

type RowGroupKeyValue<TRow> = {
  readonly [TField in FieldKey<TRow>]: [NonNullish<TRow[TField]>] extends [never]
    ? never
    : {
        readonly columnId: BrunoTableColumnId;
        readonly field: TField;
      } & BrunoTableGroupKeyPresence<TRow[TField]>;
}[FieldKey<TRow>];

type DefinedGroupKeyValue<
  TRow,
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = TColumns[number] extends infer TColumn
  ? TColumn extends {
      readonly columnId: infer TColumnId extends BrunoTableColumnId;
      readonly field: infer TField extends FieldKey<TRow>;
      readonly groupBy: true;
    }
    ? {
        readonly columnId: TColumnId;
        readonly field: TField;
      } & BrunoTableGroupKeyPresence<TRow[TField]>
    : never
  : never;

export type BrunoTableGroupKeyValue<
  TRow,
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[] | undefined = undefined,
> = TColumns extends readonly { readonly columnId: BrunoTableColumnId }[]
  ? DefinedGroupKeyValue<TRow, TColumns>
  : RowGroupKeyValue<TRow>;

export type BrunoTableGroupKeyValues<
  TRow,
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = readonly BrunoTableGroupKeyValue<TRow, TColumns>[];

export type BrunoTableRowsCellParams<
  TRow,
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = {
  readonly columnId: BrunoTableRowsColumnId;
  readonly value: bigint;
  readonly groupKeys: BrunoTableGroupKeyValues<TRow, TColumns>;
};

export type BrunoTableGroupRowsColumnOptions<
  TRow,
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = {
  readonly headerName?: string;
  readonly width?: number;
  readonly valueFormatter?: (parameters: BrunoTableRowsCellParams<TRow, TColumns>) => string;
  readonly cellClassName?:
    | string
    | ((parameters: BrunoTableRowsCellParams<TRow, TColumns>) => string | undefined);
  readonly cellRenderer?: (parameters: BrunoTableRowsCellParams<TRow, TColumns>) => ReactNode;
};

export type BrunoTableGroupKeyCellParams<
  TValue,
  TColumnId extends BrunoTableColumnId,
  TField extends string = string,
> = {
  readonly columnId: TColumnId;
  readonly field: TField;
  readonly value: TValue;
  readonly rowCount: bigint;
};

export type BrunoTableAggregateCellParams<
  TAggFunc extends BrunoTableAggFunc,
  TValue,
  TColumnId extends BrunoTableColumnId,
  TField extends string = string,
> = {
  readonly columnId: TColumnId;
  readonly field: TField;
  readonly aggFunc: TAggFunc;
  readonly value: TValue;
  readonly rowCount: bigint;
};

type GroupKeyPresentation<TValue, TColumnId extends BrunoTableColumnId, TField extends string> =
  | {
      readonly groupBy?: false | undefined;
      readonly groupKeyValueFormatter?: never;
      readonly groupKeyCellClassName?: never;
      readonly groupKeyCellRenderer?: never;
    }
  | {
      readonly groupBy: true;
      readonly groupKeyValueFormatter?: GroupKeyCallback<TValue, TColumnId, TField, string>;
      readonly groupKeyCellClassName?:
        | string
        | GroupKeyCallback<TValue, TColumnId, TField, string | undefined>;
      readonly groupKeyCellRenderer?: GroupKeyCallback<TValue, TColumnId, TField, ReactNode>;
    };

type BuiltInAggregateResults<TValueType extends BrunoTableBuiltInValueType> =
  TValueType extends "bigint"
    ? {
        readonly countDistinct: "bigint";
        readonly sum: "self";
        readonly min: "self";
        readonly max: "self";
      }
    : {
        readonly countDistinct: "bigint";
        readonly min: "self";
        readonly max: "self";
      };

type AggregateResultsFor<TValue, TValueType> = Omit<
  TValueType extends BrunoTableBuiltInValueType
    ? BuiltInAggregateResults<TValueType>
    : TValueType extends {
          readonly aggregateResults?: infer TAggregateResults extends BrunoTableAggregateResults;
        }
      ? TAggregateResults
      : {},
  [TValue] extends [NonNullish<TValue>] ? never : "sum" | "avg"
>;

type AggregateResultValue<TValue, TResultKind> = TResultKind extends "self"
  ? TValue
  : TResultKind extends "bigint"
    ? bigint
    : never;

type AggregatePresentationBranch<
  TValue,
  TColumnId extends BrunoTableColumnId,
  TField extends string,
  TAggFunc extends BrunoTableAggFunc,
  TResultKind extends BrunoTableAggregateResultKind,
> = {
  readonly aggFunc: TAggFunc;
  readonly aggregateValueFormatter?: AggregateCallback<
    AggregateResultValue<TValue, TResultKind>,
    TColumnId,
    TField,
    TAggFunc,
    string
  >;
  readonly aggregateCellClassName?:
    | string
    | AggregateCallback<
        AggregateResultValue<TValue, TResultKind>,
        TColumnId,
        TField,
        TAggFunc,
        string | undefined
      >;
  readonly aggregateCellRenderer?: AggregateCallback<
    AggregateResultValue<TValue, TResultKind>,
    TColumnId,
    TField,
    TAggFunc,
    ReactNode
  >;
};

type AggregatePresentation<
  TValue,
  TValueType,
  TColumnId extends BrunoTableColumnId,
  TField extends string,
> =
  | {
      readonly aggFunc?: never;
      readonly aggregateValueFormatter?: never;
      readonly aggregateCellClassName?: never;
      readonly aggregateCellRenderer?: never;
    }
  | {
      readonly [TAggFunc in Extract<
        keyof AggregateResultsFor<TValue, TValueType>,
        BrunoTableAggFunc
      >]: AggregatePresentationBranch<
        TValue,
        TColumnId,
        TField,
        TAggFunc,
        Extract<AggregateResultsFor<TValue, TValueType>[TAggFunc], BrunoTableAggregateResultKind>
      >;
    }[Extract<keyof AggregateResultsFor<TValue, TValueType>, BrunoTableAggFunc>];

type ColumnPresentation<TRow, TValue> = {
  readonly valueFormatter?: (parameters: ValueParams<TRow, TValue>) => string;
  readonly cellClassName?: string | ((parameters: ValueParams<TRow, TValue>) => string | undefined);
  readonly cellRenderer?: (parameters: ValueParams<TRow, TValue>) => ReactNode;
};

type ColumnLayout = {
  readonly width?: number;
  readonly cellAlign?: BrunoTableCellAlign;
  readonly editorLayout?: BrunoTableEditorLayout;
  readonly pinned?: "start" | "end";
};

type FieldColumnFilteringCapability =
  | {
      readonly enableFilter: false;
      readonly enableSetFilter?: never;
    }
  | {
      readonly enableFilter?: true;
      /** Enables the live Set Filter. Boolean and Select Field Columns default this to true. */
      readonly enableSetFilter?: boolean;
    };

type ValueGetterParams<TRow, TFields extends NonEmptyFields<TRow>> = {
  readonly row: Pick<TRow, TFields[number]>;
};

type EditableBlankRepresentation<TValue> = null extends TValue
  ? undefined extends TValue
    ? {
        /** Exact nullish value produced when an editor commits an empty candidate. */
        readonly blankValue: null | undefined;
      }
    : {
        /** Exact nullish value produced when an editor commits an empty candidate. */
        readonly blankValue: null;
      }
  : undefined extends TValue
    ? {
        /** Exact nullish value produced when an editor commits an empty candidate. */
        readonly blankValue: undefined;
      }
    : { readonly blankValue?: never };

/**
 * Plain structural arrays cannot admit a widened nullable boolean together with `blankValue`
 * without also admitting literal `false`. Nullable editability is therefore statically explicit.
 */
type NonPotentialFieldEditingCapability<TValue> = null extends TValue
  ? {
      readonly isEditable?: false;
      readonly blankValue?: never;
      readonly validate?: never;
    }
  : undefined extends TValue
    ? {
        readonly isEditable?: false;
        readonly blankValue?: never;
        readonly validate?: never;
      }
    : {
        /** A widened boolean remains runtime-defended but cannot prove Table edit capability. */
        readonly isEditable?: boolean;
        readonly blankValue?: never;
        readonly validate?: never;
      };

type FieldEditingCapability<TRow, TValue> =
  | NonPotentialFieldEditingCapability<TValue>
  | ({
      readonly isEditable: true | ((parameters: ValueParams<TRow, TValue>) => boolean);
      readonly validate?: (parameters: ValueParams<TRow, TValue>) => string | undefined;
    } & EditableBlankRepresentation<TValue>);

type FieldColumn<
  TRow,
  TField extends FieldKey<TRow>,
  TValueType extends BrunoTableBuiltInValueType | ErasedValueType,
  TColumnId extends BrunoTableColumnId = BrunoTableColumnId,
> = ColumnPresentation<TRow, TRow[TField]> &
  ColumnLayout & {
    readonly columnId: TColumnId;
    readonly field: TField;
    readonly headerName: string;
    readonly valueType: TValueType;
    readonly enableSorting?: boolean;
    readonly format?: TValueType extends "number" ? BrunoTableNumberFormat : never;
    readonly fields?: never;
    readonly valueGetter?: never;
  } & FieldEditingCapability<TRow, TRow[TField]> &
  FieldColumnFilteringCapability &
  GroupKeyPresentation<TRow[TField], TColumnId, TField> &
  AggregatePresentation<TRow[TField], TValueType, TColumnId, TField>;

type RawCustomFieldValueType<
  TValue,
  TAggregateResults extends BrunoTableAggregateResults = {},
> = BrunoTableValueType<
  NonNullish<TValue>,
  BrunoTableFilterFamily,
  Exclude<BrunoTableEditorFamily, "select">,
  TAggregateResults
>;

type RawCustomFieldColumnWithoutAggregate<TRow, TField extends FieldKey<TRow>> = Extract<
  FieldColumn<TRow, TField, RawCustomFieldValueType<TRow[TField]>>,
  { readonly aggFunc?: never }
>;

type RawCustomAggregatedFieldColumn<TRow, TField extends FieldKey<TRow>> = {
  readonly [TAggFunc in BrunoTableAggFunc]: {
    readonly [TResultKind in BrunoTableAggregateResultKind]: Extract<
      FieldColumn<
        TRow,
        TField,
        RawCustomFieldValueType<TRow[TField], Readonly<Record<TAggFunc, TResultKind>>>
      >,
      { readonly aggFunc: TAggFunc }
    >;
  }[BrunoTableAggregateResultKind];
}[BrunoTableAggFunc];

type FieldColumns<TRow> = {
  readonly [TField in FieldKey<TRow>]:
    | ([NonNullish<TRow[TField]>] extends [never]
        ? never
        : NonNullish<TRow[TField]> extends string
          ? FieldColumn<TRow, TField, "text">
          : never)
    | (NonNullish<TRow[TField]> extends number ? FieldColumn<TRow, TField, "number"> : never)
    | (NonNullish<TRow[TField]> extends bigint ? FieldColumn<TRow, TField, "bigint"> : never)
    | (NonNullish<TRow[TField]> extends boolean ? FieldColumn<TRow, TField, "boolean"> : never)
    | ([NonNullish<TRow[TField]>] extends [never]
        ? never
        :
            | RawCustomFieldColumnWithoutAggregate<TRow, TField>
            | RawCustomAggregatedFieldColumn<TRow, TField>);
}[FieldKey<TRow>];

const computedColumnMarker: unique symbol = Symbol("BrunoTableComputedColumn");

type ComputedColumn<
  TRow,
  TFields extends NonEmptyFields<TRow>,
  TValue,
  TValueType extends BrunoTableBuiltInValueType | ErasedValueType,
> = ColumnPresentation<TRow, TValue> &
  ColumnLayout & {
    readonly [computedColumnMarker]: true;
    readonly columnId: BrunoTableColumnId;
    readonly headerName: string;
    readonly fields: TFields;
    readonly valueGetter: (params: ValueGetterParams<TRow, TFields>) => TValue;
    readonly valueType: TValueType;
    readonly field?: never;
    readonly enableFilter?: never;
    readonly enableSorting?: never;
    readonly isEditable?: never;
    readonly blankValue?: never;
    readonly validate?: never;
    readonly format?: TValueType extends "number" ? BrunoTableNumberFormat : never;
  };

type ErasedEditorCapability =
  | {
      readonly editorFamily: "boolean";
      readonly booleanEditorValues: readonly [unknown, unknown];
    }
  | {
      readonly editorFamily: Exclude<BrunoTableEditorFamily, "boolean">;
      readonly booleanEditorValues?: never;
    };

type ErasedValueType = {
  readonly codecId: string;
  readonly codecVersion: number;
  readonly filterFamily: BrunoTableFilterFamily;
  readonly cellAlign: BrunoTableCellAlign;
  readonly editorLayout: BrunoTableEditorLayout;
  readonly defaultWidth: number;
  readonly aggregateResults?: BrunoTableAggregateResults;
  readonly decodeRuntime: (input: unknown) => unknown;
  readonly equivalent: (...parameters: never[]) => unknown;
  readonly compare: (...parameters: never[]) => unknown;
  readonly formatCanonicalText: (...parameters: never[]) => unknown;
  readonly parseCanonicalText: (text: string) => unknown;
  readonly formatDisplay: (...parameters: never[]) => unknown;
  readonly encodePersisted: (...parameters: never[]) => unknown;
  readonly decodePersisted: (input: unknown) => unknown;
} & ErasedEditorCapability;

type ErasedCustomComputedColumn<TRow> = ColumnPresentation<TRow, never> &
  ColumnLayout & {
    readonly [computedColumnMarker]: true;
    readonly columnId: BrunoTableColumnId;
    readonly headerName: string;
    readonly fields: NonEmptyFields<TRow>;
    readonly valueGetter: (...parameters: never[]) => unknown;
    readonly valueType: ErasedValueType;
    readonly field?: never;
    readonly enableFilter?: never;
    readonly enableSorting?: never;
    readonly isEditable?: never;
    readonly blankValue?: never;
    readonly validate?: never;
    readonly format?: never;
  };

type AnyComputedColumn<TRow> =
  | {
      readonly [TValueType in BrunoTableBuiltInValueType]: ComputedColumn<
        TRow,
        NonEmptyFields<TRow>,
        ValueForBuiltInType<TValueType>,
        TValueType
      >;
    }[BrunoTableBuiltInValueType]
  | ErasedCustomComputedColumn<TRow>;

type ComputedColumnDependencies<TRow, TFields extends NonEmptyFields<TRow>, TValue> = {
  readonly fields: TFields;
  readonly valueGetter: (params: ValueGetterParams<TRow, TFields>) => TValue;
};

type ComputedColumnOptions<
  TRow,
  TFields extends NonEmptyFields<TRow>,
  TValue,
  TValueType extends BrunoTableBuiltInValueType | ErasedValueType,
> = Omit<
  ComputedColumn<TRow, TFields, TValue, TValueType>,
  typeof computedColumnMarker | "fields" | "valueGetter"
>;

/** A string key of the consumer's Row type. */
export type BrunoTableFieldKey<TRow> = FieldKey<TRow>;

/** @internal Shared only with BrunoTable's first-party Column Helper implementation. */
export type BrunoTableNonNullish<TValue> = NonNullish<TValue>;

/** @internal Shared only with BrunoTable's first-party Column Helper implementation. */
export type BrunoTableNonEmptyFields<TRow> = NonEmptyFields<TRow>;

type StringQueryField<TRow> = {
  [TField in FieldKey<TRow>]: [NonNullish<TRow[TField]>] extends [never]
    ? never
    : [NonNullish<TRow[TField]>] extends [string]
      ? TField
      : never;
}[FieldKey<TRow>];

/** A string-valued source field eligible for the Client Quick Filter. */
export type BrunoTableQuickFilterField<TRow> = StringQueryField<TRow>;

/**
 * Explicit, non-empty source-field configuration for the Client Quick Filter.
 * TypeScript enforces the field shape and non-empty tuple; the runtime applies a defensive
 * maximum of 256 entries when snapshotting untrusted configuration.
 */
export type BrunoTableQuickFilterFields<TRow> = readonly [
  BrunoTableQuickFilterField<TRow>,
  ...BrunoTableQuickFilterField<TRow>[],
];

/** @internal Shared only with BrunoTable's first-party Column Helper implementation. */
type SelectFieldColumnCapabilities<TColumn, TOptions> = [TOptions] extends [void]
  ? TColumn
  : TOptions extends {
        readonly groupBy: true;
      }
    ? TOptions extends { readonly aggFunc: infer TAggFunc }
      ? Extract<TColumn, { readonly groupBy: true; readonly aggFunc: TAggFunc }>
      : Extract<TColumn, { readonly groupBy: true; readonly aggFunc?: never }>
    : TOptions extends { readonly aggFunc: infer TAggFunc }
      ? Extract<TColumn, { readonly groupBy?: false | undefined; readonly aggFunc: TAggFunc }>
      : Extract<TColumn, { readonly groupBy?: false | undefined; readonly aggFunc?: never }>;

/** Exact structural Field Column definition for advanced raw configuration. */
declare const brunoTableColumnHelperFieldDomainWitness: unique symbol;
declare const brunoTableColumnHelperRowWitness: unique symbol;

type BrunoTableColumnHelperRowWitness<TRow> = Readonly<{
  [brunoTableColumnHelperRowWitness]?: (row: TRow) => TRow;
}>;

type BrunoTableColumnHelperFieldDomainWitness<TField extends string, TValue> = Readonly<{
  [brunoTableColumnHelperFieldDomainWitness]?: Readonly<{
    readonly field: TField;
    readonly value: TValue;
  }>;
}>;

type BrunoTableColumnHelperFieldDomainFor<TRow, TField extends FieldKey<TRow>> =
  TField extends FieldKey<TRow>
    ? BrunoTableColumnHelperFieldDomainWitness<TField, TRow[TField]>
    : never;

export type BrunoTableFieldColumnDefinition<
  TRow,
  TField extends FieldKey<TRow>,
  TValueType extends BrunoTableBuiltInValueType | ErasedValueType,
  TOptions = void,
  TColumnId extends BrunoTableColumnId = BrunoTableColumnId,
> = BrunoTableFieldColumnInput<TRow, TField, TValueType, TOptions, TColumnId> &
  BrunoTableColumnHelperFieldDomainFor<TRow, TField> &
  BrunoTableColumnHelperRowWitness<TRow>;

/** @internal Capability-selecting input shape for first-party Column Helpers. */
export type BrunoTableFieldColumnInput<
  TRow,
  TField extends FieldKey<TRow>,
  TValueType extends BrunoTableBuiltInValueType | ErasedValueType,
  TOptions = void,
  TColumnId extends BrunoTableColumnId = BrunoTableColumnId,
> = SelectFieldColumnCapabilities<FieldColumn<TRow, TField, TValueType, TColumnId>, TOptions>;

/** @internal Shared only with BrunoTable's first-party Column Helper implementation. */
export type BrunoTableComputedColumnDefinition<
  TRow,
  TFields extends NonEmptyFields<TRow>,
  TValue,
  TValueType extends BrunoTableBuiltInValueType | BrunoTableValueType<TValue> | ErasedValueType,
> = ComputedColumn<TRow, TFields, TValue, TValueType>;

/** @internal Shared only with BrunoTable's first-party Column Helper implementation. */
export type BrunoTableComputedColumnDependencies<
  TRow,
  TFields extends NonEmptyFields<TRow>,
  TValue,
> = ComputedColumnDependencies<TRow, TFields, TValue>;

/** @internal Shared only with BrunoTable's first-party Column Helper implementation. */
export type BrunoTableComputedColumnInput<
  TRow,
  TFields extends NonEmptyFields<TRow>,
  TValue,
  TValueType extends BrunoTableBuiltInValueType | BrunoTableValueType<TValue> | ErasedValueType,
> = ComputedColumnOptions<TRow, TFields, TValue, TValueType> &
  ComputedColumnDependencies<TRow, TFields, TValue>;

/**
 * Captures a Computed Column's exact dependency tuple before contextually typing its getter.
 * Built-in Value Type helpers will delegate to this strict construction seam.
 */
export function BrunoTableComputedColumn<
  TRow,
  const TFields extends NonEmptyFields<TRow>,
  const TOptions extends ComputedColumnOptions<TRow, TFields, string, "text">,
>(
  options: TOptions &
    BrunoTableColumnIdentityInput<TOptions> &
    ComputedColumnDependencies<TRow, TFields, string>,
): TOptions &
  ComputedColumnDependencies<TRow, TFields, string> &
  ComputedColumn<TRow, TFields, string, "text">;
export function BrunoTableComputedColumn<
  TRow,
  const TFields extends NonEmptyFields<TRow>,
  const TOptions extends ComputedColumnOptions<TRow, TFields, number, "number">,
>(
  options: TOptions &
    BrunoTableColumnIdentityInput<TOptions> &
    ComputedColumnDependencies<TRow, TFields, number>,
): TOptions &
  ComputedColumnDependencies<TRow, TFields, number> &
  ComputedColumn<TRow, TFields, number, "number">;
export function BrunoTableComputedColumn<
  TRow,
  const TFields extends NonEmptyFields<TRow>,
  const TOptions extends ComputedColumnOptions<TRow, TFields, bigint, "bigint">,
>(
  options: TOptions &
    BrunoTableColumnIdentityInput<TOptions> &
    ComputedColumnDependencies<TRow, TFields, bigint>,
): TOptions &
  ComputedColumnDependencies<TRow, TFields, bigint> &
  ComputedColumn<TRow, TFields, bigint, "bigint">;
export function BrunoTableComputedColumn<
  TRow,
  const TFields extends NonEmptyFields<TRow>,
  const TOptions extends ComputedColumnOptions<TRow, TFields, boolean, "boolean">,
>(
  options: TOptions &
    BrunoTableColumnIdentityInput<TOptions> &
    ComputedColumnDependencies<TRow, TFields, boolean>,
): TOptions &
  ComputedColumnDependencies<TRow, TFields, boolean> &
  ComputedColumn<TRow, TFields, boolean, "boolean">;
export function BrunoTableComputedColumn<
  TRow,
  const TFields extends NonEmptyFields<TRow>,
  const TValueType extends ErasedValueType,
  const TOptions extends ComputedColumnOptions<
    TRow,
    TFields,
    BrunoTableValueTypeValue<TValueType>,
    TValueType
  >,
>(
  options: TOptions &
    BrunoTableColumnIdentityInput<TOptions> & {
      readonly valueType: TValueType;
    } & ComputedColumnDependencies<TRow, TFields, BrunoTableValueTypeValue<TValueType>>,
): TOptions &
  ComputedColumnDependencies<TRow, TFields, BrunoTableValueTypeValue<TValueType>> &
  ComputedColumn<TRow, TFields, BrunoTableValueTypeValue<TValueType>, TValueType>;
export function BrunoTableComputedColumn(options: Readonly<Record<string, unknown>>) {
  return { ...options, [computedColumnMarker]: true };
}

type HelperGroupedPresentationCallbacks = Readonly<{
  groupKeyValueFormatter?: unknown;
  groupKeyCellClassName?: unknown;
  groupKeyCellRenderer?: unknown;
  aggregateValueFormatter?: unknown;
  aggregateCellClassName?: unknown;
  aggregateCellRenderer?: unknown;
}>;

/** @internal Exact helper output recognized by the plain BrunoTable column-array interface. */
export type BrunoTableColumnHelperOutput<TColumn> = TColumn &
  BrunoTableColumnHelperProvenanceCarrier<
    TColumn extends { readonly field: infer TField }
      ? Readonly<{ readonly field: TField }>
      : TColumn extends { readonly fields: infer TFields }
        ? Readonly<{ readonly fields: TFields }>
        : never
  >;

type HelperFieldDomainForRow<TRow> = BrunoTableColumnHelperFieldDomainFor<TRow, FieldKey<TRow>>;

type Column<TRow> =
  | FieldColumns<TRow>
  | AnyComputedColumn<TRow>
  | ({ readonly columnId: BrunoTableColumnId } & HelperGroupedPresentationCallbacks &
      BrunoTableColumnHelperProvenanceCarrier<Readonly<{ readonly field: FieldKey<TRow> }>> &
      HelperFieldDomainForRow<TRow> &
      BrunoTableColumnHelperRowWitness<TRow>);

/**
 * A plain column array intended to be used with `satisfies`.
 *
 * Ordinary raw Field Columns require no helper. Inline grouped callbacks receive the honest broad
 * Column Identity context; exact grouped callbacks use one of BrunoTable's global typed Column
 * Helpers so their owning literal identity remains exact.
 */
export type BrunoTableColumns<TRow> = readonly Column<TRow>[];

type InvalidColumnIdentity<TColumn> = TColumn extends {
  readonly columnId: infer TColumnId extends ColumnIdPattern;
}
  ? TColumnId extends BrunoTableColumnId<TColumnId>
    ? never
    : TColumnId
  : never;

/** @internal Validates exact identities after a consumer tuple has been inferred. */
export type BrunoTableColumnIdentityGuard<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = [InvalidColumnIdentity<TColumns[number]>] extends [never] ? unknown : never;

type InvalidServerAggregateColumn<TColumns extends readonly unknown[]> =
  TColumns[number] extends infer TColumn
    ? TColumn extends { readonly aggFunc: infer TAggFunc; readonly valueType: infer TValueType }
      ? TAggFunc extends "sum"
        ? TValueType extends "bigint" | BrunoTableServerBigDecimalValueTypeAuthority
          ? never
          : TColumn
        : TAggFunc extends "avg"
          ? TValueType extends BrunoTableServerBigDecimalValueTypeAuthority
            ? never
            : TColumn
          : never
      : never
    : never;

/** @internal Restricts Server arithmetic to effect-view-server's exact result domains. */
export type BrunoTableServerAggregateGuard<TColumns extends readonly unknown[]> =
  ColumnIdPattern extends (
    TColumns[number] extends { readonly columnId: infer TColumnId } ? TColumnId : never
  )
    ? unknown
    : [InvalidServerAggregateColumn<TColumns>] extends [never]
      ? unknown
      : never;

export type BrunoTableColumnIdOf<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = TColumns[number]["columnId"];

type ColumnForId<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
  TColumnId extends BrunoTableColumnIdOf<TColumns>,
> = Extract<TColumns[number], { readonly columnId: TColumnId }>;

export type BrunoTableColumnField<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
  TColumnId extends BrunoTableColumnIdOf<TColumns>,
> =
  ColumnForId<TColumns, TColumnId> extends { readonly field: infer TField extends string }
    ? TField
    : never;

export type BrunoTableColumnValue<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TColumnId extends BrunoTableColumnIdOf<TColumns>,
> =
  ColumnForId<TColumns, TColumnId> extends {
    readonly valueGetter: (...parameters: never[]) => infer TValue;
  }
    ? TValue
    : ColumnForId<TColumns, TColumnId> extends { readonly field: infer TField }
      ? TField extends keyof TRow
        ? TRow[TField]
        : never
      : never;

type EnabledFieldColumnId<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
  TCapability extends "enableFilter" | "enableSorting",
> = TColumns[number] extends infer TColumn
  ? TColumn extends { readonly columnId: infer TColumnId extends BrunoTableColumnId }
    ? TColumn extends { readonly field: string }
      ? TColumn extends { readonly [TKey in TCapability]: false }
        ? never
        : TColumnId
      : never
    : never
  : never;

export type BrunoTableFilterableColumnId<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = EnabledFieldColumnId<TColumns, "enableFilter">;

export type BrunoTableSortableColumnId<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = EnabledFieldColumnId<TColumns, "enableSorting">;

type ExactEditableFieldColumn<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = TColumns[number] extends infer TColumn
  ? TColumn extends {
      readonly field: string;
      readonly isEditable: infer TEditable;
    }
    ? TEditable extends false | undefined
      ? never
      : TColumn
    : never
  : never;

type PotentiallyEditableFieldColumn<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> =
  BrunoTableColumnId extends BrunoTableColumnIdOf<TColumns>
    ? Extract<TColumns[number], { readonly field: string }>
    : ExactEditableFieldColumn<TColumns>;

export type BrunoTableEditableColumnId<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> =
  PotentiallyEditableFieldColumn<TColumns> extends infer TColumn
    ? TColumn extends { readonly columnId: infer TColumnId extends BrunoTableColumnId }
      ? TColumnId
      : never
    : never;

type ScalarFilterValue<TValue> = Exclude<TValue, null | undefined>;
type NonEmptyScalarFilterValues<TValue> = readonly [
  ScalarFilterValue<TValue>,
  ...ScalarFilterValue<TValue>[],
];

type FilterFamilyForValueType<TValueType> = TValueType extends "text"
  ? "text"
  : TValueType extends "number" | "bigint"
    ? "numeric"
    : TValueType extends "boolean"
      ? "boolean"
      : TValueType extends { readonly filterFamily: infer TFamily extends BrunoTableFilterFamily }
        ? TFamily
        : never;

type ColumnFilterFamily<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
  TColumnId extends BrunoTableColumnIdOf<TColumns>,
> =
  ColumnForId<TColumns, TColumnId> extends { readonly valueType: infer TValueType }
    ? FilterFamilyForValueType<TValueType>
    : never;

type TextSensitivity<TFilterFamily> = TFilterFamily extends "text"
  ? {
      readonly caseSensitive?: boolean;
      readonly accentSensitive?: boolean;
    }
  : {
      readonly caseSensitive?: never;
      readonly accentSensitive?: never;
    };

type EqualityFilter<
  TColumnId extends BrunoTableColumnId,
  TValue,
  TFilterFamily,
  TSetFilterEnabled extends boolean,
> =
  | ({
      readonly columnId: TColumnId;
      readonly type: "equals" | "notEqual";
      readonly filter: ScalarFilterValue<TValue>;
    } & TextSensitivity<TFilterFamily>)
  | (TSetFilterEnabled extends true
      ? {
          readonly columnId: TColumnId;
          readonly type: "in";
          readonly filter: NonEmptyScalarFilterValues<TValue>;
        } & TextSensitivity<TFilterFamily>
      : never);

type ColumnSetFilterEnabled<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
  TColumnId extends BrunoTableColumnIdOf<TColumns>,
> =
  ColumnForId<TColumns, TColumnId> extends { readonly enableFilter: false }
    ? false
    : ColumnForId<TColumns, TColumnId> extends { readonly enableSetFilter: infer TEnabled }
      ? TEnabled extends true
        ? true
        : false
      : ColumnFilterFamily<TColumns, TColumnId> extends "boolean" | "select"
        ? true
        : false;

type ColumnInFilterEnabled<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
  TColumnId extends BrunoTableColumnIdOf<TColumns>,
> =
  ColumnFilterFamily<TColumns, TColumnId> extends "text" | "numeric" | "boolean" | "select"
    ? true
    : ColumnSetFilterEnabled<TColumns, TColumnId>;

type MatchNoneFilter<
  TColumnId extends BrunoTableColumnId,
  TSetFilterEnabled extends boolean,
> = TSetFilterEnabled extends true
  ? { readonly columnId: TColumnId; readonly type: "matchNone" }
  : never;

type TextFilter<TColumnId extends BrunoTableColumnId, TFilterFamily> = TFilterFamily extends "text"
  ? {
      readonly columnId: TColumnId;
      readonly type: "contains" | "notContains" | "startsWith" | "endsWith";
      readonly filter: string;
      readonly caseSensitive?: boolean;
      readonly accentSensitive?: boolean;
    }
  : never;

type NumericFilter<
  TColumnId extends BrunoTableColumnId,
  TValue,
  TFilterFamily,
> = TFilterFamily extends "numeric"
  ?
      | {
          readonly columnId: TColumnId;
          readonly type: "greaterThan" | "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual";
          readonly filter: ScalarFilterValue<TValue>;
        }
      | {
          readonly columnId: TColumnId;
          /** Matches the half-open interval `filter <= value < filterTo`. */
          readonly type: "inRange";
          readonly filter: ScalarFilterValue<TValue>;
          readonly filterTo: ScalarFilterValue<TValue>;
        }
  : never;

type BlankFilter<TColumnId extends BrunoTableColumnId> = {
  readonly columnId: TColumnId;
  readonly type: "blank" | "notBlank";
};

type FilterLeaf<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TColumnId extends BrunoTableFilterableColumnId<TColumns>,
> =
  | EqualityFilter<
      TColumnId,
      BrunoTableColumnValue<TRow, TColumns, TColumnId>,
      ColumnFilterFamily<TColumns, TColumnId>,
      ColumnInFilterEnabled<TColumns, TColumnId>
    >
  | TextFilter<TColumnId, ColumnFilterFamily<TColumns, TColumnId>>
  | NumericFilter<
      TColumnId,
      BrunoTableColumnValue<TRow, TColumns, TColumnId>,
      ColumnFilterFamily<TColumns, TColumnId>
    >
  | BlankFilter<TColumnId>
  | MatchNoneFilter<TColumnId, ColumnSetFilterEnabled<TColumns, TColumnId>>;

type FilterExpressionForColumn<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TColumnId extends BrunoTableFilterableColumnId<TColumns>,
> =
  | FilterLeaf<TRow, TColumns, TColumnId>
  | {
      readonly type: "AND" | "OR";
      readonly conditions: readonly [
        FilterExpressionForColumn<TRow, TColumns, TColumnId>,
        ...FilterExpressionForColumn<TRow, TColumns, TColumnId>[],
      ];
    }
  | {
      readonly type: "NOT";
      readonly condition: FilterExpressionForColumn<TRow, TColumns, TColumnId>;
    };

export type BrunoTableFilterExpression<TRow, TColumns extends BrunoTableColumns<TRow>> = {
  readonly [TColumnId in BrunoTableFilterableColumnId<TColumns>]: FilterExpressionForColumn<
    TRow,
    TColumns,
    TColumnId
  >;
}[BrunoTableFilterableColumnId<TColumns>];

export type BrunoTableFilterExpressions<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
> = readonly BrunoTableFilterExpression<TRow, TColumns>[];

export type BrunoTableSortBy<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = readonly [
  {
    readonly [TColumnId in BrunoTableSortableColumnId<TColumns>]: {
      readonly columnId: TColumnId;
      readonly direction: "asc" | "desc";
    };
  }[BrunoTableSortableColumnId<TColumns>],
  ...{
    readonly [TColumnId in BrunoTableSortableColumnId<TColumns>]: {
      readonly columnId: TColumnId;
      readonly direction: "asc" | "desc";
    };
  }[BrunoTableSortableColumnId<TColumns>][],
];

export type BrunoTableRowsColumnId = BrunoTableRowsSystemColumnId;

export type BrunoTableGroupableColumnId<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = TColumns[number] extends infer TColumn
  ? TColumn extends {
      readonly columnId: infer TColumnId extends BrunoTableColumnId;
      readonly field: string;
      readonly groupBy: true;
    }
    ? TColumnId
    : never
  : never;

export type BrunoTableGroupedSortableColumnId<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> =
  | BrunoTableGroupableColumnId<TColumns>
  | (TColumns[number] extends infer TColumn
      ? TColumn extends {
          readonly columnId: infer TColumnId extends BrunoTableColumnId;
          readonly field: string;
          readonly aggFunc: BrunoTableAggFunc;
        }
        ? TColumnId
        : never
      : never)
  | BrunoTableRowsColumnId;

export type BrunoTableGroupSortBy<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = readonly [
  {
    readonly columnId: BrunoTableGroupedSortableColumnId<TColumns>;
    readonly direction: "asc" | "desc";
  },
  ...{
    readonly columnId: BrunoTableGroupedSortableColumnId<TColumns>;
    readonly direction: "asc" | "desc";
  }[],
];

type PersistedCodecOperand = {
  readonly codecId: string;
  readonly codecVersion: number;
  readonly filter: BrunoTableJsonValue;
};

type PersistedTextSensitivity<TFilterFamily> = TFilterFamily extends "text"
  ? {
      readonly caseSensitive?: boolean;
      readonly accentSensitive?: boolean;
    }
  : {
      readonly caseSensitive?: never;
      readonly accentSensitive?: never;
    };

type PersistedFilterLeaf<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
  TColumnId extends BrunoTableFilterableColumnId<TColumns>,
> =
  | {
      readonly columnId: TColumnId;
      readonly type: "blank" | "notBlank";
    }
  | (ColumnSetFilterEnabled<TColumns, TColumnId> extends true
      ? { readonly columnId: TColumnId; readonly type: "matchNone" }
      : never)
  | ({
      readonly columnId: TColumnId;
      readonly type: "equals" | "notEqual";
    } & PersistedCodecOperand &
      PersistedTextSensitivity<ColumnFilterFamily<TColumns, TColumnId>>)
  | (ColumnInFilterEnabled<TColumns, TColumnId> extends true
      ? {
          readonly columnId: TColumnId;
          readonly type: "in";
          readonly codecId: string;
          readonly codecVersion: number;
          readonly filter: readonly [BrunoTableJsonValue, ...BrunoTableJsonValue[]];
        } & PersistedTextSensitivity<ColumnFilterFamily<TColumns, TColumnId>>
      : never)
  | (ColumnFilterFamily<TColumns, TColumnId> extends "text"
      ? {
          readonly columnId: TColumnId;
          readonly type: "contains" | "notContains" | "startsWith" | "endsWith";
          readonly codecId: string;
          readonly codecVersion: number;
          readonly filter: string;
        } & PersistedTextSensitivity<"text">
      : never)
  | (ColumnFilterFamily<TColumns, TColumnId> extends "numeric"
      ? {
          readonly columnId: TColumnId;
          readonly type: "greaterThan" | "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual";
        } & PersistedCodecOperand
      : never)
  | (ColumnFilterFamily<TColumns, TColumnId> extends "numeric"
      ? {
          readonly columnId: TColumnId;
          readonly type: "inRange";
          readonly codecId: string;
          readonly codecVersion: number;
          readonly filter: BrunoTableJsonValue;
          readonly filterTo: BrunoTableJsonValue;
        }
      : never);

type PersistedFilterExpressionForColumn<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
  TColumnId extends BrunoTableFilterableColumnId<TColumns>,
> =
  | PersistedFilterLeaf<TColumns, TColumnId>
  | {
      readonly type: "AND" | "OR";
      readonly conditions: readonly [
        PersistedFilterExpressionForColumn<TColumns, TColumnId>,
        ...PersistedFilterExpressionForColumn<TColumns, TColumnId>[],
      ];
    }
  | {
      readonly type: "NOT";
      readonly condition: PersistedFilterExpressionForColumn<TColumns, TColumnId>;
    };

export type BrunoTablePersistedFilterExpression<TRow, TColumns extends BrunoTableColumns<TRow>> = {
  readonly [TColumnId in BrunoTableFilterableColumnId<TColumns>]: PersistedFilterExpressionForColumn<
    TColumns,
    TColumnId
  >;
}[BrunoTableFilterableColumnId<TColumns>];

export type BrunoTablePersistedFilterExpressions<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
> = readonly BrunoTablePersistedFilterExpression<TRow, TColumns>[];

export type BrunoTablePersistedColumnPinning<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> = Readonly<{
  readonly start: readonly BrunoTableColumnIdOf<TColumns>[];
  readonly end: readonly BrunoTableColumnIdOf<TColumns>[];
}>;

export type BrunoTablePersistedState<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TGrouping extends boolean = boolean,
> = TGrouping extends boolean
  ? Readonly<{
      readonly version: 1;
      readonly tableId: string;
      readonly filters: BrunoTablePersistedFilterExpressions<TRow, TColumns>;
      readonly orderBy: BrunoTableSortBy<TColumns>;
      readonly groupBy: TGrouping extends true
        ? readonly BrunoTableGroupableColumnId<TColumns>[]
        : readonly [];
      readonly groupOrderBy: TGrouping extends true ? BrunoTableGroupSortBy<TColumns> : readonly [];
      readonly columnOrder: readonly BrunoTableColumnIdOf<TColumns>[];
      readonly columnVisibility: Readonly<Partial<Record<BrunoTableColumnIdOf<TColumns>, boolean>>>;
      readonly columnWidths: Readonly<
        Partial<
          Record<
            | BrunoTableColumnIdOf<TColumns>
            | (TGrouping extends true ? BrunoTableRowsColumnId : never),
            number
          >
        >
      >;
      readonly columnPinning: BrunoTablePersistedColumnPinning<TColumns>;
    }>
  : never;

type SaveCellChangeForColumn<TRow, TColumn> = TColumn extends {
  readonly columnId: infer TColumnId extends BrunoTableColumnId;
  readonly field: infer TField extends keyof TRow & string;
}
  ? {
      readonly columnId: TColumnId;
      readonly field: TField;
      readonly before: TRow[TField];
      readonly after: TRow[TField];
    }
  : never;

export type BrunoTableSaveCellChange<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
> = SaveCellChangeForColumn<TRow, PotentiallyEditableFieldColumn<TColumns>>;

type PotentiallyEditableField<TRow, TColumns extends BrunoTableColumns<TRow>> =
  PotentiallyEditableFieldColumn<TColumns> extends infer TColumn
    ? TColumn extends { readonly field: infer TField extends keyof TRow & string }
      ? TField
      : never
    : never;

/** Exact sparse field values used to project one editable source Row for presentation. */
export type BrunoTableEditRowPatch<TRow, TColumns extends BrunoTableColumns<TRow>> = Readonly<
  Partial<Pick<TRow, PotentiallyEditableField<TRow, TColumns>>>
>;

/** Input to an Editable Client Table's trusted Row projection seam. */
export type BrunoTableEditRowProjectorInput<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TRowVersion = unknown,
> = Readonly<{
  readonly row: TRow;
  readonly patch: BrunoTableEditRowPatch<TRow, TColumns>;
  readonly rowVersion: TRowVersion;
}>;

/**
 * Reconstructs the consumer's authentic Row shape for row-aware edit-review presentation.
 *
 * The returned Row is presentation evidence only. It does not replace the source Row, Row Version,
 * or Save Change Set authority. A memoized projection remains valid while the source Row reference,
 * opaque Row Version, projector configuration, and exact patch are identical, including after a
 * review closes and reopens. Changed source, Row Version, or patch evidence requires a fresh
 * immutable Row replacement. The opaque Row Version is cache-key evidence only.
 *
 * Missing required configuration is an explicit configuration error. Before this Row has published
 * one valid projection, a projector failure, null or non-object result, source-Row result for a
 * non-empty patch, Row Identity read failure, changed Row Identity, or reused historical result is
 * also explicit. After a valid projection has been published, the same failure classes on changed
 * inputs instead withdraw row-aware Yours as unavailable. Exact Mine, Base, and Server evidence
 * remains available; BrunoTable never substitutes stale or Server evidence for Yours.
 */
export type BrunoTableEditRowProjector<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TRowVersion = unknown,
> = (input: BrunoTableEditRowProjectorInput<TRow, TColumns, TRowVersion>) => TRow;

export type BrunoTableSaveCellChangeSet<TRow, TColumns extends BrunoTableColumns<TRow>> = readonly [
  BrunoTableSaveCellChange<TRow, TColumns>,
  ...BrunoTableSaveCellChange<TRow, TColumns>[],
];

export type BrunoTableSaveRowChange<TRow, TColumns extends BrunoTableColumns<TRow>, TRowVersion> = {
  readonly rowId: BrunoTableRowId;
  readonly baseRow: TRow;
  readonly expectedVersion: TRowVersion;
  readonly changes: BrunoTableSaveCellChangeSet<TRow, TColumns>;
};

export type BrunoTableSaveChangeSet<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TRowVersion,
> = readonly [
  BrunoTableSaveRowChange<TRow, TColumns, TRowVersion>,
  ...BrunoTableSaveRowChange<TRow, TColumns, TRowVersion>[],
];

/**
 * Persist a non-empty Save Change Set.
 *
 * The returned operation must eventually settle. While it is pending, BrunoTable keeps the
 * submitted cells locked and the save counted as active. Rejection releases that save work;
 * resolution keeps it active until authoritative live-source evidence reconciles the submission.
 */
export type BrunoTableSaveEditsHandler<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TRowVersion,
> = (changes: BrunoTableSaveChangeSet<TRow, TColumns, TRowVersion>) => PromiseLike<void>;

export type BrunoTableReadOnlyCapability = {
  readonly editable?: false;
  readonly getRowVersion?: never;
  readonly onSaveEdits?: never;
  readonly projectEditRow?: never;
};

export type BrunoTableNoGroupingCapability = {
  readonly groupRowsColumn?: never;
};

export type BrunoTableGroupingCapability<TRow, TColumns extends BrunoTableColumns<TRow>> = {
  readonly groupRowsColumn?: BrunoTableGroupRowsColumnOptions<TRow, TColumns>;
};

type PotentiallyEditableRowAwarePresentationColumn<
  TColumns extends readonly { readonly columnId: BrunoTableColumnId }[],
> =
  PotentiallyEditableFieldColumn<TColumns> extends infer TColumn
    ? TColumn extends unknown
      ? TColumn extends { readonly valueFormatter: (...parameters: never[]) => unknown }
        ? TColumn
        : TColumn extends { readonly cellClassName: (...parameters: never[]) => unknown }
          ? TColumn
          : TColumn extends { readonly cellRenderer: (...parameters: never[]) => unknown }
            ? TColumn
            : never
      : never
    : never;

type BrunoTableEditRowProjectionCapability<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TRowVersion,
> = number extends TColumns["length"]
  ? { readonly projectEditRow?: BrunoTableEditRowProjector<TRow, TColumns, TRowVersion> }
  : [PotentiallyEditableRowAwarePresentationColumn<TColumns>] extends [never]
    ? { readonly projectEditRow?: BrunoTableEditRowProjector<TRow, TColumns, TRowVersion> }
    : { readonly projectEditRow: BrunoTableEditRowProjector<TRow, TColumns, TRowVersion> };

export type BrunoTableEditableCapability<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TRowVersion,
> =
  BrunoTableEditableColumnId<TColumns> extends never
    ? never
    : {
        readonly editable: true;
        readonly getRowVersion: (row: TRow) => TRowVersion;
        readonly onSaveEdits: BrunoTableSaveEditsHandler<TRow, TColumns, NoInfer<TRowVersion>>;
      } & BrunoTableEditRowProjectionCapability<TRow, TColumns, TRowVersion> &
        BrunoTableNoGroupingCapability;

export type BrunoTableEditingCapability<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TRowVersion,
> = BrunoTableReadOnlyCapability | BrunoTableEditableCapability<TRow, TColumns, TRowVersion>;

type CommonPropsWithoutInitialOrderBy<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TGrouping extends boolean = boolean,
> = {
  readonly tableId: string;
  readonly columns: TColumns & BrunoTableColumnIdentityGuard<NoInfer<TColumns>>;
  readonly initialFilters?: BrunoTableFilterExpressions<TRow, TColumns>;
  readonly initialPersistedState?: BrunoTablePersistedState<TRow, TColumns, TGrouping>;
  readonly onPersistChange?: (state: BrunoTablePersistedState<TRow, TColumns, TGrouping>) => void;
  /** Optional page-specific content rendered in BrunoTable's toolbar region. */
  readonly children?: ReactNode;
};

export type BrunoTableCommonProps<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
> = CommonPropsWithoutInitialOrderBy<TRow, TColumns> & {
  readonly initialOrderBy: BrunoTableSortBy<TColumns>;
};

// This private conditional preserves focused diagnostics for invalid component calls. Both public
// variants remove its property and replace it with the same mandatory non-empty tuple.
type ComponentCommonProps<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TGrouping extends boolean,
> = CommonPropsWithoutInitialOrderBy<TRow, TColumns, TGrouping> &
  ([BrunoTableSortableColumnId<TColumns>] extends [never]
    ? { readonly initialOrderBy?: never }
    : { readonly initialOrderBy: BrunoTableSortBy<TColumns> });

type BrunoTableClientSourceProps<TRow, TColumns extends BrunoTableColumns<TRow>> = {
  readonly initialOrderBy: BrunoTableSortBy<TColumns>;
  readonly getRowId: (row: TRow) => BrunoTableRowId;
  readonly clientSource: BrunoTableClientSource<TRow>;
  readonly quickFilterFields?: BrunoTableQuickFilterFields<TRow>;
  /** Enables session-only Row Selection for ordinary Client source rows. */
  readonly rowSelection?: true;
  readonly externalFilters?: never;
  readonly viewportSource?: never;
};

type BrunoTablePotentiallyEditableColumnRequirement<TColumns extends readonly unknown[]> =
  number extends TColumns["length"]
    ? unknown
    : Extract<
          TColumns[number],
          { readonly isEditable: true | ((...parameters: never[]) => boolean) }
        > extends never
      ? { readonly columns: never }
      : unknown;

export type BrunoTableReadOnlyClientProps<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
> = BrunoTableClientSourceProps<TRow, TColumns> &
  Omit<ComponentCommonProps<TRow, TColumns, true>, "initialOrderBy"> &
  BrunoTableReadOnlyCapability &
  BrunoTableGroupingCapability<TRow, TColumns>;

type EditableClientComposition<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
> = BrunoTableClientSourceProps<TRow, TColumns> &
  Omit<ComponentCommonProps<TRow, TColumns, false>, "initialOrderBy"> &
  BrunoTablePotentiallyEditableColumnRequirement<TColumns>;

export type BrunoTableEditableClientProps<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TGetRowVersion extends (row: TRow) => unknown,
> = EditableClientComposition<TRow, TColumns> &
  Omit<
    BrunoTableEditableCapability<TRow, TColumns, ReturnType<TGetRowVersion>>,
    "getRowVersion" | "onSaveEdits"
  > & {
    readonly getRowVersion: TGetRowVersion;
    readonly onSaveEdits: BrunoTableSaveEditsHandler<
      TRow,
      TColumns,
      NoInfer<ReturnType<TGetRowVersion>>
    >;
  };

export type BrunoTableClientProps<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TRowVersion = never,
> =
  | BrunoTableReadOnlyClientProps<TRow, TColumns>
  | (EditableClientComposition<TRow, TColumns> &
      BrunoTableEditableCapability<TRow, TColumns, TRowVersion>);

export type BrunoTableServerProps<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TViewport = unknown,
> = Omit<ComponentCommonProps<TRow, TColumns, true>, "initialOrderBy"> &
  BrunoTableReadOnlyCapability &
  BrunoTableGroupingCapability<TRow, TColumns> & {
    readonly columns: TColumns & BrunoTableServerAggregateGuard<NoInfer<TColumns>>;
    readonly initialOrderBy: BrunoTableSortBy<TColumns>;
    /** Server row identity is supplied authoritatively by the Viewport Source. */
    readonly getRowId?: never;
    readonly viewportSource: BrunoTableServerSource<
      [LiveQueryViewportBaseRow<TViewport>] extends [never]
        ? never
        : [TRow] extends [LiveQueryViewportBaseRow<TViewport>]
          ? [LiveQueryViewportBaseRow<TViewport>] extends [TRow]
            ? TViewport
            : never
          : never
    >;
    readonly externalFilters?: LiveQueryViewportWhere<NoInfer<TViewport>>;
    readonly quickFilterFields?: BrunoTableQuickFilterFields<TRow>;
    readonly clientSource?: never;
    readonly editable?: never;
    readonly rowSelection?: never;
    readonly rangeSelection?: never;
    readonly onPaste?: never;
    readonly onFill?: never;
    readonly onUndo?: never;
    readonly onRedo?: never;
  } & BrunoTableServerRouteCapability<LiveQueryViewportRouteBy<NoInfer<TViewport>>> &
  BrunoTableServerQueryAuthority<
    NoInfer<TViewport>,
    LiveQueryViewportRouteBy<NoInfer<TViewport>>,
    LiveQueryViewportWhere<NoInfer<TViewport>>
  >;

type BrunoTableServerRouteCapability<TRouteBy> = [TRouteBy] extends [never]
  ? { readonly routeBy?: never }
  : { readonly routeBy: TRouteBy };

type BrunoTableServerQueryAuthority<
  TViewport,
  TRouteBy,
  TExternalFilters extends readonly unknown[],
> = TViewport extends {
  readonly semanticKey: (
    query: {
      readonly select: LiveQueryViewportCompleteRawSelect<TViewport>;
      readonly where: TExternalFilters;
      readonly orderBy: readonly [];
    } & ([TRouteBy] extends [never]
      ? { readonly routeBy?: never }
      : { readonly routeBy: TRouteBy }),
  ) => unknown;
}
  ? [LiveQueryViewportQueryAuthority<TViewport>] extends [never]
    ? { readonly __brunoTableInvalidServerGroupedQueryAuthority: never }
    : unknown
  : { readonly __brunoTableInvalidServerQueryAuthority: never };
