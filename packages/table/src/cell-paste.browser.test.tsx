import { detectPlatform } from "@tanstack/react-hotkeys";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient } from "./index";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import { BRUNO_TABLE_PASTE_MAX_TEXT_CODE_UNITS } from "./internal/cell-paste";
import type { BrunoTableColumns } from "./public-types";

type Row = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly score: number;
  readonly note: string;
  readonly revision: bigint;
}>;

type ExactRow = Readonly<{
  readonly id: string;
  readonly quantity: bigint;
  readonly revision: bigint;
}>;

const columns = [
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
    isEditable: true,
  },
  {
    columnId: "COL_ID_SCORE",
    field: "score",
    headerName: "Score",
    valueType: "number",
    isEditable: true,
  },
  {
    columnId: "COL_ID_NOTE",
    field: "note",
    headerName: "Note",
    valueType: "text",
    isEditable: true,
  },
] satisfies BrunoTableColumns<Row>;

const columnsWithReadOnlyNote = [
  columns[0]!,
  columns[1]!,
  {
    columnId: "COL_ID_NOTE",
    field: "note",
    headerName: "Note",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Row>;

const columnsWithValidatedNote = [
  columns[0]!,
  columns[1]!,
  {
    columnId: "COL_ID_NOTE",
    field: "note",
    headerName: "Note",
    valueType: "text",
    isEditable: true,
    validate: ({ value }: { readonly value: string }) =>
      value === "bad" ? "Note must not be bad." : undefined,
  },
] satisfies BrunoTableColumns<Row>;

const columnsWithCommaMarker = [
  columns[0]!,
  {
    ...columns[1]!,
    headerName: "Revenue, row forecast",
  },
  columns[2]!,
] satisfies BrunoTableColumns<Row>;

const rows = [
  { id: "ada", name: "Ada", score: 4, note: "first", revision: 1n },
  { id: "grace", name: "Grace", score: 8, note: "last", revision: 1n },
] satisfies readonly Row[];

const exactColumns = [
  {
    columnId: "COL_ID_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
    valueType: "bigint",
    isEditable: true,
    valueFormatter: ({ value }: { readonly value: bigint }) => `display:${String(value)}`,
  },
] satisfies BrunoTableColumns<ExactRow>;

function pasteGesture(): string {
  return detectPlatform() === "mac" ? "{Meta>}v{/Meta}" : "{Control>}v{/Control}";
}

function installClipboard(text: string | (() => Promise<string>)): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      readText: vi.fn(typeof text === "string" ? async () => text : text),
    },
  });
  return () => {
    if (descriptor === undefined) delete (navigator as { clipboard?: Clipboard }).clipboard;
    else Object.defineProperty(navigator, "clipboard", descriptor);
  };
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("broadcasts one canonical clipboard cell across one Batch range as one undo gesture", async () => {
  const restoreClipboard = installClipboard("6");
  try {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_ATOMIC_PASTE_BROADCAST"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_ATOMIC_PASTE_BROADCAST" });
    expect(grid.element().getAttribute("aria-keyshortcuts")).toContain("Control+V Meta+V");
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await settleBrunoTableBrowserFrames();

    await userEvent.keyboard(pasteGesture());

    await vi.waitFor(() =>
      expect(grid.getByRole("gridcell", { name: "6", exact: true }).all()).toHaveLength(2),
    );
    expect(onSaveEdits).not.toHaveBeenCalled();
    await userEvent.keyboard(
      detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
    );
    await expect.element(grid.getByRole("gridcell", { name: "4", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "first", exact: true })).toBeVisible();
  } finally {
    restoreClipboard();
  }
});

test("confirms an orientation mismatch, reruns atomic parsing, and restores grid focus", async () => {
  const restoreClipboard = installClipboard("6\nbad");
  try {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_CONFIRMATION"
        columns={columnsWithCommaMarker}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_CONFIRMATION" });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await userEvent.keyboard(pasteGesture());

    const dialog = page.getByRole("alertdialog", { name: "Confirm paste" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog)
      .toHaveAccessibleDescription(
        "The clipboard shape does not match the current selection. Copied: 2-cell vertical line. Selected: 2-cell horizontal line. Proposed: 2-cell vertical line. Start: Revenue, row forecast, row 1. End: Revenue, row forecast, row 2. Confirm the proposed linear destination before applying any values.",
      );
    expect(
      dialog
        .getByRole("definition")
        .all()
        .map((entry) => entry.element().textContent),
    ).toEqual([
      "2-cell vertical line",
      "2-cell horizontal line",
      "2-cell vertical line",
      "Revenue, row forecast, row 1",
      "Revenue, row forecast, row 2",
    ]);

    await userEvent.click(dialog.getByRole("button", { name: "Paste" }));
    await expect.element(dialog.getByRole("alert")).toHaveTextContent("finite decimal number");
    expect(onSaveEdits).not.toHaveBeenCalled();

    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(page.getByRole("alertdialog").all()).toHaveLength(0));
    await expect.element(grid.getByRole("gridcell", { name: "4", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "8", exact: true })).toBeVisible();
    expect(document.activeElement).toBe(grid.element());

    await userEvent.keyboard(pasteGesture());
    await expect.element(page.getByRole("alertdialog", { name: "Confirm paste" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(page.getByRole("alertdialog").all()).toHaveLength(0));
    expect(document.activeElement).toBe(grid.element());
  } finally {
    restoreClipboard();
  }
});

test("confirms a valid mismatch as one Batch history command", async () => {
  const restoreClipboard = installClipboard("6\n7");
  try {
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_CONFIRM_ACCEPT"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={() => Promise.resolve()}
      />,
    );
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_CONFIRM_ACCEPT" });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await userEvent.keyboard(pasteGesture());
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "Paste" }));
    await vi.waitFor(() => {
      expect(grid.getByRole("gridcell", { name: "6", exact: true }).all()).toHaveLength(1);
      expect(grid.getByRole("gridcell", { name: "7", exact: true }).all()).toHaveLength(1);
    });
    expect(document.activeElement).toBe(grid.element());
    await userEvent.keyboard(
      detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
    );
    await expect.element(grid.getByRole("gridcell", { name: "4", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "8", exact: true })).toBeVisible();
  } finally {
    restoreClipboard();
  }
});

test("rejects a copied rectangle with one bounded toast and no edit", async () => {
  const restoreClipboard = installClipboard("1\t2\n3\t4");
  try {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_RECTANGLE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_RECTANGLE" });
    grid.element().focus();
    await userEvent.keyboard(pasteGesture());
    await userEvent.keyboard(pasteGesture());
    await vi.waitFor(() =>
      expect(
        page
          .getByRole("region", { name: "Notifications" })
          .all()
          .filter((region) =>
            region
              .element()
              .textContent?.includes("Copied 2×2. BrunoTable accepts only one row or one column."),
          ),
      ).toHaveLength(1),
    );
    await userEvent.click(page.getByRole("button", { name: "Close" }));
    await vi.waitFor(() =>
      expect(
        page
          .getByRole("region", { name: "Notifications" })
          .all()
          .some((region) =>
            region
              .element()
              .textContent?.includes("Copied 2×2. BrunoTable accepts only one row or one column."),
          ),
      ).toBe(false),
    );
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreClipboard();
  }
});

test("retains a Paste rejection across ready and loading body transitions", async () => {
  const restoreClipboard = installClipboard("1\t2\n3\t4");
  try {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const renderTable = (status: "loading" | "ready", version: number) => (
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_PERSISTENT_REJECTION"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{
          rows: status === "ready" ? rows : [],
          totalRows: rows.length,
          version,
          status,
        }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />
    );
    const screen = await render(renderTable("ready", 1));
    const grid = screen.getByRole("grid", {
      name: "Data for TABLE_ID_PASTE_PERSISTENT_REJECTION",
    });
    grid.element().focus();
    await userEvent.keyboard(pasteGesture());
    const rejectionIsVisible = () =>
      screen
        .getByRole("region", { name: "Notifications" })
        .all()
        .some((region) =>
          region
            .element()
            .textContent?.includes("Copied 2×2. BrunoTable accepts only one row or one column."),
        );
    await vi.waitFor(() => expect(rejectionIsVisible()).toBe(true));

    await screen.rerender(renderTable("loading", 2));
    await vi.waitFor(() => expect(rejectionIsVisible()).toBe(true));
    await screen.rerender(renderTable("ready", 3));
    await vi.waitFor(() => expect(rejectionIsVisible()).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await vi.waitFor(() => expect(rejectionIsVisible()).toBe(false));
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreClipboard();
  }
});

test("rejects over-budget clipboard text before confirmation or edit state exists", async () => {
  const restoreClipboard = installClipboard("x".repeat(BRUNO_TABLE_PASTE_MAX_TEXT_CODE_UNITS + 1));
  try {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_INPUT_BUDGET"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_INPUT_BUDGET" });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");

    await userEvent.keyboard(pasteGesture());

    await vi.waitFor(() =>
      expect(
        page
          .getByRole("region", { name: "Notifications" })
          .all()
          .filter((region) =>
            region.element().textContent?.includes("UTF-16 code-unit paste limit"),
          ),
      ).toHaveLength(1),
    );
    expect(page.getByRole("alertdialog").all()).toHaveLength(0);
    await expect.element(grid.getByRole("gridcell", { name: "4", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "first", exact: true })).toBeVisible();
    expect(page.getByRole("button", { name: "Undo" }).all()).toHaveLength(0);
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreClipboard();
  }
});

test("rejects a delayed paste when its exact ordered identity span changes", async () => {
  let resolveClipboard!: (text: string) => void;
  const clipboardText = new Promise<string>((resolve) => {
    resolveClipboard = resolve;
  });
  const restoreClipboard = installClipboard(() => clipboardText);
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_DELAYED_STRUCTURE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_DELAYED_STRUCTURE" });
    grid.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await userEvent.keyboard(pasteGesture());

    await userEvent.click(
      page.getByRole("button", { name: "Sort by Name, currently ascending, priority 1" }),
    );
    resolveClipboard("Ada updated\nGrace updated");

    await vi.waitFor(() =>
      expect(
        page
          .getByRole("region", { name: "Notifications" })
          .all()
          .some((region) =>
            region.element().textContent?.includes("destination changed while reading"),
          ),
      ).toBe(true),
    );
    expect(onSaveEdits).not.toHaveBeenCalled();
    expect(page.getByRole("button", { name: "Undo" }).all()).toHaveLength(0);
    await expect.element(grid.getByRole("gridcell", { name: "Ada", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "Grace", exact: true })).toBeVisible();
  } finally {
    restoreClipboard();
  }
});

test("submits a direct Immediate paste as one row-grouped save call", async () => {
  const restoreClipboard = installClipboard("6\tupdated");
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => new Promise<void>(() => undefined));
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_IMMEDIATE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_IMMEDIATE" });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await userEvent.keyboard(pasteGesture());
    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledTimes(1));
    expect(onSaveEdits.mock.calls[0]?.[0]).toMatchObject([
      {
        rowId: "ada",
        expectedVersion: 1n,
        changes: [
          { columnId: "COL_ID_SCORE", before: 4, after: 6 },
          { columnId: "COL_ID_NOTE", before: "first", after: "updated" },
        ],
      },
    ]);
  } finally {
    restoreClipboard();
  }
});

test("parses exact bigint canonical text instead of the displayed presentation", async () => {
  const exactValue = 9_007_199_254_740_993_123_456_789n;
  const restoreClipboard = installClipboard(String(exactValue));
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => new Promise<void>(() => undefined));
    const exactRows = [{ id: "exact", quantity: 1n, revision: 1n }] satisfies readonly ExactRow[];
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_EXACT_BIGINT"
        columns={exactColumns}
        initialOrderBy={[{ columnId: "COL_ID_QUANTITY", direction: "asc" }]}
        clientSource={{ rows: exactRows, totalRows: exactRows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
        projectEditRow={({ row, patch }) => Object.freeze({ ...row, ...patch })}
      />,
    );
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_EXACT_BIGINT" });
    await expect.element(grid.getByRole("gridcell", { name: "display:1" })).toBeVisible();
    grid.element().focus();

    await userEvent.keyboard(pasteGesture());

    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledTimes(1));
    expect(onSaveEdits.mock.calls[0]?.[0]).toMatchObject([
      {
        rowId: "exact",
        expectedVersion: 1n,
        changes: [
          {
            columnId: "COL_ID_QUANTITY",
            before: 1n,
            after: exactValue,
          },
        ],
      },
    ]);
  } finally {
    restoreClipboard();
  }
});

test("submits a multi-row Immediate paste in one atomic row-grouped save call", async () => {
  const restoreClipboard = installClipboard("Ada updated\nGrace updated");
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => new Promise<void>(() => undefined));
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_IMMEDIATE_MULTI_ROW"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_IMMEDIATE_MULTI_ROW" });
    grid.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");

    await userEvent.keyboard(pasteGesture());

    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledTimes(1));
    expect(onSaveEdits.mock.calls[0]?.[0]).toMatchObject([
      {
        rowId: "ada",
        expectedVersion: 1n,
        changes: [{ columnId: "COL_ID_NAME", before: "Ada", after: "Ada updated" }],
      },
      {
        rowId: "grace",
        expectedVersion: 1n,
        changes: [{ columnId: "COL_ID_NAME", before: "Grace", after: "Grace updated" }],
      },
    ]);
  } finally {
    restoreClipboard();
  }
});

test("keeps an out-of-bounds mismatch open with no partial edit", async () => {
  const restoreClipboard = installClipboard("6\n7\n8");
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_OUT_OF_BOUNDS"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_OUT_OF_BOUNDS" });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await userEvent.keyboard(pasteGesture());
    const dialog = page.getByRole("alertdialog", { name: "Confirm paste" });
    await expect.element(dialog).toBeVisible();

    await userEvent.click(dialog.getByRole("button", { name: "Paste" }));

    await expect
      .element(dialog.getByRole("alert"))
      .toHaveTextContent("outside the available table");
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(page.getByRole("alertdialog").all()).toHaveLength(0));
    await expect.element(grid.getByRole("gridcell", { name: "4", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "first", exact: true })).toBeVisible();
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreClipboard();
  }
});

test("keeps confirmation open when its retained destination identities disappear", async () => {
  const restoreClipboard = installClipboard("6\n7");
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_DISAPPEARING_TARGET"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
    const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_PASTE_DISAPPEARING_TARGET" });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await userEvent.keyboard(pasteGesture());
    const dialog = screen.getByRole("alertdialog", { name: "Confirm paste" });
    await expect.element(dialog).toBeVisible();

    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_DISAPPEARING_TARGET"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows: [rows[0]!], totalRows: 1, version: 2, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(dialog.getByRole("button", { name: "Paste" }));

    await expect
      .element(dialog.getByRole("alert"))
      .toHaveTextContent("destination changed before confirmation");
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreClipboard();
  }
});

test("rejects a gesture containing an Immediate save-locked cell without a valid suffix", async () => {
  const restoreFirstClipboard = installClipboard("6");
  let restoreSecondClipboard: (() => void) | undefined;
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => new Promise<void>(() => undefined));
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_SAVE_LOCKED"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_SAVE_LOCKED" });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard(pasteGesture());
    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledTimes(1));

    restoreFirstClipboard();
    restoreSecondClipboard = installClipboard("7\tupdated");
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await userEvent.keyboard(pasteGesture());

    await vi.waitFor(() =>
      expect(
        page
          .getByRole("region", { name: "Notifications" })
          .all()
          .some((region) => region.element().textContent?.includes("destination cell is saving")),
      ).toBe(true),
    );
    expect(onSaveEdits).toHaveBeenCalledTimes(1);
    await expect.element(grid.getByRole("gridcell", { name: "first", exact: true })).toBeVisible();
  } finally {
    restoreSecondClipboard?.();
    restoreFirstClipboard();
  }
});

test("rejects a stale Batch destination without overwriting conflict evidence", async () => {
  const restoreFirstClipboard = installClipboard("6");
  let restoreSecondClipboard: (() => void) | undefined;
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_STALE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
    const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_PASTE_STALE" });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard(pasteGesture());
    await expect.element(grid.getByRole("gridcell", { name: "6", exact: true })).toBeVisible();

    await screen.rerender(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_STALE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{
          rows: [{ ...rows[0]!, score: 5, revision: 2n }, rows[1]!],
          totalRows: rows.length,
          version: 2,
          status: "ready",
        }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "1 conflict" }).all()).toHaveLength(1),
    );
    restoreFirstClipboard();
    restoreSecondClipboard = installClipboard("7");
    grid.element().focus();
    await userEvent.keyboard(pasteGesture());

    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("region", { name: "Notifications" })
          .all()
          .some((region) => region.element().textContent?.includes("stale conflict")),
      ).toBe(true),
    );
    await expect.element(grid.getByRole("gridcell", { name: "6", exact: true })).toBeVisible();
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreSecondClipboard?.();
    restoreFirstClipboard();
  }
});

test("rejects a vector containing a read-only destination without a valid prefix", async () => {
  const restoreClipboard = installClipboard("6\tupdated");
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_READ_ONLY"
        columns={columnsWithReadOnlyNote}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_READ_ONLY" });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await userEvent.keyboard(pasteGesture());
    await vi.waitFor(() =>
      expect(
        page
          .getByRole("region", { name: "Notifications" })
          .all()
          .some((region) =>
            region
              .element()
              .textContent?.includes(
                "Note, row 1: This destination cell is read-only. Nothing was applied.",
              ),
          ),
      ).toBe(true),
    );
    await expect.element(grid.getByRole("gridcell", { name: "4", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "first", exact: true })).toBeVisible();
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreClipboard();
  }
});

test("rejects a vector containing an invalid destination without a valid prefix", async () => {
  const restoreClipboard = installClipboard("6\tbad");
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_INVALID"
        columns={columnsWithValidatedNote}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_INVALID" });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await userEvent.keyboard(pasteGesture());

    await vi.waitFor(() =>
      expect(
        page
          .getByRole("region", { name: "Notifications" })
          .all()
          .some((region) => region.element().textContent?.includes("Note must not be bad")),
      ).toBe(true),
    );
    await expect.element(grid.getByRole("gridcell", { name: "4", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "first", exact: true })).toBeVisible();
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreClipboard();
  }
});

test("rejects a direct all-no-op paste without history, save, or false success", async () => {
  const restoreClipboard = installClipboard("Ada");
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_UNCHANGED"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_UNCHANGED" });
    grid.element().focus();
    await userEvent.keyboard(pasteGesture());

    await vi.waitFor(() =>
      expect(
        page
          .getByRole("region", { name: "Notifications" })
          .all()
          .some((region) => region.element().textContent?.includes("did not change the table")),
      ).toBe(true),
    );
    expect(page.getByRole("button", { name: "Undo" }).all()).toHaveLength(0);
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreClipboard();
  }
});

test("keeps an unchanged confirmed mismatch open with an inline reason", async () => {
  const restoreClipboard = installClipboard("4\n8");
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_CONFIRMED_UNCHANGED"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", {
      name: "Data for TABLE_ID_PASTE_CONFIRMED_UNCHANGED",
    });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await userEvent.keyboard(pasteGesture());
    const dialog = page.getByRole("alertdialog", { name: "Confirm paste" });
    await userEvent.click(dialog.getByRole("button", { name: "Paste" }));

    await expect.element(dialog.getByRole("alert")).toHaveTextContent("did not change the table");
    await expect.element(dialog).toBeVisible();
    expect(page.getByRole("button", { name: "Undo" }).all()).toHaveLength(0);
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreClipboard();
  }
});

test("rejects a structurally invalidated range before clipboard fallback or read", async () => {
  const readClipboard = vi.fn(async () => "Ada updated");
  const restoreClipboard = installClipboard(() => readClipboard());
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_PREINVALIDATED"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_PREINVALIDATED" });
    grid.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await userEvent.click(
      page.getByRole("button", { name: "Sort by Name, currently ascending, priority 1" }),
    );
    grid.element().focus();
    await userEvent.keyboard(pasteGesture());

    await vi.waitFor(() =>
      expect(
        page
          .getByRole("region", { name: "Notifications" })
          .all()
          .some((region) => region.element().textContent?.includes("destination changed")),
      ).toBe(true),
    );
    expect(readClipboard).not.toHaveBeenCalled();
    expect(page.getByRole("button", { name: "Undo" }).all()).toHaveLength(0);
    expect(onSaveEdits).not.toHaveBeenCalled();
  } finally {
    restoreClipboard();
  }
});

test("allows only one clipboard read in flight and ignores its completion after unmount", async () => {
  let resolveClipboard!: (text: string) => void;
  const pending = new Promise<string>((resolve) => {
    resolveClipboard = resolve;
  });
  const readClipboard = vi.fn(() => pending);
  const restoreClipboard = installClipboard(() => readClipboard());
  try {
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_PASTE_ONE_READ"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />,
    );
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_PASTE_ONE_READ" });
    grid.element().focus();
    await userEvent.keyboard(pasteGesture());
    await userEvent.keyboard(pasteGesture());
    expect(readClipboard).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(
        page
          .getByRole("region", { name: "Notifications" })
          .all()
          .some((region) =>
            region.element().textContent?.includes("A clipboard read is already in progress."),
          ),
      ).toBe(true),
    );

    await cleanup();
    resolveClipboard("Updated");
    await Promise.resolve();
    await Promise.resolve();
    expect(onSaveEdits).not.toHaveBeenCalled();
    expect(page.getByRole("alertdialog").all()).toHaveLength(0);
  } finally {
    restoreClipboard();
  }
});
