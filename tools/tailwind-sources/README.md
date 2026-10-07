# Tailwind workspace sources

Run `vp run css:sources` after adding or removing workspace dependencies. Commit the resulting CSS blocks. `vp run check:css-sources` runs the same tool with `--check`: stale or missing blocks exit nonzero, print affected files and never write. `vp run test:css-sources` exercises the graph, updater and CLI.

The TypeScript tool reads the actual `packages` globs and exclusions in `pnpm-workspace.yaml`, then each matching package manifest. The UI identity comes from `packages/ui/package.json` (currently `@bruno/shadcn`). It follows dependencies, optional dependencies, peer dependencies and development dependencies because browser-test entrypoints also need styles. Workspace aliases and directory links resolve to the same package; cycles and diamond paths are deduplicated. An unresolved `workspace:` reference or duplicate name is an error.

For each package, it discovers `globals.css` and CSS importing `tailwindcss` or a package's `styles.css`. Existing generated blocks are also discovered so obsolete entries can be removed. It scans maintained CSS, excluding dependencies, build outputs and isolated fixtures. Packages without a CSS entrypoint are reported; the tool does not create an unused stylesheet or change imports.

A generated block includes the owning package and its reachable dependencies that themselves reach UI. Unrelated SDK/Rust packages and reverse dependents are omitted. It registers `src` and, for libraries with package exports, `dist`; output paths stay registered before a build exists. Paths are relative to **each stylesheet**, as required by [Tailwind's source registration](https://tailwindcss.com/docs/detecting-classes-in-source-files#explicitly-registering-sources). This covers source development and emitted package consumers without a repository-wide scan.

The tool owns only the block between `workspace-sources:start` and `workspace-sources:end`. Custom imports, rules and manual `@source`, `@source not` or `@source inline()` declarations stay outside it. Duplicate or broken markers fail before any file is written. All updates are planned before writes; `--check` is read-only. Normal file I/O failure during writes is reported, not claimed to be a filesystem transaction.

Current inventory:

| Workspace                                                               | Relationship to UI       | Managed CSS                             |
| ----------------------------------------------------------------------- | ------------------------ | --------------------------------------- |
| `@bruno/shadcn`                                                         | UI itself                | `packages/ui/src/styles/globals.css`    |
| `@bruno/table`                                                          | Direct                   | `packages/table/src/vitest.browser.css` |
| `@bruno/web`                                                            | Direct and through table | `apps/web/src/styles.css`               |
| `@bruno/server`, `@bruno/rust-view-server`, `@bruno/view-server-client` | None                     | None                                    |

`vp run check` includes the drift check through `check:policy`; `vp run test` includes tool tests through `test:infra`. GitHub Actions runs the focused tool typecheck, tests and `--check` on every PR and master push, without path filters that could miss manifest changes. It uses the repository's pinned Node/Vite+ versions and frozen lockfile, with no Rust, browser or Kafka setup. The tool is also included in the root pinned TypeScript tooling check. YAML uses the already-locked `yaml@2.9.0`, now declared directly rather than relying on Vite+'s transitive installation.

To run the tool directly after installing dependencies:

```sh
vp exec node tools/tailwind-sources/index.ts --check
```
