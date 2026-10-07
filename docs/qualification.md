# Original product qualification

This report is historical evidence for the pre-cleanup implementation. Current cleanup/split verification is recorded separately in [cleanup-split.md](cleanup-split.md).

This record applies to the frozen candidate commit named below. It is historical evidence and does not qualify later migration changes: the updated root `vp run test` task now includes the table Chromium browser suite, and that suite plus the full Kafka campaign must pass on the current candidate before claiming fresh acceptance.

The full campaign passed on `468e40cb9eefc4198499d98fed27141d7b057e5d` on 2026-10-06. The fresh clone also passed frozen installation, generation, build, check and the full fast suite with a clean tracked working tree. The machine-readable record is [qualification.json](qualification.json); the exact raw evidence remains in `.local/e2e/e2e-fcab61f0c80341d7/` and is excluded from Git.

## Acceptance matrix

| Area | Status | Evidence |
| --- | --- | --- |
| Official Vite+ scaffolds and pinned source imports | DONE | [Provenance](provenance.md), registry resolutions and root locks |
| Current selected toolchains and numeric React Compiler | DONE | [Toolchain decisions](toolchain-decisions.md), development/production numeric gates |
| Shared native/WASM engine and isolated production Provider fixtures | DONE | [SDK qualification](../packages/view-server-client/QUALIFICATION.json), 101 browser tests, native parity and controlled mutation failure |
| Ordinary table semantics and public Client/Server integration | DONE | 1,176 table tests, pinned Effect oracle, source/emitted type consumers |
| Scoped OrbStack Kafka and real two-topic campaign | DONE | Exact image digest, transaction/read_committed probes, all 12 full campaign checks |
| Fresh clone generate/build/check/fast suite | DONE | All composed commands exited zero; no VP task-cache hits; clean tracked working tree |
| Company-specific Buf Decimal plugin/type mapping | BLOCKED | Input unavailable; illustrative proto/Buf workflow works without inventing that mapping |
| Safari, cold-offline/PWA, broker-loss, virtualizer/compression changes | DEFERRED | Outside this qualification; no claim of support or migration |

## Exact workload and results

Both `client_orders` and `server_orders` started with **200,000 distinct live identities**, two partitions each. The independent producer journal contains 409 committed transactions. A separate reviewer reconstructed its identities, offsets and hashes and found no evidence inconsistency.

At initial native readiness, each topic had 200,000 active rows. Both partitions reached durable and derived NEXT `100199` and serving NEXT `100200`; transaction markers account for offsets beyond data-record counts. Browser Client completeness was checked against every authoritative row identity and the complete exact business payload, including missing/null distinctions, integers and decimals. The first coherent Client hash, after the mutation committed during partial bootstrap, was `aa17ddb200215f58a96733c4c84c77ec87a9aa2c9c03b3c35e62a6dca3f4bdbb`.

Initial Server delivery was exactly **18 cumulative rows, 18 distinct identities and a maximum window of 18**, with 18 mounted row identities. It scrolled to row 199,999 and returned all 2,048 facet options. The Client materialized all rows; the Server retained bounded windows.

All 12 checks passed: mutation during partial bootstrap; complete hashes/cuts; simultaneous sparse grids and deep scroll; Unicode Quick Filter/Match None and peer independence; bounded numeric/multisort/group/aggregate/facet queries; actual editing/paste/fill/committed saves and draft conflict; moved-row selection; exact live update and deletion; automatic same-page transport recovery; native restart and later update; bounded Worker asset failure and explicit retry; disposal/unmount.

The deliberate deletion left **199,999 rows in each topic**. Final Client hash was `91490357190cb17c90f43d48097f41af616e031da63c11107a15a69fba0618fe`; final Server receipt hash was `67cfcc0f04d21ca4a37e355e324fb8a082e1de1b39e027b0c17bc6adc6a128a7`.

## Recovery limit

Automatic recovery from the short same-page transport interruption passed. Native restart recovered the correct rows and acknowledged cuts in **31.94 seconds**, after the browser exhausted its unchanged automatic retry policy (12 attempts). The test verified truthful terminal errors, clicked the existing **Reconnect and reacquire** button on the same page, verified complete reacquisition, then committed and observed another update. This is **native restart recovery with explicit browser retry**, not automatic browser recovery across that longer restart.

The Kafka broker and its data volume remained intact during native-service restart. After qualification, all owned children exited and the owned broker/container/network stopped with no cleanup errors. A direct process and scoped Compose status check confirmed this. Volumes remain preserved; reset is explicit and run-scoped.

## Bounded measurements

| Measurement | Observation |
| --- | --- |
| Documented full command | 260.32 s |
| Native catchup after seed | 12.15 s |
| First coherent Client from browser start | 15.64 s |
| Source-update request to exact DOM observation | 2.93 s, includes harness work |
| Initial Worker binary payload | 35,248,912 bytes; complete stream 34,173,352, viewport 3,561 |
| Worker payload before asset-failure phase | 144,297,376 bytes, including recovery acquisitions |
| HTTP encoded bytes before asset-failure phase | 587,232 |
| Native RSS sample after restart | 309,072 KiB |
| Page JS heap sample | 978,386,100 bytes used; 1,075,265,536 allocated |
| First 2,048 rAF intervals | 30 over 32 ms; estimated 1,022 missed 60 Hz opportunities |

Raw samples are retained. These are measurements on this host, not peak-memory bounds, physical dropped-paint counts, causal speedups or production SLAs. Worker bytes are measured where its socket receives payloads; page CDP does not observe that Worker socket. Query probes qualify production provider semantics, not every equivalent menu interaction.

## Reproducibility and retained failures

A fresh local clone at `/private/tmp/rvsat-fresh-781b40b` uses the same candidate and lockfiles. A frozen dependency install reused 572 cached packages and fetched required registry policy metadata; an offline attempt failed because that metadata was absent. No old checkout or copied build outputs were used. Native/WASM compilation used cached downloaded crate sources with `CARGO_NET_OFFLINE=true`; generation used the frozen JavaScript dependencies. Pinned toolchains and the existing Chromium download are reused. This proves a clean install with those declared cache inputs, not a wholly uncached network installation.

The fresh fast suite passed 208 native tests (11 intentionally ignored; one explicitly invoked nested child excluded from that count), five legacy socket tests, 101 browser Provider tests, five complete-client tests, 1,176 table tests and 27 infrastructure/campaign tests. The ignored native cases are six opt-in Kafka socket regressions, one isolated Kafka regression and four process helpers. Fresh logs and their hashes are recorded in the machine-readable report.

Earlier failed frozen campaigns remain under `.local/e2e/`: transient source-readiness rejection, measurement before native catchup, the generic Worker facet ceiling, and automatic retry exhaustion during native restart. Repairs received focused regression tests and separate review. No failure was relabelled as a pass, no workload was reduced, and product retry budgets remain unchanged.

The final documentation commit only records evidence; executable qualification refers to the exact tested commit above. No remote push or package publication occurred.
