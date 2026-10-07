# Grouped sorting integration validation

Validated on 7 October 2026 against merged master `f3c00b98208c900792ea931a71699185f95846e9`. This validation adds regressions and their typecheck wiring; it does not change query evaluation, sorting, numeric conversion or hook behavior.

## Finding

Grouped query `orderBy` is honoured on the tested paths. The earlier confirmed defect was different: the table Rust adapter alphabetically sorted the `groupBy` tuple. Thus `['open', 'customer']` and `['customer', 'open']` became the same grouping request and semantic key. PR #3, commit `91f037674b968f329265485f1c8bee4a412473f1`, preserves the caller's tuple order. Both table viewport and whole-result paths use that shared compiler and benefited from the fix. That change did not remove or restore `orderBy`; it was already forwarded.

The grid maintains separate raw-row and grouped sort state. In grouped mode, `groupOrderBy` becomes the query's `orderBy` in `packages/table/src/internal/server-query.ts`. Raw-row sort state is retained separately. The Rust adapter in `packages/table/src/rust/translate.ts` preserves sort priority/direction and maps aggregate aliases to native aliases. Both controller paths forward the resulting `order_by`. Native grouped evaluation constructs rank tokens in that same sequence before applying the requested window.

## Executed checks

- Rebuilt emitted SDK, Workers, WASM, UI and table packages through `vp run build:packages`.
- Added `packages/table/src/rust-grouped-order.browser.test.tsx`, using actual React StrictMode, the public SDK testing fixture, real Worker/WASM, and the emitted `@bruno/table/rust` export. It checks SDK `useLiveQuery`, SDK `useLiveQueryViewport`, its `useWholeResult` helper, table `useViewportSource` and the table whole-result helper simultaneously.
- Hand-written expected results cover aggregate sum ascending/descending, field/aggregate tie-breaks, mixed field directions, exact decimal average ordering (`10.4` versus `2.3`), offsets after ranking, changing sort without remount, stable identities across sort changes, live aggregate reordering (`12` versus `9`), deletion and ordered-group-tuple replacement. An actual no-sort query is required to disagree with the sorted result. All subscriptions are released on unmount; fixture disposal is guaranteed in cleanup.
- The new browser regression passed through source table imports and then through emitted public table exports. The retained test uses the public package export. The dynamic returned-hook harness uses the same narrow React Compiler opt-out as the production Server facet boundary; production compiler configuration was not changed.
- All **109** surrounding adapter, lifecycle, Server query-planning and Server source-adapter tests passed.
- All **8** native `effect_profile` tests passed, including the new grouped multi-sort/window/live-reranking regression against the actual Rust runtime.
- Source and emitted Rust-adapter type consumers and the new browser test's focused strict TypeScript configuration passed with pinned TypeScript 7.0.2. The browser typecheck is included in the existing `test:types:rust` command. Repository policy and package-boundary checks passed.

The native regression is part of ordinary Cargo tests; the browser regression is part of the existing table browser suite. These focused tests require no Kafka. This is not a new 400,000-row network campaign; it validates the real local Worker/WASM integration and the shared native evaluator, with static tracing of the remote query forwarding.

## Other validation observations

An additional broad `tsc -p packages/table/tsconfig.json` invocation reported errors in unchanged upstream Babel/Zod declarations and existing table test/benchmark files. It is not reported as passing. The project's dedicated source/emitted consumer checks and the new focused browser configuration passed without relaxing declaration checks. The initial browser harness also encountered the known returned-hook React Compiler boundary; the retained harness handles that explicitly as described above.

Logs, including the failed broad check and initial harness attempt, are retained locally under `.local/validation/grouped-sort/`.
