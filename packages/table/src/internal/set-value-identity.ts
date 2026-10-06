import type { CompiledColumn } from "./compile-columns";

export type BrunoTableSetValueIndex = ReadonlyMap<string, readonly unknown[]>;

export function brunoTableSetValueKey(column: CompiledColumn, value: unknown): string | undefined {
  try {
    const presence = value == null ? "nullish" : "value";
    return `${column.semantics.codecId}:${presence}:${
      value == null ? "" : column.semantics.formatCanonicalText(value)
    }`;
  } catch {
    return undefined;
  }
}

export function areBrunoTableSetValuesEquivalent(
  column: CompiledColumn,
  left: unknown,
  right: unknown,
): boolean {
  try {
    return Object.is(left, right) || column.semantics.equivalent(left, right);
  } catch {
    return false;
  }
}

export function createBrunoTableSetValueIndex(
  column: CompiledColumn,
  values: readonly unknown[],
): BrunoTableSetValueIndex {
  const index = new Map<string, unknown[]>();
  for (const value of values) addBrunoTableSetValueToIndex(column, index, value);
  return index;
}

export function hasBrunoTableSetValue(
  column: CompiledColumn,
  index: BrunoTableSetValueIndex,
  value: unknown,
): boolean {
  const key = brunoTableSetValueKey(column, value);
  if (key === undefined) return false;
  return (
    index
      .get(key)
      ?.some((candidate) => areBrunoTableSetValuesEquivalent(column, candidate, value)) === true
  );
}

export function addBrunoTableSetValueToIndex(
  column: CompiledColumn,
  index: Map<string, unknown[]>,
  value: unknown,
): boolean {
  const key = brunoTableSetValueKey(column, value);
  if (key === undefined) return false;
  const bucket = index.get(key) ?? [];
  if (bucket.some((candidate) => areBrunoTableSetValuesEquivalent(column, candidate, value))) {
    return false;
  }
  bucket.push(value);
  index.set(key, bucket);
  return true;
}
