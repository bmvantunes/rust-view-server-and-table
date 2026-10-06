import { afterEach, describe, expect, it, vi } from "vitest";

import { BrunoTableSelectColumn } from "../column-helpers";
import { compileColumns } from "./compile-columns";
import {
  createBrunoTableClientRowComparator,
  createClientFilterPredicate,
  filterClientRows,
  filterReferencesColumn,
  reconcileClientOrderBy,
  sanitizeClientInitialFilters,
  sanitizeClientInitialOrderBy,
  sanitizeClientOrderBy,
} from "./client-row-model";
import {
  BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS,
  BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_TEXT_LENGTH,
  compileClientFilterCollection,
  compileClientFilterPlan,
  removeClientFilterColumn,
  restoreClientFilterColumn,
  replaceClientFilterColumn,
} from "./grid-query";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Client row model", () => {
  it("sorts exact number and bigint keys by priority with stable source-order ties", () => {
    type ExactRow = Readonly<{
      sourceIndex: number;
      score: number;
      quantity: bigint;
      label: string;
    }>;
    const columns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
      {
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        headerName: "Quantity",
        valueType: "bigint",
      },
    ]);
    const rows = [
      {
        sourceIndex: 0,
        score: 1.25,
        quantity: 9_007_199_254_740_993n,
        label: "first equal key",
      },
      {
        sourceIndex: 1,
        score: 1.5,
        quantity: 9_007_199_254_740_994n,
        label: "higher number priority",
      },
      {
        sourceIndex: 2,
        score: 1.25,
        quantity: 9_007_199_254_740_992n,
        label: "lower exact bigint",
      },
      {
        sourceIndex: 3,
        score: 1.25,
        quantity: 9_007_199_254_740_993n,
        label: "second equal key",
      },
    ] satisfies readonly ExactRow[];
    const compare = createBrunoTableClientRowComparator<ExactRow>(
      columns,
      [
        { columnId: "COL_ID_SCORE", direction: "asc" },
        { columnId: "COL_ID_QUANTITY", direction: "desc" },
      ],
      (column, row) => (column.columnId === "COL_ID_SCORE" ? row.score : row.quantity),
      (row) => row.sourceIndex,
    );

    expect(rows.toSorted(compare).map((row) => row.label)).toEqual([
      "first equal key",
      "second equal key",
      "lower exact bigint",
      "higher number priority",
    ]);
  });

  it("uses locale-independent case normalization", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const localeLowerCase = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(() => {
        throw new Error("locale-sensitive normalization must not run");
      });

    expect(
      filterClientRows([{ id: "first", name: "I" }], columns, [
        { columnId: "COL_ID_NAME", type: "equals", filter: "i" },
      ]),
    ).toEqual([{ id: "first", name: "I" }]);
    expect(localeLowerCase).not.toHaveBeenCalled();
  });

  it("compiles text filter operands once before evaluating rows", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const normalize = vi.spyOn(String.prototype, "normalize");
    const predicate = createClientFilterPredicate(columns, [
      { columnId: "COL_ID_NAME", type: "equals", filter: "ada" },
    ]);
    const rows = [{ name: "Ada" }, { name: "Grace" }, { name: "ADA" }];

    expect(normalize).toHaveBeenCalledTimes(1);
    expect(rows.filter(predicate!)).toEqual([{ name: "Ada" }, { name: "ADA" }]);
    expect(normalize).toHaveBeenCalledTimes(rows.length + 1);
  });

  it("shares compiled filter operands across Client row adapters", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const filters = [{ columnId: "COL_ID_NAME", type: "equals", filter: "ada" }];
    const normalize = vi.spyOn(String.prototype, "normalize");
    const plan = compileClientFilterPlan(columns, filters);

    createClientFilterPredicate(
      columns,
      filters,
      (_column, row: { name: string }) => row.name,
      plan,
    );
    createClientFilterPredicate(
      columns,
      filters,
      (_column, row: { name: string }) => row.name,
      plan,
    );

    expect(normalize).toHaveBeenCalledTimes(1);
  });

  it("sanitizes direct predicate plans before compiling hostile filters", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);

    expect(
      compileClientFilterPlan(columns, [{ columnId: "COL_ID_NAME", type: "in", filter: [] }]),
    ).toBeUndefined();
    expect(
      createClientFilterPredicate(columns, [{ columnId: "COL_ID_NAME", type: "in", filter: [] }]),
    ).toBeUndefined();
  });

  it("normalizes canonically equivalent accent-sensitive text", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);

    expect(
      filterClientRows([{ name: "caf\u00e9" }], columns, [
        {
          accentSensitive: true,
          columnId: "COL_ID_NAME",
          filter: "cafe\u0301",
          type: "equals",
        },
      ]),
    ).toHaveLength(1);
  });

  it("requires a valid initial sort and removes invalid or duplicate live entries", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);

    expect(() => sanitizeClientInitialOrderBy(undefined, columns)).toThrow(
      "BrunoTable initialOrderBy is required.",
    );
    expect(() =>
      sanitizeClientInitialOrderBy([{ columnId: "COL_ID_MISSING", direction: "asc" }], columns),
    ).toThrow(/no valid sortable column/u);
    expect(() =>
      sanitizeClientInitialOrderBy(
        null as unknown as Parameters<typeof sanitizeClientInitialOrderBy>[0],
        columns,
      ),
    ).toThrow(/no valid sortable column/u);
    expect(() =>
      sanitizeClientInitialOrderBy(
        [null] as unknown as Parameters<typeof sanitizeClientInitialOrderBy>[0],
        columns,
      ),
    ).toThrow(/no valid sortable column/u);
    expect(
      sanitizeClientInitialFilters(
        null as unknown as Parameters<typeof sanitizeClientInitialFilters>[0],
        columns,
      ),
    ).toEqual([]);
    expect(
      sanitizeClientOrderBy(
        [
          { columnId: "COL_ID_NAME", direction: "asc" },
          { columnId: "COL_ID_NAME", direction: "desc" },
          { columnId: "COL_ID_MISSING", direction: "asc" },
        ],
        columns,
      ),
    ).toEqual([{ columnId: "COL_ID_NAME", direction: "asc" }]);

    const sortFreeColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        enableSorting: false,
      },
    ]);
    expect(() =>
      sanitizeClientInitialOrderBy(
        [{ columnId: "COL_ID_NAME", direction: "asc" }],
        sortFreeColumns,
      ),
    ).toThrow(/requires at least one sortable column/u);
  });

  it("restores valid non-empty sorting and falls back to its baseline otherwise", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    const baseline = sanitizeClientInitialOrderBy(
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
      columns,
    );

    expect(
      reconcileClientOrderBy(
        [
          { columnId: "COL_ID_SCORE", direction: "desc" },
          { columnId: "COL_ID_SCORE", direction: "asc" },
        ],
        baseline,
        columns,
      ),
    ).toEqual([{ columnId: "COL_ID_SCORE", direction: "desc" }]);
    expect(reconcileClientOrderBy([], baseline, columns)).toEqual(baseline);
    expect(
      reconcileClientOrderBy([{ columnId: "COL_ID_STALE", direction: "asc" }], baseline, columns),
    ).toEqual(baseline);
  });

  it("keeps nullable text rows for notContains and applies half-open numeric ranges", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    const rows = [
      { id: "blank", name: null, score: 1 },
      { id: "middle", name: "Ada", score: 2 },
      { id: "upper", name: "Grace", score: 3 },
    ] as const;

    expect(
      filterClientRows(rows, columns, [
        { columnId: "COL_ID_NAME", type: "notContains", filter: "da" },
      ]).map((row) => row.id),
    ).toEqual(["blank", "upper"]);
    expect(
      filterClientRows(rows, columns, [
        { columnId: "COL_ID_SCORE", type: "inRange", filter: 1, filterTo: 3 },
      ]).map((row) => row.id),
    ).toEqual(["blank", "middle"]);
    expect(
      filterClientRows(rows, columns, [
        { columnId: "COL_ID_SCORE", type: "equals", filter: 2 },
      ]).map((row) => row.id),
    ).toEqual(["middle"]);
    expect(
      filterClientRows(rows, columns, [{ columnId: "COL_ID_SCORE", type: "in", filter: [2] }]).map(
        (row) => row.id,
      ),
    ).toEqual(["middle"]);
    expect(
      filterClientRows(rows, columns, [
        { columnId: "COL_ID_SCORE", type: "notEqual", filter: 2 },
      ]).map((row) => row.id),
    ).toEqual(["blank", "upper"]);
    expect(
      filterClientRows(rows, columns, [
        { columnId: "COL_ID_NAME", type: "notContains", filter: 2 },
      ]).map((row) => row.id),
    ).toEqual(["blank", "middle", "upper"]);
  });

  it("drops empty text search operands at the admission boundary", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const rows = [
      { id: "blank", name: null },
      { id: "empty", name: "" },
      { id: "value", name: "Ada" },
    ] as const;

    for (const type of ["contains", "startsWith", "endsWith"] as const) {
      const filters = sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_NAME", type, filter: "" }],
        columns,
      );
      expect(filters).toEqual([]);
      expect(filterClientRows(rows, columns, filters).map((row) => row.id)).toEqual([
        "blank",
        "empty",
        "value",
      ]);
    }
    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_NAME", type: "notContains", filter: "" }],
        columns,
      ),
    ).toEqual([]);
  });

  it("excludes nullish Number and BigInt values from every ordered filter", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
      {
        columnId: "COL_ID_COUNT",
        field: "count",
        headerName: "Count",
        valueType: "bigint",
      },
    ]);
    const rows = [
      { id: "null", score: null, count: null },
      { id: "low", score: 4, count: 4n },
      { id: "middle", score: 5, count: 5n },
      { id: "high", score: 6, count: 6n },
    ] as const;
    const cases = [
      ["greaterThan", ["high"]],
      ["greaterThanOrEqual", ["middle", "high"]],
      ["lessThan", ["low"]],
      ["lessThanOrEqual", ["low", "middle"]],
    ] as const;

    for (const [type, expected] of cases) {
      expect(
        filterClientRows(rows, columns, [{ columnId: "COL_ID_SCORE", type, filter: 5 }]).map(
          (row) => row.id,
        ),
      ).toEqual(expected);
      expect(
        filterClientRows(rows, columns, [{ columnId: "COL_ID_COUNT", type, filter: 5n }]).map(
          (row) => row.id,
        ),
      ).toEqual(expected);
    }
    expect(
      filterClientRows(rows, columns, [
        { columnId: "COL_ID_SCORE", type: "inRange", filter: 4, filterTo: 6 },
      ]).map((row) => row.id),
    ).toEqual(["low", "middle"]);
    expect(
      filterClientRows(rows, columns, [
        { columnId: "COL_ID_COUNT", type: "inRange", filter: 4n, filterTo: 6n },
      ]).map((row) => row.id),
    ).toEqual(["low", "middle"]);
  });

  it("does not apply built-in numeric membership keys to custom equality semantics", () => {
    const valueType = {
      codecId: "test/object-is-number",
      codecVersion: 1,
      filterFamily: "numeric",
      editorFamily: "number",
      cellAlign: "end",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input: unknown) =>
        typeof input === "number"
          ? ({ _tag: "Success" as const, value: input } as const)
          : ({ _tag: "Failure" as const, message: "Expected number." } as const),
      equivalent: (left: number, right: number) => Object.is(left, right),
      compare: (left: number, right: number) => (left < right ? -1 : left > right ? 1 : 0),
      formatCanonicalText: (value: number) => String(value),
      parseCanonicalText: (text: string) => ({
        _tag: "Success" as const,
        value: Number(text),
      }),
      formatDisplay: (value: number) => String(value),
      encodePersisted: (value: number) => value,
      decodePersisted: (input: unknown) =>
        typeof input === "number"
          ? ({ _tag: "Success" as const, value: input } as const)
          : ({ _tag: "Failure" as const, message: "Expected number." } as const),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType,
      } as never,
    ]);
    const filters = sanitizeClientInitialFilters(
      [{ columnId: "COL_ID_VALUE", type: "in", filter: [-0] }],
      columns,
    );

    expect(
      filterClientRows(
        [
          { id: "negative-zero", value: -0 },
          { id: "positive-zero", value: 0 },
        ],
        columns,
        filters,
      ).map((row) => row.id),
    ).toEqual(["negative-zero"]);
  });

  it("admits symbol operands for custom value domains", () => {
    const value = Symbol("value");
    const valueType = {
      codecId: "test/symbol",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 160,
      decodeRuntime: (input: unknown) =>
        typeof input === "symbol"
          ? ({ _tag: "Success" as const, value: input } as const)
          : ({ _tag: "Failure" as const, message: "Expected symbol." } as const),
      equivalent: (left: symbol, right: symbol) => Object.is(left, right),
      compare: () => 0,
      formatCanonicalText: (input: symbol) => input.description ?? "",
      parseCanonicalText: (text: string) => ({
        _tag: "Failure" as const,
        message: `Cannot parse symbol: ${text}`,
      }),
      formatDisplay: (input: symbol) => input.description ?? "",
      encodePersisted: (input: symbol) => input.description ?? "",
      decodePersisted: () => ({ _tag: "Failure" as const, message: "Symbols are not persisted." }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType,
      } as never,
    ]);
    const filters = sanitizeClientInitialFilters(
      [{ columnId: "COL_ID_VALUE", type: "equals", filter: value }],
      columns,
    );

    expect(filters).toHaveLength(1);
    expect(filterClientRows([{ value }, { value: Symbol("other") }], columns, filters)).toEqual([
      { value },
    ]);
  });

  it("drops empty ranges and text searches while retaining invalid-free collections", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
      {
        columnId: "COL_ID_COUNT",
        field: "count",
        headerName: "Count",
        valueType: "bigint",
      },
    ]);
    const sparseCandidates = Array<string>(2);
    sparseCandidates[1] = "Ada";

    const emptyRanges = [
      { columnId: "COL_ID_SCORE", type: "inRange", filter: 5, filterTo: 5 },
      { columnId: "COL_ID_SCORE", type: "inRange", filter: 6, filterTo: 5 },
      { columnId: "COL_ID_COUNT", type: "inRange", filter: 5n, filterTo: 5n },
      { columnId: "COL_ID_COUNT", type: "inRange", filter: 6n, filterTo: 5n },
    ] as const;
    const emptyText = { columnId: "COL_ID_NAME", type: "contains", filter: "" } as const;
    const normalizedEmptyText = {
      columnId: "COL_ID_NAME",
      type: "startsWith",
      filter: "\u0301",
    } as const;
    const emptyIn = { columnId: "COL_ID_NAME", type: "in", filter: [] } as const;
    const emptyTextIn = { columnId: "COL_ID_NAME", type: "in", filter: [""] } as const;
    const normalizedEmptyTextIn = {
      columnId: "COL_ID_NAME",
      type: "in",
      filter: ["\u0301"],
    } as const;
    expect(
      sanitizeClientInitialFilters(
        [
          ...emptyRanges,
          emptyText,
          normalizedEmptyText,
          emptyIn,
          {
            columnId: "COL_ID_NAME",
            type: "equals",
            filter: "Ada",
            caseSensitive: "yes",
          },
          {
            columnId: "COL_ID_NAME",
            type: "in",
            filter: ["Ada"],
            accentSensitive: 1,
          },
          { columnId: "COL_ID_NAME", type: "in", filter: sparseCandidates },
        ],
        columns,
      ),
    ).toEqual([]);
    const rows = [{ id: "middle", name: "Ada", score: 5, count: 5n }] as const;
    for (const range of emptyRanges) {
      expect(filterClientRows(rows, columns, [range])).toEqual(rows);
    }
    expect(filterClientRows(rows, columns, [normalizedEmptyText])).toEqual(rows);
    expect(filterClientRows(rows, columns, [emptyIn])).toEqual(rows);
    expect(sanitizeClientInitialFilters([emptyTextIn, normalizedEmptyTextIn], columns)).toEqual([]);
    expect(filterClientRows(rows, columns, [emptyTextIn, normalizedEmptyTextIn])).toEqual(rows);

    expect(
      sanitizeClientInitialFilters(
        [
          {
            columnId: "COL_ID_NAME",
            type: "contains",
            filter: "Ada",
            caseSensitive: false,
            accentSensitive: true,
          },
          { columnId: "COL_ID_SCORE", type: "inRange", filter: 4, filterTo: 6 },
          { columnId: "COL_ID_COUNT", type: "inRange", filter: 4n, filterTo: 6n },
        ],
        columns,
      ),
    ).toHaveLength(3);
  });

  it("applies text-family operators to custom canonical text domains", () => {
    type Email = Readonly<{ readonly address: string }>;
    const emailValueType = {
      codecId: "test/email",
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 180,
      decodeRuntime: (input: unknown) =>
        typeof input === "object" &&
        input !== null &&
        typeof Reflect.get(input, "address") === "string"
          ? ({ _tag: "Success", value: input as Email } as const)
          : ({ _tag: "Failure", message: "Expected email." } as const),
      equivalent: (left: Email, right: Email) => left.address === right.address,
      compare: (left: Email, right: Email) =>
        left.address === right.address ? 0 : left.address < right.address ? -1 : 1,
      formatCanonicalText: (value: Email) => value.address,
      parseCanonicalText: (text: string) =>
        ({ _tag: "Success", value: Object.freeze({ address: text }) }) as const,
      formatDisplay: (value: Email) => value.address,
      encodePersisted: (value: Email) => value.address,
      decodePersisted: (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success", value: Object.freeze({ address: input }) } as const)
          : ({ _tag: "Failure", message: "Expected persisted email." } as const),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_EMAIL",
        field: "email",
        headerName: "Email",
        valueType: emailValueType,
      },
    ]);
    const rows = [
      { id: "ada", email: Object.freeze({ address: "Ada@Example.com" }) },
      { id: "grace", email: Object.freeze({ address: "grace@example.com" }) },
      { id: "jose", email: Object.freeze({ address: "Jos\u00e9@Example.com" }) },
    ] as const;
    const filters = sanitizeClientInitialFilters(
      [{ columnId: "COL_ID_EMAIL", type: "contains", filter: "ADA@" }],
      columns,
    );

    expect(filters).toEqual([{ columnId: "COL_ID_EMAIL", type: "contains", filter: "ADA@" }]);
    expect(filterClientRows(rows, columns, filters).map((row) => row.id)).toEqual(["ada"]);
    const caseInsensitiveEquals = sanitizeClientInitialFilters(
      [
        {
          columnId: "COL_ID_EMAIL",
          type: "equals",
          filter: Object.freeze({ address: "ADA@EXAMPLE.COM" }),
          caseSensitive: false,
          accentSensitive: true,
        },
      ],
      columns,
    );
    expect(filterClientRows(rows, columns, caseInsensitiveEquals).map((row) => row.id)).toEqual([
      "ada",
    ]);
    const caseSensitiveEquals = sanitizeClientInitialFilters(
      [
        {
          columnId: "COL_ID_EMAIL",
          type: "equals",
          filter: Object.freeze({ address: "ADA@EXAMPLE.COM" }),
          caseSensitive: true,
        },
      ],
      columns,
    );
    expect(filterClientRows(rows, columns, caseSensitiveEquals)).toEqual([]);
    const accentInsensitiveIn = sanitizeClientInitialFilters(
      [
        {
          columnId: "COL_ID_EMAIL",
          type: "in",
          filter: [Object.freeze({ address: "Ad\u00e1@Example.com" })],
          caseSensitive: true,
          accentSensitive: false,
        },
      ],
      columns,
    );
    expect(filterClientRows(rows, columns, accentInsensitiveIn).map((row) => row.id)).toEqual([
      "ada",
    ]);
    const combiningMarkEquals = sanitizeClientInitialFilters(
      [
        {
          columnId: "COL_ID_EMAIL",
          type: "equals",
          filter: Object.freeze({ address: "Jose\u0301@Example.com" }),
          caseSensitive: true,
          accentSensitive: true,
        },
      ],
      columns,
    );
    expect(filterClientRows(rows, columns, combiningMarkEquals).map((row) => row.id)).toEqual([
      "jose",
    ]);
  });

  it("uses the decomposed accent-sensitive text form shared with the Server", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const rows = [{ name: "é" }, { name: "e" }] as const;
    const filters = sanitizeClientInitialFilters(
      [
        {
          columnId: "COL_ID_NAME",
          type: "contains",
          filter: "e",
          accentSensitive: true,
        },
      ],
      columns,
    );

    expect(filterClientRows(rows, columns, filters)).toEqual(rows);
  });

  it("sanitizes compound filters and tracks nested column references", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const filter = {
      type: "NOT",
      condition: { columnId: "COL_ID_NAME", type: "blank" },
    };
    const [sanitized] = sanitizeClientInitialFilters([filter], columns);

    expect(sanitized).toEqual(filter);
    expect(filterReferencesColumn(sanitized, "COL_ID_NAME")).toBe(true);
    expect(filterReferencesColumn(sanitized, "COL_ID_MISSING")).toBe(false);
  });

  it("drops empty compounds and foreign structural keys from leaf filters", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);

    expect(sanitizeClientInitialFilters([{ type: "OR", conditions: [] }], columns)).toEqual([]);
    const [sanitized] = sanitizeClientInitialFilters(
      [
        {
          columnId: "COL_ID_NAME",
          type: "blank",
          condition: { columnId: "COL_ID_SCORE", type: "blank" },
          conditions: [{ columnId: "COL_ID_SCORE", type: "blank" }],
        },
      ],
      columns,
    );
    expect(sanitized).toEqual({ columnId: "COL_ID_NAME", type: "blank" });
    expect(filterReferencesColumn(sanitized, "COL_ID_NAME")).toBe(true);
    expect(filterReferencesColumn(sanitized, "COL_ID_SCORE")).toBe(false);
  });

  it("drops sparse compound condition arrays", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);

    expect(
      sanitizeClientInitialFilters(
        [
          { type: "AND", conditions: Array(1) },
          { type: "OR", conditions: Array(2) },
        ],
        columns,
      ),
    ).toEqual([]);
  });

  it("drops cyclic and over-depth compound filters without overflowing the stack", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const cyclic: { type: "NOT"; condition?: unknown } = { type: "NOT" };
    cyclic.condition = cyclic;
    let deep: unknown = { columnId: "COL_ID_NAME", type: "equals", filter: "Ada" };
    for (let depth = 0; depth < 1_000; depth += 1) deep = { type: "NOT", condition: deep };

    expect(() => sanitizeClientInitialFilters([cyclic, deep], columns)).not.toThrow();
    expect(sanitizeClientInitialFilters([cyclic, deep], columns)).toEqual([]);
    expect(() =>
      sanitizeClientInitialFilters([deep], columns, { rejectOverBudget: true }),
    ).toThrowError(
      "BrunoTable initialFilters may contain at most 16384 nodes, 16384 operands, 1048576 UTF-16 text units, 16384 semantic comparisons, and nesting depth 64.",
    );
  });

  it("accepts an acyclic compound filter that shares one immutable leaf", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const leaf = Object.freeze({ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" });
    const shared = Object.freeze({
      type: "AND",
      conditions: Object.freeze([leaf, Object.freeze({ type: "NOT", condition: leaf })]),
    });

    const sanitized = sanitizeClientInitialFilters([shared], columns);

    expect(sanitized).toEqual([shared]);
    expect(filterClientRows([{ name: "Ada" }, { name: "Grace" }], columns, sanitized)).toEqual([]);
  });

  it("sanitizes and evaluates a deep shared filter DAG once per distinct node", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    let sourceReads = 0;
    const counted = <T extends Readonly<Record<string, unknown>>>(record: T): T =>
      new Proxy(Object.freeze(record), {
        get: (target, property, receiver) => {
          sourceReads += 1;
          if (sourceReads > 500) throw new Error("Shared filter DAG expanded exponentially.");
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    let shared: Readonly<Record<string, unknown>> = counted({
      columnId: "COL_ID_NAME",
      filter: "Ada",
      type: "equals",
    });
    const depth = 32;
    for (let index = 0; index < depth; index += 1) {
      shared = counted({ conditions: Object.freeze([shared, shared]), type: "AND" });
    }

    const sanitized = sanitizeClientInitialFilters([shared], columns);

    expect(sanitized).toHaveLength(1);
    expect(sourceReads).toBeLessThan(500);
    let sanitizedNode = sanitized[0] as Readonly<Record<string, unknown>>;
    for (let index = 0; index < depth; index += 1) {
      const conditions = sanitizedNode["conditions"] as readonly Readonly<
        Record<string, unknown>
      >[];
      expect(conditions[0]).toBe(conditions[1]);
      sanitizedNode = conditions[0]!;
    }

    let valueReads = 0;
    const predicate = createClientFilterPredicate(columns, sanitized, () => {
      valueReads += 1;
      if (valueReads > 100) throw new Error("Shared filter evaluation expanded exponentially.");
      return "Ada";
    });
    expect(predicate?.({})).toBe(true);
    expect(valueReads).toBe(1);
  });

  it("reapplies the depth bound when an accepted subtree alias moves deeper", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    let boundary: Readonly<Record<string, unknown>> = Object.freeze({
      columnId: "COL_ID_NAME",
      filter: "Ada",
      type: "equals",
    });
    for (let depth = 0; depth < 64; depth += 1) {
      boundary = Object.freeze({ condition: boundary, type: "NOT" });
    }

    const collection = compileClientFilterCollection(
      [boundary, { condition: boundary, type: "NOT" }],
      columns,
    );

    expect(collection.expressions).toHaveLength(1);
    expect(collection.filters).toEqual([expect.objectContaining({ type: "NOT" })]);
    expect(() =>
      compileClientFilterCollection([boundary, { condition: boundary, type: "NOT" }], columns, {
        rejectOverBudget: true,
      }),
    ).toThrow(/nesting depth 64/u);
  });

  it("captures a nested source array once when its owner appears at different depths", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const leaf = Object.freeze({ columnId: "COL_ID_NAME", filter: "Ada", type: "equals" });
    let indexedReads = 0;
    let lengthReads = 0;
    const sourceConditions = new Proxy(Object.freeze([leaf]), {
      get: (target, property, receiver) => {
        if (property === "length") {
          lengthReads += 1;
          if (lengthReads > 1) throw new Error("Nested source array length was read twice.");
        }
        if (property === "0") {
          indexedReads += 1;
          if (indexedReads > 1) throw new Error("Nested source array was read twice.");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const shared = Object.freeze({ conditions: sourceConditions, type: "AND" });
    const root = Object.freeze({
      conditions: Object.freeze([shared, Object.freeze({ condition: shared, type: "NOT" })]),
      type: "AND",
    });

    const sanitized = sanitizeClientInitialFilters([root], columns);

    expect(sanitized).toHaveLength(1);
    expect(indexedReads).toBe(1);
    expect(lengthReads).toBe(1);
    expect(filterClientRows([{ name: "Ada" }, { name: "Grace" }], columns, sanitized)).toEqual([]);
  });

  it("captures repeated top-level filter aliases once across public entries", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const reads = { columnId: 0, filter: 0, type: 0 };
    const source = Object.defineProperties(
      {},
      {
        columnId: {
          get: () => {
            reads.columnId += 1;
            return "COL_ID_NAME";
          },
        },
        filter: {
          get: () => {
            reads.filter += 1;
            return "Ada";
          },
        },
        type: {
          get: () => {
            reads.type += 1;
            return "equals";
          },
        },
      },
    );

    const sanitized = sanitizeClientInitialFilters([source, source], columns);

    expect(sanitized).toEqual([
      {
        type: "AND",
        conditions: [
          { columnId: "COL_ID_NAME", filter: "Ada", type: "equals" },
          { columnId: "COL_ID_NAME", filter: "Ada", type: "equals" },
        ],
      },
    ]);
    expect(reads).toEqual({ columnId: 1, filter: 1, type: 1 });
    expect(compileClientFilterCollection([source, source], columns).hasSharedNodes).toBe(true);
    expect(filterClientRows([{ name: "Ada" }, { name: "Grace" }], columns, sanitized)).toEqual([
      { name: "Ada" },
    ]);
  });

  it("captures one physical array once when aliases cross conditions and operand roles", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const leaf = Object.freeze({ columnId: "COL_ID_NAME", filter: "Ada", type: "equals" });
    let indexedReads = 0;
    let lengthReads = 0;
    const sharedArray = new Proxy(Object.freeze([leaf]), {
      get: (target, property, receiver) => {
        if (property === "length") {
          lengthReads += 1;
          if (lengthReads > 1) throw new Error("Cross-role array length was read twice.");
        }
        if (property === "0") {
          indexedReads += 1;
          if (indexedReads > 1) throw new Error("Cross-role array entry was read twice.");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const sanitized = sanitizeClientInitialFilters(
      [
        { conditions: sharedArray, type: "AND" },
        { columnId: "COL_ID_NAME", filter: sharedArray, type: "in" },
      ],
      columns,
    );

    expect(sanitized).toHaveLength(1);
    expect(lengthReads).toBe(1);
    expect(indexedReads).toBe(1);
  });

  it("drops filters when an internal Value Type decoder throws", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const throwingColumns = columns.map((column) => ({
      ...column,
      semantics: Object.freeze({
        ...column.semantics,
        decodeRuntime: () => {
          throw new Error("Decoder implementation failed.");
        },
      }),
    }));

    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_NAME", filter: "Ada", type: "equals" }],
        throwingColumns,
      ),
    ).toEqual([]);
  });

  it("drops a filter whose properties cannot be read", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const unreadable = new Proxy<Record<string, unknown>>(
      {},
      {
        get: (target, property, receiver) => {
          if (property === "type") throw new Error("Unreadable filter type.");
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );
    const valid = Object.freeze({ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" });

    const sanitized = sanitizeClientInitialFilters([unreadable, valid], columns);

    expect(sanitized).toEqual([valid]);
  });

  it("captures each relevant filter property once before validation", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const reads = {
      accentSensitive: 0,
      caseSensitive: 0,
      columnId: 0,
      filter: 0,
      type: 0,
    };
    const stateful = Object.defineProperties<Record<string, unknown>>(
      {},
      {
        accentSensitive: {
          enumerable: true,
          get: () => {
            reads.accentSensitive += 1;
            return reads.accentSensitive === 1 ? false : true;
          },
        },
        caseSensitive: {
          enumerable: true,
          get: () => {
            reads.caseSensitive += 1;
            return reads.caseSensitive === 1 ? false : true;
          },
        },
        columnId: {
          enumerable: true,
          get: () => {
            reads.columnId += 1;
            return reads.columnId === 1 ? "COL_ID_NAME" : "COL_ID_MISSING";
          },
        },
        filter: {
          enumerable: true,
          get: () => {
            reads.filter += 1;
            return reads.filter === 1 ? "Ada" : "Grace";
          },
        },
        type: {
          enumerable: true,
          get: () => {
            reads.type += 1;
            return reads.type === 1 ? "equals" : "blank";
          },
        },
      },
    );

    const sanitized = sanitizeClientInitialFilters([stateful], columns);

    expect(reads).toEqual({
      accentSensitive: 1,
      caseSensitive: 1,
      columnId: 1,
      filter: 1,
      type: 1,
    });
    expect(sanitized).toEqual([
      {
        accentSensitive: false,
        caseSensitive: false,
        columnId: "COL_ID_NAME",
        filter: "Ada",
        type: "equals",
      },
    ]);
    expect(filterClientRows([{ name: "Ada" }, { name: "Grace" }], columns, sanitized)).toEqual([
      { name: "Ada" },
    ]);
  });

  it("owns admitted filter records and arrays before later evaluation", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    let denyFurtherReads = false;
    const operands = new Proxy(Object.freeze(["Ada"]), {
      get: (target, property, receiver) => {
        if (denyFurtherReads && property === "0") throw new Error("Operand read escaped.");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const leaf = Object.freeze(
      Object.defineProperties<Record<string, unknown>>(
        {},
        {
          columnId: {
            enumerable: true,
            get: () => {
              if (denyFurtherReads) throw new Error("Column read escaped.");
              return "COL_ID_NAME";
            },
          },
          filter: {
            enumerable: true,
            get: () => {
              if (denyFurtherReads) throw new Error("Filter read escaped.");
              return operands;
            },
          },
          type: {
            enumerable: true,
            get: () => {
              if (denyFurtherReads) throw new Error("Type read escaped.");
              return "in";
            },
          },
        },
      ),
    );
    const conditions = new Proxy(Object.freeze([leaf]), {
      get: (target, property, receiver) => {
        if (denyFurtherReads && property === "0") throw new Error("Condition read escaped.");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const compound = Object.freeze({ conditions, type: "AND" });

    const sanitized = sanitizeClientInitialFilters([compound], columns);
    denyFurtherReads = true;

    expect(Object.is(sanitized[0], compound)).toBe(false);
    expect(() =>
      filterClientRows([{ name: "Ada" }, { name: "Grace" }], columns, sanitized),
    ).not.toThrow();
    expect(filterClientRows([{ name: "Ada" }, { name: "Grace" }], columns, sanitized)).toEqual([
      { name: "Ada" },
    ]);
  });

  it("bounds filter-array reads and preserves valid siblings around unreadable entries", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const root = Array<unknown>(1_000_000);
    root[0] = { columnId: "COL_ID_NAME", type: "startsWith", filter: "A" };
    let accessorReads = 0;
    Object.defineProperty(root, "1", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReads += 1;
        throw new Error("Unreadable root entry.");
      },
    });
    root[2] = { columnId: "COL_ID_NAME", type: "notBlank" };
    let indexedProbes = 0;
    let ownKeyReads = 0;
    const countIndexedProbe = (property: PropertyKey) => {
      if (typeof property !== "string" || !/^\d+$/u.test(property)) return;
      indexedProbes += 1;
      if (indexedProbes > 16_385) throw new Error("Unbounded indexed root traversal.");
    };
    const hostileRoot = new Proxy(root, {
      get: (target, property, receiver) => {
        countIndexedProbe(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
      getOwnPropertyDescriptor: (target, property) => {
        countIndexedProbe(property);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      has: (target, property) => {
        countIndexedProbe(property);
        return Reflect.has(target, property);
      },
      ownKeys: () => {
        ownKeyReads += 1;
        throw new Error("Root array own keys must not be materialized.");
      },
    });

    const sanitized = sanitizeClientInitialFilters(hostileRoot, columns);

    expect(sanitized).toEqual([
      {
        type: "AND",
        conditions: [
          { columnId: "COL_ID_NAME", type: "startsWith", filter: "A" },
          { columnId: "COL_ID_NAME", type: "notBlank" },
        ],
      },
    ]);
    expect(indexedProbes).toBeLessThanOrEqual(16_385);
    expect(ownKeyReads).toBe(0);
    expect(accessorReads).toBe(0);
  });

  it("does not materialize non-JSON root-array metadata", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const root: unknown[] = [{ columnId: "COL_ID_NAME", type: "startsWith", filter: "A" }];
    for (let index = 0; index <= 16_384; index += 1) {
      Object.defineProperty(root, `metadata-${String(index)}`, { value: index });
    }
    for (let index = 0; index <= 4_096; index += 1) {
      Object.defineProperty(root, Symbol(`metadata-${String(index)}`), { value: index });
    }
    const ownKeys = vi.spyOn(Reflect, "ownKeys");
    try {
      expect(sanitizeClientInitialFilters(root, columns)).toEqual([
        { columnId: "COL_ID_NAME", type: "startsWith", filter: "A" },
      ]);
      expect(ownKeys.mock.calls.some(([target]) => target === root)).toBe(false);
    } finally {
      ownKeys.mockRestore();
    }
  });

  it("caps hostile filter-array materialization before canonicalization", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_A",
        field: "name",
        headerName: "A",
        valueType: "text",
      },
    ]);
    const hostileRoot = Array.from({ length: 16_385 }, () => ({
      columnId: "COL_ID_A",
      type: "blank",
    }));

    expect(sanitizeClientInitialFilters(hostileRoot, columns)).toEqual([]);
    expect(() =>
      sanitizeClientInitialFilters(hostileRoot, columns, { rejectOverBudget: true }),
    ).toThrow(/contains more than 16384 entries/u);
    expect(sanitizeClientInitialFilters(hostileRoot.slice(0, 16_384), columns)).toEqual([]);
    expect(sanitizeClientInitialFilters(hostileRoot.slice(0, 1_025), columns)).toHaveLength(1);

    const metadataRoot: unknown[] = [];
    for (let index = 0; index < 16_385; index += 1) {
      Object.defineProperty(metadataRoot, `metadata-${index}`, {
        configurable: true,
        value: index,
      });
    }
    expect(sanitizeClientInitialFilters(metadataRoot, columns)).toEqual([]);
    expect(() =>
      sanitizeClientInitialFilters(metadataRoot, columns, { rejectOverBudget: true }),
    ).not.toThrow();

    const inheritedMetadata = Object.fromEntries(
      Array.from({ length: 16_385 }, (_unused, index) => [`metadata-${String(index)}`, index]),
    );
    const inheritedRoot: unknown[] = [];
    Object.setPrototypeOf(inheritedRoot, inheritedMetadata);
    expect(sanitizeClientInitialFilters(inheritedRoot, columns)).toEqual([]);
    expect(() =>
      sanitizeClientInitialFilters(inheritedRoot, columns, { rejectOverBudget: true }),
    ).not.toThrow();
  });

  it("canonicalizes one committed expression per Column Identity", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    const firstName = Object.freeze({
      columnId: "COL_ID_NAME",
      filter: "Ada",
      type: "equals" as const,
    });
    const secondName = Object.freeze({
      columnId: "COL_ID_NAME",
      filter: "Grace",
      type: "notEqual" as const,
    });

    const collection = compileClientFilterCollection(
      [firstName, { columnId: "COL_ID_SCORE", filter: 2, type: "greaterThan" }, secondName],
      columns,
    );

    expect(collection.filters).toEqual([
      { type: "AND", conditions: [firstName, secondName] },
      { columnId: "COL_ID_SCORE", filter: 2, type: "greaterThan" },
    ]);
    expect(collection.columnIds).toEqual(new Set(["COL_ID_NAME", "COL_ID_SCORE"]));
    expect(collection.filtersByColumn.get("COL_ID_NAME")).toBe(collection.filters[0]);
    expect(collection.filtersByColumn.get("COL_ID_SCORE")).toBe(collection.filters[1]);
    expect(collection.complexity.inputEntries).toBe(2);
    expect(collection.complexity.nodes).toBe(4);
  });

  it("drops the complete collection when canonicalization exceeds the aggregate bound", () => {
    const columns = compileColumns([
      { columnId: "COL_ID_A", field: "name", headerName: "A", valueType: "text" },
      { columnId: "COL_ID_B", field: "name", headerName: "B", valueType: "text" },
    ]);
    const filters = [
      ...Array.from({ length: 16_383 }, () => ({
        columnId: "COL_ID_A",
        type: "blank" as const,
      })),
      { columnId: "COL_ID_B", type: "blank" as const },
    ];

    expect(compileClientFilterCollection(filters, columns).filters).toEqual([]);
    expect(() =>
      compileClientFilterCollection(filters, columns, { rejectOverBudget: true }),
    ).toThrow(/16384 nodes/u);
  });

  it("admits one aggregate node and operand ledger for the complete filter collection", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    const leaf = Object.freeze({ columnId: "COL_ID_NAME", filter: "Ada", type: "equals" });
    const largeRoots = [
      {
        conditions: Array.from({ length: 8_190 }, () => leaf),
        type: "AND" as const,
      },
      {
        conditions: Array.from({ length: 8_190 }, () => leaf),
        type: "AND" as const,
      },
    ];
    const nodeCollection = compileClientFilterCollection(largeRoots, columns);
    expect(nodeCollection.expressions).toHaveLength(1);
    expect(nodeCollection.complexity.nodes).toBe(16_383);
    expect(nodeCollection.expressionsByColumn.get("COL_ID_NAME")?.filter).toBe(
      nodeCollection.filters[0],
    );
    expect(() =>
      compileClientFilterCollection([...largeRoots, largeRoots[0]!], columns, {
        rejectOverBudget: true,
      }),
    ).toThrow(/16384 nodes/u);

    const operandRoots = Array.from({ length: 5 }, () => ({
      columnId: "COL_ID_SCORE",
      filter: Array.from({ length: 4_096 }, (_, index) => index),
      type: "in" as const,
    }));
    const operandCollection = compileClientFilterCollection(operandRoots, columns);
    expect(operandCollection.complexity.operands).toBe(16_384);
    expect(operandCollection.expressions).toHaveLength(1);
  });

  it("prunes compiled operand metadata when a column root is replaced or cleared", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const collection = compileClientFilterCollection(
      [
        { columnId: "COL_ID_NAME", filter: "Ada", type: "equals" },
        { columnId: "COL_ID_NAME", filter: "Grace", type: "equals" },
      ],
      columns,
    );
    expect(collection.compiledOperands.size).toBe(2);

    const replacement = replaceClientFilterColumn(collection, "COL_ID_NAME", {
      columnId: "COL_ID_NAME",
      filter: "Lin",
      type: "equals",
    });
    expect(replacement?.compiledOperands.size).toBe(1);
    expect(removeClientFilterColumn(replacement!, "COL_ID_NAME").compiledOperands.size).toBe(0);
  });

  it("derives shared-node evaluation evidence from only the retained column expression", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const sharedLeaf = Object.freeze({
      columnId: "COL_ID_NAME",
      filter: "Ada",
      type: "equals" as const,
    });
    const aliasedRoot = Object.freeze({
      conditions: Object.freeze([sharedLeaf, sharedLeaf]),
      type: "AND" as const,
    });
    const ordinaryRoot = Object.freeze({
      columnId: "COL_ID_NAME",
      filter: "Grace",
      type: "notEqual" as const,
    });
    const collection = compileClientFilterCollection([aliasedRoot, ordinaryRoot], columns);
    expect(collection.hasSharedNodes).toBe(true);

    const replaced = replaceClientFilterColumn(collection, "COL_ID_NAME", {
      columnId: "COL_ID_NAME",
      filter: "Lin",
      type: "equals",
    });
    expect(replaced?.hasSharedNodes).toBe(false);
    expect(removeClientFilterColumn(collection, "COL_ID_NAME").hasSharedNodes).toBe(false);
  });

  it("evaluates a nested alias shared by distinct public entries once per row", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const sharedLeaf = Object.freeze({
      columnId: "COL_ID_NAME",
      filter: "Ada",
      type: "equals" as const,
    });
    const filters = [
      { type: "AND" as const, conditions: [sharedLeaf] },
      { type: "NOT" as const, condition: sharedLeaf },
    ];
    const collection = compileClientFilterCollection(filters, columns);
    const readValue = vi.fn(() => "Ada");
    const predicate = createClientFilterPredicate(
      columns,
      collection.filters,
      readValue,
      collection,
    );

    expect(collection.hasSharedNodes).toBe(true);
    expect(predicate?.({})).toBe(false);
    expect(readValue).toHaveBeenCalledOnce();
  });

  it("replaces one complete column expression without re-decoding other columns", () => {
    const decodeRuntime = vi.fn((input: unknown) => ({ _tag: "Success" as const, value: input }));
    const valueType = {
      codecId: "test/root-replacement",
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 160,
      decodeRuntime,
      equivalent: (left: unknown, right: unknown) => Object.is(left, right),
      compare: () => 0,
      formatCanonicalText: (value: unknown) => String(value),
      parseCanonicalText: (text: string) => ({ _tag: "Success" as const, value: text }),
      formatDisplay: (value: unknown) => String(value),
      encodePersisted: (value: unknown) => String(value),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType,
      },
    ] as never);
    const roots = Array.from({ length: 256 }, (_, index) => ({
      columnId: "COL_ID_NAME",
      type: "equals" as const,
      filter: `Name-${String(index)}`,
    }));
    const collection = compileClientFilterCollection(roots, columns);
    const decodeCallsAfterAdmission = decodeRuntime.mock.calls.length;
    const replacement = replaceClientFilterColumn(collection, "COL_ID_NAME", {
      columnId: "COL_ID_NAME",
      type: "equals",
      filter: "Updated",
    });

    expect(replacement?.expressions).toHaveLength(1);
    expect(decodeRuntime).toHaveBeenCalledTimes(decodeCallsAfterAdmission + 1);
  });

  it("bounds order-array reads and preserves valid siblings around unreadable entries", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const root = Array<unknown>(1_000_000);
    let accessorReads = 0;
    Object.defineProperty(root, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReads += 1;
        throw new Error("Unreadable root entry.");
      },
    });
    root[1] = { columnId: "COL_ID_NAME", direction: "asc" };
    let indexedProbes = 0;
    let ownKeyReads = 0;
    const countIndexedProbe = (property: PropertyKey) => {
      if (typeof property !== "string" || !/^\d+$/u.test(property)) return;
      indexedProbes += 1;
      if (indexedProbes > 16_385) throw new Error("Unbounded indexed root traversal.");
    };
    const hostileRoot = new Proxy(root, {
      get: (target, property, receiver) => {
        countIndexedProbe(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
      getOwnPropertyDescriptor: (target, property) => {
        countIndexedProbe(property);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      has: (target, property) => {
        countIndexedProbe(property);
        return Reflect.has(target, property);
      },
      ownKeys: () => {
        ownKeyReads += 1;
        throw new Error("Order array own keys must not be materialized.");
      },
    });

    expect(sanitizeClientOrderBy(hostileRoot as never, columns)).toEqual([
      { columnId: "COL_ID_NAME", direction: "asc" },
    ]);
    expect(indexedProbes).toBeLessThanOrEqual(16_385);
    expect(ownKeyReads).toBe(0);
    expect(accessorReads).toBe(0);

    const unreadableLength = new Proxy([], {
      get: (target, property, receiver) => {
        if (property === "length") throw new Error("Unreadable root length.");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(() => sanitizeClientInitialOrderBy(unreadableLength as never, columns)).toThrow(
      /no valid sortable column/u,
    );
  });

  it("preserves public query collections larger than the hostile-input recursion depth", () => {
    const columnCount = 1_025;
    const columns = compileColumns(
      Array.from({ length: columnCount }, (_, index) => ({
        columnId: `COL_ID_FIELD_${index}`,
        field: `field_${index}`,
        headerName: `Field ${index}`,
        valueType: "number" as const,
      })),
    );
    const orderBy = Array.from({ length: columnCount }, (_, index) => ({
      columnId: `COL_ID_FIELD_${index}`,
      direction: "asc" as const,
    }));
    const filters = Array.from({ length: columnCount }, (_, index) => ({
      columnId: `COL_ID_FIELD_${index}`,
      filter: index,
      type: "equals",
    }));

    expect(sanitizeClientInitialOrderBy(orderBy, columns)).toHaveLength(columnCount);
    expect(sanitizeClientInitialFilters(filters, columns)).toHaveLength(columnCount);

    const [inFilter] = sanitizeClientInitialFilters(
      [
        {
          columnId: "COL_ID_FIELD_0",
          filter: Array.from({ length: columnCount }, (_, index) => index),
          type: "in",
        },
      ],
      columns,
    );
    expect((inFilter as { readonly filter: readonly unknown[] }).filter).toHaveLength(columnCount);
  });

  it("bounds aggregate in operands before materializing hostile values", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    const atLimit = sanitizeClientInitialFilters(
      [
        {
          columnId: "COL_ID_SCORE",
          filter: Array.from({ length: 16_384 }, (_, index) => index),
          type: "in",
        },
      ],
      columns,
    );
    expect(
      (atLimit[0] as { readonly filter: readonly unknown[] } | undefined)?.filter,
    ).toHaveLength(16_384);

    const ownKeys = vi.fn(Reflect.ownKeys);
    const overBudgetOperand = new Proxy(
      Array.from({ length: 16_385 }, (_, index) => index),
      { ownKeys },
    );
    const filter = {
      columnId: "COL_ID_SCORE",
      filter: overBudgetOperand,
      type: "in",
    };

    expect(sanitizeClientInitialFilters([filter], columns)).toEqual([]);
    expect(ownKeys).not.toHaveBeenCalled();
    expect(() =>
      sanitizeClientInitialFilters([filter], columns, { rejectOverBudget: true }),
    ).toThrowError(
      "BrunoTable initialFilters may contain at most 16384 nodes, 16384 operands, 1048576 UTF-16 text units, 16384 semantic comparisons, and nesting depth 64.",
    );
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("admits text operands beyond the UI draft bound while the aggregate allows them", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const overlong = "x".repeat(1_025);

    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_NAME", filter: overlong, type: "equals" }],
        columns,
      ),
    ).toEqual([{ columnId: "COL_ID_NAME", filter: overlong, type: "equals" }]);
    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_NAME", filter: ["ok", overlong], type: "in" }],
        columns,
      ),
    ).toEqual([{ columnId: "COL_ID_NAME", filter: ["ok", overlong], type: "in" }]);

    const numericColumns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_SCORE", filter: overlong, type: "equals" }],
        numericColumns,
        { rejectOverBudget: true },
      ),
    ).toEqual([]);
  });

  it("charges long custom text through the aggregate ledger before retaining it", () => {
    const decodeRuntime = vi.fn((input: unknown) => ({ _tag: "Success" as const, value: input }));
    const customTextValueType = {
      codecId: "test/bounded-text",
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 160,
      decodeRuntime,
      equivalent: (left: unknown, right: unknown) => Object.is(left, right),
      compare: () => 0,
      formatCanonicalText: (value: unknown) => String(value),
      parseCanonicalText: (text: string) => ({ _tag: "Success" as const, value: text }),
      formatDisplay: (value: unknown) => String(value),
      encodePersisted: (value: unknown) => String(value),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_CUSTOM_TEXT",
        field: "value",
        headerName: "Value",
        valueType: customTextValueType,
      },
    ]);

    const operand = "x".repeat(1_025);
    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_CUSTOM_TEXT", filter: operand, type: "equals" }],
        columns,
      ),
    ).toEqual([{ columnId: "COL_ID_CUSTOM_TEXT", filter: operand, type: "equals" }]);
    expect(decodeRuntime).toHaveBeenCalledOnce();
  });

  it("rejects unbounded active-label formatter output before truncation", () => {
    const valueType = {
      codecId: "test/unbounded-display",
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 160,
      decodeRuntime: (input: unknown) => ({ _tag: "Success" as const, value: input }),
      equivalent: (left: unknown, right: unknown) => Object.is(left, right),
      compare: () => 0,
      formatCanonicalText: (value: unknown) => String(value),
      parseCanonicalText: (text: string) => ({ _tag: "Success" as const, value: text }),
      formatDisplay: () => "d".repeat(BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_TEXT_LENGTH),
      encodePersisted: (value: unknown) => String(value),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_UNBOUNDED_DISPLAY",
        field: "value",
        headerName: "Value",
        valueType,
      },
    ] as never);
    const filter = [{ columnId: "COL_ID_UNBOUNDED_DISPLAY", filter: "Ada", type: "equals" }];

    expect(sanitizeClientInitialFilters(filter, columns)).toEqual([]);
    expect(() => sanitizeClientInitialFilters(filter, columns, { rejectOverBudget: true })).toThrow(
      /1048576 UTF-16 text units/u,
    );
  });

  it("does not let a rejected root consume the retained collection ledger", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_REJECTED",
        field: "rejected",
        headerName: "Rejected",
        valueType: "text",
      },
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ] as never);
    const collection = compileClientFilterCollection(
      [
        {
          type: "AND",
          conditions: [
            { columnId: "COL_ID_REJECTED", type: "blank" },
            { columnId: "COL_ID_NAME", type: "blank" },
          ],
        },
        { columnId: "COL_ID_NAME", filter: "Ada", type: "equals" },
      ],
      columns,
    );

    expect(collection.filters).toEqual([
      { columnId: "COL_ID_NAME", filter: "Ada", type: "equals" },
    ]);
    expect(collection.complexity).toMatchObject({ nodes: 1, operands: 1 });
  });

  it("charges structural text for opaque roots through the aggregate ledger", () => {
    const columnId = `COL_ID_${"A".repeat(BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_TEXT_LENGTH)}`;
    const columns = compileColumns([
      {
        columnId,
        field: "value",
        headerName: "Value",
        valueType: {
          codecId: "test/opaque-structure-text",
          codecVersion: 1,
          filterFamily: "equality",
          editorFamily: "text",
          cellAlign: "start",
          editorLayout: "inline",
          defaultWidth: 160,
          decodeRuntime: (input: unknown) => ({ _tag: "Success" as const, value: input }),
          equivalent: Object.is,
          compare: () => 0,
          formatCanonicalText: (value: unknown) => String(value),
          parseCanonicalText: (text: string) => ({ _tag: "Success" as const, value: text }),
          formatDisplay: (value: unknown) => String(value),
          encodePersisted: (value: unknown) => String(value),
          decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
        },
      },
    ] as never);
    const filter = [{ columnId, filter: Object.freeze({ id: 1 }), type: "equals" }];

    expect(sanitizeClientInitialFilters(filter, columns)).toEqual([]);
    expect(() => sanitizeClientInitialFilters(filter, columns, { rejectOverBudget: true })).toThrow(
      /1048576 UTF-16 text units/u,
    );
  });

  it("shares one aggregate retained-text budget across public entries", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const operand = "x".repeat(150_000);
    const filters = [
      { columnId: "COL_ID_NAME", filter: operand, type: "equals" as const },
      { columnId: "COL_ID_NAME", filter: operand, type: "equals" as const },
    ];

    expect(compileClientFilterCollection(filters, columns).expressions).toHaveLength(1);
    expect(() =>
      compileClientFilterCollection(filters, columns, { rejectOverBudget: true }),
    ).toThrowError(/1048576 UTF-16 text units/u);
  });

  it("memoizes shared retained filter descriptions across aliased entries", () => {
    const formatDisplay = vi.fn((value: unknown) => String(value));
    const columns = compileColumns([
      {
        columnId: "COL_ID_CUSTOM_TEXT",
        field: "value",
        headerName: "Value",
        valueType: {
          codecId: "test/shared-description",
          codecVersion: 1,
          filterFamily: "text",
          editorFamily: "text",
          cellAlign: "start",
          editorLayout: "inline",
          defaultWidth: 160,
          decodeRuntime: (input: unknown) => ({ _tag: "Success" as const, value: input }),
          equivalent: Object.is,
          compare: () => 0,
          formatCanonicalText: (value: unknown) => String(value),
          parseCanonicalText: (text: string) => ({ _tag: "Success" as const, value: text }),
          formatDisplay,
          encodePersisted: (value: unknown) => String(value),
          decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
        },
      },
    ] as never);
    const first = compileClientFilterCollection(
      [{ columnId: "COL_ID_CUSTOM_TEXT", filter: "Ada", type: "equals" }],
      columns,
    );
    formatDisplay.mockClear();

    const shared = first.expressions[0]!.filter;
    const repeated = compileClientFilterCollection([shared, shared], columns);

    expect(repeated.expressions).toHaveLength(1);
    expect(formatDisplay).toHaveBeenCalledOnce();
  });

  it("rejects a reset whose retained baseline would exceed the aggregate budget", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    const baseline = compileClientFilterCollection(
      [{ columnId: "COL_ID_NAME", filter: "Ada", type: "equals" }],
      columns,
    );
    const current = compileClientFilterCollection(
      [
        {
          columnId: "COL_ID_SCORE",
          filter: Array.from({ length: 16_384 }, (_, index) => index),
          type: "in",
        },
      ],
      columns,
    );

    expect(restoreClientFilterColumn(current, baseline, "COL_ID_NAME")).toBeUndefined();
  });

  it("rejects unreadable custom object operands before invoking the decoder", () => {
    const decodeRuntime = vi.fn((input: unknown) => ({ _tag: "Success" as const, value: input }));
    const valueType = {
      codecId: "test/unreadable-object",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 160,
      decodeRuntime,
      equivalent: (left: unknown, right: unknown) => Object.is(left, right),
      compare: () => 0,
      formatCanonicalText: (value: unknown) => String(value),
      parseCanonicalText: (text: string) => ({ _tag: "Success" as const, value: text }),
      formatDisplay: (value: unknown) => String(value),
      encodePersisted: (value: unknown) => String(value),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType,
      } as never,
    ]);
    const unreadable = new Proxy(
      { value: "Ada" },
      {
        ownKeys() {
          throw new Error("unreadable operand");
        },
      },
    );

    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_VALUE", filter: unreadable, type: "equals" }],
        columns,
      ),
    ).toEqual([]);
    expect(decodeRuntime).not.toHaveBeenCalled();
  });

  it("indexes large built-in text in operands before evaluating rows", () => {
    const formatCanonicalText = vi.fn((value: string) => value);
    const valueType = {
      codecId: "test/indexed-text",
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 160,
      decodeRuntime: (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success" as const, value: input } as const)
          : ({ _tag: "Failure" as const, message: "Expected text." } as const),
      equivalent: (left: string, right: string) => left === right,
      compare: () => 0,
      formatCanonicalText,
      parseCanonicalText: (text: string) => ({ _tag: "Success" as const, value: text }),
      formatDisplay: (value: string) => value,
      encodePersisted: (value: string) => value,
      decodePersisted: (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success" as const, value: input } as const)
          : ({ _tag: "Failure" as const, message: "Expected text." } as const),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType,
      } as never,
    ]);
    const operands = Array.from({ length: 4_096 }, (_, index) => `value-${index}`);
    const filters = sanitizeClientInitialFilters(
      [{ columnId: "COL_ID_VALUE", filter: operands, type: "in" }],
      columns,
    );
    formatCanonicalText.mockClear();

    expect(filterClientRows([{ value: "value-4095" }], columns, filters)).toEqual([
      { value: "value-4095" },
    ]);
    expect(formatCanonicalText).toHaveBeenCalledTimes(operands.length + 1);
  });

  it("admits configured Select values beyond the authored text bound", () => {
    const status = "x".repeat(1_025);
    const selectColumn = Reflect.apply(BrunoTableSelectColumn, undefined, [
      {
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        options: [status],
      },
    ]) as Readonly<Record<string, unknown>>;
    const columns = compileColumns([selectColumn]);

    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_STATUS", filter: status, type: "equals" }],
        columns,
        { rejectOverBudget: true },
      ),
    ).toEqual([{ columnId: "COL_ID_STATUS", filter: status, type: "equals" }]);
    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_STATUS", filter: `${status}-stale`, type: "equals" }],
        columns,
      ),
    ).toEqual([]);

    const repeated = Array.from({ length: 2_048 }, () => ({
      columnId: "COL_ID_STATUS",
      filter: status,
      type: "equals" as const,
    }));
    const repeatedCollection = compileClientFilterCollection(repeated, columns);
    expect(repeatedCollection.expressions.length).toBeLessThan(repeated.length);
    expect(repeatedCollection.complexity.textLength).toBeLessThanOrEqual(
      BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_TEXT_LENGTH,
    );
  });

  it("does not re-decode an already compiled long Select option", () => {
    const status = "x".repeat(1_025);
    const decodeRuntime = vi.fn((input: unknown) => ({ _tag: "Success" as const, value: input }));
    const selectValueType = {
      codecId: "test/select",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "select",
      cellAlign: "start",
      editorLayout: "fullWidth",
      defaultWidth: 160,
      decodeRuntime,
      equivalent: (left: unknown, right: unknown) => Object.is(left, right),
      compare: () => 0,
      formatCanonicalText: (value: unknown) => String(value),
      parseCanonicalText: (text: string) => ({ _tag: "Success" as const, value: text }),
      formatDisplay: (value: unknown) => String(value),
      encodePersisted: (value: unknown) => String(value),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_CUSTOM_SELECT",
        field: "status",
        headerName: "Status",
        valueType: selectValueType,
        options: [status],
      } as never,
    ]);
    const compileDecodeCalls = decodeRuntime.mock.calls.length;

    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_CUSTOM_SELECT", filter: status, type: "equals" }],
        columns,
      ),
    ).toEqual([{ columnId: "COL_ID_CUSTOM_SELECT", filter: status, type: "equals" }]);
    expect(decodeRuntime).toHaveBeenCalledTimes(compileDecodeCalls);
  });

  it("canonicalizes semantically equal Select operands without decoding them", () => {
    const configured = Object.freeze({ code: "open" });
    const equivalentOperand = Object.freeze({ code: "open" });
    const decodeRuntime = vi.fn((input: unknown) => ({ _tag: "Success" as const, value: input }));
    const selectValueType = {
      codecId: "test/object-select",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "select",
      cellAlign: "start",
      editorLayout: "fullWidth",
      defaultWidth: 160,
      decodeRuntime,
      equivalent: (left: unknown, right: unknown) =>
        typeof left === "object" &&
        left !== null &&
        typeof right === "object" &&
        right !== null &&
        Reflect.get(left, "code") === Reflect.get(right, "code"),
      compare: () => 0,
      formatCanonicalText: (value: unknown) => String(Reflect.get(value as object, "code")),
      parseCanonicalText: (text: string) => ({
        _tag: "Success" as const,
        value: Object.freeze({ code: text }),
      }),
      formatDisplay: (value: unknown) => String(Reflect.get(value as object, "code")),
      encodePersisted: (value: unknown) => String(Reflect.get(value as object, "code")),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_OBJECT_SELECT",
        field: "status",
        headerName: "Status",
        valueType: selectValueType,
        options: [configured],
      } as never,
    ]);
    const compileDecodeCalls = decodeRuntime.mock.calls.length;

    const sanitized = sanitizeClientInitialFilters(
      [{ columnId: "COL_ID_OBJECT_SELECT", filter: equivalentOperand, type: "equals" }],
      columns,
    );

    expect(sanitized[0]).toMatchObject({ columnId: "COL_ID_OBJECT_SELECT", type: "equals" });
    expect((sanitized[0] as { readonly filter: unknown }).filter).toBe(configured);
    expect(decodeRuntime).toHaveBeenCalledTimes(compileDecodeCalls);
  });

  it("charges configured Select canonical text through the aggregate ledger", () => {
    const canonical = "c".repeat(2_048);
    const configured = Object.freeze({ code: "open" });
    const selectValueType = {
      codecId: "test/long-canonical-select",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "select",
      cellAlign: "start",
      editorLayout: "fullWidth",
      defaultWidth: 160,
      decodeRuntime: (input: unknown) => ({ _tag: "Success" as const, value: input }),
      equivalent: (left: unknown, right: unknown) =>
        typeof left === "object" &&
        left !== null &&
        typeof right === "object" &&
        right !== null &&
        Reflect.get(left, "code") === Reflect.get(right, "code"),
      compare: () => 0,
      formatCanonicalText: () => canonical,
      parseCanonicalText: (text: string) => ({
        _tag: "Success" as const,
        value: Object.freeze({ code: text }),
      }),
      formatDisplay: (value: unknown) => String(Reflect.get(value as object, "code")),
      encodePersisted: (value: unknown) => String(Reflect.get(value as object, "code")),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_LONG_CANONICAL_SELECT",
        field: "status",
        headerName: "Status",
        valueType: selectValueType,
        options: [configured],
      } as never,
    ]);
    const filters = Array.from({ length: 1_024 }, () => ({
      columnId: "COL_ID_LONG_CANONICAL_SELECT",
      filter: Object.freeze({ code: "open" }),
      type: "equals" as const,
    }));

    const collection = compileClientFilterCollection(filters, columns);

    expect(collection.expressions.length).toBeLessThan(filters.length);
    expect(collection.complexity.textLength).toBeLessThanOrEqual(
      BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_TEXT_LENGTH,
    );

    const exactFilters = Array.from({ length: 1_024 }, () => ({
      columnId: "COL_ID_LONG_CANONICAL_SELECT",
      filter: configured,
      type: "equals" as const,
    }));
    const exactCollection = compileClientFilterCollection(exactFilters, columns);
    expect(exactCollection.expressions.length).toBeLessThan(exactFilters.length);
  });

  it("charges custom Select scans to one collection-wide comparison allowance", () => {
    const options = Array.from({ length: 16_384 }, (_, index) =>
      Object.freeze({ code: String(index) }),
    );
    const equivalent = vi.fn(
      (left: unknown, right: unknown) =>
        typeof left === "object" &&
        left !== null &&
        typeof right === "object" &&
        right !== null &&
        Reflect.get(left, "code") === Reflect.get(right, "code"),
    );
    const selectValueType = {
      codecId: "test/large-equivalence-select",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "select",
      cellAlign: "start",
      editorLayout: "fullWidth",
      defaultWidth: 160,
      decodeRuntime: (input: unknown) => ({ _tag: "Success" as const, value: input }),
      equivalent,
      compare: () => 0,
      formatCanonicalText: () => {
        throw new Error("No canonical identity");
      },
      parseCanonicalText: (text: string) => ({
        _tag: "Success" as const,
        value: Object.freeze({ code: text }),
      }),
      formatDisplay: (value: unknown) => String(Reflect.get(value as object, "code")),
      encodePersisted: (value: unknown) => String(Reflect.get(value as object, "code")),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_LARGE_EQUIVALENCE_SELECT",
        field: "status",
        headerName: "Status",
        valueType: selectValueType,
        options,
      } as never,
    ]);

    const collection = compileClientFilterCollection(
      [
        {
          columnId: "COL_ID_LARGE_EQUIVALENCE_SELECT",
          filter: Object.freeze({ code: "16383" }),
          type: "equals",
        },
      ],
      columns,
    );

    expect(collection.expressions).toHaveLength(1);
    expect(equivalent).toHaveBeenCalledTimes(BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS);
  });

  it("replays accepted nested Select aliases without repeating semantic comparisons", () => {
    const options = Array.from({ length: 16_384 }, (_, index) =>
      Object.freeze({ code: String(index) }),
    );
    const equivalent = vi.fn(
      (left: unknown, right: unknown) =>
        typeof left === "object" &&
        left !== null &&
        typeof right === "object" &&
        right !== null &&
        Reflect.get(left, "code") === Reflect.get(right, "code"),
    );
    const selectValueType = {
      codecId: "test/aliased-equivalence-select",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "select",
      cellAlign: "start",
      editorLayout: "fullWidth",
      defaultWidth: 160,
      decodeRuntime: (input: unknown) => ({ _tag: "Success" as const, value: input }),
      equivalent,
      compare: () => 0,
      formatCanonicalText: () => {
        throw new Error("No canonical identity");
      },
      parseCanonicalText: (text: string) => ({
        _tag: "Success" as const,
        value: Object.freeze({ code: text }),
      }),
      formatDisplay: (value: unknown) => String(Reflect.get(value as object, "code")),
      encodePersisted: (value: unknown) => String(Reflect.get(value as object, "code")),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_ALIASED_EQUIVALENCE_SELECT",
        field: "status",
        headerName: "Status",
        valueType: selectValueType,
        options,
      } as never,
    ]);
    const sharedLeaf = Object.freeze({
      columnId: "COL_ID_ALIASED_EQUIVALENCE_SELECT",
      filter: Object.freeze({ code: "16383" }),
      type: "equals" as const,
    });

    const collection = compileClientFilterCollection(
      [
        { type: "AND", conditions: [sharedLeaf] },
        { type: "NOT", condition: sharedLeaf },
      ],
      columns,
    );

    expect(collection.expressions).toHaveLength(1);
    expect(collection.filters[0]).toMatchObject({
      type: "AND",
      conditions: [{ type: "AND" }, { type: "NOT" }],
    });
    expect(equivalent).toHaveBeenCalledTimes(BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS);
  });

  it("does not reopen the comparison allowance for rejected Select entries", () => {
    const options = Array.from({ length: 64 }, (_, index) =>
      Object.freeze({ code: String(index) }),
    );
    const equivalent = vi.fn(
      (left: unknown, right: unknown) =>
        typeof left === "object" &&
        left !== null &&
        typeof right === "object" &&
        right !== null &&
        Reflect.get(left, "code") === Reflect.get(right, "code"),
    );
    const selectValueType = {
      codecId: "test/shared-equivalence-budget",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "select",
      cellAlign: "start",
      editorLayout: "fullWidth",
      defaultWidth: 160,
      decodeRuntime: (input: unknown) => ({ _tag: "Success" as const, value: input }),
      equivalent,
      compare: () => 0,
      formatCanonicalText: () => {
        throw new Error("No canonical identity");
      },
      parseCanonicalText: (text: string) => ({
        _tag: "Success" as const,
        value: Object.freeze({ code: text }),
      }),
      formatDisplay: (value: unknown) => String(Reflect.get(value as object, "code")),
      encodePersisted: (value: unknown) => String(Reflect.get(value as object, "code")),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_SHARED_EQUIVALENCE_BUDGET",
        field: "status",
        headerName: "Status",
        valueType: selectValueType,
        options,
      } as never,
    ]);
    const filters = Array.from(
      { length: BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS / options.length + 4 },
      (_, index) => ({
        columnId: "COL_ID_SHARED_EQUIVALENCE_BUDGET",
        filter: Object.freeze({ code: `missing-${String(index)}` }),
        type: "equals" as const,
      }),
    );

    const collection = compileClientFilterCollection(
      [
        ...filters,
        {
          columnId: "COL_ID_SHARED_EQUIVALENCE_BUDGET",
          filter: Object.freeze({ code: "0" }),
          type: "equals" as const,
        },
      ],
      columns,
    );

    expect(collection.expressions).toEqual([]);
    expect(equivalent).toHaveBeenCalledTimes(BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS);
  });

  it("starts a fresh comparison allowance for each replacement admission", () => {
    const options = Array.from(
      { length: BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS },
      (_, index) => Object.freeze({ code: String(index) }),
    );
    const equivalent = vi.fn(
      (left: unknown, right: unknown) =>
        typeof left === "object" &&
        left !== null &&
        typeof right === "object" &&
        right !== null &&
        Reflect.get(left, "code") === Reflect.get(right, "code"),
    );
    const selectValueType = {
      codecId: "test/replacement-equivalence-budget",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "select",
      cellAlign: "start",
      editorLayout: "fullWidth",
      defaultWidth: 160,
      decodeRuntime: (input: unknown) => ({ _tag: "Success" as const, value: input }),
      equivalent,
      compare: () => 0,
      formatCanonicalText: () => {
        throw new Error("No canonical identity");
      },
      parseCanonicalText: (text: string) => ({
        _tag: "Success" as const,
        value: Object.freeze({ code: text }),
      }),
      formatDisplay: (value: unknown) => String(Reflect.get(value as object, "code")),
      encodePersisted: (value: unknown) => String(Reflect.get(value as object, "code")),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_REPLACEMENT_EQUIVALENCE_BUDGET",
        field: "status",
        headerName: "Status",
        valueType: selectValueType,
        options,
      } as never,
    ]);
    const collection = compileClientFilterCollection(
      [
        {
          columnId: "COL_ID_REPLACEMENT_EQUIVALENCE_BUDGET",
          filter: options[0],
          type: "equals" as const,
        },
      ],
      columns,
    );

    const firstReplacement = replaceClientFilterColumn(
      collection,
      "COL_ID_REPLACEMENT_EQUIVALENCE_BUDGET",
      {
        columnId: "COL_ID_REPLACEMENT_EQUIVALENCE_BUDGET",
        filter: Object.freeze({ code: String(options.length - 1) }),
        type: "equals" as const,
      },
    );
    const secondReplacement = replaceClientFilterColumn(
      firstReplacement!,
      "COL_ID_REPLACEMENT_EQUIVALENCE_BUDGET",
      {
        columnId: "COL_ID_REPLACEMENT_EQUIVALENCE_BUDGET",
        filter: Object.freeze({ code: String(options.length - 2) }),
        type: "equals" as const,
      },
    );

    expect(firstReplacement?.expressions).toHaveLength(1);
    expect(secondReplacement?.expressions).toHaveLength(1);
    expect(equivalent).toHaveBeenCalledTimes(
      BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS * 2 - 1,
    );
  });

  it("admits exact custom Select equality without a configured option domain", () => {
    const selectValueType = {
      codecId: "test/optionless-select",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 160,
      decodeRuntime: (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success" as const, value: input } as const)
          : ({ _tag: "Failure" as const, message: "Expected text." } as const),
      equivalent: (left: string, right: string) => left === right,
      compare: (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0),
      formatCanonicalText: (value: string) => value,
      parseCanonicalText: (text: string) => ({ _tag: "Success" as const, value: text }),
      formatDisplay: (value: string) => value,
      encodePersisted: (value: string) => value,
      decodePersisted: (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success" as const, value: input } as const)
          : ({ _tag: "Failure" as const, message: "Expected text." } as const),
    } as const;
    const columns = compileColumns([
      {
        columnId: "COL_ID_CUSTOM_SELECT_NO_OPTIONS",
        field: "status",
        headerName: "Status",
        valueType: selectValueType,
      } as never,
    ]);

    const filters = sanitizeClientInitialFilters(
      [{ columnId: "COL_ID_CUSTOM_SELECT_NO_OPTIONS", filter: "open", type: "equals" }],
      columns,
    );

    expect(filters).toEqual([
      { columnId: "COL_ID_CUSTOM_SELECT_NO_OPTIONS", filter: "open", type: "equals" },
    ]);
    expect(filterClientRows([{ status: "open" }, { status: "closed" }], columns, filters)).toEqual([
      { status: "open" },
    ]);
  });

  it("captures admitted dense operands without enumerating unrelated own properties", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    const values = [1] as number[] & { noise?: string };
    values.noise = "unrelated";
    const ownKeys = vi.fn((): never => {
      throw new Error("Dense operand own keys must not be enumerated.");
    });
    const operand = new Proxy(values, { ownKeys });

    const sanitized = sanitizeClientInitialFilters(
      [{ columnId: "COL_ID_SCORE", filter: operand, type: "in" }],
      columns,
    );

    expect((sanitized[0] as { readonly filter: readonly unknown[] }).filter).toEqual([1]);
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("rejects a compound filter over the total node budget before materializing conditions", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const leaf = Object.freeze({ columnId: "COL_ID_NAME", filter: "Ada", type: "equals" });
    const ownKeys = vi.fn(Reflect.ownKeys);
    const overBudgetConditions = new Proxy(
      Array.from({ length: 16_385 }, () => leaf),
      { ownKeys },
    );

    expect(
      sanitizeClientInitialFilters([{ conditions: overBudgetConditions, type: "AND" }], columns),
    ).toEqual([]);
    expect(ownKeys).not.toHaveBeenCalled();
    expect(() =>
      sanitizeClientInitialFilters([{ conditions: overBudgetConditions, type: "AND" }], columns, {
        rejectOverBudget: true,
      }),
    ).toThrowError(
      "BrunoTable initialFilters may contain at most 16384 nodes, 16384 operands, 1048576 UTF-16 text units, 16384 semantic comparisons, and nesting depth 64.",
    );

    expect(
      sanitizeClientInitialFilters(
        [{ conditions: Array.from({ length: 16_383 }, () => leaf), type: "AND" }],
        columns,
      ),
    ).toHaveLength(1);
  });

  it("applies the filter-node budget across nested condition arrays", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const leaf = Object.freeze({ columnId: "COL_ID_NAME", filter: "Ada", type: "equals" });
    const lastOwnKeys = vi.fn(Reflect.ownKeys);
    const groups = Array.from({ length: 128 }, (_, index) => ({
      conditions:
        index === 126
          ? new Proxy(
              Array.from({ length: 128 }, () => leaf),
              { ownKeys: lastOwnKeys },
            )
          : Array.from({ length: 128 }, () => leaf),
      type: "AND",
    }));

    expect(sanitizeClientInitialFilters([{ conditions: groups, type: "AND" }], columns)).toEqual(
      [],
    );
    expect(lastOwnKeys).not.toHaveBeenCalled();
  });

  it("reuses already-sanitized filter references for an equivalent column plan", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const first = sanitizeClientInitialFilters(
      [
        {
          type: "AND",
          conditions: [
            { columnId: "COL_ID_NAME", type: "startsWith", filter: "A" },
            { columnId: "COL_ID_NAME", type: "notBlank" },
          ],
        },
      ],
      columns,
    );
    const replacement = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Display name",
        valueType: "text",
        width: 240,
      },
    ]);

    expect(sanitizeClientInitialFilters(first, replacement)).toBe(first);
  });
});
