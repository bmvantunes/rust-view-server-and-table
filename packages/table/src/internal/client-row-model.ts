export {
  collectClientFilterColumnIds,
  createClientFilterPredicate,
  filterClientRows,
  filterReferencesColumn,
  reconcileClientOrderBy,
  sanitizeClientInitialFilters,
  sanitizeClientInitialOrderBy,
  sanitizeClientOrderBy,
} from "./grid-query";

import type { CompiledColumn } from "./compile-columns";
import type { ClientOrderBy } from "./grid-query";

export function createBrunoTableClientRowComparator<TRow>(
  columns: readonly CompiledColumn[],
  orderBy: ClientOrderBy,
  readValue: (column: CompiledColumn, row: TRow) => unknown,
  readSourceIndex: (row: TRow) => number,
): (left: TRow, right: TRow) => number {
  const columnsById = new Map<string, CompiledColumn>(
    columns.map((column) => [column.columnId, column]),
  );
  return (left, right) => {
    for (const sort of orderBy) {
      const column = columnsById.get(sort.columnId);
      if (column === undefined || column.enableSorting === false) continue;
      const comparison = column.semantics.compare(
        readValue(column, left),
        readValue(column, right),
      );
      if (comparison !== 0) return sort.direction === "desc" ? -comparison : comparison;
    }
    return readSourceIndex(left) - readSourceIndex(right);
  };
}

export type { BrunoTableOrderBy, ClientOrderBy } from "./grid-query";
