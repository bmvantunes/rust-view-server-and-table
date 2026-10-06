import type { CompiledColumn } from "./compile-columns";
import {
  createClientFilterPredicate,
  normalizeBrunoTableFilterText,
  type ClientFilterPlan,
} from "./grid-query";

/** Internal safety boundary for pasted Quick Filter candidates. */
export const BRUNO_TABLE_MAX_QUICK_FILTER_LENGTH = 1_024;
/** Internal configuration bound shared by Client configuration and predicate construction. */
export const BRUNO_TABLE_MAX_QUICK_FILTER_FIELDS = 256;

export function isBrunoTableQuickFilterTextWithinLimit(text: string): boolean {
  return text.length <= BRUNO_TABLE_MAX_QUICK_FILTER_LENGTH;
}

export function boundBrunoTableQuickFilterText(text: string): string {
  return isBrunoTableQuickFilterTextWithinLimit(text)
    ? text
    : text.slice(0, BRUNO_TABLE_MAX_QUICK_FILTER_LENGTH);
}

export type BrunoTableClientQuickFilterFieldReader<TRow> = (row: TRow, field: string) => unknown;

/**
 * Compiles the session-only Quick Filter independently from Grid Filter state. An empty query
 * intentionally has no predicate so the Client row model can retain its current query shape.
 */
export function createClientQuickFilterPredicate<TRow>(
  text: string | undefined,
  fields: readonly string[] | undefined,
  readField: BrunoTableClientQuickFilterFieldReader<TRow> = readClientQuickFilterField,
): ((row: TRow) => boolean) | undefined {
  const normalizedQuery = normalizeClientQuickFilterQuery(text);
  if (normalizedQuery === undefined) return undefined;
  const quickFilterFields = snapshotQuickFilterFieldsForPredicate(fields);
  if (quickFilterFields.length === 0) return undefined;
  return (row) =>
    quickFilterFields.some((field) => {
      try {
        const value = readField(row, field);
        return (
          typeof value === "string" &&
          normalizeBrunoTableFilterText(value).includes(normalizedQuery)
        );
      } catch {
        return false;
      }
    });
}

/** Returns the exact normalized query used to decide whether Quick Filter has dependencies. */
export function normalizeClientQuickFilterQuery(text: string | undefined): string | undefined {
  if (text === undefined || text.length === 0 || !isBrunoTableQuickFilterTextWithinLimit(text)) {
    return undefined;
  }
  const normalizedQuery = normalizeBrunoTableFilterText(text);
  return normalizedQuery.length === 0 ? undefined : normalizedQuery;
}

/** Composes the two independent query predicates without representing Quick Filter as a Grid Filter. */
export function createClientQueryPredicate<TRow>(
  columns: readonly CompiledColumn[],
  filters: readonly unknown[] | undefined,
  quickFilterText: string | undefined,
  quickFilterFields: readonly string[] | undefined,
  readValue: (column: CompiledColumn, row: TRow) => unknown,
  readField: BrunoTableClientQuickFilterFieldReader<TRow> = readClientQuickFilterField,
  filterPlan?: ClientFilterPlan,
): ((row: TRow) => boolean) | undefined {
  const gridPredicate = createClientFilterPredicate(columns, filters, readValue, filterPlan);
  const quickPredicate = createClientQuickFilterPredicate(
    quickFilterText,
    quickFilterFields,
    readField,
  );
  if (gridPredicate === undefined) return quickPredicate;
  if (quickPredicate === undefined) return gridPredicate;
  return (row) => gridPredicate(row) && quickPredicate(row);
}

/** Internal field access policy shared by every Client Quick Filter evaluation path. */
export function readClientQuickFilterField(row: unknown, field: string): unknown {
  if (row === null || row === undefined) throw new TypeError("Quick Filter row is nullish.");
  return Reflect.get(Object(row), field);
}

const EMPTY_QUICK_FILTER_FIELDS: readonly string[] = Object.freeze([]);

export type BrunoTableQuickFilterFieldsValidation =
  | Readonly<{ readonly ok: true; readonly fields: readonly string[] }>
  | Readonly<{
      readonly ok: false;
      readonly reason: "not-array" | "length" | "sparse" | "empty-field";
    }>;

/** Validates and snapshots the source-field tuple once for every Client runtime boundary. */
export function validateBrunoTableQuickFilterFields(
  fields: unknown,
): BrunoTableQuickFilterFieldsValidation {
  if (fields === undefined) return Object.freeze({ ok: true, fields: EMPTY_QUICK_FILTER_FIELDS });
  try {
    if (!Array.isArray(fields)) return Object.freeze({ ok: false, reason: "not-array" });
    const length = fields.length;
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > BRUNO_TABLE_MAX_QUICK_FILTER_FIELDS
    ) {
      return Object.freeze({ ok: false, reason: "length" });
    }
    const snapshot: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(fields, index)) return Object.freeze({ ok: false, reason: "sparse" });
      const field = fields[index];
      if (typeof field !== "string" || field.length === 0) {
        return Object.freeze({ ok: false, reason: "empty-field" });
      }
      if (!seen.has(field)) {
        seen.add(field);
        snapshot.push(field);
      }
    }
    return Object.freeze({ ok: true, fields: Object.freeze(snapshot) });
  } catch {
    return Object.freeze({ ok: false, reason: "not-array" });
  }
}

/** Snapshots the public Quick Filter field configuration with one shared diagnostic policy. */
export function snapshotBrunoTableQuickFilterFields(
  fields: readonly string[] | undefined,
): readonly string[] {
  const result = validateBrunoTableQuickFilterFields(fields);
  if (result.ok) return result.fields;
  switch (result.reason) {
    case "not-array":
      throw new TypeError("BrunoTable quickFilterFields must be a non-empty tuple when provided.");
    case "length":
      throw new TypeError(
        `BrunoTable quickFilterFields must contain between 1 and ${String(BRUNO_TABLE_MAX_QUICK_FILTER_FIELDS)} fields.`,
      );
    case "sparse":
      throw new TypeError("BrunoTable quickFilterFields must be dense.");
    case "empty-field":
      throw new TypeError("BrunoTable quickFilterFields must contain non-empty source fields.");
  }
}

function snapshotQuickFilterFieldsForPredicate(
  fields: readonly string[] | undefined,
): readonly string[] {
  // Public Client configuration is validated and rejected by the Adapter before this predicate
  // seam. The defensive empty result here is only for hostile internal/direct predicate callers;
  // it must never be used as the public configuration admission path.
  const result = validateBrunoTableQuickFilterFields(fields);
  return result.ok ? result.fields : EMPTY_QUICK_FILTER_FIELDS;
}
