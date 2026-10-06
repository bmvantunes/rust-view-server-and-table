/** Captures only named plain-data fields without enumerating or invoking untrusted properties. */
export function captureBrunoTablePlainRecord(
  input: unknown,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  try {
    const prototype =
      typeof input === "object" && input !== null ? Object.getPrototypeOf(input) : undefined;
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      (prototype !== Object.prototype && prototype !== null)
    ) {
      return undefined;
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of allowedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        return undefined;
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}
