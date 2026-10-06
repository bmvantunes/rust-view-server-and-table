import { describe, expect, it, vi } from "vitest";

import {
  BrunoTableBigIntColumn,
  BrunoTableBooleanColumn,
  BrunoTableNumberColumn,
  BrunoTableSelectColumn,
  BrunoTableTextColumn,
} from "../column-helpers";
import { BrunoTableAggregateAlgebra } from "../public-types";
import type { BrunoTableColumns, BrunoTableValueType } from "../public-types";
import { ColumnConfigurationError, compileColumns } from "./compile-columns";

type SemanticRow = {
  readonly symbol: string;
  readonly price: number;
  readonly quantity: bigint;
  readonly active: boolean;
  readonly status: "open" | "closed";
  readonly code: string;
};

describe("compiled Column Value Semantics", () => {
  it("compiles one immutable direct plan per normalized column", () => {
    const columns = [
      BrunoTableTextColumn({
        columnId: "COL_ID_SYMBOL",
        field: "symbol",
        headerName: "Symbol",
        pinned: "start",
      }),
      BrunoTableNumberColumn({
        columnId: "COL_ID_PRICE",
        field: "price",
        headerName: "Price",
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
    ] satisfies BrunoTableColumns<SemanticRow>;

    const compiled = compileColumns(columns);
    const semantics = compiled.map((column) => column.semantics);

    expect(semantics.map((plan) => Object.isFrozen(plan))).toEqual([true, true, true, true]);
    expect(new Set(semantics).size).toBe(4);
    expect(compiled[0]?.pinned).toBe("start");
    expect(
      semantics.map((plan) => ({
        codecId: plan.codecId,
        filterFamily: plan.filterFamily,
        editorFamily: plan.editorFamily,
        cellAlign: plan.cellAlign,
        editorLayout: plan.editorLayout,
        width: plan.width,
      })),
    ).toEqual([
      {
        codecId: "@bruno/table/text",
        filterFamily: "text",
        editorFamily: "text",
        cellAlign: "start",
        editorLayout: "inline",
        width: 160,
      },
      {
        codecId: "@bruno/table/number",
        filterFamily: "numeric",
        editorFamily: "number",
        cellAlign: "end",
        editorLayout: "inline",
        width: 120,
      },
      {
        codecId: "@bruno/table/bigint",
        filterFamily: "numeric",
        editorFamily: "bigint",
        cellAlign: "end",
        editorLayout: "inline",
        width: 140,
      },
      {
        codecId: "@bruno/table/boolean",
        filterFamily: "boolean",
        editorFamily: "boolean",
        cellAlign: "center",
        editorLayout: "center",
        width: 88,
      },
    ]);
  });

  it("keeps number and bigint exact, separate, and round-trippable", () => {
    const definitions = [
      BrunoTableNumberColumn({
        columnId: "COL_ID_PRICE",
        field: "price",
        headerName: "Price",
      }),
      BrunoTableBigIntColumn({
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        headerName: "Quantity",
      }),
    ] satisfies BrunoTableColumns<SemanticRow>;
    const [numberColumn, bigIntColumn] = compileColumns(definitions);
    const number = numberColumn!.semantics;
    const bigint = bigIntColumn!.semantics;
    const exact = 9_007_199_254_740_993_123_456_789n;

    expect(number.decodeRuntime(1n)).toEqual({
      _tag: "Failure",
      message: "Expected a finite number value.",
    });
    expect(bigint.decodeRuntime(1)).toEqual({
      _tag: "Failure",
      message: "Expected a bigint value.",
    });
    expect(number.formatCanonicalText(1.25)).toBe("1.25");
    expect(number.parseCanonicalText("1.25e2")).toEqual({ _tag: "Success", value: 125 });
    expect(number.parseCanonicalText("Infinity")._tag).toBe("Failure");
    expect(Reflect.apply(number.parseCanonicalText, undefined, [125])).toEqual({
      _tag: "Failure",
      message: "Expected canonical text input.",
    });
    expect(bigint.formatCanonicalText(exact)).toBe("9007199254740993123456789");
    expect(bigint.parseCanonicalText("9007199254740993123456789")).toEqual({
      _tag: "Success",
      value: exact,
    });
    for (const invalid of ["+1", "1.0", "1e3", " 1", "1_000"]) {
      expect(bigint.parseCanonicalText(invalid)._tag).toBe("Failure");
    }
    expect(bigint.compare(exact, exact - 1n)).toBe(1);

    const persisted = bigint.encodePersisted(exact);
    expect(JSON.stringify(persisted)).toContain("9007199254740993123456789");
    expect(bigint.decodePersisted(persisted)).toEqual({ _tag: "Success", value: exact });
    expect(number.decodePersisted(persisted)._tag).toBe("Failure");
  });

  it("keeps display formatting separate from canonical exchange semantics", () => {
    const formatter = ({ value }: { readonly value: number }) =>
      value < 0 ? `(${Math.abs(value).toFixed(1)})` : value.toFixed(1);
    const priceColumn = BrunoTableNumberColumn.withDefaults({
      headerName: "Price",
      width: 112,
      format: {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: false,
      },
    });
    const definitions = [
      priceColumn({
        columnId: "COL_ID_PRICE",
        field: "price",
        width: 144,
        format: { maximumFractionDigits: 4 },
        valueFormatter: formatter,
        cellClassName: ({ value }) => (value < 0 ? "text-destructive" : undefined),
        cellRenderer: ({ value }) => `P&L ${value}`,
      }),
    ] satisfies BrunoTableColumns<SemanticRow>;
    const definition = definitions[0]!;
    const [compiled] = compileColumns([definition]);
    const semantics = compiled!.semantics;

    expect(definition).toMatchObject({
      headerName: "Price",
      width: 144,
      cellAlign: "end",
      editorLayout: "inline",
      format: {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
        useGrouping: false,
      },
    });
    expect(compiled!.valueFormatter).toBe(formatter);
    expect(semantics.formatCanonicalText(-5.5)).toBe("-5.5");
    expect(semantics.parseCanonicalText("-5.5")).toEqual({ _tag: "Success", value: -5.5 });
    expect(semantics.formatDisplay(-5.5)).toBe(
      new Intl.NumberFormat("en-US", definition.format).format(-5.5),
    );
  });

  it("compiles Select options into exact equality, option order, and full-width editing", () => {
    const mutableOptions: ["open", "closed"] = ["open", "closed"];
    const definitions = [
      BrunoTableSelectColumn({
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        options: mutableOptions,
      }),
    ] satisfies BrunoTableColumns<SemanticRow>;
    const definition = definitions[0]!;
    mutableOptions.reverse();

    const [compiled] = compileColumns([definition]);
    const semantics = compiled!.semantics;

    expect(definition.options).toEqual(["open", "closed"]);
    expect(Object.isFrozen(definition.options)).toBe(true);
    expect(semantics).toMatchObject({
      filterFamily: "select",
      editorFamily: "select",
      cellAlign: "start",
      editorLayout: "fullWidth",
      width: 160,
    });
    expect(semantics.compare("open", "closed")).toBe(-1);
    expect(semantics.parseCanonicalText("closed")).toEqual({
      _tag: "Success",
      value: "closed",
    });
    expect(semantics.parseCanonicalText("cancelled")._tag).toBe("Failure");
    const persisted = semantics.encodePersisted("open");
    expect(semantics.decodePersisted(persisted)).toEqual({ _tag: "Success", value: "open" });
    expect(() => semantics.encodePersisted("cancelled")).toThrow(
      "not one of the configured Select options",
    );
  });

  it("uses compiled Select indexes without runtime find or indexOf calls", () => {
    const options = Array.from({ length: 32 }, (_unused, index) => `option-${String(index)}`) as [
      string,
      ...string[],
    ];
    const [compiled] = compileColumns([
      BrunoTableSelectColumn({
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        options,
      }),
    ] satisfies BrunoTableColumns<Readonly<{ readonly status: string }>>);
    const semantics = compiled!.semantics;
    const first = options[0];
    const last = options[31];
    if (first === undefined || last === undefined) throw new Error("Select fixture is incomplete.");

    const find = vi.spyOn(Array.prototype, "find");
    const indexOf = vi.spyOn(Array.prototype, "indexOf");
    let findCallCount = 0;
    let indexOfCallCount = 0;
    let observed:
      | Readonly<{
          readonly comparison: number;
          readonly equivalent: boolean;
          readonly canonicalText: string;
          readonly display: string;
          readonly parsed: unknown;
          readonly decoded: unknown;
        }>
      | undefined;
    try {
      const persisted = semantics.encodePersisted(last);
      observed = {
        comparison: semantics.compare(first, last),
        equivalent: semantics.equivalent(first, first),
        canonicalText: semantics.formatCanonicalText(last),
        display: semantics.formatDisplay(first),
        parsed: semantics.parseCanonicalText(last),
        decoded: semantics.decodePersisted(persisted),
      };
    } finally {
      findCallCount = find.mock.calls.length;
      indexOfCallCount = indexOf.mock.calls.length;
      find.mockRestore();
      indexOf.mockRestore();
    }

    expect(findCallCount).toBe(0);
    expect(indexOfCallCount).toBe(0);
    expect(observed).toEqual({
      comparison: -1,
      equivalent: true,
      canonicalText: last,
      display: first,
      parsed: { _tag: "Success", value: last },
      decoded: { _tag: "Success", value: last },
    });
  });

  it("keeps field-only preset defaults out of computed columns", () => {
    const preset = BrunoTableNumberColumn.withDefaults({
      headerName: "Price",
      enableFilter: true,
      enableSorting: true,
      isEditable: true,
    });
    const fieldColumn = Reflect.apply(preset, undefined, [
      { columnId: "COL_ID_PRICE", field: "price" },
    ]) as Readonly<Record<string, unknown>>;
    const computedColumn = Reflect.apply(preset, undefined, [
      {
        columnId: "COL_ID_NOTIONAL",
        fields: ["price", "quantity"],
        valueGetter: ({ row }: { readonly row: SemanticRow }) => row.price * Number(row.quantity),
      },
    ]) as Readonly<Record<string, unknown>>;

    expect(fieldColumn).toMatchObject({
      enableFilter: true,
      enableSorting: true,
      isEditable: true,
    });
    expect(computedColumn).not.toHaveProperty("enableFilter");
    expect(computedColumn).not.toHaveProperty("enableSorting");
    expect(computedColumn).not.toHaveProperty("isEditable");
    expect(() => compileColumns([computedColumn as never])).not.toThrow();
  });

  it("applies exact field edit policies through preset precedence and omits them for computed columns", () => {
    const presetValidate = vi.fn(() => "preset invalid");
    const individualValidate = vi.fn(() => undefined);
    const preset = BrunoTableNumberColumn.withDefaults({
      isEditable: true,
      blankValue: null,
      validate: presetValidate,
    });
    const inherited = Reflect.apply(preset, undefined, [
      { columnId: "COL_ID_NULLABLE", field: "nullable", headerName: "Nullable" },
    ]) as Readonly<Record<string, unknown>>;
    const overridden = Reflect.apply(preset, undefined, [
      {
        columnId: "COL_ID_OPTIONAL",
        field: "optional",
        headerName: "Optional",
        blankValue: undefined,
        validate: individualValidate,
      },
    ]) as Readonly<Record<string, unknown>>;
    const computed = Reflect.apply(preset, undefined, [
      {
        columnId: "COL_ID_COMPUTED",
        fields: ["price"],
        valueGetter: ({ row }: { readonly row: Pick<SemanticRow, "price"> }) => row.price,
      },
    ]) as Readonly<Record<string, unknown>>;

    expect(inherited).toMatchObject({ isEditable: true, blankValue: null });
    expect(inherited["validate"]).toBe(presetValidate);
    expect(overridden).toHaveProperty("blankValue", undefined);
    expect(overridden["validate"]).toBe(individualValidate);
    expect(computed).not.toHaveProperty("isEditable");
    expect(computed).not.toHaveProperty("blankValue");
    expect(computed).not.toHaveProperty("validate");
    expect(() =>
      Reflect.apply(preset, undefined, [
        {
          columnId: "COL_ID_DISABLED",
          field: "nullable",
          headerName: "Disabled",
          isEditable: false,
        },
      ]),
    ).toThrow("blankValue requires potential field editability");
    expect(() =>
      Reflect.apply(BrunoTableNumberColumn.withDefaults, undefined, [
        { isEditable: false, blankValue: null },
      ]),
    ).toThrow("preset blankValue requires potential editability");

    const predicate = vi.fn(() => true);
    const predicateNumberPreset = BrunoTableNumberColumn.withDefaults({
      isEditable: predicate,
      blankValue: null,
    });
    const predicateSelectPreset = BrunoTableSelectColumn.withDefaults({
      options: ["open", "closed"],
      isEditable: predicate,
      blankValue: null,
    });
    const predicateNumber = Reflect.apply(predicateNumberPreset, undefined, [
      { columnId: "COL_ID_PREDICATE_NUMBER", field: "nullable", headerName: "Number" },
    ]) as Readonly<Record<string, unknown>>;
    const predicateSelect = Reflect.apply(predicateSelectPreset, undefined, [
      { columnId: "COL_ID_PREDICATE_SELECT", field: "status", headerName: "Select" },
    ]) as Readonly<Record<string, unknown>>;
    expect(predicateNumber).toMatchObject({ isEditable: predicate, blankValue: null });
    expect(predicateSelect).toMatchObject({ isEditable: predicate, blankValue: null });
  });

  it("snapshots custom Value Type methods and validates their boundary results", () => {
    const custom: BrunoTableValueType<string, "equality", "text"> = {
      codecId: "example/upper-text",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 100,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value.toUpperCase(),
      parseCanonicalText: (text) => ({ _tag: "Success", value: text.toLowerCase() }),
      formatDisplay: (value) => value,
      encodePersisted: (value) => ({ value }),
      decodePersisted: (input) =>
        typeof input === "object" && input !== null && "value" in input
          ? { _tag: "Success", value: String(input.value) }
          : { _tag: "Failure", message: "Invalid persisted text." },
    };
    const mutableAggregateResults = { min: "self" as const };
    const mutableCustom = { ...custom, aggregateResults: mutableAggregateResults };
    const aggregateValueFormatter = () => "minimum";
    const [compiled] = compileColumns([
      {
        columnId: "COL_ID_CODE",
        field: "code",
        headerName: "Code",
        valueType: mutableCustom,
        groupBy: true,
        aggFunc: "min",
        aggregateValueFormatter,
      },
    ]);
    const semantics = compiled!.semantics;
    mutableCustom.formatCanonicalText = () => "mutated";
    Reflect.set(mutableAggregateResults, "min", "bigint");

    expect(semantics.formatCanonicalText("abc")).toBe("ABC");
    expect(semantics.parseCanonicalText("ABC")).toEqual({ _tag: "Success", value: "abc" });
    expect(semantics.aggregateResults).toEqual({ min: "self" });
    expect(Object.isFrozen(semantics.aggregateResults)).toBe(true);
    expect(compiled).toMatchObject({
      kind: "field",
      groupBy: true,
      aggFunc: "min",
      aggregateValueFormatter,
    });

    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_UNSUPPORTED_SUM",
          field: "code",
          headerName: "Unsupported sum",
          valueType: custom,
          aggFunc: "sum",
        },
      ]),
    ).toThrow("does not support sum aggregation");

    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_UNKNOWN_AGGREGATE",
          field: "code",
          headerName: "Unknown aggregate",
          valueType: { ...custom, aggregateResults: { median: "self" } },
        },
      ]),
    ).toThrow("aggregateResults does not accept median");

    const accessorAggregateResults = {};
    Object.defineProperty(accessorAggregateResults, "min", {
      enumerable: true,
      get: () => "self",
    });
    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_ACCESSOR_AGGREGATE",
          field: "code",
          headerName: "Accessor aggregate",
          valueType: { ...custom, aggregateResults: accessorAggregateResults },
        },
      ]),
    ).toThrow("aggregateResults must contain enumerable data properties");

    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_INVALID_AGGREGATE_RESULT",
          field: "code",
          headerName: "Invalid aggregate result",
          valueType: { ...custom, aggregateResults: { min: "number" } },
        },
      ]),
    ).toThrow("aggregateResults.min is invalid");

    const sparseCustom = {
      ...custom,
      encodePersisted: () => {
        const sparse: unknown[] = [];
        sparse.length = 1;
        return sparse as never;
      },
    };
    const [sparseCompiled] = compileColumns([
      {
        columnId: "COL_ID_SPARSE",
        field: "code",
        headerName: "Sparse",
        valueType: sparseCustom,
      },
    ]);
    expect(() => sparseCompiled!.semantics.encodePersisted("abc")).toThrow(
      "persisted output must be JSON-safe",
    );

    const malformed = { ...custom, codecId: "" };
    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_BAD",
          field: "code",
          headerName: "Bad",
          valueType: malformed,
        },
      ]),
    ).toThrow(ColumnConfigurationError);
  });

  it("compiles an exact two-state authority for custom Boolean editors", () => {
    type Toggle = "N" | "Y";
    const toggle: BrunoTableValueType<Toggle, "equality", "boolean"> = {
      codecId: "example/toggle",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "boolean",
      booleanEditorValues: ["N", "Y"],
      cellAlign: "center",
      editorLayout: "center",
      defaultWidth: 88,
      decodeRuntime: (input) =>
        input === "N" || input === "Y"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected N or Y." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left === "N" ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) =>
        text === "N" || text === "Y"
          ? { _tag: "Success", value: text }
          : { _tag: "Failure", message: "Expected N or Y." },
      formatDisplay: (value) => value,
      encodePersisted: (value) => value,
      decodePersisted: (input) =>
        input === "N" || input === "Y"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected N or Y." },
    };
    const compileToggle = (valueType: unknown) =>
      compileColumns([
        {
          columnId: "COL_ID_TOGGLE",
          field: "code",
          headerName: "Toggle",
          valueType: valueType as never,
        },
      ])[0]!.semantics;

    expect(compileToggle(toggle).booleanEditorCanonicalValues).toStrictEqual(["N", "Y"]);
    expect(() => compileToggle({ ...toggle, booleanEditorValues: ["N", "N"] })).toThrow(
      "must represent two distinct values",
    );
    const { booleanEditorValues: omitted, ...withoutMapping } = toggle;
    void omitted;
    expect(() => compileToggle(withoutMapping)).toThrow("require exactly [falseValue, trueValue]");
  });

  it("snapshots an exact aggregate algebra and rejects hostile capability pairs", () => {
    type Money = Readonly<{ readonly minorUnits: bigint }>;
    const mutable = {
      add: function (this: void, left: Money, right: Money): Money {
        if (this !== undefined) throw new Error("Aggregate add received a receiver.");
        return { minorUnits: left.minorUnits + right.minorUnits };
      },
      divideByCount: (total: Money, count: bigint): Money => ({
        minorUnits: total.minorUnits / count,
      }),
    };
    const algebra = BrunoTableAggregateAlgebra(mutable);
    const valueType: BrunoTableValueType<
      Money,
      "numeric",
      "text",
      { readonly sum: "self"; readonly avg: "self" }
    > = {
      codecId: "example/money",
      codecVersion: 1,
      filterFamily: "numeric",
      editorFamily: "text",
      cellAlign: "end",
      editorLayout: "inline",
      defaultWidth: 120,
      aggregateResults: { sum: "self", avg: "self" },
      aggregateAlgebra: algebra,
      decodeRuntime: (input) =>
        typeof input === "object" && input !== null && "minorUnits" in input
          ? { _tag: "Success", value: input as Money }
          : { _tag: "Failure", message: "Expected money." },
      equivalent: (left, right) => left.minorUnits === right.minorUnits,
      compare: (left, right) =>
        left.minorUnits === right.minorUnits ? 0 : left.minorUnits < right.minorUnits ? -1 : 1,
      formatCanonicalText: (value) => value.minorUnits.toString(),
      parseCanonicalText: (text) => ({
        _tag: "Success",
        value: { minorUnits: BigInt(text) },
      }),
      formatDisplay: (value) => value.minorUnits.toString(),
      encodePersisted: (value) => value.minorUnits.toString(),
      decodePersisted: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: { minorUnits: BigInt(input) } }
          : { _tag: "Failure", message: "Expected persisted money." },
    };
    const [compiled] = compileColumns([
      {
        columnId: "COL_ID_MONEY",
        field: "money",
        headerName: "Money",
        valueType,
        aggFunc: "avg",
      },
    ]);
    mutable.add = () => ({ minorUnits: 999n });
    expect(
      compiled?.semantics.aggregateAlgebra?.add({ minorUnits: 2n }, { minorUnits: 3n }),
    ).toEqual({ _tag: "Success", value: { minorUnits: 5n } });

    for (const aggregateResults of [
      { countDistinct: "self" },
      { sum: "bigint" },
      { min: "bigint" },
      { max: "bigint" },
      { avg: "bigint" },
    ]) {
      expect(() =>
        compileColumns([
          {
            columnId: "COL_ID_HOSTILE",
            field: "money",
            headerName: "Hostile",
            valueType: { ...valueType, aggregateResults },
          },
        ]),
      ).toThrow("aggregateResults");
    }
    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_MISSING_ALGEBRA",
          field: "money",
          headerName: "Missing algebra",
          valueType: {
            ...valueType,
            aggregateResults: { sum: "self" },
            aggregateAlgebra: undefined,
          },
          aggFunc: "sum",
        },
      ]),
    ).toThrow("sum aggregation requires an exact add operation");

    const addGetter = vi.fn();
    const accessorAlgebra = Object.defineProperty({}, "add", {
      enumerable: true,
      get: addGetter,
    });
    expect(() => BrunoTableAggregateAlgebra(accessorAlgebra as never)).toThrow(
      "requires an exact add operation",
    );
    expect(addGetter).not.toHaveBeenCalled();
    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_MISSING_DIVISION",
          field: "money",
          headerName: "Missing division",
          valueType: {
            ...valueType,
            aggregateResults: { avg: "self" },
            aggregateAlgebra: BrunoTableAggregateAlgebra<Money>({
              add: (left, right) => ({ minorUnits: left.minorUnits + right.minorUnits }),
            }),
          } as never,
          aggFunc: "avg",
        },
      ]),
    ).toThrow("avg aggregation requires an exact divideByCount operation");
  });

  it("rejects malformed equality and normalizes custom decoder failures", () => {
    const custom = {
      codecId: "example/hostile-text",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 100,
      decodeRuntime: () => {
        throw new Error("hostile runtime decoder");
      },
      equivalent: () => "false",
      compare: () => 0,
      formatCanonicalText: (value: unknown) => String(value),
      parseCanonicalText: () => ({ unexpected: true }),
      formatDisplay: (value: unknown) => String(value),
      encodePersisted: (value: unknown) => ({ value: String(value) }),
      decodePersisted: () => {
        throw new Error("hostile persistence decoder");
      },
    };
    const [compiled] = compileColumns([
      {
        columnId: "COL_ID_CODE",
        field: "code",
        headerName: "Code",
        valueType: custom,
      },
    ]);
    const semantics = compiled!.semantics;

    expect(() => semantics.equivalent("left", "right")).toThrow("equivalent must return a boolean");
    expect(semantics.decodeRuntime("code")).toEqual({
      _tag: "Failure",
      message: "BrunoTable Value Type decodeRuntime failed.",
    });
    expect(semantics.parseCanonicalText("code")).toEqual({
      _tag: "Failure",
      message: "BrunoTable Value Type parseCanonicalText failed.",
    });
    expect(semantics.decodePersisted({ value: "code" })).toEqual({
      _tag: "Failure",
      message: "BrunoTable Value Type decodePersisted failed.",
    });
  });

  it("rejects a custom Select editor family without helper-owned option provenance", () => {
    const unsupported = {
      codecId: "test/custom-select",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "select",
      cellAlign: "start",
      editorLayout: "fullWidth",
      defaultWidth: 120,
      decodeRuntime: (input: unknown) => ({ _tag: "Success", value: String(input) }),
      equivalent: Object.is,
      compare: () => 0,
      formatCanonicalText: String,
      parseCanonicalText: (text: string) => ({ _tag: "Success", value: text }),
      formatDisplay: String,
      encodePersisted: String,
      decodePersisted: (input: unknown) => ({ _tag: "Success", value: String(input) }),
    };

    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_UNSUPPORTED_SELECT",
          field: "value",
          headerName: "Unsupported Select",
          valueType: unsupported as never,
          isEditable: true,
        },
      ]),
    ).toThrow("custom Value Types cannot use the Select editor family");
  });

  it("rejects malformed helper and presentation configuration", () => {
    const callSelectAtRuntime = BrunoTableSelectColumn as unknown as (
      options: Readonly<Record<string, unknown>>,
    ) => unknown;
    expect(() =>
      callSelectAtRuntime({
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        options: [],
      }),
    ).toThrow("options must be a non-empty array");
    expect(() =>
      callSelectAtRuntime({
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        options: ["open", 1],
      }),
    ).toThrow("one homogeneous");
    expect(() =>
      Reflect.apply(BrunoTableNumberColumn.withDefaults, undefined, [
        { headerName: "Price", columnId: "COL_ID_PRICE" },
      ]),
    ).toThrow("preset does not accept columnId");
    expect(() =>
      Reflect.apply(BrunoTableNumberColumn, undefined, [
        {
          columnId: "COL_ID_PRICE",
          field: "price",
          headerName: "Price",
          valueType: "text",
        },
      ]),
    ).toThrow("do not accept a valueType override");
    expect(() =>
      Reflect.apply(BrunoTableNumberColumn, undefined, [
        {
          columnId: "COL_ID_PRICE",
          field: "price",
          headerName: "Price",
          format: "invalid",
        },
      ]),
    ).toThrow("format must be an object");
    expect(() =>
      compileColumns([
        Reflect.apply(BrunoTableNumberColumn, undefined, [
          {
            columnId: "COL_ID_PRICE",
            field: "price",
            headerName: "Price",
            format: { maximumFractionDigit: 2 },
          },
        ]) as never,
      ]),
    ).toThrow("does not accept maximumFractionDigit");
    expect(() =>
      Reflect.apply(BrunoTableNumberColumn.withDefaults, undefined, [
        { headerName: "Price", format: "invalid" },
      ]),
    ).toThrow("format must be an object");
    expect(() =>
      Reflect.apply(BrunoTableNumberColumn, undefined, [
        {
          columnId: "COL_ID_PRICE",
          field: "price",
          headerName: "Price",
          mysteryOption: true,
        },
      ]),
    ).toThrow("does not accept mysteryOption");
    expect(() =>
      Reflect.apply(BrunoTableSelectColumn, undefined, [
        {
          columnId: "COL_ID_STATUS",
          field: "status",
          headerName: "Status",
          options: ["open", "closed"],
          mysteryOption: true,
        },
      ]),
    ).toThrow("does not accept mysteryOption");
    const statusPreset = BrunoTableSelectColumn.withDefaults({
      headerName: "Status",
      options: ["open", "closed"],
    });
    expect(() =>
      Reflect.apply(statusPreset, undefined, [
        {
          columnId: "COL_ID_STATUS",
          field: "status",
          options: ["open"],
        },
      ]),
    ).toThrow("preset options cannot be overridden");
    for (const [key, message] of [
      ["cellAlign", "cellAlign must be"],
      ["editorLayout", "editorLayout must be"],
      ["width", "width must be"],
    ] as const) {
      expect(() =>
        Reflect.apply(compileColumns, undefined, [
          [
            {
              columnId: "COL_ID_SYMBOL",
              field: "symbol",
              headerName: "Symbol",
              valueType: "text",
              [key]: null,
            },
          ],
        ]),
      ).toThrow(message);
    }
    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_SYMBOL",
          field: "symbol",
          headerName: "Symbol",
          valueType: "text",
          format: { maximumFractionDigits: 2 },
        },
      ]),
    ).toThrow("format is supported only");
    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_SYMBOL",
          field: "symbol",
          headerName: "Symbol",
          valueType: "text",
          cellRenderer: "not a function",
        },
      ]),
    ).toThrow("cellRenderer must be a function");
  });

  it("preserves typed validation callbacks through field Column Helpers", () => {
    const validate = ({ value }: { readonly value: number }) =>
      value >= 0 ? undefined : "Price must be non-negative.";
    const helperColumns = [
      BrunoTableNumberColumn({
        columnId: "COL_ID_PRICE",
        field: "price",
        headerName: "Price",
        isEditable: true,
        validate,
      }),
    ] satisfies BrunoTableColumns<SemanticRow>;

    expect(helperColumns[0]?.validate).toBe(validate);
    const compiled = compileColumns(helperColumns)[0];
    expect(compiled?.kind === "field" ? compiled.validate : undefined).toBe(validate);
  });

  it("snapshots reusable preset defaults before later caller mutation", () => {
    const numberDefaults = {
      headerName: "Price",
      width: 112,
      format: { minimumFractionDigits: 2 },
    };
    const numberPreset = Reflect.apply(BrunoTableNumberColumn.withDefaults, undefined, [
      numberDefaults,
    ]);
    numberDefaults.headerName = "Mutated";
    numberDefaults.width = 999;
    numberDefaults.format.minimumFractionDigits = 9;
    Object.assign(numberDefaults, { columnId: "COL_ID_HIDDEN", field: "price" });

    const numberColumn = Reflect.apply(numberPreset, undefined, [
      { columnId: "COL_ID_PRICE", field: "price" },
    ]);
    expect(numberColumn).toMatchObject({
      columnId: "COL_ID_PRICE",
      field: "price",
      headerName: "Price",
      width: 112,
      format: { minimumFractionDigits: 2 },
    });
    const numberColumnWithoutIdentity = Reflect.apply(numberPreset, undefined, [
      { field: "price" },
    ]);
    expect(numberColumnWithoutIdentity).not.toHaveProperty("columnId");

    const selectOptions: ["open", "closed"] = ["open", "closed"];
    const selectDefaults = { headerName: "Status", options: selectOptions };
    const selectPreset = Reflect.apply(BrunoTableSelectColumn.withDefaults, undefined, [
      selectDefaults,
    ]);
    selectOptions.reverse();
    Object.assign(selectDefaults, { valueType: "text" });

    const selectColumn = Reflect.apply(selectPreset, undefined, [
      { columnId: "COL_ID_STATUS", field: "status" },
    ]);
    expect(selectColumn).toMatchObject({
      columnId: "COL_ID_STATUS",
      field: "status",
      headerName: "Status",
      options: ["open", "closed"],
    });
  });
});
