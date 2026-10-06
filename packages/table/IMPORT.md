# Table import provenance

The executable table and its regression fixtures come from shadcn-table commit
`341c82dd2e5498a801e71fc4e1b62e5e0d57106d`. The source checkout was a fresh,
clean temporary clone. The existing dirty checkout was never modified or copied.
The upstream MIT license and third-party notices are retained unchanged.

`../ui` keeps the 18 UI primitives referenced by this table plus their exact
utility/style dependencies. It preserves the `@bruno/shadcn` direct subpath API.
Unused chart/calendar/carousel/OTP/layout components and unrelated application,
research archives, skill reference duplication, generated output and caches are excluded.

`src/rust` and `tests/rust` import the reviewed local Rust integration commit
`be2d8f400e9b5ba6e632e541007d20e3e99df465`; imports now use the public SDK
subpaths. The table depends on the SDK, which does not depend on the grid.
Every adapter query now explicitly selects `effect-4.2.8`; native SDK queries keep
native semantics unless selected. The profile provides NFD/case/accent text matching,
UTF-16 string ordering, missing/null ordering and aggregates, exact Number sums and
100-significant-digit averages. Nullable numeric sum/avg queries stay rejected as
in the pinned oracle. Optional nonnullable numeric fields are supported. The complete
Client-source adapter converts catalog wire scalars once per immutable row object.
Viewport requests remain capped at 1,024 rows; whole facet results are capped at 4,096
and reject truncated results rather than showing an incomplete facet list.

Compiler numerical equivalence, emitted-output and browser callback regressions
are adapted from Astryx reference `851f4afee86fdca15bbb28e0a0fe4dab127084ae`.
No Astryx UI/runtime is imported. StyleX-specific assertions are omitted because
this table uses its actual Tailwind styles. Tests retain independent native-JS
expectations, exception types, exact keys, state and callback behavior.

## Compiler qualification

The active pipeline uses the shared `reactCompiler()` factory, Babel core 7.29.7,
and React Compiler 1.0.0 with the narrowly scoped BigInt lowering patch from the
pinned Astryx source. Strict inference and fatal compiler errors stay enabled.
Oxc 0.153.0 silently converted tested BigInt literals into `undefined`; Babel 8
also failed the full table build on standard destructured defaults, so neither
is used. Both failures are recorded in the repository qualification evidence.
Source callbacks were refactored into equivalent explicit branches where the
compiler rejects optional/conditional expressions inside try blocks. No extra
compiler opt-out was introduced.

`test` is Kafka-free. `test:types:source`, `test:types:emitted` and
`test:types:rust` cover source and emitted public contracts using native TypeScript7.
`check:build` verifies artifact, dependency and runtime boundaries.
`test:release:package` checks local private archive content without publishing.
`test:packed` separately performs isolated packed-consumer installation,
compiler negative control, SSR and browser hydration on the pinned current stack.
