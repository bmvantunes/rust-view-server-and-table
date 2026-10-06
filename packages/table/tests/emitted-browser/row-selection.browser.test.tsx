import { afterEach, expect, test } from "vite-plus/test";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient } from "../../dist/index.mjs";
import type { BrunoTableColumns } from "../../dist/index.mjs";

type Row = Readonly<{ readonly id: string; readonly name: string }>;

const columns = [
  {
    columnId: "COL_ID_EMITTED_SELECTION_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Row>;
const rows = [
  { id: "a", name: "Ada" },
  { id: "b", name: "Babbage" },
] satisfies readonly Row[];

afterEach(async () => cleanup());

test("selects stable Client Row Identities through the emitted package", async () => {
  const screen = await render(
    <>
      <style>{`[role="checkbox"] { width: 16px; height: 16px; }`}</style>
      <BrunoTableClient
        tableId="TABLE_ID_EMITTED_ROW_SELECTION"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_EMITTED_SELECTION_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        rowSelection
      />
    </>,
  );
  await settleFrames();
  const first = screen.getByRole("checkbox", { name: "Select row 1", exact: true });
  await first.click();
  await expect.element(first).toBeChecked();
  await expect
    .element(screen.getByRole("checkbox", { name: "Select all rows" }))
    .toHaveAttribute("aria-checked", "mixed");
});

async function settleFrames(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
