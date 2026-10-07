# Qualification after integrating master

PR [#2](https://github.com/bmvantunes/rust-view-server-and-table/pull/2) combines the reviewed cleanup/package split with master `5b994153d9dcd087e69c7d319de64dbdc546de14` through an ordinary merge. The final executable candidate is **`d7617cf28fdec833501ac07adafad1b1d0f14f01`**. The delivery commit adds this evidence only. See [machine-readable results](merge-qualification.json) and the [initial cleanup qualification](cleanup-qualification.json) for the earlier fresh-checkout and packaged-consumer checks.

The fresh campaign **e2e-91081aaae760e3e1 passed all 12 browser checks** with **200,000 distinct initial live rows in each source topic**. Its source fingerprint matches the frozen Git commit. It includes real editing, exact aggregates, live updates/deletes, transport interruption, native restart, Worker asset failure, explicit retry and disposal. The runner completed in 227.92 seconds. All owned children and broker resources stopped with no cleanup errors; the run-owned data volume remains preserved.

Native restart still requires the existing explicit browser retry after the automatic retry budget expires. No SDK/Rust retry budget or decimal arithmetic changed. Company source decoder mapping remains pending; genuine Effect BigDecimal values and exact conversion support remain present. Broader charter acceptance remains false.

| Executed verification | Result |
| --- | --- |
| Full root checks on integrated master `74f5d1e` | PASS: native lint, strict TypeScript, source/emitted consumers and policy |
| Full root tests on `17c784d` | PASS: 211 native + 5 socket, 101 Provider, 5 complete SDK, 16 UI, 46 infra, 15 SDK runtime, 16 table tooling, 1,180 table fast and 767 table browser |
| Final table repair: build, source/emitted types and app types | PASS with pinned compiler |
| Final table tests | 1,182 fast with one worker and 768 browser PASS; 21 focused lifecycle/adapter and actual React regression also PASS |
| Authoring and package boundaries | PASS; no reverse SDK-to-table runtime dependency |
| Fresh full campaign on `d7617cf` | All 12 checks PASS; independent producer-journal and frozen-source audit PASS |

Native counts exclude one nested process helper; 11 intentionally ignored native tests remain. The final repair changes only table subscription admission handling and its tests, so unchanged native/SDK suites were not repeated after the clean full-root run. The campaign rebuilt its required artifacts through VP.

Two narrow repairs followed integration: the grouping test now waits for the menu to unmount, and a Provider that fails before complete-source subscription now yields an owned empty error state instead of throwing from a React effect. The latter preserves the visible retry action; regression tests cover actual SDK failure, replacement, StrictMode cleanup and ignored late deliveries. Independent review found no actionable issues.

Failures remain visible in the machine-readable report: an unchanged native timing assertion; two occurrences of the menu teardown race; the prior 10/12 asset-failure campaign; the new regression before its fix; and an unchanged wide-column test at 160.7ms against 150ms. The entire table suite passed with one worker without changing that limit. These local timings are not performance guarantees. Prior failed runs were not relabeled or reused as passing evidence.

Raw logs and evidence are retained under `.local/cleanup/master-integration/` and `.local/e2e/e2e-91081aaae760e3e1/`, with hashes recorded in the report. Safari, cold-offline/PWA and broker-loss behavior remain outside this qualification.
