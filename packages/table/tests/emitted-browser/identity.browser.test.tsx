import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server.browser";
import { cleanup, render } from "vitest-browser-react";

import {
  BrunoTableBigIntColumn,
  BrunoTableActiveFilterCount,
  BrunoTableActiveSortCount,
  BrunoTableBooleanColumn,
  BrunoTableClient,
  BrunoTableFilterControl,
  BrunoTableLoadedRowCount,
  BrunoTableNumberColumn,
  BrunoTableQuickFilter,
  BrunoTableResultRowCount,
  BrunoTableSelectColumn,
  BrunoTableToolbar,
} from "../../dist/index.mjs";
import type { BrunoTableColumns } from "../../dist/index.mjs";

type Row = Readonly<{ id: string; name: string; score: number }>;
type FilterRow = Readonly<{ id: string; name: string; symbol: string }>;
type EmittedFilterRow = Readonly<{
  id: string;
  name: string;
  score: number;
  quantity: bigint;
  active: boolean;
  status: "open" | "closed";
}>;
type EmittedSelectRow = Readonly<{ id: string; choice: string }>;

const source = Object.freeze({
  rows: Object.freeze([{ id: "row", name: "Ada", score: 1_234.5 }]) satisfies readonly Row[],
  totalRows: 1,
  version: 1,
  status: "ready" as const,
});

const filterSource = Object.freeze({
  rows: Object.freeze([
    { id: "ada", name: "Ada", symbol: "AAPL" },
    { id: "grace", name: "Grace", symbol: "MSFT" },
  ]) satisfies readonly FilterRow[],
  totalRows: 2,
  version: 1,
  status: "ready" as const,
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("restores and emits versioned Grid Preferences from the emitted package", async () => {
  const columns = [
    {
      columnId: "COL_ID_EMITTED_PREFERENCE_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
    },
  ] satisfies BrunoTableColumns<FilterRow>;
  const onPersistChange = vi.fn();
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_EMITTED_PREFERENCES"
      getRowId={(row: FilterRow) => row.id}
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_EMITTED_PREFERENCE_NAME", direction: "asc" }]}
      initialPersistedState={{
        version: 1,
        tableId: "TABLE_ID_EMITTED_PREFERENCES",
        filters: [
          {
            columnId: "COL_ID_EMITTED_PREFERENCE_NAME",
            type: "equals",
            codecId: "@bruno/table/text",
            codecVersion: 1,
            filter: { $brunoTableValue: "text", version: 1, value: "Grace" },
          },
        ],
        orderBy: [{ columnId: "COL_ID_EMITTED_PREFERENCE_NAME", direction: "desc" }],
        groupBy: [],
        groupOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" }],
        columnOrder: ["COL_ID_EMITTED_PREFERENCE_NAME"],
        columnVisibility: { COL_ID_EMITTED_PREFERENCE_NAME: true },
        columnWidths: { COL_ID_EMITTED_PREFERENCE_NAME: 180 },
        columnPinning: { start: [], end: [] },
      }}
      onPersistChange={onPersistChange}
      clientSource={filterSource}
    />,
  );
  await expect
    .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Ada", exact: true }))
    .not.toBeInTheDocument();
  expect(onPersistChange).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
  await vi.waitFor(() => expect(onPersistChange).toHaveBeenCalledOnce());
  expect(JSON.stringify(onPersistChange.mock.lastCall?.[0])).toContain(
    '"codecId":"@bruno/table/text"',
  );
});

test("applies emitted Quick Filter and column filter interactions", async () => {
  const columns = [
    {
      columnId: "COL_ID_EMITTED_FILTER_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
    },
  ] satisfies BrunoTableColumns<FilterRow>;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_EMITTED_FILTERS"
      getRowId={(row: FilterRow) => row.id}
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_EMITTED_FILTER_NAME", direction: "asc" }]}
      quickFilterFields={["symbol"]}
      clientSource={filterSource}
    >
      <BrunoTableToolbar>
        <BrunoTableQuickFilter />
        <BrunoTableFilterControl<FilterRow, typeof columns> ownership="grid">
          {(commands) => (
            <button type="button" onClick={() => commands.clearAll()}>
              Clear Grid Filters
            </button>
          )}
        </BrunoTableFilterControl>
        <BrunoTableResultRowCount />
        <BrunoTableLoadedRowCount />
        <BrunoTableActiveFilterCount />
        <BrunoTableActiveSortCount />
      </BrunoTableToolbar>
    </BrunoTableClient>,
  );

  await userEvent.fill(screen.getByRole("searchbox", { name: "Quick Filter" }), "msft");
  await expect.element(screen.getByRole("status", { name: "Result rows" })).toHaveTextContent("1");
  await expect.element(screen.getByRole("status", { name: "Loaded rows" })).toHaveTextContent("2");
  await expect
    .element(screen.getByRole("status", { name: "Active filters" }))
    .toHaveTextContent("1");
  await expect.element(screen.getByRole("status", { name: "Active sorts" })).toHaveTextContent("1");
  await expect
    .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Ada", exact: true }))
    .not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Active filters (1)" }));
  const review = screen.getByRole("dialog", { name: "Active filters" });
  await expect
    .element(review.getByRole("button", { name: 'Remove Quick Filter contains "msft"' }))
    .toBeInTheDocument();
  await userEvent.click(
    review.getByRole("button", { name: 'Remove Quick Filter contains "msft"' }),
  );
  await expect
    .element(screen.getByRole("button", { name: "Active filters (0)" }))
    .toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Filter Name" }));
  const dialog = screen.getByRole("dialog", { name: "Filter Name" });
  await expect.element(dialog).toBeInTheDocument();
  await userEvent.fill(dialog.getByRole("textbox", { name: "Filter value for Name" }), "Grace");
  await expect
    .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("status", { name: "Active filters" }))
    .toHaveTextContent("1 active filter");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(screen.getByRole("grid", { name: "Data for TABLE_ID_EMITTED_FILTERS" }))
    .toHaveFocus();
  await userEvent.fill(screen.getByRole("searchbox", { name: "Quick Filter" }), "msft");
  await expect
    .element(screen.getByRole("status", { name: "Active filters" }))
    .toHaveTextContent("2 active filters");
  await userEvent.click(screen.getByRole("button", { name: "Clear Grid Filters" }));
  await expect
    .element(screen.getByRole("status", { name: "Active filters" }))
    .toHaveTextContent("1 active filter");
  await expect
    .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Ada", exact: true }))
    .not.toBeInTheDocument();
});

test("applies emitted live Set Filter inclusion and normalization", async () => {
  type SetRow = Readonly<{ id: string; active: boolean }>;
  const columns = [
    {
      columnId: "COL_ID_EMITTED_SET_ID",
      field: "id",
      headerName: "Id",
      valueType: "text",
    },
    BrunoTableBooleanColumn({
      columnId: "COL_ID_EMITTED_SET_ACTIVE",
      field: "active",
      headerName: "Active",
    }),
  ] satisfies BrunoTableColumns<SetRow>;
  const screen = await render(
    <BrunoTableClient<SetRow, typeof columns>
      tableId="TABLE_ID_EMITTED_SET_FILTER"
      getRowId={(row) => row.id}
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_EMITTED_SET_ID", direction: "asc" }]}
      clientSource={{
        rows: [
          { id: "active", active: true },
          { id: "inactive", active: false },
        ],
        totalRows: 2,
        version: 1,
        status: "ready",
      }}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Filter Active" }));
  const dialog = screen.getByRole("dialog", { name: "Filter Active" });
  await userEvent.click(dialog.getByRole("button", { name: "Clear All" }));
  dialog.getByRole("checkbox", { name: "Select true, 1" }).element().focus();
  await userEvent.keyboard(" ");
  await expect
    .element(screen.getByRole("gridcell", { name: "inactive", exact: true }))
    .not.toBeInTheDocument();
  dialog.getByRole("checkbox", { name: "Select false, 1" }).element().focus();
  await userEvent.keyboard(" ");
  await expect
    .element(screen.getByRole("gridcell", { name: "inactive", exact: true }))
    .toBeInTheDocument();
});

test("windows emitted Select filter options while retaining a selected value", async () => {
  const options = [
    "option-0",
    ...Array.from({ length: 64 }, (_, index) => `option-${index + 1}`),
  ] as readonly [string, ...string[]];
  const columns = [
    BrunoTableSelectColumn({
      columnId: "COL_ID_EMITTED_LARGE_SELECT",
      field: "choice",
      headerName: "Choice",
      options,
    }),
  ] satisfies BrunoTableColumns<EmittedSelectRow>;
  const screen = await render(
    <BrunoTableClient<EmittedSelectRow, typeof columns>
      tableId="TABLE_ID_EMITTED_LARGE_SELECT"
      getRowId={(row) => row.id}
      columns={columns}
      initialFilters={[
        { columnId: "COL_ID_EMITTED_LARGE_SELECT", type: "equals", filter: "option-64" },
      ]}
      initialOrderBy={[{ columnId: "COL_ID_EMITTED_LARGE_SELECT", direction: "asc" }]}
      clientSource={{
        rows: [{ id: "selected", choice: "option-64" }],
        totalRows: 1,
        version: 1,
        status: "ready",
      }}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Filter Choice (active)" }));
  const dialog = screen.getByRole("dialog", { name: "Filter Choice" });
  await expect
    .element(dialog.getByRole("status").nth(1))
    .toHaveTextContent("Showing options 1–64 of 65");
  const selectedOption = dialog.getByRole("option", { name: "option-64" });
  await expect.element(selectedOption).toBeInTheDocument();
  expect((selectedOption.element() as HTMLOptionElement).selected).toBe(true);
  await userEvent.click(dialog.getByRole("button", { name: "Next filter options for Choice" }));
  await expect
    .element(dialog.getByRole("status").nth(1))
    .toHaveTextContent("Showing options 2–65 of 65");
  await expect.element(dialog.getByRole("option", { name: "option-0" })).not.toBeInTheDocument();
  expect(
    (dialog.getByRole("option", { name: "option-64" }).element() as HTMLOptionElement).selected,
  ).toBe(true);
  await userEvent.click(dialog.getByRole("button", { name: "Previous filter options for Choice" }));
  await expect.element(dialog.getByRole("option", { name: "option-0" })).toBeInTheDocument();
  expect(
    (dialog.getByRole("option", { name: "option-64" }).element() as HTMLOptionElement).selected,
  ).toBe(true);
});

test("applies emitted numeric, BigInt, discrete, range, and compound filters", async () => {
  const columns = [
    {
      columnId: "COL_ID_EMITTED_FILTER_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
    },
    BrunoTableNumberColumn({
      columnId: "COL_ID_EMITTED_FILTER_SCORE",
      field: "score",
      headerName: "Score",
    }),
    BrunoTableBigIntColumn({
      columnId: "COL_ID_EMITTED_FILTER_QUANTITY",
      field: "quantity",
      headerName: "Quantity",
    }),
    BrunoTableBooleanColumn({
      columnId: "COL_ID_EMITTED_FILTER_ACTIVE",
      field: "active",
      headerName: "Active",
    }),
    BrunoTableSelectColumn({
      columnId: "COL_ID_EMITTED_FILTER_STATUS",
      field: "status",
      headerName: "Status",
      options: ["open", "closed"],
    }),
  ] satisfies BrunoTableColumns<EmittedFilterRow>;
  const rows = [
    {
      id: "ada",
      name: "Ada",
      score: 1.5,
      quantity: 9_007_199_254_740_993n,
      active: true,
      status: "open",
    },
    {
      id: "grace",
      name: "Grace",
      score: 2.5,
      quantity: 9_007_199_254_740_994n,
      active: false,
      status: "closed",
    },
    {
      id: "linus",
      name: "Linus",
      score: 4.5,
      quantity: 9_007_199_254_740_995n,
      active: true,
      status: "open",
    },
  ] satisfies readonly EmittedFilterRow[];
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_EMITTED_FILTER_FAMILIES"
      getRowId={(row: EmittedFilterRow) => row.id}
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_EMITTED_FILTER_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Filter Score" }));
  let dialog = screen.getByRole("dialog", { name: "Filter Score" });
  await userEvent.selectOptions(
    dialog.getByRole("combobox", { name: "Filter operator for Score" }),
    "equals",
  );
  dialog = screen.getByRole("dialog", { name: "Filter Score" });
  await userEvent.fill(dialog.getByRole("spinbutton", { name: "Filter value for Score" }), "2.5");
  await expect
    .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Ada", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Clear filter for Score" }).click();

  await userEvent.click(screen.getByRole("button", { name: "Filter Quantity" }));
  dialog = screen.getByRole("dialog", { name: "Filter Quantity" });
  await userEvent.selectOptions(
    dialog.getByRole("combobox", { name: "Filter operator for Quantity" }),
    "greaterThan",
  );
  dialog = screen.getByRole("dialog", { name: "Filter Quantity" });
  await userEvent.fill(
    dialog.getByRole("textbox", { name: "Filter value for Quantity" }),
    "9007199254740993",
  );
  await expect
    .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Ada", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Clear filter for Quantity" }).click();

  await userEvent.click(screen.getByRole("button", { name: "Filter Score" }));
  dialog = screen.getByRole("dialog", { name: "Filter Score" });
  await userEvent.selectOptions(
    dialog.getByRole("combobox", { name: "Filter operator for Score" }),
    "inRange",
  );
  dialog = screen.getByRole("dialog", { name: "Filter Score" });
  await userEvent.fill(dialog.getByRole("spinbutton", { name: "Filter value for Score" }), "1.5");
  await userEvent.fill(
    dialog.getByRole("spinbutton", { name: "Filter upper bound for Score" }),
    "4.5",
  );
  await expect
    .element(screen.getByRole("gridcell", { name: "Ada", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Linus", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Clear filter for Score" }).click();

  await userEvent.click(screen.getByRole("button", { name: "Filter Active" }));
  dialog = screen.getByRole("dialog", { name: "Filter Active" });
  await userEvent.selectOptions(
    dialog.getByRole("combobox", { name: "Filter value for Active" }),
    "true",
  );
  await expect
    .element(screen.getByRole("gridcell", { name: "Ada", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Clear filter for Active" }).click();

  await userEvent.click(screen.getByRole("button", { name: "Filter Status" }));
  dialog = screen.getByRole("dialog", { name: "Filter Status" });
  await userEvent.selectOptions(
    dialog.getByRole("combobox", { name: "Filter operator for Status" }),
    "equals",
  );
  await userEvent.selectOptions(
    dialog.getByRole("combobox", { name: "Filter value for Status" }),
    "closed",
  );
  await expect
    .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Ada", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Clear filter for Status" }).click();

  await userEvent.click(screen.getByRole("button", { name: "Filter Name" }));
  dialog = screen.getByRole("dialog", { name: "Filter Name" });
  await userEvent.selectOptions(
    dialog.getByRole("combobox", { name: "Filter expression for Name" }),
    "OR",
  );
  dialog = screen.getByRole("dialog", { name: "Filter Name" });
  await userEvent.fill(
    dialog.getByRole("textbox", { name: "Filter value for Name (condition 1)" }),
    "Ada",
  );
  await userEvent.fill(
    dialog.getByRole("textbox", { name: "Filter value for Name (condition 2)" }),
    "Grace",
  );
  await expect
    .element(screen.getByRole("gridcell", { name: "Ada", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("gridcell", { name: "Linus", exact: true }))
    .not.toBeInTheDocument();
});

test("reports incompatible Table Identity reuse from the emitted browser runtime", async () => {
  const restoreProcess = replaceBrowserProcess({ env: { NODE_ENV: "development" } });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const firstColumns = [
    {
      columnId: "COL_ID_VALUE",
      field: "name",
      headerName: "Name",
      valueType: "text",
    },
  ] as const;
  const incompatibleColumns = [
    {
      columnId: "COL_ID_VALUE",
      field: "score",
      headerName: "Score",
      valueType: "number",
    },
  ] as const;
  try {
    const screen = await render(
      <>
        <BrunoTableClient
          tableId="TABLE_ID_EMITTED_CONFLICT"
          getRowId={(row: Row) => row.id}
          columns={firstColumns}
          initialOrderBy={[{ columnId: "COL_ID_VALUE", direction: "asc" }]}
          clientSource={source}
        />
        <BrunoTableClient
          tableId="TABLE_ID_EMITTED_CONFLICT"
          getRowId={(row: Row) => row.id}
          columns={incompatibleColumns}
          initialOrderBy={[{ columnId: "COL_ID_VALUE", direction: "asc" }]}
          clientSource={source}
        />
      </>,
    );

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('simultaneous use of tableId "TABLE_ID_EMITTED_CONFLICT"'),
    );
    expect(
      screen.getByRole("grid", { name: "Data for TABLE_ID_EMITTED_CONFLICT" }).all(),
    ).toHaveLength(2);
  } finally {
    restoreProcess();
  }
});

test("keeps emitted identity diagnostics disabled without a process environment", async () => {
  const restoreProcess = replaceBrowserProcess(undefined);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const firstColumns = [
    {
      columnId: "COL_ID_VALUE_WITHOUT_PROCESS",
      field: "name",
      headerName: "Name",
      valueType: "text",
    },
  ] as const;
  const incompatibleColumns = [
    {
      columnId: "COL_ID_VALUE_WITHOUT_PROCESS",
      field: "score",
      headerName: "Score",
      valueType: "number",
    },
  ] as const;

  try {
    const screen = await render(
      <>
        <BrunoTableClient
          tableId="TABLE_ID_EMITTED_NO_PROCESS"
          getRowId={(row: Row) => row.id}
          columns={firstColumns}
          initialOrderBy={[{ columnId: "COL_ID_VALUE_WITHOUT_PROCESS", direction: "asc" }]}
          clientSource={source}
        />
        <BrunoTableClient
          tableId="TABLE_ID_EMITTED_NO_PROCESS"
          getRowId={(row: Row) => row.id}
          columns={incompatibleColumns}
          initialOrderBy={[{ columnId: "COL_ID_VALUE_WITHOUT_PROCESS", direction: "asc" }]}
          clientSource={source}
        />
      </>,
    );

    expect(
      screen.getByRole("grid", { name: "Data for TABLE_ID_EMITTED_NO_PROCESS" }).all(),
    ).toHaveLength(2);
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    restoreProcess();
  }
});

test("keeps emitted identity diagnostics disabled in production", async () => {
  const restoreProcess = replaceBrowserProcess({ env: { NODE_ENV: "production" } });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const firstColumns = [
    {
      columnId: "COL_ID_VALUE_IN_PRODUCTION",
      field: "name",
      headerName: "Name",
      valueType: "text",
    },
  ] as const;
  const incompatibleColumns = [
    {
      columnId: "COL_ID_VALUE_IN_PRODUCTION",
      field: "score",
      headerName: "Score",
      valueType: "number",
    },
  ] as const;

  try {
    const screen = await render(
      <>
        <BrunoTableClient
          tableId="TABLE_ID_EMITTED_PRODUCTION"
          getRowId={(row: Row) => row.id}
          columns={firstColumns}
          initialOrderBy={[{ columnId: "COL_ID_VALUE_IN_PRODUCTION", direction: "asc" }]}
          clientSource={source}
        />
        <BrunoTableClient
          tableId="TABLE_ID_EMITTED_PRODUCTION"
          getRowId={(row: Row) => row.id}
          columns={incompatibleColumns}
          initialOrderBy={[{ columnId: "COL_ID_VALUE_IN_PRODUCTION", direction: "asc" }]}
          clientSource={source}
        />
      </>,
    );

    expect(
      screen.getByRole("grid", { name: "Data for TABLE_ID_EMITTED_PRODUCTION" }).all(),
    ).toHaveLength(2);
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    restoreProcess();
  }
});

test("hydrates emitted custom controls after removing their inert server boundary", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const activate = vi.fn();
  const recoverableErrors: unknown[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const columns = [
    {
      columnId: "COL_ID_ACTION",
      field: "name",
      headerName: "Action",
      valueType: "text",
      cellRenderer: ({ value }: { readonly value: string }) => (
        <button type="button" onClick={() => activate(value)}>
          Hydrate {value}
        </button>
      ),
    },
    {
      columnId: "COL_ID_SCORE",
      field: "score",
      headerName: "Score",
      valueType: "number",
      format: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
    },
  ] as const;
  const element = (
    <BrunoTableClient
      tableId="TABLE_ID_EMITTED_HYDRATION"
      getRowId={(row: Row) => row.id}
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_ACTION", direction: "asc" }]}
      clientSource={source}
    />
  );
  const serverMarkup = renderToString(element);
  expect(serverMarkup).toContain('inert=""');
  expect(serverMarkup).toContain("1,234.50");
  const container = document.createElement("div");
  const beforeHydration = document.createElement("button");
  beforeHydration.textContent = "Before hydration";
  const hydrationHost = document.createElement("div");
  hydrationHost.innerHTML = serverMarkup;
  const afterHydration = document.createElement("button");
  afterHydration.textContent = "After hydration";
  container.append(beforeHydration, hydrationHost, afterHydration);
  document.body.append(container);
  const before = page.getByRole("button", { name: "Before hydration" });
  const sortPanel = page.getByRole("button", { name: "Sort rows, 1 active" });
  const grid = page.getByRole("grid", { name: "Data for TABLE_ID_EMITTED_HYDRATION" });
  const after = page.getByRole("button", { name: "After hydration" });
  before.element().focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(sortPanel.element());
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(grid.element());
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(after.element());
  const mutations: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.attributeName === "tabindex" && record.target instanceof HTMLButtonElement) {
        mutations.push("tabindex");
      }
      if (record.attributeName === "inert") mutations.push("inert");
    }
  });
  observer.observe(hydrationHost, {
    attributes: true,
    attributeFilter: ["inert", "tabindex"],
    subtree: true,
  });
  let root: Root | undefined;

  try {
    await act(async () => {
      root = hydrateRoot(hydrationHost, element, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
      await Promise.resolve();
    });
    const action = page.getByRole("button", { name: "Hydrate Ada" });
    await vi.waitFor(() => {
      expect(action.element().tabIndex).toBe(-1);
      expect(action.element().closest("[inert]")).toBeNull();
      expect(mutations).toContain("tabindex");
      expect(mutations).toContain("inert");
    });
    expect(mutations.indexOf("tabindex")).toBeLessThan(mutations.indexOf("inert"));
    expect(recoverableErrors).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    await action.click();
    expect(activate).toHaveBeenCalledWith("Ada");
  } finally {
    observer.disconnect();
    await act(async () => root?.unmount());
    container.remove();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("runs emitted column management commands through the accessible menu", async () => {
  const columns = [
    {
      columnId: "COL_ID_EMITTED_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      width: 160,
    },
    {
      columnId: "COL_ID_EMITTED_SCORE",
      field: "score",
      headerName: "Score",
      valueType: "number",
      width: 96,
    },
  ] as const;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_EMITTED_COLUMN_MANAGEMENT"
      getRowId={(row: Row) => row.id}
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_EMITTED_NAME", direction: "asc" }]}
      clientSource={source}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Pin to logical end" }));
  await vi.waitFor(() => {
    const header = screen
      .getByRole("grid")
      .element()
      .querySelector<HTMLElement>('th[data-bruno-column-id="COL_ID_EMITTED_NAME"]');
    expect(header).not.toBeNull();
    expect(header).toHaveAttribute("data-pinned-region", "end");
  });
});

test("runs emitted resize, reorder, visibility, and reset commands", async () => {
  const columns = [
    {
      columnId: "COL_ID_EMITTED_LAYOUT_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      width: 160,
    },
    {
      columnId: "COL_ID_EMITTED_LAYOUT_SCORE",
      field: "score",
      headerName: "Score",
      valueType: "number",
      width: 96,
    },
  ] as const;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_EMITTED_LAYOUT_COMMANDS"
      getRowId={(row: Row) => row.id}
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_EMITTED_LAYOUT_NAME", direction: "asc" }]}
      clientSource={source}
    />,
  );
  const grid = screen.getByRole("grid").element();
  const resize = screen.getByRole("separator", { name: "Resize Name" });
  resize.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(resize).toHaveAttribute("aria-valuenow", "170");
  resize.element().dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 100,
      pointerId: 30,
    }),
  );
  window.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, clientX: 130, pointerId: 30 }),
  );
  await new Promise((resolve) => requestAnimationFrame(resolve));
  window.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, clientX: 130, pointerId: 30 }),
  );
  await expect.element(resize).toHaveAttribute("aria-valuenow", "200");

  await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
  await userEvent.hover(screen.getByRole("menuitem", { name: "Move" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Move toward logical end" }));
  await vi.waitFor(() =>
    expect(
      [...grid.querySelectorAll<HTMLElement>("th[data-bruno-column-id]")].map(
        (header) => header.dataset["brunoColumnId"],
      ),
    ).toEqual(["COL_ID_EMITTED_LAYOUT_SCORE", "COL_ID_EMITTED_LAYOUT_NAME"]),
  );

  await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
  await userEvent.hover(screen.getByRole("menuitem", { name: "Visibility" }));
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Score" }));
  await vi.waitFor(() => expect(grid).toHaveAttribute("aria-colcount", "1"));

  await userEvent.keyboard("{Escape}");
  const nameMenu = screen.getByRole("button", { name: "Column menu for Name" });
  await vi.waitFor(() => expect(document.activeElement).toBe(nameMenu.element()));
  await userEvent.click(nameMenu);
  await vi.waitFor(() => expect(nameMenu).toHaveAttribute("aria-expanded", "true"));
  await userEvent.hover(screen.getByRole("menuitem", { name: "Reset" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Reset complete layout" }));
  await vi.waitFor(() => expect(grid).toHaveAttribute("aria-colcount", "2"));
  await expect
    .element(screen.getByRole("separator", { name: "Resize Name" }))
    .toHaveAttribute("aria-valuenow", "160");
});

function replaceBrowserProcess(value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
  Object.defineProperty(globalThis, "process", {
    configurable: true,
    value,
    writable: true,
  });
  return () => {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, "process");
    } else {
      Object.defineProperty(globalThis, "process", descriptor);
    }
  };
}
