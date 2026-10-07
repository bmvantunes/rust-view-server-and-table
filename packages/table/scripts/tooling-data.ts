import assert from "node:assert/strict";

export function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected a JSON object",
  );
  return value as Record<string, unknown>;
}
function stringRecord(value: unknown): Record<string, string> {
  const source = record(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    assert.ok(typeof item === "string", `Expected string value for ${key}`);
    result[key] = item;
  }
  return result;
}
export function parseManifest(source: string) {
  const value = record(JSON.parse(source));
  return {
    private: value.private,
    files: value.files,
    homepage: value.homepage,
    bugs: value.bugs === undefined ? undefined : record(value.bugs),
    repository: value.repository === undefined ? undefined : record(value.repository),
    exports: record(value.exports),
    dependencies: value.dependencies === undefined ? undefined : stringRecord(value.dependencies),
    peerDependencies:
      value.peerDependencies === undefined ? undefined : stringRecord(value.peerDependencies),
    optionalDependencies:
      value.optionalDependencies === undefined
        ? undefined
        : stringRecord(value.optionalDependencies),
    devDependencies:
      value.devDependencies === undefined ? undefined : stringRecord(value.devDependencies),
    inlinedDependencies:
      value.inlinedDependencies === undefined ? undefined : stringRecord(value.inlinedDependencies),
  };
}
export function packedFilePaths(source: string): string[] {
  const output: unknown = JSON.parse(source);
  assert.ok(Array.isArray(output) && output.length === 1, "Expected exactly one packed archive");
  const files = record(output[0]).files;
  assert.ok(Array.isArray(files), "Expected packed file entries");
  return files.map((file: unknown) => {
    const path = record(file).path;
    assert.ok(typeof path === "string", "Expected packed file path");
    return path;
  });
}

// pnpm edits this file (for example, recording pinned release-age exceptions),
// so use block mappings rather than JSON/flow-style YAML. JSON string quoting
// keeps archive paths containing spaces, colons or newlines unambiguous.
export function yamlStringMapping(name: string, entries: Record<string, string>): string {
  const pairs = Object.entries(entries);
  return pairs.length === 0
    ? `${name}: {}`
    : `${name}:\n${pairs.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join("\n")}`;
}
