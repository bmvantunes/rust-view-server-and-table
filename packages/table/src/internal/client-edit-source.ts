import type { BrunoTableRowId } from "../public-types";

export function reconcileBrunoTableClientEditSourcePublication(
  authority: Readonly<{ readonly hasAuthoritativeEditSource: () => boolean }>,
  editMemory:
    | Readonly<{
        readonly setSavePreflightAvailable: (available: boolean) => void;
      }>
    | undefined,
  cellEdit:
    | Readonly<{
        readonly reconcileSourceRows: (changedRowIds?: ReadonlySet<BrunoTableRowId>) => void;
        readonly reconcileActiveRow: (changedRowIds?: ReadonlySet<BrunoTableRowId>) => void;
      }>
    | undefined,
  changedRowIds: ReadonlySet<BrunoTableRowId> | undefined,
): void {
  const authoritative = authority.hasAuthoritativeEditSource();
  editMemory?.setSavePreflightAvailable(authoritative);
  if (!authoritative) return;
  cellEdit?.reconcileSourceRows(changedRowIds);
  cellEdit?.reconcileActiveRow(changedRowIds);
}
