# Local Kafka through OrbStack

Only Kafka runs in a container. Rust services, Node/Vite+, the TanStack application and browser tests run natively. Fast Rust/WASM/provider/table tests neither invoke Docker nor require a broker. No host Java, `JAVA_HOME` or `KAFKA_HOME` is used.

The [official JVM image](https://kafka.apache.org/41/getting-started/docker/) is pinned to Apache Kafka **4.1.2** and an immutable multi-platform index digest in `infra/kafka/compose.yaml`. `image-lock.json` records the resolved index plus arm64 and amd64 manifests. The CLI always uses the explicit `orbstack` context and never changes the default context or socket permissions. On denied engine access, request normal scoped approval. If OrbStack is unavailable, capture the failing command/output and continue the independent fast suite.

Initialize once per run and keep the same run for service/recovery tests:

```sh
vp exec node scripts/kafka.ts preflight
vp exec node scripts/kafka.ts init --run dev --port 19092
vp exec node scripts/kafka.ts up --run dev
vp exec node scripts/kafka.ts env --run dev
vp exec node scripts/kafka.ts describe --run dev
vp exec node scripts/kafka.ts container-check --run dev
vp exec node scripts/kafka.ts persistence-check --run dev
```

Run the native probe with `vp run kafka:probe`, or select another owned run endpoint with `vp exec node scripts/rust.ts run -p product-source-ingestion --features kafka-canonical --example orbstack_probe -- 127.0.0.1:PORT`. The repository selector also pins Cargo subcommands to Rust1.99.0. It verifies advertised metadata, both topic partitions, committed transactions, aborted transactions and both consumer isolation modes. `container-check` verifies metadata and actual production/consumption using `kafka:9092` inside the container. `persistence-check` verifies a freshly produced sentinel survives scoped down/up container recreation with the same data volume. Run it only while that run is not serving other work. A passing healthcheck alone is not integration qualification. These are small infrastructure probes, separate from the **two source topics with 200,000 distinct live rows each** acceptance campaign.

`init` creates a checkout ownership token and run state under ignored `.local/kafka/`. It refuses an existing run name. Each run has a unique Compose project, network, named volume and KRaft cluster ID. Host client access is published only on `127.0.0.1`; the controller/internal listener ports are not published. Native clients receive loopback metadata; container clients receive `kafka:9092`. Explicit single-broker internal-topic replication and minimum ISR allow transactions. The broker has a 1 GiB maximum Java heap and 2 GiB container memory cap; record actual memory and any resource failure during the full campaign.

Use a new run name and a free port for each fresh acceptance campaign. Run-scoped broker ownership permits canonical source topic names `client_orders` and `server_orders`, each explicitly created with at least two partitions. Do not silently use existing historical data. Record effective topic/broker settings, producer receipts and the source cuts with the final evidence.

```sh
# Retains data and cluster identity across broker/service recovery tests:
vp exec node scripts/kafka.ts restart --run dev
# Stops owned resources, preserving the persistent data volume:
vp exec node scripts/kafka.ts down --run dev
# Starts the same data again:
vp exec node scripts/kafka.ts up --run dev
# Explicit destructive reset of this run only:
vp exec node scripts/kafka.ts reset --run dev --confirm-run dev
```

Resource ownership labels are checked before operations, including before data deletion. No global prune or unrelated cleanup is performed. A volume remains after ordinary shutdown, and reset removes the run state so the next initialization chooses a fresh cluster ID. Stop owned processes after qualification. The root VP dev/e2e entrypoints must call this lifecycle wrapper; Kafka lifecycle, seed and live acceptance tasks must remain uncached.

Lifecycle ownership and data-preservation checks run without Docker using `vp exec node --test scripts/test_kafka_lifecycle.ts`.

## Native dev and seeding

`vp exec node scripts/dev.ts` builds with the repository Rust selector, starts its scoped broker, creates two compact source topics and two compact state topics, starts the native service on `127.0.0.1:3010` (health on `3011`) and the native web application on `http://127.0.0.1:3000`, then seeds 200,000 distinct identities **per source topic** on first use. `--run NAME --kafka-port PORT` selects an isolated broker run. `--rows 100` is an explicit small development smoke, never the final acceptance gate. `--no-web`, `--no-seed` and `--no-build` permit separately controlled qualification. The run lock prevents concurrent orchestrators from stopping a peer's broker.

`vp exec node scripts/seed.ts --run NAME --campaign` requires the full200k per topic and sends an authenticated request to that running dev session's single journalled control authority. It never starts a competing writer. The authority uses one persistent native producer for both sources, accepts bounded batches of at most1,000 records, admits original rows and encoded keys/values against generated schemas, and publishes receipts only after each Kafka transaction commits. Both authority and native producer hold scoped ownership locks; writes fail closed if journal outcome is uncertain. `--start`, `--rows` and `--revision` support bounded updates with stable identities. A repeated seed upserts those identities; it does not establish a fresh baseline. Use a new run for final acceptance.

The seed uses the same logical IDs in both topics with distinct numeric/text values, 2,048 exact customer facet values, Unicode, exact large uint64/decimal strings, boolean values and omitted/null/empty notes. Configurations refer to the generated Orders and SimpleKey descriptors; no business schema is duplicated. Each source admits at most 250,000 live rows (200k baseline plus 50k headroom), with one current value per key and no time-based application expiry. Source/state topics use explicit compaction and unlimited Kafka time retention. Existing transport frame/queue limits are preserved; Client acquisition must satisfy its own bounded-delivery contract before full application acceptance.

Logs, immutable run configuration, the local session token and per-record receipts live under `.local/runs/<run>/<cluster-id>/`. Tokens are private local development credentials, excluded from Git. A broker reset creates a new cluster ID and preserves prior run evidence. Seed summaries record acknowledged distinct identities and per-partition source-next cuts, and explicitly do **not** claim browser completeness or service catch-up. The development orchestrator terminates only its own child process groups and stops its owned broker while preserving the volume.

Opt-in inherited socket regressions now use the owned run wrapper with `RVS_KAFKA_RUN`, `RVS_SERVICE_BINARY` and `RVS_KAFKA_PROBE_BINARY` pointing to this checkout's freshly built service and `kafka_probe` example. They are ignored in the fast suite; they no longer launch host Java or refer to historical runtime paths. Kafka-free seed checks run with `vp exec node --test scripts/test_demo_seed.ts`.
