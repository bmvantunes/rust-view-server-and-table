type BrunoTableSelectValueTypeProvenance = Readonly<{
  readonly fingerprint: readonly string[];
  readonly canonicalOptions: readonly string[];
}>;

const selectValueTypeProvenance = new WeakMap<object, BrunoTableSelectValueTypeProvenance>();

export function attachBrunoTableSelectValueTypeProvenance(
  valueType: object,
  kind: string,
  canonicalOptions: readonly string[],
): void {
  const options = Object.freeze([...canonicalOptions]);
  selectValueTypeProvenance.set(
    valueType,
    Object.freeze({ fingerprint: Object.freeze([kind, ...options]), canonicalOptions: options }),
  );
}

export function getBrunoTableSelectValueTypeFingerprint(
  valueType: unknown,
): readonly string[] | undefined {
  return typeof valueType === "object" && valueType !== null
    ? selectValueTypeProvenance.get(valueType)?.fingerprint
    : undefined;
}

export function getBrunoTableSelectCanonicalOptions(
  valueType: unknown,
): readonly string[] | undefined {
  return typeof valueType === "object" && valueType !== null
    ? selectValueTypeProvenance.get(valueType)?.canonicalOptions
    : undefined;
}
