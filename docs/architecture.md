# Architecture and complete acquisition

The application owns one browser provider after mount. It shares authenticated WebSocket/Worker transport between two independently named source topics. Server grids use sparse subscriptions; Client grids use a separate credit-driven complete acquisition through that same production provider.

The same catalog-driven `generic::Runtime` executes native and generic WASM queries. Kafka persistence, native filesystem and sockets belong to native adapters. Local fixture publication means engine application and observer delivery, never a Kafka durability acknowledgement.

## Complete source protocol

An authenticated acquisition captures an immutable full-source result and its applied source cut on the native service event loop. Queries select the generated catalog's fields, retain authoritative row IDs, and close after capture. Snapshot frames are at most 512 rows and 512 KiB. The retained source is bounded at 250,000 rows and 128 MiB encoded row data; the ordered live tail is bounded at 16 MiB. The service admits two acquisitions globally and one per connection.

The client acknowledges one sequence before receiving the next frame. Bootstrap rows remain hidden until snapshot and a finite tail epoch complete. New commits arriving while an epoch drains belong to the next epoch, so continuous traffic cannot postpone its completion forever. Completion markers identify the applied epoch cut. Partial tail frames retain the preceding delivered cut.

Committed batches coalesce repeated identities, delivering final deletes before upserts to avoid transient row-cap violations. Overflow forces a bounded fresh acquisition. The SDK validates rows against the generated schema, enforces row/byte limits, rejects sequence mismatch, invalidates obsolete acquisition IDs, and uses deadlines and bounded retries. Disposal cancels acquisition and timers. Native source admission, canonical commit-before-publication and readiness remain authoritative.

This design bounds transport frames and retained protocol queues, but snapshot capture currently visits and copies the source synchronously. Large-run startup time and memory must be measured; a small smoke is insufficient evidence.

## Semantic profile

Ordinary table queries explicitly request `effect-4.2.8`. The profile participates in query identity and native/WASM execution. It selects reference Unicode text normalization, UTF-16 ordering and exact numeric aggregation behavior without silently changing legacy native query defaults. The pinned Effect oracle remains separate correctness evidence.
