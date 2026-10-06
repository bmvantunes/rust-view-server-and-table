import { useState } from "react";
import { Button } from "@bruno/shadcn/button";
import {
  BrunoTableClient,
  BrunoTableQuickFilter,
  BrunoTableResultRowCount,
  BrunoTableTextColumn,
  BrunoTableToolbar,
  type BrunoTableColumns,
} from "@bruno/table";

type Row = { readonly id: string; readonly name: string };
const columns = [
  BrunoTableTextColumn({ columnId: "COL_ID_NAME", field: "name", headerName: "Name" }),
] satisfies BrunoTableColumns<Row>;
const rows = [
  { id: "ada", name: "Ada" },
  { id: "grace", name: "Grace" },
];
const source = { rows, totalRows: 2, version: 1, status: "ready" as const };

export function PackedApplication() {
  const [count, setCount] = useState(0);
  return (
    <>
      <Button onClick={() => setCount(count + 1)}>Clicks: {count}</Button>
      <BrunoTableClient
        tableId="TABLE_ID_PACKED_HYDRATION"
        getRowId={(row) => row.id}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={source}
        quickFilterFields={["name"]}
      >
        <BrunoTableToolbar>
          <BrunoTableQuickFilter />
          <BrunoTableResultRowCount />
        </BrunoTableToolbar>
      </BrunoTableClient>
    </>
  );
}
