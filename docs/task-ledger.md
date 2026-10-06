# Implementation ledger

IN PROGRESS. No integrated 200,000-row-per-topic acceptance is claimed.

## Verified checkpoints

- Official Vite+ scaffolds and pinned new monorepo; original repositories preserved.
- OrbStack engine and Compose verified; official JVM Kafka4.1.2 tag and digest pinned. Native transaction/read_committed and container-side metadata/produce/consume probes passed; owned data survives broker recreation.
- Shared generic native/WASM engine and emitted SDK; latest browser suite101/101 passes, including identical native/WASM corpus, isolated fixtures and actual missing-WASM-asset failure followed by explicit retry.
- Controlled copied-source delete mutation causes the real React consumer to fail; production source unchanged and scratch source restored.
- Table fast suite1,176/1,176; numeric React Compiler development/production browser gates pass. UI/table package builds, strict source/emitted Rust adapter types pass.
- Real100-row-per-topic app smoke: both simultaneous grids, coherent cuts/full client payload, sparse Server delivery, deep scroll99, Unicode filters, exact aggregates, facets and actual transaction-backed editing/paste saves have passed individual checks.
- Single journalled control authority now handles supported seed writes; producer locks, schema admission, conflict and cleanup regressions added. Independent review identified these issues; the repairs passed 16 control/campaign regressions and focused follow-up review.

## Remaining qualification

- Full application type check passes after assignment-checked helper output annotations bound the inference cost. Composed root check passed, including pinned Clippy and all source/emitted/app type gates.
- Finite100/topic production campaign passed all11 checks, including fill, selected-row movement, transport/service recovery, asset retry and cleanup. This was explicitly an unfrozen development run.
- Frozen candidate0bcfc82 full run e2e-d2302fb0c2db4c53 committed200,000 distinct rows per topic and Client acquired200,000, but failed the240s coherence gate: Server retained a transient retention-pending error. All owned resources stopped; volumes and failure evidence retained. Bounded per-query readiness retries, monotonic request IDs and supersession/cancellation regressions now pass100 browser tests and focused independent review; full rerun pending.
- Composed root build/check/test passed. Fresh dependency installation and full-size integration qualification remain. A separate fresh reviewer checked exact implementation bytes and both final harness repairs; no remaining actionable findings in that reviewed scope.
- Company-specific Buf Decimal plugin remains unavailable independently of the illustrative working schema workflow.

## Evidence and resources

Raw campaign results, failed runs, screenshots and producer receipts remain under ignored `.local/e2e/`; failures are retained. Broker data volumes are owned per run and preserved after shutdown. Fast tests do not need Kafka or OrbStack. Heavy builds/campaigns are coordinated between owners.

Local foundation commit: a8c2fbf. Integrated implementation checkpoint: bf06e06. No remote push or publication.

Full run781b40b / e2e-6bd3ea5593d44ecc reached exact200,000-row Client payload equality in16.93s and Server200,000 total with18 mounted rows. It failed the cumulative initial delivery gate because native catchup was still producing bounded live windows. A separately recorded native catchup phase now precedes browser measurement, preserving the original delivery bounds and bootstrap mutation. Worker payload bytes are measured at the actual socket receiver. Independent review and17 integration regressions pass; full rerun pending.

Full run71e5fd0 / e2e-953dd09d6e5c440a passed native catchup(12.14s), Client200,000 full hash(15.47s), Server18 delivered/distinct/mounted rows and deep scroll199,999. It then exposed a stale1024-row Worker reconstruction limit against the existing4096-row generic complete-result contract. Generic v15 decoding now explicitly uses4096 while legacy remains1024; actual Worker2048-row acceptance and4097-row rejection pass, with independent boundary/delta review. Full SDK source checking is now included in the root check gate. Full rerun pending.
