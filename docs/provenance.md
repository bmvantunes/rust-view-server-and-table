# Source provenance

Rust SDK/engine/runtime: bmvantunes/rust-view-server be2d8f400e9b5ba6e632e541007d20e3e99df465, local feat/shadcn-table-compatibility integration. Published predecessor 1008840f580174ebe481c627f0e857c3ced8a075.

Table and required internal UI: bmvantunes/shadcn-table 341c82dd2e5498a801e71fc4e1b62e5e0d57106d. The old checkout at 00efa816 remains untouched.

Read-only regression reference: Astryx 851f4afee86fdca15bbb28e0a0fe4dab127084ae. Semantic oracle stays effect-view-server 4.2.8 / Effect 4.0.0-rc.111.

Official Vite+ 1.0.0 monorepo/library/application scaffolds and TanStack CLI 0.71.1 generated the initial workspace. Unused newly generated website/utils packages removed. Server scaffold is repurposed as Cargo adapter.

Live wire source moved from experiments/v131 into owned SDK/crates paths. Historical evidence, caches, compiled assets, archives and reports were excluded. Original source repositories and dirty changes were not altered. No root project license chosen; imported notices and licenses retain their original scope.

Buf validates/builds the illustrative proto inputs before the existing descriptor/catalog generator. Company-specific Decimal plugin/type mapping remains unavailable and is not invented.

The cleanup branch preserves those imports and native crate names while moving the TypeScript SDK, Workers and browser fixtures to `packages/view-server-client` (`@bruno/view-server-client`). The Rust package now owns only native/WASM implementation and its private task adapter. Historical `IMPORT-MAP.json` and qualification files describe their original import/test checkpoint; [cleanup-split.md](cleanup-split.md) and [cleanup-inventory.json](cleanup-inventory.json) record current ownership and authoring changes. The native/browser parity corpus is shared at `fixtures/native-wasm-parity.json`.
