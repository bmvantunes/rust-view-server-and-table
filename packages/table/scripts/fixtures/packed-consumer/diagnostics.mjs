import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  BrunoTableClient,
  BrunoTableQuickFilter,
  BrunoTableTextColumn,
  BrunoTableToolbar,
} from "@bruno/table";

const columns = [
  BrunoTableTextColumn({ columnId: "COL_ID_NAME", field: "name", headerName: "Name" }),
];
const table = createElement(
  BrunoTableClient,
  {
    tableId: "TABLE_ID_DIAGNOSTICS_CONSUMER",
    columns,
    initialOrderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }],
    getRowId: (row) => row.name,
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
  ]) {
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
  Object.defineProperty(globalThis, "process", originalProcess);
}
console.log("Installed Table diagnostics require explicit development evidence.");
