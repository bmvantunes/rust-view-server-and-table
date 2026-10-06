import type { CompiledColumn } from "./compile-columns";
import type { ClientOrderBy } from "./grid-query";
import { reconcileClientOrderBy, sanitizeClientOrderBy } from "./grid-query";

export type BrunoTableSortingCommand =
  | Readonly<{
      readonly type: "column.sort.toggle";
      readonly columnId: string;
      readonly multi: boolean;
    }>
  | Readonly<{
      readonly type: "sorting.add";
      readonly columnId: string;
    }>
  | Readonly<{
      readonly type: "sorting.remove";
      readonly columnId: string;
    }>
  | Readonly<{
      readonly type: "sorting.move";
      readonly columnId: string;
      readonly targetIndex: number;
    }>
  | Readonly<{ readonly type: "sorting.reset" }>;

export function applyBrunoTableSortingCommand(
  orderBy: ClientOrderBy,
  baseline: ClientOrderBy,
  columns: readonly CompiledColumn[],
  command: BrunoTableSortingCommand,
): ClientOrderBy {
  const currentOrderBy = isValidActiveOrder(orderBy, columns)
    ? orderBy
    : reconcileClientOrderBy(orderBy, baseline, columns);
  if (command.type === "sorting.reset") {
    return reconcileClientOrderBy([], baseline, columns);
  }
  if (!isSortableColumn(columns, command.columnId)) return currentOrderBy;

  const currentIndex = currentOrderBy.findIndex((sort) => sort.columnId === command.columnId);
  const current = currentOrderBy[currentIndex];
  if (command.type === "sorting.add") {
    return current === undefined
      ? sanitizeClientOrderBy(
          [...currentOrderBy, { columnId: command.columnId, direction: "asc" }],
          columns,
        )
      : currentOrderBy;
  }
  if (command.type === "sorting.remove") {
    return current === undefined || currentOrderBy.length === 1
      ? currentOrderBy
      : sanitizeClientOrderBy(
          currentOrderBy.filter((sort) => sort.columnId !== command.columnId),
          columns,
        );
  }
  if (command.type === "sorting.move") {
    if (
      current === undefined ||
      !Number.isInteger(command.targetIndex) ||
      command.targetIndex < 0 ||
      command.targetIndex >= currentOrderBy.length ||
      command.targetIndex === currentIndex
    ) {
      return currentOrderBy;
    }
    const next = Array.from(currentOrderBy);
    next.splice(currentIndex, 1);
    next.splice(command.targetIndex, 0, current);
    return sanitizeClientOrderBy(next, columns);
  }

  const nextDirection: "asc" | "desc" = current?.direction === "asc" ? "desc" : "asc";
  const next = command.multi
    ? current === undefined
      ? [...currentOrderBy, { columnId: command.columnId, direction: "asc" as const }]
      : currentOrderBy.map((sort, index) =>
          index === currentIndex ? { columnId: command.columnId, direction: nextDirection } : sort,
        )
    : [{ columnId: command.columnId, direction: nextDirection }];
  return sanitizeClientOrderBy(next, columns);
}

export function isBrunoTableSortingCommand(
  command: BrunoTableSortingCommand | Readonly<{ readonly type: string }>,
): command is BrunoTableSortingCommand {
  return (
    command.type === "column.sort.toggle" ||
    command.type === "sorting.add" ||
    command.type === "sorting.remove" ||
    command.type === "sorting.move" ||
    command.type === "sorting.reset"
  );
}

function isSortableColumn(columns: readonly CompiledColumn[], columnId: string): boolean {
  return columns.some((column) => column.columnId === columnId && column.enableSorting !== false);
}

function isValidActiveOrder(orderBy: ClientOrderBy, columns: readonly CompiledColumn[]): boolean {
  if (orderBy.length === 0) return false;
  const sortable = new Set<string>();
  for (const column of columns) {
    if (column.enableSorting !== false) sortable.add(column.columnId);
  }
  const seen = new Set<string>();
  for (const sort of orderBy) {
    if (!sortable.has(sort.columnId) || seen.has(sort.columnId)) return false;
    seen.add(sort.columnId);
  }
  return true;
}
