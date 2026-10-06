import { detectPlatform, getHotkeyManager } from "@tanstack/react-hotkeys";
import * as BigDecimal from "effect/BigDecimal";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import {
  BrunoTableClient,
  BrunoTableFilterControl,
  BrunoTableQuickFilter,
  BrunoTableToolbar,
} from "./index";
import { BrunoTableBigDecimalColumn } from "./effect";
import { BrunoTableAggregateAlgebra } from "./public-types";
import type { BrunoTableColumns, BrunoTablePersistedState } from "./public-types";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import { BRUNO_TABLE_GROUP_BY_HOTKEY_REGISTRATION_COUNT } from "./internal/hotkey-adapter";
import {
  installBrunoTableClientCellRenderListenerForTable,
  installBrunoTableClientGridSurfaceRenderListenerForTable,
  installBrunoTableClientRowOrderPlanningListener,
  installBrunoTableClientSortPanelRenderListenerForTable,
} from "./internal/render-instrumentation";

type GroupRow = Readonly<{
  id: string;
  desk: string;
  region: string;
  quantity: bigint;
  price: number;
}>;

const columns = [
  {
    columnId: "COL_ID_DESK",
    field: "desk",
    headerName: "Desk",
    valueType: "text",
    groupBy: true,
    valueFormatter: ({ row, value }) => {
      if ("rowCount" in row) throw new TypeError("Raw Desk formatter received a grouped row.");
      return value;
    },
    groupKeyValueFormatter: ({ value, rowCount }) => `${value} (${String(rowCount)})`,
  },
  {
    columnId: "COL_ID_REGION",
    field: "region",
    headerName: "Region",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
    valueType: "bigint",
    aggFunc: "sum",
    aggregateValueFormatter: ({ value }) => `${value.toString()} units`,
  },
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Maximum price",
    valueType: "number",
    aggFunc: "max",
  },
] satisfies BrunoTableColumns<GroupRow>;

const rows: readonly GroupRow[] = Object.freeze([
  { id: "1", desk: "Alpha", region: "East", quantity: 2n, price: 1.25 },
  { id: "2", desk: "Alpha", region: "West", quantity: 3n, price: 4.5 },
  { id: "3", desk: "Beta", region: "East", quantity: 5n, price: 2.75 },
]);

type ExactDecimalGroupRow = Readonly<{
  id: string;
  desk: string;
  amount: BigDecimal.BigDecimal;
}>;

const exactDecimalColumns = [
  {
    columnId: "COL_ID_DECIMAL_DESK",
    field: "desk",
    headerName: "Desk",
    valueType: "text",
    groupBy: true,
  },
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_DECIMAL_SUM",
    field: "amount",
    headerName: "Total amount",
    aggFunc: "sum",
    aggregateValueFormatter: ({ value }) => `sum ${BigDecimal.format(value)}`,
  }),
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_DECIMAL_AVG",
    field: "amount",
    headerName: "Average amount",
    aggFunc: "avg",
    aggregateValueFormatter: ({ value }) => `avg ${BigDecimal.format(value)}`,
  }),
] satisfies BrunoTableColumns<ExactDecimalGroupRow>;

const exactDecimalRows = Object.freeze([
  { id: "a-1", desk: "Alpha", amount: BigDecimal.fromStringUnsafe("0.1") },
  { id: "a-2", desk: "Alpha", amount: BigDecimal.fromStringUnsafe("0.2") },
  { id: "b-1", desk: "Beta", amount: BigDecimal.fromStringUnsafe("1") },
  { id: "b-2", desk: "Beta", amount: BigDecimal.fromStringUnsafe("0") },
  { id: "b-3", desk: "Beta", amount: BigDecimal.fromStringUnsafe("0") },
]);

let removeProjectionListener = (): void => undefined;

afterEach(async () => {
  removeProjectionListener();
  removeProjectionListener = () => undefined;
  await cleanup();
  await settleBrunoTableBrowserFrames();
});

describe("BrunoTableClient grouping and aggregation", () => {
  test("retains a coherent grouped epoch through a stale aggregate failure and recovers atomically", async () => {
    type Credit = Readonly<{ readonly units: bigint }>;
    type CreditRow = Readonly<{
      readonly id: string;
      readonly group: string;
      readonly credit: Credit;
    }>;
    let rejectAggregate = false;
    const creditColumns = [
      {
        columnId: "COL_ID_GROUP",
        field: "group",
        headerName: "Group",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_CREDIT",
        field: "credit",
        headerName: "Credit",
        valueType: {
          codecId: "test/browser-credit",
          codecVersion: 1,
          filterFamily: "numeric",
          editorFamily: "text",
          cellAlign: "end",
          editorLayout: "inline",
          defaultWidth: 120,
          aggregateResults: { avg: "self" },
          aggregateAlgebra: BrunoTableAggregateAlgebra<Credit>({
            add: (left, right) => ({ units: left.units + right.units }),
            divideByCount: (total, count) => {
              if (rejectAggregate) throw new Error("hostile aggregate");
              return { units: total.units / count };
            },
          }),
          decodeRuntime: (input: unknown) =>
            typeof input === "object" &&
            input !== null &&
            "units" in input &&
            typeof input.units === "bigint"
              ? { _tag: "Success" as const, value: input as Credit }
              : { _tag: "Failure" as const, message: "Expected Credit." },
          equivalent: (left: Credit, right: Credit) => left.units === right.units,
          compare: (left: Credit, right: Credit) =>
            left.units === right.units ? 0 : left.units < right.units ? -1 : 1,
          formatCanonicalText: (value: Credit) => value.units.toString(),
          parseCanonicalText: (text: string) => ({
            _tag: "Success" as const,
            value: { units: BigInt(text) },
          }),
          formatDisplay: (value: Credit) => value.units.toString(),
          encodePersisted: (value: Credit) => value.units.toString(),
          decodePersisted: (input: unknown) =>
            typeof input === "string"
              ? { _tag: "Success" as const, value: { units: BigInt(input) } }
              : { _tag: "Failure" as const, message: "Expected persisted Credit." },
        },
        aggFunc: "avg",
        aggregateValueFormatter: ({ value }: { readonly value: Credit }) =>
          `${value.units.toString()} credits`,
      },
    ] satisfies BrunoTableColumns<CreditRow>;
    const initialRows: readonly CreditRow[] = [
      { id: "one", group: "A", credit: { units: 1n } },
      { id: "two", group: "A", credit: { units: 2n } },
    ];
    const renderTable = (
      sourceRows: readonly CreditRow[],
      version: number,
      status: "ready" | "stale",
    ) => (
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_AGGREGATE_FALLBACK"
        columns={creditColumns}
        initialOrderBy={[{ columnId: "COL_ID_GROUP", direction: "asc" }]}
        getRowId={(row) => row.id}
        rowSelection
        clientSource={{
          rows: sourceRows,
          totalRows: sourceRows.length,
          version,
          status,
          ...(status === "stale" ? { message: "Retaining the prior grouped result" } : {}),
        }}
      />
    );
    const screen = await render(renderTable(initialRows, 1, "ready"));
    await expect
      .element(page.getByRole("checkbox", { name: "Select all rows" }))
      .toBeInTheDocument();
    await chooseGroup("Group");
    expect(page.getByRole("checkbox", { name: "Select all rows" }).all()).toHaveLength(0);
    await expect.element(page.getByRole("gridcell", { name: "1 credits" })).toBeInTheDocument();

    rejectAggregate = true;
    const rejectedRows: readonly CreditRow[] = [
      initialRows[0]!,
      { id: "two", group: "A", credit: { units: 4n } },
    ];
    await screen.rerender(renderTable(rejectedRows, 2, "stale"));
    await expect.element(page.getByRole("gridcell", { name: "1 credits" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Retaining the prior grouped result");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Grouped result, column COL_ID_CREDIT");

    rejectAggregate = false;
    const recoveredRows: readonly CreditRow[] = [
      initialRows[0]!,
      { id: "two", group: "A", credit: { units: 5n } },
    ];
    await screen.rerender(renderTable(recoveredRows, 3, "ready"));
    await expect.element(page.getByRole("gridcell", { name: "3 credits" })).toBeInTheDocument();

    rejectAggregate = true;
    await screen.rerender(renderTable(rejectedRows, 4, "ready"));
    await expect
      .element(page.getByRole("grid", { name: "Data for TABLE_ID_GROUPED_AGGREGATE_FALLBACK" }))
      .not.toBeInTheDocument();
    expect(page.getByRole("checkbox", { name: "Select all rows" }).all()).toHaveLength(0);
    expect(page.getByRole("checkbox", { name: /Select row/u }).all()).toHaveLength(0);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Grouped result, column COL_ID_CREDIT");

    rejectAggregate = false;
    await screen.rerender(renderTable(recoveredRows, 5, "ready"));
    await expect.element(page.getByRole("gridcell", { name: "3 credits" })).toBeInTheDocument();
    expect(page.getByRole("checkbox", { name: "Select all rows" }).all()).toHaveLength(0);
    expect(page.getByRole("checkbox", { name: /Select row/u }).all()).toHaveLength(0);
  });

  test("groups the filtered resident result and exposes accessible add, remove, and reorder commands", async () => {
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_CLIENT_GROUPING"
        columns={columns}
        initialFilters={[{ columnId: "COL_ID_QUANTITY", type: "greaterThan", filter: 2n }]}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        groupRowsColumn={{ headerName: "Orders", width: 112 }}
      />,
    );
    await settleBrunoTableBrowserFrames();
    const committedProjections: string[][] = [];
    removeProjectionListener = installBrunoTableClientGridSurfaceRenderListenerForTable(
      "TABLE_ID_CLIENT_GROUPING",
      () => committedProjections.push(readCommittedHeaderProjection()),
    );
    let previousProjection: readonly string[] = ["Desk", "Region", "Quantity", "Maximum price"];
    const expectCommittedProjection = async (expected: readonly string[]) => {
      await settleBrunoTableBrowserFrames();
      expect(committedProjections.length).toBeGreaterThan(0);
      for (const projection of committedProjections) {
        expect(projection.length).toBeGreaterThan(0);
        expect(
          isOrderedSubsequence(projection, previousProjection) ||
            isOrderedSubsequence(projection, expected),
          JSON.stringify({ projection, previousProjection, expected }),
        ).toBe(true);
      }
      expect(isOrderedSubsequence(readCommittedHeaderProjection(), expected)).toBe(true);
      previousProjection = expected;
      committedProjections.length = 0;
    };

    const groupRegion = page.getByRole("region", { name: "Group By" });
    const groupRegionElement = groupRegion.element();
    const addGroup = groupRegion.getByRole("combobox", { name: "Add Group" });
    await userEvent.click(page.getByRole("button", { name: "Column menu for Desk" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Group by Desk" }));
    await expectCommittedProjection(["Desk", "Orders", "Quantity", "Maximum price"]);
    await expect.element(page.getByRole("button", { name: "Column menu for Desk" })).toHaveFocus();
    expect(activeGridCellText()).toBe("Alpha (1)");
    await expect.element(page.getByRole("columnheader", { name: /Desk/u })).toBeInTheDocument();
    await expect.element(page.getByRole("columnheader", { name: /Orders/u })).toBeInTheDocument();
    await expect.element(page.getByRole("gridcell", { name: "Alpha (1)" })).toBeInTheDocument();
    await expect.element(page.getByRole("gridcell", { name: "3 units" })).toBeInTheDocument();
    expect(page.getByRole("gridcell", { name: "1", exact: true }).all()).toHaveLength(2);
    const reorderInstructions = groupRegion.getByRole("note");
    await expect.element(reorderInstructions).toBeVisible();
    await expect
      .element(reorderInstructions)
      .toHaveTextContent(
        "Reorder a group with Alt+Left Arrow or Alt+Right Arrow while its chip is focused.",
      );
    await expect
      .element(groupRegion.getByRole("button", { name: /Desk, position 1 of 1/u }))
      .toHaveAccessibleDescription(
        "Reorder a group with Alt+Left Arrow or Alt+Right Arrow while its chip is focused.",
      );

    const grid = page.getByRole("grid");
    grid.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await expect
      .element(page.getByRole("gridcell", { name: "1", exact: true }).first())
      .toHaveAttribute("aria-selected", "true");
    await userEvent.click(addGroup);
    await userEvent.click(page.getByRole("option", { name: "Region", exact: true }));
    await expectCommittedProjection(["Desk", "Region", "Orders", "Quantity", "Maximum price"]);
    await vi.waitFor(() => expect(document.activeElement).toBe(addGroup.element()));
    expect(activeGridCellText()).toBe("Alpha (1)");
    await expect
      .element(page.getByRole("gridcell", { name: "West", exact: true }))
      .not.toHaveAttribute("aria-selected");
    const regionChip = groupRegion.getByRole("button", { name: /Region, position 2 of 2/u });
    const groupingRegistrations = [...getHotkeyManager().registrations.state.values()].filter(
      (registration) =>
        registration.target === groupRegion.element() &&
        (registration.hotkey === "Alt+ArrowLeft" || registration.hotkey === "Alt+ArrowRight"),
    );
    expect(groupingRegistrations).toHaveLength(BRUNO_TABLE_GROUP_BY_HOTKEY_REGISTRATION_COUNT);
    grid.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await userEvent.click(regionChip);
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    await expectCommittedProjection(["Region", "Desk", "Orders", "Quantity", "Maximum price"]);
    expect(activeGridCellText()).toBe("West");
    expect(groupRegion.getByRole("button", { name: /Region, position 1 of 2/u }).element()).toBe(
      document.activeElement,
    );
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Region moved to position 1 of 2");
    await expect
      .element(page.getByRole("gridcell", { name: "Alpha (1)", exact: true }))
      .not.toHaveAttribute("aria-selected");

    grid.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await userEvent.click(groupRegion.getByRole("button", { name: /Region, position 1 of 2/u }));
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await expectCommittedProjection(["Desk", "Region", "Orders", "Quantity", "Maximum price"]);
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Region moved to position 2 of 2");
    await expect
      .element(page.getByRole("gridcell", { name: "West", exact: true }))
      .not.toHaveAttribute("aria-selected");
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(readCommittedHeaderProjection()).toEqual([
      "Desk",
      "Region",
      "Orders",
      "Quantity",
      "Maximum price",
    ]);

    await userEvent.click(page.getByRole("button", { name: "Column menu for Region" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Remove Region from grouping" }));
    await expectCommittedProjection(["Desk", "Orders", "Quantity", "Maximum price"]);
    await expect
      .element(page.getByRole("log", { name: "Table interaction status" }))
      .toHaveTextContent("Region removed from Group By, 1 group remaining");
    await expect
      .element(groupRegion.getByRole("button", { name: /Desk, position 1 of 1/u }))
      .toHaveFocus();
    expect(activeGridCellText()).toBe("Alpha (1)");

    await chooseGroup("Region");
    await expectCommittedProjection(["Desk", "Region", "Orders", "Quantity", "Maximum price"]);

    grid.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await userEvent.click(groupRegion.getByRole("button", { name: "Remove Region from Group By" }));
    await expectCommittedProjection(["Desk", "Orders", "Quantity", "Maximum price"]);
    expect(activeGridCellText()).toBe("Alpha (1)");
    await expect
      .element(page.getByRole("gridcell", { name: "1", exact: true }).first())
      .not.toHaveAttribute("aria-selected");
    await expect
      .element(groupRegion.getByRole("button", { name: /Desk, position 1 of 1/u }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Region removed from Group By, 1 group remaining");

    grid.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await userEvent.click(page.getByRole("button", { name: "Column menu for Desk" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Remove Desk from grouping" }));
    await expectCommittedProjection(["Desk", "Region", "Quantity", "Maximum price"]);
    await vi.waitFor(() => expect(document.activeElement).toBe(addGroup.element()));
    await expect
      .element(page.getByRole("log", { name: "Table interaction status" }))
      .toHaveTextContent("Desk removed from Group By, 0 groups remaining");
    expect(activeGridCellText()).toBe("Alpha");
    await expect.element(page.getByRole("columnheader", { name: /Region/u })).toBeInTheDocument();
    await expect
      .element(page.getByRole("columnheader", { name: /Orders/u }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("gridcell", { name: "East", exact: true }).first())
      .not.toHaveAttribute("aria-selected");
    await screen.unmount();
    expect(
      [...getHotkeyManager().registrations.state.values()].filter(
        (registration) => registration.target === groupRegionElement,
      ),
    ).toHaveLength(0);
  });

  test("atomically replaces same-identity aggregate result and formatter semantics", async () => {
    const initialColumns = columns.map((column) =>
      column.columnId === "COL_ID_QUANTITY"
        ? {
            ...column,
            aggFunc: "sum" as const,
            aggregateValueFormatter: ({ value }: { readonly value: bigint }) => {
              if (value !== 5n) throw new TypeError("Old sum formatter received a new epoch.");
              return `${value.toString()} old-sum`;
            },
          }
        : column,
    ) satisfies BrunoTableColumns<GroupRow>;
    const replacementColumns = columns.map((column) =>
      column.columnId === "COL_ID_QUANTITY"
        ? {
            ...column,
            aggFunc: "max" as const,
            aggregateValueFormatter: ({ value }: { readonly value: bigint }) => {
              if (value !== 3n && value !== 5n) {
                throw new TypeError("New max formatter received an invalid epoch.");
              }
              return `${value.toString()} new-max`;
            },
          }
        : column,
    ) satisfies BrunoTableColumns<GroupRow>;
    const renderTable = (activeColumns: BrunoTableColumns<GroupRow>) => (
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_PRESENTATION_EPOCH"
        columns={activeColumns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      />
    );
    const screen = await render(renderTable(initialColumns));
    await chooseGroup("Desk");
    expect(page.getByRole("gridcell", { name: "5 old-sum" }).all()).toHaveLength(2);
    const grid = page.getByRole("grid").element();

    await screen.rerender(renderTable(replacementColumns));

    await expect.element(page.getByRole("gridcell", { name: "3 new-max" })).toBeInTheDocument();
    await expect.element(page.getByRole("gridcell", { name: "5 new-max" })).toBeInTheDocument();
    expect(page.getByRole("grid").element()).toBe(grid);
    expect(page.getByRole("gridcell", { name: "5 old-sum" }).all()).toHaveLength(0);
  });

  test("keeps grouping coordination alive across ready, loading, and ready", async () => {
    const renderTable = (
      source: Readonly<{
        readonly rows: readonly GroupRow[];
        readonly totalRows: number;
        readonly version: number;
        readonly status: "ready" | "loading";
      }>,
    ) => (
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_LIFECYCLE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        rowSelection
        clientSource={source}
      />
    );
    const screen = await render(
      renderTable({ rows, totalRows: rows.length, version: 1, status: "ready" }),
    );
    await expect
      .element(page.getByRole("checkbox", { name: "Select all rows" }))
      .toBeInTheDocument();
    await chooseGroup("Desk");
    await expect.element(page.getByRole("gridcell", { name: "Alpha (2)" })).toBeInTheDocument();

    await screen.rerender(
      renderTable({ rows: [], totalRows: rows.length, version: 2, status: "loading" }),
    );
    const loadingGrid = page.getByRole("grid", { name: "Loading table rows" });
    await expect.element(loadingGrid).toBeInTheDocument();
    await expect
      .element(loadingGrid.getByRole("gridcell", { name: "Loading Rows" }).first())
      .toBeInTheDocument();
    expect(loadingGrid.getByRole("gridcell", { name: "Loading Desk" }).all()).toHaveLength(
      rows.length,
    );
    expect(loadingGrid.getByRole("gridcell", { name: "Loading Rows" }).all()).toHaveLength(
      rows.length,
    );
    expect(loadingGrid.getByRole("gridcell", { name: "Loading Quantity" }).all()).toHaveLength(
      rows.length,
    );
    expect(loadingGrid.getByRole("gridcell", { name: "Loading Maximum price" }).all()).toHaveLength(
      rows.length,
    );
    expect(loadingGrid.getByRole("gridcell", { name: "Loading Region" }).all()).toHaveLength(0);
    expect(page.getByRole("gridcell", { name: "Row selection loading" }).all()).toHaveLength(0);

    const recoveredRows = Object.freeze([
      ...rows,
      { id: "4", desk: "Alpha", region: "North", quantity: 7n, price: 8 },
    ]);
    await screen.rerender(
      renderTable({
        rows: recoveredRows,
        totalRows: recoveredRows.length,
        version: 3,
        status: "ready",
      }),
    );

    await expect.element(page.getByRole("gridcell", { name: "Alpha (3)" })).toBeInTheDocument();
    await expect.element(page.getByRole("gridcell", { name: "12 units" })).toBeInTheDocument();
  });

  test("restores grouping while initially loading and installs the first ready projection", async () => {
    const tableId = "TABLE_ID_GROUPED_INITIAL_LOADING";
    const persisted = {
      version: 1 as const,
      tableId,
      filters: [],
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" as const }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" as const }],
      columnOrder: ["COL_ID_DESK", "COL_ID_REGION", "COL_ID_QUANTITY", "COL_ID_PRICE"],
      columnVisibility: {
        COL_ID_DESK: true,
        COL_ID_REGION: true,
        COL_ID_QUANTITY: true,
        COL_ID_PRICE: true,
      },
      columnWidths: {},
      columnPinning: { start: [], end: [] },
    } satisfies BrunoTablePersistedState<GroupRow, typeof columns, true>;
    const renderTable = (status: "loading" | "ready", version: number) => (
      <BrunoTableClient
        tableId={tableId}
        columns={columns}
        initialPersistedState={persisted}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        rowSelection
        clientSource={{
          rows: status === "ready" ? rows : [],
          totalRows: rows.length,
          version,
          status,
        }}
      />
    );
    const screen = await render(renderTable("loading", 1));
    const loadingGrid = page.getByRole("grid", { name: "Loading table rows" });
    await expect.element(loadingGrid).toBeInTheDocument();
    await expect
      .element(loadingGrid.getByRole("gridcell", { name: "Loading Rows" }).first())
      .toBeInTheDocument();
    expect(loadingGrid.getByRole("gridcell", { name: "Loading Desk" }).all()).toHaveLength(
      rows.length,
    );
    expect(loadingGrid.getByRole("gridcell", { name: "Loading Rows" }).all()).toHaveLength(
      rows.length,
    );
    expect(loadingGrid.getByRole("gridcell", { name: "Loading Quantity" }).all()).toHaveLength(
      rows.length,
    );
    expect(loadingGrid.getByRole("gridcell", { name: "Loading Maximum price" }).all()).toHaveLength(
      rows.length,
    );
    expect(loadingGrid.getByRole("gridcell", { name: "Loading Region" }).all()).toHaveLength(0);
    expect(page.getByRole("gridcell", { name: "Row selection loading" }).all()).toHaveLength(0);

    await screen.rerender(renderTable("ready", 2));

    await expect.element(page.getByRole("gridcell", { name: "Alpha (2)" })).toBeInTheDocument();
    expect(page.getByRole("gridcell", { name: "5 units" }).all()).toHaveLength(2);
    expect(page.getByRole("grid").element().getAttribute("aria-activedescendant")).toBeNull();
    expect(readCommittedHeaderProjection()).toEqual(["Desk", "Rows", "Quantity", "Maximum price"]);
  });

  test("resets Active when grouping is commanded before the first ready rows viewport", async () => {
    const renderTable = (status: "loading" | "ready", version: number) => (
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_DURING_INITIAL_LOADING"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{
          rows: status === "ready" ? rows : [],
          totalRows: rows.length,
          version,
          status,
        }}
      />
    );
    const screen = await render(renderTable("loading", 1));
    const addGroup = page
      .getByRole("region", { name: "Group By" })
      .getByRole("combobox", { name: "Add Group" });

    await chooseGroup("Desk");
    await vi.waitFor(() => expect(document.activeElement).toBe(addGroup.element()));
    await screen.rerender(renderTable("ready", 2));

    await expect.element(page.getByRole("gridcell", { name: "Alpha (2)" })).toBeInTheDocument();
    expect(activeGridCellText()).toBe("Alpha (2)");
    expect(document.activeElement).toBe(addGroup.element());
  });

  test("clears the current row-selection capability after it is toggled", async () => {
    const renderTable = (rowSelection: true | undefined) => (
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_SELECTION_TOGGLE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        {...(rowSelection === true ? { rowSelection } : {})}
      />
    );
    const screen = await render(renderTable(true));
    await userEvent.click(page.getByRole("checkbox", { name: "Select row 1", exact: true }));
    await screen.rerender(renderTable(undefined));
    await screen.rerender(renderTable(true));
    await expect
      .element(page.getByRole("checkbox", { name: "Select row 1", exact: true }))
      .not.toBeChecked();

    await page
      .getByRole("checkbox", { name: "Select row 2", exact: true })
      .click({ modifiers: ["Shift"] });
    await expect
      .element(page.getByRole("checkbox", { name: "Select row 1", exact: true }))
      .not.toBeChecked();
    await expect
      .element(page.getByRole("checkbox", { name: "Select row 2", exact: true }))
      .toBeChecked();

    await chooseGroup("Desk");
    await userEvent.click(page.getByRole("button", { name: "Remove Desk from Group By" }));

    await expect
      .element(page.getByRole("checkbox", { name: "Select row 1", exact: true }))
      .not.toBeChecked();
    await expect
      .element(page.getByRole("checkbox", { name: "Select row 2", exact: true }))
      .not.toBeChecked();
  });

  test("atomically removes an active key when live column definitions revoke eligibility", async () => {
    const replacementColumns = columns.map((column) =>
      column.columnId === "COL_ID_DESK"
        ? {
            columnId: "COL_ID_DESK" as const,
            field: "desk" as const,
            headerName: "Desk",
            valueType: "text" as const,
            valueFormatter: ({
              row,
              value,
            }: {
              readonly row: GroupRow;
              readonly value: string;
            }) => {
              if ("rowCount" in row) {
                throw new TypeError("Raw Desk formatter received a grouped row.");
              }
              return value;
            },
          }
        : column,
    ) satisfies BrunoTableColumns<GroupRow>;
    const renderTable = (activeColumns: BrunoTableColumns<GroupRow>) => (
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_ACTIVE_KEY_REMOVAL"
        columns={activeColumns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      />
    );
    const screen = await render(renderTable(columns));
    await chooseGroup("Desk");
    const committedProjections: string[][] = [];
    removeProjectionListener = installBrunoTableClientGridSurfaceRenderListenerForTable(
      "TABLE_ID_GROUPED_ACTIVE_KEY_REMOVAL",
      () => committedProjections.push(readCommittedHeaderProjection()),
    );

    await screen.rerender(renderTable(replacementColumns));
    await settleBrunoTableBrowserFrames();

    expect(committedProjections.length).toBeGreaterThan(0);
    for (const projection of committedProjections) {
      expect(projection.length).toBeGreaterThan(0);
      expect(
        isOrderedSubsequence(projection, ["Desk", "Rows", "Quantity", "Maximum price"]) ||
          isOrderedSubsequence(projection, ["Desk", "Region", "Quantity", "Maximum price"]),
        JSON.stringify(projection),
      ).toBe(true);
    }
    expect(readCommittedHeaderProjection()).toEqual([
      "Desk",
      "Region",
      "Quantity",
      "Maximum price",
    ]);
    expect(page.getByRole("button", { name: /Desk, position/u }).all()).toHaveLength(0);
    await expect.element(page.getByRole("gridcell", { name: "Alpha" }).first()).toBeInTheDocument();
  });

  test("promotes a hidden active key and restores its dormant visibility on final ungroup", async () => {
    const tableId = "TABLE_ID_GROUPED_HIDDEN_KEY";
    const persisted = {
      version: 1 as const,
      tableId,
      filters: [],
      orderBy: [{ columnId: "COL_ID_QUANTITY", direction: "asc" as const }],
      groupBy: [],
      groupOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" as const }],
      columnOrder: ["COL_ID_DESK", "COL_ID_REGION", "COL_ID_QUANTITY", "COL_ID_PRICE"],
      columnVisibility: {
        COL_ID_DESK: false,
        COL_ID_REGION: true,
        COL_ID_QUANTITY: true,
        COL_ID_PRICE: true,
      },
      columnWidths: {},
      columnPinning: { start: [], end: [] },
    } satisfies BrunoTablePersistedState<GroupRow, typeof columns>;
    await render(
      <BrunoTableClient
        tableId={tableId}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_QUANTITY", direction: "asc" }]}
        initialPersistedState={persisted}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      />,
    );
    expect(page.getByRole("columnheader", { name: /Desk/u }).all()).toHaveLength(0);

    await chooseGroup("Desk");
    await expect.element(page.getByRole("columnheader", { name: /Desk/u })).toBeInTheDocument();
    expect(readCommittedHeaderProjection()).toEqual(["Desk", "Rows", "Quantity", "Maximum price"]);

    await userEvent.click(page.getByRole("button", { name: "Remove Desk from Group By" }));
    await settleBrunoTableBrowserFrames();
    expect(page.getByRole("columnheader", { name: /Desk/u }).all()).toHaveLength(0);
    expect(readCommittedHeaderProjection()).toEqual(["Region", "Quantity", "Maximum price"]);
  });

  test("uses Rows presentation authority and limits grouped column menus to grouped capabilities", async () => {
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_MENU_CAPABILITIES"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        groupRowsColumn={{ headerName: "Orders", width: 112 }}
      />,
    );
    await chooseGroup("Desk");

    await userEvent.click(page.getByRole("button", { name: "Column menu for Desk" }));
    await expect
      .element(page.getByRole("menuitemradio", { name: "Pin to logical start" }))
      .toBeInTheDocument();
    expect(page.getByRole("menuitem", { name: "Move", exact: true }).all()).toHaveLength(0);
    await expect
      .element(page.getByRole("menuitem", { name: "Increase width" }))
      .toBeInTheDocument();
    await userEvent.click(page.getByRole("menuitem", { name: "Increase width" }));
    await expect
      .element(page.getByRole("separator", { name: "Resize Desk" }))
      .toHaveAttribute("aria-valuenow", "170");

    await userEvent.click(page.getByRole("button", { name: "Remove Desk from Group By" }));
    await chooseGroup("Desk");
    await expect
      .element(page.getByRole("separator", { name: "Resize Desk" }))
      .toHaveAttribute("aria-valuenow", "170");
    await userEvent.click(page.getByRole("button", { name: "Column menu for Desk" }));
    await userEvent.hover(page.getByRole("menuitem", { name: "Visibility", exact: true }));
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Quantity" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Maximum price" }))
      .toBeInTheDocument();
    expect(page.getByRole("menuitemcheckbox", { name: "Desk" }).all()).toHaveLength(0);
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Region" }))
      .toBeInTheDocument();
    await userEvent.hover(page.getByRole("menuitem", { name: "Reset", exact: true }));
    await expect.element(page.getByRole("menuitem", { name: "Reset widths" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: "Reset visibility" }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("menuitem", { name: "Reset pinning" })).toBeInTheDocument();
    expect(page.getByRole("menuitem", { name: "Reset order" }).all()).toHaveLength(0);
    expect(page.getByRole("menuitem", { name: "Reset complete layout" }).all()).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(page.getByRole("menu").all()).toHaveLength(0));

    await expect
      .element(page.getByRole("separator", { name: "Resize Quantity" }))
      .toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Column menu for Quantity" }));
    await expect
      .element(page.getByRole("menuitem", { name: "Increase width" }))
      .toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(page.getByRole("button", { name: "Column menu for Orders" }));
    await expect
      .element(page.getByRole("menuitem", { name: "Increase width" }))
      .toBeInTheDocument();
    await userEvent.click(page.getByRole("menuitem", { name: "Increase width" }));
    await expect
      .element(page.getByRole("separator", { name: "Resize Orders" }))
      .toHaveAttribute("aria-valuenow", "122");

    await userEvent.click(page.getByRole("button", { name: "Column menu for Desk" }));
    await userEvent.hover(page.getByRole("menuitem", { name: "Reset", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Reset widths" }));
    await expect
      .element(page.getByRole("separator", { name: "Resize Orders" }))
      .toHaveAttribute("aria-valuenow", "112");
    await vi.waitFor(() => expect(page.getByRole("menu").all()).toHaveLength(0));

    await userEvent.click(page.getByRole("button", { name: "Sort rows, 1 active" }));
    const sortPanel = page.getByRole("dialog", { name: "Sort rows" });
    await expect.element(sortPanel).toBeInTheDocument();
    await expect
      .element(
        sortPanel.getByRole("button", {
          name: "Toggle Desk direction, currently ascending",
        }),
      )
      .toBeInTheDocument();
    await userEvent.click(sortPanel.getByRole("combobox", { name: "Add sort column" }));
    await expect.element(page.getByRole("option", { name: "Orders" })).toBeInTheDocument();
  });

  test("restores exact durable order and pinning while Rows keeps persisted width across live presentation", async () => {
    const tableId = "TABLE_ID_GROUPED_LAYOUT_RESTORE";
    const persisted = {
      version: 1 as const,
      tableId,
      filters: [],
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" as const }],
      groupBy: [],
      groupOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "desc" as const }],
      columnOrder: ["COL_ID_PRICE", "COL_ID_DESK", "COL_ID_QUANTITY", "COL_ID_REGION"],
      columnVisibility: {
        COL_ID_PRICE: true,
        COL_ID_DESK: true,
        COL_ID_QUANTITY: true,
        COL_ID_REGION: true,
      },
      columnWidths: { COL_ID_BRUNO_TABLE_ROWS: 180 },
      columnPinning: { start: ["COL_ID_PRICE"], end: ["COL_ID_REGION"] },
    } satisfies BrunoTablePersistedState<GroupRow, typeof columns>;
    const renderTable = (headerName: string, width: number) => (
      <BrunoTableClient
        tableId={tableId}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        initialPersistedState={persisted}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        groupRowsColumn={{ headerName, width }}
      />
    );
    const screen = await render(renderTable("Orders", 112));
    await settleBrunoTableBrowserFrames();
    expect(readCommittedHeaderProjection()).toEqual([
      "Maximum price",
      "Desk",
      "Quantity",
      "Region",
    ]);
    await expect
      .element(page.getByRole("columnheader", { name: /Maximum price/u }))
      .toHaveAttribute("data-pinned-region", "start");
    await expect
      .element(page.getByRole("columnheader", { name: /Region/u }))
      .toHaveAttribute("data-pinned-region", "end");

    await chooseGroup("Desk");
    await settleBrunoTableBrowserFrames();
    expect(readCommittedHeaderProjection()).toEqual([
      "Desk",
      "Orders",
      "Maximum price",
      "Quantity",
    ]);
    await expect
      .element(page.getByRole("columnheader", { name: /Orders/u }))
      .toHaveAccessibleName(/width 180 pixels/u);

    await screen.rerender(renderTable("Trades", 140));
    await expect
      .element(page.getByRole("columnheader", { name: /Trades/u }))
      .toHaveAccessibleName(/width 180 pixels/u);
    await userEvent.click(page.getByRole("button", { name: "Sort rows, 1 active" }));
    await expect
      .element(
        page.getByRole("dialog", { name: "Sort rows" }).getByRole("button", {
          name: "Toggle Trades direction, currently descending",
        }),
      )
      .toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Sort rows, 1 active" }));

    await userEvent.click(page.getByRole("button", { name: "Column menu for Desk" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Remove Desk from grouping" }));
    await settleBrunoTableBrowserFrames();
    expect(readCommittedHeaderProjection()).toEqual([
      "Maximum price",
      "Desk",
      "Quantity",
      "Region",
    ]);
    await expect
      .element(page.getByRole("columnheader", { name: /Maximum price/u }))
      .toHaveAttribute("data-pinned-region", "start");
    await expect
      .element(page.getByRole("columnheader", { name: /Region/u }))
      .toHaveAttribute("data-pinned-region", "end");
  });

  test("sorts grouped rows through Rows and distinct same-field aggregate identities", async () => {
    const sortingColumns = [
      ...columns,
      {
        columnId: "COL_ID_QUANTITY_MAX",
        field: "quantity",
        headerName: "Maximum quantity",
        valueType: "bigint",
        aggFunc: "max",
      },
    ] satisfies BrunoTableColumns<GroupRow>;
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_SORTING"
        columns={sortingColumns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      />,
    );
    await chooseGroup("Desk");
    await expect
      .element(page.getByRole("row").nth(1).getByRole("gridcell").first())
      .toHaveTextContent("Alpha");
    await userEvent.click(page.getByRole("button", { name: /Sort by Rows/u }));
    await expect
      .element(page.getByRole("row").nth(1).getByRole("gridcell").first())
      .toHaveTextContent("Beta");
    await userEvent.click(page.getByRole("button", { name: /Sort by Rows/u }));
    await expect
      .element(page.getByRole("row").nth(1).getByRole("gridcell").first())
      .toHaveTextContent("Alpha");

    page
      .getByRole("button", { name: /Sort by Maximum quantity/u })
      .element()
      .focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("row").nth(1).getByRole("gridcell").first())
      .toHaveTextContent("Alpha");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("row").nth(1).getByRole("gridcell").first())
      .toHaveTextContent("Beta");
  });

  test("resets grouped Active and vertical scroll after user sort and Quick Filter commits", async () => {
    const manyRows = Object.freeze(
      Array.from(
        { length: 100 },
        (_unused, index): GroupRow => ({
          id: `query-row-${String(index)}`,
          desk: `Group ${String(index).padStart(3, "0")}`,
          region: index % 2 === 0 ? "East" : "West",
          quantity: BigInt(index + 1),
          price: index,
        }),
      ),
    );
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_QUERY_ACTIVE_RESET"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{
          rows: manyRows,
          totalRows: manyRows.length,
          version: 1,
          status: "ready",
        }}
        quickFilterFields={["desk"]}
      >
        <BrunoTableToolbar>
          <BrunoTableQuickFilter />
          <BrunoTableFilterControl<GroupRow, typeof columns> ownership="grid">
            {(commands) => (
              <button
                type="button"
                onClick={() =>
                  commands.replace({
                    columnId: "COL_ID_QUANTITY",
                    type: "equals",
                    filter: 50n,
                  })
                }
              >
                Show quantity 50
              </button>
            )}
          </BrunoTableFilterControl>
        </BrunoTableToolbar>
      </BrunoTableClient>,
    );
    await chooseGroup("Desk");
    const grid = page.getByRole("grid");
    grid.element().focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(activeGridCellText()).toBe("Group 002 (1)");
    grid.element().scrollTop = 720;
    grid.element().dispatchEvent(new Event("scroll"));
    await settleBrunoTableBrowserFrames();
    expect(grid.element().scrollTop).toBeGreaterThan(0);

    await userEvent.click(page.getByRole("button", { name: "Sort rows, 1 active" }));
    const rowsSort = page
      .getByRole("dialog", { name: "Sort rows" })
      .getByRole("button", { name: "Toggle Desk direction, currently ascending" });
    const rowsSortElement = rowsSort.element();
    rowsSortElement.focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => {
      const firstCell = page.getByRole("row").nth(1).getByRole("gridcell").first().element();
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(firstCell.id);
      expect(grid.element().scrollTop).toBe(0);
      expect(document.activeElement).toBe(rowsSortElement);
    });
    await userEvent.keyboard("{Escape}");

    grid.element().focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(grid.element().getAttribute("aria-activedescendant")).not.toBe(
      page.getByRole("row").nth(1).getByRole("gridcell").first().element().id,
    );
    grid.element().scrollTop = 720;
    grid.element().dispatchEvent(new Event("scroll"));
    await settleBrunoTableBrowserFrames();
    expect(grid.element().scrollTop).toBeGreaterThan(0);

    const quickFilter = page.getByRole("searchbox", { name: "Quick Filter" });
    await userEvent.fill(quickFilter, "Group");
    await vi.waitFor(() => {
      const firstCell = page.getByRole("row").nth(1).getByRole("gridcell").first().element();
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(firstCell.id);
      expect(grid.element().scrollTop).toBe(0);
      expect(document.activeElement).toBe(quickFilter.element());
    });

    grid.element().focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    grid.element().scrollTop = 720;
    grid.element().dispatchEvent(new Event("scroll"));
    await settleBrunoTableBrowserFrames();
    expect(grid.element().scrollTop).toBeGreaterThan(0);

    const quantityFilter = page.getByRole("button", { name: "Show quantity 50" });
    await userEvent.click(quantityFilter);
    await vi.waitFor(() => {
      const firstCell = page.getByRole("row").nth(1).getByRole("gridcell").first().element();
      expect(firstCell.textContent?.trim()).toBe("Group 049 (1)");
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(firstCell.id);
      expect(grid.element().scrollTop).toBe(0);
      expect(document.activeElement).toBe(quantityFilter.element());
    });
  });

  test("keeps Add Group open when a closing column menu finishes", async () => {
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_GROUPING_MENU_FOCUS_TRANSFER"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Column menu for Desk" }));
    const menu = page.getByRole("menu").element();
    menu.style.animationDuration = "400ms";
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("combobox", { name: "Add Group" }));
    await expect.element(page.getByRole("option", { name: "Desk", exact: true })).toBeVisible();
    expect(menu.isConnected).toBe(true);
    expect(menu.hasAttribute("data-closed")).toBe(true);
    await vi.waitFor(() => expect(menu.isConnected).toBe(false));
    await expect.element(page.getByRole("option", { name: "Desk", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: "Desk", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Remove Desk from Group By" }))
      .toBeVisible();
  });

  test("admits disabled raw sort columns only while they participate in grouping", async () => {
    const disabledGroupedSortColumns = [
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
        enableSorting: false,
      },
      {
        columnId: "COL_ID_REGION",
        field: "region",
        headerName: "Region",
        valueType: "text",
      },
      {
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        headerName: "Quantity",
        valueType: "bigint",
        aggFunc: "sum",
      },
      {
        columnId: "COL_ID_PRICE",
        field: "price",
        headerName: "Maximum price",
        valueType: "number",
        aggFunc: "max",
        enableSorting: false,
      },
    ] satisfies BrunoTableColumns<GroupRow>;
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_DISABLED_SORT_CAPABILITY"
        columns={disabledGroupedSortColumns}
        initialOrderBy={[{ columnId: "COL_ID_REGION", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      />,
    );

    expect(page.getByRole("button", { name: "Sort by Desk", exact: true }).all()).toHaveLength(0);
    expect(
      page.getByRole("button", { name: "Sort by Maximum price", exact: true }).all(),
    ).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Column menu for Desk" }));
    expect(page.getByRole("menuitem", { name: "Sort by Desk" }).all()).toHaveLength(0);
    await userEvent.keyboard("{Escape}");

    await chooseGroup("Desk");
    await userEvent.click(page.getByRole("button", { name: "Column menu for Desk" }));
    await expect.element(page.getByRole("menuitem", { name: "Sort by Desk" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Sort rows, 1 active" }));
    const sortPanel = page.getByRole("dialog", { name: "Sort rows" });
    await expect
      .element(
        sortPanel.getByRole("button", {
          name: "Toggle Desk direction, currently ascending",
        }),
      )
      .toBeInTheDocument();
    await userEvent.click(sortPanel.getByRole("combobox", { name: "Add sort column" }));
    await expect.element(page.getByRole("option", { name: "Maximum price" })).toBeInTheDocument();
  });

  test("keeps the grouped viewport structural identity and isolates a value-only live update", async () => {
    const tableId = "TABLE_ID_GROUPED_VALUE_ONLY";
    const screen = await render(
      <BrunoTableClient
        tableId={tableId}
        columns={columns}
        groupRowsColumn={{ headerName: "Orders" }}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      />,
    );
    await chooseGroup("Desk");
    await expect.element(page.getByRole("columnheader", { name: "Orders" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("gridcell", { name: "5 units" }).first())
      .toBeInTheDocument();
    const grid = page.getByRole("grid").element();
    const structuralRenders: unknown[] = [];
    const cellRenders: Array<readonly [string, string]> = [];
    const rowOrderPlanning = vi.fn();
    const removeStructural = installBrunoTableClientGridSurfaceRenderListenerForTable(tableId, () =>
      structuralRenders.push(undefined),
    );
    const removeCells = installBrunoTableClientCellRenderListenerForTable(
      tableId,
      (rowId, columnId) => cellRenders.push([rowId, columnId]),
    );
    const removePlanning = installBrunoTableClientRowOrderPlanningListener(rowOrderPlanning);
    try {
      const updatedRows = Object.freeze([{ ...rows[0]!, quantity: 4n }, ...rows.slice(1)]);
      await screen.rerender(
        <BrunoTableClient
          tableId={tableId}
          columns={columns}
          groupRowsColumn={{ headerName: "Orders" }}
          initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
          getRowId={(row) => row.id}
          clientSource={{
            rows: updatedRows,
            totalRows: updatedRows.length,
            version: 2,
            status: "ready",
          }}
        />,
      );
      await expect.element(page.getByRole("gridcell", { name: "7 units" })).toBeInTheDocument();
      expect(page.getByRole("grid").element()).toBe(grid);
      expect(structuralRenders).toHaveLength(0);
      expect(rowOrderPlanning).not.toHaveBeenCalled();
      expect(cellRenders).toEqual([[expect.stringContaining("Alpha"), "COL_ID_QUANTITY"]]);
    } finally {
      removeStructural();
      removeCells();
      removePlanning();
    }
  });

  test("reconciles grouped Active by private identity, then clamped index, and clears only when empty", async () => {
    const liveRows = Object.freeze(
      Array.from(
        { length: 100 },
        (_unused, index): GroupRow => ({
          id: `row-${String(index)}`,
          desk: `Group ${String(index).padStart(3, "0")}`,
          region: "East",
          quantity: BigInt(index + 1),
          price: index,
        }),
      ),
    );
    const renderTable = (sourceRows: readonly GroupRow[], version: number) => (
      <BrunoTableClient
        tableId="TABLE_ID_GROUPED_ACTIVE_RECONCILE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{
          rows: sourceRows,
          totalRows: sourceRows.length,
          version,
          status: "ready",
        }}
      />
    );
    const screen = await render(renderTable(liveRows, 1));
    await chooseGroup("Desk");
    await userEvent.click(page.getByRole("button", { name: /Sort by Quantity/u }));
    const activeQuantity = page.getByRole("gridcell", { name: "13 units", exact: true });
    await userEvent.click(activeQuantity);
    const grid = page.getByRole("grid");
    const activeIdentity = activeQuantity.element().id;
    const scrollBefore = grid.element().scrollTop;

    const movedRows = liveRows.map((row) =>
      row.id === "row-12" ? { ...row, quantity: 10_000n } : row,
    );
    await screen.rerender(renderTable(movedRows, 2));
    const movedProxy = page.getByRole("gridcell", { name: "10000 units", exact: true });
    await vi.waitFor(() => {
      expect(movedProxy.element().id).toBe(activeIdentity);
      expect(movedProxy.element().hasAttribute("data-bruno-active-proxy")).toBe(true);
      expect(grid.element().scrollTop).toBe(scrollBefore);
    });

    const removedRows = movedRows.filter((row) => row.id !== "row-12");
    await screen.rerender(renderTable(removedRows, 3));
    const clamped = page.getByRole("gridcell", { name: "100 units", exact: true });
    await vi.waitFor(() => {
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(clamped.element().id);
      expect(grid.element().scrollTop).toBe(scrollBefore);
    });

    await screen.rerender(renderTable(Object.freeze([]), 4));
    await expect.element(page.getByRole("region", { name: "No rows" })).toBeInTheDocument();
    expect(page.getByRole("grid").all()).toHaveLength(0);
  });

  test("renders exact optional-Effect BigDecimal sum and default-precision average", async () => {
    const writes: string[] = [];
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async (text: string) => writes.push(text)) },
    });
    try {
      await render(
        <BrunoTableClient
          tableId="TABLE_ID_GROUPED_BIGDECIMAL"
          columns={exactDecimalColumns}
          initialOrderBy={[{ columnId: "COL_ID_DECIMAL_DESK", direction: "asc" }]}
          getRowId={(row) => row.id}
          clientSource={{
            rows: exactDecimalRows,
            totalRows: exactDecimalRows.length,
            version: 1,
            status: "ready",
          }}
        />,
      );
      await chooseGroup("Desk");

      const oneThird = BigDecimal.format(
        BigDecimal.divideUnsafe(BigDecimal.fromBigInt(1n), BigDecimal.fromBigInt(3n)),
      );
      await expect.element(page.getByRole("gridcell", { name: "sum 0.3" })).toBeInTheDocument();
      await expect.element(page.getByRole("gridcell", { name: "avg 0.15" })).toBeInTheDocument();
      await expect.element(page.getByRole("gridcell", { name: "sum 1" })).toBeInTheDocument();
      await expect
        .element(page.getByRole("gridcell", { name: `avg ${oneThird}` }))
        .toBeInTheDocument();

      const grid = page.getByRole("grid");
      grid.element().focus();
      await userEvent.keyboard("{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
      await userEvent.keyboard(
        detectPlatform() === "mac" ? "{Meta>}c{/Meta}" : "{Control>}c{/Control}",
      );
      await vi.waitFor(() => expect(writes).toEqual(["0.3\t0.15"]));
    } finally {
      if (clipboardDescriptor === undefined) {
        delete (navigator as { clipboard?: Clipboard }).clipboard;
      } else {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      }
    }
  });

  test("clears ordinary selection and the old range before grouped canonical Copy", async () => {
    const writes: string[] = [];
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async (text: string) => writes.push(text)) },
    });
    try {
      await render(
        <BrunoTableClient
          tableId="TABLE_ID_GROUPED_RANGE_COPY"
          columns={columns}
          initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
          getRowId={(row) => row.id}
          clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
          rowSelection
        />,
      );
      await page.getByRole("checkbox", { name: "Select row 1", exact: true }).click();
      const grid = page.getByRole("grid");
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      await expect
        .element(page.getByRole("gridcell", { name: "Alpha" }).first())
        .toHaveAttribute("aria-selected", "true");

      await chooseGroup("Desk");
      await settleBrunoTableBrowserFrames();
      expect(page.getByRole("checkbox", { name: "Select row 1", exact: true }).all()).toHaveLength(
        0,
      );
      await expect
        .element(page.getByRole("gridcell", { name: "Alpha (2)" }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "2", exact: true }))
        .not.toHaveAttribute("aria-selected");

      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      await userEvent.keyboard(
        detectPlatform() === "mac" ? "{Meta>}c{/Meta}" : "{Control>}c{/Control}",
      );
      await vi.waitFor(() => expect(writes).toEqual(["Alpha\t2"]));
    } finally {
      if (clipboardDescriptor === undefined) {
        delete (navigator as { clipboard?: Clipboard }).clipboard;
      } else {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      }
    }
  });

  test("keeps the idle Sort Panel out of grouped membership and order publications", async () => {
    const sortPanelCommits = vi.fn();
    const removeListener = installBrunoTableClientSortPanelRenderListenerForTable(
      "TABLE_ID_GROUPED_SORT_PANEL_ISOLATION",
      sortPanelCommits,
    );
    try {
      const renderTable = (sourceRows: readonly GroupRow[], version: number) => (
        <BrunoTableClient
          tableId="TABLE_ID_GROUPED_SORT_PANEL_ISOLATION"
          columns={columns}
          initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
          getRowId={(row) => row.id}
          clientSource={{
            rows: sourceRows,
            totalRows: sourceRows.length,
            version,
            status: "ready",
          }}
          groupRowsColumn={{ headerName: "Orders" }}
          quickFilterFields={["desk"]}
        >
          <BrunoTableToolbar>
            <BrunoTableQuickFilter />
          </BrunoTableToolbar>
        </BrunoTableClient>
      );
      const screen = await render(renderTable(rows, 1));
      await chooseGroup("Desk");
      await settleBrunoTableBrowserFrames();
      const commitsAfterGrouping = sortPanelCommits.mock.calls.length;
      expect(commitsAfterGrouping).toBeGreaterThan(0);

      await userEvent.fill(page.getByRole("searchbox", { name: "Quick Filter" }), "Alpha");
      await settleBrunoTableBrowserFrames();
      expect(sortPanelCommits).toHaveBeenCalledTimes(commitsAfterGrouping);

      await screen.rerender(
        renderTable([{ ...rows[2]!, desk: "Alpha", quantity: 7n }, rows[1]!, rows[0]!], 2),
      );
      await settleBrunoTableBrowserFrames();

      expect(sortPanelCommits).toHaveBeenCalledTimes(commitsAfterGrouping);
      await expect
        .element(page.getByRole("button", { name: "Sort rows, 1 active" }))
        .toBeInTheDocument();
    } finally {
      removeListener();
    }
  });
});

function readCommittedHeaderProjection(): string[] {
  return page
    .getByRole("columnheader")
    .all()
    .map(
      (header) =>
        header
          .element()
          .textContent?.replace(/(?:Clear|Reset|[↑↓\d])/gu, "")
          .trim() ?? "",
    );
}

async function chooseGroup(name: string): Promise<void> {
  const trigger = page
    .getByRole("region", { name: "Group By" })
    .getByRole("combobox", { name: "Add Group" });
  await userEvent.click(trigger);
  await userEvent.click(page.getByRole("option", { name, exact: true }));
}

function isOrderedSubsequence(received: readonly string[], expected: readonly string[]): boolean {
  let previousIndex = -1;
  for (const value of received) {
    const index = expected.indexOf(value);
    if (index <= previousIndex) return false;
    previousIndex = index;
  }
  return true;
}

function activeGridCellText(): string | undefined {
  const activeId = page.getByRole("grid").element().getAttribute("aria-activedescendant");
  return page
    .getByRole("gridcell")
    .all()
    .find((cell) => cell.element().id === activeId)
    ?.element()
    .textContent?.trim();
}
