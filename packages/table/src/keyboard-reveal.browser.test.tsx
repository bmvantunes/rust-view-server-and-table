import { afterEach, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient, type BrunoTableColumns } from "./index";

type Row = { id: string; sequence: number; start: string; end: string; filler: string };
const rows = Array.from({ length: 100 }, (_, sequence) => ({
  id: `row-${sequence}`,
  sequence,
  start: `Start ${sequence}`,
  end: `End ${sequence}`,
  filler: "Filler",
}));
const columns = [
  { columnId: "COL_ID_SEQUENCE", field: "sequence", headerName: "Sequence", valueType: "number" },
] as const satisfies BrunoTableColumns<Row>;
const pinnedColumns = [
  {
    columnId: "COL_ID_START",
    field: "start",
    headerName: "Start",
    valueType: "text",
    pinned: "start",
    width: 100,
  },
  { ...columns[0], width: 120 },
  { columnId: "COL_ID_WIDE", field: "filler", headerName: "Wide", valueType: "text", width: 800 },
  {
    columnId: "COL_ID_END",
    field: "end",
    headerName: "End",
    valueType: "text",
    pinned: "end",
    width: 100,
  },
] satisfies BrunoTableColumns<Row>;

afterEach(cleanup);

test("reveals pinned keyboard destinations in local coordinates under ancestor scaling", async () => {
  const screen = await render(
    <div style={{ width: 600, transform: "scale(0.8)", transformOrigin: "top left" }}>
      <BrunoTableClient
        tableId="TABLE_ID_SCALED_HEADER_REVEAL"
        columns={pinnedColumns}
        initialOrderBy={[{ columnId: "COL_ID_SEQUENCE", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      />
    </div>,
  );
  const grid = screen.getByRole("grid").element();
  const header = screen.getByRole("columnheader").first().element();
  await screen.getByRole("gridcell", { name: "0", exact: true }).click();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
  grid.scrollTop = 180;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await userEvent.keyboard("{ArrowUp}{ArrowLeft}");
  await vi.waitFor(() => {
    const destination = screen.getByRole("gridcell", { name: "Start 4", exact: true }).element();
    expect(grid.getAttribute("aria-activedescendant")).toBe(destination.id);
    expect(destination.getBoundingClientRect().top).toBeCloseTo(
      header.getBoundingClientRect().bottom,
      1,
    );
    expect(grid.scrollTop).toBe(144);
  });
});

test.each(
  [28, 36, 72].flatMap((headerHeight) => [false, true].map((pinned) => ({ headerHeight, pinned }))),
)(
  "reveals keyboard destinations around a $headerHeight px header (pinned: $pinned) with minimum scrolling",
  async ({ headerHeight, pinned }) => {
    const screen = await render(
      <div className="keyboard-reveal-fixture" style={{ width: 600 }}>
        <style>{`
        .keyboard-reveal-fixture [role="grid"] { height: ${headerHeight + 180}px !important; max-height: ${headerHeight + 180}px !important; }
        .keyboard-reveal-fixture thead tr,
        .keyboard-reveal-fixture thead th { height: var(--test-header-height, ${headerHeight}px) !important; max-height: var(--test-header-height, ${headerHeight}px) !important; padding-block: 0 !important; }
        .keyboard-reveal-fixture thead button { height: 20px !important; min-height: 0 !important; padding-block: 0 !important; }
      `}</style>
        <BrunoTableClient
          tableId="TABLE_ID_HEADER_REVEAL"
          columns={pinned ? pinnedColumns : columns}
          initialOrderBy={[{ columnId: "COL_ID_SEQUENCE", direction: "asc" }]}
          getRowId={(row) => row.id}
          clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        />
      </div>,
    );
    const grid = screen.getByRole("grid").element();
    const header = screen
      .getByRole("columnheader")
      .nth(pinned ? 1 : 0)
      .element();
    await vi.waitFor(() => expect(header.getBoundingClientRect().height).toBe(headerHeight));
    await screen.getByRole("gridcell", { name: "0", exact: true }).click();
    await userEvent.keyboard("{PageDown}");
    await vi.waitFor(() =>
      expect(grid.getAttribute("aria-activedescendant")).toBe(
        screen.getByRole("gridcell", { name: "5", exact: true }).element().id,
      ),
    );
    await userEvent.keyboard("{PageUp}");
    await vi.waitFor(() => {
      expect(grid.getAttribute("aria-activedescendant")).toBe(
        screen.getByRole("gridcell", { name: "0", exact: true }).element().id,
      );
      expect(grid.scrollTop).toBe(0);
    });
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    const destination = screen.getByRole("gridcell", { name: "5", exact: true });
    await vi.waitFor(() => {
      expect(grid.getAttribute("aria-activedescendant")).toBe(destination.element().id);
      expect(destination.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
        grid.getBoundingClientRect().top + grid.clientTop + grid.clientHeight,
      );
      expect(grid.scrollTop).toBe(36);
    });
    await userEvent.keyboard("{ArrowUp}");
    await vi.waitFor(() =>
      expect(grid.getAttribute("aria-activedescendant")).toBe(
        screen.getByRole("gridcell", { name: "4", exact: true }).element().id,
      ),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(grid.scrollTop).toBe(36);
    await userEvent.keyboard("{ArrowDown}");
    grid.scrollTop = 180;
    await vi.waitFor(() =>
      expect(destination.element().getBoundingClientRect().top).toBe(
        header.getBoundingClientRect().bottom,
      ),
    );
    await userEvent.keyboard("{ArrowUp}");
    await vi.waitFor(() => {
      const previous = screen.getByRole("gridcell", { name: "4", exact: true }).element();
      expect(grid.getAttribute("aria-activedescendant")).toBe(previous.id);
      expect(previous.getBoundingClientRect().top).toBe(header.getBoundingClientRect().bottom);
      expect(grid.scrollTop).toBe(144);
      expect(grid.scrollLeft).toBe(0);
      if (pinned) {
        expect(previous.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          screen.getByRole("columnheader").first().element().getBoundingClientRect().right,
        );
        expect(previous.getBoundingClientRect().right).toBeLessThanOrEqual(
          screen.getByRole("columnheader").last().element().getBoundingClientRect().left,
        );
      }
    });
    if (pinned) {
      await userEvent.keyboard("{ArrowLeft}");
      await vi.waitFor(() => {
        const pinnedDestination = screen
          .getByRole("gridcell", { name: "Start 4", exact: true })
          .element();
        expect(grid.getAttribute("aria-activedescendant")).toBe(pinnedDestination.id);
        expect(pinnedDestination.getBoundingClientRect().top).toBe(
          header.getBoundingClientRect().bottom,
        );
        expect(grid.scrollTop).toBe(144);
      });
      await userEvent.keyboard("{ArrowRight}");
    }
    // Styles can change after mount without changing the scroll owner's dimensions.
    // Canceling a concurrent width preview must not restore obsolete header geometry.
    const resizeHandle = screen.getByRole("separator", { name: "Resize Sequence" }).element();
    const originalWidth = resizeHandle.getAttribute("aria-valuenow");
    resizeHandle.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, pointerId: 81 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 240, pointerId: 81 }),
    );
    await vi.waitFor(() =>
      expect(resizeHandle.getAttribute("aria-valuenow")).not.toBe(originalWidth),
    );
    const resizedHeight = headerHeight === 72 ? 28 : 72;
    grid.style.setProperty("--test-header-height", `${resizedHeight}px`);
    await vi.waitFor(() => expect(header.getBoundingClientRect().height).toBe(resizedHeight));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(resizeHandle.getAttribute("aria-valuenow")).toBe(originalWidth));
    await screen.getByRole("gridcell", { name: "4", exact: true }).click();
    // Establish the same starting window after native scroll anchoring has settled.
    grid.scrollTop = 144;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    await vi.waitFor(() => {
      const resizedDestination = screen.getByRole("gridcell", { name: "9", exact: true }).element();
      expect(grid.getAttribute("aria-activedescendant")).toBe(resizedDestination.id);
      expect(resizedDestination.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        grid.getBoundingClientRect().top + grid.clientTop + grid.clientHeight,
      );
      expect(grid.scrollTop).toBe(headerHeight === 72 ? 144 : headerHeight === 28 ? 224 : 216);
    });
    if (pinned) {
      const centerTop = screen
        .getByRole("gridcell", { name: "9", exact: true })
        .element()
        .getBoundingClientRect().top;
      await userEvent.keyboard("{ArrowLeft}");
      await vi.waitFor(() => {
        const start = screen.getByRole("gridcell", { name: "Start 9", exact: true }).element();
        expect(grid.getAttribute("aria-activedescendant")).toBe(start.id);
        expect(start.getBoundingClientRect().top).toBe(centerTop);
      });
      await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
      await vi.waitFor(() => {
        const end = screen.getByRole("gridcell", { name: "End 9", exact: true }).element();
        expect(grid.getAttribute("aria-activedescendant")).toBe(end.id);
        expect(end.getBoundingClientRect().top).toBe(centerTop);
        expect(end.getBoundingClientRect().right).toBeLessThanOrEqual(
          grid.getBoundingClientRect().right,
        );
      });
    }
  },
);
