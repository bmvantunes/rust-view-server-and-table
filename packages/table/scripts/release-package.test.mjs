import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

void test("private table archive content excludes development-only compiler fixtures", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bruno-release-content-"));
  const result = spawnSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(scratch, "cache") },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout)[0];
  assert.ok(packed.files.some(({ path }) => path === "dist/index.mjs"));
  assert.ok(packed.files.some(({ path }) => path === "dist/server.mjs"));
  assert.deepEqual(
    packed.files.filter(({ path }) => path.includes("compiler-smoke")),
    [],
  );
});

void test("both private packages identify their source and issue tracker", async () => {
  for (const directory of ["table", "ui"]) {
    const manifest = JSON.parse(
      await readFile(new URL(`../../${directory}/package.json`, import.meta.url), "utf8"),
    );
    assert.equal(manifest.private, true);
    assert.equal(manifest.bugs?.url, "https://github.com/bmvantunes/shadcn-table/issues");
    assert.equal(manifest.repository?.directory, `packages/${directory === "ui" ? "shadcn" : directory}`);
    assert.equal(manifest.repository?.url, "git+https://github.com/bmvantunes/shadcn-table.git");
    assert.equal(
      manifest.homepage,
      `https://github.com/bmvantunes/shadcn-table/tree/main/packages/${directory === "ui" ? "shadcn" : directory}#readme`,
    );
  }
});

void test("React package entries preserve the client boundary for server-component consumers", async () => {
  const table = await readFile(new URL("../dist/index.mjs", import.meta.url), "utf8");
  assert.match(table, /^['"]use client['"];\s/u);
  const manifest = JSON.parse(
    await readFile(new URL("../../ui/package.json", import.meta.url), "utf8"),
  );
  for (const target of Object.values(manifest.exports)) {
    if (typeof target !== "object") continue;
    const source = await readFile(
      new URL(`../../ui/${target.import}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /^['"]use client['"];\s/u, target.import);
  }
});

void test("every direct export resolves inside a tarball containing only release resources", async () => {
  for (const directory of ["table", "ui"]) {
    const scratch = await mkdtemp(join(tmpdir(), "bruno-release-exports-"));
    const packageRoot = new URL(`../../${directory}/`, import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
    const result = spawnSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      {
        cwd: fileURLToPath(packageRoot),
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: join(scratch, "cache") },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const files = JSON.parse(result.stdout)[0].files.map(({ path }) => path);
    function checkTarget(target) {
      if (typeof target === "string") {
        assert.ok(
          target.startsWith("./") && files.includes(target.slice(2)),
          `Missing packed export: ${directory} ${target}`,
        );
      } else {
        for (const nested of Object.values(target)) checkTarget(nested);
      }
    }
    checkTarget(manifest.exports);
    for (const path of files) {
      assert.match(
        path,
        /^(?:package\.json|README\.md|LICENSE(?:\.md)?|THIRD_PARTY_NOTICES\.md|USAGE\.md|RELEASE\.md|dist\/.+\.(?:mjs|d\.mts)|skills\/.+|src\/styles\/globals\.css)$/u,
      );
      assert.doesNotMatch(path, /(?:compiler-smoke|\.repos|\.cache|\.test\.|\.bench\.)/u);
      if (path.includes("node_modules")) {
        assert.match(
          path,
          /^dist\/node_modules\/\.pnpm\/effect-view-server@4\.2\.8_[^/]+\/node_modules\/effect-view-server\/dist\/[^/]+\.(?:mjs|d\.mts)$/u,
        );
      }
    }
    assert.ok(files.includes("README.md"));
    assert.ok(
      files.some((path) => /^LICENSE(?:\.md)?$/u.test(path)),
      `${directory} must ship its declared license text`,
    );
    assert.ok(
      files.includes("THIRD_PARTY_NOTICES.md"),
      `${directory} must retain bundled source notices`,
    );
    if (directory === "table") {
      assert.ok(files.includes("USAGE.md"));
      assert.ok(files.includes("RELEASE.md"));
      assert.ok(files.includes("dist/rust.mjs"));
    } else {
      assert.ok(files.includes("THIRD_PARTY_NOTICES.md"));
    }
  }
});
