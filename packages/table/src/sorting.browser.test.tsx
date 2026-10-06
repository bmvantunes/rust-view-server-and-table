import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient } from "./index";
import { installBrunoTableGridCommandListener } from "./internal/grid-command-instrumentation";
import { installBrunoTableClientSortPanelRenderListenerForTable } from "./internal/render-instrumentation";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

type Row = {
  readonly id: string;
  readonly name: string;
  readonly score: number;
  readonly quantity: bigint;
};

const columns = [
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
] as const;

const rows = [
  { id: "grace", name: "Grace", score: 2, quantity: 9_007_199_254_740_993n },
  { id: "ada", name: "Ada", score: 4, quantity: 9_007_199_254_740_992n },
] satisfies readonly Row[];

function source(nextRows: readonly Row[] = rows, version = 1) {
  return {
    rows: nextRows,
    totalRows: nextRows.length,
    version,
    status: "ready" as const,
  };
}

const props = {
  tableId: "TABLE_ID_SORTING",
  getRowId: (row: Row) => row.id,
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SCORE", direction: "asc" as const }],
} as const;

describe("BrunoTableClient sorting", () => {
  test("dispatches Shift+Enter with the same typed multi-sort semantics as Shift-pointer", async () => {
    const commands = vi.fn();
    const removeListener = installBrunoTableGridCommandListener(props.tableId, commands);
    try {
      const screen = await render(<BrunoTableClient {...props} clientSource={source()} />);
      const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SORTING" });
      const nameHeader = screen.getByRole("columnheader", { name: "Name" });
      grid.element().focus();
      grid.element().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
      await vi.waitFor(() =>
        expect(grid.element().getAttribute("aria-activedescendant")).toBe(nameHeader.element().id),
      );

      grid
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter", shiftKey: true }),
        );
      await expect
        .element(
          screen.getByRole("button", {
            name: "Sort by Name, currently ascending, priority 2",
          }),
        )
        .toBeInTheDocument();
      expect(commands).toHaveBeenLastCalledWith({
        type: "column.sort.toggle",
        columnId: "COL_ID_NAME",
        multi: true,
      });

      grid
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter", shiftKey: true }),
        );
      await expect
        .element(
          screen.getByRole("button", {
            name: "Sort by Name, currently descending, priority 2",
          }),
        )
        .toBeInTheDocument();
      expect(commands).toHaveBeenLastCalledWith({
        type: "column.sort.toggle",
        columnId: "COL_ID_NAME",
        multi: true,
      });
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(nameHeader.element().id);
    } finally {
      removeListener();
    }
  });

  test("operates every Sort panel command from the keyboard without losing focus", async () => {
    const screen = await render(
      <>
        <input aria-label="External focus target" />
        <BrunoTableClient {...props} clientSource={source()} />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Sort rows, 1 active" });
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");

    const panel = screen.getByRole("dialog", { name: "Sort rows" });
    await expect.element(panel).toBeInTheDocument();
    await expect
      .element(panel.getByRole("listitem", { name: "Priority 1, Score, ascending" }))
      .toBeInTheDocument();

    const add = panel.getByRole("combobox", { name: "Add sort column" });
    const addElement = add.element() as HTMLSelectElement;
    addElement.focus();
    await userEvent.keyboard("n{Enter}");
    await expect
      .element(panel.getByRole("listitem", { name: "Priority 2, Name, ascending" }))
      .toBeInTheDocument();
    expect(document.activeElement).toBe(addElement);

    const toggleName = panel.getByRole("button", {
      name: "Toggle Name direction, currently ascending",
    });
    const toggleNameElement = toggleName.element();
    toggleNameElement.focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(panel.getByRole("listitem", { name: "Priority 2, Name, descending" }))
      .toBeInTheDocument();
    expect(document.activeElement).toBe(toggleNameElement);

    const moveNameEarlier = panel.getByRole("button", { name: "Move Name earlier" });
    moveNameEarlier.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(panel.getByRole("listitem", { name: "Priority 1, Name, descending" }))
      .toBeInTheDocument();
    expect(document.activeElement).toBe(
      panel.getByRole("button", { name: "Move Name earlier" }).element(),
    );

    const externalFocusTarget = screen.getByRole("textbox", { name: "External focus target" });
    externalFocusTarget.element().focus();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(document.activeElement).toBe(externalFocusTarget.element());
    await expect.element(panel).toBeInTheDocument();

    const removeScore = panel.getByRole("button", { name: "Remove Score" });
    removeScore.element().focus();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(document.activeElement).toBe(removeScore.element());
    await userEvent.keyboard("{Enter}");
    await expect.element(panel.getByRole("button", { name: "Remove Name" })).toBeDisabled();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        panel
          .getByRole("button", {
            name: "Toggle Name direction, currently descending",
          })
          .element(),
      ),
    );

    const reset = panel.getByRole("button", { name: "Reset sorting" });
    reset.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(panel.getByRole("listitem", { name: "Priority 1, Score, ascending" }))
      .toBeInTheDocument();
    expect(document.activeElement).toBe(reset.element());
  });

  test("resets only vertical position for a panel sort command", async () => {
    const wideColumns = [
      {
        columnId: "COL_ID_VALUE_00",
        field: "score",
        headerName: "Value 0",
        valueType: "number",
        width: 480,
      },
      {
        columnId: "COL_ID_VALUE_01",
        field: "score",
        headerName: "Value 1",
        valueType: "number",
        width: 480,
      },
      {
        columnId: "COL_ID_VALUE_02",
        field: "score",
        headerName: "Value 2",
        valueType: "number",
        width: 480,
      },
      {
        columnId: "COL_ID_VALUE_03",
        field: "score",
        headerName: "Value 3",
        valueType: "number",
        width: 480,
      },
    ] as const;
    const largeRows = Array.from({ length: 100 }, (_, index) => ({
      id: `row-${index}`,
      name: `Row ${index}`,
      score: index,
      quantity: BigInt(index),
    })) satisfies readonly Row[];
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_SORT_SCROLL"
        getRowId={(row: Row) => row.id}
        columns={wideColumns}
        initialOrderBy={[{ columnId: "COL_ID_VALUE_00", direction: "asc" }]}
        clientSource={source(largeRows)}
      />,
    );
    const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SORT_SCROLL" });
    grid.element().focus();
    expect(grid.element().getAttribute("aria-activedescendant")).not.toBeNull();
    grid.element().scrollLeft = 320;
    grid.element().scrollTop = 720;
    grid.element().dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const horizontalBefore = grid.element().scrollLeft;
    expect(horizontalBefore).toBeGreaterThan(0);
    expect(grid.element().scrollTop).toBeGreaterThan(0);

    await screen.getByRole("button", { name: "Sort rows, 1 active" }).click();
    const toggle = screen.getByRole("button", {
      name: "Toggle Value 0 direction, currently ascending",
    });
    const toggleElement = toggle.element();
    toggleElement.focus();
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => expect(grid.element().scrollTop).toBe(0));
    expect(grid.element().scrollLeft).toBe(horizontalBefore);
    expect(grid.element().getAttribute("aria-activedescendant")).toBeNull();
    expect(document.activeElement).toBe(toggleElement);
  });

  test("keeps the original sorting baseline when later props change", async () => {
    const screen = await render(<BrunoTableClient {...props} clientSource={source()} />);
    await screen.getByRole("button", { name: "Sort by Name", exact: true }).click();
    await expect
      .element(
        screen.getByRole("button", {
          name: "Sort by Name, currently ascending, priority 1",
        }),
      )
      .toBeInTheDocument();

    await screen.rerender(
      <BrunoTableClient
        {...props}
        initialOrderBy={[{ columnId: "COL_ID_QUANTITY", direction: "desc" }]}
        clientSource={source(rows, 2)}
      />,
    );
    await expect
      .element(
        screen.getByRole("button", {
          name: "Sort by Name, currently ascending, priority 1",
        }),
      )
      .toBeInTheDocument();

    await screen.getByRole("button", { name: "Sort rows, 1 active" }).click();
    await screen.getByRole("button", { name: "Reset sorting" }).click();
    await expect
      .element(screen.getByRole("listitem", { name: "Priority 1, Score, ascending" }))
      .toBeInTheDocument();
  });

  test("does not rerender the idle Sort panel for hot row publications", async () => {
    const sortPanelCommits = vi.fn();
    const removeListener = installBrunoTableClientSortPanelRenderListenerForTable(
      props.tableId,
      sortPanelCommits,
    );
    try {
      const screen = await render(<BrunoTableClient {...props} clientSource={source()} />);
      const commitsAfterMount = sortPanelCommits.mock.calls.length;
      expect(commitsAfterMount).toBeGreaterThan(0);

      await screen.rerender(
        <BrunoTableClient
          {...props}
          clientSource={source([{ ...rows[0]!, name: "Grace updated" }, rows[1]!], 2)}
        />,
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(sortPanelCommits).toHaveBeenCalledTimes(commitsAfterMount);

      await screen
        .getByRole("button", { name: "Sort by Score, currently ascending, priority 1" })
        .click();
      await vi.waitFor(() => expect(sortPanelCommits).toHaveBeenCalledTimes(commitsAfterMount + 1));
    } finally {
      removeListener();
    }
  });

  test("keeps exact multi-sort values and stable source order for equal keys", async () => {
    const exactRows = [
      { id: "z", name: "First source row", score: 1, quantity: 9_007_199_254_740_993n },
      { id: "a", name: "Second source row", score: 1, quantity: 9_007_199_254_740_992n },
      { id: "m", name: "Third source row", score: 1, quantity: 9_007_199_254_740_993n },
    ] satisfies readonly Row[];
    const screen = await render(
      <BrunoTableClient
        {...props}
        initialOrderBy={[
          { columnId: "COL_ID_SCORE", direction: "asc" },
          { columnId: "COL_ID_QUANTITY", direction: "asc" },
        ]}
        clientSource={source(exactRows)}
      />,
    );

    await expect
      .element(screen.getByRole("row").nth(1).getByRole("gridcell").nth(0))
      .toHaveTextContent("Second source row");
    await expect
      .element(screen.getByRole("row").nth(2).getByRole("gridcell").nth(0))
      .toHaveTextContent("First source row");
    await expect
      .element(screen.getByRole("row").nth(3).getByRole("gridcell").nth(0))
      .toHaveTextContent("Third source row");
  });

  test("follows a live-moved Active Cell by Row Identity without revealing it", async () => {
    const largeRows = Array.from({ length: 100 }, (_, index) => ({
      id: `row-${index}`,
      name: `Row ${index}`,
      score: index,
      quantity: BigInt(index),
    })) satisfies readonly Row[];
    const screen = await render(<BrunoTableClient {...props} clientSource={source(largeRows)} />);
    const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SORTING" });
    grid.element().focus();
    grid.element().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageDown" }));
    await vi.waitFor(() =>
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(
        screen.getByRole("gridcell", { name: "Row 12", exact: true }).element().id,
      ),
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const scrollBefore = grid.element().scrollTop;

    const movedRows = largeRows.map((row) =>
      row.id === "row-12" ? { ...row, score: 1_000 } : row,
    );
    await screen.rerender(<BrunoTableClient {...props} clientSource={source(movedRows, 2)} />);

    const movedProxy = screen.getByRole("gridcell", { name: "Row 12", exact: true });
    await expect.element(movedProxy).toHaveAttribute("data-bruno-active-proxy", "");
    expect(grid.element().getAttribute("aria-activedescendant")).toBe(movedProxy.element().id);
    expect(grid.element().scrollTop).toBe(scrollBefore);
  });

  test("preserves the viewport when a live active-row move also changes totalRows", async () => {
    const largeRows = Array.from({ length: 100 }, (_, index) => ({
      id: `row-${index}`,
      name: `Row ${index}`,
      score: index,
      quantity: BigInt(index),
    })) satisfies readonly Row[];
    const screen = await render(<BrunoTableClient {...props} clientSource={source(largeRows)} />);
    const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SORTING" });
    grid.element().focus();
    await userEvent.keyboard("{PageDown}");

    const activeBefore = screen.getByRole("gridcell", { name: "Row 12", exact: true });
    await vi.waitFor(() =>
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(activeBefore.element().id),
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const activeIdentity = activeBefore.element().id;
    const scrollBefore = grid.element().scrollTop;
    expect(scrollBefore).toBeGreaterThan(0);

    const publishedRows = [
      ...largeRows.map((row) => (row.id === "row-12" ? { ...row, score: 10_000 } : row)),
      {
        id: "row-inserted",
        name: "Inserted row",
        score: 12,
        quantity: 10_000n,
      },
    ] satisfies readonly Row[];
    expect(publishedRows).toHaveLength(101);

    await screen.rerender(<BrunoTableClient {...props} clientSource={source(publishedRows, 2)} />);
    const movedProxy = screen.getByRole("gridcell", { name: "Row 12", exact: true });
    await vi.waitFor(() => {
      expect(grid.element().getAttribute("aria-rowcount")).toBe("102");
      expect(grid.element().scrollTop).toBe(scrollBefore);
      expect(movedProxy.element().id).toBe(activeIdentity);
      expect(movedProxy.element().hasAttribute("data-bruno-active-proxy")).toBe(true);
    });

    expect(document.activeElement).toBe(grid.element());
    expect(grid.element().scrollTop).toBe(scrollBefore);
    await expect.element(movedProxy).toHaveAttribute("data-bruno-active-proxy", "");
    expect(movedProxy.element().id).toBe(activeIdentity);
    expect(movedProxy.element().parentElement?.getAttribute("aria-rowindex")).toBe("102");
    await expect.element(grid).toHaveAttribute("aria-rowcount", "102");
    expect(grid.element().getAttribute("aria-activedescendant")).toBe(activeIdentity);

    const oldDisplayRow = screen
      .getByRole("row")
      .all()
      .find(
        (row) =>
          row.element().getAttribute("aria-rowindex") === "14" &&
          row.element().hasAttribute("aria-owns"),
      );
    expect(oldDisplayRow).toBeDefined();
    expect(
      oldDisplayRow
        ?.getByRole("gridcell")
        .all()
        .some((cell) => cell.element().id === activeIdentity),
    ).toBe(false);
  });
});
