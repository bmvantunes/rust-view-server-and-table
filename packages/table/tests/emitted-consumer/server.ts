import {
  BrunoTableBigIntColumn,
  BrunoTableServer,
  type BrunoTableColumns,
  type BrunoTableServerProps,
} from "@bruno/table/server";

type ExampleRow = Readonly<{ id: string; count: bigint }>;

const columns = [
  BrunoTableBigIntColumn({
    columnId: "COL_ID_COUNT",
    field: "count",
    headerName: "Count",
  }),
] satisfies BrunoTableColumns<ExampleRow>;

void BrunoTableServer;
void columns;
type ServerProps = BrunoTableServerProps<ExampleRow, typeof columns>;
void (undefined as ServerProps | undefined);
