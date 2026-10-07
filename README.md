# Rust View Server and BrunoTable

Private local workspace joining the proto-first Rust view engine with `BrunoTableClient` and `BrunoTableServer` in one TanStack Start app. The [cleanup and package split](docs/cleanup-split.md) records current verification; the [original qualification report](docs/qualification.md) retains the earlier campaign and measured limits.

## Start here

Install the pinned Node runtime and dependencies through Vite+, and Rust 1.99.0 with `wasm32-unknown-unknown`. The root `.node-version`, Rust toolchain and lockfiles are authoritative. From this directory:

```sh
vp install --frozen-lockfile
PLAYWRIGHT_SKIP_BROWSER_GC=1 vp exec playwright install chromium
vp run generate
vp run build
vp run test
vp run dev
```

The development app opens at http://127.0.0.1:3000. The default seed is 200,000 distinct identities in **each** of two source topics. Native Rust services and the app run on the host. Only Apache Kafka runs in Docker, using the explicitly selected OrbStack context. No host Java, `JAVA_HOME` or `KAFKA_HOME` is required.

A long native-service restart can exceed the bounded browser reconnect policy. Once native recovery is ready, use **Reconnect and reacquire**; the full campaign qualified that explicit retry path.

Interrupting the dev command stops its owned services and broker while preserving the run's broker volume. A reset is a separate explicit scoped command. See [Kafka lifecycle and ownership](docs/local-kafka.md).

## Commands

| Command | Purpose |
| --- | --- |
| `vp run css:sources` | Refresh dependency-derived Tailwind source blocks |
| `vp run check:css-sources` | Read-only CSS source drift check (also runs in CI) |
| `vp run generate` | Buf descriptor validation and generated TS/catalog sources |
| `vp run check` | Rust clippy and source/emitted integration types |
| `vp run test` | Kafka-free native, real browser WASM/provider, infrastructure and table checks |
| `vp run build` | Fresh native/WASM assets, SDK, UI, table and app packages |
| `vp run dev` | Owned Kafka + native Rust + native web app |
| `vp run seed` | Deterministic private protobuf producer; see command help for run selection |
| `vp run test:packaged` | Isolated installed SDK/Worker/WASM and table/Compiler consumer checks |
| `vp run test:e2e` | Finite real 200,000-row-per-topic browser campaign |
| `vp run verify` | Finite composed local acceptance sequence |

Fast checks do not access Kafka or OrbStack. Browser tests still require their pinned Chromium binary and local static asset server. The integration campaign has explicit `--smoke 100` development mode; that mode never qualifies the 200k requirement.

## Boundaries

- `packages/rust-view-server`: Rust core/runtime/admission/wire/WASM crates, native tests and a private VP task adapter.
- `packages/view-server-client` (`@bruno/view-server-client`): SDK, Provider/hooks, Workers, protocol validation, generated TypeScript and isolated browser fixtures.
- `packages/table`: public Client/Server tables and the Rust adapter; genuine Effect BigDecimal values and exact conversions are preserved.
- `packages/ui`: the table's actual required UI primitives and retained notices.
- `apps/server`: thin native Rust binary; `apps/web`: client-owned provider and simultaneous tables.
- `proto`: illustrative business schemas, authored once; company-specific Decimal plugin input remains independently unavailable.

The Server grid delivers bounded windows and independent facets. The Client grid acquires a bounded chunked snapshot plus ordered live tail, and stays loading until a coherent completion boundary. Its fully materialized data necessarily consumes browser memory.

Source provenance and exclusions are in [provenance](docs/provenance.md). Imported licenses retain their original scope; no new root project license has been selected. Package publication is not configured. The cleanup/split was merged through PR #2.

Tailwind source registration is maintained by the [workspace source tool](tools/tailwind-sources/README.md), including transitive UI dependencies and a GitHub Actions drift check.
