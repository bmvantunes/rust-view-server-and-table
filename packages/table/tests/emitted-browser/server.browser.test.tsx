import { afterEach, expect, test } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { Effect, Schema } from "effect";
import { ViewServerId, defineViewServerConfig } from "effect-view-server/config";
import { createViewServerReact } from "effect-view-server/react";
import { createInMemoryViewServerReact } from "effect-view-server/react/testing";

import { BrunoTableServer } from "../../dist/index.mjs";
import type { BrunoTableColumns } from "../../dist/index.mjs";

type Row = Readonly<{ id: string; symbol: string; desk: string; price: number }>;

const viewportConfig = defineViewServerConfig({
  topics: {
    orders: {
      schema: Schema.Struct({
        id: ViewServerId,
        symbol: Schema.String,
        desk: Schema.String,
        price: Schema.Number,
      }),
    },
  },
});
const viewportReact = createViewServerReact(viewportConfig);
type EmittedViewportSource = ReturnType<typeof viewportReact.useLiveQueryViewport>;
const completeRawSelect = Object.freeze([
  "id",
  "symbol",
  "desk",
  "price",
]) as unknown as EmittedViewportSource["completeRawSelect"];
type EmittedSink = Readonly<{
  readonly setRowCount: (count: number, keepRenderedRows?: boolean) => void;
  readonly setRowData: (
    rows: Readonly<Record<number, Partial<Row>>>,
    keys: Readonly<Record<number, string>>,
  ) => void;
}>;
type EmittedBrowserViewport = Omit<
  ReturnType<typeof viewportReact.useLiveQueryViewport>["viewport"],
  "destroy"
>;

const columns = [
  {
    columnId: "COL_ID_EMITTED_SERVER_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
    enableFilter: true,
    enableSetFilter: true,
  },
] satisfies BrunoTableColumns<Row>;
const groupingColumns = [
  {
    columnId: "COL_ID_EMITTED_SERVER_DESK",
    field: "desk",
    headerName: "Desk",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_EMITTED_SERVER_MIN_PRICE",
    field: "price",
    headerName: "Minimum",
    valueType: "number",
    aggFunc: "min",
    aggregateValueFormatter: ({ value }) => `Min ${String(value)}`,
  },
  {
    columnId: "COL_ID_EMITTED_SERVER_MAX_PRICE",
    field: "price",
    headerName: "Maximum",
    valueType: "number",
    aggFunc: "max",
    aggregateValueFormatter: ({ value }) => `Max ${String(value)}`,
  },
] satisfies BrunoTableColumns<Row>;

afterEach(async () => cleanup());

test("renders authoritative sparse slots from the emitted Server package", async () => {
  let sink: EmittedSink | undefined;
  const viewport = {
    semanticKey: (query: unknown) => JSON.stringify(query),
    replace(request: Readonly<{ readonly sink: NonNullable<typeof sink> }>) {
      sink = request.sink;
      sink.setRowCount(1_000, true);
      return { setWindow: () => undefined, release: () => undefined };
    },
  } as unknown as EmittedBrowserViewport;
  const screen = await render(
    <BrunoTableServer
      tableId="TABLE_ID_EMITTED_SERVER"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_EMITTED_SERVER_SYMBOL", direction: "asc" }]}
      viewportSource={{
        viewport,
        useWholeResult: () => ({ rows: [], totalRows: 0, version: 1, status: "ready" }),
        completeRawSelect,
        totalRows: 1_000,
        version: 1,
        status: "ready",
      }}
    />,
  );
  sink?.setRowData({ 0: { symbol: "EMITTED" } }, { 0: "emitted-row" });
  await expect.element(screen.getByRole("gridcell", { name: "EMITTED" })).toBeInTheDocument();
  await expect
    .element(screen.getByRole("grid", { name: "Data for TABLE_ID_EMITTED_SERVER" }))
    .toHaveAttribute("aria-rowcount", "1001");
  expect(screen.getByRole("checkbox", { name: /Select (all )?rows?/ }).query()).toBeNull();
});

test("renders and releases a live whole-result facet from the emitted package", async () => {
  const inMemory = createInMemoryViewServerReact(viewportReact);
  await Effect.runPromise(
    inMemory.client.publishMany("orders", [
      { id: "emitted-facet-1", symbol: "AAA", desk: "Rates", price: 10 },
      { id: "emitted-facet-2", symbol: "BBB", desk: "Credit", price: 20 },
    ]),
  );

  function EmittedFacetTable() {
    const source = viewportReact.useLiveQueryViewport("orders");
    return (
      <BrunoTableServer
        tableId="TABLE_ID_EMITTED_SERVER_FACET"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_EMITTED_SERVER_SYMBOL", direction: "asc" }]}
        viewportSource={source}
      />
    );
  }

  try {
    const screen = await render(
      <inMemory.ViewServerInMemoryProvider>
        <EmittedFacetTable />
      </inMemory.ViewServerInMemoryProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Filter Symbol" }));
    const dialog = screen.getByRole("dialog", { name: "Filter Symbol" });
    await expect.element(dialog.getByRole("checkbox", { name: "Select AAA, 1" })).toBeVisible();

    await Effect.runPromise(
      inMemory.client.publish("orders", {
        id: "emitted-facet-3",
        symbol: "AAA",
        desk: "Rates",
        price: 30,
      }),
    );
    await expect.element(dialog.getByRole("checkbox", { name: "Select AAA, 2" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Filter Symbol" }));
    await expect.element(dialog).not.toBeInTheDocument();
    await expect
      .poll(
        async () =>
          (await Effect.runPromise(inMemory.client.health())).engine.topics.orders
            .activeSubscriptions,
      )
      .toBe(1);
  } finally {
    await Effect.runPromise(inMemory.close);
  }
});

test("groups and decodes duplicate-field aggregates from the emitted package", async () => {
  const inMemory = createInMemoryViewServerReact(viewportReact);
  await Effect.runPromise(
    inMemory.client.publishMany("orders", [
      { id: "emitted-group-1", symbol: "AAA", desk: "Rates", price: 10 },
      { id: "emitted-group-2", symbol: "BBB", desk: "Rates", price: 30 },
    ]),
  );

  function EmittedGroupedTable() {
    const source = viewportReact.useLiveQueryViewport("orders");
    return (
      <BrunoTableServer
        tableId="TABLE_ID_EMITTED_SERVER_GROUPING"
        columns={groupingColumns}
        initialOrderBy={[{ columnId: "COL_ID_EMITTED_SERVER_DESK", direction: "asc" }]}
        groupRowsColumn={{ valueFormatter: ({ value }) => `${String(value)} orders` }}
        viewportSource={source}
      />
    );
  }

  try {
    const screen = await render(
      <inMemory.ViewServerInMemoryProvider>
        <EmittedGroupedTable />
      </inMemory.ViewServerInMemoryProvider>,
    );
    const groupRegion = screen.getByRole("region", { name: "Group By" });
    await userEvent.click(groupRegion.getByRole("combobox", { name: "Add Group" }));
    await userEvent.click(screen.getByRole("option", { name: "Desk", exact: true }));
    await expect.element(screen.getByRole("gridcell", { name: "Rates" })).toBeVisible();
    await expect.element(screen.getByRole("gridcell", { name: "2 orders" })).toBeVisible();
    await expect.element(screen.getByRole("gridcell", { name: "Min 10" })).toBeVisible();
    await expect.element(screen.getByRole("gridcell", { name: "Max 30" })).toBeVisible();
  } finally {
    await Effect.runPromise(inMemory.close);
  }
});
