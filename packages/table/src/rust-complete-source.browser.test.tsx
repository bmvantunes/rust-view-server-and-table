import { StrictMode, useState } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { cleanup, render } from "vitest-browser-react";
import { BrowserProductProvider } from "@bruno/view-server-client/react";
import { catalog } from "@bruno/view-server-client/generated/topics";
import { sources } from "@bruno/view-server-client/generated/source-metadata";
import { BrunoTableCreateRustHooks } from "./rust/index";

const hooks = BrunoTableCreateRustHooks({ orders: catalog.orders });
type CompleteProvider = Pick<BrowserProductProvider, "watchComplete">;
afterEach(cleanup);

test("pre-failed complete-source admission preserves the visible error and retry UI", async () => {
  // Disposal exercises the actual SDK terminalCause guard before the React effect runs.
  const failed = new BrowserProductProvider({
    mode: "memory",
    sources: { orders: sources.orders },
    // This valid empty module only satisfies constructor input. No engine queries
    // are issued and no network transport is configured.
    module: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
    catalog: { orders: catalog.orders },
  });
  failed.dispose();
  await expect(failed.ready).rejects.toThrow("provider is disposed");
  const active = new Set<object>();
  const healthy: CompleteProvider = {
    watchComplete(_topic, _schema, _fingerprint, listener) {
      const token = {};
      active.add(token);
      listener({ status: "ready", rows: [], loaded: 0 });
      return () => { active.delete(token); };
    },
  };
  function Consumer() {
    const [provider, setProvider] = useState<CompleteProvider>(failed);
    const source = hooks.useCompleteSource(provider, "orders");
    return <section>
      <output role="status">{source.status}:{source.loaded}:{source.totalRows}:{source.version}:{source.rows.length}</output>
      {source.error && <p role="alert">{source.error}</p>}
      <button onClick={() => setProvider(healthy)}>Reconnect and reacquire</button>
    </section>;
  }
  const screen = await render(<StrictMode><Consumer /></StrictMode>);
  try {
    await expect.element(screen.getByRole("status")).toHaveTextContent("error:0:0:0:0");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("provider is disposed; pending completion uncertain");
    await screen.getByRole("button", { name: "Reconnect and reacquire" }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("ready:0:0:1:0");
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    expect(active.size).toBe(1);
  } finally {
    await screen.unmount();
    failed.dispose();
  }
  expect(active.size).toBe(0);
});
