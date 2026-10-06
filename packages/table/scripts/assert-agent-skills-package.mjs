import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  BRUNO_TABLE_PACKAGED_SKILL_FILES,
  assertExactPackagedSkillFiles,
  assertExpectedIntentDiscovery,
  collectPackagedSkillFiles,
} from "./agent-skills-contract.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const scratch = await mkdtemp(join(tmpdir(), "bruno-table-agent-skills-"));
const npmCache = join(scratch, "npm-cache");
const fixture = join(scratch, "consumer");
const packageNodeModules = join(fixture, "node_modules/@bruno/table");
const evilPackage = join(fixture, "node_modules/@untrusted/matching-skill");
const sentinel = join(scratch, "dependency-code-executed");
const allowedSentinel = join(scratch, "allowlisted-package-code-executed");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.cleanEnv === true ? options.env : { ...process.env, ...options.env },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

async function findSkillResources(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(`skills/${relative(root, path).split(sep).join("/")}`);
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

await mkdir(fixture, { recursive: true });
const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
const expectedLoadedContent = await readFile(
  join(packageDir, "skills/define-columns/SKILL.md"),
  "utf8",
);
assert.deepEqual(
  packageJson.intent?.resources,
  BRUNO_TABLE_PACKAGED_SKILL_FILES,
  "package metadata must explicitly declare every reviewed skill resource",
);
const packOutput = run(
  "npm",
  ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
  { cwd: packageDir, env: { npm_config_cache: npmCache } },
);
const packResult = JSON.parse(packOutput)[0];
assert.ok(packResult?.filename, "npm pack did not report a tarball");
const expectedSkillFiles = await findSkillResources(join(packageDir, "skills"));
assertExactPackagedSkillFiles(expectedSkillFiles);
assertExactPackagedSkillFiles(collectPackagedSkillFiles(packResult.files));

await mkdir(packageNodeModules, { recursive: true });
run("tar", [
  "-xzf",
  join(scratch, packResult.filename),
  "--strip-components=1",
  "-C",
  packageNodeModules,
]);
const installedPackageJsonPath = join(packageNodeModules, "package.json");
const installedPackageJson = JSON.parse(await readFile(installedPackageJsonPath, "utf8"));
installedPackageJson.scripts = {
  ...installedPackageJson.scripts,
  postinstall: `node -e "require('fs').writeFileSync('${allowedSentinel}', 'bad')"`,
};
await writeFile(installedPackageJsonPath, JSON.stringify(installedPackageJson));
// Skill discovery also runs before a package build in the read-only CI job.
// Materialize the execution trap independently of whether dist was packed.
await mkdir(join(packageNodeModules, "dist"), { recursive: true });
await writeFile(
  join(packageNodeModules, "dist/index.mjs"),
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(allowedSentinel)}, "bad");\nthrow new Error("allowlisted dependency code executed");\n`,
);
await mkdir(join(evilPackage, "skills/look-alike"), { recursive: true });
await writeFile(
  join(evilPackage, "package.json"),
  JSON.stringify({
    name: "@untrusted/matching-skill",
    version: "1.0.0",
    repository: "https://example.invalid/untrusted",
    scripts: { postinstall: `node -e "require('fs').writeFileSync('${sentinel}', 'bad')"` },
    exports: { ".": "./execute-me.mjs" },
  }),
);
await writeFile(
  join(evilPackage, "execute-me.mjs"),
  `throw new Error("dependency code executed");\n`,
);
await writeFile(
  join(evilPackage, "skills/look-alike/SKILL.md"),
  ["---", "name: look-alike", "description: untrusted", "---", "# Untrusted", ""].join("\n"),
);
await writeFile(
  join(fixture, "package.json"),
  JSON.stringify({
    name: "bruno-table-agent-skills-consumer",
    private: true,
    dependencies: {
      "@bruno/table": "0.0.0",
      "@untrusted/matching-skill": "1.0.0",
    },
    intent: {
      skills: ["@bruno/table"],
      exclude: ["@bruno/table#edit-cells"],
    },
  }),
);

const intentCli = join(repoRoot, "node_modules/@tanstack/intent/dist/cli.mjs");
const intentEnv = {
  INTENT_AUDIENCE: "human",
  INTENT_GLOBAL_NODE_MODULES: "",
};
const listing = JSON.parse(
  run(process.execPath, [intentCli, "list", "--json"], {
    cleanEnv: true,
    cwd: fixture,
    env: intentEnv,
  }),
);
assert.deepEqual(
  listing.skills.map((skill) => skill.use).sort(),
  ["@bruno/table#choose-row-model", "@bruno/table#define-columns"],
  "consumer discovery must apply both the package allowlist and skill exclusion",
);
assert.equal(listing.hiddenSourceCount, 1, "the rejected untrusted candidate must be reported");
assert.deepEqual(listing.hiddenSources, [{ name: "@untrusted/matching-skill", skillCount: 1 }]);
assert.match(listing.notices.join("\n"), /@untrusted\/matching-skill/);
assert.deepEqual(
  (await readdir(fixture)).sort(),
  ["node_modules", "package.json"],
  "discovery must work without installing or executing editor hooks",
);

const loaded = JSON.parse(
  run(process.execPath, [intentCli, "load", "@bruno/table#define-columns", "--json"], {
    cleanEnv: true,
    cwd: fixture,
    env: intentEnv,
  }),
);
assert.equal(loaded.package, "@bruno/table");
assert.equal(loaded.skill, "define-columns");
assert.equal(
  loaded.content,
  expectedLoadedContent
    .replaceAll(
      "(../references/docs/grid/public-api-design.md)",
      "(node_modules/@bruno/table/skills/references/docs/grid/public-api-design.md)",
    )
    .replaceAll(
      "(../references/packages/table/README.md)",
      "(node_modules/@bruno/table/skills/references/packages/table/README.md)",
    ),
  "consumer load must preserve reviewed guidance with consumer-relative reference links",
);
for (const reference of [
  "skills/references/docs/grid/public-api-design.md",
  "skills/references/packages/table/README.md",
]) {
  assert.equal(
    await readFile(join(packageNodeModules, reference), "utf8"),
    await readFile(join(packageDir, reference), "utf8"),
    `loaded reference must resolve to exact reviewed package content: ${reference}`,
  );
}

const excluded = spawnSync(
  process.execPath,
  [intentCli, "load", "@bruno/table#edit-cells", "--json"],
  { cwd: fixture, encoding: "utf8", env: intentEnv },
);
assert.notEqual(excluded.status, 0, "an explicitly excluded skill must not load");
assert.match(excluded.stderr, /excluded/);

const bridgePackage = join(fixture, "node_modules/conflict-bridge");
const conflictingPackage = join(bridgePackage, "node_modules/@bruno/table");
await mkdir(join(conflictingPackage, "skills/define-columns"), { recursive: true });
await writeFile(
  join(bridgePackage, "package.json"),
  JSON.stringify({
    name: "conflict-bridge",
    version: "1.0.0",
    dependencies: { "@bruno/table": "9.9.9" },
  }),
);
await writeFile(
  join(conflictingPackage, "package.json"),
  JSON.stringify({
    name: "@bruno/table",
    version: "9.9.9",
    keywords: ["tanstack-intent"],
    repository: "https://example.invalid/conflicting-bruno-table",
    intent: {
      version: 1,
      repo: "https://example.invalid/conflicting-bruno-table",
      docs: "https://example.invalid/conflicting-bruno-table/docs",
      resources: ["skills/define-columns/SKILL.md"],
    },
  }),
);
await writeFile(
  join(conflictingPackage, "skills/define-columns/SKILL.md"),
  [
    "---",
    "name: define-columns",
    "description: conflicting installed version",
    "---",
    "# Conflicting skill",
    "",
  ].join("\n"),
);
await writeFile(
  join(fixture, "package.json"),
  JSON.stringify({
    name: "bruno-table-agent-skills-consumer",
    private: true,
    dependencies: {
      "@bruno/table": "0.0.0",
      "@untrusted/matching-skill": "1.0.0",
      "conflict-bridge": "1.0.0",
    },
    intent: {
      skills: ["@bruno/table"],
      exclude: ["@bruno/table#edit-cells"],
    },
  }),
);
const ambiguousListing = JSON.parse(
  run(process.execPath, [intentCli, "list", "--json"], {
    cleanEnv: true,
    cwd: fixture,
    env: intentEnv,
  }),
);
assert.ok(
  ambiguousListing.conflicts.some((conflict) => conflict.packageName === "@bruno/table"),
  "the duplicate installed package fixture must produce an Intent conflict",
);
assert.throws(
  () =>
    assertExpectedIntentDiscovery({
      expectedLoadedContent,
      expectedPackageRoot: packageNodeModules,
      expectedUses: ["@bruno/table#choose-row-model", "@bruno/table#define-columns"],
      expectedVersion: packageJson.version,
      listing: ambiguousListing,
      loaded,
    }),
  /ambiguous @bruno\/table discovery/,
);

await assert.rejects(
  readFile(sentinel),
  /ENOENT/,
  "dependency scripts, exports, and hooks must not run",
);
await assert.rejects(
  readFile(allowedSentinel),
  /ENOENT/,
  "allowlisted dependency scripts and exports must not run",
);
process.stdout.write("Agent-skill tarball and safe consumer discovery are valid.\n");
