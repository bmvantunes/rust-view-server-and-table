import type { ReactNode } from "react";

import type { CompiledColumn } from "./compile-columns";

export function brunoTableCellPresentationUsesRawRow(column: CompiledColumn): boolean {
  return (
    column.valueFormatter !== undefined ||
    typeof column.cellClassName === "function" ||
    column.cellRenderer !== undefined
  );
}

export function brunoTableProxyPresentationUsesRawRow(column: CompiledColumn): boolean {
  return column.valueFormatter !== undefined;
}

export function resolveBrunoTableCellText(
  column: CompiledColumn,
  row: unknown,
  value: unknown,
): string {
  if (column.valueFormatter !== undefined) {
    const formatted = Reflect.apply(column.valueFormatter, undefined, [{ row, value }]);
    if (typeof formatted === "string") return formatted;
  }
  if (value === null || value === undefined) return "";
  return column.semantics.formatDisplay(value);
}

export function resolveBrunoTableCellContent(
  column: CompiledColumn,
  row: unknown,
  value: unknown,
): ReactNode {
  if (column.cellRenderer !== undefined) {
    return Reflect.apply(column.cellRenderer, undefined, [{ row, value }]) as ReactNode | undefined;
  }
  const booleanContent = resolveBooleanCellContent(column, value);
  if (booleanContent !== undefined) return booleanContent;
  return resolveBrunoTableCellText(column, row, value);
}

export function resolveBrunoTableProxyCellContent(
  column: CompiledColumn,
  row: unknown,
  value: unknown,
): ReactNode {
  const booleanContent = resolveBooleanCellContent(column, value);
  if (booleanContent !== undefined) return booleanContent;
  return resolveBrunoTableCellText(column, row, value);
}

export function resolveBrunoTableCellClassName(
  column: CompiledColumn,
  row: unknown,
  value: unknown,
): string | undefined {
  if (typeof column.cellClassName === "string") return column.cellClassName;
  if (column.cellClassName === undefined) return undefined;
  const className = Reflect.apply(column.cellClassName, undefined, [{ row, value }]);
  return typeof className === "string" ? className : undefined;
}

export function resolveBrunoTableProxyCellClassName(
  column: CompiledColumn,
  row: unknown,
  value: unknown,
): string | undefined {
  const sourceClassName = resolveBrunoTableCellClassName(column, row, value);
  const alignmentClassName =
    column.semantics.cellAlign === "center"
      ? "text-center"
      : column.semantics.cellAlign === "end"
        ? "text-end"
        : "text-start";
  return sourceClassName === undefined
    ? alignmentClassName
    : `${alignmentClassName} ${sourceClassName}`;
}

function resolveBooleanCellContent(column: CompiledColumn, value: unknown): ReactNode | undefined {
  if (
    column.valueFormatter === undefined &&
    column.valueType === "boolean" &&
    typeof value === "boolean"
  ) {
    return <input aria-label={column.headerName} checked={value} disabled type="checkbox" />;
  }
  return undefined;
}
