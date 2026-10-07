import { StrictMode, useEffect, useState } from "react";
import { expect, test } from "vite-plus/test";
import { render } from "vitest-browser-react";
import * as BigDecimal from "effect/BigDecimal";
import { createTopicHooks } from "@bruno/view-server-client/react";
import { createTestViewServer } from "@bruno/view-server-client/testing";
import { catalog as allTopics } from "@bruno/view-server-client/generated/demo-catalog";
import { sources } from "@bruno/view-server-client/generated/source-metadata";
import { decimal, uint64 } from "@bruno/view-server-client/schema";
import { BrunoTableCreateRustHooks } from "@bruno/table/rust";

const catalog = { client_orders: allTopics.client_orders };
const sdk = createTopicHooks(catalog);
const table = BrunoTableCreateRustHooks(catalog);
type Order =
  | { readonly field: "customer" | "open"; readonly direction: "asc" | "desc" }
  | { readonly aggregate: "total" | "mean"; readonly direction: "asc" | "desc" };
type Scenario = {
  readonly order: readonly Order[];
  readonly offset: number;
  readonly reversedGroups?: boolean;
};
type Cell = {
  readonly rowId: string;
  readonly customer?: string;
  readonly open?: boolean;
  readonly total: string | bigint | BigDecimal.BigDecimal;
  readonly mean: string | BigDecimal.BigDecimal;
};
const paths = ["sdk-whole", "sdk-helper", "sdk-viewport", "table-whole", "table-viewport"] as const;
const exact = (value: Cell["total"]) =>
  BigDecimal.isBigDecimal(value) ? BigDecimal.format(value) : String(value);
function Rows({ name, rows }: { name: string; rows: readonly Cell[] }) {
  return (
    <output data-testid={name} data-ids={JSON.stringify(rows.map((row) => row.rowId))}>
      {rows
        .map((row) => `${row.customer}/${row.open}:${exact(row.total)}:${exact(row.mean)}`)
        .join("|")}
    </output>
  );
}

test("real Worker/WASM grouped sorting survives both SDK hooks and both table result paths", async () => {
  const fixture = await createTestViewServer({ catalog, sources });
  const publish = (id: string, customer: string, open: boolean, units: bigint, price: string) =>
    fixture.publish("client_orders", {
      key: { id },
      value: { orderId: id, customer, open, units: uint64(units), price: decimal(price) },
    }).delivered;
  function Harness({ scenario }: { scenario: Scenario }) {
    "use no memo"; // Same dynamic returned-hook boundary as the production Server facet adapter.
    const query = {
      groupBy: scenario.reversedGroups
        ? (["customer", "open"] as const)
        : (["open", "customer"] as const),
      aggregates: {
        total: { aggFunc: "sum", field: "units" },
        mean: { aggFunc: "avg", field: "price" },
      },
      where: [],
      orderBy: scenario.order,
    } as const;
    const sdkQuery = {
      groupBy: query.groupBy,
      aggregates: query.aggregates,
      orderBy: query.orderBy,
      semanticProfile: "effect-4.2.8",
    } as const;
    const whole = sdk.useLiveQuery("client_orders", sdkQuery);
    const sdkSource = sdk.useLiveQueryViewport("client_orders");
    const helper = sdkSource.useWholeResult(sdkQuery);
    const tableSource = table.useViewportSource(fixture.provider, "client_orders");
    const tableWhole = tableSource.useWholeResult(query);
    const [sdkRows, setSdkRows] = useState<readonly Cell[]>([]);
    const [tableRows, setTableRows] = useState<readonly Cell[]>([]);
    useEffect(() => {
      const request = sdkSource.viewport.replace({
        query: sdkQuery,
        window: { firstRow: scenario.offset, lastRow: scenario.offset + 1 },
        sink: {
          setRowCount() {},
          setRowData(rows) {
            setSdkRows(Object.values(rows));
          },
        },
      });
      return () => request.release();
    }, [sdkSource.viewport, scenario]);
    useEffect(() => {
      const request = tableSource.viewport.replace({
        query,
        window: { firstRow: scenario.offset, lastRow: scenario.offset + 1 },
        sink: {
          setRowCount() {},
          setRowData(rows) {
            setTableRows(Object.values(rows));
          },
        },
      });
      return () => request.release();
    }, [tableSource.viewport, scenario]);
    return (
      <>
        <Rows name="sdk-whole" rows={whole.rows} />
        <Rows name="sdk-helper" rows={helper.rows} />
        <Rows name="sdk-viewport" rows={sdkRows} />
        <Rows name="table-whole" rows={tableWhole.rows} />
        <Rows name="table-viewport" rows={tableRows} />
      </>
    );
  }
  const descending: Scenario = {
    order: [
      { aggregate: "total", direction: "desc" },
      { field: "customer", direction: "desc" },
    ],
    offset: 0,
  };
  const node = (scenario: Scenario) => (
    <StrictMode>
      <fixture.Provider>
        <Harness scenario={scenario} />
      </fixture.Provider>
    </StrictMode>
  );
  let screen: Awaited<ReturnType<typeof render>> | undefined;
  try {
    // Insertion order, group-key order and requested rank all disagree. A discarded sort cannot pass.
    await publish("bt", "B", true, 1n, "10.4");
    await publish("af1", "A", false, 2n, "0.1");
    await publish("at", "A", true, 9n, "2.3");
    await publish("bf", "B", false, 9n, "0.2");
    await publish("af2", "A", false, 3n, "0.2");
    screen = await render(node(descending));
    const check = async (expected: readonly string[], offset: number) => {
      for (const path of paths) {
        const rows = path.endsWith("viewport") ? expected.slice(offset, offset + 2) : expected;
        await expect
          .poll(() => screen!.getByTestId(path).element().textContent)
          .toBe(rows.join("|"));
      }
    };
    await check(["B/false:9:0.2", "A/true:9:2.3", "A/false:5:0.15", "B/true:1:10.4"], 0);
    const originalIds = screen.getByTestId("table-whole").element().getAttribute("data-ids");
    const unsorted = await fixture.provider.open("unsorted-control", {
      topic: "client_orders",
      schema: catalog.client_orders.fingerprint,
      semantic_profile: "effect-4.2.8",
      group_by: ["open", "customer"],
      aggregates: {
        total: { aggFunc: "sum", field: "units" },
        mean: { aggFunc: "avg", field: "price" },
      },
      order_by: [],
      offset: 0,
      limit: 4,
    });
    expect(JSON.parse(originalIds ?? "[]")).not.toEqual(unsorted.keys);
    await fixture.provider.apply({ command: "close", subscription: "unsorted-control" });
    const ascending: Scenario = {
      order: [
        { aggregate: "total", direction: "asc" },
        { field: "customer", direction: "asc" },
      ],
      offset: 1,
    };
    await screen.rerender(node(ascending));
    await check(["B/true:1:10.4", "A/false:5:0.15", "A/true:9:2.3", "B/false:9:0.2"], 1);
    const reversedIds = screen.getByTestId("table-whole").element().getAttribute("data-ids");
    expect(JSON.parse(reversedIds ?? "[]")).toEqual(JSON.parse(originalIds ?? "[]").reverse());
    const fields: Scenario = {
      order: [
        { field: "customer", direction: "desc" },
        { field: "open", direction: "asc" },
      ],
      offset: 1,
    };
    await screen.rerender(node(fields));
    await check(["B/false:9:0.2", "B/true:1:10.4", "A/false:5:0.15", "A/true:9:2.3"], 1);
    // Average sorting uses exact decimal values, not lexical ordering or aggregate alias names.
    const mean: Scenario = { order: [{ aggregate: "mean", direction: "desc" }], offset: 1 };
    await screen.rerender(node(mean));
    await check(["B/true:1:10.4", "A/true:9:2.3", "B/false:9:0.2", "A/false:5:0.15"], 1);
    await screen.rerender(node(descending));
    await check(["B/false:9:0.2", "A/true:9:2.3", "A/false:5:0.15", "B/true:1:10.4"], 0);
    await publish("bt", "B", true, 12n, "10.4");
    await check(["B/true:12:10.4", "B/false:9:0.2", "A/true:9:2.3", "A/false:5:0.15"], 0);
    await fixture.delete("client_orders", { id: "bt" }).delivered;
    await check(["B/false:9:0.2", "A/true:9:2.3", "A/false:5:0.15"], 0);
    const beforeRegroup = screen.getByTestId("table-whole").element().getAttribute("data-ids");
    await screen.rerender(node({ ...descending, reversedGroups: true }));
    await check(["B/false:9:0.2", "A/true:9:2.3", "A/false:5:0.15"], 0);
    await expect
      .poll(() => screen!.getByTestId("table-whole").element().getAttribute("data-ids"))
      .not.toBe(beforeRegroup);
  } finally {
    try {
      await screen?.unmount();
      await fixture.flush();
      expect(fixture.provider.admission.subscriptions).toBe(0);
    } finally {
      await fixture.dispose();
    }
  }
});
