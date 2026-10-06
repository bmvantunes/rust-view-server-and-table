import type { CompiledColumn } from "./compile-columns";

export function readCompiledColumnValue(column: CompiledColumn, row: unknown): unknown {
  if (column.kind === "field") return readField(row, column.field);

  const dependencies = Object.fromEntries(
    column.fields.map((field) => [field, readField(row, field)] as const),
  );
  return Reflect.apply(column.valueGetter, undefined, [{ row: dependencies }]);
}

function readField(row: unknown, field: string): unknown {
  if (row === null || row === undefined) {
    throw new TypeError("BrunoTable cannot read a column field from a nullish row.");
  }
  return Reflect.get(Object(row), field);
}
