import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createTestViewServer } from "@bruno/view-server-client/testing";
import { createTopicHooks } from "@bruno/view-server-client/react";
import { catalog } from "@bruno/view-server-client/generated/demo-catalog";
import { sources } from "@bruno/view-server-client/generated/source-metadata";
import { decimal, uint64 } from "@bruno/view-server-client/schema";

const hooks = createTopicHooks(catalog);
const exact = "9007199254740993.123456789012345678";
const query = { select: ["customer", "units", "price"], orderBy: [] } as const;
function Grid({ id }: { id: string }) {
  const result = hooks.useLiveQuery("client_orders", query);
  return createElement(
    "output",
    { "data-grid": id, "data-status": result.status },
    result.rows.map((row) => `${row.customer}|${row.units}|${row.price}`).join(","),
  );
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
async function waitFor(predicate: () => boolean, message: string) {
  const until = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() > until) throw Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
const input = (name: string) => ({
  key: { id: "same" },
  value: {
    orderId: "same",
    customer: name,
    units: uint64(9007199254740993n),
    price: decimal(exact),
    open: true,
  },
});
async function run() {
  // No module override: resolve/fetch the actual WASM alongside installed public exports.
  const left = await createTestViewServer({ catalog, sources });
  const right = await createTestViewServer({ catalog, sources });
  const host = document.getElementById("app");
  assert(host, "Missing fixture host");
  const root = createRoot(host);
  const grid = (id: string) => document.querySelector(`[data-grid="${id}"]`);
  try {
    await left.publish("client_orders", input("left")).delivered;
    await right.publish("client_orders", input("right")).delivered;
    root.render(
      createElement(
        "section",
        null,
        createElement(left.Provider, null, createElement(Grid, { id: "left" })),
        createElement(right.Provider, null, createElement(Grid, { id: "right" })),
      ),
    );
    await waitFor(
      () =>
        grid("left")?.textContent === `left|9007199254740993|${exact}` &&
        grid("right")?.textContent === `right|9007199254740993|${exact}`,
      "Public React consumers did not receive isolated exact rows",
    );
    await left.publish("client_orders", input("updated")).delivered;
    await waitFor(
      () => grid("left")?.textContent === `updated|9007199254740993|${exact}`,
      "Live Worker update did not reach React",
    );
    assert(
      grid("right")?.textContent === `right|9007199254740993|${exact}`,
      "Isolated peer changed",
    );
    await left.delete("client_orders", { id: "same" }).delivered;
    await waitFor(
      () =>
        grid("left")?.textContent === "" &&
        grid("right")?.textContent === `right|9007199254740993|${exact}`,
      "Worker delete or isolation failed",
    );
    root.unmount();
    await left.flush();
    await right.flush();
    assert(
      left.provider.admission.subscriptions === 0 && right.provider.admission.subscriptions === 0,
      "Unmount retained subscriptions",
    );
  } finally {
    await left.dispose();
    await right.dispose();
  }
  assert(
    left.diagnostics.disposed && right.diagnostics.disposed,
    "Fixture disposal did not settle",
  );
  assert(
    left.provider.admission.outstanding === 0 && right.provider.admission.outstanding === 0,
    "Disposal retained pending commands",
  );
  return {
    status: "passed",
    checks: [
      "installed-public-exports",
      "default-relative-wasm-url",
      "actual-generic-workers",
      "exact-values",
      "publish-before-mount",
      "react-live-update",
      "same-topic-key-isolation",
      "delete",
      "unmount-subscriptions",
      "disposal",
    ],
    exactRoundTrip: exact,
  };
}
void run().then(
  (value) => {
    const result = document.getElementById("result");
    if (result) result.textContent = JSON.stringify(value);
  },
  (error) => {
    const result = document.getElementById("result");
    if (result) result.textContent = JSON.stringify({ status: "failed", error: String(error) });
  },
);
