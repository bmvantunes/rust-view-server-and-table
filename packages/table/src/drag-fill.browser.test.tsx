import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient } from "./index";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import { installBrunoTableClientDragFillFrameListener } from "./internal/render-instrumentation";
import type { BrunoTableColumns, BrunoTableSaveEditsHandler } from "./public-types";

type Row = Readonly<{
  readonly id: string;
  readonly first: string;
  readonly second: string;
  readonly third: string;
  readonly fourth: string;
  readonly revision: bigint;
}>;

const columns = [
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
] as const satisfies BrunoTableColumns<Row>;

const rejectionColumns = [
  columns[0],
  {
    ...columns[1],
    validate: ({ value }: { readonly value: string }) =>
      value === "alpha" ? "Second cannot repeat alpha." : undefined,
  },
  columns[2],
  columns[3],
] satisfies BrunoTableColumns<Row>;

const rows = [
  {
    id: "row-1",
    first: "alpha",
    second: "beta",
    third: "third",
    fourth: "fourth",
    revision: 1n,
  },
] satisfies readonly Row[];

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

test.each(["pointerup", "pointercancel", "unmount"] as const)(
  "suspends editable content only during Drag Fill and restores it after %s",
  async (ending) => {
    const screen = await render(
      <BrunoTableClient
        tableId={`TABLE_ID_DRAG_FILL_EDITABLE_${ending.toUpperCase()}`}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={() => Promise.resolve()}
      />,
    );
    const grid = screen.getByRole("grid").element() as HTMLElement;
    grid.focus();
    await settleBrunoTableBrowserFrames();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
    expect(handle).not.toBeNull();
    expect(grid.getAttribute("contenteditable")).toBe("plaintext-only");

    handle!.dispatchEvent(pointer("pointerdown", 810, centerOf(handle!)));
    expect(grid.getAttribute("contenteditable")).toBe("false");

    if (ending === "unmount") {
      await screen.unmount();
    } else {
      grid.dispatchEvent(pointer(ending, 810, centerOf(handle!)));
    }
    expect(grid.getAttribute("contenteditable")).toBe("plaintext-only");
    expect(grid.isContentEditable).toBe(true);
  },
);

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("repeats an editable Client linear range through one Batch Drag Fill gesture", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  await render(
    <div style={{ width: 480 }}>
      <BrunoTableClient
        tableId="TABLE_ID_DRAG_FILL_PRODUCTION"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />
    </div>,
  );
  await userEvent.click(page.getByRole("switch", { name: "Batch editing" }));
  const grid = page.getByRole("grid", { name: "Data for TABLE_ID_DRAG_FILL_PRODUCTION" });
  grid.element().focus();
  await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
  await settleBrunoTableBrowserFrames();

  const handle = grid.element().querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
  expect(handle).not.toBeNull();
  const fourth = grid
    .getByRole("gridcell", { name: "fourth", exact: true })
    .element() as HTMLElement;
  handle!.dispatchEvent(pointer("pointerdown", 91, centerOf(handle!)));
  fourth.dispatchEvent(pointer("pointermove", 91, centerOf(fourth)));
  await settleBrunoTableBrowserFrames();
  fourth.dispatchEvent(pointer("pointerup", 91, centerOf(fourth)));

  await vi.waitFor(() => {
    expect(grid.getByRole("gridcell", { name: "alpha", exact: true }).all()).toHaveLength(2);
    expect(grid.getByRole("gridcell", { name: "beta", exact: true }).all()).toHaveLength(2);
  });
  expect(onSaveEdits).not.toHaveBeenCalled();
});

test.each([false, true])(
  "fills beneath a tall header, canceling if it resizes during the gesture (%s)",
  async (resizeDuringGesture) => {
    const sourceRows = Array.from({ length: 10 }, (_, index) => ({
      ...rows[0]!,
      id: `row-${index}`,
      first: String(index).padStart(3, "0"),
    }));
    const onSaveEdits = vi.fn<BrunoTableSaveEditsHandler<Row, typeof columns, bigint>>(() =>
      Promise.resolve(),
    );
    const screen = await render(
      <div className="tall-fill-header">
        <style>{`.tall-fill-header [role="grid"] { height: 300px !important; max-height: 300px !important; }
        .tall-fill-header thead tr, .tall-fill-header thead th { height: var(--test-fill-header-height, 72px) !important; }`}</style>
        <BrunoTableClient<Row, typeof columns, (row: Row) => bigint>
          tableId="TABLE_ID_TALL_FILL_HEADER"
          columns={columns}
          initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
          clientSource={{
            rows: sourceRows,
            totalRows: sourceRows.length,
            version: 1,
            status: "ready",
          }}
          getRowId={(row) => row.id}
          editable
          getRowVersion={(row) => row.revision}
          onSaveEdits={onSaveEdits}
        />
      </div>,
    );
    const grid = screen.getByRole("grid").element();
    await screen.getByRole("gridcell", { name: "000", exact: true }).click();
    await settleBrunoTableBrowserFrames();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
    expect(handle).not.toBeNull();
    const destination = centerOf(
      screen.getByRole("gridcell", { name: "001", exact: true }).element(),
    );
    handle!.dispatchEvent(pointer("pointerdown", 95, centerOf(handle!)));
    if (resizeDuringGesture) {
      grid.style.setProperty("--test-fill-header-height", "108px");
      await vi.waitFor(() =>
        expect(
          screen.getByRole("columnheader").first().element().getBoundingClientRect().height,
        ).toBe(108),
      );
      await settleBrunoTableBrowserFrames();
    }
    grid.dispatchEvent(pointer("pointerup", 95, destination));
    if (resizeDuringGesture) {
      await settleBrunoTableBrowserFrames();
      expect(onSaveEdits).not.toHaveBeenCalled();
      return;
    }
    await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledTimes(1));
    expect(onSaveEdits.mock.calls[0]![0].map((change) => change.rowId)).toEqual(["row-1"]);
  },
);

test("releases Drag Fill against native scroll before the next viewport publication", async () => {
  const sourceRows = Array.from({ length: 100 }, (_, index) => ({
    ...rows[0]!,
    id: `row-${index}`,
    first: String(index).padStart(3, "0"),
  }));
  const onSaveEdits = vi.fn<BrunoTableSaveEditsHandler<Row, typeof columns, bigint>>(() =>
    Promise.resolve(),
  );
  const screen = await render(
    <BrunoTableClient<Row, typeof columns, (row: Row) => bigint>
      tableId="TABLE_ID_DRAG_FILL_NATIVE_RELEASE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />,
  );
  const grid = screen.getByRole("grid").element() as HTMLElement;
  grid.focus();
  await settleBrunoTableBrowserFrames();
  const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
  expect(handle).not.toBeNull();
  const destination = centerOf(
    screen.getByRole("gridcell", { name: "001", exact: true }).element(),
  );
  handle!.dispatchEvent(pointer("pointerdown", 94, centerOf(handle!)));
  // No frame may publish between native movement and release at the captured grid.
  grid.scrollTop = 36;
  grid.dispatchEvent(pointer("pointerup", 94, destination));
  await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledTimes(1));
  expect(onSaveEdits.mock.calls[0]![0].map((change) => change.rowId).toSorted()).toEqual([
    "row-1",
    "row-2",
  ]);
});

test("queues the next Drag Fill frame before native edge scrolling schedules viewport publication", async () => {
  const tableId = "TABLE_ID_DRAG_FILL_FRAME_ORDER";
  const screen = await render(
    <div style={{ width: 240 }}>
      <BrunoTableClient
        tableId={tableId}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={() => Promise.resolve()}
      />
    </div>,
  );
  const grid = screen.getByRole("grid").element() as HTMLElement;
  grid.focus();
  await settleBrunoTableBrowserFrames();
  const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
  if (handle === null)
    throw new Error("Expected the selected source to expose a Drag Fill handle.");
  const rowId = handle.closest<HTMLElement>("[data-bruno-row-id]")?.dataset["brunoRowId"];
  if (rowId === undefined) throw new Error("Expected the handle to have an owning source row.");
  const sourceCell = grid.querySelector<HTMLElement>(
    `[role="gridcell"][data-bruno-row-id="${rowId}"]`,
  );
  if (sourceCell === null) throw new Error("Expected the Drag Fill source cell to be mounted.");

  const timeline: string[] = [];
  const dragFillFrameIds: number[] = [];
  const viewportFrameIds: number[] = [];
  const removeFrames = installBrunoTableClientDragFillFrameListener(tableId, (event) => {
    if (event.phase !== "scheduled") return;
    dragFillFrameIds.push(event.frameId);
    timeline.push(`drag-fill:${String(event.frameId)}`);
  });
  const requestFrame = window.requestAnimationFrame.bind(window);
  const requestFrameSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const frameId = requestFrame(callback);
      timeline.push(`raf:${String(frameId)}`);
      const schedulingStack = new Error().stack ?? "";
      if (
        schedulingStack.includes("virtual-viewport.ts") &&
        schedulingStack.includes("schedulePublish")
      ) {
        viewportFrameIds.push(frameId);
        timeline.push(`viewport:${String(frameId)}`);
      }
      return frameId;
    });

  try {
    const initialScrollLeft = grid.scrollLeft;
    const bounds = grid.getBoundingClientRect();
    const rowBounds = sourceCell.getBoundingClientRect();
    handle.dispatchEvent(pointer("pointerdown", 811, centerOf(handle)));
    grid.dispatchEvent(
      pointer("pointermove", 811, { x: bounds.right - 2, y: rowBounds.top + rowBounds.height / 2 }),
    );
    await vi.waitFor(() => expect(grid.scrollLeft).toBeGreaterThan(initialScrollLeft));
    await settleBrunoTableBrowserFrames(4);

    expect(dragFillFrameIds.length).toBeGreaterThanOrEqual(2);
    const continuation = `drag-fill:${String(dragFillFrameIds[1])}`;
    const continuationIndex = timeline.indexOf(continuation);
    const firstViewportFrameId = viewportFrameIds[0];
    const firstViewportRequestIndex =
      firstViewportFrameId === undefined
        ? -1
        : timeline.indexOf(`viewport:${String(firstViewportFrameId)}`);
    expect(continuationIndex).toBeGreaterThanOrEqual(0);
    expect(firstViewportRequestIndex).toBeGreaterThan(continuationIndex);
  } finally {
    grid.dispatchEvent(pointer("pointercancel", 811, centerOf(handle)));
    removeFrames();
    requestFrameSpy.mockRestore();
  }
});

test("releases horizontal Drag Fill at the native boundary with Row Selection", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const screen = await render(
    <div style={{ width: 240 }}>
      <BrunoTableClient
        tableId="TABLE_ID_DRAG_FILL_SELECTION_RELEASE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />
    </div>,
  );
  const grid = screen.getByRole("grid").element() as HTMLElement;
  grid.focus();
  await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
  await settleBrunoTableBrowserFrames();
  const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
  expect(handle).not.toBeNull();
  const y = centerOf(screen.getByRole("gridcell", { name: "alpha", exact: true }).element()).y;
  handle!.dispatchEvent(pointer("pointerdown", 194, centerOf(handle!)));
  grid.scrollLeft = grid.scrollWidth;
  grid.dispatchEvent(pointer("pointerup", 194, { x: grid.getBoundingClientRect().right - 50, y }));
  await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledTimes(1));
  await expect
    .element(screen.getByRole("gridcell", { name: "fourth", exact: true }))
    .not.toBeInTheDocument();
});

test.each([
  "release",
  "direction",
  "ancestor-direction",
  "ancestor-scroll",
  "resize",
  "element-resize",
] as const)("cancels Drag Fill when the grid moves before %s", async (cause) => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const screen = await render(
    <div style={{ width: 480 }}>
      <BrunoTableClient
        tableId="TABLE_ID_DRAG_FILL_MOVED_RELEASE"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />
    </div>,
  );
  const grid = screen.getByRole("grid").element() as HTMLElement;
  grid.focus();
  await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
  await settleBrunoTableBrowserFrames();
  const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
  expect(handle).not.toBeNull();
  const destination = screen.getByRole("gridcell", { name: "fourth", exact: true }).element();
  handle!.dispatchEvent(pointer("pointerdown", 95, centerOf(handle!)));
  destination.dispatchEvent(pointer("pointermove", 95, centerOf(destination)));
  await settleBrunoTableBrowserFrames();
  // Layout can change without a pointer frame or a resize notification being delivered.
  if (cause === "direction") grid.style.direction = "rtl";
  else if (cause === "ancestor-direction") grid.parentElement!.style.direction = "rtl";
  else grid.style.transform = "translateY(36px)";
  if (cause !== "release" && cause !== "direction" && cause !== "ancestor-direction") {
    if (cause === "ancestor-scroll") document.dispatchEvent(new Event("scroll"));
    else if (cause === "element-resize") grid.style.width = "300px";
    else window.dispatchEvent(new Event("resize"));
    await settleBrunoTableBrowserFrames();
    expect(grid.querySelector("[data-bruno-drag-fill-preview]")).toBeNull();
  }
  destination.dispatchEvent(pointer("pointerup", 95, centerOf(destination)));
  await settleBrunoTableBrowserFrames();
  expect(onSaveEdits).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("gridcell", { name: "fourth", exact: true })).toBeVisible();
});

test("keeps Drag Fill layout reads out of the hot pointer frame", async () => {
  await render(
    <div style={{ width: 320 }}>
      <BrunoTableClient
        tableId="TABLE_ID_DRAG_FILL_LAYOUT_READS"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={() => Promise.resolve()}
      />
    </div>,
  );
  const grid = page.getByRole("grid", { name: "Data for TABLE_ID_DRAG_FILL_LAYOUT_READS" });
  const gridElement = grid.element() as HTMLElement;
  gridElement.focus();
  await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
  await settleBrunoTableBrowserFrames();

  expect(grid.element()).toBe(gridElement);
  expect(document.activeElement).toBe(gridElement);
  const handle = gridElement.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
  expect(handle).not.toBeNull();
  const fourth = grid.getByRole("gridcell", { name: "fourth", exact: true }).element();
  const handleCenter = centerOf(handle!);
  const fourthCenter = centerOf(fourth);
  const gridBounds = gridElement.getBoundingClientRect();
  handle!.dispatchEvent(pointer("pointerdown", 92, handleCenter));

  const gridBoundsRead = vi.spyOn(gridElement, "getBoundingClientRect");
  const pointHitRead = vi.spyOn(document, "elementFromPoint");
  const selectorRead = vi.spyOn(gridElement, "querySelectorAll");
  const directionRead = vi.spyOn(window, "getComputedStyle");
  fourth.dispatchEvent(
    pointer("pointermove", 92, {
      x: gridBounds.right - 2,
      y: fourthCenter.y,
    }),
  );
  await settleBrunoTableBrowserFrames();

  expect(gridBoundsRead).not.toHaveBeenCalled();
  expect(pointHitRead).not.toHaveBeenCalled();
  expect(
    selectorRead.mock.calls.some(([selector]) =>
      String(selector).includes("COL_ID_BRUNO_TABLE_ROW_SELECTION"),
    ),
  ).toBe(false);
  expect(directionRead).not.toHaveBeenCalled();
});

test("retains a Drag Fill rejection across ready and loading body transitions", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const renderTable = (status: "loading" | "ready", version: number) => (
    <div style={{ width: 480 }}>
      <BrunoTableClient
        tableId="TABLE_ID_DRAG_FILL_PERSISTENT_REJECTION"
        columns={rejectionColumns}
        initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
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
    </div>
  );
  const screen = await render(renderTable("ready", 1));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_DRAG_FILL_PERSISTENT_REJECTION",
  });
  const source = grid.getByRole("gridcell", { name: "alpha", exact: true }).element();
  const destination = grid.getByRole("gridcell", { name: "beta", exact: true }).element();
  source.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settleBrunoTableBrowserFrames();
  const handle = grid.element().querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
  if (handle === null) throw new Error("Expected an active-cell Drag Fill handle.");
  handle.dispatchEvent(pointer("pointerdown", 93, centerOf(handle)));
  destination.dispatchEvent(pointer("pointermove", 93, centerOf(destination)));
  await settleBrunoTableBrowserFrames();
  destination.dispatchEvent(pointer("pointerup", 93, centerOf(destination)));
  const rejectionIsVisible = () =>
    screen
      .getByRole("region", { name: "Notifications", exact: true })
      .all()
      .some((region) => region.element().textContent?.includes("Second cannot repeat alpha."));
  await vi.waitFor(() => expect(rejectionIsVisible()).toBe(true));

  await screen.rerender(renderTable("loading", 2));
  await vi.waitFor(() => expect(rejectionIsVisible()).toBe(true));
  await expect
    .element(screen.getByRole("button", { name: "Close toast", exact: true }))
    .toBeVisible();
  await screen.rerender(renderTable("ready", 3));
  await vi.waitFor(() => expect(rejectionIsVisible()).toBe(true));
  expect(onSaveEdits).not.toHaveBeenCalled();
});
