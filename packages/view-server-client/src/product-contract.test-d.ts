import { useLiveQuery, useLiveQueryViewport, useConnectionStatus, type ConnectionStatus, type LiveQueryStatus } from "./product-provider";

function selectedRawQueryContract() {
  const result = useLiveQuery("products", {
    select: ["id", "quantity", "amount"],
    where: [],
    orderBy: [{ field: "amount", direction: "asc" }],
  });
  const id: string | undefined = result.rows[0]?.id;
  const quantity: string | undefined = result.rows[0]?.quantity;
  const exactCoefficient: string | undefined = result.rows[0]?.amount.coefficient;
  void [id, quantity, exactCoefficient];
  // @ts-expect-error projection does not include category.
  result.rows[0]?.category;
  // @ts-expect-error the topic is statically bound to this product provider.
  useLiveQuery("missing", { select: ["id"], where: [], orderBy: [] });
  // @ts-expect-error invalid product columns are rejected.
  useLiveQuery("products", { select: ["notAField"], where: [], orderBy: [] });
  // @ts-expect-error quantity ordering is not part of the implemented query grammar.
  useLiveQuery("products", { select: ["id"], where: [], orderBy: [{ field: "quantity", direction: "asc" }] });
}

function sortCardinalityContract() {
  // @ts-expect-error bounded adapter admits zero or one amount sort, never two.
  useLiveQuery("products", { select: ["id"], where: [], orderBy: [{ field: "amount", direction: "asc" }, { field: "amount", direction: "desc" }] });
}
void sortCardinalityContract;

function sparseViewportContract() {
  const viewport = useLiveQueryViewport("products");
  const generation = viewport.viewport.replace({
    window: { firstRow: 10, lastRow: 19 },
    query: { select: ["id", "amount"], where: [], orderBy: [{ field: "amount", direction: "desc" }] },
    sink: {
      setRowCount: (count, keepRenderedRows) => {
        const rowCount: number = count;
        const keep: boolean | undefined = keepRenderedRows;
        void [rowCount, keep];
      },
      setRowData: (rows, keys) => {
        const row: string | undefined = rows[10]?.id;
        const key: string | undefined = keys[10];
        void [row, key];
        // @ts-expect-error selected viewport rows omit category.
        rows[10]?.category;
      },
    },
  });
  generation.setWindow({ firstRow: 20, lastRow: 29 });
  generation.release();
}

void selectedRawQueryContract;
void sparseViewportContract;

function statusContract() {
  const connection: ConnectionStatus = useConnectionStatus();
  const query = { select: ["id"] as const, where: [], orderBy: [] as const };
  const whole: LiveQueryStatus = useLiveQuery("products", query).status;
  const viewport: LiveQueryStatus = useLiveQueryViewport("products").status;
  const accessor: LiveQueryStatus = useLiveQueryViewport("products").useWholeResult(query).status;
  const values: LiveQueryStatus[] = ["loading", "ready", "stale", "closed", "error"];
  const connections: ConnectionStatus[] = ["connecting", "connected", "disconnected"];
  // @ts-expect-error transport readiness is not query readiness.
  const bad: LiveQueryStatus = connection;
  void [whole, viewport, accessor, values, connections, bad];
}
void statusContract;
