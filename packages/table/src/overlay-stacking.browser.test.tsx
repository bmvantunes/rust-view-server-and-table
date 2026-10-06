import { afterEach, expect, test } from "vite-plus/test";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient, type BrunoTableColumns } from "./index";

type Row = { readonly id: string; readonly name: string };
const columns = [
  { columnId: "COL_ID_NAME", field: "name", headerName: "Name", valueType: "text", width: 240 },
] satisfies BrunoTableColumns<Row>;
const rows: readonly Row[] = [{ id: "ada", name: "Ada" }];

afterEach(cleanup);

test("table column menu and filter paint above their sticky page header", async () => {
  const screen = await render(
    <header
      className="bg-background"
      style={{ position: "sticky", top: 0, zIndex: 50, height: 480 }}
    >
      <h1>Directory</h1>
      <BrunoTableClient
        tableId="TABLE_ID_OVERLAY_STACKING"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        getRowId={(row) => row.id}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      />
    </header>,
  );
  const header = screen.getByRole("banner").element();
  await screen.getByRole("button", { name: "Column menu for Name" }).click();
  const menu = screen.getByRole("menu");
  await expect.element(menu).toBeVisible();
  await expect.poll(() => paintsAboveHeader(menu.element(), header)).toBe(true);

  await screen.getByRole("menuitem", { name: "Open filter for Name", exact: true }).click();
  const filter = screen.getByRole("dialog", { name: "Filter Name" });
  await expect.element(filter).toBeVisible();
  await expect.poll(() => paintsAboveHeader(filter.element(), header)).toBe(true);
});

function paintsAboveHeader(surface: Element, header: Element): boolean {
  const bounds = surface.getBoundingClientRect();
  const headerBounds = header.getBoundingClientRect();
  const left = Math.max(bounds.left, headerBounds.left);
  const right = Math.min(bounds.right, headerBounds.right);
  const top = Math.max(bounds.top, headerBounds.top);
  const bottom = Math.min(bounds.bottom, headerBounds.bottom);
  expect(right - left).toBeGreaterThan(0);
  expect(bottom - top).toBeGreaterThan(0);
  return surface.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
}
