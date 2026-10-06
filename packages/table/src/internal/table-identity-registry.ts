import { getBrunoTableSelectValueTypeFingerprint } from "./select-value-type-provenance";

import type { CompiledColumn } from "./compile-columns";

type Registration = Readonly<{
  readonly instanceId: symbol;
  readonly schemaFingerprint: string;
}>;

const registrations = new Map<string, Registration[]>();
const computedGetterIdentities = new WeakMap<Function, number>();
const valueSemanticsFunctionIdentities = new WeakMap<Function, number>();
let nextComputedGetterIdentity = 1;
let nextValueSemanticsFunctionIdentity = 1;

export function registerBrunoTableIdentity(
  tableId: string,
  columns: readonly CompiledColumn[],
  report: (message: string) => void = console.error,
): () => void {
  const instanceId = Symbol(tableId);
  const schemaFingerprint = fingerprintSchema(columns);
  const current = registrations.get(tableId) ?? [];
  if (current.some((registration) => registration.schemaFingerprint !== schemaFingerprint)) {
    report(
      `BrunoTable detected simultaneous use of tableId ${JSON.stringify(tableId)} with incompatible column schemas.`,
    );
  }
  const registration = Object.freeze({ instanceId, schemaFingerprint });
  registrations.set(tableId, [...current, registration]);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const latest = registrations.get(tableId);
    if (latest === undefined) return;
    const remaining = latest.filter((candidate) => candidate.instanceId !== instanceId);
    if (remaining.length === 0) registrations.delete(tableId);
    else registrations.set(tableId, remaining);
  };
}

function fingerprintSchema(columns: readonly CompiledColumn[]): string {
  const normalized = columns.map((column) => ({
    columnId: column.columnId,
    kind: column.kind,
    ...(column.kind === "field"
      ? {
          field: column.field,
          groupBy: column.groupBy,
          aggFunc: column.aggFunc,
        }
      : {
          fields: column.fields,
          valueGetterIdentity: computedGetterIdentity(column.valueGetter),
        }),
    codecId: column.semantics.codecId,
    codecVersion: column.semantics.codecVersion,
    filterFamily: column.semantics.filterFamily,
    customValueSemantics: fingerprintCustomValueSemantics(column.valueType),
    enableFilter: column.enableFilter,
    enableSorting: column.enableSorting,
  }));
  normalized.sort((left, right) => left.columnId.localeCompare(right.columnId));
  return JSON.stringify(normalized);
}

function computedGetterIdentity(valueGetter: Function): number {
  const current = computedGetterIdentities.get(valueGetter);
  if (current !== undefined) return current;
  const next = nextComputedGetterIdentity;
  nextComputedGetterIdentity += 1;
  computedGetterIdentities.set(valueGetter, next);
  return next;
}

function fingerprintCustomValueSemantics(
  valueType: unknown,
): readonly (number | string)[] | undefined {
  if (typeof valueType !== "object" || valueType === null) return undefined;
  const selectFingerprint = getBrunoTableSelectValueTypeFingerprint(valueType);
  if (selectFingerprint !== undefined) return selectFingerprint;
  const descriptor = valueType as Readonly<Record<string, unknown>>;
  const keys = [
    "decodeRuntime",
    "equivalent",
    "compare",
    "formatCanonicalText",
    "parseCanonicalText",
    "encodePersisted",
    "decodePersisted",
  ] as const;
  const fingerprint: (number | string)[] = [];
  for (const key of keys) {
    const candidate = descriptor[key];
    fingerprint.push(
      key,
      typeof candidate === "function" ? valueSemanticsFunctionIdentity(candidate) : "missing",
    );
  }
  return Object.freeze(fingerprint);
}

function valueSemanticsFunctionIdentity(callback: Function): number {
  const current = valueSemanticsFunctionIdentities.get(callback);
  if (current !== undefined) return current;
  const next = nextValueSemanticsFunctionIdentity;
  nextValueSemanticsFunctionIdentity += 1;
  valueSemanticsFunctionIdentities.set(callback, next);
  return next;
}
