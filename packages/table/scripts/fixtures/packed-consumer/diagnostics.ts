import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  BrunoTableClient,
  type BrunoTableColumns,
  BrunoTableQuickFilter,
  BrunoTableTextColumn,
  BrunoTableToolbar,
} from "@bruno/table";

type Row = { name: string };
const columns = [
  BrunoTableTextColumn({ columnId: "COL_ID_NAME", field: "name", headerName: "Name" }),
] satisfies BrunoTableColumns<Row>;
const table = createElement(
  BrunoTableClient<Row, typeof columns>,
  {
    tableId: "TABLE_ID_DIAGNOSTICS_CONSUMER",
    columns,
    initialOrderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }],
    getRowId: (row: Row) => row.name,
    clientSource: { rows: [], totalRows: 0, version: 1, status: "ready" },
  },
  createElement(BrunoTableToolbar, null, createElement(BrunoTableQuickFilter)),
);

// Dependencies load normally; only the consumer's runtime environment changes.
// Exercise the installed public Table, not a copied diagnostic expression.
const originalProcess = Object.getOwnPropertyDescriptor(globalThis, "process");
try {
  for (const [label, environment, diagnosticExpected] of [
    ["absent process", undefined, false],
    ["absent environment", {}, false],
    ["absent NODE_ENV", { env: {} }, false],
    ["production", { env: { NODE_ENV: "production" } }, false],
    ["test is not development", { env: { NODE_ENV: "test" } }, false],
    ["development", { env: { NODE_ENV: "development" } }, true],
  ] as const) {
    Object.defineProperty(globalThis, "process", { configurable: true, value: environment });
    if (diagnosticExpected) {
      assert.throws(
        () => renderToString(table),
        /BrunoTableQuickFilter requires BrunoTableClient quickFilterFields/u,
        label,
      );
    } else {
      assert.doesNotThrow(() => renderToString(table), label);
    }
  }
} finally {
  if (originalProcess) Object.defineProperty(globalThis, "process", originalProcess);
  else Reflect.deleteProperty(globalThis, "process");
}
console.log("Installed Table diagnostics require explicit development evidence.");
