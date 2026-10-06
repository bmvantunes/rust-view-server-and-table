import { detectPlatform } from "@tanstack/react-hotkeys";
import * as BigDecimal from "effect/BigDecimal";
import { Component, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import {
  BrunoTableClient,
  BrunoTableTextColumn,
  BrunoTableNumberColumn,
  BrunoTableBigIntColumn,
  BrunoTableBooleanColumn,
  BrunoTableSelectColumn,
  type BrunoTableColumns,
} from "./index";
import { BrunoTableBigDecimalColumn } from "./effect";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

class ConfigurationBoundary extends Component<
  { children: ReactNode },
  { error: string | undefined }
> {
  override state = { error: undefined as string | undefined };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    return this.state.error === undefined ? (
      this.props.children
    ) : (
      <p role="alert">{this.state.error}</p>
    );
  }
}

test.each([
  { override: { columnId: "" }, message: "columnId must start with COL_ID_" },
  { override: { headerName: "  " }, message: "headerName must be a non-empty string" },
])("public Table rejects malformed helper metadata: $message", async ({ override, message }) => {
  type Row = { id: string; text: string };
  const invalid: unknown = Reflect.apply(BrunoTableTextColumn, undefined, [
    {
      columnId: "COL_ID_TEXT",
      field: "text",
      headerName: "Text",
      ...override,
    },
  ]);
  const screen = await render(
    <ConfigurationBoundary>
      <BrunoTableClient
        tableId="TABLE_ID_INVALID_HELPER_METADATA"
        columns={[invalid] as BrunoTableColumns<Row>}
        initialOrderBy={[{ columnId: "COL_ID_TEXT", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows: [], totalRows: 0, version: 0, status: "ready" }}
      />
    </ConfigurationBoundary>,
  );
  await expect.element(screen.getByRole("alert")).toHaveTextContent(message);
});

test("public Table copies canonical helper values independently of custom presentation", async () => {
  type Row = {
    id: string;
    text: string;
    number: number;
    bigint: bigint;
    boolean: boolean;
    side: "Buy" | "Sell";
    decimal: BigDecimal.BigDecimal;
  };
  const columns = [
    BrunoTableTextColumn({
      columnId: "COL_ID_TEXT",
      field: "text",
      headerName: "Text",
      cellRenderer: () => "Text display",
    }),
    BrunoTableNumberColumn({
      columnId: "COL_ID_NUMBER",
      field: "number",
      headerName: "Number",
      cellRenderer: () => "Number display",
    }),
    BrunoTableBigIntColumn({
      columnId: "COL_ID_BIGINT",
      field: "bigint",
      headerName: "BigInt",
      cellRenderer: () => "BigInt display",
    }),
    BrunoTableBooleanColumn({
      columnId: "COL_ID_BOOLEAN",
      field: "boolean",
      headerName: "Boolean",
      cellRenderer: () => "Boolean display",
    }),
    BrunoTableSelectColumn({
      columnId: "COL_ID_SIDE",
      field: "side",
      headerName: "Side",
      options: ["Buy", "Sell"],
      cellRenderer: () => "Side display",
    }),
    BrunoTableBigDecimalColumn({
      columnId: "COL_ID_DECIMAL",
      field: "decimal",
      headerName: "Decimal",
      cellRenderer: () => "Decimal display",
    }),
  ] satisfies BrunoTableColumns<Row>;
  const writes = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const screen = await render(
    <div style={{ width: 1200, height: 400 }}>
      <BrunoTableClient
        tableId="TABLE_ID_HELPER_CANONICAL_COPY"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_TEXT", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{
          rows: [
            {
              id: "one",
              text: "Buy",
              number: 1.25,
              bigint: 9007199254740993n,
              boolean: false,
              side: "Sell",
              decimal: BigDecimal.make(900719925474099312345n, 3),
            },
          ],
          totalRows: 1,
          version: 0,
          status: "ready",
        }}
      />
    </div>,
  );
  for (const [name, canonical] of [
    ["Text display", "Buy"],
    ["Number display", "1.25"],
    ["BigInt display", "9007199254740993"],
    ["Boolean display", "false"],
    ["Side display", "Sell"],
    ["Decimal display", "900719925474099312.345"],
  ] as const) {
    await screen.getByRole("gridcell", { name, exact: true }).click();
    await userEvent.keyboard(
      detectPlatform() === "mac" ? "{Meta>}c{/Meta}" : "{Control>}c{/Control}",
    );
    await expect.poll(() => writes.mock.lastCall?.[0]).toBe(canonical);
  }
});

test("Select remains a nullable Group Key beside exact helper aggregates", async () => {
  type Row = { id: string; side: "Buy" | "Sell" | null; quantity: bigint };
  const columns = [
    BrunoTableSelectColumn({
      columnId: "COL_ID_SIDE",
      field: "side",
      headerName: "Side",
      options: ["Buy", "Sell"],
      groupBy: true,
      groupKeyValueFormatter: ({ value }) => value ?? "Unassigned",
    }),
    BrunoTableBigIntColumn({
      columnId: "COL_ID_QUANTITY",
      field: "quantity",
      headerName: "Quantity",
      aggFunc: "sum",
    }),
  ] satisfies BrunoTableColumns<Row>;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_SELECT_GROUP_KEY"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_SIDE", direction: "asc" }]}
      getRowId={(row) => row.id}
      clientSource={{
        rows: [
          { id: "one", side: "Buy", quantity: 9007199254740993n },
          { id: "two", side: "Buy", quantity: 2n },
          { id: "three", side: null, quantity: 7n },
        ],
        totalRows: 3,
        version: 0,
        status: "ready",
      }}
    />,
  );
  await screen.getByRole("combobox", { name: "Add Group" }).click();
  await page.getByRole("option", { name: "Side", exact: true }).click();
  await expect
    .element(screen.getByRole("gridcell", { name: "Unassigned", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("gridcell", { name: "9007199254740995", exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("columnheader", { name: /^Rows/u })).toBeVisible();
});
