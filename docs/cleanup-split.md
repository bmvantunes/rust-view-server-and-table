# TypeScript cleanup and package split

Branch: `refactor/typescript-tooling`. Baseline: `202833c9211cae9f9720c46a6ddff4f1dffc7594`. Current qualification after integrating master is at `d7617cf28fdec833501ac07adafad1b1d0f14f01`; see [final integration results](merge-qualification.md). The initial cleanup qualification below remains historical evidence from `31e24ec`, before publication and the master integration.

| Owner | Maintained source |
| --- | --- |
| `packages/rust-view-server` | Existing Rust core/runtime/admission/wire/WASM crates, native tests, private Cargo task adapter |
| `packages/view-server-client` | `@bruno/view-server-client`: SDK, Provider/hooks, Workers, protocol validation, schema helpers, generated catalogs, local WASM fixture and client tests |
| `packages/table` | BrunoTableClient/BrunoTableServer, genuine Effect BigDecimal integration, public SDK adapter |
| Workspace | Proto authority/generation, verified WASM staging, native orchestration, cross-package tests and policy gates |

No native crate names or protocol identifiers changed. Cargo’s root workspace/toolchain remain authoritative. Table imports public client exports; no SDK→table dependency exists. All old SDK runtime exports were removed from the Rust adapter. No external compatibility consumer was identified, so no duplicate SDK/shim remains.

## Authoring inventory

The baseline contains 14 Python implementations/tests, 31 JavaScript implementations/tests and five standalone declarations ending in `.d.mts`. Necessary logic moved to checked TypeScript; redundant Intent packaging helpers were removed with their unused development dependency. Runtime row reconstruction and wire decoding retain unknown-input validation and atomic rejection. All root/client/table tooling and configuration helpers are included in the pinned TypeScript checks.

The exhaustive selected-extension before/after inventory is [cleanup-inventory.json](cleanup-inventory.json): **14 → 0 Python, 31 → 1 JavaScript, 5 → 1 standalone `.d.mts` signatures**. The remaining frozen `fixtures/rowid-before/projector.mjs` and its declaration are an independent historical oracle; the policy pins the implementation SHA-256. Generated output, installed dependencies, retained third-party Rust/protobuf sources and notices are explicitly excluded. Emitted Worker `.mjs`, declarations and WASM remain legitimate. No Python wrapper is hidden behind TypeScript. Shared build-helper `.d.ts` output is generated and explicitly ignored; signatures come from checked implementations. Two authored `.d.ts` twins were also removed; the one retained table ambient declaration describes the compile-time development/diagnostic constants.

## Commands and verification

Use `vp run build`, `vp run check`, `vp run test` and `vp run test:e2e`. Fast tests do not contact Kafka. The latter creates an owned OrbStack Kafka run and retains the 200,000 distinct live rows per source requirement. `vp run check:policy` verifies first-party authoring and package boundaries. Native `vp run build:native` works with already-generated catalogs before any SDK/table build.

WASM is built into `artifacts/wasm`, verified against source and artifact hashes and actual export arities, then staged and copied into client output. No package installation script invokes Cargo. Rust tool selection resolves every compiler/helper through the one root toolchain pin, including clippy.

The separate [decimal clarification](decimal-integration.md) records genuine Effect values, exact conversion checks and public result domains. Company source decoder mapping remains pending; decimal support is present.

## Initial cleanup qualification (historical)

The fresh full campaign **e2e-25491a17557af84e passed all 12 browser checks**, with **200,000 distinct initial live rows in each topic**, two partitions each, and no cleanup errors. It ran through the new TypeScript tooling and final package layout at frozen executable commit `31e24ec2962ad7312ec28b213c60ce5982ebb54f`. The machine-readable report is [cleanup-qualification.json](cleanup-qualification.json). Raw evidence remains in ignored `.local/e2e/e2e-25491a17557af84e/` and `.local/cleanup/`.

The campaign qualifies complete Client row identity/payload hashes and source cuts; bounded Server windows, deep scroll and 2,048 facets; exact aggregate results; real editing/paste/fill, conflict and selection behavior; live update/delete; recovery; and disposal. The deliberate deletion leaves 199,999 rows in each topic. Initial native catchup took 13.06 seconds; the runner took 239.64 seconds and browser checks 144.32 seconds.

Short transport interruption recovered automatically. Native restart recovered broker-backed state in **32.68 seconds**, after the unchanged browser retry budget expired; the existing **Reconnect and reacquire** action then reacquired complete data and observed a later update. This is explicit browser retry after native restart, not automatic browser recovery across the entire restart. Worker asset failure was tested separately and recovered through the same explicit action. All five owned children, container and network were confirmed stopped. The owned broker volume remains preserved; no reset occurred.

The earlier cleanup campaign `e2e-a911768a59f2bdd1` is retained as **failed**. Its inherited whole-browser offline fault also disabled replacement Worker downloads. The reviewed repair closes a real Worker transport through an owned loopback pass-through, keeps asset HTTP available, and requires a lost-attempt event, a new attempt and full coherence. A separate EOF/exit race fix reports browser failures accurately and tolerates signal errors only after observed child exit. Product recovery policy was unchanged.

| Verification actually executed | Result |
| --- | --- |
| Fresh same-repository worktree, frozen install → generate → build → check → full fast suite | PASS on `675aaa3`; no copied outputs, no VP task-cache hits |
| Final `31e24ec` tooling repair in that clean worktree | Strict TypeScript, all 46 infrastructure tests, authoring and dependency graph PASS |
| Native compilation with SDK/table output directories absent | PASS; actual app recompilation through VP, outputs restored afterward |
| Native suites | 208 passes, 11 intentionally ignored, plus 5 legacy socket passes; one nested helper excluded from count |
| Provider / complete SDK / table / UI browser | 101 / 5 / 1,176 / 16 passes |
| Runtime protocol/assets / table tooling | 15 / 16 passes |
| Source and emitted type consumers | PASS with pinned TypeScript 7.0.2 |
| Installed client tarball, actual Workers/default WASM assets | 10 checks PASS; no Rust invocation, source fallback or external service |
| Installed table and production React Compiler | PASS for types/runtime, SSR/hydration and exact numeric gates |
| Independent engine mutation and real cancellation negative controls | Expected failures observed; source restoration and cleanup verified |
| Effect clarification | 44 focused tests, eight genuine Effect values, exact roundtrip and inference PASS |

Fresh installation reused 569 cached pnpm packages and downloaded registry policy metadata; native compilation reused cached crate sources and existing toolchains/Chromium. This qualifies a fresh checkout with those declared caches, not an entirely uncached network install. Fresh WASM outputs matched the main checkout byte-for-byte. Rust 1.99.0, TypeScript 7.0.2, Effect 4.0.0-rc.111 and workspace locks remain pinned.

Independent review covered the complete cleanup/split and the exact final repair commit. The independent campaign audit replayed all 409 committed batches / 400,014 records and matched the starting/final distinct identities, hashes, source cuts and frozen Git source fingerprint; its evidence is indexed in the machine-readable report. The only company-specific pending work is source decoder mapping; decimal support is implemented. Broader charter acceptance remains false for that pending scope. Safari, cold-offline/PWA and broker-loss behavior remain outside this qualification. Local performance samples are observations, not peak-memory or production SLA claims.
