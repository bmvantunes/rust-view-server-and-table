# @bruno/view-server-client

The TypeScript SDK for the Rust view server. This package owns the Provider, hooks, Workers, schema helpers, protocol decoding/validation, row-delta reconstruction, generated TypeScript catalogs and isolated local WASM fixtures. Public entry points include the package root, `/react`, `/schema` and `/testing`.

Rust implementation and WASM sources live in `../rust-view-server/crates`. They are a development build dependency only. The client has no runtime Cargo imports, install hook or dependency on the table.

From the workspace root, run `vp run build:sdk` to compile Rust WASM, verify and stage artifacts, emit the SDK and Workers, and package the WASM assets. The published package layout resolves its own emitted Worker and WASM files; consumers need no Rust toolchain. Use `vp run test:provider` for the isolated real-browser fixtures and `vp run test:sdk-runtime` for protocol and artifact checks.

Shared proto authority and generators remain at the workspace root. See [fixture usage](../../docs/generic-wasm.md), [package ownership](../../docs/cleanup-split.md), and the root commands for full integration verification. `QUALIFICATION.json` retains the original pre-split checkpoint; current cleanup evidence is separate.
