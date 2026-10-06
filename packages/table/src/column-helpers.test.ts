import { describe, expect, it } from "vitest";

import { BrunoTableNumberColumn } from "./column-helpers";
import { compileColumns } from "./internal/compile-columns";

describe("BrunoTable Column Helper runtime capability guards", () => {
  it("rejects a non-function validator before returning a helper column", () => {
    expect(() =>
      Reflect.apply(BrunoTableNumberColumn, undefined, [
        {
          columnId: "COL_ID_INVALID_VALIDATE",
          field: "value",
          headerName: "Value",
          validate: "not-a-function",
        },
      ]),
    ).toThrow("validate must be a function");
    const direct = Reflect.apply(BrunoTableNumberColumn, undefined, [
      {
        columnId: "COL_ID_UNDEFINED_VALIDATE",
        field: "value",
        headerName: "Value",
        validate: undefined,
      },
    ]);
    expect(() => compileColumns([direct])).not.toThrow();

    const preset = Reflect.apply(BrunoTableNumberColumn.withDefaults, undefined, [
      { validate: undefined },
    ]);
    expect(typeof preset).toBe("function");
    if (typeof preset !== "function") throw new Error("Expected a Number Column preset.");
    const presetColumn = Reflect.apply(preset, undefined, [
      {
        columnId: "COL_ID_UNDEFINED_PRESET_VALIDATE",
        field: "value",
        headerName: "Preset value",
      },
    ]);
    expect(() => compileColumns([presetColumn])).not.toThrow();
  });

  it("rejects validation without effective potential editability", () => {
    const validate = () => undefined;
    expect(() =>
      Reflect.apply(BrunoTableNumberColumn, undefined, [
        {
          columnId: "COL_ID_READ_ONLY_VALIDATE",
          field: "value",
          headerName: "Read-only validate",
          validate,
        },
      ]),
    ).toThrow("validate requires potential field editability");

    expect(() =>
      Reflect.apply(BrunoTableNumberColumn.withDefaults, undefined, [{ validate }]),
    ).toThrow("preset validate requires potential editability");

    const preset = Reflect.apply(BrunoTableNumberColumn.withDefaults, undefined, [
      { isEditable: true, validate },
    ]) as (...arguments_: unknown[]) => unknown;
    expect(() =>
      Reflect.apply(preset, undefined, [
        {
          columnId: "COL_ID_DISABLED_VALIDATE",
          field: "value",
          headerName: "Disabled validate",
          isEditable: false,
        },
      ]),
    ).toThrow("validate requires potential field editability");
  });
});
