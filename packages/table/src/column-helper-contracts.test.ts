import { expect, test } from "vite-plus/test";

import {
  BrunoTableBigIntColumn,
  BrunoTableBooleanColumn,
  BrunoTableNumberColumn,
  BrunoTableSelectColumn,
  BrunoTableTextColumn,
  type BrunoTableColumns,
} from "./index";

test.each(["countDistinct", "min", "max", "sum", "avg"])(
  "Select rejects unsupported %s aggregation at the public helper boundary",
  (aggFunc) => {
    expect(() =>
      Reflect.apply(BrunoTableSelectColumn, undefined, [
        {
          columnId: "COL_ID_SIDE",
          field: "side",
          headerName: "Side",
          options: ["Buy", "Sell"],
          aggFunc,
        },
      ]),
    ).toThrow("unsupported aggFunc");
    const preset = BrunoTableSelectColumn.withDefaults({
      headerName: "Side",
      options: ["Buy", "Sell"],
    });
    expect(() =>
      Reflect.apply(preset, undefined, [{ columnId: "COL_ID_SIDE", field: "side", aggFunc }]),
    ).toThrow("unsupported aggFunc");
  },
);

test("public primitive helpers retain explicit identity and semantic layout defaults", () => {
  type Row = { text: string; number: number; bigint: bigint; boolean: boolean };
  const columns = [
    BrunoTableTextColumn({ columnId: "COL_ID_TEXT", field: "text", headerName: "Text" }),
    BrunoTableNumberColumn({ columnId: "COL_ID_NUMBER", field: "number", headerName: "Number" }),
    BrunoTableBigIntColumn({ columnId: "COL_ID_BIGINT", field: "bigint", headerName: "BigInt" }),
    BrunoTableBooleanColumn({
      columnId: "COL_ID_BOOLEAN",
      field: "boolean",
      headerName: "Boolean",
    }),
  ] satisfies BrunoTableColumns<Row>;
  expect(
    columns.map(({ columnId, headerName, valueType, cellAlign, editorLayout, width }) => ({
      columnId,
      headerName,
      valueType,
      cellAlign,
      editorLayout,
      width,
    })),
  ).toEqual([
    {
      columnId: "COL_ID_TEXT",
      headerName: "Text",
      valueType: "text",
      cellAlign: "start",
      editorLayout: "inline",
      width: 160,
    },
    {
      columnId: "COL_ID_NUMBER",
      headerName: "Number",
      valueType: "number",
      cellAlign: "end",
      editorLayout: "inline",
      width: 120,
    },
    {
      columnId: "COL_ID_BIGINT",
      headerName: "BigInt",
      valueType: "bigint",
      cellAlign: "end",
      editorLayout: "inline",
      width: 140,
    },
    {
      columnId: "COL_ID_BOOLEAN",
      headerName: "Boolean",
      valueType: "boolean",
      cellAlign: "center",
      editorLayout: "center",
      width: 88,
    },
  ]);
});

test("Select codecs preserve exact primitive domains, configured order, and JSON-safe persistence", () => {
  type Row = {
    side: "Buy" | "Sell";
    quantity: 9007199254740993n | 2n;
    price: 1.25 | 0;
    active: boolean;
  };
  const columns = [
    BrunoTableSelectColumn({
      columnId: "COL_ID_SIDE",
      field: "side",
      headerName: "Side",
      options: ["Sell", "Buy"],
    }),
    BrunoTableSelectColumn({
      columnId: "COL_ID_QUANTITY",
      field: "quantity",
      headerName: "Quantity",
      options: [9007199254740993n, 2n],
    }),
    BrunoTableSelectColumn({
      columnId: "COL_ID_PRICE",
      field: "price",
      headerName: "Price",
      options: [1.25, 0],
    }),
    BrunoTableSelectColumn({
      columnId: "COL_ID_ACTIVE",
      field: "active",
      headerName: "Active",
      options: [false, true],
    }),
  ] as const satisfies BrunoTableColumns<Row>;
  const side = columns[0].valueType;
  const quantity = columns[1].valueType;
  const price = columns[2].valueType;
  const active = columns[3].valueType;
  expect(side!.compare("Sell", "Buy")).toBe(-1);
  expect(side!.parseCanonicalText("Buy")).toEqual({ _tag: "Success", value: "Buy" });
  expect(quantity!.formatCanonicalText(9007199254740993n)).toBe("9007199254740993");
  const persistedQuantity = JSON.parse(JSON.stringify(quantity.encodePersisted(9007199254740993n)));
  expect(quantity.decodePersisted(persistedQuantity)).toEqual({
    _tag: "Success",
    value: 9007199254740993n,
  });
  expect(price!.parseCanonicalText("1.25")).toEqual({ _tag: "Success", value: 1.25 });
  expect(active!.parseCanonicalText("false")).toEqual({ _tag: "Success", value: false });
  expect(side!.decodeRuntime(null)._tag).toBe("Failure");
  expect(side!.decodeRuntime(undefined)._tag).toBe("Failure");
  expect(quantity!.decodeRuntime(9007199254740992)._tag).toBe("Failure");
  expect(active!.decodeRuntime("false")._tag).toBe("Failure");
  expect(
    side!.decodePersisted({
      $brunoTableValue: "select",
      version: 2,
      value: { type: "string", value: "Buy" },
    })._tag,
  ).toBe("Failure");
});

test.each([[], ["Buy", "Buy"], [0, -0], [1, "1"], [NaN], [Infinity], [null], [undefined], [{}]])(
  "Select rejects invalid or canonically ambiguous runtime options %j",
  (...options) => {
    expect(() =>
      Reflect.apply(BrunoTableSelectColumn, undefined, [
        {
          columnId: "COL_ID_CHOICE",
          field: "choice",
          headerName: "Choice",
          options,
        },
      ]),
    ).toThrow(TypeError);
  },
);

test("individual options override presets without replacing helper value semantics", () => {
  const preset = BrunoTableNumberColumn.withDefaults({
    headerName: "Preset price",
    width: 180,
    cellAlign: "start",
    format: { minimumFractionDigits: 2, maximumFractionDigits: 4 },
  });
  const columns = [
    preset({
      columnId: "COL_ID_PRICE",
      field: "price",
      headerName: "Execution price",
      width: 220,
      format: { maximumFractionDigits: 3 },
    }),
  ] satisfies BrunoTableColumns<{ price: number }>;
  expect(columns[0]).toMatchObject({
    columnId: "COL_ID_PRICE",
    headerName: "Execution price",
    width: 220,
    cellAlign: "start",
    editorLayout: "inline",
    valueType: "number",
    format: { minimumFractionDigits: 2, maximumFractionDigits: 3 },
  });
  expect(() =>
    Reflect.apply(preset, undefined, [
      {
        columnId: "COL_ID_PRICE",
        field: "price",
        valueType: "text",
      },
    ]),
  ).toThrow("valueType override");
});

test("a Select preset snapshots a large option domain and preserves late-option lookup", () => {
  const options: [string, ...string[]] = [
    "Option 0",
    ...Array.from({ length: 35 }, (_, index) => `Option ${index + 1}`),
  ];
  const preset = BrunoTableSelectColumn.withDefaults({ headerName: "Choice", options });
  options[35] = "Changed after preset creation";
  const columns = [
    preset({ columnId: "COL_ID_CHOICE", field: "choice" }),
  ] satisfies BrunoTableColumns<{ choice: string }>;
  const codec = columns[0]!.valueType;
  expect(codec.decodeRuntime("Option 35")).toEqual({ _tag: "Success", value: "Option 35" });
  expect(codec.parseCanonicalText("Option 35")).toEqual({ _tag: "Success", value: "Option 35" });
  expect(codec.compare("Option 0", "Option 35")).toBe(-1);
  expect(codec.decodeRuntime("Changed after preset creation")._tag).toBe("Failure");
  expect(codec.parseCanonicalText("Option 36")._tag).toBe("Failure");
  expect(() =>
    Reflect.apply(preset, undefined, [
      {
        columnId: "COL_ID_CHOICE",
        field: "choice",
        options: ["Replacement"],
      },
    ]),
  ).toThrow("preset options cannot be overridden");
});
