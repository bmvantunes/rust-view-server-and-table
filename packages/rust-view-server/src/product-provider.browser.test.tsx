import { createElement, useEffect, useState } from "react";
import { expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import {
  BrowserProductProvider,
  ProductProvider,
  useProductLiveQuery as useLiveQuery,
  type ProductQuery,
  type ProductResult,
  toProductQuery,
} from "./product-provider";
import {
  useLiveQuery as useTopicLiveQuery,
  useLiveQueryViewport,
} from "./product-provider";

type Corpus = {
  commands: Array<Record<string, unknown>>;
  expect: {
    all: { ids: string[]; total_rows: number; version: number };
    c0: { ids: string[]; total_rows: number; version: number };
  };
};

const allQuery: ProductQuery = {
  where_expr: { op: "true" },
  direction: "ascending",
  offset: 0,
  limit: 8,
};

function QueryView({ subscription, testId, onResult }: {
  subscription: string;
  testId: string;
  onResult?: (ids: string[], total: number) => void;
}) {
  const { data, error } = useLiveQuery(subscription, allQuery);
  const ids = data?.rows.map(({ id }) => { if (id === undefined) throw Error("Full local row requires id"); return id; }) ?? [];
  onResult?.(ids, data?.total_rows ?? -1);
  return createElement(
    "output",
    { "data-testid": testId, "data-error": error?.message ?? "" },
    `${data?.version ?? "loading"}|${data?.total_rows ?? "loading"}|${ids.join(",")}`,
  );
}

async function loadCorpus(): Promise<Corpus> {
  const response = await fetch(new URL("../../../fixtures/product-core-100.json",import.meta.url));
  if (!response.ok) throw new Error(`corpus fetch failed: ${response.status}`);
  return (await response.json()) as Corpus;
}

async function seed(provider: BrowserProductProvider, commands: Array<Record<string, unknown>>) {
  for (const command of commands.slice(0, 100)) await provider.apply(command);
}

it("runs the shared 100-row corpus through WASM and applies replacement results via a mounted React hook", async () => {
  const corpus = await loadCorpus();
  const provider = new BrowserProductProvider();
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const firstPublish = provider.apply(corpus.commands[0], traceparent);
  try {
    await firstPublish;
    expect(provider.lastWorkerTraceparent).toBe(traceparent);
    await seed(provider, corpus.commands.slice(1, 100));
    const screen = await render(
      createElement(ProductProvider, {
        provider,
        children: createElement(QueryView, { subscription: "all", testId: "all" }),
      }),
    );
    try {
      await expect.element(screen.getByTestId("all")).toHaveTextContent(
        `${corpus.expect.all.version - 3}|100|p-000,p-001,p-002,p-003,p-004,p-005,p-006,p-007`,
      );
      await provider.apply(corpus.commands[101]);
      await provider.apply(corpus.commands[102]);
      await expect.element(screen.getByTestId("all")).toHaveTextContent(
        `103|99|${corpus.expect.all.ids.join(",")}`,
      );
    } finally {
      await screen.unmount();
    }
  } finally {
    provider.dispose();
  }
});

it("keeps sparse viewport rows at absolute ranks through queued moves and edits before the range", async () => {
  const corpus = await loadCorpus();
  const provider = new BrowserProductProvider();
  await seed(provider, corpus.commands.slice(0, 100));
  const query = { select: ["id", "amount"] as const, where: [], orderBy: [{ field: "amount", direction: "asc" }] as const };
  const emissions: Array<{ count: number; indexes: string }> = [];
  let move: ((first: number, last: number) => void) | undefined;
  function Sparse() {
    const viewport = useLiveQueryViewport("products");
    const [value, setValue] = useState("loading");
    useEffect(() => {
      const generation = viewport.viewport.replace({
        window: { firstRow: 9, lastRow: 11 }, query,
        sink: {
          setRowCount(count) { emissions.push({ count, indexes: "count" }); },
          setRowData(rows) {
            const keys = Object.keys(rows).map(Number).sort((a, b) => a - b);
            const indexes = keys.map((index) => `${index}:${rows[index]?.id}`).join(",");
            emissions.push({ count: -1, indexes });
            setValue(indexes);
          },
        },
      });
      move = (first, last) => generation.setWindow({ firstRow: first, lastRow: last });
      return () => generation.release();
    }, [viewport.viewport]);
    return createElement("output", { "data-testid": "sparse-ranks" }, value);
  }
  try {
    const screen = await render(createElement(ProductProvider, { provider, children: createElement(Sparse) }));
    try {
      const ids = Array.from({ length: 100 }, (_, index) => `p-${String(index).padStart(3, "0")}`);
      await expect.element(screen.getByTestId("sparse-ranks")).toHaveTextContent(`9:${ids[9]},10:${ids[10]},11:${ids[11]}`);
      move?.(2, 4);
      move?.(5, 7);
      await expect.element(screen.getByTestId("sparse-ranks")).toHaveTextContent(`5:${ids[5]},6:${ids[6]},7:${ids[7]}`);
      expect(emissions.some((entry) => entry.indexes === `2:${ids[2]},3:${ids[3]},4:${ids[4]}`)).toBe(true);
      await provider.apply({ command: "upsert", row: { id: "before-range", category: "new", quantity: "0", amount: { coefficient: "-1000", scale: 0 } } });
      await expect.element(screen.getByTestId("sparse-ranks")).toHaveTextContent(`5:${ids[4]},6:${ids[5]},7:${ids[6]}`);
      await provider.apply({ command: "delete", id: "before-range" });
      await expect.element(screen.getByTestId("sparse-ranks")).toHaveTextContent(`5:${ids[5]},6:${ids[6]},7:${ids[7]}`);
      await provider.apply({ command: "delete", id: ids[6] });
      await expect.element(screen.getByTestId("sparse-ranks")).toHaveTextContent(`5:${ids[5]},6:${ids[7]},7:${ids[8]}`);
      move?.(200, 202);
      await expect.element(screen.getByTestId("sparse-ranks")).toBeEmptyDOMElement();
      expect(provider.lastWorkerStats?.worker_results_built).toBeGreaterThan(0);
    } finally { await screen.unmount(); }
  } finally { provider.dispose(); }
});

it("isolates same-shape React consumers and keeps Worker acknowledgements independent of throwing listeners", async () => {
  const provider = new BrowserProductProvider();
  await seed(provider, (await loadCorpus()).commands.slice(0, 4));
  const query = { select: ["id"] as const, where: [], orderBy: [] as const };
  function Consumers() {
    const left = useTopicLiveQuery("products", query);
    const right = useTopicLiveQuery("products", query);
    return createElement("output", { "data-testid": "consumers" }, `${left.totalRows}|${right.totalRows}`);
  }
  try {
    const screen = await render(createElement(ProductProvider, { provider, children: createElement(Consumers) }));
    try {
      await expect.element(screen.getByTestId("consumers")).toHaveTextContent("4|4");
      expect(provider.lastWorkerStats?.active_subscriptions).toBe(2);
      expect(provider.lastWorkerStats?.active_query_shapes).toBe(1);
      let throwingListenerReported = false;
      let healthyListenerSawResult = false;
      provider.onConsumerError = () => { throwingListenerReported = true; };
      const stopThrow = provider.watch("throwing-listener", allQuery, (() => { throw new Error("listener exploded"); }) as (result: ProductResult) => void);
      const stopHealthy = provider.watch("healthy-listener", allQuery, (() => { healthyListenerSawResult = true; }) as (result: ProductResult) => void);
      await provider.apply({ command: "upsert", row: { id: "extra", category: "c0", quantity: "1", amount: { coefficient: "-1", scale: 0 } } });
      await expect.poll(() => throwingListenerReported && healthyListenerSawResult).toBe(true);
      await provider.apply({ command: "upsert", row: { id: "after-error", category: "c0", quantity: "1", amount: { coefficient: "0", scale: 0 } } });
      expect(provider.lastWorkerStats?.active_subscriptions).toBe(4);
      stopThrow(); stopHealthy();
    } finally { await screen.unmount(); }
  } finally { provider.dispose(); }
});

it("sorts exact negative decimals and preserves ascending ID ties in both WASM directions", async () => {
  const provider = new BrowserProductProvider();
  const values: Array<[string, string]> = [
    ["m10", "-10"], ["m2", "-2"], ["m1-z", "-1"], ["m1-a", "-1"],
    ["z0-b", "0"], ["z0-a", "0"], ["p2", "2"], ["p10", "10"],
  ];
  try {
    for (const [id, coefficient] of values) {
      await provider.apply({ command: "upsert", row: { id, category: "sort", quantity: "0", amount: { coefficient, scale: 0 } } });
    }
    const ascending = await provider.open("sort-asc", { where_expr: { op: "true" }, direction: "ascending", offset: 0, limit: 20 });
    const descending = await provider.open("sort-desc", { where_expr: { op: "true" }, direction: "descending", offset: 0, limit: 20 });
    expect(ascending.rows.map((row) => row.id)).toEqual(["m10", "m2", "m1-a", "m1-z", "z0-a", "z0-b", "p2", "p10"]);
    expect(descending.rows.map((row) => row.id)).toEqual(["p10", "p2", "z0-a", "z0-b", "m1-a", "m1-z", "m2", "m10"]);
  } finally { provider.dispose(); }
});

it("returns whole results beyond 100 rows and rejects unsupported raw query forms", async () => {
  const provider = new BrowserProductProvider();
  const query = { where_expr: { op: "true" }, direction: "ascending" as const, offset: 0, limit: 0xffff_ffff };
  try {
    expect((await provider.open("empty", query)).rows).toHaveLength(0);
    const expectedSizes = [1, 100, 101, 257];
    for (let index = 0; index < 257; index += 1) {
      await provider.apply({ command: "upsert", row: { id: `row-${String(index).padStart(3, "0")}`, category: "all", quantity: String(index), amount: { coefficient: String(index), scale: 0 } } });
      if (expectedSizes.includes(index + 1)) {
        const result = await provider.open(`size-${index + 1}`, query);
        expect(result.total_rows).toBe(index + 1);
        expect(result.rows).toHaveLength(index + 1);
        await provider.apply({ command: "close", subscription: `size-${index + 1}` });
      }
    }
  } finally { provider.dispose(); }
  expect(() => toProductQuery({ select: ["id"], where: [], orderBy: [{ field: "amount", direction: "asc" }, { field: "amount", direction: "desc" }] } as never)).toThrow("at most one");
  expect(() => toProductQuery({ select: [], where: [], orderBy: [] } as never)).toThrow("non-empty selection");
  expect(() => toProductQuery({ select: ["id"], where: [{ field: "quantity", type: "equals", filter: "1" }], orderBy: [] } as never)).toThrow("category equality");
});

it("isolates identical subscription names across fixture providers and reports explicit closed once when closed before readiness", async () => {
  const corpus = await loadCorpus();
  const left = new BrowserProductProvider();
  const right = new BrowserProductProvider();
  const earlyClose = new BrowserProductProvider();
  let afterCloseCallbacks = 0;
  const callback = ((_result: ProductResult) => { afterCloseCallbacks += 1; }) as ((result: ProductResult) => void) & { onError?: (error: Error) => void };
  Object.assign(callback, { onStatus: (status: string) => { if (status === "closed") afterCloseCallbacks += 1; } });
  earlyClose.watch("same-topic", allQuery, callback);
  earlyClose.close();
  await expect(earlyClose.apply(corpus.commands[0])).rejects.toThrow("provider is disposed");

  try {
    await Promise.all([
      seed(left, corpus.commands.slice(0, 2)),
      seed(right, corpus.commands.slice(0, 3)),
    ]);
    const leftScreen = await render(createElement(ProductProvider, {
      provider: left,
      children: createElement(QueryView, { subscription: "same", testId: "left" }),
    }));
    const rightScreen = await render(createElement(ProductProvider, {
      provider: right,
      children: createElement(QueryView, { subscription: "same", testId: "right" }),
    }));
    try {
      await expect.element(leftScreen.getByTestId("left")).toHaveTextContent("3|2|p-000,p-001");
      await expect.element(rightScreen.getByTestId("right")).toHaveTextContent("4|3|p-000,p-001,p-002");
      await right.apply({ command: "delete", id: "__barrier_missing__" });
      expect(afterCloseCallbacks).toBe(1);
    } finally {
      await leftScreen.unmount();
      await rightScreen.unmount();
    }
  } finally {
    left.dispose();
    right.dispose();
    earlyClose.dispose();
  }
});

it("uses topic/query hook inference and streams only the requested sparse viewport rows", async () => {
  const corpus = await loadCorpus();
  const provider = new BrowserProductProvider();
  await seed(provider, corpus.commands.slice(0, 30));
  const query = {
    select: ["id", "quantity", "amount"] as const,
    where: [{ field: "category", type: "equals", filter: "c0" }] as const,
    orderBy: [{ field: "amount", direction: "asc" }] as const,
  };
  let moveWindow: (() => void) | undefined;
  function Orders() {
    const live = useTopicLiveQuery("products", query);
    const viewport = useLiveQueryViewport("products");
    const [viewportIndices, setViewportIndices] = useState<number[]>([]);
    useEffect(() => {
      const generation = viewport.viewport.replace({
        window: { firstRow: 2, lastRow: 4 },
        query,
        sink: { setRowCount() {}, setRowData(rows) { setViewportIndices(Object.keys(rows).map(Number)); } },
      });
      moveWindow = () => generation.setWindow({ firstRow: 5, lastRow: 7 });
      return () => generation.release();
    }, [viewport.viewport]);
    return createElement("output", { "data-testid": "typed-orders" },
      `${live.status}|${live.totalRows}|${typeof live.rows[0]?.quantity}|${typeof live.rows[0]?.amount.coefficient}|${live.rows[0]?.quantity}|${live.rows[0]?.amount.coefficient}|${viewportIndices.join(",")}`);
  }
  try {
    const screen = await render(createElement(ProductProvider, {
      provider,
      children: createElement(Orders),
    }));
    try {
      await expect.element(screen.getByTestId("typed-orders")).toHaveTextContent("ready|8|string|string|9007199254740992|1|2,3,4");
      expect(provider.lastWorkerStats?.query_seed_rows_scanned).toBe(30);
      moveWindow?.();
      await expect.element(screen.getByTestId("typed-orders")).toHaveTextContent("ready|8|string|string|9007199254740992|1|5,6,7");
      const builtBeforeIrrelevant = provider.lastWorkerStats?.worker_results_built ?? 0;
      await provider.apply({ command: "upsert", row: { id: "outside", category: "other", quantity: "1", amount: { coefficient: "1", scale: 0 } } });
      expect(provider.lastWorkerStats?.query_seed_rows_scanned).toBe(30);
      expect(provider.lastWorkerStats?.upsert_predicate_checks).toBe(1);
      expect(provider.lastWorkerStats?.worker_results_built).toBe(builtBeforeIrrelevant);
      await provider.apply({ command: "upsert", row: { id: "outside", category: "other", quantity: "1", amount: { coefficient: "1", scale: 0 } } });
      expect(provider.lastWorkerStats?.worker_results_built).toBe(builtBeforeIrrelevant);
      await provider.apply({ command: "patch", id: "p-000", patch: {
        category: { op: "unchanged" }, label: { op: "unchanged" }, quantity: { op: "unchanged" },
        amount: { op: "set", value: { coefficient: "-5", scale: 0 } },
      } });
      expect(provider.lastWorkerStats?.worker_results_built).toBeGreaterThanOrEqual(builtBeforeIrrelevant + 2);
    } finally {
      await screen.unmount();
    }
  } finally {
    provider.dispose();
  }
});
