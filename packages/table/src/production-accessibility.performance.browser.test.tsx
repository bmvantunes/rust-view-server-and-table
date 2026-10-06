import type { CDPSession as PlaywrightCDPSession } from "@vitest/browser-playwright";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { cdp, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient } from "./index";
import { getBrunoTableBenchmarkEnvironment } from "./internal/benchmark-profile";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import type { BrunoTableColumns } from "./public-types";

type AccessibilityRow = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly revision: bigint;
}>;

const rows = Object.freeze([
  Object.freeze({ id: "accessibility-row-0000", name: "Accessibility row 0000", revision: 1n }),
] satisfies readonly AccessibilityRow[]);
const columns = [
  {
    columnId: "COL_ID_ACCESSIBILITY_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
    width: 180,
    isEditable: true,
  },
] as const satisfies BrunoTableColumns<AccessibilityRow>;

type AccessibilityMatrixRow = Readonly<{
  readonly id: string;
  readonly desk: string;
  readonly symbol: string;
  readonly venue: string;
  readonly owner: string;
  readonly strategy: string;
  readonly quantity: bigint;
  readonly status: string;
}>;

const matrixRows = Object.freeze([
  Object.freeze({
    id: "matrix-1",
    desk: "Alpha",
    symbol: "AAPL",
    venue: "XNAS",
    owner: "Ada",
    strategy: "Momentum",
    quantity: 12n,
    status: "Open",
  }),
  Object.freeze({
    id: "matrix-2",
    desk: "Beta",
    symbol: "MSFT",
    venue: "XNYS",
    owner: "Grace",
    strategy: "Value",
    quantity: 7n,
    status: "Closed",
  }),
] satisfies readonly AccessibilityMatrixRow[]);

const matrixColumns = [
  {
    columnId: "COL_ID_MATRIX_DESK",
    field: "desk",
    headerName: "Desk",
    valueType: "text",
    groupBy: true,
    pinned: "start",
    width: 180,
  },
  {
    columnId: "COL_ID_MATRIX_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
    width: 240,
  },
  {
    columnId: "COL_ID_MATRIX_VENUE",
    field: "venue",
    headerName: "Venue",
    valueType: "text",
    width: 240,
  },
  {
    columnId: "COL_ID_MATRIX_OWNER",
    field: "owner",
    headerName: "Owner",
    valueType: "text",
    width: 240,
  },
  {
    columnId: "COL_ID_MATRIX_STRATEGY",
    field: "strategy",
    headerName: "Strategy",
    valueType: "text",
    width: 240,
  },
  {
    columnId: "COL_ID_MATRIX_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
    valueType: "bigint",
    aggFunc: "sum",
    width: 220,
  },
  {
    columnId: "COL_ID_MATRIX_STATUS",
    field: "status",
    headerName: "Status",
    valueType: "text",
    pinned: "end",
    width: 180,
  },
] as const satisfies BrunoTableColumns<AccessibilityMatrixRow>;

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe("BrunoTable production accessibility acceptance", () => {
  test("records the exact capable-hardware runtime profile", () => {
    const environment = getBrunoTableBenchmarkEnvironment();

    expect(environment).toEqual({
      browserEngine: "chromium",
      devicePixelRatio: window.devicePixelRatio,
      logicalProcessorCount: navigator.hardwareConcurrency,
      mode: import.meta.env.MODE,
      profile: "chromium-capable-hardware-v1",
      userAgent: navigator.userAgent,
      viewport: { height: window.innerHeight, width: window.innerWidth },
    });
    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.viewport)).toBe(true);
  });

  test("keeps headers, body, pinned reveal, filters, grouping, and selection keyboard-perceivable", async () => {
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_PRODUCTION_ACCESSIBILITY_MATRIX"
        getRowId={(row: AccessibilityMatrixRow) => row.id}
        columns={matrixColumns}
        initialOrderBy={[{ columnId: "COL_ID_MATRIX_SYMBOL", direction: "asc" }]}
        clientSource={{
          rows: matrixRows,
          totalRows: matrixRows.length,
          version: 1,
          status: "ready",
        }}
        groupRowsColumn={{ headerName: "Orders", width: 120 }}
        rowSelection
      />,
    );
    await settleBrunoTableBrowserFrames(3);

    const grid = screen.getByRole("grid", {
      name: "Data for TABLE_ID_PRODUCTION_ACCESSIBILITY_MATRIX",
    });
    await expect.element(grid).toHaveAttribute("aria-rowcount", "3");
    await expect.element(grid).toHaveAttribute("aria-colcount", "8");
    await expect
      .element(screen.getByRole("columnheader", { name: /Symbol, sorted ascending/u }))
      .toHaveAttribute("aria-sort", "ascending");
    await expect
      .element(screen.getByRole("gridcell", { name: "AAPL", exact: true }))
      .toBeInTheDocument();

    const pinnedStart = document.querySelector<HTMLElement>(
      '[data-bruno-pinned-body-region="start"]',
    );
    const pinnedEnd = document.querySelector<HTMLElement>('[data-bruno-pinned-body-region="end"]');
    expect(pinnedStart).not.toBeNull();
    expect(pinnedEnd).not.toBeNull();

    const firstSelection = screen.getByRole("checkbox", { name: "Select row 1" });
    firstSelection.element().focus();
    await userEvent.keyboard(" ");
    await expect.element(firstSelection).toBeChecked();
    await expect
      .element(screen.getByRole("checkbox", { name: "Select all rows" }))
      .toHaveAttribute("aria-checked", "mixed");

    grid.element().focus();
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{Alt>}{Enter}{/Alt}");
    const filter = screen.getByRole("dialog", { name: "Filter Desk" });
    await expect.element(filter).toBeInTheDocument();
    await userEvent.fill(filter.getByRole("textbox", { name: "Filter value for Desk" }), "Alpha");
    await expect
      .element(screen.getByRole("gridcell", { name: "Beta", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect.element(grid).toHaveFocus();
    await expect
      .element(screen.getByRole("button", { name: "Filter Desk (active)" }))
      .toBeInTheDocument();

    await userEvent.keyboard("{ArrowDown}");
    for (let index = 1; index < matrixColumns.length; index += 1) {
      await userEvent.keyboard("{ArrowRight}");
    }
    const activeId = grid.element().getAttribute("aria-activedescendant");
    const active = activeId === null ? null : document.getElementById(activeId);
    expect(active?.textContent).toContain("Open");
    expect(active?.closest('[data-bruno-pinned-body-region="end"]')).not.toBeNull();

    const addGroup = screen
      .getByRole("region", { name: "Group By" })
      .getByRole("combobox", { name: "Add Group" });
    addGroup.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("option", { name: "Desk", exact: true }));
    await expect
      .element(screen.getByRole("button", { name: /Desk, position 1 of 1/u }))
      .toHaveAccessibleDescription(/Alt\+Left Arrow or Alt\+Right Arrow/u);
    await expect.element(screen.getByRole("gridcell", { name: /Alpha/u })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select all rows" }).all()).toHaveLength(0);
    expect(screen.getByRole("checkbox", { name: /Select row/u }).all()).toHaveLength(0);
    await expect.element(screen.getByRole("status")).toHaveTextContent("Desk added at position 1");
  }, 30_000);

  test("keeps save state perceivable without motion and exposes keyboard notification actions", async () => {
    expect(import.meta.env.MODE).toBe("production");
    expect(__BRUNO_TABLE_DEVELOPMENT__).toBe(false);

    const session: PlaywrightCDPSession = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    let rejectFirstSave!: (reason: Error) => void;
    let saveAttempt = 0;
    const onSaveEdits = vi.fn(() => {
      saveAttempt += 1;
      if (saveAttempt > 1) return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        rejectFirstSave = reject;
      });
    });

    try {
      const screen = await render(
        <BrunoTableClient
          tableId="TABLE_ID_PRODUCTION_ACCESSIBILITY"
          getRowId={(row: AccessibilityRow) => row.id}
          columns={columns}
          initialOrderBy={[{ columnId: "COL_ID_ACCESSIBILITY_NAME", direction: "asc" }]}
          clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
          editable
          getRowVersion={(row) => row.revision}
          onSaveEdits={onSaveEdits}
        />,
      );
      const grid = screen.getByRole("grid", {
        name: "Data for TABLE_ID_PRODUCTION_ACCESSIBILITY",
      });
      await expect.element(grid).toHaveAttribute("aria-rowcount", "2");
      await expect.element(grid).toHaveAttribute("aria-colcount", "1");
      await settleBrunoTableBrowserFrames(3);

      grid.element().focus();
      await userEvent.keyboard("{F2}");
      await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "A11y pending");
      await userEvent.keyboard("{Enter}");
      expect(onSaveEdits).toHaveBeenCalledTimes(1);

      const pendingCell = grid.getByRole("gridcell", { name: "A11y pending", exact: true });
      await expect.element(pendingCell).toHaveAttribute("data-bruno-save-pending", "");
      await expect.element(pendingCell).toHaveAttribute("aria-busy", "true");
      await expect
        .element(screen.getByRole("region", { name: "Edit safety" }))
        .toHaveTextContent("1 Immediate save pending");
      const spinner = pendingCell.element().querySelector<SVGElement>("svg");
      if (spinner === null)
        throw new Error("A pending save must retain its non-color spinner cue.");
      expect(getComputedStyle(spinner).animationName).toBe("none");

      rejectFirstSave(new Error("Version changed on the server."));
      const notificationRegion = screen.getByRole("region", { name: "Notifications" });
      await expect.element(notificationRegion).toHaveAttribute("aria-live", "polite");
      await expect
        .element(notificationRegion)
        .toHaveTextContent("Open Operation details for the complete explanation.");
      const failedCell = grid.getByRole("gridcell", {
        name: "Accessibility row 0000",
        exact: true,
      });
      await expect.element(failedCell).toHaveAttribute("data-bruno-save-failed", "");
      expect(failedCell.element().textContent).toContain("!");

      const operationDetails = notificationRegion.getByRole("button", {
        name: "Operation details",
      });
      operationDetails.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect
        .element(screen.getByRole("alertdialog", { name: "Save operation details" }))
        .toHaveTextContent("Version changed on the server.");
      await userEvent.keyboard("{Escape}");
      await expect
        .element(screen.getByRole("alertdialog", { name: "Save operation details" }))
        .not.toBeInTheDocument();

      const closeToast = notificationRegion.getByRole("button", { name: "Close toast" });
      closeToast.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect
        .element(notificationRegion)
        .not.toHaveTextContent("Open Operation details for the complete explanation.");

      grid.element().focus();
      await userEvent.keyboard("{Enter}");
      await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "A11y accepted");
      await userEvent.keyboard("{Enter}");
      const acceptedCell = grid.getByRole("gridcell", { name: "A11y accepted", exact: true });
      await expect.element(acceptedCell).toHaveAttribute("data-bruno-save-success", "");
      await expect
        .element(screen.getByRole("region", { name: "Edit safety" }))
        .toHaveTextContent("1 Immediate save accepted · waiting for live confirmation");
      const successStyle = getComputedStyle(acceptedCell.element(), "::after");
      expect(successStyle.animationName).toBe("none");
      expect(successStyle.opacity).toBe("1");
      expect(onSaveEdits).toHaveBeenCalledTimes(2);
    } finally {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    }
  }, 30_000);
});
