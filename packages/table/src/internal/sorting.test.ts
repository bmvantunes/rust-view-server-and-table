import { describe, expect, it } from "vitest";

import { compileColumns } from "./compile-columns";
import { applyBrunoTableSortingCommand } from "./sorting";

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
    columnId: "COL_ID_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
    valueType: "bigint",
  },
  {
    columnId: "COL_ID_LOCKED",
    field: "locked",
    headerName: "Locked",
    valueType: "boolean",
    enableSorting: false,
  },
]);

const baseline = Object.freeze([
  Object.freeze({ columnId: "COL_ID_SCORE", direction: "asc" as const }),
]);

describe("BrunoTable sorting commands", () => {
  it("repairs an empty sorting-capable state before applying any command", () => {
    expect(
      applyBrunoTableSortingCommand([], [], columns, {
        type: "sorting.remove",
        columnId: "COL_ID_MISSING",
      }),
    ).toEqual([{ columnId: "COL_ID_NAME", direction: "asc" }]);
  });

  it("makes a plain new column the sole ascending priority-one sort", () => {
    expect(
      applyBrunoTableSortingCommand(baseline, baseline, columns, {
        type: "column.sort.toggle",
        columnId: "COL_ID_NAME",
        multi: false,
      }),
    ).toEqual([{ columnId: "COL_ID_NAME", direction: "asc" }]);
  });

  it("makes a plain existing column the sole priority-one sort and toggles its direction", () => {
    const current = Object.freeze([
      Object.freeze({ columnId: "COL_ID_NAME", direction: "desc" as const }),
      Object.freeze({ columnId: "COL_ID_SCORE", direction: "asc" as const }),
      Object.freeze({ columnId: "COL_ID_QUANTITY", direction: "desc" as const }),
    ]);

    expect(
      applyBrunoTableSortingCommand(current, baseline, columns, {
        type: "column.sort.toggle",
        columnId: "COL_ID_SCORE",
        multi: false,
      }),
    ).toEqual([{ columnId: "COL_ID_SCORE", direction: "desc" }]);
  });

  it("appends a Shift-activated new column and toggles an existing one in place", () => {
    const appended = applyBrunoTableSortingCommand(baseline, baseline, columns, {
      type: "column.sort.toggle",
      columnId: "COL_ID_NAME",
      multi: true,
    });
    expect(appended).toEqual([
      { columnId: "COL_ID_SCORE", direction: "asc" },
      { columnId: "COL_ID_NAME", direction: "asc" },
    ]);

    expect(
      applyBrunoTableSortingCommand(appended, baseline, columns, {
        type: "column.sort.toggle",
        columnId: "COL_ID_SCORE",
        multi: true,
      }),
    ).toEqual([
      { columnId: "COL_ID_SCORE", direction: "desc" },
      { columnId: "COL_ID_NAME", direction: "asc" },
    ]);
  });

  it("supports one through every sortable column without admitting nonsortable identities", () => {
    const two = applyBrunoTableSortingCommand(baseline, baseline, columns, {
      type: "sorting.add",
      columnId: "COL_ID_NAME",
    });
    const all = applyBrunoTableSortingCommand(two, baseline, columns, {
      type: "sorting.add",
      columnId: "COL_ID_QUANTITY",
    });
    const rejected = applyBrunoTableSortingCommand(all, baseline, columns, {
      type: "sorting.add",
      columnId: "COL_ID_LOCKED",
    });

    expect(all).toEqual([
      { columnId: "COL_ID_SCORE", direction: "asc" },
      { columnId: "COL_ID_NAME", direction: "asc" },
      { columnId: "COL_ID_QUANTITY", direction: "asc" },
    ]);
    expect(rejected).toBe(all);
  });

  it("removes only when another active sort remains", () => {
    expect(
      applyBrunoTableSortingCommand(baseline, baseline, columns, {
        type: "sorting.remove",
        columnId: "COL_ID_SCORE",
      }),
    ).toBe(baseline);

    const current = Object.freeze([
      baseline[0]!,
      Object.freeze({ columnId: "COL_ID_NAME", direction: "desc" as const }),
    ]);
    expect(
      applyBrunoTableSortingCommand(current, baseline, columns, {
        type: "sorting.remove",
        columnId: "COL_ID_SCORE",
      }),
    ).toEqual([{ columnId: "COL_ID_NAME", direction: "desc" }]);
  });

  it("reorders priorities accessibly and rejects out-of-range no-op moves", () => {
    const current = Object.freeze([
      baseline[0]!,
      Object.freeze({ columnId: "COL_ID_NAME", direction: "desc" as const }),
      Object.freeze({ columnId: "COL_ID_QUANTITY", direction: "asc" as const }),
    ]);
    expect(
      applyBrunoTableSortingCommand(current, baseline, columns, {
        type: "sorting.move",
        columnId: "COL_ID_QUANTITY",
        targetIndex: 0,
      }),
    ).toEqual([
      { columnId: "COL_ID_QUANTITY", direction: "asc" },
      { columnId: "COL_ID_SCORE", direction: "asc" },
      { columnId: "COL_ID_NAME", direction: "desc" },
    ]);
    expect(
      applyBrunoTableSortingCommand(current, baseline, columns, {
        type: "sorting.move",
        columnId: "COL_ID_MISSING",
        targetIndex: 0,
      }),
    ).toBe(current);
  });

  it("restores the original baseline with frozen state", () => {
    const current = Object.freeze([
      Object.freeze({ columnId: "COL_ID_NAME", direction: "desc" as const }),
    ]);
    const reset = applyBrunoTableSortingCommand(current, baseline, columns, {
      type: "sorting.reset",
    });

    expect(reset).toEqual(baseline);
    expect(Object.isFrozen(reset)).toBe(true);
    expect(Object.isFrozen(reset[0])).toBe(true);
  });
});
