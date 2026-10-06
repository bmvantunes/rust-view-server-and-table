import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isolatedProcessEnvironment } from "../../../config/isolated-process-environment.mjs";

export async function assertInstalledIntent(consumerRoot) {
  const packageRoot = join(consumerRoot, "node_modules/@bruno/table");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  function intent(args) {
    const result = spawnSync(
      process.execPath,
      ["node_modules/@tanstack/intent/dist/cli.mjs", ...args, "--json"],
      {
        cwd: consumerRoot,
        encoding: "utf8",
        env: {
          ...isolatedProcessEnvironment(consumerRoot),
          INTENT_GLOBAL_NODE_MODULES: "",
          INTENT_AUDIENCE: "human",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const listing = intent(["list"]);
  assert.deepEqual(listing.conflicts, []);
  assert.deepEqual(listing.skills.map(({ use }) => use).sort(), [
    "@bruno/table#choose-row-model",
    "@bruno/table#define-columns",
    "@bruno/table#edit-cells",
  ]);
  for (const skill of listing.skills) {
    assert.equal(await realpath(skill.packageRoot), await realpath(packageRoot));
    assert.equal(skill.packageVersion, manifest.version);
  }
  const loaded = intent(["load", "@bruno/table#define-columns"]);
  assert.equal(loaded.package, "@bruno/table");
  assert.equal(loaded.skill, "define-columns");
  assert.equal(loaded.version, manifest.version);
  assert.equal(await realpath(loaded.packageRoot), await realpath(packageRoot));
  const expected = await readFile(join(packageRoot, "skills/define-columns/SKILL.md"), "utf8");
  const installedRelativePath = relative(await realpath(consumerRoot), await realpath(packageRoot))
    .split(sep)
    .join("/");
  assert.equal(
    loaded.content,
    expected.replaceAll("(../references/", `(${installedRelativePath}/skills/references/`),
  );
  process.stdout.write("Installed consumer Intent discovery and exact guidance passed.\n");
}
