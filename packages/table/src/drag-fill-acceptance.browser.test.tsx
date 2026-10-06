import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { detectPlatform } from "@tanstack/react-hotkeys";
import { Schema } from "effect";
import { ViewServerId, defineViewServerConfig } from "effect-view-server/config";
import { createViewServerReact } from "effect-view-server/react";
import { StrictMode } from "react";

import { BrunoTableClient, BrunoTableServer } from "./index";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import { installBrunoTableCellRangeInstrumentationListener } from "./internal/cell-range-clipboard";
import type { BrunoTableColumns } from "./public-types";

type FillRow = Readonly<{
  readonly id: string;
  readonly first: string;
  readonly second: string;
  readonly third: string;
  readonly fourth: string;
  readonly revision: bigint;
}>;

const editableColumns = [
  {
    columnId: "COL_ID_FIRST",
    field: "first",
    headerName: "First",
    valueType: "text",
    width: 80,
    isEditable: true,
  },
  {
    columnId: "COL_ID_SECOND",
    field: "second",
    headerName: "Second",
    valueType: "text",
    width: 80,
    isEditable: true,
  },
  {
    columnId: "COL_ID_THIRD",
    field: "third",
    headerName: "Third",
    valueType: "text",
    width: 80,
    isEditable: true,
  },
  {
    columnId: "COL_ID_FOURTH",
    field: "fourth",
    headerName: "Fourth",
    valueType: "text",
    width: 80,
    isEditable: true,
  },
] as const satisfies BrunoTableColumns<FillRow>;

const readOnlyColumns = [
  {
    columnId: "COL_ID_FIRST",
    field: "first",
    headerName: "First",
    valueType: "text",
    width: 80,
  },
  {
    columnId: "COL_ID_SECOND",
    field: "second",
    headerName: "Second",
    valueType: "text",
    width: 80,
  },
  {
    columnId: "COL_ID_THIRD",
    field: "third",
    headerName: "Third",
    valueType: "text",
    width: 80,
  },
  {
    columnId: "COL_ID_FOURTH",
    field: "fourth",
    headerName: "Fourth",
    valueType: "text",
    width: 80,
  },
] as const satisfies BrunoTableColumns<FillRow>;

const pinnedEditableColumns = [
  editableColumns[0],
  editableColumns[1],
  editableColumns[2],
  { ...editableColumns[3], pinned: "end" as const },
] as const satisfies BrunoTableColumns<FillRow>;

const permissionEditableColumns = [
  {
    ...editableColumns[0],
    isEditable: ({ row }: { readonly row: FillRow }) => row.fourth !== "locked",
  },
  editableColumns[1],
  editableColumns[2],
  editableColumns[3],
] as const satisfies BrunoTableColumns<FillRow>;

const dragFillViewportReact = createViewServerReact(
  defineViewServerConfig({
    topics: {
      fills: {
        schema: Schema.Struct({
          id: ViewServerId,
          first: Schema.String,
          second: Schema.String,
          third: Schema.String,
          fourth: Schema.String,
          revision: Schema.BigInt,
        }),
      },
    },
  }),
);

type DragFillViewportSource = ReturnType<typeof dragFillViewportReact.useLiveQueryViewport>;
type ObservedSaveChangeSet = readonly [
  Readonly<{
    readonly rowId: string;
    readonly expectedVersion: bigint;
    readonly changes: unknown;
  }>,
];

type SaveMock = Readonly<{
  readonly mock: Readonly<{ readonly calls: readonly unknown[] }>;
}>;

const groupingColumns = [
  {
    ...readOnlyColumns[0],
    groupBy: true,
  },
  readOnlyColumns[1],
  readOnlyColumns[2],
  readOnlyColumns[3],
] as const satisfies BrunoTableColumns<FillRow>;

const rows = [
  {
    id: "row-1",
    first: "alpha",
    second: "beta",
    third: "gamma",
    fourth: "delta",
    revision: 1n,
  },
] satisfies readonly FillRow[];

function centerOf(element: Element): Readonly<{ x: number; y: number }> {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}

function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  pointerId: number,
  point: Readonly<{ x: number; y: number }>,
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    pointerId,
  });
}

function undoGesture(): string {
  return detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}";
}

function redoGesture(): string {
  return detectPlatform() === "mac" ? "{Meta>}{Shift>}z{/Shift}{/Meta}" : "{Control>}y{/Control}";
}

function pasteGesture(): string {
  return detectPlatform() === "mac" ? "{Meta>}v{/Meta}" : "{Control>}v{/Control}";
}

function installClipboard(readText: () => Promise<string>): {
  readonly readText: ReturnType<typeof vi.fn>;
  readonly restore: () => void;
} {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const read = vi.fn(readText);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: read },
  });
  return Object.freeze({
    readText: read,
    restore: () => {
      if (descriptor === undefined) delete (navigator as { clipboard?: Clipboard }).clipboard;
      else Object.defineProperty(navigator, "clipboard", descriptor);
    },
  });
}

function dragHandle(grid: Element): HTMLElement {
  const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
  if (handle === null) throw new Error("Expected the selected fill source to expose its handle.");
  return handle;
}

function cell(grid: ReturnType<typeof page.getByRole>, name: string): HTMLElement {
  return grid.getByRole("gridcell", { name, exact: true }).element() as HTMLElement;
}

async function selectTwoCellSource(grid: Element): Promise<void> {
  (grid as HTMLElement).focus();
  await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
  await settleBrunoTableBrowserFrames();
}

async function dragTo(grid: Element, target: HTMLElement, pointerId: number): Promise<void> {
  const handle = dragHandle(grid);
  handle.dispatchEvent(pointer("pointerdown", pointerId, centerOf(handle)));
  target.dispatchEvent(pointer("pointermove", pointerId, centerOf(target)));
  await settleBrunoTableBrowserFrames();
  target.dispatchEvent(pointer("pointerup", pointerId, centerOf(target)));
}

function observedSaveChangeSet(onSaveEdits: SaveMock): ObservedSaveChangeSet {
  const call = onSaveEdits.mock.calls[0] as readonly [ObservedSaveChangeSet] | undefined;
  if (call === undefined) throw new Error("Expected one observed Save Change Set.");
  return call[0];
}

function clientTable(
  tableId: string,
  onSaveEdits: (changes: unknown) => PromiseLike<void>,
  clientRows: readonly FillRow[] = rows,
  version = 1,
  columns: BrunoTableColumns<FillRow> = editableColumns,
) {
  return (
    <div style={{ width: 480 }}>
      <BrunoTableClient
        tableId={tableId}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
        clientSource={{ rows: clientRows, totalRows: clientRows.length, version, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />
    </div>
  );
}

function clientTableWithOutsideReleaseTarget(
  tableId: string,
  onSaveEdits: (changes: unknown) => PromiseLike<void>,
) {
  return (
    <div style={{ display: "flex", gap: 24, width: 320 }}>
      <div style={{ width: 240 }}>
        <BrunoTableClient
          tableId={tableId}
          columns={editableColumns}
          initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
          clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
          getRowId={(row) => row.id}
          editable
          getRowVersion={(row) => row.revision}
          onSaveEdits={onSaveEdits}
        />
      </div>
      <div
        aria-label="Outside grid release target"
        role="region"
        style={{ height: 80, width: 40 }}
      />
    </div>
  );
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe("BrunoTable Drag Fill acceptance", () => {
  test("keeps Drag Fill interactive through Strict Mode effect rehearsal and cleans up", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_STRICT_MODE";
    const screen = await render(<StrictMode>{clientTable(tableId, onSaveEdits)}</StrictMode>);
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());

    const target = cell(grid, "delta");
    const handle = dragHandle(grid.element());
    handle.dispatchEvent(pointer("pointerdown", 223, centerOf(handle)));
    target.dispatchEvent(pointer("pointermove", 223, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    expect(
      grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
    ).toBeGreaterThan(0);
    await userEvent.keyboard("{F2}");
    await expect
      .element(screen.getByRole("textbox", { name: "Edit Second" }))
      .not.toBeInTheDocument();

    target.dispatchEvent(pointer("pointerup", 223, centerOf(target)));
    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);

    await settleBrunoTableBrowserFrames();
    const secondHandle = dragHandle(grid.element());
    secondHandle.dispatchEvent(pointer("pointerdown", 224, centerOf(secondHandle)));
    target.dispatchEvent(pointer("pointermove", 224, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    expect(
      grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
    ).toBeGreaterThan(0);

    await screen.unmount();
    window.dispatchEvent(pointer("pointermove", 224, centerOf(target)));
    window.dispatchEvent(pointer("pointerup", 224, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    expect(onSaveEdits).toHaveBeenCalledOnce();
  });

  test("keeps Drag Fill unavailable while Cell Range owns a pointer", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_RANGE_POINTER_OWNER";
    await render(clientTable(tableId, onSaveEdits));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());

    const rangeOrigin = cell(grid, "alpha");
    rangeOrigin.dispatchEvent(pointer("pointerdown", 213, centerOf(rangeOrigin)));
    await settleBrunoTableBrowserFrames();

    const blockedHandle = dragHandle(grid.element());
    const target = cell(grid, "delta");
    blockedHandle.dispatchEvent(pointer("pointerdown", 214, centerOf(blockedHandle)));
    target.dispatchEvent(pointer("pointermove", 214, centerOf(target)));
    await settleBrunoTableBrowserFrames();

    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    window.dispatchEvent(pointer("pointercancel", 214, centerOf(target)));
    window.dispatchEvent(pointer("pointercancel", 213, centerOf(rangeOrigin)));
    await settleBrunoTableBrowserFrames();

    await dragTo(grid.element(), target, 215);
    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
  });

  test("keeps Cell Range unavailable while Drag Fill owns a pointer", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_POINTER_OWNER";
    await render(clientTable(tableId, onSaveEdits));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());

    const handle = dragHandle(grid.element());
    const target = cell(grid, "delta");
    handle.dispatchEvent(pointer("pointerdown", 216, centerOf(handle)));
    target.dispatchEvent(pointer("pointermove", 216, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    expect(
      grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
    ).toBeGreaterThan(0);

    const competingRangeOrigin = cell(grid, "gamma");
    competingRangeOrigin.dispatchEvent(pointer("pointerdown", 217, centerOf(competingRangeOrigin)));
    await settleBrunoTableBrowserFrames();

    expect(
      grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
    ).toBeGreaterThan(0);
    window.dispatchEvent(pointer("pointercancel", 217, centerOf(competingRangeOrigin)));
    target.dispatchEvent(pointer("pointerup", 216, centerOf(target)));
    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
  });

  test("keeps Drag Fill unavailable while Paste owns an asynchronous read or confirmation", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_PASTE_OWNER";
    const screen = await render(clientTable(tableId, onSaveEdits));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());
    let resolveClipboard!: (text: string) => void;
    const clipboardText = new Promise<string>((resolve) => {
      resolveClipboard = resolve;
    });
    const clipboard = installClipboard(() => clipboardText);
    try {
      await userEvent.keyboard(pasteGesture());
      await vi.waitFor(() => expect(clipboard.readText).toHaveBeenCalledOnce());

      const pendingHandle = dragHandle(grid.element());
      const target = cell(grid, "delta");
      pendingHandle.dispatchEvent(pointer("pointerdown", 225, centerOf(pendingHandle)));
      target.dispatchEvent(pointer("pointermove", 225, centerOf(target)));
      await settleBrunoTableBrowserFrames();
      expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
      window.dispatchEvent(pointer("pointercancel", 225, centerOf(target)));

      resolveClipboard("left\nright");
      await expect.element(screen.getByRole("alertdialog")).toBeVisible();
      const confirmingHandle = dragHandle(grid.element());
      confirmingHandle.dispatchEvent(pointer("pointerdown", 226, centerOf(confirmingHandle)));
      target.dispatchEvent(pointer("pointermove", 226, centerOf(target)));
      await settleBrunoTableBrowserFrames();
      expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
      window.dispatchEvent(pointer("pointercancel", 226, centerOf(target)));
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    } finally {
      clipboard.restore();
    }
    expect(onSaveEdits).not.toHaveBeenCalled();
  });

  test("consumes Paste and Batch history commands while Drag Fill owns the pointer", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_EDIT_COMMAND_OWNER";
    const screen = await render(clientTable(tableId, onSaveEdits));
    await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard("{F2}");
    const editor = screen.getByRole("textbox", { name: "Edit First" });
    await userEvent.clear(editor);
    await userEvent.type(editor, "seed{Enter}");
    await expect.element(grid.getByRole("gridcell", { name: "seed", exact: true })).toBeVisible();
    grid.element().focus();
    await userEvent.keyboard("{Home}");
    await selectTwoCellSource(grid.element());

    const clipboard = installClipboard(async () => "replacement");
    try {
      const target = cell(grid, "delta");
      const handle = dragHandle(grid.element());
      handle.dispatchEvent(pointer("pointerdown", 228, centerOf(handle)));
      target.dispatchEvent(pointer("pointermove", 228, centerOf(target)));
      await settleBrunoTableBrowserFrames();
      expect(
        grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
      ).toBeGreaterThan(0);

      await userEvent.keyboard(`${pasteGesture()}${undoGesture()}`);
      await settleBrunoTableBrowserFrames();
      expect(clipboard.readText).not.toHaveBeenCalled();
      await expect.element(grid.getByRole("gridcell", { name: "seed", exact: true })).toBeVisible();
      expect(
        grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
      ).toBeGreaterThan(0);
      await userEvent.keyboard("{Escape}");
      await userEvent.keyboard(undoGesture());
      await expect
        .element(grid.getByRole("gridcell", { name: "alpha", exact: true }))
        .toBeVisible();

      grid.element().focus();
      await userEvent.keyboard("{Home}");
      await selectTwoCellSource(grid.element());
      const redoHandle = dragHandle(grid.element());
      redoHandle.dispatchEvent(pointer("pointerdown", 233, centerOf(redoHandle)));
      target.dispatchEvent(pointer("pointermove", 233, centerOf(target)));
      await settleBrunoTableBrowserFrames();
      await userEvent.keyboard(redoGesture());
      await expect
        .element(grid.getByRole("gridcell", { name: "alpha", exact: true }))
        .toBeVisible();
      expect(
        grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
      ).toBeGreaterThan(0);
      await userEvent.keyboard("{Escape}");
    } finally {
      clipboard.restore();
    }
    expect(onSaveEdits).not.toHaveBeenCalled();
  });

  test("keeps column resize and Drag Fill mutually exclusive in both admission orders", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_COLUMN_GESTURE_OWNER";
    const screen = await render(clientTable(tableId, onSaveEdits));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());
    const resize = screen.getByRole("separator", { name: "Resize First" }).element();
    const handleBeforeResize = dragHandle(grid.element());
    const target = cell(grid, "delta");
    const initialWidth = resize.getAttribute("aria-valuenow");

    resize.dispatchEvent(pointer("pointerdown", 229, centerOf(resize)));
    handleBeforeResize.dispatchEvent(pointer("pointerdown", 230, centerOf(handleBeforeResize)));
    target.dispatchEvent(pointer("pointermove", 230, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    window.dispatchEvent(pointer("pointercancel", 230, centerOf(target)));
    window.dispatchEvent(pointer("pointercancel", 229, centerOf(resize)));
    await settleBrunoTableBrowserFrames();

    await selectTwoCellSource(grid.element());
    const handle = dragHandle(grid.element());
    handle.dispatchEvent(pointer("pointerdown", 231, centerOf(handle)));
    target.dispatchEvent(pointer("pointermove", 231, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    expect(
      grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
    ).toBeGreaterThan(0);
    resize.dispatchEvent(pointer("pointerdown", 232, centerOf(resize)));
    window.dispatchEvent(
      pointer("pointermove", 232, { x: centerOf(resize).x + 40, y: centerOf(resize).y }),
    );
    window.dispatchEvent(pointer("pointerup", 232, centerOf(resize)));
    await settleBrunoTableBrowserFrames();
    expect(resize.getAttribute("aria-valuenow")).toBe(initialWidth);
    target.dispatchEvent(pointer("pointerup", 231, centerOf(target)));
    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
  });

  test("suppresses grid navigation while Drag Fill owns the pointer", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_NAVIGATION_OWNER";
    await render(clientTable(tableId, onSaveEdits));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());

    const handle = dragHandle(grid.element());
    const target = cell(grid, "delta");
    handle.dispatchEvent(pointer("pointerdown", 218, centerOf(handle)));
    target.dispatchEvent(pointer("pointermove", 218, centerOf(target)));
    await settleBrunoTableBrowserFrames();

    for (const gesture of ["{ArrowRight}", "{PageDown}", "{Tab}"]) {
      await userEvent.keyboard(gesture);
      await settleBrunoTableBrowserFrames();
      expect(
        grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
      ).toBeGreaterThan(0);
    }

    target.dispatchEvent(pointer("pointerup", 218, centerOf(target)));
    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
  });

  test("suppresses F2 edit activation while Drag Fill owns the pointer", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_F2_OWNER";
    const screen = await render(clientTable(tableId, onSaveEdits));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());

    const handle = dragHandle(grid.element());
    const target = cell(grid, "delta");
    handle.dispatchEvent(pointer("pointerdown", 219, centerOf(handle)));
    target.dispatchEvent(pointer("pointermove", 219, centerOf(target)));
    await settleBrunoTableBrowserFrames();

    await userEvent.keyboard("{F2}");
    await settleBrunoTableBrowserFrames();

    await expect.element(screen.getByRole("textbox", { name: /^Edit / })).not.toBeInTheDocument();
    expect(
      grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
    ).toBeGreaterThan(0);
    target.dispatchEvent(pointer("pointerup", 219, centerOf(target)));
    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
  });

  test("withdraws Drag Fill while a cell editor owns the interaction", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_EDITOR_OWNER";
    const screen = await render(clientTable(tableId, onSaveEdits));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());
    const staleHandle = dragHandle(grid.element());

    await userEvent.keyboard("{F2}");
    await expect.element(screen.getByRole("textbox", { name: "Edit Second" })).toBeVisible();
    await settleBrunoTableBrowserFrames();
    expect(grid.element().querySelector("[data-bruno-drag-fill-handle]")).toBeNull();

    const target = cell(grid, "delta");
    staleHandle.dispatchEvent(pointer("pointerdown", 234, centerOf(staleHandle)));
    target.dispatchEvent(pointer("pointermove", 234, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);

    await userEvent.keyboard("{Escape}");
    await settleBrunoTableBrowserFrames();
    expect(grid.element().querySelector("[data-bruno-drag-fill-handle]")).not.toBeNull();
    expect(onSaveEdits).not.toHaveBeenCalled();
  });

  test("suppresses produced-text edit activation while Drag Fill owns the pointer", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_PRODUCED_TEXT_OWNER";
    const screen = await render(clientTable(tableId, onSaveEdits));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());

    const handle = dragHandle(grid.element());
    const target = cell(grid, "delta");
    handle.dispatchEvent(pointer("pointerdown", 220, centerOf(handle)));
    target.dispatchEvent(pointer("pointermove", 220, centerOf(target)));
    await settleBrunoTableBrowserFrames();

    await userEvent.keyboard("x");
    await settleBrunoTableBrowserFrames();

    await expect.element(screen.getByRole("textbox", { name: /^Edit / })).not.toBeInTheDocument();
    expect(
      grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
    ).toBeGreaterThan(0);
    target.dispatchEvent(pointer("pointerup", 220, centerOf(target)));
    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
  });

  test("keeps range source identity compact until an admitted handle press", async () => {
    const tableId = "TABLE_ID_DRAG_FILL_COMPACT_SOURCE";
    let materializations = 0;
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => {
        if (event.kind === "identity-span-materialization") materializations += 1;
      },
    );
    try {
      await render(clientTable(tableId, () => Promise.resolve()));
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      await userEvent.click(cell(grid, "alpha"));
      await selectTwoCellSource(grid.element());

      expect(materializations).toBe(0);
      const handle = dragHandle(grid.element());
      handle.dispatchEvent(pointer("pointerdown", 80, centerOf(handle)));
      expect(materializations).toBe(1);
      window.dispatchEvent(pointer("pointercancel", 80, centerOf(handle)));
    } finally {
      removeInstrumentation();
    }
  });

  test("keeps the last valid preview through pointer capture when the user releases outside the grid", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_OUTSIDE_RELEASE";
    await render(clientTableWithOutsideReleaseTarget(tableId, onSaveEdits));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });

    await selectTwoCellSource(grid.element());
    const handle = dragHandle(grid.element());
    await userEvent.dragAndDrop(
      handle,
      page.getByRole("region", { name: "Outside grid release target", exact: true }),
      { steps: 24 },
    );
    await settleBrunoTableBrowserFrames();

    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
    const changeSet = observedSaveChangeSet(onSaveEdits);
    expect(changeSet[0].changes).toEqual(
      expect.arrayContaining([
        { columnId: "COL_ID_THIRD", field: "third", before: "gamma", after: "alpha" },
      ]),
    );
    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    expect(dragHandle(grid.element())).toBeInstanceOf(HTMLElement);
  });

  test("sends one Immediate save change set for one public Drag Fill gesture", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_IMMEDIATE";
    await render(clientTable(tableId, onSaveEdits));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });

    await selectTwoCellSource(grid.element());
    await dragTo(grid.element(), cell(grid, "delta"), 201);

    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
    const changeSet = observedSaveChangeSet(onSaveEdits);
    expect(changeSet[0]).toMatchObject({ rowId: "row-1", expectedVersion: 1n });
    expect(changeSet[0].changes).toEqual(
      expect.arrayContaining([
        { columnId: "COL_ID_THIRD", field: "third", before: "gamma", after: "alpha" },
        { columnId: "COL_ID_FOURTH", field: "fourth", before: "delta", after: "beta" },
      ]),
    );
  });

  test("lets a single Active Cell acquire the vertical fill axis", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_ACTIVE_VERTICAL";
    const secondRow: FillRow = {
      id: "row-2",
      first: "epsilon",
      second: "zeta",
      third: "eta",
      fourth: "theta",
      revision: 2n,
    };
    await render(clientTable(tableId, onSaveEdits, [rows[0]!, secondRow]));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
    const source = grid
      .element()
      .querySelector<HTMLElement>(
        '[data-bruno-row-id="row-1"][data-bruno-column-id="COL_ID_FIRST"]',
      )!;
    const destination = grid
      .element()
      .querySelector<HTMLElement>(
        '[data-bruno-row-id="row-2"][data-bruno-column-id="COL_ID_FIRST"]',
      )!;
    await userEvent.click(source);
    await settleBrunoTableBrowserFrames();

    const handle = dragHandle(grid.element());
    const start = centerOf(handle);
    const destinationCenter = centerOf(destination);
    const verticalPoint = Object.freeze({ x: start.x, y: destinationCenter.y });
    handle.dispatchEvent(pointer("pointerdown", 202, start));
    destination.dispatchEvent(pointer("pointermove", 202, verticalPoint));
    await settleBrunoTableBrowserFrames();
    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).not.toHaveLength(0);
    destination.dispatchEvent(pointer("pointerup", 202, verticalPoint));

    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
    const changeSet = observedSaveChangeSet(onSaveEdits);
    expect(changeSet[0]).toMatchObject({ rowId: "row-2", expectedVersion: 2n });
    expect(changeSet[0].changes).toEqual([
      { columnId: "COL_ID_FIRST", field: "first", before: "epsilon", after: "alpha" },
    ]);
  });

  test("uses a visible Immediate Accepted Overlay as the next Drag Fill source", async () => {
    let resolveFirstSave!: () => void;
    const onSaveEdits = vi.fn(() =>
      onSaveEdits.mock.calls.length === 1
        ? new Promise<void>((resolve) => {
            resolveFirstSave = resolve;
          })
        : Promise.resolve(),
    );
    const tableId = "TABLE_ID_DRAG_FILL_ACCEPTED_OVERLAY";
    const screen = await render(clientTable(tableId, onSaveEdits));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit First" }), "overlay");
    await userEvent.keyboard("{Enter}");
    resolveFirstSave();
    await expect
      .element(screen.getByRole("region", { name: "Edit safety" }))
      .toHaveTextContent("1 Immediate save accepted · waiting for live confirmation");
    await expect.element(cell(grid, "overlay")).toBeVisible();

    const invalidOverlayRows = [
      { ...rows[0]!, first: Number.NaN },
    ] as unknown as readonly FillRow[];
    await screen.rerender(clientTable(tableId, onSaveEdits, invalidOverlayRows, 2));
    await expect.element(cell(grid, "overlay")).toBeVisible();

    await dragTo(grid.element(), cell(grid, "beta"), 211);

    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledTimes(2));
    const secondCall = onSaveEdits.mock.calls[1] as readonly [ObservedSaveChangeSet] | undefined;
    expect(secondCall?.[0][0]?.changes).toEqual([
      {
        columnId: "COL_ID_SECOND",
        field: "second",
        before: "beta",
        after: "overlay",
      },
    ]);
  });

  test("completes a fully unchanged Drag Fill silently", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_UNCHANGED";
    const unchangedRows = [{ ...rows[0]!, second: rows[0]!.first }] as const;
    const screen = await render(clientTable(tableId, onSaveEdits, unchangedRows));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
    const destination = grid
      .element()
      .querySelector<HTMLElement>(
        '[data-bruno-row-id="row-1"][data-bruno-column-id="COL_ID_SECOND"]',
      );
    if (destination === null) throw new Error("Expected the unchanged fill destination.");

    await dragTo(grid.element(), destination, 212);
    await settleBrunoTableBrowserFrames();

    expect(onSaveEdits).not.toHaveBeenCalled();
    await expect
      .element(screen.getByRole("region", { name: "Notifications", exact: true }))
      .toHaveTextContent(/^$/);
  });

  test("completes a production Drag Fill onto a pinned destination cell", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_PINNED_DESTINATION";
    await render(
      <div style={{ width: 320 }}>
        <BrunoTableClient
          tableId={tableId}
          columns={pinnedEditableColumns}
          initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
          clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
          getRowId={(row) => row.id}
          editable
          getRowVersion={(row) => row.revision}
          onSaveEdits={onSaveEdits}
        />
      </div>,
    );
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });

    await selectTwoCellSource(grid.element());
    const pinnedDestination = cell(grid, "delta");
    expect(pinnedDestination.closest('[data-bruno-pinned-body-region="end"]')).not.toBeNull();
    await userEvent.dragAndDrop(dragHandle(grid.element()), pinnedDestination, { steps: 16 });
    await settleBrunoTableBrowserFrames();

    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
    const changeSet = observedSaveChangeSet(onSaveEdits);
    expect(changeSet[0].changes).toEqual(
      expect.arrayContaining([
        { columnId: "COL_ID_THIRD", field: "third", before: "gamma", after: "alpha" },
        { columnId: "COL_ID_FOURTH", field: "fourth", before: "delta", after: "beta" },
      ]),
    );
  });

  test("records one Batch history command which Undo reverts atomically", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_BATCH_UNDO";
    await render(clientTable(tableId, onSaveEdits));
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });

    await selectTwoCellSource(grid.element());
    await dragTo(grid.element(), cell(grid, "delta"), 202);
    await vi.waitFor(() => {
      expect(grid.getByRole("gridcell", { name: "alpha", exact: true }).all()).toHaveLength(2);
      expect(grid.getByRole("gridcell", { name: "beta", exact: true }).all()).toHaveLength(2);
    });
    expect(onSaveEdits).not.toHaveBeenCalled();

    await userEvent.keyboard(undoGesture());
    await expect.element(grid.getByRole("gridcell", { name: "gamma", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "delta", exact: true })).toBeVisible();
    expect(onSaveEdits).not.toHaveBeenCalled();
  });

  test("preserves cyclic source phase when a two-cell source fills in reverse", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_REVERSE_PHASE";
    await render(clientTable(tableId, onSaveEdits));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await settleBrunoTableBrowserFrames();

    await dragTo(grid.element(), cell(grid, "alpha"), 203);

    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
    const changeSet = observedSaveChangeSet(onSaveEdits);
    expect(changeSet[0].changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ columnId: "COL_ID_FIRST", after: "gamma" }),
        expect.objectContaining({ columnId: "COL_ID_SECOND", after: "delta" }),
      ]),
    );
  });

  test("Escape before release and pointer cancellation leave no draft or save mutation", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_CANCEL";
    await render(clientTable(tableId, onSaveEdits));
    await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());
    const target = cell(grid, "delta");
    let handle = dragHandle(grid.element());
    handle.dispatchEvent(pointer("pointerdown", 204, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 204, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    await userEvent.keyboard("{Escape}");

    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    expect(onSaveEdits).not.toHaveBeenCalled();
    await expect.element(grid.getByRole("gridcell", { name: "gamma", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "delta", exact: true })).toBeVisible();

    handle = dragHandle(grid.element());
    handle.dispatchEvent(pointer("pointerdown", 205, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 205, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    window.dispatchEvent(pointer("pointercancel", 205, centerOf(target)));

    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    expect(onSaveEdits).not.toHaveBeenCalled();
    await expect.element(grid.getByRole("gridcell", { name: "gamma", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "delta", exact: true })).toBeVisible();
  });

  test("cancels an armed Drag Fill before Reset Review takes modal ownership", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_RESET_REVIEW";
    const screen = await render(clientTable(tableId, onSaveEdits));
    await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit First" }), "local");
    await userEvent.keyboard("{Enter}");
    await selectTwoCellSource(grid.element());

    const target = cell(grid, "delta");
    const handle = dragHandle(grid.element());
    handle.dispatchEvent(pointer("pointerdown", 221, centerOf(handle)));
    target.dispatchEvent(pointer("pointermove", 221, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    expect(
      grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
    ).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
    await expect.element(screen.getByRole("alertdialog", { name: "Reset Review" })).toBeVisible();
    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    expect(grid.element().querySelector("[data-bruno-drag-fill-handle]")).toBeNull();

    await userEvent.keyboard("{Escape}");
    await expect
      .element(screen.getByRole("alertdialog", { name: "Reset Review" }))
      .not.toBeInTheDocument();
    target.dispatchEvent(pointer("pointerup", 221, centerOf(target)));
    await settleBrunoTableBrowserFrames();

    expect(onSaveEdits).not.toHaveBeenCalled();
    await expect.element(grid.getByRole("gridcell", { name: "gamma", exact: true })).toBeVisible();
    await expect.element(grid.getByRole("gridcell", { name: "delta", exact: true })).toBeVisible();
    expect(dragHandle(grid.element())).toBeVisible();
  });

  test("cancels an armed Drag Fill before Blocked Changes Review takes modal ownership", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_BLOCKED_REVIEW";
    const screen = await render(clientTable(tableId, onSaveEdits));
    await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit First" }), "local");
    await userEvent.keyboard("{Enter}");
    const lockedRows = [{ ...rows[0]!, fourth: "locked", revision: 2n }] as const;
    await screen.rerender(
      clientTable(tableId, onSaveEdits, lockedRows, 2, permissionEditableColumns),
    );
    await selectTwoCellSource(grid.element());

    const target = cell(grid, "gamma");
    const handle = dragHandle(grid.element());
    handle.dispatchEvent(pointer("pointerdown", 222, centerOf(handle)));
    target.dispatchEvent(pointer("pointermove", 222, centerOf(target)));
    await settleBrunoTableBrowserFrames();
    expect(
      grid.element().querySelectorAll("[data-bruno-drag-fill-preview]").length,
    ).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "1 blocked change" }));
    await expect
      .element(screen.getByRole("alertdialog", { name: "Blocked Changes Review" }))
      .toBeVisible();
    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    expect(grid.element().querySelector("[data-bruno-drag-fill-handle]")).toBeNull();

    await userEvent.keyboard("{Escape}");
    await expect
      .element(screen.getByRole("alertdialog", { name: "Blocked Changes Review" }))
      .not.toBeInTheDocument();
    target.dispatchEvent(pointer("pointerup", 222, centerOf(target)));
    await settleBrunoTableBrowserFrames();

    expect(onSaveEdits).not.toHaveBeenCalled();
    await expect.element(grid.getByRole("gridcell", { name: "gamma", exact: true })).toBeVisible();
    expect(dragHandle(grid.element())).toBeVisible();
  });

  test("never exposes the fill handle for a read-only Client capability", async () => {
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_DRAG_FILL_READ_ONLY"
        columns={readOnlyColumns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
      />,
    );
    const grid = screen.getByRole("grid", {
      name: "Data for TABLE_ID_DRAG_FILL_READ_ONLY",
    });
    expect(grid.element().querySelector("[data-bruno-drag-fill-handle]")).toBeNull();
  });

  test("never exposes the fill handle for a grouped Client capability", async () => {
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_DRAG_FILL_GROUPED"
        columns={groupingColumns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
      />,
    );
    await userEvent.click(page.getByRole("combobox", { name: "Add Group" }));
    await userEvent.click(page.getByRole("option", { name: "First", exact: true }));
    await settleBrunoTableBrowserFrames();
    expect(
      page
        .getByRole("grid", { name: "Data for TABLE_ID_DRAG_FILL_GROUPED" })
        .element()
        .querySelector("[data-bruno-drag-fill-handle]"),
    ).toBeNull();
  });

  test("never exposes the fill handle for a Server capability", async () => {
    const viewport = {
      semanticKey: () => "drag-fill-server",
      replace: () => ({ setWindow: () => undefined, release: () => undefined }),
    } as unknown as DragFillViewportSource["viewport"];
    const serverSource = {
      viewport,
      useWholeResult: () => ({ rows: [], totalRows: 0, version: 1, status: "ready" as const }),
      completeRawSelect: ["id", "first", "second", "third", "fourth", "revision"],
      totalRows: 0,
      version: 1,
      status: "ready" as const,
    } as unknown as DragFillViewportSource;
    await render(
      <BrunoTableServer
        tableId="TABLE_ID_DRAG_FILL_SERVER"
        columns={readOnlyColumns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
        viewportSource={serverSource}
      />,
    );
    expect(
      page
        .getByRole("grid", { name: "Data for TABLE_ID_DRAG_FILL_SERVER" })
        .element()
        .querySelector("[data-bruno-drag-fill-handle]"),
    ).toBeNull();
  });

  test("withdraws Drag Fill while Conflict Review owns the edit workflow", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_CONFLICT_REVIEW";
    const screen = await render(clientTable(tableId, onSaveEdits));
    await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit First" }), "local");
    await userEvent.keyboard("{Enter}");

    await screen.rerender(
      clientTable(tableId, onSaveEdits, [{ ...rows[0]!, first: "remote", revision: 2n }], 2),
    );
    await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
    await expect
      .element(screen.getByRole("alertdialog", { name: "Conflict Review" }))
      .toBeVisible();
    expect(grid.element().querySelector("[data-bruno-drag-fill-handle]")).toBeNull();
  });

  test("keeps the public preview static and cancels on live structural invalidation", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_STRUCTURE";
    const screen = await render(clientTable(tableId, onSaveEdits));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());
    const target = cell(grid, "delta");
    const handle = dragHandle(grid.element());
    handle.dispatchEvent(pointer("pointerdown", 206, centerOf(handle)));
    target.dispatchEvent(pointer("pointermove", 206, centerOf(target)));
    await settleBrunoTableBrowserFrames();

    const previews = grid.element().querySelectorAll<HTMLElement>("[data-bruno-drag-fill-preview]");
    expect(previews.length).toBeGreaterThan(0);
    for (const preview of previews) {
      expect(preview.style.transition).toBe("");
      expect(preview.style.animation).toBe("");
    }

    await screen.rerender(clientTable(tableId, onSaveEdits, [{ ...rows[0]!, id: "row-replaced" }]));
    target.dispatchEvent(pointer("pointerup", 206, centerOf(target)));

    expect(onSaveEdits).not.toHaveBeenCalled();
    expect(grid.element().querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
  });

  test("retains an active Drag Fill across value-only publications with the same identity order", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_VALUE_PUBLICATION";
    const sourceRows = [
      rows[0]!,
      {
        id: "row-2",
        first: "omega",
        second: "sigma",
        third: "theta",
        fourth: "zeta",
        revision: 1n,
      },
    ] satisfies readonly FillRow[];
    const screen = await render(clientTable(tableId, onSaveEdits, sourceRows, 1));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    await selectTwoCellSource(grid.element());
    const target = cell(grid, "delta");
    const handle = dragHandle(grid.element());
    handle.dispatchEvent(pointer("pointerdown", 207, centerOf(handle)));
    target.dispatchEvent(pointer("pointermove", 207, centerOf(target)));
    await settleBrunoTableBrowserFrames();

    await screen.rerender(
      clientTable(
        tableId,
        onSaveEdits,
        [{ ...sourceRows[0]!, first: "aardvark", revision: 2n }, sourceRows[1]!],
        2,
      ),
    );
    await settleBrunoTableBrowserFrames();
    target.dispatchEvent(pointer("pointerup", 207, centerOf(target)));

    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
    expect(observedSaveChangeSet(onSaveEdits)[0].changes).toEqual(
      expect.arrayContaining([
        { columnId: "COL_ID_THIRD", field: "third", before: "gamma", after: "alpha" },
        { columnId: "COL_ID_FOURTH", field: "fourth", before: "delta", after: "beta" },
      ]),
    );
  });

  test("moves a single-cell fill source with Active Cell-only edit traversal", async () => {
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const tableId = "TABLE_ID_DRAG_FILL_ACTIVE_CELL_TRAVERSAL";
    const screen = await render(clientTable(tableId, onSaveEdits));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    expect(dragHandle(grid.element()).closest('[role="gridcell"]')).toBe(cell(grid, "alpha"));

    await userEvent.keyboard("{F2}{Tab}");
    await settleBrunoTableBrowserFrames();

    expect(dragHandle(grid.element()).closest('[role="gridcell"]')).toBe(cell(grid, "beta"));
  });
});
