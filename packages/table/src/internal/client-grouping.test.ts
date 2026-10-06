import { describe, expect, it, vi } from "vitest";

import { BrunoTableAggregateAlgebra } from "../public-types";
import type { BrunoTableValueType } from "../public-types";
import { compileColumns } from "./compile-columns";
import {
  deriveBrunoTableClientGroupedProjection,
  type BrunoTableClientGroupedProjection,
  type BrunoTableClientGroupingInputRow,
} from "./client-grouping";

type Order = Readonly<{
  readonly id: string;
  readonly region?: string | null | undefined;
  readonly status: string;
  readonly quantity: bigint;
  readonly price: number;
  readonly money: Money;
  readonly flag?: boolean;
}>;

type Money = Readonly<{ readonly minorUnits: bigint }>;

const moneyAlgebra = BrunoTableAggregateAlgebra<Money>({
  add: (left, right) => ({ minorUnits: left.minorUnits + right.minorUnits }),
  divideByCount: (total, count) => ({ minorUnits: total.minorUnits / count }),
});

const moneyValueType: BrunoTableValueType<
  Money,
  "numeric",
  "text",
  {
    readonly countDistinct: "bigint";
    readonly sum: "self";
    readonly min: "self";
    readonly max: "self";
    readonly avg: "self";
  }
> = {
  codecId: "test/money",
  codecVersion: 1,
  filterFamily: "numeric",
  editorFamily: "text",
  cellAlign: "end",
  editorLayout: "inline",
  defaultWidth: 120,
  aggregateResults: {
    countDistinct: "bigint",
    sum: "self",
    min: "self",
    max: "self",
    avg: "self",
  },
  aggregateAlgebra: moneyAlgebra,
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

const columns = compileColumns([
  {
    columnId: "COL_ID_REGION",
    field: "region",
    headerName: "Region",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_STATUS",
    field: "status",
    headerName: "Status",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_QUANTITY_SUM",
    field: "quantity",
    headerName: "Quantity sum",
    valueType: "bigint",
    aggFunc: "sum",
  },
  {
    columnId: "COL_ID_QUANTITY_MAX",
    field: "quantity",
    headerName: "Quantity max",
    valueType: "bigint",
    aggFunc: "max",
  },
  {
    columnId: "COL_ID_PRICE_MIN",
    field: "price",
    headerName: "Price min",
    valueType: "number",
    aggFunc: "min",
  },
  {
    columnId: "COL_ID_MONEY_SUM",
    field: "money",
    headerName: "Money sum",
    valueType: moneyValueType,
    aggFunc: "sum",
  },
  {
    columnId: "COL_ID_MONEY_AVG",
    field: "money",
    headerName: "Money average",
    valueType: moneyValueType,
    aggFunc: "avg",
  },
  {
    columnId: "COL_ID_MONEY_DISTINCT",
    field: "money",
    headerName: "Money distinct",
    valueType: moneyValueType,
    aggFunc: "countDistinct",
  },
]);

function inputRow(raw: Order, rowIndex: number): BrunoTableClientGroupingInputRow {
  return {
    raw,
    rowId: raw.id,
    rowIndex,
    readValue: (column) => (column.kind === "field" ? Reflect.get(raw, column.field) : undefined),
  };
}

function value(
  projection: Extract<
    ReturnType<typeof deriveBrunoTableClientGroupedProjection>,
    { kind: "ready" }
  >,
  rowIndex: number,
  columnId: string,
): unknown {
  return projection.rows[rowIndex]?.values.get(columnId);
}

describe("Client flat grouping", () => {
  it("never reads or executes hidden non-participating aggregates", () => {
    const hiddenAggregateRead = vi.fn(() => {
      throw new Error("Hidden aggregate must remain dormant.");
    });
    const participatingColumns = compileColumns([
      {
        columnId: "COL_ID_GROUP",
        field: "region",
        headerName: "Region",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_HIDDEN_TOTAL",
        field: "quantity",
        headerName: "Hidden total",
        valueType: "bigint",
        aggFunc: "sum",
      },
    ]);
    const rows: readonly BrunoTableClientGroupingInputRow[] = [
      {
        raw: { region: "EU", quantity: 1n },
        rowId: "row-1",
        rowIndex: 0,
        readValue: (column) =>
          column.columnId === "COL_ID_HIDDEN_TOTAL" ? hiddenAggregateRead() : "EU",
      },
    ];

    const hidden = deriveBrunoTableClientGroupedProjection({
      rows,
      columns: participatingColumns,
      participatingAggregateColumnIds: new Set(["COL_ID_GROUP"]),
      groupBy: ["COL_ID_GROUP"],
      groupOrderBy: [{ columnId: "COL_ID_GROUP", direction: "asc" }],
    });
    expect(hidden.kind).toBe("ready");
    expect(hiddenAggregateRead).not.toHaveBeenCalled();

    const visible = deriveBrunoTableClientGroupedProjection({
      rows,
      columns: participatingColumns,
      participatingAggregateColumnIds: new Set(["COL_ID_HIDDEN_TOTAL"]),
      groupBy: ["COL_ID_GROUP"],
      groupOrderBy: [{ columnId: "COL_ID_GROUP", direction: "asc" }],
    });
    expect(visible.kind).toBe("invalid");
    expect(hiddenAggregateRead).toHaveBeenCalledOnce();
  });

  it("derives multi-key flat groups, exact Rows, and same-field aggregates in one pass", () => {
    const huge = 10n ** 80n;
    const projection = deriveBrunoTableClientGroupedProjection({
      rows: [
        inputRow(
          {
            id: "a",
            region: "EU",
            status: "open",
            quantity: huge,
            price: -0,
            money: { minorUnits: 10n },
          },
          0,
        ),
        inputRow(
          {
            id: "b",
            region: "EU",
            status: "open",
            quantity: 7n,
            price: 0,
            money: { minorUnits: 20n },
          },
          1,
        ),
        inputRow(
          {
            id: "c",
            region: "EU",
            status: "closed",
            quantity: 2n,
            price: 3,
            money: { minorUnits: 20n },
          },
          2,
        ),
      ],
      columns,
      groupBy: ["COL_ID_REGION", "COL_ID_STATUS"],
      groupOrderBy: [{ columnId: "COL_ID_STATUS", direction: "desc" }],
    });
    expect(projection.kind).toBe("ready");
    if (projection.kind !== "ready") return;
    expect(projection.rows).toHaveLength(2);
    expect(projection.rows.map((row) => row.rowCount)).toEqual([2n, 1n]);
    expect(value(projection, 0, "COL_ID_QUANTITY_SUM")).toBe(huge + 7n);
    expect(value(projection, 0, "COL_ID_QUANTITY_MAX")).toBe(huge);
    expect(Object.is(value(projection, 0, "COL_ID_PRICE_MIN"), -0)).toBe(false);
    expect(Object.is(value(projection, 0, "COL_ID_PRICE_MIN"), 0)).toBe(true);
    expect(value(projection, 0, "COL_ID_MONEY_SUM")).toEqual({ minorUnits: 30n });
    expect(value(projection, 0, "COL_ID_MONEY_AVG")).toEqual({ minorUnits: 15n });
    expect(value(projection, 0, "COL_ID_MONEY_DISTINCT")).toBe(2n);
    expect(new Set(projection.rows.map((row) => row.rowId)).size).toBe(2);
  });

  it("keeps Missing distinct from Present null or undefined and preserves all-missing extrema", () => {
    const rawMissing = {
      id: "missing",
      status: "open",
      quantity: 1n,
      price: 1,
      money: { minorUnits: 1n },
    } as Order;
    const rawNull: Order = {
      id: "null",
      region: null,
      status: "open",
      quantity: 1n,
      price: 1,
      money: { minorUnits: 1n },
    };
    const rawUndefined = Object.defineProperty(
      {
        id: "undefined",
        status: "open",
        quantity: 1n,
        price: 1,
        money: { minorUnits: 1n },
      },
      "region",
      { enumerable: true, value: undefined },
    ) as Order;
    const rawNullText: Order = {
      id: "null-text",
      region: "null",
      status: "open",
      quantity: 1n,
      price: 1,
      money: { minorUnits: 1n },
    };
    const rawUndefinedText: Order = {
      id: "undefined-text",
      region: "undefined",
      status: "open",
      quantity: 1n,
      price: 1,
      money: { minorUnits: 1n },
    };
    const identityRows = [
      inputRow(rawMissing, 0),
      inputRow(rawNull, 1),
      inputRow(rawUndefined, 2),
      inputRow(rawNullText, 3),
      inputRow(rawUndefinedText, 4),
    ];
    const projection = deriveBrunoTableClientGroupedProjection({
      rows: identityRows,
      columns,
      groupBy: ["COL_ID_REGION"],
      groupOrderBy: [{ columnId: "COL_ID_REGION", direction: "asc" }],
    });
    expect(projection.kind).toBe("ready");
    if (projection.kind !== "ready") return;
    expect(projection.rows).toHaveLength(5);
    expect(projection.rows.map((row) => row.rowCount)).toEqual([1n, 1n, 1n, 1n, 1n]);
    expect(projection.rows[0]?.groupKeys[0]).toEqual({ _tag: "Missing" });
    expect(projection.rows[1]?.groupKeys[0]).toEqual({ _tag: "Present", value: null });
    expect(projection.rows[2]?.groupKeys[0]).toEqual({ _tag: "Present", value: undefined });
    expect(projection.rows.slice(3).map((row) => row.groupKeys[0])).toEqual([
      { _tag: "Present", value: "null" },
      { _tag: "Present", value: "undefined" },
    ]);

    const distinctColumns = compileColumns([
      columns[1],
      {
        columnId: "COL_ID_REGION_DISTINCT",
        field: "region",
        headerName: "Distinct regions",
        valueType: "text",
        aggFunc: "countDistinct",
      },
    ]);
    const distinct = deriveBrunoTableClientGroupedProjection({
      rows: identityRows,
      columns: distinctColumns,
      groupBy: ["COL_ID_STATUS"],
      groupOrderBy: [{ columnId: "COL_ID_STATUS", direction: "asc" }],
    });
    expect(distinct.kind).toBe("ready");
    if (distinct.kind === "ready") {
      expect(value(distinct, 0, "COL_ID_REGION_DISTINCT")).toBe(5n);
    }

    const extremaColumns = compileColumns([
      columns[1],
      {
        columnId: "COL_ID_REGION_MIN",
        field: "region",
        headerName: "Minimum region",
        valueType: "text",
        aggFunc: "min",
      },
      {
        columnId: "COL_ID_REGION_MAX",
        field: "region",
        headerName: "Maximum region",
        valueType: "text",
        aggFunc: "max",
      },
    ]);
    const allMissing = deriveBrunoTableClientGroupedProjection({
      rows: [inputRow(rawMissing, 0)],
      columns: extremaColumns,
      groupBy: ["COL_ID_STATUS"],
      groupOrderBy: [{ columnId: "COL_ID_STATUS", direction: "asc" }],
    });
    expect(allMissing.kind).toBe("ready");
    if (allMissing.kind === "ready") {
      expect(value(allMissing, 0, "COL_ID_REGION_MIN")).toBeUndefined();
      expect(value(allMissing, 0, "COL_ID_REGION_MAX")).toBeUndefined();
    }
    const missingAndNull = deriveBrunoTableClientGroupedProjection({
      rows: [inputRow(rawMissing, 0), inputRow(rawNull, 1)],
      columns: extremaColumns,
      groupBy: ["COL_ID_STATUS"],
      groupOrderBy: [{ columnId: "COL_ID_STATUS", direction: "asc" }],
    });
    expect(missingAndNull.kind).toBe("ready");
    if (missingAndNull.kind === "ready") {
      expect(value(missingAndNull, 0, "COL_ID_REGION_MIN")).toBeUndefined();
      expect(value(missingAndNull, 0, "COL_ID_REGION_MAX")).toBeNull();
    }
  });

  it("derives exact min and max in every core and custom ordered domain", () => {
    const extremaColumns = compileColumns([
      columns[1],
      ...(
        [
          ["REGION", "region", "text"],
          ["FLAG", "flag", "boolean"],
          ["PRICE", "price", "number"],
          ["QUANTITY", "quantity", "bigint"],
          ["MONEY", "money", moneyValueType],
        ] as const
      ).flatMap(([identity, field, valueType]) => [
        {
          columnId: `COL_ID_${identity}_MIN`,
          field,
          headerName: `${identity} min`,
          valueType,
          aggFunc: "min" as const,
        },
        {
          columnId: `COL_ID_${identity}_MAX`,
          field,
          headerName: `${identity} max`,
          valueType,
          aggFunc: "max" as const,
        },
      ]),
    ]);
    const projection = deriveBrunoTableClientGroupedProjection({
      rows: [
        inputRow(
          {
            id: "low",
            region: "A",
            status: "one",
            quantity: 2n,
            price: 1.5,
            money: { minorUnits: 10n },
            flag: false,
          },
          0,
        ),
        inputRow(
          {
            id: "high",
            region: "Z",
            status: "one",
            quantity: 9n,
            price: 7.5,
            money: { minorUnits: 90n },
            flag: true,
          },
          1,
        ),
      ],
      columns: extremaColumns,
      groupBy: ["COL_ID_STATUS"],
      groupOrderBy: [{ columnId: "COL_ID_STATUS", direction: "asc" }],
    });
    expect(projection.kind).toBe("ready");
    if (projection.kind !== "ready") return;
    expect(value(projection, 0, "COL_ID_REGION_MIN")).toBe("A");
    expect(value(projection, 0, "COL_ID_REGION_MAX")).toBe("Z");
    expect(value(projection, 0, "COL_ID_FLAG_MIN")).toBe(false);
    expect(value(projection, 0, "COL_ID_FLAG_MAX")).toBe(true);
    expect(value(projection, 0, "COL_ID_PRICE_MIN")).toBe(1.5);
    expect(value(projection, 0, "COL_ID_PRICE_MAX")).toBe(7.5);
    expect(value(projection, 0, "COL_ID_QUANTITY_MIN")).toBe(2n);
    expect(value(projection, 0, "COL_ID_QUANTITY_MAX")).toBe(9n);
    expect(value(projection, 0, "COL_ID_MONEY_MIN")).toEqual({ minorUnits: 10n });
    expect(value(projection, 0, "COL_ID_MONEY_MAX")).toEqual({ minorUnits: 90n });
  });

  it("sorts and reconciles countDistinct through exact bigint result semantics", () => {
    const distinctColumns = compileColumns([
      columns[0],
      {
        columnId: "COL_ID_STATUS_DISTINCT",
        field: "status",
        headerName: "Distinct statuses",
        valueType: "text",
        aggFunc: "countDistinct",
      },
    ]);
    const sourceRows = [
      {
        id: "a",
        region: "A",
        status: "open",
        quantity: 1n,
        price: 1,
        money: { minorUnits: 1n },
      },
      {
        id: "b-1",
        region: "B",
        status: "open",
        quantity: 1n,
        price: 1,
        money: { minorUnits: 1n },
      },
      {
        id: "b-2",
        region: "B",
        status: "closed",
        quantity: 1n,
        price: 1,
        money: { minorUnits: 1n },
      },
    ] satisfies readonly Order[];
    const first = deriveBrunoTableClientGroupedProjection({
      rows: sourceRows.map(inputRow),
      columns: distinctColumns,
      groupBy: ["COL_ID_REGION"],
      groupOrderBy: [{ columnId: "COL_ID_STATUS_DISTINCT", direction: "desc" }],
    });
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") return;
    expect(first.rows.map((row) => row.values.get("COL_ID_REGION"))).toEqual(["B", "A"]);
    expect(first.rows.map((row) => row.values.get("COL_ID_STATUS_DISTINCT"))).toEqual([2n, 1n]);

    const equivalent = deriveBrunoTableClientGroupedProjection({
      rows: sourceRows.map(inputRow),
      columns: distinctColumns,
      groupBy: ["COL_ID_REGION"],
      groupOrderBy: [{ columnId: "COL_ID_STATUS_DISTINCT", direction: "desc" }],
      previous: first,
    });
    expect(equivalent.kind).toBe("ready");
    if (equivalent.kind === "ready") expect(equivalent.rows).toBe(first.rows);
  });

  it("replaces grouped rows when Present null and Present undefined aggregates alternate", () => {
    const nullableColumns = compileColumns([
      {
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_REGION_MIN",
        field: "region",
        headerName: "Minimum region",
        valueType: "text",
        aggFunc: "min",
      },
    ]);
    const derive = (
      region: string | null | undefined,
      previous?: BrunoTableClientGroupedProjection,
    ) =>
      deriveBrunoTableClientGroupedProjection({
        rows: [
          inputRow(
            {
              id: "one",
              region,
              status: "same",
              quantity: 1n,
              price: 1,
              money: { minorUnits: 1n },
            },
            0,
          ),
        ],
        columns: nullableColumns,
        groupBy: ["COL_ID_STATUS"],
        groupOrderBy: [{ columnId: "COL_ID_STATUS", direction: "asc" }],
        ...(previous === undefined ? {} : { previous }),
      });
    const nullProjection = derive(null);
    expect(nullProjection.kind).toBe("ready");
    if (nullProjection.kind !== "ready") return;
    const undefinedProjection = derive(undefined, nullProjection);
    expect(undefinedProjection.kind).toBe("ready");
    if (undefinedProjection.kind !== "ready") return;
    expect(undefinedProjection.rows[0]).not.toBe(nullProjection.rows[0]);
    expect(undefinedProjection.rows[0]?.values.get("COL_ID_REGION_MIN")).toBeUndefined();

    const nullAgain = derive(null, undefinedProjection);
    expect(nullAgain.kind).toBe("ready");
    if (nullAgain.kind === "ready") {
      expect(nullAgain.rows[0]).not.toBe(undefinedProjection.rows[0]);
      expect(nullAgain.rows[0]?.values.get("COL_ID_REGION_MIN")).toBeNull();
    }
  });

  it("sorts an active countDistinct-capable key through its field semantics", () => {
    const groupedMoneyColumns = compileColumns([
      {
        columnId: "COL_ID_MONEY_KEY",
        field: "money",
        headerName: "Money key",
        valueType: moneyValueType,
        groupBy: true,
        aggFunc: "countDistinct",
      },
    ]);
    const rows = [2n, 1n].map((minorUnits, index) =>
      inputRow(
        {
          id: String(index),
          region: "EU",
          status: "open",
          quantity: 1n,
          price: 1,
          money: { minorUnits },
        },
        index,
      ),
    );
    const projection = deriveBrunoTableClientGroupedProjection({
      rows,
      columns: groupedMoneyColumns,
      groupBy: ["COL_ID_MONEY_KEY"],
      groupOrderBy: [{ columnId: "COL_ID_MONEY_KEY", direction: "asc" }],
    });
    expect(projection.kind).toBe("ready");
    if (projection.kind === "ready") {
      expect(projection.rows.map((row) => row.values.get("COL_ID_MONEY_KEY"))).toEqual([
        { minorUnits: 1n },
        { minorUnits: 2n },
      ]);
      const equivalent = deriveBrunoTableClientGroupedProjection({
        rows,
        columns: groupedMoneyColumns,
        groupBy: ["COL_ID_MONEY_KEY"],
        groupOrderBy: [{ columnId: "COL_ID_MONEY_KEY", direction: "asc" }],
        previous: projection,
      });
      expect(equivalent.kind).toBe("ready");
      if (equivalent.kind === "ready") expect(equivalent.rows).toBe(projection.rows);
    }
  });

  it("turns hostile algebra execution and decoded results into deterministic invalid projections", () => {
    const rows = [
      inputRow(
        {
          id: "a",
          region: "EU",
          status: "open",
          quantity: 1n,
          price: 1,
          money: { minorUnits: 1n },
        },
        0,
      ),
      inputRow(
        {
          id: "b",
          region: "EU",
          status: "open",
          quantity: 1n,
          price: 1,
          money: { minorUnits: 2n },
        },
        1,
      ),
    ];
    const cases = [
      {
        name: "add throw",
        aggFunc: "sum" as const,
        algebra: BrunoTableAggregateAlgebra<Money>({
          add: () => {
            throw new Error("boom");
          },
        }),
      },
      {
        name: "add wrong domain",
        aggFunc: "sum" as const,
        algebra: BrunoTableAggregateAlgebra<Money>({
          add: () => 3n as unknown as Money,
        }),
      },
      {
        name: "divide throw",
        aggFunc: "avg" as const,
        algebra: BrunoTableAggregateAlgebra<Money>({
          add: (left, right) => ({ minorUnits: left.minorUnits + right.minorUnits }),
          divideByCount: () => {
            throw new Error("boom");
          },
        }),
      },
      {
        name: "divide wrong domain",
        aggFunc: "avg" as const,
        algebra: BrunoTableAggregateAlgebra<Money>({
          add: (left, right) => ({ minorUnits: left.minorUnits + right.minorUnits }),
          divideByCount: () => 3n as unknown as Money,
        }),
      },
    ];
    for (const scenario of cases) {
      const invalidColumns = compileColumns([
        columns[0],
        {
          columnId: "COL_ID_BAD_AGGREGATE",
          field: "money",
          headerName: scenario.name,
          valueType: {
            ...moneyValueType,
            aggregateResults: { [scenario.aggFunc]: "self" },
            aggregateAlgebra: scenario.algebra,
          },
          aggFunc: scenario.aggFunc,
        },
      ]);
      expect(
        deriveBrunoTableClientGroupedProjection({
          rows,
          columns: invalidColumns,
          groupBy: ["COL_ID_REGION"],
          groupOrderBy: [{ columnId: "COL_ID_REGION", direction: "asc" }],
        }),
        scenario.name,
      ).toMatchObject({
        kind: "invalid",
        invalid: scenario.name.startsWith("add")
          ? {
              kind: "source-row",
              rowIndex: 1,
              columnId: "COL_ID_BAD_AGGREGATE",
            }
          : { kind: "group", columnId: "COL_ID_BAD_AGGREGATE" },
      });
    }

    const admittedInputs = new WeakSet(rows.map((row) => (row.raw as Order).money as object));
    const decoderThrowColumns = compileColumns([
      columns[0],
      {
        columnId: "COL_ID_DECODER_THROW",
        field: "money",
        headerName: "Decoder throw",
        valueType: {
          ...moneyValueType,
          aggregateResults: { sum: "self" },
          aggregateAlgebra: BrunoTableAggregateAlgebra<Money>({
            add: (left, right) => ({ minorUnits: left.minorUnits + right.minorUnits }),
          }),
          decodeRuntime: (input: unknown) => {
            if (typeof input === "object" && input !== null && admittedInputs.has(input)) {
              return { _tag: "Success" as const, value: input as Money };
            }
            throw new Error("decoder threw on algebra output");
          },
        },
        aggFunc: "sum",
      },
    ]);
    expect(
      deriveBrunoTableClientGroupedProjection({
        rows,
        columns: decoderThrowColumns,
        groupBy: ["COL_ID_REGION"],
        groupOrderBy: [{ columnId: "COL_ID_REGION", direction: "asc" }],
      }),
    ).toMatchObject({
      kind: "invalid",
      invalid: {
        kind: "source-row",
        rowIndex: 1,
        columnId: "COL_ID_DECODER_THROW",
      },
    });
  });

  it("reuses unchanged grouped rows and the complete row collection across value-only publications", () => {
    const sourceRows: Order[] = [
      {
        id: "a",
        region: "East",
        status: "open",
        quantity: 2n,
        price: 1,
        money: { minorUnits: 10n },
      },
      {
        id: "b",
        region: "West",
        status: "open",
        quantity: 3n,
        price: 2,
        money: { minorUnits: 20n },
      },
    ];
    const first = deriveBrunoTableClientGroupedProjection({
      rows: sourceRows.map(inputRow),
      columns,
      groupBy: ["COL_ID_REGION"],
      groupOrderBy: [{ columnId: "COL_ID_REGION", direction: "asc" }],
    });
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") return;
    const equivalent = deriveBrunoTableClientGroupedProjection({
      rows: sourceRows.map(inputRow),
      columns,
      groupBy: ["COL_ID_REGION"],
      groupOrderBy: [{ columnId: "COL_ID_REGION", direction: "asc" }],
      previous: first,
    });
    expect(equivalent.kind).toBe("ready");
    if (equivalent.kind !== "ready") return;
    expect(equivalent.rows).toBe(first.rows);

    const changed = deriveBrunoTableClientGroupedProjection({
      rows: sourceRows.with(1, { ...sourceRows[1]!, quantity: 4n }).map(inputRow),
      columns,
      groupBy: ["COL_ID_REGION"],
      groupOrderBy: [{ columnId: "COL_ID_REGION", direction: "asc" }],
      previous: first,
    });
    expect(changed.kind).toBe("ready");
    if (changed.kind !== "ready") return;
    expect(changed.rows[0]).toBe(first.rows[0]);
    expect(changed.rows[1]).not.toBe(first.rows[1]);
  });
});
