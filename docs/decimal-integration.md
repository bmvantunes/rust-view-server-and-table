# Effect BigDecimal integration clarification

Inspected local HEAD: `202833c9211cae9f9720c46a6ddff4f1dffc7594`. This clarification also checks the current cleanup working tree. The package split changes SDK imports from `@bruno/rust-view-server` to `@bruno/view-server-client`; it does not replace decimal arithmetic or the TypeScript BigDecimal integration. `packages/table/src/effect.ts` is unchanged from that commit. The changes in `src/rust/translate.ts` and `src/rust/types.ts` only rename SDK imports.

The installed and project-pinned Effect version is **`4.0.0-rc.111`**. `effect/BigDecimal` resolves to `node_modules/.pnpm/effect@4.0.0-rc.111/node_modules/effect/dist/BigDecimal.js`. The table and web application pin that version. TypeScript resolves to **7.0.2**.

## Actual paths and representations

| Boundary | Actual implementation | Representation |
|---|---|---|
| SDK/wire | `packages/view-server-client/src/topic-schema.ts`, `decimal` / `validateScalar` | Canonical validated decimal strings, retaining exact precision; these are not Effect objects |
| Native/shared WASM arithmetic | `packages/rust-view-server/crates/core/src/product.rs` (`ExactDecimal`) and `grouped.rs` (BigInt accumulator) | Exact native Rust arithmetic; this does not replace the TypeScript consumer's Effect values |
| Client table rows | `packages/table/src/rust/index.ts` calls `decodeCompleteRows` in `translate.ts`; its `converted` function imports `effect/BigDecimal` | Actual `BigDecimal.fromStringUnsafe` → `BigDecimal.normalize` objects, then frozen |
| Server table rows | `packages/table/src/rust/controller.ts` calls `decodeRows` before `sink.setRowData` | The same real Effect constructors for decimal fields and aggregate decimal results |
| Client columns and operands | `apps/web/src/editing.tsx` imports `BrunoTableBigDecimalColumn` from `@bruno/table/effect`; `packages/table/src/effect.ts` directly imports `effect/BigDecimal` | Genuine Effect values admitted by the table value type, with owned values constructed using `BigDecimal.make`; exact comparison, filters and editing |
| Server columns and operands | `apps/web/src/demonstration.tsx` uses that same column helper; `translate.ts` `value`/`compile` requires `BigDecimal.isBigDecimal` for decimal predicates | Decimal wire strings, ordinary coefficient/scale objects and Numbers are rejected as TypeScript-side decimal operands |
| Outgoing edits and predicates | `translate.ts` `encodeCompatRow`, `value`, `plainDecimal`, `decimalParts` | Plain canonical text constructed from bigint coefficient and integer scale, without converting the decimal value through `Number` |

`apps/web/src/demonstration.tsx` supplies `hooks.useCompleteSource` to `BrunoTableClient` and the decoded viewport source to `BrunoTableServer`. Both illustrative tables therefore use the Effect integration. The generic `admitted<T>` row assertion follows schema validation and real scalar conversion; it does not manufacture a BigDecimal object by assertion. The value-type cache assertion in `effect.ts` only returns values previously constructed and recorded by the codec.

## Result domains

For decimal columns, Client local grouping calls real `BigDecimal.sum` and `BigDecimal.divideUnsafe` via `bigDecimalAggregateAlgebra` in `packages/table/src/effect.ts`. Both sum and average return Effect BigDecimal.

For Server results under the explicit `effect-4.2.8` compatibility profile, `decodeRows` reconstructs aggregate decimal strings with real Effect constructors. `packages/table/src/rust/types.ts` preserves these public result domains:

| Aggregate input | Sum | Average |
|---|---|---|
| Decimal | Effect BigDecimal | Effect BigDecimal |
| Number, Server compatibility profile | Effect BigDecimal | Effect BigDecimal |
| int64/uint64, Server compatibility profile | bigint | Effect BigDecimal |

The independently pinned Effect oracle remains `effect-view-server@4.2.8`. No Rust arithmetic or Effect precision behavior was changed for this clarification.

## Focused verification actually run

- `vp test run src/effect.test.ts tests/rust/adapter.test.ts tests/rust/profile.test.ts tests/rust/effect-oracle.test.ts` in `packages/table`: **44 tests passed in four files**. This covers real Client grouped sum/average, codec admission, adapter conversions, exact operands and the independent pinned oracle.
- Source and emitted Rust-adapter inference: `vp exec tsc -p packages/table/tests/rust/tsconfig.json` and `vp exec tsc -p packages/table/tests/rust/tsconfig.emitted.json`: **passed with TypeScript 7.0.2**.
- Supplemental emitted-runtime check (`.local/decimal-clarification-check.ts`): **eight values passed both `BigDecimal.isBigDecimal` and actual Effect prototype identity**—Client raw value, Server raw value, Client sum/average, Server sum/average, runtime codec result and persisted codec result. It also rejected three non-Effect operands.
- Exact round-trip verified: `9007199254740993.123456789012345678`, with bigint coefficient `9007199254740993123456789012345678n` and scale `18`. Client write encoding and Server predicate encoding return the original exact plain string. Client and Server sum/average values agree without Number coercion.
- Supplemental public emitted inference (`.local/decimal-inference.ts`) explicitly checks Decimal sums/averages, bigint integer sums, BigDecimal integer averages and compile-time rejection of string/Number decimal operands: **passed**.

Logs are `/tmp/decimal-focused-tests.log` and `/tmp/decimal-emitted-values.log`. Supplemental scripts are ignored verification artifacts, not new product code. The supplemental Server check supplies wire aggregate results to the real decoder; it does not claim to execute a fresh Kafka/native aggregation campaign. No 400k-row campaign was run for this clarification.

## Precise remaining company mapping

Only the source-decoder mapping from the company's specific protobuf Decimal definition, custom options and Buf-generated representation into this repository's source schema/catalog remains unspecified. The illustrative `proto/topics.proto` already declares `price` as a string with `(view.decimal) = true`; `scripts/generate-proto-topics.ts` maps that annotation to the SDK decimal domain. The generic Rust decoder, exact wire representation, real Effect objects and illustrative tables do not depend on unavailable company artifacts.

**Handoff: Effect BigDecimal integration is implemented and verified; company-specific source decoder mapping remains pending.** No additional company input is requested here, and no decimal repair is necessary.
