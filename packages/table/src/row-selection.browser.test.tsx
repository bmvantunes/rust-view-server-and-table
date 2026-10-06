import { StrictMode } from "react";
import { detectPlatform, getHotkeyManager } from "@tanstack/react-hotkeys";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient, BrunoTableToolbar } from "./index";
import type { BrunoTableColumnId, BrunoTableColumns } from "./public-types";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import {
  installBrunoTableClientGridSurfaceRenderListenerForTable,
  installBrunoTableClientHeaderRenderListenerForTable,
  installBrunoTableClientViewRenderListenerForTable,
} from "./internal/render-instrumentation";
import { installBrunoTableRowSelectionRenderListener } from "./internal/row-selection";

type Row = Readonly<{ readonly id: string; readonly name: string }>;

const columns = [
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Row>;

const rows: readonly Row[] = [
  { id: "a", name: "Ada" },
  { id: "b", name: "Babbage" },
  { id: "c", name: "Curie" },
];

afterEach(() => cleanup());

describe("ordinary Client Row Selection", () => {
  test("exposes accessible row checkboxes and mixed Select All state", async () => {
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_ACCESSIBLE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();

    const selectAll = page.getByRole("checkbox", { name: "Select all rows" });
    const ada = page.getByRole("checkbox", { name: "Select row 1" });
    await expect.element(selectAll).toHaveAttribute("tabindex", "-1");
    await expect.element(ada).toHaveAttribute("tabindex", "-1");
    await expect.element(selectAll).not.toBeChecked();
    await userEvent.click(ada);
    await expect.element(ada).toBeChecked();
    await expect.element(selectAll).toHaveAttribute("data-indeterminate", "");
    await expect.element(selectAll).toHaveAttribute("aria-checked", "mixed");
    expect(ada.element().ownerDocument.activeElement).toBe(ada.element());
    await userEvent.keyboard(
      detectPlatform() === "mac" ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
    );
    await expect.element(selectAll).toBeChecked();
    await expect.element(page.getByRole("checkbox", { name: "Select row 3" })).toBeChecked();

    await userEvent.click(selectAll);
    await expect.element(selectAll).not.toBeChecked();
    expect(selectAll.element().ownerDocument.activeElement).toBe(selectAll.element());
    await userEvent.keyboard(
      detectPlatform() === "mac" ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
    );
    await expect.element(selectAll).toBeChecked();
  });

  test("uses the stable grid Space command without adding virtualized Tab stops", async () => {
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_GRID_SPACE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();

    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_GRID_SPACE" });
    await expect
      .element(grid)
      .toHaveAttribute(
        "aria-keyshortcuts",
        "Alt+ArrowLeft Alt+ArrowRight Shift+F10 ContextMenu Control+C Meta+C Space Shift+Space Control+A Meta+A",
      );
    grid.element().focus();
    await userEvent.keyboard(" ");
    await expect.element(page.getByRole("checkbox", { name: "Select row 1" })).toBeChecked();

    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Shift>} {/Shift}");
    await expect.element(page.getByRole("checkbox", { name: "Select row 2" })).toBeChecked();
    await vi.waitFor(() =>
      expect(grid.element().querySelector<HTMLElement>('[aria-live="polite"]')?.textContent).toBe(
        "2 rows selected, rows 1 through 2",
      ),
    );
    await expect
      .element(page.getByRole("checkbox", { name: "Select all rows" }))
      .toHaveAttribute("aria-checked", "mixed");

    await userEvent.keyboard("{ArrowUp}{ArrowUp} ");
    await expect
      .element(page.getByRole("columnheader", { name: /Name, sorted descending/ }))
      .toHaveAttribute("aria-sort", "descending");
    await expect
      .element(page.getByRole("checkbox", { name: "Select all rows" }))
      .toHaveAttribute("aria-checked", "mixed");

    await userEvent.keyboard(
      detectPlatform() === "mac" ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
    );
    await expect.element(page.getByRole("checkbox", { name: "Select all rows" })).toBeChecked();
  });

  test("preserves table state when the optional capability changes", async () => {
    const manager = getHotkeyManager();
    const selectAllRegistrationsFor = (grid: HTMLElement | SVGElement) =>
      [...manager.registrations.state.values()].filter(
        (registration) => registration.target === grid && registration.hotkey === "Mod+A",
      );
    const renderTable = (rowSelection: true | undefined) => (
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_DYNAMIC"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        {...(rowSelection === true ? { rowSelection } : {})}
      />
    );
    const screen = await render(renderTable(undefined));
    await settleBrunoTableBrowserFrames();
    const disabledGrid = page
      .getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_DYNAMIC" })
      .element();
    expect(selectAllRegistrationsFor(disabledGrid)).toHaveLength(0);
    await page.getByRole("button", { name: /Sort by Name/ }).click();
    await expect.element(page.getByRole("gridcell", { name: "Curie" })).toBeInTheDocument();

    await screen.rerender(renderTable(true));
    await settleBrunoTableBrowserFrames();
    const enabledGrid = page
      .getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_DYNAMIC" })
      .element();
    expect(selectAllRegistrationsFor(enabledGrid)).toHaveLength(1);
    const names = page
      .getByRole("gridcell")
      .all()
      .map((cell) => cell.element().textContent)
      .filter((value) => value === "Ada" || value === "Babbage" || value === "Curie");
    expect(names).toEqual(["Curie", "Babbage", "Ada"]);
    await expect.element(page.getByRole("checkbox", { name: "Select all rows" })).toBeEnabled();

    await screen.rerender(renderTable(undefined));
    await settleBrunoTableBrowserFrames();
    const restoredGrid = page
      .getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_DYNAMIC" })
      .element();
    expect(selectAllRegistrationsFor(restoredGrid)).toHaveLength(0);
    expect(selectAllRegistrationsFor(enabledGrid)).toHaveLength(0);
    expect(
      page
        .getByRole("gridcell")
        .all()
        .map((cell) => cell.element().textContent)
        .filter((value) => value === "Ada" || value === "Babbage" || value === "Curie"),
    ).toEqual(["Curie", "Babbage", "Ada"]);
    await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
  });

  test("re-enables selection after a loading-only capability cycle", async () => {
    const renderTable = (status: "loading" | "ready", rowSelection: true | undefined) => (
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_LOADING_TOGGLE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{
          rows: status === "ready" ? rows : [],
          totalRows: rows.length,
          version: status === "ready" ? 2 : 1,
          status,
        }}
        getRowId={(row) => row.id}
        {...(rowSelection === true ? { rowSelection } : {})}
      />
    );
    const screen = await render(renderTable("loading", true));
    await screen.rerender(renderTable("loading", undefined));
    await screen.rerender(renderTable("loading", true));
    await screen.rerender(renderTable("ready", true));

    const firstRow = page.getByRole("checkbox", { name: "Select row 1" });
    await userEvent.click(firstRow);
    await expect.element(firstRow).toBeChecked();
  });

  test("keeps the selection gutter while Client rows are loading", async () => {
    const loadingColumns = [
      {
        columnId: "COL_ID_START",
        field: "name",
        headerName: "Start",
        valueType: "text",
        pinned: "start",
        width: 80,
      },
      {
        columnId: "COL_ID_CENTER",
        field: "name",
        headerName: "Center",
        valueType: "text",
        width: 120,
      },
      {
        columnId: "COL_ID_END",
        field: "name",
        headerName: "End",
        valueType: "text",
        pinned: "end",
        width: 80,
      },
    ] satisfies BrunoTableColumns<Row>;
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_LOADING"
        columns={loadingColumns}
        initialOrderBy={[{ columnId: "COL_ID_CENTER", direction: "asc" }]}
        clientSource={{ rows: [] as readonly Row[], totalRows: 100, version: 1, status: "loading" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();

    const grid = page.getByRole("grid", { name: "Loading table rows" });
    await expect.element(grid).toHaveAttribute("aria-colcount", "4");
    const selectionCell = page
      .getByRole("gridcell", { name: "Row selection loading" })
      .nth(0)
      .element();
    const pinnedStart = page.getByRole("gridcell", { name: "Loading Start" }).nth(0).element();
    expect(pinnedStart.closest('[data-bruno-pinned-body-region="start"]')).not.toBeNull();
    expect(pinnedStart.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      selectionCell.getBoundingClientRect().right - 1,
    );
  });

  test("Shift-click selects the inclusive current projection without changing grid focus", async () => {
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_SHIFT"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();

    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_SHIFT" });
    const activeDescendantBefore = grid.element().getAttribute("aria-activedescendant");
    await userEvent.click(page.getByRole("checkbox", { name: "Select row 1" }));
    const third = page.getByRole("checkbox", { name: "Select row 3" });
    await third.click({ modifiers: ["Shift"] });

    await expect.element(page.getByRole("checkbox", { name: "Select row 2" })).toBeChecked();
    await expect.element(third).toBeChecked();
    expect(document.activeElement).toBe(third.element());
    expect(grid.element().getAttribute("aria-activedescendant")).toBe(activeDescendantBefore);

    await page.getByRole("checkbox", { name: "Select row 1" }).click({ modifiers: ["Shift"] });
    await expect.element(page.getByRole("checkbox", { name: "Select row 1" })).not.toBeChecked();
    await expect.element(page.getByRole("checkbox", { name: "Select row 2" })).not.toBeChecked();
    await expect.element(third).not.toBeChecked();
  });

  test("retains the stable Shift anchor across a sorted projection", async () => {
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_SORTED_ANCHOR"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    await userEvent.click(rowCheckboxForCell("Ada"));
    await page
      .getByRole("button", { name: "Sort by Name, currently ascending, priority 1" })
      .click();
    await settleBrunoTableBrowserFrames();

    await page.getByRole("checkbox", { name: "Select row 1" }).click({ modifiers: ["Shift"] });

    await expect.element(page.getByRole("checkbox", { name: "Select all rows" })).toBeChecked();
  });

  test("preserves stable selected identities across live values, sorting, removal, and reappearance", async () => {
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_LIVE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();

    await userEvent.click(page.getByRole("checkbox", { name: "Select row 1" }));
    const movedRows = [
      { id: "a", name: "Zelda" },
      { id: "b", name: "Babbage" },
      { id: "c", name: "Curie" },
    ] satisfies readonly Row[];
    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_LIVE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows: movedRows, totalRows: movedRows.length, version: 2, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    expect(rowCheckboxForCell("Zelda").getAttribute("aria-checked")).toBe("true");

    const withoutAda = movedRows.slice(1);
    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_LIVE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{
          rows: withoutAda,
          totalRows: withoutAda.length,
          version: 3,
          status: "ready",
        }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    await expect.element(page.getByRole("checkbox", { name: "Select all rows" })).not.toBeChecked();

    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_LIVE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows: movedRows, totalRows: movedRows.length, version: 4, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    expect(rowCheckboxForCell("Zelda").getAttribute("aria-checked")).toBe("false");
  });

  test("keeps pointer focus and selection on the stable grid through virtualization", async () => {
    const manyRows = Array.from({ length: 2_000 }, (_unused, index) => ({
      id: `row-${String(index).padStart(4, "0")}`,
      name: `Row ${String(index).padStart(4, "0")}`,
    }));
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_VIRTUAL"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows: manyRows, totalRows: manyRows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();

    const first = page.getByRole("checkbox", { name: "Select row 1", exact: true });
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_VIRTUAL" });
    await userEvent.click(first);
    await expect.element(first).toBeChecked();
    expect(document.activeElement).toBe(first.element());
    grid.element().scrollTop = grid.element().scrollHeight;
    grid.element().dispatchEvent(new Event("scroll"));
    await settleBrunoTableBrowserFrames();
    expect(page.getByRole("checkbox", { name: "Select row 1", exact: true }).query()).toBeNull();
    expect(document.activeElement).toBe(grid.element());
    await userEvent.keyboard(" ");
    grid.element().scrollTop = 0;
    grid.element().dispatchEvent(new Event("scroll"));
    await settleBrunoTableBrowserFrames();
    await expect
      .element(page.getByRole("checkbox", { name: "Select row 1", exact: true }))
      .not.toBeChecked();
  });

  test("selects the complete filtered projection without adopting later matching rows", async () => {
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_FILTERED"
        columns={columns}
        initialFilters={[{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }]}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    await page.getByRole("checkbox", { name: "Select all rows" }).click();
    expect(rowCheckboxForCell("Ada").getAttribute("aria-checked")).toBe("true");

    const nextRows = [
      { id: "a", name: "Zelda" },
      { id: "b", name: "Babbage" },
      { id: "c", name: "Curie" },
      { id: "d", name: "Ada" },
    ] satisfies readonly Row[];
    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_FILTERED"
        columns={columns}
        initialFilters={[{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }]}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows: nextRows, totalRows: nextRows.length, version: 2, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    expect(rowCheckboxForCell("Ada").getAttribute("aria-checked")).toBe("false");
    await expect.element(page.getByRole("checkbox", { name: "Select all rows" })).not.toBeChecked();

    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_FILTERED" });
    const selectAllShortcut =
      detectPlatform() === "mac" ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}";
    grid.element().focus();
    await userEvent.keyboard(selectAllShortcut);
    await vi.waitFor(() =>
      expect(grid.element().querySelector<HTMLElement>('[aria-live="polite"]')?.textContent).toBe(
        "1 matching row selected",
      ),
    );
    const repeatedSelectionRenders = vi.fn();
    const removeRepeatedSelectionProbe = installBrunoTableRowSelectionRenderListener(
      "TABLE_ID_ROW_SELECTION_FILTERED",
      repeatedSelectionRenders,
    );
    try {
      grid.element().dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "a",
          repeat: true,
          ...(detectPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true }),
        }),
      );
      await expect.element(page.getByRole("checkbox", { name: "Select all rows" })).toBeChecked();
      expect(repeatedSelectionRenders).not.toHaveBeenCalled();
    } finally {
      removeRepeatedSelectionProbe();
    }
    await page.getByRole("checkbox", { name: "Select all rows" }).click();
    await expect.element(page.getByRole("checkbox", { name: "Select all rows" })).not.toBeChecked();

    const restoredRows = [{ id: "a", name: "Ada" }, ...nextRows.slice(1)] satisfies readonly Row[];
    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_FILTERED"
        columns={columns}
        initialFilters={[{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }]}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{
          rows: restoredRows,
          totalRows: restoredRows.length,
          version: 3,
          status: "ready",
        }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    const adaRows = page.getByRole("gridcell", { name: "Ada" }).all();
    expect(adaRows).toHaveLength(2);
    const checkedStates = adaRows.map((cell) =>
      cell
        .element()
        .closest('[role="row"]')
        ?.querySelector('[role="checkbox"]')
        ?.getAttribute("aria-checked"),
    );
    expect(checkedStates).toEqual(["true", "false"]);
    await expect
      .element(page.getByRole("checkbox", { name: "Select all rows" }))
      .toHaveAttribute("data-indeterminate", "");
  });

  test("disables Select All for an empty filtered projection", async () => {
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_EMPTY_FILTER"
        columns={columns}
        initialFilters={[{ columnId: "COL_ID_NAME", type: "equals", filter: "Nobody" }]}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    await expect.element(page.getByRole("checkbox", { name: "Select all rows" })).toBeDisabled();
    expect(page.getByRole("checkbox", { name: /Select row/ }).query()).toBeNull();
    const grid = page
      .getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_EMPTY_FILTER" })
      .element();
    grid.focus();
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "a",
      ...(detectPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true }),
    });
    expect(grid.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  test("returns focus to the grid when a live projection disables focused Select All", async () => {
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_DISABLE_FOCUS"
        columns={columns}
        initialFilters={[{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }]}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    const selectAll = page.getByRole("checkbox", { name: "Select all rows" });
    await userEvent.click(selectAll);
    expect(selectAll.element().ownerDocument.activeElement).toBe(selectAll.element());

    const changedRows = rows.map((row) => (row.id === "a" ? { ...row, name: "Lovelace" } : row));
    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_DISABLE_FOCUS"
        columns={columns}
        initialFilters={[{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }]}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows: changedRows, totalRows: rows.length, version: 2, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    await expect.element(selectAll).toBeDisabled();
    expect(selectAll.element().ownerDocument.activeElement).toBe(
      page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_DISABLE_FOCUS" }).element(),
    );
  });

  test("preserves selection across a rejected row-count publication", async () => {
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_REJECTED_COUNT"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    await userEvent.click(page.getByRole("checkbox", { name: "Select row 1" }));

    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_REJECTED_COUNT"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length + 1, version: 2, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await expect.element(page.getByRole("alert")).toHaveTextContent("Expected 4 rows");

    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_REJECTED_COUNT"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 3, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    await expect.element(page.getByRole("checkbox", { name: "Select row 1" })).toBeChecked();
  });

  test("keeps simultaneous and Strict Mode table lifetimes isolated", async () => {
    const manager = getHotkeyManager();
    await render(
      <StrictMode>
        <BrunoTableClient
          tableId="TABLE_ID_ROW_SELECTION_FIRST"
          columns={columns}
          initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
          clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
          getRowId={(row) => row.id}
          rowSelection
        />
        <BrunoTableClient
          tableId="TABLE_ID_ROW_SELECTION_SECOND"
          columns={columns}
          initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
          clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
          getRowId={(row) => row.id}
          rowSelection
        />
      </StrictMode>,
    );
    await settleBrunoTableBrowserFrames();
    const firstGrid = page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_FIRST" });
    const secondGrid = page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_SECOND" });
    expect(
      [...manager.registrations.state.values()].filter(
        (registration) =>
          (registration.target === firstGrid.element() ||
            registration.target === secondGrid.element()) &&
          registration.hotkey === "Mod+A",
      ),
    ).toHaveLength(2);
    await firstGrid.getByRole("checkbox", { name: "Select row 1" }).click();
    await expect.element(firstGrid.getByRole("checkbox", { name: "Select row 1" })).toBeChecked();
    await expect
      .element(secondGrid.getByRole("checkbox", { name: "Select row 1" }))
      .not.toBeChecked();
  });

  test("keeps nested table checkbox ownership with the nearest Client", async () => {
    const innerRows = [{ id: "inner", name: "Inner" }] satisfies readonly Row[];
    const nestedColumns = [
      {
        columnId: "COL_ID_NESTED",
        field: "name",
        headerName: "Nested",
        valueType: "text",
        cellRenderer: () => (
          <BrunoTableClient
            tableId="TABLE_ID_ROW_SELECTION_INNER"
            columns={columns}
            initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
            clientSource={{ rows: innerRows, totalRows: 1, version: 1, status: "ready" }}
            getRowId={(row) => row.id}
            rowSelection
          />
        ),
      },
    ] satisfies BrunoTableColumns<Row>;
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_OUTER"
        columns={nestedColumns}
        initialOrderBy={[{ columnId: "COL_ID_NESTED", direction: "asc" }]}
        clientSource={{ rows: [rows[0]!], totalRows: 1, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    const outer = page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_OUTER" });
    const inner = page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_INNER" });
    expect(
      [...getHotkeyManager().registrations.state.values()].filter(
        (registration) =>
          (registration.target === outer.element() || registration.target === inner.element()) &&
          registration.hotkey === "Mod+A",
      ),
    ).toHaveLength(2);
    await inner.getByRole("checkbox", { name: "Select row 1" }).click();
    await expect.element(inner.getByRole("checkbox", { name: "Select row 1" })).toBeChecked();
    const outerAndNestedCheckboxes = outer.getByRole("checkbox", { name: "Select row 1" }).all();
    expect(outerAndNestedCheckboxes).toHaveLength(2);
    await expect.element(outerAndNestedCheckboxes[0]!).not.toBeChecked();
  });

  test("keeps the selection gutter before pinned data and exposes unique column indices", async () => {
    const pinnedColumns = [
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        pinned: "start",
        width: 160,
      },
    ] satisfies BrunoTableColumns<Row>;
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_PINNED"
        columns={pinnedColumns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    const selectionHeader = page
      .getByRole("checkbox", { name: "Select all rows" })
      .element()
      .closest<HTMLElement>('[role="columnheader"]');
    const nameHeader = page.getByRole("columnheader", { name: "Name" }).element();
    expect(selectionHeader?.getAttribute("aria-colindex")).toBe("1");
    expect(nameHeader.getAttribute("aria-colindex")).toBe("2");
    expect(nameHeader.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      selectionHeader?.getBoundingClientRect().right ?? 0,
    );
    const overlay = page
      .getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_PINNED" })
      .element()
      .parentElement?.querySelector<HTMLElement>("[data-bruno-scrollbar-overlay]");
    expect(overlay?.style.getPropertyValue("--bruno-table-scrollbar-horizontal-start")).toBe(
      "200px",
    );
  });

  test("includes the gutter at the exact pinned-centre suspension threshold", async () => {
    const thresholdColumns = [
      {
        columnId: "COL_ID_THRESHOLD_START",
        field: "name",
        headerName: "Threshold start",
        valueType: "text",
        pinned: "start",
        width: 180,
      },
      {
        columnId: "COL_ID_THRESHOLD_CENTER",
        field: "name",
        headerName: "Threshold center",
        valueType: "text",
        width: 120,
      },
      {
        columnId: "COL_ID_THRESHOLD_END",
        field: "name",
        headerName: "Threshold end",
        valueType: "text",
        pinned: "end",
        width: 180,
      },
    ] satisfies BrunoTableColumns<Row>;
    await render(
      <div style={{ width: 479 }}>
        <BrunoTableClient
          tableId="TABLE_ID_ROW_SELECTION_THRESHOLD"
          columns={thresholdColumns}
          initialOrderBy={[{ columnId: "COL_ID_THRESHOLD_CENTER", direction: "asc" }]}
          clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
          getRowId={(row) => row.id}
          rowSelection
        />
      </div>,
    );
    await settleBrunoTableBrowserFrames();
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_THRESHOLD" });
    expect(grid.element().querySelector('[data-bruno-pinned-body-region="start"]')).toBeNull();
    expect(grid.element().querySelector('[data-bruno-pinned-body-region="end"]')).toBeNull();
  });

  test("keeps the gutter mounted across two-axis virtualization with pinned start and end columns", async () => {
    const wideColumns = Array.from({ length: 120 }, (_unused, index) => {
      const column = {
        columnId: `COL_ID_WIDE_${String(index).padStart(3, "0")}` as BrunoTableColumnId,
        field: "name" as const,
        headerName: `Wide ${String(index)}`,
        valueType: "text" as const,
        width: 140,
      };
      if (index === 0) return { ...column, pinned: "start" as const };
      if (index === 119) return { ...column, pinned: "end" as const };
      return column;
    }) satisfies BrunoTableColumns<Row>;
    const manyRows = Array.from({ length: 1_000 }, (_unused, index) => ({
      id: `wide-${String(index).padStart(4, "0")}`,
      name: `Wide row ${String(index).padStart(4, "0")}`,
    }));
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_TWO_AXIS"
        columns={wideColumns}
        initialOrderBy={[{ columnId: "COL_ID_WIDE_000", direction: "asc" }]}
        clientSource={{ rows: manyRows, totalRows: manyRows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    const first = page.getByRole("checkbox", { name: "Select row 1", exact: true });
    await first.click();
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_ROW_SELECTION_TWO_AXIS" });
    grid.element().scrollLeft = grid.element().scrollWidth;
    grid.element().scrollTop = grid.element().scrollHeight;
    grid.element().dispatchEvent(new Event("scroll"));
    await settleBrunoTableBrowserFrames();
    await expect
      .element(page.getByRole("checkbox", { name: "Select all rows" }))
      .toHaveAttribute("data-indeterminate", "");
    expect(page.getByRole("columnheader", { name: "Wide 0" }).query()).not.toBeNull();
    expect(page.getByRole("columnheader", { name: "Wide 119" }).query()).not.toBeNull();
    grid.element().scrollLeft = 0;
    grid.element().scrollTop = 0;
    grid.element().dispatchEvent(new Event("scroll"));
    await settleBrunoTableBrowserFrames();
    await expect
      .element(page.getByRole("checkbox", { name: "Select row 1", exact: true }))
      .toBeChecked();
  });

  test("never emits or hydrates Row Selection through persisted preferences", async () => {
    const onPersistChange = vi.fn();
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_PERSISTENCE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        onPersistChange={onPersistChange}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    onPersistChange.mockClear();
    await page.getByRole("checkbox", { name: "Select row 1", exact: true }).click();
    expect(onPersistChange).not.toHaveBeenCalled();

    await screen.rerender(<></>);
    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_PERSISTENCE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        initialPersistedState={
          {
            version: 1,
            tableId: "TABLE_ID_ROW_SELECTION_PERSISTENCE",
            filters: [],
            orderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }],
            groupBy: [],
            groupOrderBy: [],
            columnOrder: ["COL_ID_NAME"],
            columnVisibility: { COL_ID_NAME: true },
            columnWidths: {},
            columnPinning: { start: [], end: [] },
            rowSelection: ["a"],
          } as never
        }
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames();
    await expect
      .element(page.getByRole("checkbox", { name: "Select row 1", exact: true }))
      .not.toBeChecked();
  });

  test("one selection gesture does not wake unrelated toolbar content", async () => {
    const toolbarRenders = vi.fn();
    function ToolbarProbe() {
      toolbarRenders();
      return <span>Unrelated toolbar probe</span>;
    }
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ROW_SELECTION_TOOLBAR_ISOLATION"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      >
        <BrunoTableToolbar>
          <ToolbarProbe />
        </BrunoTableToolbar>
      </BrunoTableClient>,
    );
    await settleBrunoTableBrowserFrames();
    toolbarRenders.mockClear();
    await page.getByRole("checkbox", { name: "Select row 1", exact: true }).click();
    expect(toolbarRenders).not.toHaveBeenCalled();
  });

  test("20Hz value publications keep selection and unrelated surfaces asleep", async () => {
    const tableId = "TABLE_ID_ROW_SELECTION_PUBLICATION_ISOLATION";
    const toolbarRenders = vi.fn();
    function ToolbarProbe() {
      toolbarRenders();
      return <span>Publication toolbar probe</span>;
    }
    const screen = await render(
      <BrunoTableClient
        tableId={tableId}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      >
        <BrunoTableToolbar>
          <ToolbarProbe />
        </BrunoTableToolbar>
      </BrunoTableClient>,
    );
    await settleBrunoTableBrowserFrames();
    const selectionRenders = vi.fn();
    const viewRenders = vi.fn();
    const gridRenders = vi.fn();
    const headerRenders = vi.fn();
    const removeSelection = installBrunoTableRowSelectionRenderListener(tableId, selectionRenders);
    const removeView = installBrunoTableClientViewRenderListenerForTable(tableId, viewRenders);
    const removeGrid = installBrunoTableClientGridSurfaceRenderListenerForTable(
      tableId,
      gridRenders,
    );
    const removeHeader = installBrunoTableClientHeaderRenderListenerForTable(
      tableId,
      headerRenders,
    );
    toolbarRenders.mockClear();
    try {
      for (let publication = 0; publication < 20; publication += 1) {
        const publishedRows = rows.map((row) =>
          row.id === "a" ? { ...row, name: `Ada ${String(publication)}` } : row,
        );
        await screen.rerender(
          <BrunoTableClient
            tableId={tableId}
            columns={columns}
            initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
            clientSource={{
              rows: publishedRows,
              totalRows: publishedRows.length,
              version: publication + 2,
              status: "ready",
            }}
            getRowId={(row) => row.id}
            rowSelection
          >
            <BrunoTableToolbar>
              <ToolbarProbe />
            </BrunoTableToolbar>
          </BrunoTableClient>,
        );
        await settleBrunoTableBrowserFrames();
      }
      expect(selectionRenders).not.toHaveBeenCalled();
      expect(toolbarRenders).not.toHaveBeenCalled();
      expect(viewRenders).not.toHaveBeenCalled();
      expect(gridRenders).not.toHaveBeenCalled();
      expect(headerRenders).not.toHaveBeenCalled();

      await page.getByRole("checkbox", { name: "Select row 1", exact: true }).click();
      expect(selectionRenders).toHaveBeenCalledTimes(2);
      expect(selectionRenders.mock.calls).toEqual([
        ["header", undefined],
        ["row", "a"],
      ]);
      expect(toolbarRenders).not.toHaveBeenCalled();
      expect(viewRenders).not.toHaveBeenCalled();
      expect(gridRenders).not.toHaveBeenCalled();
      expect(headerRenders).not.toHaveBeenCalled();
    } finally {
      removeHeader();
      removeGrid();
      removeView();
      removeSelection();
    }
  });

  test("keeps a non-opted-in Client table free of Row Selection UI", async () => {
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_NO_ROW_SELECTION"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
      />,
    );
    await settleBrunoTableBrowserFrames();

    await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
  });
});

function rowCheckboxForCell(cellName: string): HTMLElement {
  const row = page.getByRole("gridcell", { name: cellName }).element().closest('[role="row"]');
  const checkbox = row?.querySelector<HTMLElement>('[role="checkbox"]');
  if (checkbox === null || checkbox === undefined) {
    throw new Error(`No row checkbox was mounted for ${cellName}.`);
  }
  return checkbox;
}
