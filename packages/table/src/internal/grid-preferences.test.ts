import { describe, expect, it, vi } from "vitest";

import type { BrunoTableColumns, BrunoTableJsonValue, BrunoTableValueType } from "../public-types";
import { BrunoTableSelectColumn } from "../column-helpers";
import { compileColumns } from "./compile-columns";
import {
  BRUNO_TABLE_PERSISTED_STATE_VERSION,
  createBrunoTableGridPreferences,
  createBrunoTablePersistedState,
} from "./grid-preferences";
import {
  BRUNO_TABLE_CLIENT_FILTER_MAX_INPUT_ENTRIES,
  BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS,
} from "./grid-query";

const accountEncodePersisted = vi.fn((value: Readonly<{ readonly address: string }>) => ({
  account: value.address,
}));

const accountValueType: BrunoTableValueType<
  Readonly<{ readonly address: string }>,
  "equality",
  "text",
  {}
> = Object.freeze({
  codecId: "test/account",
  codecVersion: 3,
  filterFamily: "equality",
  editorFamily: "text",
  cellAlign: "start",
  editorLayout: "inline",
  defaultWidth: 180,
  decodeRuntime: (input) =>
    typeof input === "object" && input !== null && "address" in input
      ? { _tag: "Success", value: { address: String(input.address) } }
      : { _tag: "Failure", message: "Expected account." },
  equivalent: (left, right) => left.address === right.address,
  compare: (left, right) =>
    left.address === right.address ? 0 : left.address < right.address ? -1 : 1,
  formatCanonicalText: (value) => value.address,
  parseCanonicalText: (text) => ({ _tag: "Success", value: { address: text } }),
  formatDisplay: (value) => value.address,
  encodePersisted: accountEncodePersisted,
  decodePersisted: (input) =>
    typeof input === "object" &&
    input !== null &&
    "account" in input &&
    typeof input.account === "string"
      ? { _tag: "Success", value: { address: input.account } }
      : { _tag: "Failure", message: "Invalid persisted account." },
});

function isStringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((value) => typeof value === "string");
}

const stringTupleValueType: BrunoTableValueType<readonly string[], "equality", "text", {}> =
  Object.freeze({
    codecId: "test/string-tuple",
    codecVersion: 1,
    filterFamily: "equality",
    editorFamily: "text",
    cellAlign: "start",
    editorLayout: "inline",
    defaultWidth: 160,
    decodeRuntime: (input) =>
      isStringArray(input)
        ? { _tag: "Success", value: Object.freeze(Array.from(input)) }
        : { _tag: "Failure", message: "Expected a string tuple." },
    equivalent: (left, right) =>
      left.length === right.length && left.every((value, index) => value === right[index]),
    compare: (left, right) => {
      const leftText = JSON.stringify(left);
      const rightText = JSON.stringify(right);
      return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
    },
    formatCanonicalText: (value) => JSON.stringify(value),
    parseCanonicalText: (text) => {
      try {
        const parsed: unknown = JSON.parse(text);
        return isStringArray(parsed)
          ? { _tag: "Success", value: Object.freeze(Array.from(parsed)) }
          : { _tag: "Failure", message: "Expected a string tuple." };
      } catch {
        return { _tag: "Failure", message: "Expected a string tuple." };
      }
    },
    formatDisplay: (value) => value.join(", "),
    encodePersisted: (value) => Object.freeze(Array.from(value)),
    decodePersisted: (input) =>
      isStringArray(input)
        ? { _tag: "Success", value: Object.freeze(Array.from(input)) }
        : { _tag: "Failure", message: "Expected a persisted string tuple." },
  });

type PreferenceRow = Readonly<{
  name: string;
  quantity: bigint;
  account: Readonly<{ readonly address: string }>;
  status: "open" | "closed";
  score: number;
}>;

const columnDefinitions = [
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
    width: 120,
    pinned: "start",
  },
  {
    columnId: "COL_ID_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
    valueType: "bigint",
    width: 140,
  },
  {
    columnId: "COL_ID_ACCOUNT",
    field: "account",
    headerName: "Account",
    valueType: accountValueType,
    width: 180,
  },
  BrunoTableSelectColumn({
    columnId: "COL_ID_STATUS",
    field: "status",
    headerName: "Status",
    options: ["open", "closed"] as const,
  }),
  {
    columnId: "COL_ID_SCORE",
    field: "score",
    headerName: "Score",
    valueType: "number",
    width: 140,
  },
] satisfies BrunoTableColumns<PreferenceRow>;

const columns = compileColumns(columnDefinitions);

const initialOrderBy = Object.freeze([
  Object.freeze({ columnId: "COL_ID_NAME", direction: "asc" as const }),
]);

describe("Grid Preferences", () => {
  it("round-trips native exact operands through the compiled codec and JSON", () => {
    const preferences = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_ORDERS",
      columns,
      initialFilters: [
        { columnId: "COL_ID_QUANTITY", type: "greaterThan", filter: 9_007_199_254_740_993n },
        { columnId: "COL_ID_ACCOUNT", type: "equals", filter: { address: "acct-42" } },
        { columnId: "COL_ID_STATUS", type: "equals", filter: "closed" },
        { columnId: "COL_ID_SCORE", type: "equals", filter: 1e21 },
      ],
      initialOrderBy,
    });

    const snapshot = createBrunoTablePersistedState(preferences);
    const json = JSON.stringify(snapshot);
    expect(json).toContain('"codecId":"@bruno/table/bigint"');
    expect(json).toContain('"value":"9007199254740993"');
    expect(json).toContain('"codecId":"test/account"');
    expect(json).toContain('"codecId":"@bruno/table/select"');
    expect(json).toContain('"codecId":"@bruno/table/number"');
    expect(json).toContain('"value":"1e+21"');

    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_ORDERS",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: JSON.parse(json),
    });
    expect(restored.filters).toEqual([
      { columnId: "COL_ID_QUANTITY", type: "greaterThan", filter: 9_007_199_254_740_993n },
      { columnId: "COL_ID_ACCOUNT", type: "equals", filter: { address: "acct-42" } },
      { columnId: "COL_ID_STATUS", type: "equals", filter: "closed" },
      { columnId: "COL_ID_SCORE", type: "equals", filter: 1e21 },
    ]);
  });

  it("round-trips a scalar array-valued custom operand without treating it as in", () => {
    const tupleColumns = compileColumns([
      {
        columnId: "COL_ID_TAGS",
        field: "tags",
        headerName: "Tags",
        valueType: stringTupleValueType,
      },
    ]);
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_ARRAY_OPERAND",
        columns: tupleColumns,
        initialFilters: [{ columnId: "COL_ID_TAGS", type: "equals", filter: ["exact", "tuple"] }],
        initialOrderBy: [{ columnId: "COL_ID_TAGS", direction: "asc" }],
      }),
    );
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_ARRAY_OPERAND",
      columns: tupleColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_TAGS", direction: "asc" }],
      initialPersistedState: JSON.parse(JSON.stringify(snapshot)),
    });

    expect(restored.filters).toEqual([
      { columnId: "COL_ID_TAGS", type: "equals", filter: ["exact", "tuple"] },
    ]);
  });

  it("prunes restored Set Filter leaves when the capability is no longer supported", () => {
    const persistedColumns = compileColumns([
      {
        columnId: "COL_ID_ACCOUNT",
        field: "account",
        headerName: "Account",
        valueType: accountValueType,
        enableSetFilter: true,
      },
    ]);
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_REMOVED_SET_FILTER",
        columns: persistedColumns,
        initialFilters: [
          {
            type: "AND",
            conditions: [
              { columnId: "COL_ID_ACCOUNT", type: "matchNone" },
              { columnId: "COL_ID_ACCOUNT", type: "in", filter: [{ address: "acct-42" }] },
              { columnId: "COL_ID_ACCOUNT", type: "blank" },
            ],
          },
        ],
        initialOrderBy,
      }),
    );
    const currentColumns = compileColumns([
      {
        columnId: "COL_ID_ACCOUNT",
        field: "account",
        headerName: "Account",
        valueType: accountValueType,
        enableSetFilter: false,
      },
    ]);
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_REMOVED_SET_FILTER",
      columns: currentColumns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: snapshot,
    });

    expect(restored.filters).toEqual([{ columnId: "COL_ID_ACCOUNT", type: "blank" }]);
  });

  it("persists custom text-search operands as raw bounded strings", () => {
    type SearchValue = Readonly<{ readonly text: string }>;
    const encodePersisted = vi.fn((value: SearchValue) => ({ text: value.text }));
    const valueType: BrunoTableValueType<SearchValue, "text", "text"> = {
      codecId: "test/object-text",
      codecVersion: 1,
      filterFamily: "text",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 160,
      decodeRuntime: (input) =>
        typeof input === "object" && input !== null && "text" in input
          ? { _tag: "Success", value: { text: String(input.text) } }
          : { _tag: "Failure", message: "Expected object text." },
      equivalent: (left, right) => left.text === right.text,
      compare: (left, right) => (left.text === right.text ? 0 : left.text < right.text ? -1 : 1),
      formatCanonicalText: (value) => value.text,
      parseCanonicalText: (text) => ({ _tag: "Success", value: { text } }),
      formatDisplay: (value) => value.text,
      encodePersisted,
      decodePersisted: (input) =>
        typeof input === "object" && input !== null && "text" in input
          ? { _tag: "Success", value: { text: String(input.text) } }
          : { _tag: "Failure", message: "Expected persisted object text." },
    };
    const searchColumns = compileColumns([
      {
        columnId: "COL_ID_SEARCH",
        field: "account",
        headerName: "Search",
        valueType,
      },
    ]);
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_OBJECT_TEXT_SEARCH",
        columns: searchColumns,
        initialFilters: [
          { columnId: "COL_ID_SEARCH", type: "contains", filter: "needle", caseSensitive: true },
        ],
        initialOrderBy: [{ columnId: "COL_ID_SEARCH", direction: "asc" }],
      }),
    );
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_OBJECT_TEXT_SEARCH",
      columns: searchColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_SEARCH", direction: "asc" }],
      initialPersistedState: JSON.parse(JSON.stringify(snapshot)),
    });

    expect(encodePersisted).not.toHaveBeenCalled();
    expect(restored.filters).toEqual([
      { columnId: "COL_ID_SEARCH", type: "contains", filter: "needle", caseSensitive: true },
    ]);
  });

  it("rejects over-budget persisted strings before invoking exact codecs", () => {
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_OVERSIZED_PERSISTED_STRING",
        columns,
        initialFilters: [{ columnId: "COL_ID_QUANTITY", type: "equals", filter: 1n }],
        initialOrderBy,
      }),
    );
    const filters = snapshot["filters"];
    const filter = Array.isArray(filters) ? filters[0] : undefined;
    if (typeof filter !== "object" || filter === null) {
      throw new TypeError("Expected one persisted BigInt filter.");
    }
    const operand = filter["filter"];
    if (typeof operand !== "object" || operand === null) {
      throw new TypeError("Expected one tagged persisted BigInt operand.");
    }
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_OVERSIZED_PERSISTED_STRING",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        ...snapshot,
        filters: [
          {
            ...filter,
            filter: {
              ...operand,
              value: "9".repeat(1_048_577),
            },
          },
        ],
      },
    });

    expect(restored.filters).toEqual([]);
  });

  it("rejects unsupported sensitivity evidence on numeric filters", () => {
    const numericSnapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_UNSUPPORTED_SENSITIVITY",
        columns,
        initialFilters: [{ columnId: "COL_ID_QUANTITY", type: "equals", filter: 1n }],
        initialOrderBy,
      }),
    );
    const numericFilters = numericSnapshot["filters"];
    const numericFilter = Array.isArray(numericFilters) ? numericFilters[0] : undefined;
    if (typeof numericFilter !== "object" || numericFilter === null) {
      throw new TypeError("Expected one persisted numeric filter.");
    }
    const unsupported = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_UNSUPPORTED_SENSITIVITY",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        ...numericSnapshot,
        filters: [{ ...numericFilter, caseSensitive: false }],
      },
    });
    expect(unsupported.filters).toEqual([]);
  });

  it("rejects malformed persisted text-sensitivity flags", () => {
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_MALFORMED_SENSITIVITY",
        columns,
        initialFilters: [
          { columnId: "COL_ID_NAME", type: "equals", filter: "Ada", caseSensitive: true },
        ],
        initialOrderBy,
      }),
    );
    const filters = snapshot["filters"];
    const filter = Array.isArray(filters) ? filters[0] : undefined;
    if (typeof filter !== "object" || filter === null) {
      throw new TypeError("Expected one persisted text filter.");
    }
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_MALFORMED_SENSITIVITY",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        ...snapshot,
        filters: [{ ...filter, caseSensitive: "true", accentSensitive: 1 }],
      },
    });

    expect(restored.filters).toEqual([]);
  });

  it("preserves an own __proto__ key in a custom JSON-safe codec payload", () => {
    const protoValueType: BrunoTableValueType<string, "equality", "text"> = Object.freeze({
      ...accountValueType,
      codecId: "test/proto-key",
      codecVersion: 1,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value,
      encodePersisted: (value) => JSON.parse(`{"__proto__":{"value":${JSON.stringify(value)}}}`),
      decodePersisted: (input) => {
        const descriptor =
          typeof input === "object" && input !== null
            ? Object.getOwnPropertyDescriptor(input, "__proto__")
            : undefined;
        const payload = descriptor?.value;
        return typeof payload === "object" && payload !== null && "value" in payload
          ? { _tag: "Success", value: String(payload.value) }
          : { _tag: "Failure", message: "Expected an own __proto__ payload." };
      },
    });
    const protoColumns = compileColumns([
      {
        columnId: "COL_ID_PROTO",
        field: "name",
        headerName: "Proto",
        valueType: protoValueType,
      },
    ]);
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_PROTO",
        columns: protoColumns,
        initialFilters: [{ columnId: "COL_ID_PROTO", type: "equals", filter: "exact" }],
        initialOrderBy: [{ columnId: "COL_ID_PROTO", direction: "asc" }],
      }),
    );

    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_PROTO",
      columns: protoColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_PROTO", direction: "asc" }],
      initialPersistedState: JSON.parse(JSON.stringify(snapshot)),
    });
    expect(restored.filters).toEqual([
      { columnId: "COL_ID_PROTO", type: "equals", filter: "exact" },
    ]);
  });

  it("drops incompatible versions, table identities, codecs, operators, and malformed entries", () => {
    const baseline = [{ columnId: "COL_ID_NAME", type: "equals", filter: "baseline" }];
    const valid = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_ORDERS",
        columns,
        initialFilters: [{ columnId: "COL_ID_QUANTITY", type: "equals", filter: 42n }],
        initialOrderBy,
      }),
    );

    for (const candidate of [
      { ...valid, version: BRUNO_TABLE_PERSISTED_STATE_VERSION + 1 },
      { ...valid, tableId: "TABLE_ID_OTHER" },
      null,
      [],
    ]) {
      const restored = createBrunoTableGridPreferences({
        tableId: "TABLE_ID_ORDERS",
        columns,
        initialFilters: baseline,
        initialOrderBy,
        initialPersistedState: candidate,
      });
      expect(restored.filters).toEqual(baseline);
    }

    const validFilters = valid["filters"];
    expect(Array.isArray(validFilters)).toBe(true);
    const filter = Array.isArray(validFilters) ? validFilters[0] : undefined;
    expect(filter).toBeDefined();
    for (const tampered of [
      { ...filter, codecId: "test/stale" },
      { ...filter, codecVersion: 999 },
      { ...filter, type: "contains" },
      { ...filter, columnId: "COL_ID_REMOVED" },
      { ...filter, filter: { $brunoTableValue: "bigint", version: 1, value: "1.5" } },
    ]) {
      const restored = createBrunoTableGridPreferences({
        tableId: "TABLE_ID_ORDERS",
        columns,
        initialFilters: baseline,
        initialOrderBy,
        initialPersistedState: { ...valid, filters: [tampered] },
      });
      expect(restored.filters).toEqual([]);
    }

    const hostileLayout = {
      ...valid,
      columnWidths: Object.defineProperty({}, "COL_ID_NAME", {
        enumerable: true,
        get: () => {
          throw new Error("hostile width getter");
        },
      }),
    };
    expect(() =>
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_ORDERS",
        columns,
        initialFilters: baseline,
        initialOrderBy,
        initialPersistedState: hostileLayout,
      }),
    ).not.toThrow();
  });

  it("retains baselines for malformed preference slices and bounds hostile filter input", () => {
    const baselineFilters = [{ columnId: "COL_ID_NAME", type: "equals", filter: "baseline" }];
    const baseline = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_ORDERS",
        columns,
        initialFilters: [],
        initialOrderBy,
      }),
    );
    const invalidFilters = Object.defineProperty([], 0, {
      enumerable: true,
      get: () => {
        throw new Error("hostile persisted filter getter");
      },
    });
    Reflect.set(invalidFilters, "length", 1);

    for (const filters of [
      {},
      invalidFilters,
      Array.from({ length: BRUNO_TABLE_CLIENT_FILTER_MAX_INPUT_ENTRIES + 1 }, () => null),
    ]) {
      const restored = createBrunoTableGridPreferences({
        tableId: "TABLE_ID_ORDERS",
        columns,
        initialFilters: baselineFilters,
        initialOrderBy,
        initialPersistedState: { ...baseline, filters },
      });
      expect(restored.filters).toEqual(baselineFilters);
    }
  });

  it("rejects root snapshot accessors without invoking them", () => {
    const versionGetter = vi.fn(() => BRUNO_TABLE_PERSISTED_STATE_VERSION);
    const hostileRoot = Object.defineProperties(
      {},
      {
        version: { enumerable: true, get: versionGetter },
        tableId: { enumerable: true, value: "TABLE_ID_ORDERS" },
      },
    );
    const baselineFilters = [{ columnId: "COL_ID_NAME", type: "equals", filter: "baseline" }];

    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_ORDERS",
      columns,
      initialFilters: baselineFilters,
      initialOrderBy,
      initialPersistedState: hostileRoot,
    });

    expect(versionGetter).not.toHaveBeenCalled();
    expect(restored.filters).toEqual(baselineFilters);
  });

  it("captures only known persisted fields without enumerating irrelevant record keys", () => {
    const baseline = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_BOUNDED_RECORDS",
        columns,
        initialFilters: [],
        initialOrderBy,
      }),
    );
    const visibilityOwnKeys = vi.fn(() => {
      throw new Error("must not enumerate persisted visibility");
    });
    const rootOwnKeys = vi.fn(() => {
      throw new Error("must not enumerate the persisted root");
    });
    const visibility = new Proxy(
      { COL_ID_NAME: false, irrelevant: "ignored" },
      { ownKeys: visibilityOwnKeys },
    );
    const root = new Proxy(
      { ...baseline, columnVisibility: visibility, irrelevant: "ignored" },
      { ownKeys: rootOwnKeys },
    );

    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_BOUNDED_RECORDS",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: root,
    });

    expect(rootOwnKeys).not.toHaveBeenCalled();
    expect(visibilityOwnKeys).not.toHaveBeenCalled();
    expect(restored.columnLayout.visibleColumnIds).not.toContain("COL_ID_NAME");
  });

  it("rejects accessor-backed persisted sorting without invoking it", () => {
    const directionGetter = vi.fn(() => "desc" as const);
    const hostileSort = Object.defineProperties(
      {},
      {
        columnId: { enumerable: true, value: "COL_ID_QUANTITY" },
        direction: { enumerable: true, get: directionGetter },
      },
    );
    const baseline = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_HOSTILE_SORT",
        columns,
        initialFilters: [],
        initialOrderBy,
      }),
    );

    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_HOSTILE_SORT",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: { ...baseline, orderBy: [hostileSort] },
    });

    expect(directionGetter).not.toHaveBeenCalled();
    expect(restored.orderBy).toEqual(initialOrderBy);

    const entryGetter = vi.fn(() => ({ columnId: "COL_ID_QUANTITY", direction: "desc" }));
    const hostileOrder = Object.defineProperty([], 0, {
      enumerable: true,
      get: entryGetter,
    });
    Reflect.set(hostileOrder, "length", 1);
    const restoredArray = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_HOSTILE_SORT",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: { ...baseline, orderBy: hostileOrder },
    });
    expect(entryGetter).not.toHaveBeenCalled();
    expect(restoredArray.orderBy).toEqual(initialOrderBy);
  });

  it("preserves valid siblings when a compound persisted filter leaf becomes stale", () => {
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_STALE_COMPOUND_LEAF",
        columns,
        initialFilters: [
          {
            type: "AND",
            conditions: [
              { columnId: "COL_ID_ACCOUNT", type: "blank" },
              { columnId: "COL_ID_ACCOUNT", type: "equals", filter: { address: "acct-42" } },
            ],
          },
        ],
        initialOrderBy,
      }),
    );
    const persistedFilters = snapshot["filters"];
    const compound = Array.isArray(persistedFilters) ? persistedFilters[0] : undefined;
    if (typeof compound !== "object" || compound === null || !("conditions" in compound)) {
      throw new TypeError("Expected one persisted compound filter.");
    }
    const conditions = compound.conditions;
    if (!Array.isArray(conditions) || typeof conditions[1] !== "object" || conditions[1] === null) {
      throw new TypeError("Expected two persisted compound conditions.");
    }
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_STALE_COMPOUND_LEAF",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        ...snapshot,
        filters: [
          {
            ...compound,
            conditions: [conditions[0], { ...conditions[1], codecVersion: 999 }],
          },
        ],
      },
    });

    expect(restored.filters).toEqual([{ columnId: "COL_ID_ACCOUNT", type: "blank" }]);
  });

  it("prunes an empty persisted in leaf while preserving its valid compound sibling", () => {
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_EMPTY_IN_COMPOUND_LEAF",
        columns,
        initialFilters: [
          {
            type: "AND",
            conditions: [
              { columnId: "COL_ID_STATUS", type: "blank" },
              { columnId: "COL_ID_STATUS", type: "in", filter: ["open"] },
            ],
          },
        ],
        initialOrderBy,
      }),
    );
    const persistedFilters = snapshot["filters"];
    const compound = Array.isArray(persistedFilters) ? persistedFilters[0] : undefined;
    if (typeof compound !== "object" || compound === null || !("conditions" in compound)) {
      throw new TypeError("Expected one persisted compound filter.");
    }
    const conditions = compound.conditions;
    if (!Array.isArray(conditions) || typeof conditions[1] !== "object" || conditions[1] === null) {
      throw new TypeError("Expected two persisted compound conditions.");
    }

    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_EMPTY_IN_COMPOUND_LEAF",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        ...snapshot,
        filters: [
          {
            ...compound,
            conditions: [conditions[0], { ...conditions[1], filter: [] }],
          },
        ],
      },
    });

    expect(restored.filters).toEqual([{ columnId: "COL_ID_STATUS", type: "blank" }]);
  });

  it("prunes persisted search leaves that normalize empty while preserving their sibling", () => {
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_EMPTY_SEARCH_COMPOUND_LEAF",
        columns,
        initialFilters: [
          {
            type: "AND",
            conditions: [
              { columnId: "COL_ID_NAME", type: "blank" },
              { columnId: "COL_ID_NAME", type: "contains", filter: "open" },
            ],
          },
        ],
        initialOrderBy,
      }),
    );
    const persistedFilters = snapshot["filters"];
    const compound = Array.isArray(persistedFilters) ? persistedFilters[0] : undefined;
    if (typeof compound !== "object" || compound === null || !("conditions" in compound)) {
      throw new TypeError("Expected one persisted compound filter.");
    }
    const conditions = compound.conditions;
    if (!Array.isArray(conditions) || typeof conditions[1] !== "object" || conditions[1] === null) {
      throw new TypeError("Expected two persisted compound conditions.");
    }

    for (const filter of ["", "\u0301"]) {
      const restored = createBrunoTableGridPreferences({
        tableId: "TABLE_ID_EMPTY_SEARCH_COMPOUND_LEAF",
        columns,
        initialFilters: [],
        initialOrderBy,
        initialPersistedState: {
          ...snapshot,
          filters: [
            {
              ...compound,
              conditions: [conditions[0], { ...conditions[1], filter }],
            },
          ],
        },
      });

      expect(restored.filters).toEqual([{ columnId: "COL_ID_NAME", type: "blank" }]);
    }
  });

  it("prunes codec-decodable leaves that fail current value semantics", () => {
    const rangeSnapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_STALE_RANGE_LEAF",
        columns,
        initialFilters: [
          {
            type: "AND",
            conditions: [
              { columnId: "COL_ID_SCORE", type: "blank" },
              { columnId: "COL_ID_SCORE", type: "inRange", filter: 1, filterTo: 2 },
            ],
          },
        ],
        initialOrderBy,
      }),
    );
    const rangeFilters = rangeSnapshot["filters"];
    const rangeCompound = Array.isArray(rangeFilters) ? rangeFilters[0] : undefined;
    if (
      typeof rangeCompound !== "object" ||
      rangeCompound === null ||
      !("conditions" in rangeCompound) ||
      !Array.isArray(rangeCompound.conditions) ||
      typeof rangeCompound.conditions[1] !== "object" ||
      rangeCompound.conditions[1] === null ||
      !("filterTo" in rangeCompound.conditions[1]) ||
      typeof rangeCompound.conditions[1].filterTo !== "object" ||
      rangeCompound.conditions[1].filterTo === null
    ) {
      throw new TypeError("Expected one persisted range compound.");
    }
    const restoredRange = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_STALE_RANGE_LEAF",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        ...rangeSnapshot,
        filters: [
          {
            ...rangeCompound,
            conditions: [
              rangeCompound.conditions[0],
              {
                ...rangeCompound.conditions[1],
                filterTo: { ...rangeCompound.conditions[1].filterTo, value: "1" },
              },
            ],
          },
        ],
      },
    });
    expect(restoredRange.filters).toEqual([{ columnId: "COL_ID_SCORE", type: "blank" }]);

    const selectSnapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_STALE_SELECT_LEAF",
        columns,
        initialFilters: [
          {
            type: "AND",
            conditions: [
              { columnId: "COL_ID_STATUS", type: "blank" },
              { columnId: "COL_ID_STATUS", type: "equals", filter: "open" },
            ],
          },
        ],
        initialOrderBy,
      }),
    );
    const currentSelectColumns = compileColumns([
      BrunoTableSelectColumn({
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        options: ["closed"] as const,
      }),
    ] satisfies BrunoTableColumns<Readonly<{ status: "closed" }>>);
    const restoredSelect = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_STALE_SELECT_LEAF",
      columns: currentSelectColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_STATUS", direction: "asc" }],
      initialPersistedState: selectSnapshot,
    });
    expect(restoredSelect.filters).toEqual([{ columnId: "COL_ID_STATUS", type: "blank" }]);
  });

  it("shares one semantic comparison allowance across restored leaves", () => {
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
      codecId: "test/persisted-shared-equivalence-budget",
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
      encodePersisted: (value: unknown) => ({ code: String(Reflect.get(value as object, "code")) }),
      decodePersisted: (input: unknown) => ({ _tag: "Success" as const, value: input }),
    } as const;
    const selectColumns = compileColumns([
      {
        columnId: "COL_ID_BOUNDED_SELECT",
        field: "status",
        headerName: "Status",
        valueType: selectValueType,
        options,
      } as never,
    ]);
    const baseline = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_BOUNDED_SELECT",
        columns: selectColumns,
        initialFilters: [],
        initialOrderBy: [{ columnId: "COL_ID_BOUNDED_SELECT", direction: "asc" }],
      }),
    );
    const staleLeaves = Array.from(
      { length: BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS / options.length + 4 },
      (_, index) => ({
        columnId: "COL_ID_BOUNDED_SELECT",
        type: "equals",
        codecId: selectValueType.codecId,
        codecVersion: selectValueType.codecVersion,
        filter: { code: `missing-${String(index)}` },
      }),
    );
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_BOUNDED_SELECT",
      columns: selectColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_BOUNDED_SELECT", direction: "asc" }],
      initialPersistedState: {
        ...baseline,
        filters: [
          {
            type: "AND",
            conditions: [...staleLeaves, { columnId: "COL_ID_BOUNDED_SELECT", type: "blank" }],
          },
        ],
      },
    });

    expect(restored.filters).toEqual([{ columnId: "COL_ID_BOUNDED_SELECT", type: "blank" }]);
    expect(equivalent).toHaveBeenCalledTimes(BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS);
  });

  it("rejects accessor-backed persisted codec operands without invoking them", () => {
    const valid = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_HOSTILE_OPERAND",
        columns,
        initialFilters: [{ columnId: "COL_ID_QUANTITY", type: "equals", filter: 42n }],
        initialOrderBy,
      }),
    );
    const filters = valid["filters"];
    const validFilter = Array.isArray(filters) ? filters[0] : undefined;
    if (typeof validFilter !== "object" || validFilter === null) {
      throw new TypeError("Expected one persisted bigint filter.");
    }
    const valueGetter = vi.fn(() => "42");
    const hostileOperand = Object.defineProperties(
      {},
      {
        $brunoTableValue: { enumerable: true, value: "bigint" },
        version: { enumerable: true, value: 1 },
        value: { enumerable: true, get: valueGetter },
      },
    );
    const cases = [
      { ...validFilter, filter: hostileOperand },
      { ...validFilter, type: "in", filter: [hostileOperand] },
      { ...validFilter, type: "inRange", filterTo: hostileOperand },
    ];

    for (const filter of cases) {
      const restored = createBrunoTableGridPreferences({
        tableId: "TABLE_ID_HOSTILE_OPERAND",
        columns,
        initialFilters: [],
        initialOrderBy,
        initialPersistedState: { ...valid, filters: [filter] },
      });
      expect(restored.filters).toEqual([]);
    }
    expect(valueGetter).not.toHaveBeenCalled();
  });

  it("does not install an order override for an absent or malformed persisted order", () => {
    const baseline = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_ORDER_BASELINE",
        columns,
        initialFilters: [],
        initialOrderBy,
      }),
    );
    for (const columnOrder of [undefined, {}]) {
      const restored = createBrunoTableGridPreferences({
        tableId: "TABLE_ID_ORDER_BASELINE",
        columns,
        initialFilters: [],
        initialOrderBy,
        initialPersistedState: { ...baseline, columnOrder },
      });
      expect(restored.columnLayout.orderOverride).toBeUndefined();
    }
  });

  it("bounds hostile persisted column-order traversal before reading entries", () => {
    let descriptorCalls = 0;
    let lengthReads = 0;
    const overlongOrder = new Proxy(
      Array.from({ length: 10_000 }, () => "COL_ID_REMOVED"),
      {
        get: (target, key, receiver) => {
          if (key !== "length") return Reflect.get(target, key, receiver);
          lengthReads += 1;
          return lengthReads === 1 ? 10_000 : 0;
        },
        getOwnPropertyDescriptor: (target, key) => {
          descriptorCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_BOUNDED_LAYOUT",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        version: BRUNO_TABLE_PERSISTED_STATE_VERSION,
        tableId: "TABLE_ID_BOUNDED_LAYOUT",
        filters: [],
        orderBy: initialOrderBy,
        groupBy: [],
        groupOrderBy: [],
        columnOrder: overlongOrder,
        columnVisibility: {},
        columnWidths: {},
        columnPinning: { start: [], end: [] },
      },
    });

    expect(descriptorCalls).toBe(0);
    expect(lengthReads).toBe(1);
    expect(restored.columnLayout.orderOverride).toBeUndefined();

    const negativeLengthOrder = new Proxy([], {
      get: (target, key, receiver) => (key === "length" ? -1 : Reflect.get(target, key, receiver)),
    });
    const negativeLength = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_BOUNDED_LAYOUT",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        version: BRUNO_TABLE_PERSISTED_STATE_VERSION,
        tableId: "TABLE_ID_BOUNDED_LAYOUT",
        filters: [],
        orderBy: initialOrderBy,
        groupBy: [],
        groupOrderBy: [],
        columnOrder: negativeLengthOrder,
        columnVisibility: {},
        columnWidths: {},
        columnPinning: { start: [], end: [] },
      },
    });
    expect(negativeLength.columnLayout.orderOverride).toBeUndefined();
  });

  it("drops malformed pinning and stale widths instead of coercing them", () => {
    const baseline = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_ORDERS",
        columns,
        initialFilters: [],
        initialOrderBy,
      }),
    );
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_ORDERS",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        ...baseline,
        columnWidths: { COL_ID_NAME: 2, COL_ID_QUANTITY: 140.5 },
        columnPinning: { start: null, end: null },
      },
    });
    const snapshot = createBrunoTablePersistedState(restored);
    expect(snapshot["columnWidths"]).toEqual({});
    expect(snapshot["columnPinning"]).toEqual({ start: ["COL_ID_NAME"], end: [] });
  });

  it("keeps baseline pinning for a column introduced after the snapshot", () => {
    const oldColumns = compileColumns([
      {
        columnId: "COL_ID_EXISTING",
        field: "name",
        headerName: "Existing",
        valueType: "text",
        pinned: "start",
      },
    ]);
    const oldSnapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_COLUMN_ADDITION",
        columns: oldColumns,
        initialFilters: [],
        initialOrderBy: [{ columnId: "COL_ID_EXISTING", direction: "asc" }],
      }),
    );
    const currentColumns = compileColumns([
      {
        columnId: "COL_ID_EXISTING",
        field: "name",
        headerName: "Existing",
        valueType: "text",
        pinned: "start",
      },
      {
        columnId: "COL_ID_NEW",
        field: "name",
        headerName: "New",
        valueType: "text",
        pinned: "end",
      },
    ]);
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_COLUMN_ADDITION",
      columns: currentColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_EXISTING", direction: "asc" }],
      initialPersistedState: {
        ...oldSnapshot,
        columnPinning: { start: [], end: [] },
      },
    });

    expect(createBrunoTablePersistedState(restored)["columnPinning"]).toEqual({
      start: [],
      end: ["COL_ID_NEW"],
    });
  });

  it("restores valid preferences, falls back from an empty sanitized order, and drops grouping", () => {
    const persisted = {
      version: BRUNO_TABLE_PERSISTED_STATE_VERSION,
      tableId: "TABLE_ID_ORDERS",
      filters: [],
      orderBy: [{ columnId: "COL_ID_REMOVED", direction: "desc" }],
      groupBy: ["COL_ID_NAME"],
      groupOrderBy: [{ columnId: "COL_ID_NAME", direction: "desc" }],
      columnOrder: [
        "COL_ID_ACCOUNT",
        "COL_ID_NAME",
        "COL_ID_QUANTITY",
        "COL_ID_STATUS",
        "COL_ID_SCORE",
      ],
      columnVisibility: {
        COL_ID_NAME: false,
        COL_ID_QUANTITY: true,
        COL_ID_ACCOUNT: true,
        COL_ID_STATUS: true,
        COL_ID_SCORE: true,
      },
      columnWidths: { COL_ID_QUANTITY: 333, COL_ID_REMOVED: 999 },
      columnPinning: { start: ["COL_ID_ACCOUNT"], end: ["COL_ID_QUANTITY"] },
    };
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_ORDERS",
      columns,
      initialFilters: [{ columnId: "COL_ID_NAME", type: "equals", filter: "baseline" }],
      initialOrderBy,
      initialPersistedState: persisted,
    });

    expect(restored.orderBy).toEqual(initialOrderBy);
    expect(restored.groupBy).toEqual([]);
    expect(restored.groupOrderBy).toEqual([]);
    const snapshot = createBrunoTablePersistedState(restored);
    expect(snapshot["columnOrder"]).toEqual([
      "COL_ID_ACCOUNT",
      "COL_ID_NAME",
      "COL_ID_QUANTITY",
      "COL_ID_STATUS",
      "COL_ID_SCORE",
    ]);
    expect(snapshot["columnVisibility"]).toEqual({
      COL_ID_ACCOUNT: true,
      COL_ID_NAME: false,
      COL_ID_QUANTITY: true,
      COL_ID_STATUS: true,
      COL_ID_SCORE: true,
    });
    expect(snapshot["columnWidths"]).toEqual({
      COL_ID_QUANTITY: 333,
    });
    expect(snapshot["columnPinning"]).toEqual({
      start: ["COL_ID_ACCOUNT"],
      end: ["COL_ID_QUANTITY"],
    });
  });

  it("persists only durable width overrides and retains an explicit baseline-equal width", () => {
    const pristine = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_WIDTH_INTENT",
      columns,
      initialFilters: [],
      initialOrderBy,
    });
    expect(createBrunoTablePersistedState(pristine)["columnWidths"]).toEqual({});

    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_WIDTH_INTENT",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        ...createBrunoTablePersistedState(pristine),
        columnWidths: { COL_ID_NAME: 120 },
      },
    });
    expect(createBrunoTablePersistedState(restored)["columnWidths"]).toEqual({
      COL_ID_NAME: 120,
    });
  });

  it("drops the reserved Rows width when the Client has no grouping capability", () => {
    const pristine = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_ROWS_WIDTH",
      columns,
      initialFilters: [],
      initialOrderBy,
    });
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_ROWS_WIDTH",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: {
        ...createBrunoTablePersistedState(pristine),
        columnWidths: { COL_ID_NAME: 222, COL_ID_BRUNO_TABLE_ROWS: 333 },
      },
    });

    expect(createBrunoTablePersistedState(restored)["columnWidths"]).toEqual({
      COL_ID_NAME: 222,
    });
  });

  it("sanitizes and restores Client grouping, grouped sorting, and dormant Rows width", () => {
    const groupingColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "name",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        headerName: "Quantity",
        valueType: "bigint",
        aggFunc: "sum",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
        aggFunc: "max",
      },
    ]);
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_GROUPING",
      columns: groupingColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      grouping: true,
      initialPersistedState: {
        version: 1,
        tableId: "TABLE_ID_GROUPING",
        filters: [],
        orderBy: [{ columnId: "COL_ID_DESK", direction: "desc" }],
        groupBy: ["COL_ID_UNKNOWN", "COL_ID_DESK", "COL_ID_DESK"],
        groupOrderBy: [
          { columnId: "COL_ID_UNKNOWN", direction: "asc" },
          { columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "desc" },
          { columnId: "COL_ID_QUANTITY", direction: "asc" },
          { columnId: "COL_ID_SCORE", direction: "asc" },
          { columnId: "COL_ID_DESK", direction: "sideways" },
        ],
        columnOrder: ["COL_ID_DESK", "COL_ID_QUANTITY", "COL_ID_SCORE"],
        columnVisibility: { COL_ID_SCORE: false },
        columnWidths: { COL_ID_BRUNO_TABLE_ROWS: 333 },
        columnPinning: { start: ["COL_ID_DESK"], end: [] },
      },
    });

    expect(restored.groupBy).toEqual(["COL_ID_DESK"]);
    expect(restored.groupOrderBy).toEqual([
      { columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "desc" },
      { columnId: "COL_ID_QUANTITY", direction: "asc" },
    ]);
    expect(restored.rowsWidth).toBe(333);
    expect(createBrunoTablePersistedState(restored)).toMatchObject({
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [
        { columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "desc" },
        { columnId: "COL_ID_QUANTITY", direction: "asc" },
      ],
      columnWidths: { COL_ID_BRUNO_TABLE_ROWS: 333 },
    });
  });

  it("snapshots hostile persisted grouping entries without invoking accessors", () => {
    const groupingColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "name",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
    ]);
    let groupByGetterReads = 0;
    const hostileGroupBy = ["COL_ID_DESK"];
    Object.defineProperty(hostileGroupBy, 0, {
      enumerable: true,
      get: () => {
        groupByGetterReads += 1;
        return "COL_ID_DESK";
      },
    });
    let orderGetterReads = 0;
    const hostileOrder = Object.create(null);
    Object.defineProperties(hostileOrder, {
      columnId: {
        enumerable: true,
        get: () => {
          orderGetterReads += 1;
          return "COL_ID_DESK";
        },
      },
      direction: { enumerable: true, value: "desc" },
    });
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_HOSTILE_GROUPING",
      columns: groupingColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      grouping: true,
      initialPersistedState: {
        version: 1,
        tableId: "TABLE_ID_HOSTILE_GROUPING",
        filters: [],
        orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
        groupBy: hostileGroupBy,
        groupOrderBy: [hostileOrder],
        columnOrder: ["COL_ID_DESK"],
        columnVisibility: {},
        columnWidths: {},
        columnPinning: { start: [], end: [] },
      },
    });

    expect(groupByGetterReads).toBe(0);
    expect(orderGetterReads).toBe(0);
    expect(restored.groupBy).toEqual([]);
    expect(restored.groupOrderBy).toEqual([
      { columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" },
    ]);
  });

  it("rejects over-budget persisted grouping arrays before reading their entries", () => {
    const groupingColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "name",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
    ]);
    let entryReads = 0;
    const overBudgetGroupBy = Array.from({ length: 16_385 });
    const overBudgetGroupOrderBy = Array.from({ length: 16_385 });
    Object.defineProperty(overBudgetGroupBy, 0, {
      enumerable: true,
      get: () => {
        entryReads += 1;
        return "COL_ID_DESK";
      },
    });
    Object.defineProperty(overBudgetGroupOrderBy, 0, {
      enumerable: true,
      get: () => {
        entryReads += 1;
        return { columnId: "COL_ID_DESK", direction: "desc" };
      },
    });

    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_OVER_BUDGET_GROUPING",
      columns: groupingColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      grouping: true,
      initialPersistedState: {
        version: 1,
        tableId: "TABLE_ID_OVER_BUDGET_GROUPING",
        filters: [],
        orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
        groupBy: overBudgetGroupBy,
        groupOrderBy: overBudgetGroupOrderBy,
        columnOrder: ["COL_ID_DESK"],
        columnVisibility: {},
        columnWidths: {},
        columnPinning: { start: [], end: [] },
      },
    });

    expect(entryReads).toBe(0);
    expect(restored.groupBy).toEqual([]);
    expect(restored.groupOrderBy).toEqual([
      { columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" },
    ]);
  });

  it("restores a mandatory grouped sort over the active key when persisted intent sanitizes empty", () => {
    const groupingColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "name",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_GROUP_SORT_FALLBACK",
      columns: groupingColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      grouping: true,
      initialPersistedState: {
        version: 1,
        tableId: "TABLE_ID_GROUP_SORT_FALLBACK",
        filters: [],
        orderBy: [{ columnId: "COL_ID_DESK", direction: "desc" }],
        groupBy: ["COL_ID_DESK"],
        groupOrderBy: [{ columnId: "COL_ID_UNKNOWN", direction: "asc" }],
        columnOrder: ["COL_ID_DESK"],
        columnVisibility: {},
        columnWidths: {},
        columnPinning: { start: [], end: [] },
      },
    });

    expect(restored.groupOrderBy).toEqual([{ columnId: "COL_ID_DESK", direction: "asc" }]);
    expect(restored.orderBy).toEqual([{ columnId: "COL_ID_DESK", direction: "desc" }]);
  });

  it("restores Rows as the mandatory dormant grouped sort before the first group key", () => {
    const groupingColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "name",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_DORMANT_GROUP_SORT_FALLBACK",
      columns: groupingColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      grouping: true,
      initialPersistedState: {
        version: 1,
        tableId: "TABLE_ID_DORMANT_GROUP_SORT_FALLBACK",
        filters: [],
        orderBy: [{ columnId: "COL_ID_DESK", direction: "desc" }],
        groupBy: [],
        groupOrderBy: [],
        columnOrder: ["COL_ID_DESK"],
        columnVisibility: {},
        columnWidths: {},
        columnPinning: { start: [], end: [] },
      },
    });

    expect(restored.groupOrderBy).toEqual([
      { columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" },
    ]);
    expect(createBrunoTablePersistedState(restored)["groupOrderBy"]).toEqual([
      { columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" },
    ]);
  });

  it("encodes only at committed preference boundaries", () => {
    accountEncodePersisted.mockClear();
    const preferences = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_ORDERS",
      columns,
      initialFilters: [{ columnId: "COL_ID_ACCOUNT", type: "equals", filter: { address: "a" } }],
      initialOrderBy,
    });
    expect(accountEncodePersisted).not.toHaveBeenCalled();
    createBrunoTablePersistedState(preferences);
    expect(accountEncodePersisted).toHaveBeenCalledOnce();
  });

  it("captures codec arrays from one non-negative length observation", () => {
    let lengthReads = 0;
    const changingArray = new Proxy(["stable"], {
      get: (target, key, receiver) => {
        if (key !== "length") return Reflect.get(target, key, receiver);
        lengthReads += 1;
        return lengthReads === 1 ? 1 : -1;
      },
    });
    const changingValueType: BrunoTableValueType<string, "equality", "text"> = {
      ...accountValueType,
      codecId: "test/changing-array",
      codecVersion: 1,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value,
      encodePersisted: () => changingArray,
      decodePersisted: () => ({ _tag: "Failure" as const, message: "Not restored." }),
    };
    const changingColumns = compileColumns([
      {
        columnId: "COL_ID_CHANGING_ARRAY",
        field: "name",
        headerName: "Changing array",
        valueType: changingValueType,
      },
    ]);
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_CHANGING_ARRAY",
        columns: changingColumns,
        initialFilters: [{ columnId: "COL_ID_CHANGING_ARRAY", type: "equals", filter: "value" }],
        initialOrderBy: [{ columnId: "COL_ID_CHANGING_ARRAY", direction: "asc" }],
      }),
    );

    expect(lengthReads).toBe(1);
    expect(JSON.stringify(snapshot)).toContain('"filter":["stable"]');

    let negativeLengthReads = 0;
    const negativeArray = new Proxy([], {
      get: (target, key, receiver) => {
        if (key !== "length") return Reflect.get(target, key, receiver);
        negativeLengthReads += 1;
        return -1;
      },
    });
    const negativeValueType = { ...changingValueType, encodePersisted: () => negativeArray };
    const negativeColumns = compileColumns([
      {
        columnId: "COL_ID_NEGATIVE_ARRAY",
        field: "name",
        headerName: "Negative array",
        valueType: negativeValueType,
      },
    ]);
    const negativePreferences = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_NEGATIVE_ARRAY",
      columns: negativeColumns,
      initialFilters: [{ columnId: "COL_ID_NEGATIVE_ARRAY", type: "equals", filter: "value" }],
      initialOrderBy: [{ columnId: "COL_ID_NEGATIVE_ARRAY", direction: "asc" }],
    });
    expect(() => createBrunoTablePersistedState(negativePreferences)).toThrow("JSON-safe");
    expect(negativeLengthReads).toBe(1);
  });

  it("rejects a filter collection whose combined codec output exceeds the restore budget", () => {
    const largeTuple = Object.freeze(Array.from({ length: 70_000 }, () => "exact"));
    const largeValueType: BrunoTableValueType<string, "equality", "text"> = {
      ...accountValueType,
      codecId: "test/large-output",
      codecVersion: 1,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value,
      encodePersisted: () => largeTuple,
      decodePersisted: () => ({ _tag: "Failure" as const, message: "Not restored." }),
    };
    const largeColumns = compileColumns([
      {
        columnId: "COL_ID_LARGE_FIRST",
        field: "name",
        headerName: "Large first",
        valueType: largeValueType,
      },
      {
        columnId: "COL_ID_LARGE_SECOND",
        field: "name",
        headerName: "Large second",
        valueType: largeValueType,
      },
    ]);
    const preferences = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_COMBINED_CODEC_BUDGET",
      columns: largeColumns,
      initialFilters: [
        { columnId: "COL_ID_LARGE_FIRST", type: "equals", filter: "first" },
        { columnId: "COL_ID_LARGE_SECOND", type: "equals", filter: "second" },
      ],
      initialOrderBy: [{ columnId: "COL_ID_LARGE_FIRST", direction: "asc" }],
    });

    expect(() => createBrunoTablePersistedState(preferences)).toThrow("JSON-safe");
  });

  it("rejects an over-keyed nested persisted codec object", () => {
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_OVER_KEYED_CODEC",
        columns,
        initialFilters: [
          { columnId: "COL_ID_ACCOUNT", type: "equals", filter: { address: "acct-42" } },
        ],
        initialOrderBy,
      }),
    );
    const filters = snapshot["filters"];
    const filter = Array.isArray(filters) ? filters[0] : undefined;
    if (typeof filter !== "object" || filter === null) {
      throw new TypeError("Expected one persisted account filter.");
    }
    const payload = Object.fromEntries([
      ["account", "acct-42"],
      ...Array.from({ length: 4_097 }, (_unused, index) => [`irrelevant-${String(index)}`, index]),
    ]);
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_OVER_KEYED_CODEC",
      columns,
      initialFilters: [],
      initialOrderBy,
      initialPersistedState: { ...snapshot, filters: [{ ...filter, filter: payload }] },
    });

    expect(restored.filters).toEqual([]);
  });

  it("bounds custom codec output before compiled JSON validation", () => {
    const output = Object.fromEntries(
      Array.from({ length: 4_097 }, (_unused, index) => [`key-${String(index)}`, index]),
    );
    const valueType: BrunoTableValueType<string, "equality", "text"> = {
      ...accountValueType,
      codecId: "test/bounded-output",
      codecVersion: 1,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value,
      encodePersisted: () => output,
      decodePersisted: () => ({ _tag: "Failure", message: "Not restored." }),
    };
    const boundedColumns = compileColumns([
      {
        columnId: "COL_ID_BOUNDED_OUTPUT",
        field: "name",
        headerName: "Bounded output",
        valueType,
      },
    ]);
    const preferences = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_BOUNDED_OUTPUT",
      columns: boundedColumns,
      initialFilters: [{ columnId: "COL_ID_BOUNDED_OUTPUT", type: "equals", filter: "value" }],
      initialOrderBy: [{ columnId: "COL_ID_BOUNDED_OUTPUT", direction: "asc" }],
    });
    const ownKeys = vi.spyOn(Reflect, "ownKeys");
    try {
      expect(() => createBrunoTablePersistedState(preferences)).toThrow("JSON-safe");
      expect(ownKeys.mock.calls.some(([target]) => target === output)).toBe(false);
    } finally {
      ownKeys.mockRestore();
    }
  });

  it("rejects over-budget persisted JSON value and key text before codecs", () => {
    let output: BrunoTableJsonValue = { value: "ok" };
    const decodePersisted = vi.fn((input: unknown) =>
      typeof input === "object" && input !== null && "value" in input
        ? { _tag: "Success" as const, value: String(input.value) }
        : { _tag: "Failure" as const, message: "Expected persisted text." },
    );
    const valueType: BrunoTableValueType<string, "equality", "text"> = {
      ...accountValueType,
      codecId: "test/text-budget",
      codecVersion: 1,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value,
      encodePersisted: () => output,
      decodePersisted,
    };
    const budgetColumns = compileColumns([
      {
        columnId: "COL_ID_TEXT_BUDGET",
        field: "name",
        headerName: "Text budget",
        valueType,
      },
    ]);
    const preferences = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_TEXT_BUDGET",
      columns: budgetColumns,
      initialFilters: [{ columnId: "COL_ID_TEXT_BUDGET", type: "equals", filter: "value" }],
      initialOrderBy: [{ columnId: "COL_ID_TEXT_BUDGET", direction: "asc" }],
    });
    const valid = createBrunoTablePersistedState(preferences);
    const hugeText = "x".repeat(1_048_577);

    output = hugeText;
    expect(() => createBrunoTablePersistedState(preferences)).toThrow("JSON-safe");
    output = { [hugeText]: "short" };
    expect(() => createBrunoTablePersistedState(preferences)).toThrow("JSON-safe");

    const filters = valid["filters"];
    const filter = Array.isArray(filters) ? filters[0] : undefined;
    if (typeof filter !== "object" || filter === null) {
      throw new TypeError("Expected one persisted text-budget filter.");
    }
    decodePersisted.mockClear();
    const restored = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_TEXT_BUDGET",
      columns: budgetColumns,
      initialFilters: [],
      initialOrderBy: [{ columnId: "COL_ID_TEXT_BUDGET", direction: "asc" }],
      initialPersistedState: {
        ...valid,
        filters: [{ ...filter, filter: { [hugeText]: "short" } }],
      },
    });

    expect(restored.filters).toEqual([]);
    expect(decodePersisted).not.toHaveBeenCalled();
  });

  it("rejects negative-zero custom codec output before JSON changes its meaning", () => {
    const valueType: BrunoTableValueType<number, "equality", "text"> = {
      codecId: "test/negative-zero",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "end",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "number"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected number." },
      equivalent: Object.is,
      compare: (left, right) => (Object.is(left, right) ? 0 : left < right ? -1 : 1),
      formatCanonicalText: String,
      parseCanonicalText: (text) => ({ _tag: "Success", value: Number(text) }),
      formatDisplay: String,
      encodePersisted: () => -0,
      decodePersisted: (input) =>
        typeof input === "number"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected number." },
    };
    const negativeZeroColumns = compileColumns([
      {
        columnId: "COL_ID_NEGATIVE_ZERO",
        field: "score",
        headerName: "Negative zero",
        valueType,
      },
    ]);
    const preferences = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_NEGATIVE_ZERO",
      columns: negativeZeroColumns,
      initialFilters: [{ columnId: "COL_ID_NEGATIVE_ZERO", type: "equals", filter: -0 }],
      initialOrderBy: [{ columnId: "COL_ID_NEGATIVE_ZERO", direction: "asc" }],
    });

    expect(() => createBrunoTablePersistedState(preferences)).toThrow("JSON-safe");
  });

  it("does not materialize non-JSON nested codec metadata", () => {
    const snapshot = createBrunoTablePersistedState(
      createBrunoTableGridPreferences({
        tableId: "TABLE_ID_CODEC_METADATA",
        columns,
        initialFilters: [
          { columnId: "COL_ID_ACCOUNT", type: "equals", filter: { address: "acct-42" } },
        ],
        initialOrderBy,
      }),
    );
    const filters = snapshot["filters"];
    const filter = Array.isArray(filters) ? filters[0] : undefined;
    if (typeof filter !== "object" || filter === null) {
      throw new TypeError("Expected one persisted account filter.");
    }
    const payload = { account: "acct-42" };
    for (let index = 0; index <= 4_096; index += 1) {
      Object.defineProperty(payload, `metadata-${String(index)}`, { value: index });
      Object.defineProperty(payload, Symbol(`metadata-${String(index)}`), { value: index });
    }
    const ownKeys = vi.spyOn(Reflect, "ownKeys");
    try {
      const restored = createBrunoTableGridPreferences({
        tableId: "TABLE_ID_CODEC_METADATA",
        columns,
        initialFilters: [],
        initialOrderBy,
        initialPersistedState: { ...snapshot, filters: [{ ...filter, filter: payload }] },
      });

      expect(restored.filters).toEqual([
        { columnId: "COL_ID_ACCOUNT", type: "equals", filter: { address: "acct-42" } },
      ]);
      expect(ownKeys.mock.calls.some(([target]) => target === payload)).toBe(false);
    } finally {
      ownKeys.mockRestore();
    }
  });

  it("retains the captured codec-object prototype decision", () => {
    let prototypeReads = 0;
    const changingPrototype = new Proxy(
      { value: "unsafe" },
      {
        getPrototypeOf: () => {
          prototypeReads += 1;
          return prototypeReads === 1
            ? Object.prototype
            : prototypeReads === 2
              ? Date.prototype
              : null;
        },
      },
    );
    const valueType: BrunoTableValueType<string, "equality", "text"> = {
      ...accountValueType,
      codecId: "test/changing-prototype",
      codecVersion: 1,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value,
      encodePersisted: () => changingPrototype,
      decodePersisted: () => ({ _tag: "Failure" as const, message: "Not restored." }),
    };
    const hostileColumns = compileColumns([
      {
        columnId: "COL_ID_CHANGING_PROTOTYPE",
        field: "name",
        headerName: "Changing prototype",
        valueType,
      },
    ]);
    const preferences = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_CHANGING_PROTOTYPE",
      columns: hostileColumns,
      initialFilters: [{ columnId: "COL_ID_CHANGING_PROTOTYPE", type: "equals", filter: "value" }],
      initialOrderBy: [{ columnId: "COL_ID_CHANGING_PROTOTYPE", direction: "asc" }],
    });

    expect(JSON.stringify(createBrunoTablePersistedState(preferences))).toContain(
      '"filter":{"value":"unsafe"}',
    );
    expect(prototypeReads).toBe(2);
  });

  it("refuses non-JSON-safe output from a custom persisted codec", () => {
    const unsafeValueType: BrunoTableValueType<string, "equality", "text"> = {
      codecId: "test/unsafe-json",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected string." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value,
      encodePersisted: () => Number.NaN,
      decodePersisted: () => ({ _tag: "Failure", message: "Never decodes." }),
    };
    const unsafeColumns = compileColumns([
      {
        columnId: "COL_ID_UNSAFE",
        field: "name",
        headerName: "Unsafe",
        valueType: unsafeValueType,
      },
    ]);
    const preferences = createBrunoTableGridPreferences({
      tableId: "TABLE_ID_UNSAFE_JSON",
      columns: unsafeColumns,
      initialFilters: [{ columnId: "COL_ID_UNSAFE", type: "equals", filter: "value" }],
      initialOrderBy: [{ columnId: "COL_ID_UNSAFE", direction: "asc" }],
    });

    expect(() => createBrunoTablePersistedState(preferences)).toThrow("JSON-safe");
  });
});
