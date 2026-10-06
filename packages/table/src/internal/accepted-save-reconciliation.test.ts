import { expect, test } from "vite-plus/test";
import { BrunoTableCellEditRuntime, type BrunoTableCellEditSaveChangeSet } from "./cell-edit";
import { compileColumns } from "./compile-columns";

test("accepted Immediate reconciliation reads only its changed row once and unlocks it", () => {
  const before: Readonly<{ value: string }> = Object.freeze({ value: "before" });
  const rows = new Map([
    ["a", before],
    ["b", before],
  ]);
  const reads: string[] = [];
  const runtime = new BrunoTableCellEditRuntime({
    columns: compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
        isEditable: true,
      },
    ]),
    getRow: (id) => {
      reads.push(id);
      return rows.get(id);
    },
  });
  const saveRow = (rowId: string): BrunoTableCellEditSaveChangeSet[number] => ({
    rowId,
    baseRow: before,
    expectedVersion: 1,
    changes: [{ columnId: "COL_ID_VALUE", field: "value", before: "before", after: "after" }],
  });
  const changes = [saveRow("a"), saveRow("b")] satisfies BrunoTableCellEditSaveChangeSet;
  try {
    expect(runtime.beginSaveOperation("operation", changes, false)).toBe(true);
    runtime.acceptSave("operation", changes, false);
    rows.set("a", Object.freeze({ value: "after" }));
    reads.length = 0;
    runtime.reconcileSourceRows(new Set(["a"]));
    expect(reads).toEqual(["a"]);
    expect(runtime.getAcceptedOverlayCountForOperation("operation")).toBe(1);
    expect(runtime.isEditable("a", "COL_ID_VALUE")).toBe(true);
    expect(runtime.isEditable("b", "COL_ID_VALUE")).toBe(false);
  } finally {
    runtime.dispose();
  }
});
