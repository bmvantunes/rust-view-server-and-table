import type { BrunoTableColumnId } from "../public-types";
import type { CompiledColumn, CompiledFieldColumn } from "./compile-columns";
import { BRUNO_TABLE_ROWS_COLUMN_ID, type BrunoTableClientGroupedRow } from "./client-grouping";
import {
  BRUNO_TABLE_DEFAULT_GROUP_ROWS_COLUMN_WIDTH,
  BRUNO_TABLE_MAX_COLUMN_WIDTH,
  BRUNO_TABLE_MIN_COLUMN_WIDTH,
} from "./column-management";
import { captureBrunoTablePlainRecord } from "./untrusted-input";
import { compileColumnValueSemantics } from "./value-semantics";

type RuntimeCallback = (...parameters: never[]) => unknown;

export type BrunoTableGroupedPresentationInput = Readonly<{
  readonly columns: readonly CompiledColumn[];
  readonly visibleColumnIds: readonly string[];
  readonly groupBy: readonly string[];
  readonly rowsColumn: BrunoTableCompiledGroupRowsColumn;
  readonly persistedRowsWidth?: number;
}>;

export type BrunoTableCompiledGroupRowsColumn = Readonly<{
  readonly headerName: string;
  readonly width: number;
  readonly valueFormatter?: RuntimeCallback;
  readonly cellClassName?: string | RuntimeCallback;
  readonly cellRenderer?: RuntimeCallback;
}>;

export function compileBrunoTableGroupRowsColumn(
  input: unknown,
): BrunoTableCompiledGroupRowsColumn {
  const record = captureBrunoTablePlainRecord(input, [
    "headerName",
    "width",
    "valueFormatter",
    "cellClassName",
    "cellRenderer",
  ]);
  if (input !== undefined && record === undefined) {
    throw new TypeError("BrunoTable groupRowsColumn must be a plain data object.");
  }
  const headerName = record?.["headerName"] ?? "Rows";
  if (typeof headerName !== "string" || headerName.trim().length === 0) {
    throw new TypeError("BrunoTable groupRowsColumn headerName must be non-empty.");
  }
  const width = record?.["width"] ?? BRUNO_TABLE_DEFAULT_GROUP_ROWS_COLUMN_WIDTH;
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width < BRUNO_TABLE_MIN_COLUMN_WIDTH ||
    width > BRUNO_TABLE_MAX_COLUMN_WIDTH
  ) {
    throw new TypeError("BrunoTable groupRowsColumn width must be between 32 and 1000.");
  }
  const valueFormatter = optionalFunction(record?.["valueFormatter"], "valueFormatter");
  const cellRenderer = optionalFunction(record?.["cellRenderer"], "cellRenderer");
  const cellClassName = record?.["cellClassName"];
  if (
    cellClassName !== undefined &&
    typeof cellClassName !== "string" &&
    typeof cellClassName !== "function"
  ) {
    throw new TypeError("BrunoTable groupRowsColumn cellClassName must be a string or function.");
  }
  return Object.freeze({
    headerName,
    width,
    ...(valueFormatter === undefined ? {} : { valueFormatter }),
    ...(cellRenderer === undefined ? {} : { cellRenderer }),
    ...(cellClassName === undefined
      ? {}
      : { cellClassName: cellClassName as string | RuntimeCallback }),
  });
}

export function createBrunoTableGroupedColumns(
  input: BrunoTableGroupedPresentationInput,
): readonly CompiledColumn[] {
  return new BrunoTableGroupedPresentationCompiler().compile(input);
}

export class BrunoTableGroupedPresentationCompiler {
  private input: BrunoTableGroupedPresentationInput | undefined;
  private output: readonly CompiledColumn[] | undefined;
  private rowsSemantics:
    | Readonly<{ readonly width: number; readonly value: CompiledFieldColumn["semantics"] }>
    | undefined;
  private readonly countDistinctSemantics = new WeakMap<
    CompiledFieldColumn["semantics"],
    CompiledFieldColumn["semantics"]
  >();

  public compile(input: BrunoTableGroupedPresentationInput): readonly CompiledColumn[] {
    if (this.input !== undefined && samePresentationInput(this.input, input)) {
      return this.output as readonly CompiledColumn[];
    }
    const output = createGroupedColumns(
      input,
      (width) => this.compileRowsSemantics(width),
      (semantics) => this.compileCountDistinctSemantics(semantics),
    );
    this.input = Object.freeze({
      ...input,
      visibleColumnIds: Object.freeze(Array.from(input.visibleColumnIds)),
      groupBy: Object.freeze(Array.from(input.groupBy)),
    });
    this.output = output;
    return output;
  }

  private compileRowsSemantics(width: number): CompiledFieldColumn["semantics"] {
    if (this.rowsSemantics?.width === width) return this.rowsSemantics.value;
    const value = compileColumnValueSemantics("bigint", { width });
    this.rowsSemantics = Object.freeze({ width, value });
    return value;
  }

  private compileCountDistinctSemantics(
    source: CompiledFieldColumn["semantics"],
  ): CompiledFieldColumn["semantics"] {
    const cached = this.countDistinctSemantics.get(source);
    if (cached !== undefined) return cached;
    const value = compileColumnValueSemantics("bigint", { width: source.width });
    this.countDistinctSemantics.set(source, value);
    return value;
  }
}

function createGroupedColumns(
  input: BrunoTableGroupedPresentationInput,
  compileRowsSemantics: (width: number) => CompiledFieldColumn["semantics"],
  compileCountDistinctSemantics: (
    source: CompiledFieldColumn["semantics"],
  ) => CompiledFieldColumn["semantics"],
): readonly CompiledColumn[] {
  const byId = new Map<string, CompiledColumn>(
    input.columns.map((column) => [column.columnId, column]),
  );
  const active = new Set(input.groupBy);
  const keys = input.groupBy.flatMap((columnId) => {
    const column = byId.get(columnId);
    return column?.kind === "field"
      ? [createRoleColumn(column, "groupKey", compileCountDistinctSemantics)]
      : [];
  });
  const aggregates = input.visibleColumnIds.flatMap((columnId) => {
    const column = byId.get(columnId);
    return column !== undefined &&
      column.kind === "field" &&
      column.aggFunc !== undefined &&
      !active.has(column.columnId)
      ? [createRoleColumn(column, "aggregate", compileCountDistinctSemantics)]
      : [];
  });
  return Object.freeze([
    ...keys,
    createRowsColumn(
      input.rowsColumn,
      input.persistedRowsWidth,
      input.groupBy,
      byId,
      compileRowsSemantics,
    ),
    ...aggregates,
  ]);
}

function createRoleColumn(
  column: CompiledFieldColumn,
  role: "groupKey" | "aggregate",
  compileCountDistinctSemantics: (
    source: CompiledFieldColumn["semantics"],
  ) => CompiledFieldColumn["semantics"],
): CompiledColumn {
  const aggregateIsBigInt = role === "aggregate" && column.aggFunc === "countDistinct";
  const semantics = aggregateIsBigInt
    ? compileCountDistinctSemantics(column.semantics)
    : column.semantics;
  const formatter =
    role === "groupKey" ? column.groupKeyValueFormatter : column.aggregateValueFormatter;
  const className =
    role === "groupKey" ? column.groupKeyCellClassName : column.aggregateCellClassName;
  const renderer = role === "groupKey" ? column.groupKeyCellRenderer : column.aggregateCellRenderer;
  const {
    pinned: _pinned,
    valueFormatter: _valueFormatter,
    cellClassName: _cellClassName,
    cellRenderer: _cellRenderer,
    ...base
  } = column;
  return Object.freeze({
    ...base,
    semantics,
    valueType: aggregateIsBigInt ? "bigint" : column.valueType,
    ...(formatter === undefined
      ? {}
      : { valueFormatter: wrapRoleCallback(formatter, column, role) }),
    ...(className === undefined
      ? {}
      : {
          cellClassName:
            typeof className === "function" ? wrapRoleCallback(className, column, role) : className,
        }),
    ...(renderer === undefined ? {} : { cellRenderer: wrapRoleCallback(renderer, column, role) }),
  });
}

function wrapRoleCallback(
  callback: RuntimeCallback,
  column: CompiledFieldColumn,
  role: "groupKey" | "aggregate",
): RuntimeCallback {
  return ((input: Readonly<{ readonly row: unknown; readonly value: unknown }>) => {
    const row = asGroupedRow(input.row, column.columnId, role);
    const parameters =
      role === "groupKey"
        ? {
            columnId: column.columnId,
            field: column.field,
            value: input.value,
            rowCount: row.rowCount,
          }
        : {
            columnId: column.columnId,
            field: column.field,
            aggFunc: column.aggFunc,
            value: input.value,
            rowCount: row.rowCount,
          };
    return Reflect.apply(callback, undefined, [parameters]);
  }) as RuntimeCallback;
}

function createRowsColumn(
  options: BrunoTableCompiledGroupRowsColumn,
  persistedWidth: number | undefined,
  groupBy: readonly string[],
  columnsById: ReadonlyMap<string, CompiledColumn>,
  compileRowsSemantics: (width: number) => CompiledFieldColumn["semantics"],
): CompiledColumn {
  const width = persistedWidth ?? options.width;
  const semantics = compileRowsSemantics(width);
  const wrap = (callback: RuntimeCallback): RuntimeCallback =>
    ((input: Readonly<{ readonly row: unknown; readonly value: unknown }>) => {
      const row = asGroupedRow(input.row, BRUNO_TABLE_ROWS_COLUMN_ID, "rows");
      const groupKeys = Object.freeze(
        groupBy.flatMap((columnId, index) => {
          const column = columnsById.get(columnId);
          const presence = row.groupKeys[index];
          return column?.kind !== "field" || presence === undefined
            ? []
            : [
                presence._tag === "Missing"
                  ? Object.freeze({
                      columnId: column.columnId,
                      field: column.field,
                      _tag: "Missing" as const,
                    })
                  : Object.freeze({
                      columnId: column.columnId,
                      field: column.field,
                      _tag: "Present" as const,
                      value: presence.value,
                    }),
              ];
        }),
      );
      return Reflect.apply(callback, undefined, [
        { columnId: BRUNO_TABLE_ROWS_COLUMN_ID, value: input.value, groupKeys },
      ]);
    }) as RuntimeCallback;
  return Object.freeze({
    kind: "computed",
    columnId: BRUNO_TABLE_ROWS_COLUMN_ID as BrunoTableColumnId,
    headerName: options.headerName,
    valueType: "bigint",
    semantics,
    fields: Object.freeze(["__BRUNO_TABLE_ROWS__"]) as readonly [string],
    valueGetter: (() => undefined) as RuntimeCallback,
    enableFilter: false,
    enableSetFilter: false,
    enableSorting: true,
    ...(options.valueFormatter === undefined
      ? {}
      : { valueFormatter: wrap(options.valueFormatter) }),
    ...(options.cellClassName === undefined
      ? {}
      : {
          cellClassName:
            typeof options.cellClassName === "function"
              ? wrap(options.cellClassName)
              : options.cellClassName,
        }),
    ...(options.cellRenderer === undefined ? {} : { cellRenderer: wrap(options.cellRenderer) }),
  });
}

function samePresentationInput(
  previous: BrunoTableGroupedPresentationInput,
  next: BrunoTableGroupedPresentationInput,
): boolean {
  return (
    previous.columns === next.columns &&
    previous.rowsColumn === next.rowsColumn &&
    previous.persistedRowsWidth === next.persistedRowsWidth &&
    sameStrings(previous.visibleColumnIds, next.visibleColumnIds) &&
    sameStrings(previous.groupBy, next.groupBy)
  );
}

function sameStrings(previous: readonly string[], next: readonly string[]): boolean {
  return (
    previous === next ||
    (previous.length === next.length && previous.every((value, index) => value === next[index]))
  );
}

function asGroupedRow(
  input: unknown,
  columnId: string,
  role: "groupKey" | "aggregate" | "rows",
): BrunoTableClientGroupedRow {
  if (typeof input !== "object" || input === null || !("rowCount" in input)) {
    throw new TypeError(`BrunoTable ${role} presentation for ${columnId} requires a grouped row.`);
  }
  return input as BrunoTableClientGroupedRow;
}

function optionalFunction(input: unknown, name: string): RuntimeCallback | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "function") {
    throw new TypeError(`BrunoTable groupRowsColumn ${name} must be a function.`);
  }
  return input as RuntimeCallback;
}
