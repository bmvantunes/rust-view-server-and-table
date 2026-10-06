import { afterEach, expect, test } from "vite-plus/test";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient } from "./index";
import type { BrunoTableColumns } from "./index";

type Row = { id: string; name: string; score: number };
const rows: Row[] = [
  { id: "ada", name: "Ada", score: 4 },
  { id: "grace", name: "Grace", score: 2 },
];
const columns = [
  { columnId: "COL_ID_NAME", field: "name", headerName: "Name", valueType: "text" },
  { columnId: "COL_ID_SCORE", field: "score", headerName: "Score", valueType: "number" },
] satisfies BrunoTableColumns<Row>;
const props = {
  tableId: "TABLE_ID_LIFECYCLE_RECOVERY",
  getRowId: (row: Row) => row.id,
  columns,
  initialOrderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }] as const,
};

afterEach(cleanup);

// Production React avoids its development prop-diff logger reading the deliberately
// throwing source getter outside the table's source-admission boundary.
test("removes a recovered lifecycle error without hiding a retained query rejection", async () => {
  const source = { rows, totalRows: rows.length, version: 1, status: "ready" as const };
  const screen = await render(<BrunoTableClient {...props} clientSource={source} />);
  await expect.element(screen.getByRole("gridcell", { name: "Ada" })).toBeInTheDocument();
  const rejectedSource = {
    ...source,
    rows: [{ ...rows[0]!, score: Number.NaN }, rows[1]!],
    status: "stale" as const,
  };
  await screen.rerender(<BrunoTableClient {...props} clientSource={rejectedSource} />);
  await expect.element(screen.getByRole("alert").first()).toHaveTextContent("Live data delayed");
  await screen.getByRole("button", { name: "Sort by Score" }).click();
  await expect.element(screen.getByRole("alert").first()).toHaveTextContent("COL_ID_SCORE");
  const acceptedCell = screen.getByRole("gridcell", { name: "Ada" }).element();

  const unreadableSource = { ...rejectedSource };
  Object.defineProperty(unreadableSource, "status", {
    get: () => {
      throw new Error("Unreadable status.");
    },
  });
  await screen.rerender(<BrunoTableClient {...props} clientSource={unreadableSource} />);
  await expect
    .element(screen.getByRole("alert").first())
    .toHaveTextContent("Unreadable Client Source lifecycle field: status.");
  expect(screen.getByRole("gridcell", { name: "Ada" }).element()).toBe(acceptedCell);

  await screen.rerender(<BrunoTableClient {...props} clientSource={{ ...rejectedSource }} />);
  await expect
    .element(screen.getByRole("alert").first())
    .not.toHaveTextContent("Unreadable Client Source");
  await expect.element(screen.getByRole("alert").first()).toHaveTextContent("COL_ID_SCORE");
  const recoveredCell = screen.getByRole("gridcell", { name: "Ada" }).element();
  const repeatedSource = { ...rejectedSource, message: "Still awaiting corrected values." };
  await screen.rerender(<BrunoTableClient {...props} clientSource={repeatedSource} />);
  await expect.element(screen.getByRole("alert").first()).toHaveTextContent(repeatedSource.message);
  await expect.element(screen.getByRole("alert").first()).toHaveTextContent("COL_ID_SCORE");
  expect(screen.getByRole("gridcell", { name: "Ada" }).element()).toBe(recoveredCell);
  await screen.getByRole("button", { name: "Sort by Score" }).click();
  await expect
    .element(screen.getByRole("alert").first())
    .not.toHaveTextContent("Unreadable Client Source");
  await expect.element(screen.getByRole("alert").first()).toHaveTextContent("COL_ID_SCORE");
});
