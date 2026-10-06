# Release compatibility and migration

This is preparation for the first complete public package. Both packages retain the explicitly
chosen `0.0.0` version for this non-publishing dry run; it is not an announced stable release.
Preparation creates local tarballs only.

Both packages ship the owner-confirmed MIT license, Copyright (c) 2026 Bruno Antunes. The table's
bundled View Server code uses the same owner-confirmed license and is recorded in its third-party
notice. The shadcn package separately preserves the upstream MIT notice, Copyright (c) 2023 shadcn.

## Supported and validated environment

| Boundary                     | Package contract                                                                                     | Release validation baseline                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| React and React DOM          | `^19.2.8`, matching versions                                                                         | 19.2.8                                                                                     |
| TypeScript                   | Strict TypeScript with modern ESM resolution                                                         | 7.0.2, `strict`, `exactOptionalPropertyTypes`, declarations checked without `skipLibCheck` |
| Node SSR and release tooling | Modern Node ESM                                                                                      | 24.20.0                                                                                    |
| Browser                      | Desktop browser with native BigInt, ResizeObserver, Pointer Events, Clipboard API, and inert support | Playwright 1.60.0 Chromium; repository accessibility/keyboard and production workloads     |
| Styles                       | `@bruno/shadcn` and Tailwind CSS v4                                                                  | Tailwind 4.3.3, Vite+ 0.2.8                                                                |
| React Compiler               | React 19 target, fatal bailout policy                                                                | `@vitejs/plugin-react` 6.1.0 and `oxc-transform-react` 0.145.0                             |
| Optional BigDecimal          | `effect@4.0.0-rc.111` through `@bruno/table/effect`                                                  | Exact prerelease pin; root works without Effect installed                                  |
| Application Viewport Source  | Compatible `effect-view-server` source contract, floor 4.2.8                                         | 4.2.8, source-owned route/where/identity/generation witnesses                              |

The validated baseline is evidence for these exact versions, not a claim that every browser,
framework, or version permitted by a peer range was separately tested. React 18, CommonJS `require`,
older TypeScript compilers, alternate SSR runtimes, and mobile/touch interaction are outside this
release's validated matrix. A preserved `"use client"` boundary enables server-component packaging;
it is not a claim of a separately validated Next.js application.

Install Effect only for BigDecimal or an application source that needs it. The root runtime and its
declaration closure do not require Effect or View Server. The optional entry inlines View Server's
audited value-semantics implementation; the application Server source is installed separately.
The exact Effect prerelease pin is retained until broader compatibility is demonstrated with the
same immutable exact-value and installed-consumer checks. Never interpret that pin as a stable
Effect v4 compatibility range.

`@bruno/shadcn` has direct component subpaths and no root export. Its complete component distribution
currently installs dependencies for components the grid may not use, including charts, carousel,
calendar, and the shadcn CLI/CSS resources. Direct imports and tree shaking avoid putting those
unreferenced component modules into the table's JavaScript bundle; they do not reduce installation
size. Splitting that package is outside this release. CSS is explicitly side-effectful; table
JavaScript has no required module-evaluation side effects.

## Public contracts

The public runtime surface is the BrunoTable-branded root API, the Server-only `@bruno/table/server`
entry, and the optional branded Effect subpath. The Server subpath shares public column, filter,
grouping, and toolbar primitives while excluding Client edit runtime from Server-only bundles. The
root entry continues to export `BrunoTableServer` for compatibility. Package metadata is available
at `@bruno/table/package.json`. Private Grid Runtime,
geometry, stores, XState actors, TanStack instances, View Server translation, and internal React
components are not public entry points. Deep imports into `dist` or `src` are unsupported and blocked
by the exports map.

The complete V1 capability set is described in [the integration guide](./USAGE.md) and the
[README](./README.md): read-only and editable Clients, sparse read-only Server, typed helpers and
presets, exact numeric semantics, filters, always-on sorting, preference persistence, grouping,
selection/copy, keyboard navigation, and save/conflict workflows. Shipped Agent Skills carry their
own skill versions and match the library version; all cited authoritative documents ship with them.

Exclude prototypes and research code from compatibility promises. V1 has no pagination, expandable
group hierarchy, variable-height Server fast path, editable Server, grouped editing, Server row/range
selection, rectangular Client ranges, destructive Clear/Delete, arithmetic Drag Fill, or public grid
controller. The two private Server facet Compiler escape hatches remain tracked by
[issue #96](https://github.com/bmvantunes/shadcn-table/issues/96); this release does not close it.

## Migrating repository prototypes

No earlier stable package migration is implied. Consumers of pre-release repository code should:

1. Replace private/path imports with direct public package exports. Keep page controls as toolbar
   children and remove controller, TanStack, actor, or store coupling.
2. Give every Table a stable `tableId` and every leaf column explicit `columnId` and `headerName`.
   Supply `valueType` for raw value-bearing columns or use the global typed helpers. Keep the single
   plain array checked with `satisfies BrunoTableColumns<TRow>`.
3. Supply mandatory non-empty `initialOrderBy`; remove unsorted and pagination state. Use Client
   `getRowId` only for raw source records. Remove Server identity callbacks and consume its
   source-authoritative row keys.
4. Store only version-1 preference snapshots. Do not convert old unknown layouts or exact operands
   by guessing. Restore through BrunoTable's sanitizer; migrate custom codecs with explicit new
   codec versions and discard incompatible stored operands conservatively.
5. Replace save-returned rows with a transactional `PromiseLike<void>` operation and live canonical
   source publications. Require exact Row Versions and compare-and-set. Add `projectEditRow` for
   row-aware editable presentation. Let the user own Edit Mode and conflict choices.
6. Separate read-only grouped Instances from Editable Instances. Expect grouping to clear row
   selection, range gestures, and the previous logical Active Cell.
7. Import/process the package stylesheet and register the installed table distribution with Tailwind.
   Use the same initial source/preferences during SSR and hydration.

Future public breaking changes require an explicit release/migration note and deliberate version
change; persistence and Value Type codecs are independently versioned. Do not silently reinterpret
an existing codec or persisted version. Update library-version metadata and reviewed skill source
acknowledgements together with a release version.

## Non-publishing preparation

From the repository root, run `vp run release:dry-run`. The release script creates fresh isolated
source snapshots, installs the frozen workspace lockfile, runs the full existing validation chain
with unchanged benchmarks, and builds/packs twice. It requires byte-identical tarballs across the
independent builds and retains package manifests, file lists, hashes, and complete command logs.
The command prints its temporary artifact directory. A failed command leaves its logs and exits
nonzero; a passing retry is not recorded as a fix for an earlier failure.

The procedure does not invoke `publish`, alter dist-tags, create a release, or change registry state.
Tarballs remain local review artifacts. Review, hosted checks, and an explicit publication/version
decision remain publication gates. Never treat a dry-run tarball as authorization to publish.
