import { describe, expect, it } from "vitest";

import { readCompiledColumnValue } from "./cell-value";
import { compileColumns } from "./compile-columns";

describe("readCompiledColumnValue", () => {
  it("reads fields admitted by primitive and tuple row types", () => {
    const [stringColumn] = compileColumns([
      {
        columnId: "COL_ID_LENGTH",
        field: "length",
        headerName: "Length",
        valueType: "number",
      },
    ]);
    const [tupleColumn] = compileColumns([
      {
        columnId: "COL_ID_FIRST",
        field: "0",
        headerName: "First",
        valueType: "text",
      },
    ]);

    expect(readCompiledColumnValue(stringColumn!, "Ada")).toBe(3);
    expect(readCompiledColumnValue(tupleColumn!, ["Grace"] as const)).toBe("Grace");
  });

  it("preserves __proto__ as an own computed-column dependency", () => {
    const [column] = compileColumns([
      {
        columnId: "COL_ID_PROTO",
        fields: ["__proto__"],
        headerName: "Protocol",
        valueType: "text",
        valueGetter: ({ row }: { readonly row: Readonly<Record<string, unknown>> }) => ({
          own: Object.hasOwn(row, "__proto__"),
          value: row["__proto__"],
        }),
      },
    ]);
    const row = Object.fromEntries([["__proto__", "safe-value"]]);

    expect(readCompiledColumnValue(column!, row)).toEqual({
      own: true,
      value: "safe-value",
    });
  });
});
