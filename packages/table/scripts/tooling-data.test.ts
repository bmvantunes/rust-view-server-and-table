import assert from "node:assert/strict";
import { test } from "node:test";
import { packedFilePaths, parseManifest, yamlStringMapping } from "./tooling-data.ts";

test("package metadata rejects malformed dependency maps and exports", () => {
  assert.deepEqual(
    parseManifest('{"exports":{".":"./dist/index.mjs"},"dependencies":{"react":"19.3.0"}}')
      .dependencies,
    { react: "19.3.0" },
  );
  for (const source of [
    "null",
    "[]",
    '{"exports":[]}',
    '{"exports":{},"dependencies":{"react":19}}',
  ]) {
    assert.throws(() => parseManifest(source));
  }
});

test("archive reports require exactly one archive with string paths", () => {
  assert.deepEqual(
    packedFilePaths('[{"files":[{"path":"dist/index.mjs"},{"path":"package.json"}]}]'),
    ["dist/index.mjs", "package.json"],
  );
  for (const source of ["[]", "[{},{}]", '[{"files":null}]', '[{"files":[{"path":false}]}]']) {
    assert.throws(() => packedFilePaths(source));
  }
});

test("consumer workspace settings use editable block mappings and quote archive paths", () => {
  assert.equal(
    yamlStringMapping("overrides", { "@bruno/table": "file:/tmp/archive with: colon.tgz" }),
    'overrides:\n  "@bruno/table": "file:/tmp/archive with: colon.tgz"',
  );
  assert.equal(yamlStringMapping("patchedDependencies", {}), "patchedDependencies: {}");
});
