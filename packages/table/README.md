# `@bruno/table`

The React data-grid package for BrunoTable.

Start with the [integration guide](https://github.com/bmvantunes/shadcn-table/blob/main/packages/table/USAGE.md)
for Client, Server, editing, grouping, and copy examples. See the
[release and migration guide](https://github.com/bmvantunes/shadcn-table/blob/main/packages/table/RELEASE.md)
for compatibility, exclusions, and the non-publishing release procedure. Both guides ship in the package.

The public interface is intentionally small and BrunoTable-owned. TanStack Table, virtualization,
stores, and server-query translation are private implementation details.

The package establishes strict TypeScript contracts for columns, client sources, server viewport
sources, filters, sorts, and the `BrunoTableClient` and `BrunoTableServer` composition roots.

## Agent skills

This package ships version-matched BrunoTable guidance for coding agents. In a pnpm consumer
workspace, run `pnpm dlx @tanstack/intent@latest install`, then use
`pnpm dlx @tanstack/intent@latest list` to discover the installed skills and
`pnpm dlx @tanstack/intent@latest load @bruno/table#<skill>` to load only the concern needed for the
current task. Use the equivalent one-shot command from another workspace's declared package manager
rather than invoking npm inside a pnpm-enforced workspace. Configure an explicit `package.json`
`intent.skills` package allowlist and `intent.exclude` entries for skills the project must not
surface.

Intent's optional editor hooks improve discovery and remind an agent to load matching guidance, but
they are not a trust boundary. Safe discovery reads installed package metadata and skill files
without importing package exports or running dependency scripts, exports, hooks, or lifecycle code.
Repository validation, source acknowledgements, the package allowlist, explicit exclusions, and the
published-tarball assertion remain authoritative even when no editor hook is installed.
Every authoritative document named by a shipped skill is also included byte-for-byte under
`skills/references/`; source validation rejects a missing or divergent packaged reference before
publication.

Use one plain column array with `satisfies`. Optional helpers supply coherent exact value semantics
and presentation defaults without generating identity or hiding the resulting column definition:

```tsx
import {
  BrunoTableBigIntColumn,
  BrunoTableNumberColumn,
  BrunoTableSelectColumn,
  BrunoTableTextColumn,
  type BrunoTableColumns,
} from "@bruno/table";

type Order = {
  readonly symbol: string;
  readonly price: number;
  readonly quantity: bigint;
  readonly status: "open" | "closed";
};

const priceColumn = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  width: 112,
  format: { minimumFractionDigits: 2 },
});

const columns = [
  BrunoTableTextColumn({
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
  }),
  priceColumn({
    columnId: "COL_ID_PRICE",
    field: "price",
    width: 144,
  }),
  BrunoTableBigIntColumn({
    columnId: "COL_ID_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
  }),
  BrunoTableSelectColumn({
    columnId: "COL_ID_STATUS",
    field: "status",
    headerName: "Status",
    options: ["open", "closed"],
  }),
] satisfies BrunoTableColumns<Order>;
```

Helper precedence is built-in defaults, reusable preset defaults, then individual column options.
Display callbacks such as `valueFormatter`, `cellClassName`, and `cellRenderer` do not change exact
equality, sorting, clipboard text, parsing, persistence, or conflict comparison. Custom exact domains
use an explicit `BrunoTableValueType` with paired canonical text and persistence codecs.

Effect BigDecimal support is isolated behind the optional entry point. Applications that use it
install the compatible Effect peer and import only that subpath:

```tsx
import * as BigDecimal from "effect/BigDecimal";
import { BrunoTableBigDecimalColumn, BrunoTableBigDecimalValueType } from "@bruno/table/effect";
import type { BrunoTableColumns } from "@bruno/table";

type PriceRow = { readonly price: BigDecimal.BigDecimal };

const columns = [
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    aggFunc: "sum",
    aggregateValueFormatter: ({ value }) => BigDecimal.format(value),
  }),
] satisfies BrunoTableColumns<PriceRow>;

void BrunoTableBigDecimalValueType;
```

The BigDecimal Value Type keeps canonical text, persisted operands, equality, and ordering exact. It
accepts only effect-view-server-compatible wire-safe values, treats differently scaled
representations as equal, and never compares by aligning scales through a power of ten. Importing
`@bruno/table` does not import or require Effect; `effect@4.0.0-rc.111` is an optional peer used
only by `@bruno/table/effect`. This optional value-type entry point is built against the separate
public, versioned `effect-view-server@4.2.4/value-semantics` compatibility contract; the Server
viewport integration described below requires 4.2.8. Admitted cross-bundle wire values are copied
into owned local BigDecimals and receive opaque source-owned comparison metadata before BrunoTable
exposes the full Effect value type. That focused runtime is inlined into `@bruno/table/effect`;
applications do not install effect-view-server merely to use BigDecimal columns. BigDecimal columns
support `countDistinct`, `sum`, `min`, `max`, and
`avg`; aggregate callbacks receive the exact result (`bigint` for `countDistinct`, BigDecimal for
the others), owning Column Identity, aggregate function, and row count, but never sibling Group Key
evidence or a fabricated raw source row.
`sum` and `avg` are intentionally unavailable for optional or nullable fields because the View
Server rejects those aggregate domains; `min` and `max` preserve the field's nullish result type.
Canonical and persisted BigDecimal text is rejected above 4,096 UTF-16 code units before parsing,
which bounds synchronous coefficient work on browser input paths.

Raw field definitions remain fully supported for grouping and aggregation. A raw custom Value Type
must structurally declare the selected function in `aggregateResults`; unsupported pairs fail both
TypeScript and runtime normalization. BrunoTable's optional typed Column Helpers provide the same
ordinary definitions with contextual callback inference and reusable defaults.

Both `BrunoTableClient` and `BrunoTableServer` use the private column compiler when constructing
or replacing their column definition array. Each root memoizes the frozen, trusted Field-or-Computed
representation by array identity and rejects malformed widened input. Consumers do not install a
compiler or use a separate grid-definition API.

Both renderers use one continuous virtual row space, one native scroll owner, and no pagination
state or controls. `BrunoTableServer` writes authoritative View Server row keys and payloads into
sparse absolute slots, keeps window movement inside a semantic query generation, and replaces that
generation only for route, projection, filter, sort, grouping, or aggregate changes. An open Server
Set Filter uses the same source's independent whole-result hook and never facets sparse loaded slots.
Consumers pass the typed result of a
compatible Viewport Source directly; they never provide `getRowId` or observe Effect, TanStack, or
viewport-controller types through BrunoTable's public declarations.

The Server integration requires `effect-view-server@4.2.8` at the application's source
boundary. It contains the insertion-cleanup guarantee from issue #408, source-native Match None
from issue #409, and the declaration-bundle-safe invariant base-row witness completed by issue 465,
issue 469, and issue 471. Issue 473 adds the source-owned complete raw projection used whenever a
formatter, functional class, or renderer lawfully reads the complete row. BrunoTable maps empty Set
inclusion intent to the source's `{ type: "FALSE" }` expression and does not emulate it by enumerating
current facet values. Issue 477 adds the topic-bound whole-result hook that keeps an open live facet
independent from the primary viewport generation. Issue 479 exposes exact Route and Where witnesses,
and issue 481 exposes the exact source-owned raw/grouped `semanticKey` and `replace` authority through
the dependency-free viewport witness subpath.

The Client root accepts optional children for page-specific toolbar composition; absent children do
not reserve vertical space.

## Grid Preferences

`initialPersistedState` accepts one version-1, JSON-safe replacement snapshot when a Table Instance
is constructed. BrunoTable deterministically sanitizes it against the current `tableId`, compiled
Column Definitions, operator capabilities, and Value Type codec identities before the first server
or client render. Valid restored filters, sorting, and layout win over their initial baselines;
changing the prop later does not control the runtime. Filter and sorting Reset commands still return
to `initialFilters` and the mandatory non-empty `initialOrderBy`, while Clear removes Grid Filters.

`onPersistChange` synchronously receives one complete replacement snapshot after a committed Grid
Filter, sorting, ordered Group By, grouped sorting, column-order, visibility, width, or pinning change.
Restoration, hydration, source publications, Quick Filter, focus, selection, scrolling, and other
transient activity do not emit.
The callback may be replaced without recreating the Grid Runtime; its return value and failures do
not roll back committed grid state or escape Grid command dispatch. Applications own storage,
transport, retry, authorization, error reporting, and publication ordering—BrunoTable does not
access Local Storage or any persistence backend. `columnWidths` contains only explicit committed
user width overrides, so definition-provided defaults remain free to evolve between releases.

Persisted value operands carry the owning column's `codecId` and `codecVersion` and contain only
that compiled Value Type's JSON-safe `encodePersisted` output. Text-search operators persist their
bounded search operand directly as a string because it is search intent rather than a column value;
codec identity and version are still checked for compatibility. Restoration calls the matching
`decodePersisted` implementation for value operands and drops stale, malformed, unknown, or
incompatible evidence. A restored search operand that normalizes to empty text under its own case
and accent sensitivity is also dropped because compiled admission rejects search intent that would
degenerate to Match All or Match None depending on the operator.
Native `bigint` and Effect BigDecimal objects therefore never appear directly in the snapshot.
If a custom `encodePersisted` implementation returns a value that is not JSON-safe, the committing
preference command throws a `TypeError`; column compilation does not pre-execute value codecs.
An unreadable or malformed persisted `filters` slice preserves `initialFilters`, while a readable
slice containing only stale or incompatible leaves validly restores no active Grid Filters.
Read-only Client and Server Tables restore ordered Group By and grouped sorting against their
current column capabilities. Editable Client Tables install no grouping and conservatively discard
Group By, grouped sorting, and Rows System Column width during restoration.

## Application styles

Import the canonical shadcn stylesheet once from an application CSS entry point, include the
installed table bundle as a Tailwind source, and enable the Tailwind Vite plugin in the application
build:

```css
@import "@bruno/shadcn/styles.css";

@source "../node_modules/@bruno/table/dist";
```

```ts
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [tailwindcss()] });
```

The stylesheet owns BrunoTable's shared design tokens, while the explicit source directive emits
the utilities used by BrunoTable's renderer. The table package does not inject global CSS at
runtime.
