# TypeScript cleanup and package split

Branch: `refactor/typescript-tooling`. Baseline: `202833c9211cae9f9720c46a6ddff4f1dffc7594`. Final acceptance is in progress; historical PASS logs do not qualify these changes.

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

Fresh integrated qualification, final review, exact commit and executed result inventory will be recorded here before delivery.
