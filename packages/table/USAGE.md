# BrunoTable integration guide

Install `@bruno/table`, its matching `@bruno/shadcn` package, React and React DOM. Import
`@bruno/shadcn/styles.css` once and process it through Tailwind CSS v4. Register
`@source "./node_modules/@bruno/table/dist";` in your application stylesheet, adjusting the relative
path for that stylesheet's location. See [the package README](./README.md) for CSS and exact numeric
configuration and [release compatibility](./RELEASE.md) for tested versions.

Put React composition and column callbacks in a client module when using a server-component framework.
The React package entry preserves its `"use client"` boundary. Server rendering and hydration use the
same source snapshot and initial preferences; storage is application-owned and must not introduce a
different first client render.

Import `BrunoTableServer` and its server-compatible types from `@bruno/table/server` when an
application uses only the Server variant. The root `@bruno/table` export remains available and keeps
its existing `BrunoTableServer` export for compatibility. The dedicated entry excludes the Client
edit runtime from Server-only consumer bundles.

## Read-only Client, helpers, and presets

```tsx
import {
  BrunoTableClient,
  BrunoTableNumberColumn,
  BrunoTableQuickFilter,
  BrunoTableResultRowCount,
  BrunoTableTextColumn,
  BrunoTableToolbar,
  type BrunoTableColumns,
} from "@bruno/table";

type Product = {
  readonly id: string;
  readonly category: string;
  readonly price: number;
  readonly revision: bigint;
};

const price = BrunoTableNumberColumn.withDefaults({
  headerName: "Price",
  width: 120,
  format: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
});
const columns = [
  BrunoTableTextColumn({
    columnId: "COL_ID_CATEGORY",
    field: "category",
    headerName: "Category",
    groupBy: true,
  }),
  price({ columnId: "COL_ID_PRICE", field: "price", aggFunc: "min" }),
] satisfies BrunoTableColumns<Product>;

export function Products({ rows }: { readonly rows: readonly Product[] }) {
  return (
    <BrunoTableClient
      tableId="TABLE_ID_PRODUCTS"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_CATEGORY", direction: "asc" }]}
      getRowId={(row: Product) => row.id}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      rowSelection
      quickFilterFields={["category"]}
    >
      <BrunoTableToolbar>
        <BrunoTableQuickFilter />
        <BrunoTableResultRowCount />
      </BrunoTableToolbar>
    </BrunoTableClient>
  );
}
```

Supply the complete resident collection, keeping unchanged row objects stable across publications.
Use the source's actual lifecycle and Query Version for live integrations. Loading, stale, closed,
and error presentation comes from that source. Retry appears only when it supplies `retry` with its
own `run` command and `pending` state; BrunoTable never schedules reconnection.

Helpers infer the row from the outer `satisfies` context. Preset defaults override built-in defaults,
and individual options override the preset. Every column has an explicit stable identity and visible
`headerName`; raw Field Columns additionally declare `valueType`. Use native BigInt helpers for
`bigint`, and the optional `@bruno/table/effect` helpers for BigDecimal. Never convert either through
`number`. Formatting changes presentation only, not equality, saves, clipboard exchange, or sorting.

## Filters, sorting, and preferences

Every Table requires non-empty `initialOrderBy` using sortable Column Identities. Users can change
priorities but cannot remove the last sort. `initialFilters` supplies a one-time Grid Filter baseline,
for example `[{ columnId: "COL_ID_PRICE", type: "inRange", filter: 10, filterTo: 20 }]`.
Ranges are half-open, so this includes 10 and excludes 20. An empty Set Filter inclusion matches no
current or future value. Quick Filter uses only its explicit string field tuple and is not persisted.

Pass a previously stored JSON-safe snapshot as `initialPersistedState`, and store each complete
replacement received by `onPersistChange`. Infer the callback type from the Table's column tuple;
no controller, store, or TanStack context is needed. The initial snapshot is read once. Restoration
sanitizes unknown columns and incompatible Value Type codecs; later prop changes do not control user
state. Initial rendering/hydration emits no preference echo. Persisted version 1 contains filters,
normal and grouped sorting, ordered Group By, column order, visibility, committed widths, and pinning.
It excludes source rows, scroll, focus, selection, menus, Quick Filter, and all editing state.

## Grouping, selection, and copy

Read-only Clients and Servers expose Add Group and column-menu commands for `groupBy: true` columns.
The example can group Category and show its minimum Price. Each ordered key tuple produces one flat summary row;
Rows is an exact `bigint` count. Optional `groupRowsColumn` customizes its label, baseline width, and
presentation. Aggregate and Group Key callbacks have their own typed contexts and never receive a
fabricated Product. Normal `orderBy` and grouped `groupOrderBy` remain separate.

Active Group By chips support Remove and `Alt+ArrowLeft/Right` reorder. Group changes reset the logical
Active Cell without moving DOM focus away from the control. The first group clears Row Selection
and its Shift anchor. Grouped views expose no row checkboxes or dormant selection; ungrouping starts
with empty selection.

`rowSelection` enables ordinary Client row checkboxes and Select All. Selection uses source Row
Identities and is transient. Clients also support one contiguous horizontal or vertical Cell Range,
including copy-only ranges over grouped summaries. Copy captures one immutable identity/value
snapshot and writes canonical tab/newline-separated text. Sorting or live changes invalidate a range
when its identity span changes. Server Copy uses only its one loaded Active Cell. There is no
rectangular range, unloaded Server range, Cut, or destructive Clear/Delete capability.

## Editable Client and save/conflict integration

Use a separate Editable Table Instance. Shared columns may declare grouping and editing capability,
but an Editable Client never activates grouping. The application performs one atomic compare-and-set
transaction for the complete Save Change Set and publishes authoritative rows through the live Client
Source. This minimal boundary leaves the transport and storage choice to the application:

```tsx
import {
  BrunoTableClient,
  BrunoTableTextColumn,
  type BrunoTableColumns,
  type BrunoTableSaveChangeSet,
} from "@bruno/table";

type Item = { readonly id: string; readonly name: string; readonly revision: bigint };
const columns = [
  BrunoTableTextColumn({
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    isEditable: true,
  }),
] satisfies BrunoTableColumns<Item>;

export function EditableItems({
  rows,
  compareAndSet,
}: {
  readonly rows: readonly Item[];
  readonly compareAndSet: (
    changes: BrunoTableSaveChangeSet<Item, typeof columns, bigint>,
  ) => Promise<void>;
}) {
  return (
    <BrunoTableClient
      tableId="TABLE_ID_EDITABLE_ITEMS"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      getRowId={(row: Item) => row.id}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      editable
      getRowVersion={(row: Item) => row.revision}
      onSaveEdits={compareAndSet}
    />
  );
}
```

Each non-empty row change contains `rowId`, a safely rebased `baseRow`, exact `expectedVersion`, and
non-empty `changes` preserving each cell's `columnId`, `field`, `before`, and `after`. Compare every
expected Row Version atomically and reject the entire operation with a safe ordinary `Error` on
failure. Never use the source's top-level Query Version or an unconditional View Server `patch`.
Resolve with `void`, never canonical rows. Later source publications are the only canonical authority.
For row-aware editable formatters, class callbacks, or renderers, also supply `projectEditRow` that
returns an authentic immutable row with the exact sparse patch and unchanged identity.

The user owns Immediate/Batch mode through BrunoTable's toggle. Immediate mode submits each gesture
and allows disjoint-cell operations. Batch accumulates net changes and globally locks edit mutations
while a submitted save reconciles. Its persistent footer opens complete live reviews on demand.
Edited-field divergence enters Conflict Review before save; Mine/Server choices apply to individual
or explicitly selected conflicts. A fresh Save rechecks all current values and versions. Resolution
creates Accepted Overlays until live convergence, a different Row Version, or authoritative removal;
there is no timeout or automatic save retry. Rejection preserves unconverged Batch drafts/history;
Immediate rejection restores unconverged operation-owned cells. Complete later live convergence
supersedes an ambiguous failure.

Paste and repetition-only Drag Fill are atomic one-axis gestures. Only a single source cell
broadcasts; other shape mismatches require explicit confirmation. Batch undo/redo records one gesture
at a time. Live convergence removes that cell's draft and history evidence. Mode switches cannot
discard outstanding edits, conflicts, operations, or redo work.

## Sparse Server

Create a typed Viewport Source with `effect-view-server@4.2.8` in the application's source module.
Pass its returned source directly, using the same column pattern:

```tsx
<BrunoTableServer
  tableId="TABLE_ID_LIVE_PRODUCTS"
  columns={columns}
  initialOrderBy={[{ columnId: "COL_ID_CATEGORY", direction: "asc" }]}
  viewportSource={source}
  externalFilters={[{ field: "price", type: "inRange", filter: 10, filterTo: 20 }]}
/>
```

Here `source` is the actual typed source returned by the application's View Server hook, not a row
array or a cast. For leased feeds pass its exact Feed Route as `routeBy` as well. Import
`BrunoTableServer` from `@bruno/table`; do not duplicate source schemas or expose source implementation
types through a table wrapper. Both raw and grouped identities are supplied authoritatively by the
source; Server rejects `getRowId`, editing, and row/range selection.

The Server owns filtering, sorting, grouping, aggregation, and complete-domain facets. A semantic
query change invalidates the old generation and shows fixed-height loading rows. Window movement
retains same-generation overlap. Both variants use one continuous virtual row space with one native
two-axis scroll owner, fixed-height rows, and pinned-column suspension when there is insufficient
room. There are no pages or pagination controls.
