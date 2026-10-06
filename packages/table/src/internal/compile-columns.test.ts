import { describe, expect, it } from "vitest";

import {
  BrunoTableNumberColumn,
  BrunoTableSelectColumn,
  BrunoTableTextColumn,
} from "../column-helpers";
import type { BrunoTableColumns } from "../public-types";
import { ColumnConfigurationError, compileColumns } from "./compile-columns";

describe("compileColumns", () => {
  it("preserves an exact nullable blank representation through Column Helpers", () => {
    const definitions = [
      BrunoTableNumberColumn({
        columnId: "COL_ID_OPTIONAL_SCORE",
        field: "score",
        headerName: "Optional score",
        isEditable: true,
        blankValue: undefined,
      }),
    ] satisfies BrunoTableColumns<{ readonly score: number | undefined }>;

    const [compiled] = compileColumns(definitions);

    expect(compiled?.kind === "field" ? compiled.blankValue : undefined).toStrictEqual({
      value: undefined,
    });
    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_READ_ONLY_BLANK",
          field: "score",
          headerName: "Read-only blank",
          valueType: "number",
          blankValue: null,
        },
      ]),
    ).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable blankValue requires a potentially editable field column: COL_ID_READ_ONLY_BLANK",
      ),
    );

    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_READ_ONLY_VALIDATE",
          field: "score",
          headerName: "Read-only validate",
          valueType: "number",
          validate: () => undefined,
        },
      ]),
    ).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable validate requires a potentially editable field column: COL_ID_READ_ONLY_VALIDATE",
      ),
    );
  });

  it("rejects mutated helper structural evidence before compiling presentation callbacks", () => {
    const callback = () => "helper-owned";
    const [helperColumn] = [
      BrunoTableTextColumn({
        columnId: "COL_ID_SYMBOL",
        field: "symbol",
        groupBy: true,
        headerName: "Symbol",
        groupKeyValueFormatter: callback,
      }),
    ] satisfies BrunoTableColumns<{ readonly symbol: string; readonly status: string }>;
    const originalHelperColumn = helperColumn!;
    const customized = { ...originalHelperColumn, headerName: "Customized symbol", width: 180 };

    const [compiled] = compileColumns([customized]);

    expect(compiled?.kind === "field" ? compiled.groupKeyValueFormatter : undefined).toBe(callback);
    expect(Object.getOwnPropertySymbols(customized)).toHaveLength(1);
    expect(
      Object.prototype.propertyIsEnumerable.call(
        customized,
        Object.getOwnPropertySymbols(customized)[0]!,
      ),
    ).toBe(true);
    expect(Object.getOwnPropertySymbols(compiled ?? {})).toHaveLength(0);
    expect(JSON.stringify(customized)).not.toContain("provenance");

    let replacementReads = 0;
    const changedCallback = Object.defineProperty(
      { ...originalHelperColumn },
      "groupKeyValueFormatter",
      {
        enumerable: true,
        get() {
          replacementReads += 1;
          return () => "replacement";
        },
      },
    );
    expect(() => compileColumns([changedCallback])).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable Column Helper structural evidence does not match groupKeyValueFormatter: COL_ID_SYMBOL",
      ),
    );
    expect(replacementReads).toBe(0);
    const { groupKeyValueFormatter: _removedCallback, ...withoutCallback } = originalHelperColumn;
    expect(() => compileColumns([withoutCallback])).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable Column Helper structural evidence does not match groupKeyValueFormatter: COL_ID_SYMBOL",
      ),
    );

    const [helperWithoutGroupedCallback] = [
      BrunoTableTextColumn({
        columnId: "COL_ID_STATUS",
        field: "status",
        groupBy: true,
        headerName: "Status",
      }),
    ] satisfies BrunoTableColumns<{ readonly symbol: string; readonly status: string }>;
    expect(() =>
      compileColumns([{ ...helperWithoutGroupedCallback, groupKeyValueFormatter: callback }]),
    ).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable Column Helper structural evidence does not match groupKeyValueFormatter: COL_ID_STATUS",
      ),
    );

    const [plainHelper] = [
      BrunoTableTextColumn({
        columnId: "COL_ID_PLAIN",
        field: "status",
        headerName: "Plain",
      }),
    ] satisfies BrunoTableColumns<{ readonly status: string }>;
    const sealedPropertyKeys = [
      "valueGetter",
      "valueFormatter",
      "cellClassName",
      "cellRenderer",
      "isEditable",
      "groupKeyValueFormatter",
      "groupKeyCellClassName",
      "groupKeyCellRenderer",
      "aggregateValueFormatter",
      "aggregateCellClassName",
      "aggregateCellRenderer",
      "groupBy",
      "aggFunc",
    ] as const;
    for (const key of sealedPropertyKeys) {
      let getterReads = 0;
      const accessorAddition = Object.defineProperty({ ...plainHelper! }, key, {
        enumerable: true,
        get() {
          getterReads += 1;
          return key === "groupBy" ? true : key === "aggFunc" ? "max" : callback;
        },
      });
      expect(() => compileColumns([accessorAddition])).toThrowError(
        new ColumnConfigurationError(
          `BrunoTable Column Helper structural evidence does not match ${key}: COL_ID_PLAIN`,
        ),
      );
      expect(getterReads).toBe(0);
    }

    let callbackReads = 0;
    const changedIdentity = Object.defineProperty(
      { ...originalHelperColumn, columnId: "COL_ID_CHANGED_SYMBOL" },
      "groupKeyValueFormatter",
      {
        enumerable: true,
        get() {
          callbackReads += 1;
          return callback;
        },
      },
    );
    expect(() => compileColumns([changedIdentity])).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable Column Helper structural evidence does not match columnId: COL_ID_CHANGED_SYMBOL",
      ),
    );
    expect(callbackReads).toBe(0);
    expect(() => compileColumns([{ ...originalHelperColumn, groupBy: false }])).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable Column Helper structural evidence does not match groupBy: COL_ID_SYMBOL",
      ),
    );
    expect(() => compileColumns([{ ...originalHelperColumn, field: "status" }])).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable Column Helper structural evidence does not match field: COL_ID_SYMBOL",
      ),
    );
    expect(() => compileColumns([{ ...originalHelperColumn, valueType: "number" }])).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable Column Helper structural evidence does not match valueType: COL_ID_SYMBOL",
      ),
    );

    const [aggregate] = [
      BrunoTableNumberColumn({
        columnId: "COL_ID_MAX_PRICE",
        field: "price",
        headerName: "Maximum price",
        aggFunc: "max",
        aggregateValueFormatter: ({ value }) => value.toFixed(2),
      }),
    ] satisfies BrunoTableColumns<{ readonly price: number }>;
    const originalAggregate = aggregate!;
    let aggregateCallbackReads = 0;
    const changedAggregate = Object.defineProperty(
      { ...originalAggregate, aggFunc: "countDistinct" },
      "aggregateValueFormatter",
      {
        enumerable: true,
        get() {
          aggregateCallbackReads += 1;
          return originalAggregate.aggregateValueFormatter;
        },
      },
    );
    expect(() => compileColumns([changedAggregate])).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable Column Helper structural evidence does not match aggFunc: COL_ID_MAX_PRICE",
      ),
    );
    expect(aggregateCallbackReads).toBe(0);

    const [computed] = [
      BrunoTableNumberColumn({
        columnId: "COL_ID_NOTIONAL",
        fields: ["price", "quantity"],
        headerName: "Notional",
        valueGetter: ({ row }) => row.price * row.quantity,
      }),
    ] satisfies BrunoTableColumns<{
      readonly price: number;
      readonly quantity: number;
    }>;
    expect(() => compileColumns([{ ...computed, fields: ["price"] }])).toThrowError(
      new ColumnConfigurationError(
        "BrunoTable Column Helper structural evidence does not match fields: COL_ID_NOTIONAL",
      ),
    );

    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_RAW",
          field: "changed",
          headerName: "Raw",
          valueType: "text",
        },
      ]),
    ).not.toThrow();
  });

  it("compiles immutable field and computed representations once", () => {
    const valueGetter = ({ row }: { row: { price: number; quantity: number } }) =>
      row.price * row.quantity;
    const dependencies = ["price", "quantity"];
    const columns = [
      {
        columnId: "COL_ID_PRICE",
        field: "price",
        headerName: "Price",
        valueType: "number",
      },
      {
        columnId: "COL_ID_NOTIONAL",
        fields: dependencies,
        headerName: "Notional",
        valueGetter,
        valueType: "number",
      },
    ];

    const compiled = compileColumns(columns);

    expect(compiled).toEqual([
      expect.objectContaining({
        kind: "field",
        columnId: "COL_ID_PRICE",
        field: "price",
        enableFilter: true,
        enableSorting: true,
      }),
      expect.objectContaining({
        kind: "computed",
        columnId: "COL_ID_NOTIONAL",
        enableFilter: false,
        enableSorting: false,
        fields: ["price", "quantity"],
        valueGetter,
      }),
    ]);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled[0])).toBe(true);
    expect(Object.isFrozen(compiled[1])).toBe(true);

    dependencies.push("status");
    expect(compiled[1]?.kind === "computed" ? compiled[1].fields : undefined).toEqual([
      "price",
      "quantity",
    ]);
  });

  it("defaults bounded Boolean and Select facets on and requires explicit opt-in otherwise", () => {
    type FacetRow = {
      readonly active: boolean;
      readonly status: "open" | "closed";
      readonly name: string;
      readonly score: number;
    };
    const definitions = [
      {
        columnId: "COL_ID_ACTIVE",
        field: "active",
        headerName: "Active",
        valueType: "boolean",
      },
      BrunoTableSelectColumn({
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        options: ["open", "closed"] as const,
      }),
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SCORE",
        enableSetFilter: true,
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
      {
        columnId: "COL_ID_DISABLED_BOOLEAN",
        enableFilter: false,
        field: "active",
        headerName: "Disabled Boolean",
        valueType: "boolean",
      },
    ] satisfies import("../public-types").BrunoTableColumns<FacetRow>;
    const compiled = compileColumns(definitions);

    expect(compiled.map((column) => column.enableSetFilter)).toEqual([
      true,
      true,
      false,
      true,
      false,
    ]);
  });

  it("snapshots accessor-backed definition properties once", () => {
    const reads = new Map<string, number>();
    const valueGetter = () => 42;
    const valueFormatter = () => "42";
    const property = (name: string, firstValue: unknown, laterValue: unknown) => ({
      enumerable: true,
      get() {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        return count === 1 ? firstValue : laterValue;
      },
    });
    const definition = Object.defineProperties(
      {},
      {
        columnId: property("columnId", "COL_ID_COMPUTED", "COL_ID_changed"),
        headerName: property("headerName", "Computed", ""),
        valueType: property("valueType", "number", "invalid"),
        fields: property("fields", ["price"], []),
        valueGetter: property("valueGetter", valueGetter, "not a function"),
        valueFormatter: property("valueFormatter", valueFormatter, 42),
      },
    );

    const compiled = compileColumns([definition]);

    expect(Object.fromEntries(reads)).toEqual({
      columnId: 1,
      headerName: 1,
      valueType: 1,
      fields: 1,
      valueGetter: 1,
      valueFormatter: 1,
    });
    expect(compiled[0]).toEqual({
      kind: "computed",
      columnId: "COL_ID_COMPUTED",
      headerName: "Computed",
      valueType: "number",
      enableFilter: false,
      enableSetFilter: false,
      enableSorting: false,
      fields: ["price"],
      valueGetter,
      valueFormatter,
      semantics: expect.objectContaining({
        codecId: "@bruno/table/number",
        filterFamily: "numeric",
        editorFamily: "number",
        cellAlign: "end",
        editorLayout: "inline",
        width: 120,
      }),
    });

    let fieldReads = 0;
    let editableReads = 0;
    let enableFilterReads = 0;
    let enableSortingReads = 0;
    const fieldDefinition = Object.defineProperties(
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
      },
      {
        field: {
          enumerable: true,
          get() {
            fieldReads += 1;
            return fieldReads === 1 ? "price" : 42;
          },
        },
        isEditable: {
          enumerable: true,
          get() {
            editableReads += 1;
            return editableReads === 1;
          },
        },
        enableFilter: {
          enumerable: true,
          get() {
            enableFilterReads += 1;
            return enableFilterReads === 1 ? false : "invalid";
          },
        },
        enableSorting: {
          enumerable: true,
          get() {
            enableSortingReads += 1;
            return enableSortingReads === 1 ? true : "invalid";
          },
        },
      },
    );

    const [compiledField] = compileColumns([fieldDefinition]);

    expect({ fieldReads, editableReads, enableFilterReads, enableSortingReads }).toEqual({
      fieldReads: 1,
      editableReads: 1,
      enableFilterReads: 1,
      enableSortingReads: 1,
    });
    expect(compiledField).toEqual({
      kind: "field",
      columnId: "COL_ID_PRICE",
      headerName: "Price",
      valueType: "number",
      field: "price",
      groupBy: false,
      enableFilter: false,
      enableSetFilter: false,
      enableSorting: true,
      isEditable: true,
      semantics: expect.objectContaining({
        codecId: "@bruno/table/number",
        cellAlign: "end",
        editorLayout: "inline",
        width: 120,
      }),
    });
  });

  it("accepts unique namespaced uppercase identities", () => {
    expect(() => {
      compileColumns([
        {
          columnId: "COL_ID_SYMBOL",
          field: "symbol",
          headerName: "Symbol",
          valueType: "text",
        },
        {
          columnId: "COL_ID_AÉTAT",
          field: "state",
          headerName: "State",
          valueType: "text",
        },
      ]);
    }).not.toThrow();
  });

  it("rejects malformed identities, duplicate identities, and missing headers", () => {
    for (const columnId of [
      "price",
      "COL_ID_price",
      "COL_ID_",
      "COL_ID_ÉTAT",
      "COL_ID_-TOTAL",
      "COL_ID_A B",
      "COL_ID_A\tB",
      "COL_ID_A\nB",
      "COL_ID_A\u00a0B",
      "COL_ID_A\u3000B",
      "COL_ID_BRUNO_TABLE_ROWS",
      "COL_ID_BRUNO_TABLE_ROW_SELECTION",
      "COL_ID_é",
      "COL_ID_ß",
      "COL_ID_δ",
      42,
      null,
      undefined,
      Symbol("COL_ID_PRICE"),
    ]) {
      expect(() => {
        compileColumns([{ columnId, field: "price", headerName: "Price", valueType: "number" }]);
      }).toThrow(ColumnConfigurationError);
    }

    expect(() => {
      compileColumns([
        {
          columnId: "COL_ID_BRUNO_TABLE_ROWS",
          field: "price",
          headerName: "Rows",
          valueType: "number",
        },
      ]);
    }).toThrow("BrunoTable columnId is reserved for the Rows System Column");

    expect(() => {
      compileColumns([
        {
          columnId: "COL_ID_BRUNO_TABLE_ROW_SELECTION",
          field: "price",
          headerName: "Selection",
          valueType: "number",
        },
      ]);
    }).toThrow("BrunoTable columnId is reserved for the Row Selection Column");

    expect(() => {
      compileColumns([
        {
          columnId: "COL_ID_PRICE",
          field: "price",
          headerName: "Price",
          valueType: "number",
        },
        {
          columnId: "COL_ID_PRICE",
          field: "price",
          headerName: "Unit price",
          valueType: "number",
        },
      ]);
    }).toThrow("BrunoTable columnId must be unique: COL_ID_PRICE");

    for (const headerName of [undefined, 42, "   "]) {
      expect(() => {
        compileColumns([
          { columnId: "COL_ID_PRICE", field: "price", headerName, valueType: "number" },
        ]);
      }).toThrow(ColumnConfigurationError);
    }

    const hostileColumnId = {
      [Symbol.toPrimitive]() {
        throw new Error("must not coerce an invalid Column Identity");
      },
    };

    expect(() => {
      compileColumns([
        {
          columnId: hostileColumnId,
          field: "price",
          headerName: "Price",
          valueType: "number",
        },
      ]);
    }).toThrow(ColumnConfigurationError);
  });

  it("rejects select options outside the compiled value domain", () => {
    const select = BrunoTableSelectColumn<
      { status: "open" | "closed" },
      readonly ["open", "closed"],
      "status",
      "COL_ID_STATUS",
      {
        readonly columnId: "COL_ID_STATUS";
        readonly field: "status";
        readonly headerName: "Status";
        readonly options: readonly ["open", "closed"];
      }
    >({
      columnId: "COL_ID_STATUS",
      field: "status",
      headerName: "Status",
      options: ["open", "closed"],
    }) as unknown as Readonly<Record<string, unknown>>;
    const widened = { ...select, options: ["pending"] };

    expect(() => compileColumns([widened])).toThrow(ColumnConfigurationError);
    expect(() => compileColumns([widened])).toThrow(/option at index 0 is invalid/u);
  });

  it("wraps a throwing Select decoder in a ColumnConfigurationError", () => {
    const throwingValueType = {
      codecId: "test/throwing-select-decoder",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "select",
      cellAlign: "start",
      editorLayout: "fullWidth",
      defaultWidth: 160,
      decodeRuntime: () => {
        throw new Error("decoder exploded");
      },
      equivalent: (left: unknown, right: unknown) => Object.is(left, right),
      compare: () => 0,
      formatCanonicalText: (value: unknown) => String(value),
      parseCanonicalText: (text: string) => ({ _tag: "Success" as const, value: text }),
      formatDisplay: (value: unknown) => String(value),
      encodePersisted: (value: unknown) => String(value),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;

    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_THROWING_SELECT",
          field: "status",
          headerName: "Status",
          valueType: throwingValueType,
          options: ["open"],
        } as never,
      ]),
    ).toThrow(
      "BrunoTable Select column option at index 0 is invalid for COL_ID_THROWING_SELECT: BrunoTable Value Type decodeRuntime failed.",
    );
  });

  it("rejects sparse Select option arrays", () => {
    const select = Reflect.apply(BrunoTableSelectColumn, undefined, [
      {
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        options: ["open", "closed"],
      },
    ]) as Readonly<Record<string, unknown>>;
    const sparseOptions = Array(2) as unknown[];

    expect(() => compileColumns([{ ...select, options: sparseOptions }])).toThrow(
      ColumnConfigurationError,
    );
    expect(() => compileColumns([{ ...select, options: sparseOptions }])).toThrow(
      /options must be dense/u,
    );
  });

  it("bounds Select option snapshotting before decoding", () => {
    const select = Reflect.apply(BrunoTableSelectColumn, undefined, [
      {
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        options: ["open", "closed"],
      },
    ]) as Readonly<Record<string, unknown>>;
    const options = Array.from({ length: 16_385 }, (_, index) => String(index));

    expect(() => compileColumns([{ ...select, options }])).toThrow(
      /options must contain at most 16384 values/u,
    );

    let lengthReads = 0;
    const stableOptions = new Proxy(["open", "closed"], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return lengthReads === 1 ? 2 : 16_385;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const [compiled] = compileColumns([{ ...select, options: stableOptions }]);

    expect(compiled?.selectOptions).toHaveLength(2);
    expect(lengthReads).toBe(1);
  });

  it("rejects malformed widened Field Columns", () => {
    for (const column of [
      null,
      [],
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "currency",
        field: "price",
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
        field: " ",
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
        field: "price",
        isEditable: "yes",
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
        field: "price",
        enableFilter: "yes",
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
        field: "price",
        enableFilter: false,
        enableSetFilter: true,
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
        field: "price",
        enableSorting: 1,
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
        field: "price",
        valueFormatter: 42,
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
        field: "price",
        groupBy: false,
        groupKeyValueFormatter: () => "Price",
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
        field: "price",
        aggregateValueFormatter: () => "Price",
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
        field: "price",
        aggFunc: "sum",
      },
      {
        columnId: "COL_ID_PRICE",
        headerName: "Price",
        valueType: "number",
        field: "price",
        fields: ["price"],
        valueGetter: () => 1,
      },
    ]) {
      expect(() => compileColumns([column])).toThrow(ColumnConfigurationError);
    }
  });

  it("rejects sparse top-level and computed dependency arrays", () => {
    expect(() => compileColumns(Array(1))).toThrow(ColumnConfigurationError);

    expect(() =>
      compileColumns([
        {
          columnId: "COL_ID_NOTIONAL",
          headerName: "Notional",
          valueType: "number",
          fields: Array(1),
          valueGetter: () => 1,
        },
      ]),
    ).toThrow(ColumnConfigurationError);
  });

  it("rejects malformed widened Computed Columns", () => {
    for (const column of [
      {
        columnId: "COL_ID_NOTIONAL",
        headerName: "Notional",
        valueType: "number",
        fields: [],
        valueGetter: () => 1,
      },
      {
        columnId: "COL_ID_NOTIONAL",
        headerName: "Notional",
        valueType: "number",
        fields: ["price", ""],
        valueGetter: () => 1,
      },
      {
        columnId: "COL_ID_NOTIONAL",
        headerName: "Notional",
        valueType: "number",
        fields: ["price"],
        valueGetter: "not a function",
      },
      {
        columnId: "COL_ID_NOTIONAL",
        headerName: "Notional",
        valueType: "number",
        fields: ["price"],
        valueGetter: () => 1,
        isEditable: false,
      },
      {
        columnId: "COL_ID_NOTIONAL",
        headerName: "Notional",
        valueType: "number",
        fields: ["price"],
        valueGetter: () => 1,
        enableFilter: false,
      },
      {
        columnId: "COL_ID_NOTIONAL",
        headerName: "Notional",
        valueType: "number",
        fields: ["price"],
        valueGetter: () => 1,
        enableSetFilter: false,
      },
      {
        columnId: "COL_ID_NOTIONAL",
        headerName: "Notional",
        valueType: "number",
        fields: ["price"],
        valueGetter: () => 1,
        enableSorting: false,
      },
      {
        columnId: "COL_ID_NOTIONAL",
        headerName: "Notional",
        valueType: "number",
        fields: ["price"],
        valueGetter: () => 1,
        groupBy: true,
      },
    ]) {
      expect(() => compileColumns([column])).toThrow(ColumnConfigurationError);
    }
  });
});
