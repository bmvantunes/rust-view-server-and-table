type RuntimeColumnDefinition = Readonly<Record<PropertyKey, unknown>>;

type OwnCapabilityEvidence = Readonly<{
  present: boolean;
  value: unknown;
}>;

const semanticCallbackKeys = [
  "valueGetter",
  "valueFormatter",
  "cellClassName",
  "cellRenderer",
  "isEditable",
  "validate",
  "groupKeyValueFormatter",
  "groupKeyCellClassName",
  "groupKeyCellRenderer",
  "aggregateValueFormatter",
  "aggregateCellClassName",
  "aggregateCellRenderer",
] as const;

type SemanticCallbackKey = (typeof semanticCallbackKeys)[number];

type SealedCallbackEvidence =
  | Readonly<{ readonly kind: "non-function" }>
  | Readonly<{ readonly kind: "function"; readonly value: unknown }>;

type SemanticCallbackEvidence = Readonly<Record<SemanticCallbackKey, SealedCallbackEvidence>>;

type FieldEvidence = Readonly<{
  kind: "field";
  aggFunc: OwnCapabilityEvidence;
  callbacks: SemanticCallbackEvidence;
  columnId: unknown;
  field: unknown;
  groupBy: OwnCapabilityEvidence;
  valueType: unknown;
}>;

type ComputedEvidence = Readonly<{
  kind: "computed";
  aggFunc: OwnCapabilityEvidence;
  callbacks: SemanticCallbackEvidence;
  columnId: unknown;
  fields: readonly unknown[];
  groupBy: OwnCapabilityEvidence;
  valueType: unknown;
}>;

type ColumnHelperEvidence = FieldEvidence | ComputedEvidence;

export const brunoTableColumnHelperProvenance: unique symbol = Symbol(
  "BrunoTable.private.columnHelperProvenance",
);

declare const brunoTableColumnHelperStructureWitness: unique symbol;

export type BrunoTableColumnHelperProvenanceCarrier<TStructure = unknown> = Readonly<{
  [brunoTableColumnHelperProvenance]: ColumnHelperEvidence;
  [brunoTableColumnHelperStructureWitness]?: TStructure;
}>;

export type BrunoTableColumnHelperProvenanceMismatch =
  | "columnId"
  | "field"
  | "fields"
  | "groupBy"
  | "aggFunc"
  | SemanticCallbackKey
  | "valueType"
  | "provenance";

export function attachBrunoTableColumnHelperProvenance(
  column: RuntimeColumnDefinition,
): RuntimeColumnDefinition & BrunoTableColumnHelperProvenanceCarrier {
  const columnId = column["columnId"];
  const valueType = column["valueType"];
  const evidence: ColumnHelperEvidence = Object.hasOwn(column, "fields")
    ? Object.freeze({
        kind: "computed",
        aggFunc: captureOwnCapability(column, "aggFunc"),
        callbacks: captureSemanticCallbacks(column),
        columnId,
        fields: Object.freeze(Array.from(asArray(column["fields"]))),
        groupBy: captureOwnCapability(column, "groupBy"),
        valueType,
      })
    : Object.freeze({
        kind: "field",
        aggFunc: captureOwnCapability(column, "aggFunc"),
        callbacks: captureSemanticCallbacks(column),
        columnId,
        field: column["field"],
        groupBy: captureOwnCapability(column, "groupBy"),
        valueType,
      });

  return {
    ...column,
    [brunoTableColumnHelperProvenance]: evidence,
  };
}

export function getBrunoTableColumnHelperProvenanceMismatch(
  column: RuntimeColumnDefinition,
): BrunoTableColumnHelperProvenanceMismatch | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(column, brunoTableColumnHelperProvenance);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !isEvidence(descriptor.value)) return "provenance";

  const evidence = descriptor.value;
  if (readOwnDataValue(column, "columnId") !== evidence.columnId) return "columnId";
  if (readOwnDataValue(column, "valueType") !== evidence.valueType) return "valueType";
  if (!matchesOwnCapability(column, "groupBy", evidence.groupBy)) return "groupBy";
  if (!matchesOwnCapability(column, "aggFunc", evidence.aggFunc)) return "aggFunc";
  for (const key of semanticCallbackKeys) {
    if (!matchesSemanticCallback(column, key, evidence.callbacks[key])) return key;
  }
  if (evidence.kind === "field") {
    return readOwnDataValue(column, "field") === evidence.field ? undefined : "field";
  }

  const fields = readOwnDataValue(column, "fields");
  if (!Array.isArray(fields) || fields.length !== evidence.fields.length) return "fields";
  for (let index = 0; index < fields.length; index += 1) {
    if (!Object.hasOwn(fields, index) || fields[index] !== evidence.fields[index]) return "fields";
  }
  return undefined;
}

function captureOwnCapability(
  record: RuntimeColumnDefinition,
  key: "aggFunc" | "groupBy",
): OwnCapabilityEvidence {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return Object.freeze({
    present: descriptor !== undefined && "value" in descriptor,
    value: descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined,
  });
}

function captureSemanticCallbacks(record: RuntimeColumnDefinition): SemanticCallbackEvidence {
  return Object.freeze(
    Object.fromEntries(
      semanticCallbackKeys.map((key) => {
        const value = readOwnDataValue(record, key);
        return [
          key,
          Object.freeze(
            typeof value === "function" ? { kind: "function", value } : { kind: "non-function" },
          ),
        ];
      }),
    ) as Record<SemanticCallbackKey, SealedCallbackEvidence>,
  );
}

function matchesSemanticCallback(
  record: RuntimeColumnDefinition,
  key: SemanticCallbackKey,
  expected: SealedCallbackEvidence,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor !== undefined && !("value" in descriptor)) return false;
  const value = descriptor?.value;
  return expected.kind === "function"
    ? typeof value === "function" && value === expected.value
    : typeof value !== "function";
}

function matchesOwnCapability(
  record: RuntimeColumnDefinition,
  key: "aggFunc" | "groupBy",
  evidence: OwnCapabilityEvidence,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return !evidence.present;
  if (!("value" in descriptor)) return false;
  return evidence.present && descriptor.value === evidence.value;
}

function readOwnDataValue(record: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isEvidence(value: unknown): value is ColumnHelperEvidence {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value)) return false;
  const kind = readOwnDataValue(value, "kind");
  if (kind === "field") {
    return (
      Object.hasOwn(value, "columnId") &&
      Object.hasOwn(value, "aggFunc") &&
      isSemanticCallbackEvidence(readOwnDataValue(value, "callbacks")) &&
      Object.hasOwn(value, "field") &&
      Object.hasOwn(value, "groupBy") &&
      Object.hasOwn(value, "valueType")
    );
  }
  if (kind !== "computed") return false;
  const fields = readOwnDataValue(value, "fields");
  return (
    Object.hasOwn(value, "columnId") &&
    Object.hasOwn(value, "aggFunc") &&
    isSemanticCallbackEvidence(readOwnDataValue(value, "callbacks")) &&
    Array.isArray(fields) &&
    Object.isFrozen(fields) &&
    Object.hasOwn(value, "groupBy") &&
    Object.hasOwn(value, "valueType")
  );
}

function isSemanticCallbackEvidence(value: unknown): value is SemanticCallbackEvidence {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.isFrozen(value) &&
    semanticCallbackKeys.every((key) => isSealedCallbackEvidence(readOwnDataValue(value, key)))
  );
}

function isSealedCallbackEvidence(value: unknown): value is SealedCallbackEvidence {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value)) return false;
  const kind = readOwnDataValue(value, "kind");
  return kind === "non-function" || (kind === "function" && Object.hasOwn(value, "value"));
}
