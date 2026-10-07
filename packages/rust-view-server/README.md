# Rust View Server

This private workspace package owns the Rust view engine and its native and WebAssembly builds. Cargo
owns the Rust crates and tests; the root Cargo workspace and `rust-toolchain.toml` are authoritative.
The TypeScript SDK, Workers, Provider, generated client bindings, and browser tests live separately in
[`packages/view-server-client`](../view-server-client/README.md) as `@bruno/view-server-client`.
This Rust package has no npm runtime exports.

## BrunoTable integration

The workspace demo shares one `BrowserProductProvider` from
`@bruno/view-server-client/react` across both tables. The table adapter and setup are documented in
the [BrunoTable Rust integration guide](../table/USAGE.md#rust-view-server-integration) and shown in
[`apps/web/src/demonstration.tsx`](../../apps/web/src/demonstration.tsx). The Client hook acquires a
complete source; the Server hook supplies sparse viewport data. Client identity comes from each
source row and is passed through `getRowId`; Server identity is authoritative in the viewport source.
Each table requires a stable `tableId` and non-empty `initialOrderBy`.

The root `@bruno/table` entry does not require Effect. Decimal columns use the optional
`@bruno/table/effect` entry, but `@bruno/table/rust` currently imports Effect BigDecimal at runtime, so
install the matching Effect peer when using that adapter, even if the catalog has no Decimal fields.
The TypeScript SDK itself does not require Effect. See the [decimal integration note](../../docs/decimal-integration.md)
for the exact current representation and version details.

## Workspace commands

Run commands from the repository root. `vp run build:sdk` builds the Rust WebAssembly engine, stages
and checks its artifacts, and builds the client SDK. `vp run test:provider` runs the SDK browser
fixtures; `vp run test:sdk-runtime` checks client protocol and artifact behavior. `vp run build`,
`vp run check`, `vp run test`, and `vp run verify` cover the integrated workspace.

See the [workspace README](../../README.md), [generic WebAssembly guide](../../docs/generic-wasm.md),
and [end-to-end guide](../../docs/e2e.md). Migration provenance and current qualification are recorded
in the [source import map](./IMPORT-MAP.json), [cleanup qualification](../../docs/cleanup-split.md),
and [merge qualification](../../docs/merge-qualification.md).
