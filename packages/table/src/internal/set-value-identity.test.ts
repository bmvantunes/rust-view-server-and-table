import { describe, expect, it } from "vitest";

import { compileColumns } from "./compile-columns";
import {
  brunoTableSetValueKey,
  createBrunoTableSetValueIndex,
  hasBrunoTableSetValue,
} from "./set-value-identity";

describe("BrunoTable Set value identity", () => {
  it("shares one nullish bucket while keeping an exact empty string distinct", () => {
    const column = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
      },
    ])[0]!;

    const keys = [null, undefined, ""].map((value) => brunoTableSetValueKey(column, value));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    const index = createBrunoTableSetValueIndex(column, [null, undefined, ""]);
    expect(index.size).toBe(2);
    expect(
      hasBrunoTableSetValue(column, createBrunoTableSetValueIndex(column, [null]), undefined),
    ).toBe(true);
    expect(
      hasBrunoTableSetValue(column, createBrunoTableSetValueIndex(column, [undefined]), null),
    ).toBe(true);
    expect(hasBrunoTableSetValue(column, createBrunoTableSetValueIndex(column, [null]), "")).toBe(
      false,
    );
  });
});
