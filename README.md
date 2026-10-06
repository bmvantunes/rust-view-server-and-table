# Rust View Server and BrunoTable

Private local workspace joining the proto-first Rust view engine with `BrunoTableClient` and `BrunoTableServer` in one TanStack Start app. See [qualification status](docs/task-ledger.md) before interpreting a passing individual check as integrated acceptance.

## Start here

Install the pinned Node runtime and dependencies through Vite+, and Rust 1.99.0 with `wasm32-unknown-unknown`. The root `.node-version`, Rust toolchain and lockfiles are authoritative. From this directory:

```sh
vp install --frozen-lockfile
vp run generate
vp run build
vp run test
vp run dev
```

The development app opens at http://127.0.0.1:3000. The default seed is 200,000 distinct identities in **each** of two source topics. Native Rust services and the app run on the host. Only Apache Kafka runs in Docker, using the explicitly selected OrbStack context. No host Java, `JAVA_HOME` or `KAFKA_HOME` is required.

Interrupting the dev command stops its owned services and broker while preserving the run's broker volume. A reset is a separate explicit scoped command. See [Kafka lifecycle and ownership](docs/local-kafka.md).

## Commands

| Command | Purpose |
| --- | --- |
| `vp run generate` | Buf descriptor validation and generated TS/catalog sources |
| `vp run check` | Rust clippy and source/emitted integration types |
| `vp run test` | Kafka-free native, real browser WASM/provider, infrastructure and table checks |
| `vp run build` | Fresh native/WASM assets, SDK, UI, table and app packages |
| `vp run dev` | Owned Kafka + native Rust + native web app |
| `vp run seed` | Deterministic private protobuf producer; see command help for run selection |
| `vp run test:e2e` | Finite real 200,000-row-per-topic browser campaign |
| `vp run verify` | Finite composed local acceptance sequence |

Fast checks do not access Kafka or OrbStack. Browser tests still require their pinned Chromium binary and local static asset server. The integration campaign has explicit `--smoke 100` development mode; that mode never qualifies the 200k requirement.

## Boundaries

- `packages/rust-view-server`: shared generic Rust engine, native adapters, typed SDK, Workers and React testing fixture.
- `packages/table`: public Client/Server tables and the Rust adapter; optional Effect numeric integration stays separate.
- `packages/ui`: the table's actual required UI primitives and retained notices.
- `apps/server`: thin native Rust binary; `apps/web`: client-owned provider and simultaneous tables.
- `proto`: illustrative business schemas, authored once; company-specific Decimal plugin input remains independently unavailable.

The Server grid delivers bounded windows and independent facets. The Client grid acquires a bounded chunked snapshot plus ordered live tail, and stays loading until a coherent completion boundary. Its fully materialized data necessarily consumes browser memory.

Source provenance and exclusions are in [provenance](docs/provenance.md). Imported licenses retain their original scope; no new root project license has been selected. No package publication or remote push is configured by this work.
