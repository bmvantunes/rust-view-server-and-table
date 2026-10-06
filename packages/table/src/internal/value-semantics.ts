import type {
  BrunoTableBuiltInValueType,
  BrunoTableAggregateResults,
  BrunoTableCellAlign,
  BrunoTableDecodeResult,
  BrunoTableEditorFamily,
  BrunoTableEditorLayout,
  BrunoTableFilterFamily,
  BrunoTableJsonValue,
  BrunoTableNumberFormat,
  BrunoTableOrdering,
} from "../public-types";
import {
  getBrunoTableSelectCanonicalOptions,
  getBrunoTableSelectValueTypeFingerprint,
} from "./select-value-type-provenance";
import { isBrunoTableServerBigDecimalValueType } from "../public-types";

type SemanticsOverrides = {
  readonly cellAlign?: unknown;
  readonly editorLayout?: unknown;
  readonly width?: unknown;
  readonly format?: unknown;
};

type RuntimeValueTypeDescriptor = {
  readonly codecId: string;
  readonly codecVersion: number;
  readonly filterFamily: BrunoTableFilterFamily;
  readonly editorFamily: BrunoTableEditorFamily;
  readonly booleanEditorCanonicalValues?: readonly [falseValue: string, trueValue: string];
  readonly booleanEditorDomainExhaustive?: true;
  readonly cellAlign: BrunoTableCellAlign;
  readonly editorLayout: BrunoTableEditorLayout;
  readonly defaultWidth: number;
  readonly aggregateResults: BrunoTableAggregateResults;
  readonly aggregateAlgebra?: RuntimeAggregateAlgebra;
  readonly serverAggregateAuthority?: "core-bigint" | "effect-bigdecimal";
  readonly decodeRuntime: (input: unknown) => BrunoTableDecodeResult<unknown>;
  readonly decodeRuntimeAuthority?: unknown;
  readonly equivalentAuthority?: unknown;
  readonly formatCanonicalTextAuthority?: unknown;
  readonly parseCanonicalTextAuthority?: unknown;
  readonly formatDisplayAuthority?: unknown;
  readonly equivalent: (left: unknown, right: unknown) => boolean;
  readonly compare: (left: unknown, right: unknown) => BrunoTableOrdering;
  readonly formatCanonicalText: (value: unknown) => string;
  readonly parseCanonicalText: (text: string) => BrunoTableDecodeResult<unknown>;
  readonly formatDisplay: (value: unknown) => string;
  readonly encodePersisted: (value: unknown) => unknown;
  readonly decodePersisted: (input: unknown) => BrunoTableDecodeResult<unknown>;
};

export type CompiledColumnValueSemantics = {
  readonly codecId: string;
  readonly codecVersion: number;
  readonly filterFamily: BrunoTableFilterFamily;
  readonly editorFamily: BrunoTableEditorFamily;
  readonly booleanEditorCanonicalValues?: readonly [falseValue: string, trueValue: string];
  readonly booleanEditorDomainExhaustive?: true;
  readonly cellAlign: BrunoTableCellAlign;
  readonly editorLayout: BrunoTableEditorLayout;
  readonly selectCanonicalOptions?: readonly string[];
  readonly selectEditAuthority?: readonly string[];
  readonly width: number;
  readonly aggregateResults: BrunoTableAggregateResults;
  readonly aggregateAlgebra?: CompiledAggregateAlgebra;
  readonly serverAggregateAuthority?: "core-bigint" | "effect-bigdecimal";
  readonly decodeRuntime: (input: unknown) => BrunoTableDecodeResult<unknown>;
  /** Stable private authority used to invalidate decoded Server projections. */
  readonly decodeRuntimeAuthority: unknown;
  /** Stable private authority used to decide whether an active editor may retain its candidate. */
  readonly editSessionAuthority: Readonly<{
    readonly formatCanonicalText: unknown;
    readonly parseCanonicalText: unknown;
  }>;
  /** Stable private authority for grouped representative retention and Copy observability. */
  readonly groupedRetentionAuthority: Readonly<{
    readonly equivalent: unknown;
    readonly formatCanonicalText: unknown;
    readonly formatDisplay: unknown;
  }>;
  readonly equivalent: (left: unknown, right: unknown) => boolean;
  readonly compare: (left: unknown, right: unknown) => BrunoTableOrdering;
  readonly formatCanonicalText: (value: unknown) => string;
  readonly parseCanonicalText: (text: string) => BrunoTableDecodeResult<unknown>;
  readonly formatDisplay: (value: unknown) => string;
  readonly encodePersistedCandidate: (value: unknown) => unknown;
  readonly encodePersisted: (value: unknown) => BrunoTableJsonValue;
  readonly decodePersisted: (input: unknown) => BrunoTableDecodeResult<unknown>;
};

type RuntimeAggregateAlgebra = Readonly<{
  readonly add: (left: unknown, right: unknown) => unknown;
  readonly divideByCount?: (total: unknown, count: bigint) => unknown;
}>;

export type CompiledAggregateAlgebra = Readonly<{
  readonly add: (left: unknown, right: unknown) => BrunoTableDecodeResult<unknown>;
  readonly divideByCount?: (total: unknown, count: bigint) => BrunoTableDecodeResult<unknown>;
}>;

export class ValueSemanticsConfigurationError extends TypeError {}

const numberTextPattern = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u;
const bigIntTextPattern = /^-?\d+$/u;
const numberFormatOptionKeys = new Set<PropertyKey>([
  "compactDisplay",
  "currency",
  "currencyDisplay",
  "currencySign",
  "localeMatcher",
  "maximumFractionDigits",
  "maximumSignificantDigits",
  "minimumFractionDigits",
  "minimumIntegerDigits",
  "minimumSignificantDigits",
  "notation",
  "numberingSystem",
  "roundingIncrement",
  "roundingMode",
  "roundingPriority",
  "signDisplay",
  "style",
  "trailingZeroDisplay",
  "unit",
  "unitDisplay",
  "useGrouping",
]);
const aggregateFunctionNames = new Set<PropertyKey>(["countDistinct", "sum", "min", "max", "avg"]);
const builtInScalarAggregateResults = Object.freeze({
  countDistinct: "bigint",
  min: "self",
  max: "self",
} satisfies BrunoTableAggregateResults);
const builtInBigIntAggregateResults = Object.freeze({
  ...builtInScalarAggregateResults,
  sum: "self",
} satisfies BrunoTableAggregateResults);

const builtInValueTypes: Readonly<Record<BrunoTableBuiltInValueType, RuntimeValueTypeDescriptor>> =
  Object.freeze({
    text: createTextValueType(),
    number: createNumberValueType(),
    bigint: createBigIntValueType(),
    boolean: createBooleanValueType(),
  });

export function compileColumnValueSemantics(
  selection: unknown,
  overrides: SemanticsOverrides,
): CompiledColumnValueSemantics {
  const builtInSelection = isBuiltInValueType(selection) ? selection : undefined;
  const descriptor =
    builtInSelection === undefined
      ? snapshotCustomValueType(selection)
      : builtInValueTypes[builtInSelection];

  const cellAlign = overrides.cellAlign === undefined ? descriptor.cellAlign : overrides.cellAlign;
  if (!isCellAlign(cellAlign)) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable cellAlign must be start, center, or end when provided.",
    );
  }

  const editorLayout =
    overrides.editorLayout === undefined ? descriptor.editorLayout : overrides.editorLayout;
  if (!isEditorLayout(editorLayout)) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable editorLayout must be inline, center, or fullWidth when provided.",
    );
  }

  const width = overrides.width === undefined ? descriptor.defaultWidth : overrides.width;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable width must be a positive finite number when provided.",
    );
  }

  const format = overrides.format;
  if (format !== undefined && builtInSelection !== "number") {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable format is supported only by the built-in number Value Type.",
    );
  }

  let formatDisplay = (value: unknown) => descriptor.formatDisplay(value);
  if (format !== undefined) {
    if (!isRecord(format)) {
      throw new ValueSemanticsConfigurationError(
        "BrunoTable number format must be an object when provided.",
      );
    }
    for (const key of Reflect.ownKeys(format)) {
      if (!numberFormatOptionKeys.has(key)) {
        throw new ValueSemanticsConfigurationError(
          `BrunoTable number format does not accept ${String(key)}.`,
        );
      }
    }
    const formatSnapshot = Object.freeze({ ...format }) as BrunoTableNumberFormat;
    let formatter: Intl.NumberFormat;
    try {
      formatter = new Intl.NumberFormat(BRUNO_TABLE_NUMBER_DISPLAY_LOCALE, formatSnapshot);
    } catch (error) {
      throw new ValueSemanticsConfigurationError(
        `BrunoTable number format is invalid: ${safeErrorMessage(error)}`,
      );
    }
    formatDisplay = (value) => formatter.format(assertFiniteNumber(value));
  }
  const selectCanonicalOptions =
    descriptor.editorFamily === "select"
      ? getBrunoTableSelectCanonicalOptions(selection)
      : undefined;
  const selectEditAuthority =
    descriptor.editorFamily === "select"
      ? getBrunoTableSelectValueTypeFingerprint(selection)
      : undefined;

  return Object.freeze({
    codecId: descriptor.codecId,
    codecVersion: descriptor.codecVersion,
    filterFamily: descriptor.filterFamily,
    editorFamily: descriptor.editorFamily,
    cellAlign,
    editorLayout,
    ...(selectCanonicalOptions === undefined ? {} : { selectCanonicalOptions }),
    ...(selectEditAuthority === undefined ? {} : { selectEditAuthority }),
    ...(descriptor.booleanEditorCanonicalValues === undefined
      ? {}
      : { booleanEditorCanonicalValues: descriptor.booleanEditorCanonicalValues }),
    ...(descriptor.booleanEditorDomainExhaustive === true
      ? { booleanEditorDomainExhaustive: true as const }
      : {}),
    width,
    aggregateResults: descriptor.aggregateResults,
    ...(descriptor.aggregateAlgebra === undefined
      ? {}
      : { aggregateAlgebra: compileAggregateAlgebra(descriptor) }),
    ...(descriptor.serverAggregateAuthority === undefined
      ? {}
      : { serverAggregateAuthority: descriptor.serverAggregateAuthority }),
    decodeRuntime: (input) => descriptor.decodeRuntime(input),
    decodeRuntimeAuthority: descriptor.decodeRuntimeAuthority ?? descriptor.decodeRuntime,
    editSessionAuthority: Object.freeze({
      formatCanonicalText:
        descriptor.formatCanonicalTextAuthority ?? descriptor.formatCanonicalText,
      parseCanonicalText: descriptor.parseCanonicalTextAuthority ?? descriptor.parseCanonicalText,
    }),
    groupedRetentionAuthority: Object.freeze({
      equivalent: descriptor.equivalentAuthority ?? descriptor.equivalent,
      formatCanonicalText:
        descriptor.formatCanonicalTextAuthority ?? descriptor.formatCanonicalText,
      formatDisplay: descriptor.formatDisplayAuthority ?? descriptor.formatDisplay,
    }),
    equivalent: (left, right) => descriptor.equivalent(left, right),
    compare: (left, right) => descriptor.compare(left, right),
    formatCanonicalText: (value) => descriptor.formatCanonicalText(value),
    parseCanonicalText: (text) =>
      typeof text === "string"
        ? descriptor.parseCanonicalText(text)
        : { _tag: "Failure", message: "Expected canonical text input." },
    formatDisplay,
    encodePersistedCandidate: (value) => descriptor.encodePersisted(value),
    encodePersisted: (value) => validateJsonValue(descriptor.encodePersisted(value)),
    decodePersisted: (input) => descriptor.decodePersisted(input),
  } satisfies CompiledColumnValueSemantics);
}

const BRUNO_TABLE_NUMBER_DISPLAY_LOCALE = "en-US";

function snapshotCustomValueType(selection: unknown): RuntimeValueTypeDescriptor {
  if (!isRecord(selection)) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable valueType must be text, number, bigint, boolean, or a Value Type descriptor.",
    );
  }

  const codecId = selection["codecId"];
  const codecVersion = selection["codecVersion"];
  const filterFamily = selection["filterFamily"];
  const editorFamily = selection["editorFamily"];
  const booleanEditorValues = selection["booleanEditorValues"];
  const cellAlign = selection["cellAlign"];
  const editorLayout = selection["editorLayout"];
  const defaultWidth = selection["defaultWidth"];
  const aggregateResults = snapshotAggregateResults(selection["aggregateResults"]);
  const aggregateAlgebra = snapshotAggregateAlgebra(
    selection["aggregateAlgebra"],
    aggregateResults,
  );
  const decodeRuntime = selection["decodeRuntime"];
  const equivalent = selection["equivalent"];
  const compare = selection["compare"];
  const formatCanonicalText = selection["formatCanonicalText"];
  const parseCanonicalText = selection["parseCanonicalText"];
  const formatDisplay = selection["formatDisplay"];
  const encodePersisted = selection["encodePersisted"];
  const decodePersisted = selection["decodePersisted"];

  if (typeof codecId !== "string" || codecId.trim().length === 0) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable Value Type codecId must be a non-empty string.",
    );
  }
  if (typeof codecVersion !== "number" || !Number.isSafeInteger(codecVersion) || codecVersion < 1) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable Value Type codecVersion must be a positive safe integer.",
    );
  }
  if (!isFilterFamily(filterFamily)) {
    throw new ValueSemanticsConfigurationError("BrunoTable Value Type filterFamily is invalid.");
  }
  if (!isEditorFamily(editorFamily)) {
    throw new ValueSemanticsConfigurationError("BrunoTable Value Type editorFamily is invalid.");
  }
  if (!isCellAlign(cellAlign)) {
    throw new ValueSemanticsConfigurationError("BrunoTable Value Type cellAlign is invalid.");
  }
  if (!isEditorLayout(editorLayout)) {
    throw new ValueSemanticsConfigurationError("BrunoTable Value Type editorLayout is invalid.");
  }
  if (typeof defaultWidth !== "number" || !Number.isFinite(defaultWidth) || defaultWidth <= 0) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable Value Type defaultWidth must be a positive finite number.",
    );
  }

  const decodeRuntimeFunction = requireFunction(decodeRuntime, "decodeRuntime");
  const equivalentFunction = requireFunction(equivalent, "equivalent");
  const compareFunction = requireFunction(compare, "compare");
  const formatCanonicalTextFunction = requireFunction(formatCanonicalText, "formatCanonicalText");
  const parseCanonicalTextFunction = requireFunction(parseCanonicalText, "parseCanonicalText");
  const formatDisplayFunction = requireFunction(formatDisplay, "formatDisplay");
  const encodePersistedFunction = requireFunction(encodePersisted, "encodePersisted");
  const decodePersistedFunction = requireFunction(decodePersisted, "decodePersisted");

  const decodeRuntimeValue = (input: unknown) =>
    safeDecode(decodeRuntimeFunction, input, "decodeRuntime");
  const equivalentValue = (left: unknown, right: unknown) =>
    validateBoolean(Reflect.apply(equivalentFunction, undefined, [left, right]));
  const formatCanonicalTextValue = (value: unknown) =>
    validateText(Reflect.apply(formatCanonicalTextFunction, undefined, [value]));
  const parseCanonicalTextValue = (text: string) =>
    safeDecode(parseCanonicalTextFunction, text, "parseCanonicalText");
  const booleanEditorCanonicalValues = snapshotBooleanEditorCanonicalValues(
    editorFamily,
    booleanEditorValues,
    decodeRuntimeValue,
    equivalentValue,
    formatCanonicalTextValue,
    parseCanonicalTextValue,
  );

  const descriptor: RuntimeValueTypeDescriptor = {
    codecId,
    codecVersion,
    filterFamily,
    editorFamily,
    ...(booleanEditorCanonicalValues === undefined ? {} : { booleanEditorCanonicalValues }),
    cellAlign,
    editorLayout,
    defaultWidth,
    aggregateResults,
    ...(aggregateAlgebra === undefined ? {} : { aggregateAlgebra }),
    ...(isBrunoTableServerBigDecimalValueType(selection)
      ? { serverAggregateAuthority: "effect-bigdecimal" as const }
      : {}),
    decodeRuntime: decodeRuntimeValue,
    decodeRuntimeAuthority: decodeRuntimeFunction,
    equivalentAuthority: equivalentFunction,
    formatCanonicalTextAuthority: formatCanonicalTextFunction,
    parseCanonicalTextAuthority: parseCanonicalTextFunction,
    formatDisplayAuthority: formatDisplayFunction,
    equivalent: equivalentValue,
    compare: (left, right) =>
      validateOrdering(Reflect.apply(compareFunction, undefined, [left, right])),
    formatCanonicalText: formatCanonicalTextValue,
    parseCanonicalText: parseCanonicalTextValue,
    formatDisplay: (value) =>
      validateText(Reflect.apply(formatDisplayFunction, undefined, [value])),
    encodePersisted: (value) => Reflect.apply(encodePersistedFunction, undefined, [value]),
    decodePersisted: (input) => safeDecode(decodePersistedFunction, input, "decodePersisted"),
  };
  return Object.freeze(descriptor);
}

function snapshotBooleanEditorCanonicalValues(
  editorFamily: BrunoTableEditorFamily,
  input: unknown,
  decodeRuntime: (input: unknown) => BrunoTableDecodeResult<unknown>,
  equivalent: (left: unknown, right: unknown) => boolean,
  formatCanonicalText: (value: unknown) => string,
  parseCanonicalText: (text: string) => BrunoTableDecodeResult<unknown>,
): readonly [falseValue: string, trueValue: string] | undefined {
  if (editorFamily !== "boolean") {
    if (input !== undefined) {
      throw new ValueSemanticsConfigurationError(
        "BrunoTable booleanEditorValues requires the Boolean editor family.",
      );
    }
    return undefined;
  }
  if (!Array.isArray(input) || input.length !== 2 || !(0 in input) || !(1 in input)) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable Boolean Value Types require exactly [falseValue, trueValue].",
    );
  }
  const decodedFalse = decodeRuntime(input[0]);
  const decodedTrue = decodeRuntime(input[1]);
  if (decodedFalse._tag !== "Success" || decodedTrue._tag !== "Success") {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable booleanEditorValues must belong to the Value Type domain.",
    );
  }
  try {
    if (equivalent(decodedFalse.value, decodedTrue.value)) {
      throw new ValueSemanticsConfigurationError(
        "BrunoTable booleanEditorValues must represent two distinct values.",
      );
    }
    const falseText = formatCanonicalText(decodedFalse.value);
    const trueText = formatCanonicalText(decodedTrue.value);
    const parsedFalse = parseCanonicalText(falseText);
    const parsedTrue = parseCanonicalText(trueText);
    if (
      falseText === trueText ||
      parsedFalse._tag !== "Success" ||
      parsedTrue._tag !== "Success" ||
      !equivalent(parsedFalse.value, decodedFalse.value) ||
      !equivalent(parsedTrue.value, decodedTrue.value)
    ) {
      throw new ValueSemanticsConfigurationError(
        "BrunoTable booleanEditorValues must round-trip through distinct canonical text.",
      );
    }
    return Object.freeze([falseText, trueText]);
  } catch (error) {
    if (error instanceof ValueSemanticsConfigurationError) throw error;
    throw new ValueSemanticsConfigurationError(
      `BrunoTable booleanEditorValues are invalid: ${safeErrorMessage(error)}`,
    );
  }
}

function snapshotAggregateResults(input: unknown): BrunoTableAggregateResults {
  if (input === undefined) return Object.freeze({});
  if (!isRecord(input)) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable Value Type aggregateResults must be an object when provided.",
    );
  }

  const snapshot: Partial<Record<string, "self" | "bigint">> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (!aggregateFunctionNames.has(key) || typeof key !== "string") {
      throw new ValueSemanticsConfigurationError(
        `BrunoTable Value Type aggregateResults does not accept ${String(key)}.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new ValueSemanticsConfigurationError(
        "BrunoTable Value Type aggregateResults must contain enumerable data properties.",
      );
    }
    const expected = key === "countDistinct" ? "bigint" : "self";
    if (descriptor.value !== expected) {
      throw new ValueSemanticsConfigurationError(
        `BrunoTable Value Type aggregateResults.${key} is invalid; expected ${expected}.`,
      );
    }
    snapshot[key] = expected;
  }

  return Object.freeze(snapshot);
}

function snapshotAggregateAlgebra(
  input: unknown,
  aggregateResults: BrunoTableAggregateResults,
): RuntimeAggregateAlgebra | undefined {
  const requiresAdd = aggregateResults.sum === "self" || aggregateResults.avg === "self";
  const requiresDivision = aggregateResults.avg === "self";
  if (input === undefined) {
    if (requiresAdd) {
      throw new ValueSemanticsConfigurationError(
        `BrunoTable ${requiresDivision ? "avg" : "sum"} aggregation requires an exact add operation.`,
      );
    }
    return undefined;
  }
  if (!isRecord(input)) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable aggregateAlgebra must be an object when provided.",
    );
  }
  const addDescriptor = Object.getOwnPropertyDescriptor(input, "add");
  const divideDescriptor = Object.getOwnPropertyDescriptor(input, "divideByCount");
  const add =
    addDescriptor !== undefined &&
    "value" in addDescriptor &&
    typeof addDescriptor.value === "function"
      ? (addDescriptor.value as RuntimeAggregateAlgebra["add"])
      : undefined;
  const divideByCount =
    divideDescriptor !== undefined &&
    "value" in divideDescriptor &&
    typeof divideDescriptor.value === "function"
      ? (divideDescriptor.value as NonNullable<RuntimeAggregateAlgebra["divideByCount"]>)
      : undefined;
  if (requiresAdd && add === undefined) {
    throw new ValueSemanticsConfigurationError(
      `BrunoTable ${requiresDivision ? "avg" : "sum"} aggregation requires an exact add operation.`,
    );
  }
  if (requiresDivision && divideByCount === undefined) {
    throw new ValueSemanticsConfigurationError(
      "BrunoTable avg aggregation requires an exact divideByCount operation.",
    );
  }
  if (add === undefined) return undefined;
  return Object.freeze({ add, ...(divideByCount === undefined ? {} : { divideByCount }) });
}

function compileAggregateAlgebra(descriptor: RuntimeValueTypeDescriptor): CompiledAggregateAlgebra {
  const algebra = descriptor.aggregateAlgebra!;
  const add = algebra.add;
  const divideByCount = algebra.divideByCount;
  const decode = descriptor.decodeRuntime;
  const invoke = (operation: () => unknown): BrunoTableDecodeResult<unknown> => {
    try {
      const decoded = decode(operation());
      return decoded._tag === "Success"
        ? decoded
        : failure(`Aggregate Algebra returned an invalid value: ${decoded.message}`);
    } catch {
      return failure("Aggregate Algebra operation threw.");
    }
  };
  return Object.freeze({
    add: (left, right) => invoke(() => Reflect.apply(add, undefined, [left, right])),
    ...(divideByCount === undefined
      ? {}
      : {
          divideByCount: (total: unknown, count: bigint) =>
            invoke(() => Reflect.apply(divideByCount, undefined, [total, count])),
        }),
  });
}

function createTextValueType(): RuntimeValueTypeDescriptor {
  const descriptor: RuntimeValueTypeDescriptor = {
    codecId: "@bruno/table/text",
    codecVersion: 1,
    filterFamily: "text",
    editorFamily: "text",
    cellAlign: "start",
    editorLayout: "inline",
    defaultWidth: 160,
    aggregateResults: builtInScalarAggregateResults,
    decodeRuntime: (input) =>
      typeof input === "string" ? success(input) : failure("Expected a string value."),
    equivalent: (left, right) => assertString(left) === assertString(right),
    compare: (left, right) => comparePrimitive(assertString(left), assertString(right)),
    formatCanonicalText: assertString,
    parseCanonicalText: success,
    formatDisplay: assertString,
    encodePersisted: (value) => persisted("text", assertString(value)),
    decodePersisted: (input) =>
      decodePersistedTag(input, "text", (value) =>
        typeof value === "string" ? success(value) : failure("Persisted text value is invalid."),
      ),
  };
  return Object.freeze(descriptor);
}

function createNumberValueType(): RuntimeValueTypeDescriptor {
  const descriptor: RuntimeValueTypeDescriptor = {
    codecId: "@bruno/table/number",
    codecVersion: 1,
    filterFamily: "numeric",
    editorFamily: "number",
    cellAlign: "end",
    editorLayout: "inline",
    defaultWidth: 120,
    aggregateResults: builtInScalarAggregateResults,
    decodeRuntime: (input) =>
      typeof input === "number" && Number.isFinite(input)
        ? success(Object.is(input, -0) ? 0 : input)
        : failure("Expected a finite number value."),
    equivalent: (left, right) => assertFiniteNumber(left) === assertFiniteNumber(right),
    compare: (left, right) => comparePrimitive(assertFiniteNumber(left), assertFiniteNumber(right)),
    formatCanonicalText: (value) => String(assertFiniteNumber(value)),
    parseCanonicalText: parseNumberText,
    formatDisplay: (value) => String(assertFiniteNumber(value)),
    encodePersisted: (value) => persisted("number", String(assertFiniteNumber(value))),
    decodePersisted: (input) =>
      decodePersistedTag(input, "number", (value) =>
        typeof value === "string"
          ? parseNumberText(value)
          : failure("Persisted number value is invalid."),
      ),
  };
  return Object.freeze(descriptor);
}

function createBigIntValueType(): RuntimeValueTypeDescriptor {
  const descriptor: RuntimeValueTypeDescriptor = {
    codecId: "@bruno/table/bigint",
    codecVersion: 1,
    filterFamily: "numeric",
    editorFamily: "bigint",
    cellAlign: "end",
    editorLayout: "inline",
    defaultWidth: 140,
    aggregateResults: builtInBigIntAggregateResults,
    serverAggregateAuthority: "core-bigint",
    aggregateAlgebra: Object.freeze({
      add: (left, right) => assertBigInt(left) + assertBigInt(right),
    }),
    decodeRuntime: (input) =>
      typeof input === "bigint" ? success(input) : failure("Expected a bigint value."),
    equivalent: (left, right) => assertBigInt(left) === assertBigInt(right),
    compare: (left, right) => comparePrimitive(assertBigInt(left), assertBigInt(right)),
    formatCanonicalText: (value) => assertBigInt(value).toString(10),
    parseCanonicalText: parseBigIntText,
    formatDisplay: (value) => assertBigInt(value).toString(10),
    encodePersisted: (value) => persisted("bigint", assertBigInt(value).toString(10)),
    decodePersisted: (input) =>
      decodePersistedTag(input, "bigint", (value) =>
        typeof value === "string"
          ? parseBigIntText(value)
          : failure("Persisted bigint value is invalid."),
      ),
  };
  return Object.freeze(descriptor);
}

function createBooleanValueType(): RuntimeValueTypeDescriptor {
  const descriptor: RuntimeValueTypeDescriptor = {
    codecId: "@bruno/table/boolean",
    codecVersion: 1,
    filterFamily: "boolean",
    editorFamily: "boolean",
    booleanEditorCanonicalValues: Object.freeze(["false", "true"]),
    booleanEditorDomainExhaustive: true,
    cellAlign: "center",
    editorLayout: "center",
    defaultWidth: 88,
    aggregateResults: builtInScalarAggregateResults,
    decodeRuntime: (input) =>
      typeof input === "boolean" ? success(input) : failure("Expected a boolean value."),
    equivalent: (left, right) => assertBoolean(left) === assertBoolean(right),
    compare: (left, right) => {
      const leftBoolean = assertBoolean(left);
      const rightBoolean = assertBoolean(right);
      return leftBoolean === rightBoolean ? 0 : leftBoolean ? 1 : -1;
    },
    formatCanonicalText: (value) => String(assertBoolean(value)),
    parseCanonicalText: (text) =>
      text === "true"
        ? success(true)
        : text === "false"
          ? success(false)
          : failure("Expected true or false."),
    formatDisplay: (value) => String(assertBoolean(value)),
    encodePersisted: (value) => persisted("boolean", assertBoolean(value)),
    decodePersisted: (input) =>
      decodePersistedTag(input, "boolean", (value) =>
        typeof value === "boolean"
          ? success(value)
          : failure("Persisted boolean value is invalid."),
      ),
  };
  return Object.freeze(descriptor);
}

function parseNumberText(text: string): BrunoTableDecodeResult<number> {
  if (!numberTextPattern.test(text)) return failure("Expected a finite decimal number.");
  const value = Number(text);
  return Number.isFinite(value)
    ? success(Object.is(value, -0) ? 0 : value)
    : failure("Expected a finite decimal number.");
}

function parseBigIntText(text: string): BrunoTableDecodeResult<bigint> {
  return bigIntTextPattern.test(text)
    ? success(BigInt(text))
    : failure("Expected signed base-10 integer digits.");
}

function persisted(type: string, value: BrunoTableJsonValue): BrunoTableJsonValue {
  return { $brunoTableValue: type, version: 1, value };
}

function decodePersistedTag<TValue>(
  input: unknown,
  type: string,
  decode: (value: unknown) => BrunoTableDecodeResult<TValue>,
): BrunoTableDecodeResult<TValue> {
  return isRecord(input) && input["$brunoTableValue"] === type && input["version"] === 1
    ? decode(input["value"])
    : failure(`Persisted ${type} value has an invalid tag.`);
}

function comparePrimitive<TValue extends string | number | bigint>(
  left: TValue,
  right: TValue,
): BrunoTableOrdering {
  return left === right ? 0 : left < right ? -1 : 1;
}

function success<TValue>(value: TValue): BrunoTableDecodeResult<TValue> {
  return { _tag: "Success", value };
}

function failure(message: string): BrunoTableDecodeResult<never> {
  return { _tag: "Failure", message };
}

function assertFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("BrunoTable Number Value Type received a non-finite value.");
  }
  return value;
}

function assertString(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("BrunoTable Text Value Type received a non-string value.");
  }
  return value;
}

function assertBigInt(value: unknown): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError("BrunoTable BigInt Value Type received a non-bigint value.");
  }
  return value;
}

function assertBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError("BrunoTable Boolean Value Type received a non-boolean value.");
  }
  return value;
}

function safeDecode(
  decoder: Function,
  input: unknown,
  operation: "decodePersisted" | "decodeRuntime" | "parseCanonicalText",
): BrunoTableDecodeResult<unknown> {
  try {
    return validateDecodeResult(Reflect.apply(decoder, undefined, [input]));
  } catch {
    return failure(`BrunoTable Value Type ${operation} failed.`);
  }
}

function validateBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError("BrunoTable Value Type equivalent must return a boolean.");
  }
  return value;
}

function validateDecodeResult(value: unknown): BrunoTableDecodeResult<unknown> {
  if (!isRecord(value) || (value["_tag"] !== "Success" && value["_tag"] !== "Failure")) {
    throw new TypeError("BrunoTable Value Type returned an invalid decode result.");
  }
  if (value["_tag"] === "Failure") {
    if (typeof value["message"] !== "string" || value["message"].trim().length === 0) {
      throw new TypeError("BrunoTable Value Type returned an invalid decode failure.");
    }
    return { _tag: "Failure", message: value["message"] };
  }
  return { _tag: "Success", value: value["value"] };
}

function validateOrdering(value: unknown): BrunoTableOrdering {
  if (value !== -1 && value !== 0 && value !== 1) {
    throw new TypeError("BrunoTable Value Type compare must return -1, 0, or 1.");
  }
  return value;
}

function validateText(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("BrunoTable Value Type formatter must return a string.");
  }
  return value;
}

function validateJsonValue(value: unknown): BrunoTableJsonValue {
  if (!isJsonValue(value, new Set())) {
    throw new TypeError("BrunoTable Value Type persisted output must be JSON-safe.");
  }
  return value;
}

function isJsonValue(value: unknown, ancestors: Set<object>): value is BrunoTableJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? isDenseJsonArray(value, ancestors)
    : isJsonObject(value, ancestors);
  ancestors.delete(value);
  return valid;
}

function isDenseJsonArray(value: readonly unknown[], ancestors: Set<object>): boolean {
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) return false;

  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !isJsonValue(descriptor.value, ancestors)
    ) {
      return false;
    }
  }
  return true;
}

function isJsonObject(value: object, ancestors: Set<object>): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !isJsonValue(descriptor.value, ancestors)
    ) {
      return false;
    }
  }
  return true;
}

function isBuiltInValueType(value: unknown): value is BrunoTableBuiltInValueType {
  return value === "text" || value === "number" || value === "bigint" || value === "boolean";
}

function isFilterFamily(value: unknown): value is BrunoTableFilterFamily {
  return (
    value === "boolean" ||
    value === "equality" ||
    value === "numeric" ||
    value === "select" ||
    value === "text"
  );
}

function isEditorFamily(value: unknown): value is BrunoTableEditorFamily {
  return (
    value === "bigdecimal" ||
    value === "bigint" ||
    value === "boolean" ||
    value === "number" ||
    value === "select" ||
    value === "text"
  );
}

function isCellAlign(value: unknown): value is BrunoTableCellAlign {
  return value === "start" || value === "center" || value === "end";
}

function isEditorLayout(value: unknown): value is BrunoTableEditorLayout {
  return value === "inline" || value === "center" || value === "fullWidth";
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFunction(value: unknown, name: string): Function {
  if (typeof value !== "function") {
    throw new ValueSemanticsConfigurationError(`BrunoTable Value Type ${name} must be a function.`);
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
