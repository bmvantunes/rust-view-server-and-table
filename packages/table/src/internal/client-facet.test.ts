import { describe, expect, it, vi } from "vitest";

import { compileColumns } from "./compile-columns";
import {
  applyBrunoTableSetFilterCommand,
  createBrunoTableClientFacetSnapshot,
  createBrunoTableClientFacetStore,
  createBrunoTableServerFacetSnapshot,
  isBrunoTableSetFilterExpression,
  readBrunoTableSetFilterIntent,
} from "./client-facet";
import type { BrunoTableClientFacetRowsSnapshot } from "./client-source-adapter";
import {
  compileClientFilterCollection,
  filterClientRows,
  replaceClientFilterColumn,
} from "./grid-query";
import {
  createBrunoTableInvalidCellValue,
  type BrunoTableRowPipelineRuntimeView,
} from "./grid-runtime";

type Row = Readonly<{
  active: boolean;
  amount: bigint;
  region: "east" | "west";
}>;

const columns = compileColumns([
  {
    columnId: "COL_ID_ACTIVE",
    field: "active",
    headerName: "Active",
    valueType: "boolean",
  },
  {
    columnId: "COL_ID_AMOUNT",
    enableSetFilter: true,
    field: "amount",
    headerName: "Amount",
    valueType: "bigint",
  },
  {
    columnId: "COL_ID_REGION",
    field: "region",
    headerName: "Region",
    valueType: "text",
  },
]);

const activeColumn = columns[0]!;
const amountColumn = columns[1]!;
const rows: readonly Row[] = Object.freeze([
  Object.freeze({ active: true, amount: 9_007_199_254_740_993n, region: "east" }),
  Object.freeze({ active: false, amount: 9_007_199_254_740_994n, region: "east" }),
  Object.freeze({ active: true, amount: 9_007_199_254_740_993n, region: "west" }),
]);

describe("Client Set Filter intent", () => {
  it("projects native whole-result Server facet rows without leaking the private count alias", () => {
    const value = 9_007_199_254_740_993n;
    expect(
      createBrunoTableServerFacetSnapshot({
        column: amountColumn,
        countAlias: "__bruno_table_facet_count",
        rows: [
          { amount: value, __bruno_table_facet_count: 3n },
          { amount: value + 1n, __bruno_table_facet_count: 2n },
        ],
        expression: {
          columnId: "COL_ID_AMOUNT",
          type: "in",
          filter: [value, value + 2n],
        },
      }),
    ).toEqual({
      intent: { kind: "include", values: [value, value + 2n] },
      options: [
        { value, count: 3n, display: String(value) },
        { value: value + 1n, count: 2n, display: String(value + 1n) },
        { value: value + 2n, count: 0n, display: String(value + 2n) },
      ],
    });
  });

  it("keeps a colliding grouped source Field distinct from its plan-owned count alias", () => {
    const field = "__bruno_table_facet_count";
    const countAlias = `${field}_1`;
    const column = compileColumns([
      {
        columnId: "COL_ID_COLLIDING_FACET",
        enableSetFilter: true,
        field,
        headerName: "Facet",
        valueType: "text",
      },
    ])[0]!;

    expect(
      createBrunoTableServerFacetSnapshot({
        column,
        countAlias,
        rows: [{ [field]: "source value", [countAlias]: 4n }],
        expression: undefined,
      }),
    ).toEqual({
      intent: { kind: "all" },
      options: [{ value: "source value", count: 4n, display: "source value" }],
    });
  });

  it("coalesces equivalent decoded Server groups with exact bigint counts", () => {
    type Token = Readonly<{ readonly raw: string }>;
    const tokenColumn = compileColumns([
      {
        columnId: "COL_ID_SERVER_TOKEN",
        enableSetFilter: true,
        field: "token",
        headerName: "Token",
        valueType: {
          codecId: "test/server-token-facet",
          codecVersion: 1,
          filterFamily: "select",
          editorFamily: "text",
          cellAlign: "start",
          editorLayout: "inline",
          defaultWidth: 120,
          decodeRuntime: (input: unknown) =>
            typeof input === "object" && input !== null && "raw" in input
              ? ({ _tag: "Success", value: input as Token } as const)
              : ({ _tag: "Failure", message: "Expected token." } as const),
          equivalent: (left: Token, right: Token) =>
            left.raw.toLocaleLowerCase() === right.raw.toLocaleLowerCase(),
          compare: (left: Token, right: Token) =>
            left.raw.toLocaleLowerCase().localeCompare(right.raw.toLocaleLowerCase()),
          formatCanonicalText: (value: Token) => value.raw.toLocaleLowerCase(),
          parseCanonicalText: (text: string) =>
            ({ _tag: "Success", value: { raw: text } }) as const,
          formatDisplay: (value: Token) => value.raw,
          encodePersisted: (value: Token) => value.raw,
          decodePersisted: (input: unknown) =>
            typeof input === "string"
              ? ({ _tag: "Success", value: { raw: input } } as const)
              : ({ _tag: "Failure", message: "Expected token." } as const),
        },
      },
    ])[0]!;
    const first = Object.freeze({ raw: "A" });
    const equivalent = Object.freeze({ raw: "a" });

    expect(
      createBrunoTableServerFacetSnapshot({
        column: tokenColumn,
        countAlias: "count",
        rows: [
          { token: first, count: 9_007_199_254_740_993n },
          { token: equivalent, count: 2n },
        ],
        expression: undefined,
      }),
    ).toEqual({
      intent: { kind: "all" },
      options: [
        {
          value: first,
          count: 9_007_199_254_740_995n,
          display: "A",
        },
      ],
    });
  });

  it.each([
    ["missing", {}],
    ["number", { count: 1 }],
    ["string", { count: "1" }],
    ["negative", { count: -1n }],
  ])("rejects a %s Server facet count instead of publishing a partial domain", (_name, count) => {
    expect(() =>
      createBrunoTableServerFacetSnapshot({
        column: amountColumn,
        countAlias: "count",
        rows: [
          { amount: 1n, count: 2n },
          { amount: 2n, ...count },
        ],
        expression: undefined,
      }),
    ).toThrow("BrunoTable Server facet delivered an invalid aggregate count.");
  });

  it.each([null, undefined, "row", 1, true, () => undefined])(
    "rejects a non-record Server facet row without publishing a valid prefix",
    (candidate) => {
      expect(() =>
        createBrunoTableServerFacetSnapshot({
          column: amountColumn,
          countAlias: "count",
          rows: [{ amount: 1n, count: 2n }, candidate],
          expression: undefined,
        }),
      ).toThrow("BrunoTable Server facet delivered an invalid grouped row.");
    },
  );

  it("accepts zero and arbitrarily large exact Server facet counts", () => {
    const large = 9_007_199_254_740_993_123_456n;
    expect(
      createBrunoTableServerFacetSnapshot({
        column: amountColumn,
        countAlias: "count",
        rows: [
          { amount: 1n, count: 0n },
          { amount: 2n, count: large },
        ],
        expression: undefined,
      }).options.map(({ count }) => count),
    ).toEqual([0n, large]);
  });

  it("normalizes inclusion and exclusion through one complete column expression", () => {
    const excluded = applyBrunoTableSetFilterCommand(activeColumn, { kind: "all" }, [true, false], {
      type: "toggle",
      value: false,
      selected: false,
    });
    expect(excluded).toEqual({
      type: "NOT",
      condition: { columnId: "COL_ID_ACTIVE", type: "in", filter: [false] },
    });
    expect(readBrunoTableSetFilterIntent(activeColumn, excluded)).toEqual({
      kind: "exclude",
      values: [false],
    });

    const selectedAll = applyBrunoTableSetFilterCommand(
      activeColumn,
      { kind: "exclude", values: [false] },
      [true, false],
      { type: "toggle", value: false, selected: true },
    );
    expect(selectedAll).toBeUndefined();

    const included = applyBrunoTableSetFilterCommand(
      activeColumn,
      { kind: "include", values: [] },
      [true, false],
      { type: "toggle", value: true, selected: true },
    );
    expect(included).toEqual({ columnId: "COL_ID_ACTIVE", type: "in", filter: [true] });

    const manuallySelectedFinal = applyBrunoTableSetFilterCommand(
      activeColumn,
      { kind: "include", values: [true] },
      [true, false],
      { type: "toggle", value: false, selected: true },
    );
    expect(manuallySelectedFinal).toBeUndefined();
  });

  it("stores Clear All as explicit empty inclusion Match None", () => {
    const cleared = applyBrunoTableSetFilterCommand(activeColumn, { kind: "all" }, [true, false], {
      type: "clear-all",
    });
    expect(cleared).toEqual({ columnId: "COL_ID_ACTIVE", type: "matchNone" });
    expect(readBrunoTableSetFilterIntent(activeColumn, cleared)).toEqual({
      kind: "include",
      values: [],
    });
    expect(filterClientRows(rows, columns, [cleared])).toEqual([]);
    expect(
      filterClientRows(
        [...rows, { active: false, amount: 9_007_199_254_740_995n, region: "east" }],
        columns,
        [cleared],
      ),
    ).toEqual([]);
  });

  it("keeps opted-in Text Set membership exact without claiming insensitive programmatic intent", () => {
    const textColumns = compileColumns([
      {
        columnId: "COL_ID_LABEL",
        enableSetFilter: true,
        field: "label",
        headerName: "Label",
        valueType: "text",
      },
    ]);
    const column = textColumns[0]!;
    const insensitive = { columnId: "COL_ID_LABEL", type: "in", filter: ["A"] };
    expect(readBrunoTableSetFilterIntent(column, insensitive)).toEqual({ kind: "all" });
    expect(isBrunoTableSetFilterExpression(column, insensitive)).toBe(false);

    const exact = applyBrunoTableSetFilterCommand(
      column,
      { kind: "include", values: [] },
      ["A", "a", "é", "e"],
      { type: "toggle", value: "A", selected: true },
    );
    expect(exact).toEqual({
      columnId: "COL_ID_LABEL",
      type: "in",
      filter: ["A"],
      caseSensitive: true,
      accentSensitive: true,
    });
    expect(
      filterClientRows(
        [{ label: "A" }, { label: "a" }, { label: "é" }, { label: "e\u0301" }, { label: "e" }],
        textColumns,
        [exact],
      ),
    ).toEqual([{ label: "A" }]);

    const composed = applyBrunoTableSetFilterCommand(
      column,
      { kind: "include", values: [] },
      ["é", "e\u0301"],
      { type: "toggle", value: "é", selected: true },
    );
    expect(
      filterClientRows([{ label: "é" }, { label: "e\u0301" }], textColumns, [composed]),
    ).toEqual([{ label: "é" }]);
  });
});

describe("Client facet projection", () => {
  it("reuses live counts when only the owning column intent changes", () => {
    let filterCollection = compileClientFilterCollection([], columns);
    let filterListener: (() => void) | undefined;
    const read = vi.fn((raw: Row, column: (typeof columns)[number]) =>
      column.kind === "field" ? raw[column.field as keyof Row] : undefined,
    );
    const admittedRows = rows.map((raw, rowIndex) => ({
      raw,
      rowId: `row-${String(rowIndex)}`,
      rowIndex,
      values: {
        read: (
          nextRaw: unknown,
          _rowId: unknown,
          _rowIndex: number,
          column: (typeof columns)[number],
        ) => read(nextRaw as Row, column),
      },
    }));
    const query = () => ({
      columns,
      filters: filterCollection.filters,
      filterCollection,
      quickFilter: "",
      orderBy: [{ columnId: "COL_ID_ACTIVE", direction: "asc" as const }],
      generation: 1,
      navigationMode: "reset" as const,
    });
    const runtime = {
      getQuerySnapshot: query,
      getRowSpaceSnapshot: () => undefined,
      getQuickFilterFieldsSnapshot: () => [],
      subscribeFilter: (listener: () => void) => {
        filterListener = listener;
        return () => {
          filterListener = undefined;
        };
      },
      subscribeRowSpace: () => () => undefined,
    } as unknown as BrunoTableRowPipelineRuntimeView;
    const store = createBrunoTableClientFacetStore({
      column: activeColumn,
      rows: {
        getFacetRowsSnapshot: () => ({
          rows: admittedRows as never,
          token: admittedRows,
          changedIndexes: [],
        }),
      },
      runtime,
    });
    const unsubscribe = store.subscribe(() => undefined);

    const initialSnapshot = store.getSnapshot();
    expect(initialSnapshot.options).toHaveLength(2);
    const readsAfterOpen = read.mock.calls.length;
    filterCollection = replaceClientFilterColumn(filterCollection, "COL_ID_ACTIVE", {
      type: "NOT",
      condition: { columnId: "COL_ID_ACTIVE", type: "in", filter: [false] },
    })!;
    filterListener?.();
    expect(store.getSnapshot().intent).toEqual({ kind: "exclude", values: [false] });
    expect(read).toHaveBeenCalledTimes(readsAfterOpen);
    unsubscribe();
  });

  it("skips a full projection when changed rows preserve every facet dependency", () => {
    let rowListener: (() => void) | undefined;
    let quickFilter = "\u0301";
    const firstRows = rows.map((raw, rowIndex) => admittedRow(raw, rowIndex));
    const changedRaw = Object.freeze({
      ...rows[0]!,
      get unrelated(): never {
        throw new Error("Unreadable dormant Quick Filter field.");
      },
    });
    const secondRows = [admittedRow(changedRaw, 0), ...firstRows.slice(1)];
    const firstToken = Object.freeze({});
    const secondToken = Object.freeze({});
    let rowSnapshot: BrunoTableClientFacetRowsSnapshot = {
      rows: firstRows,
      token: firstToken,
      changedIndexes: Object.freeze([] as number[]),
    };
    const filterCollection = compileClientFilterCollection([], columns);
    const runtime = {
      getQuerySnapshot: () => ({
        columns,
        filters: filterCollection.filters,
        filterCollection,
        quickFilter,
        orderBy: [{ columnId: "COL_ID_ACTIVE", direction: "asc" as const }],
        generation: 1,
        navigationMode: "reset" as const,
      }),
      getRowSpaceSnapshot: () => undefined,
      getQuickFilterFieldsSnapshot: () => ["unrelated"],
      subscribeFilter: () => () => undefined,
      subscribeRowSpace: (listener: () => void) => {
        rowListener = listener;
        return () => {
          rowListener = undefined;
        };
      },
    } as unknown as BrunoTableRowPipelineRuntimeView;
    const store = createBrunoTableClientFacetStore({
      column: activeColumn,
      rows: { getFacetRowsSnapshot: () => rowSnapshot },
      runtime,
    });
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    const initialSnapshot = store.getSnapshot();
    expect(initialSnapshot.options).toHaveLength(2);
    const readsAfterOpen = firstRows[0]!.values.read as ReturnType<typeof vi.fn>;
    const initialReads = readsAfterOpen.mock.calls.length;

    rowSnapshot = {
      rows: secondRows,
      token: secondToken,
      parentToken: firstToken,
      changedIndexes: Object.freeze([0]),
    };
    rowListener?.();
    expect(store.getSnapshot()).toBe(initialSnapshot);
    expect(readsAfterOpen.mock.calls.length - initialReads).toBeLessThanOrEqual(1);
    expect(notify).not.toHaveBeenCalled();

    quickFilter = "needle";
    expect(() => rowListener?.()).not.toThrow();
    expect(store.getSnapshot().options).toEqual([]);
    const activeQuickFilterSnapshot = store.getSnapshot();
    const thirdToken = Object.freeze({});
    rowSnapshot = {
      rows: [admittedRow(changedRaw, 0), ...secondRows.slice(1)],
      token: thirdToken,
      parentToken: secondToken,
      changedIndexes: Object.freeze([0]),
    };
    expect(() => rowListener?.()).not.toThrow();
    expect(store.getSnapshot()).not.toBe(activeQuickFilterSnapshot);
    expect(store.getSnapshot().options).toEqual([]);
    unsubscribe();
  });

  it("omits invalid decoded cell evidence from the typed facet domain", () => {
    const invalid = createBrunoTableInvalidCellValue({
      kind: "invalid-value",
      rowIndex: 1,
      columnId: "COL_ID_ACTIVE",
      message: "Expected boolean.",
    });
    const snapshot = createBrunoTableClientFacetSnapshot({
      column: activeColumn,
      columns,
      filterCollection: compileClientFilterCollection([], columns),
      quickFilter: "",
      quickFilterFields: [],
      rows: [true, invalid, false],
      readColumnValue: (_column, row) => row,
      readQuickFilterField: () => undefined,
    });

    expect(snapshot.options.map(({ value, count }) => [value, count])).toEqual([
      [true, 1],
      [false, 1],
    ]);
  });

  it("rebuilds when an equivalent facet value changes its independent display text", () => {
    type DisplayToken = Readonly<{ readonly raw: string }>;
    const displayColumns = compileColumns([
      {
        columnId: "COL_ID_DISPLAY_TOKEN",
        enableSetFilter: true,
        field: "token",
        headerName: "Token",
        valueType: {
          codecId: "test/display-token",
          codecVersion: 1,
          filterFamily: "equality",
          editorFamily: "text",
          cellAlign: "start",
          editorLayout: "inline",
          defaultWidth: 120,
          decodeRuntime: (input: unknown) =>
            typeof input === "object" && input !== null && "raw" in input
              ? ({ _tag: "Success", value: input as DisplayToken } as const)
              : ({ _tag: "Failure", message: "Expected token." } as const),
          equivalent: (left: DisplayToken, right: DisplayToken) =>
            left.raw.toLocaleLowerCase() === right.raw.toLocaleLowerCase(),
          compare: (left: DisplayToken, right: DisplayToken) => {
            const leftCanonical = left.raw.toLocaleLowerCase();
            const rightCanonical = right.raw.toLocaleLowerCase();
            return leftCanonical === rightCanonical ? 0 : leftCanonical < rightCanonical ? -1 : 1;
          },
          formatCanonicalText: (value: DisplayToken) => value.raw.toLocaleLowerCase(),
          parseCanonicalText: (text: string) =>
            ({ _tag: "Success", value: { raw: text } }) as const,
          formatDisplay: (value: DisplayToken) => value.raw,
          encodePersisted: (value: DisplayToken) => value.raw,
          decodePersisted: (input: unknown) =>
            typeof input === "string"
              ? ({ _tag: "Success", value: { raw: input } } as const)
              : ({ _tag: "Failure", message: "Expected token." } as const),
        },
      },
    ]);
    const firstToken = Object.freeze({});
    const secondToken = Object.freeze({});
    const makeRow = (raw: Readonly<{ readonly token: DisplayToken }>) => ({
      raw,
      rowId: "row",
      rowIndex: 0,
      values: {
        read: () => raw.token,
      },
    });
    let rowSnapshot: BrunoTableClientFacetRowsSnapshot = {
      rows: [makeRow({ token: { raw: "a" } })],
      token: firstToken,
      changedIndexes: [],
    };
    let rowListener: (() => void) | undefined;
    const filterCollection = compileClientFilterCollection([], displayColumns);
    const runtime = {
      getQuerySnapshot: () => ({
        columns: displayColumns,
        filters: filterCollection.filters,
        filterCollection,
        quickFilter: "",
        orderBy: [{ columnId: "COL_ID_DISPLAY_TOKEN", direction: "asc" as const }],
        generation: 1,
        navigationMode: "reset" as const,
      }),
      getRowSpaceSnapshot: () => undefined,
      getQuickFilterFieldsSnapshot: () => [],
      subscribeFilter: () => () => undefined,
      subscribeRowSpace: (listener: () => void) => {
        rowListener = listener;
        return () => undefined;
      },
    } as unknown as BrunoTableRowPipelineRuntimeView;
    const store = createBrunoTableClientFacetStore({
      column: displayColumns[0]!,
      rows: { getFacetRowsSnapshot: () => rowSnapshot },
      runtime,
    });
    store.subscribe(() => undefined);
    expect(store.getSnapshot().options[0]?.display).toBe("a");

    rowSnapshot = {
      rows: [makeRow({ token: { raw: "A" } })],
      token: secondToken,
      parentToken: firstToken,
      changedIndexes: [0],
    };
    rowListener?.();
    expect(store.getSnapshot().options[0]?.display).toBe("A");
  });

  it("applies other filters while excluding the current column filter", () => {
    const filterCollection = compileClientFilterCollection(
      [
        { columnId: "COL_ID_ACTIVE", type: "equals", filter: false },
        { columnId: "COL_ID_REGION", type: "equals", filter: "east" },
      ],
      columns,
    );
    const snapshot = createBrunoTableClientFacetSnapshot({
      column: activeColumn,
      columns,
      filterCollection,
      quickFilter: "",
      quickFilterFields: [],
      rows,
      readColumnValue: (column, row) =>
        column.kind === "field" ? row[column.field as keyof Row] : undefined,
      readQuickFilterField: (row, field) => row[field as keyof Row],
    });

    expect(snapshot.options.map(({ value, count }) => [value, count])).toEqual([
      [true, 1],
      [false, 1],
    ]);
  });

  it("retains absent explicit exact values at zero and restores their counts", () => {
    const absent = 9_007_199_254_740_995n;
    const filterCollection = compileClientFilterCollection(
      [{ columnId: "COL_ID_AMOUNT", type: "in", filter: [absent] }],
      columns,
    );
    const snapshot = createBrunoTableClientFacetSnapshot({
      column: amountColumn,
      columns,
      filterCollection,
      quickFilter: "",
      quickFilterFields: [],
      rows,
      readColumnValue: (column, row) =>
        column.kind === "field" ? row[column.field as keyof Row] : undefined,
      readQuickFilterField: (row, field) => row[field as keyof Row],
    });

    expect(snapshot.options.map(({ value, count }) => [value, count])).toEqual([
      [9_007_199_254_740_993n, 2],
      [9_007_199_254_740_994n, 1],
      [absent, 0],
    ]);
    expect(snapshot.intent).toEqual({ kind: "include", values: [absent] });

    const returned = createBrunoTableClientFacetSnapshot({
      column: amountColumn,
      columns,
      filterCollection,
      quickFilter: "",
      quickFilterFields: [],
      rows: [...rows, { active: true, amount: absent, region: "west" }],
      readColumnValue: (column, row) =>
        column.kind === "field" ? row[column.field as keyof Row] : undefined,
      readQuickFilterField: (row, field) => row[field as keyof Row],
    });
    expect(returned.options.at(-1)).toMatchObject({ value: absent, count: 1 });
  });

  it("preserves finite Number values without string or integer coercion", () => {
    type NumberRow = Readonly<{ readonly score: number }>;
    const numberColumns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        enableSetFilter: true,
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    const snapshot = createBrunoTableClientFacetSnapshot<NumberRow>({
      column: numberColumns[0]!,
      columns: numberColumns,
      filterCollection: compileClientFilterCollection([], numberColumns),
      quickFilter: "",
      quickFilterFields: [],
      rows: [{ score: 1.5 }, { score: 2.25 }, { score: 1.5 }],
      readColumnValue: (column, row) =>
        column.kind === "field" ? row[column.field as keyof NumberRow] : undefined,
      readQuickFilterField: () => undefined,
    });

    expect(snapshot.options.map(({ value, count }) => [value, count])).toEqual([
      [1.5, 2],
      [2.25, 1],
    ]);
  });

  it("groups custom values with their compiled equality instead of object identity", () => {
    type Token = Readonly<{ readonly raw: string }>;
    type TokenRow = Readonly<{ readonly token: Token }>;
    const tokenValueType = {
      codecId: "test/token",
      codecVersion: 1,
      filterFamily: "select",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input: unknown) =>
        typeof input === "object" && input !== null && "raw" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
      equivalent: (left: Token, right: Token) =>
        left.raw.toLocaleLowerCase() === right.raw.toLocaleLowerCase(),
      compare: (left: Token, right: Token) => {
        const leftCanonical = left.raw.toLocaleLowerCase();
        const rightCanonical = right.raw.toLocaleLowerCase();
        return leftCanonical === rightCanonical ? 0 : leftCanonical < rightCanonical ? -1 : 1;
      },
      formatCanonicalText: (value: Token) => value.raw.toLocaleLowerCase(),
      parseCanonicalText: (text: string) => ({ _tag: "Success", value: { raw: text } }) as const,
      formatDisplay: (value: Token) => value.raw,
      encodePersisted: (value: Token) => value.raw,
      decodePersisted: (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success", value: { raw: input } } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
    } as const;
    const tokenColumns = compileColumns([
      {
        columnId: "COL_ID_TOKEN",
        enableSetFilter: true,
        field: "token",
        headerName: "Token",
        valueType: tokenValueType,
      },
    ]);
    const tokenColumn = tokenColumns[0]!;
    const absent = Object.freeze({ raw: "B" });
    const collection = compileClientFilterCollection(
      [{ columnId: "COL_ID_TOKEN", type: "in", filter: [absent] }],
      tokenColumns,
    );
    const snapshot = createBrunoTableClientFacetSnapshot<TokenRow>({
      column: tokenColumn,
      columns: tokenColumns,
      filterCollection: collection,
      quickFilter: "",
      quickFilterFields: [],
      rows: [{ token: { raw: "A" } }, { token: { raw: "a" } }],
      readColumnValue: (column, row) =>
        column.kind === "field" ? row[column.field as keyof TokenRow] : undefined,
      readQuickFilterField: () => undefined,
    });

    expect(snapshot.options.map(({ value, count }) => [(value as Token).raw, count])).toEqual([
      ["A", 2],
      ["B", 0],
    ]);
  });
});

function admittedRow(raw: Row, rowIndex: number) {
  return {
    raw,
    rowId: `row-${String(rowIndex)}`,
    rowIndex,
    values: {
      read: vi.fn(
        (nextRaw: unknown, _rowId: unknown, _rowIndex: number, column: (typeof columns)[number]) =>
          column.kind === "field" ? (nextRaw as Row)[column.field as keyof Row] : undefined,
      ),
    },
  };
}
