import { BrunoTableClient } from "@bruno/table";
import type { BrunoTableClientProps, BrunoTableColumns } from "@bruno/table";

type BrowserRow = Readonly<{ readonly id: string; readonly symbol: string }>;

const columns = [
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
  },
] as const satisfies BrunoTableColumns<BrowserRow>;

const props: BrunoTableClientProps<BrowserRow, typeof columns> = {
  tableId: "TABLE_ID_EMITTED_BROWSER_ROOT",
  columns,
  clientSource: { rows: [], totalRows: 0, version: 0, status: "ready" },
  getRowId: (row) => row.id,
  initialOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
  rowSelection: true,
};
BrunoTableClient(props);

// @ts-expect-error The emitted root browser consumer intentionally has no Node ambient types.
void process.version;
