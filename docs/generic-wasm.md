# Generic WASM and isolated Provider fixtures

`@bruno/rust-view-server/testing` exposes `createTestViewServer`. It creates a real generic Rust engine in a dedicated browser Worker, then returns the production Provider and hooks interface. No socket server, Kafka process, JavaScript query evaluator, telemetry exporter or application HTTP transport is involved. A missing precompiled module is loaded as a static package WASM asset; test-runner traffic and this static fetch are distinct from application transport.

## Package boundary and build

`packages/rust-view-server/crates/core` contains the portable schema, typed key/rowId admission, mutation runtime, incremental raw/grouped/join evaluation, semantic profile and retention policy normalization. `crates/runtime` owns Kafka, native sockets, canonical durability and recovery. Its scalar protobuf decoder delegates admitted typed values to the same `TypedSource` as WASM. Expanded protobuf decoding remains native and shares the portable schema/evaluator boundary. `crates/wasm` binds the core using an explicit handle-based ABI. Each instance owns its runtime, memory and retention indexes.

`python3 scripts/build-wasm.py --clean` compiles both current generic WASM and the retained legacy product-only WASM from an empty artifact directory with the pinned Rust compiler and locked dependencies. It writes source hashes and binary hashes to `.local/wasm-build.json`; no old binary is copied. The generic fixture always selects `generic_engine.wasm`. The product asset exists only to preserve the pre-existing local Provider API and its regression tests.

`vp run build:sdk` builds typed ESM exports into `dist`, bundles all Worker entry points, and includes both fresh WASM assets. Public exports resolve emitted `.mjs` and `.d.mts`, not private TypeScript source. The browser fixture tests import these public exports. Vite-compatible consumers resolve the package-relative Worker and WASM URLs. This packaging has been exercised with the repository Vite application and Chromium test runner; other bundlers are not claimed as qualified.

## Typed fixture example

```tsx
import {createTestViewServer} from '@bruno/rust-view-server/testing';
import {createTopicHooks} from '@bruno/rust-view-server/react';
import {catalog} from '@bruno/rust-view-server/generated/demo-catalog';
import {sources} from '@bruno/rust-view-server/generated/source-metadata';
import {uint64, decimal} from '@bruno/rust-view-server/schema';

const fixture = await createTestViewServer({
  catalog, sources, clock: {nowMs: 0},
  retention: {client_orders: {maxRetentionMinutes: 1}},
});
const hooks = createTopicHooks(catalog);
await fixture.publish('client_orders', {
  key: {id: 'same'},
  value: {orderId: 'same', customer: 'Alice', open: true,
          units: uint64(3n), price: decimal('0.1')},
}).delivered;

function Rows() {
  const result = hooks.useLiveQuery('client_orders', {
    select: ['customer', 'units'], orderBy: [],
  });
  return <output>{result.rows.map(row => row.customer).join(',')}</output>;
}
// Mount <fixture.Provider><Rows /></fixture.Provider> in this test's container.
// Wrap writes after mounting in React act and assert using waitFor.
await fixture.advanceTime(60_000).delivered;
await fixture.dispose();
```

Generated schemas determine value types. Generated `keyFields` and source identity determine key types and the source-owned rowId. Publishers cannot supply rowId. Exact integer/decimal brands retain wire precision; malformed values fail genuine Rust schema admission. Full after-images distinguish an omitted optional value, explicit null, zero and empty text. A key-only tombstone is rejected for a delete-log identity that includes a value field, matching native source semantics.

## Lifecycle, clocks and receipts

Call initialization outside React render. An immutable `WebAssembly.Module` may be shared through the `module` option; no mutable instance or memory is shared. An optional `signal` cancels initialization. Initialization and each receipt have a finite timeout (10 seconds by default, explicitly bounded to 60 seconds); expiry closes the owned Provider and settles pending operations. `dispose()` is idempotent, terminates the Worker, clears fixture maintenance, releases subscriptions and awaits pending receipts. It is safe during pending initialization through the abort signal or directly through the lower-level Provider's `dispose()`.

A receipt's `accepted` sequence identifies local queue acceptance. `applied` rejects invalid inputs and resolves after the engine command is acknowledged. `delivered` resolves after synchronous Provider observers for that acknowledgement have been invoked; it does not promise React commit or browser paint. Throwing observers are isolated by the Provider. `flush()` is a queue/application/observer barrier. None of these operations is a Kafka durability acknowledgement.

An explicit `clock: {nowMs}` selects a per-fixture controlled clock; `advanceTime(milliseconds)` rejects negative or unsafe values. Retention uses the shared native normalization, checked expiry calculation and count-policy admission. Silent expiry retracts rows through the same generic mutation engine, including groups and joins. Without a controlled clock, retention uses an owned monotonic scheduler at 250 ms intervals; fixtures without retention allocate no maintenance timer. Browser tests do not install global fake timers or reset another fixture's state.

The local retention index is intentionally ephemeral. It does not model Kafka event timestamps, partition ownership, transactions, canonical persistence, recovery or broker retention. Those require native integration qualification. Local count policies use typed logical source keys, while native retention retains its original protobuf key identity. Compacted source identities are key-only, so replacing a key refreshes its one live row.

## Bounds and qualification

Default retained-row capacity is 250,000 per topic; initialization may specify a smaller explicit `maxRows`. Commands and result frames are bounded to 4 MiB; reads are bounded to 4,096 rows. The fixture is not an unbounded whole-source exporter. Production complete acquisition has its own credit-controlled protocol and tests.

`vp run test:provider` builds the fresh assets and runs real Worker/WASM and Provider tests without requiring OrbStack. New tests cover simultaneous fixtures with identical topic/key names, publish before mount, StrictMode, live changes and deletion, omission/null/zero/empty, profile filtering, exact aggregation, grouped HAVING, incremental left joins, controlled silent expiry, rejected query replacement, observer exceptions, shared-query release, pending initialization cancellation, terminal disposal and ignored late callbacks. Imported R1, R1-MIXED and H1 cases remain executable browser regressions. The complete native test suite also exercises native schema/source identities and default semantics separately.

Browser installation must use `PLAYWRIGHT_SKIP_BROWSER_GC=1` to preserve unrelated cached browser versions. During the initial tool setup the installer removed three older shared browser caches; their exact revisions were restored (Chromium/headless 1228 and WebKit 2311). This tooling side effect did not modify old project checkouts or source files.

## Paired and mutation evidence

`crates/wasm/tests/typed_parity.rs` and the browser fixture consume the same `tests/fixtures/native-wasm-parity.json`. Generated Orders schema and SimpleKey metadata drive six source/time cuts. Every native Runtime result equals the local binding result, including keys, versions, raw projections and grouped rows. The browser Provider checks those same raw/grouped cuts. The native reference schedules expiry independently with the shared checked clock policy; it does not call the local retention index.

Run `python3 packages/rust-view-server/scripts/check-engine-mutation.py` after building the SDK to repeat the mutation check. It copies only the portable crates into a scoped temporary workspace, deliberately makes the engine ignore admitted deletes, compiles that copy, and runs the actual emitted React consumer with that WASM. The observed failure is the retained `changed:0` row after a deletion when the DOM must be empty. A successful build or a module-loading failure cannot satisfy the gate. The script restores the scratch source exactly, verifies production source hashes are unchanged, removes the scoped scratch tree, and records `.local/engine-mutation.json` plus its test log. Production artifacts are never replaced by the defective asset.

`tsconfig.contracts.json` preserves the generated-schema compile contracts. `tsconfig.emitted.json` separately checks the emitted React declarations with `skipLibCheck: false`. Explicit public hook interfaces prevent recursive query-check types from expanding into a 110 KB inferred return declaration; the qualified emitted Provider declaration is approximately 17 KB and its strict import check completes in under a second on this host.
