import { afterEach, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient, type BrunoTableColumns } from "./index";

type Row = { id: string; label: string; sequence: number };
const columns = [
  { columnId: "COL_ID_LABEL", field: "label", headerName: "Label", valueType: "text" },
  { columnId: "COL_ID_SEQUENCE", field: "sequence", headerName: "Sequence", valueType: "number" },
] as const satisfies BrunoTableColumns<Row>;
const rows = Array.from({ length: 60 }, (_, sequence) => ({
  id: `row-${sequence}`,
  label: `Row ${sequence}`,
  sequence,
}));

afterEach(cleanup);

test.each([false, true])(
  "keeps the exact header active for PageUp and held repeats (empty: %s)",
  async (empty) => {
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_HEADER_PAGE_BOUNDARY"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_SEQUENCE", direction: "asc" }]}
        initialFilters={
          empty ? [{ columnId: "COL_ID_LABEL", type: "equals", filter: "Missing" }] : []
        }
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      />,
    );
    const grid = screen.getByRole("grid").element();
    grid.style.height = "396px";
    grid.focus();
    if (!empty) await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{ArrowRight}");
    const header = screen.getByRole("columnheader", { name: "Sequence" }).element();
    await vi.waitFor(() => expect(grid.getAttribute("aria-activedescendant")).toBe(header.id));
    await userEvent.keyboard("{PageUp}");
    expect(grid.getAttribute("aria-activedescendant")).toBe(header.id);
    for (let index = 0; index < 5; index += 1) {
      grid.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "PageUp",
          repeat: index > 0,
        }),
      );
      expect(grid.getAttribute("aria-activedescendant")).toBe(header.id);
    }
    grid.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "PageUp" }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(grid.scrollTop).toBe(0);
    expect(document.activeElement).toBe(grid);
    await userEvent.keyboard("{PageDown}");
    if (empty) {
      expect(grid.getAttribute("aria-activedescendant")).toBe(header.id);
    } else {
      await vi.waitFor(() =>
        expect(grid.getAttribute("aria-activedescendant")).toBe(
          screen.getByRole("gridcell", { name: "9", exact: true }).element().id,
        ),
      );
      await userEvent.keyboard("{PageDown}");
      await vi.waitFor(() =>
        expect(grid.getAttribute("aria-activedescendant")).toBe(
          screen.getByRole("gridcell", { name: "19", exact: true }).element().id,
        ),
      );
      await userEvent.keyboard("{PageUp}");
      await vi.waitFor(() =>
        expect(grid.getAttribute("aria-activedescendant")).toBe(
          screen.getByRole("gridcell", { name: "9", exact: true }).element().id,
        ),
      );
    }
  },
);
