import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertExactPackagedSkillFiles,
  assertExpectedIntentDiscovery,
  assertNoIntentStalenessReports,
  collectPackagedSkillFiles,
  validateSourceAcknowledgements,
} from "./agent-skills-contract.mjs";
import { runIntentStalenessValidation } from "./assert-intent-staleness.mjs";

const expectedIntentSkillNames = ["choose-row-model", "define-columns", "edit-cells"];

void test("workspace discovery accepts Intent-resolved links but rejects altered guidance", async () => {
  const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const fixture = await mkdtemp(join(tmpdir(), "bruno-workspace-discovery-"));
  const listingPath = join(fixture, "list.json");
  const loadedPath = join(fixture, "load.json");
  const runIntent = (args, outputPath) => {
    const output = openSync(outputPath, "w");
    try {
      execFileSync(
        process.execPath,
        [join(workspaceRoot, "node_modules/@tanstack/intent/dist/cli.mjs"), ...args, "--json"],
        {
          cwd: workspaceRoot,
          stdio: ["ignore", output, "pipe"],
        },
      );
    } finally {
      closeSync(output);
    }
  };
  runIntent(["list"], listingPath);
  runIntent(["load", "@bruno/table#define-columns"], loadedPath);
  const loaded = JSON.parse(await readFile(loadedPath, "utf8"));
  assert.ok(
    loaded.content.includes("(packages/table/skills/references/docs/grid/public-api-design.md)"),
  );
  await writeFile(loadedPath, JSON.stringify(loaded));
  const validate = () =>
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./assert-intent-discovery.mjs", import.meta.url)),
        listingPath,
        loadedPath,
      ],
      { cwd: workspaceRoot, stdio: "pipe" },
    );
  assert.doesNotThrow(validate);
  await writeFile(
    loadedPath,
    JSON.stringify({ ...loaded, content: `${loaded.content}\nAltered guidance.` }),
  );
  assert.throws(validate, /loaded guidance differs/);
});

void test("creates its own review PR instead of editing a same-named fork PR", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/check-skills.yml", import.meta.url),
    "utf8",
  );
  const publication = workflow.slice(workflow.indexOf("      - name: Open"));
  const script = publication
    .slice(publication.indexOf("        run: |\n") + 15)
    .replaceAll(/^          /gm, "");
  const output = execFileSync(
    "bash",
    [
      "-e",
      "-c",
      `
    git() { return 0; }
    gh() {
      if [ "$1 $2" = "pr list" ]; then
        printf '%s\\n' 'https://github.com/bmvantunes/shadcn-table/pull/999';
      else
        printf '%s\\n' "$*";
      fi
    }
    ${script}
  `,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DEFAULT_BRANCH: "main",
        BRANCH: "skills/review-manual-100-1",
        VERSION: "manual",
        RUNNER_TEMP: "/tmp",
      },
    },
  );
  assert.doesNotMatch(output, /pr edit/u);
  assert.match(output, /pr create .*--head skills\/review-manual-100-1 --base main/u);
});

void test("bases inert review publication on the default branch rather than the dispatch ref", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/check-skills.yml", import.meta.url),
    "utf8",
  );
  const publication = workflow.slice(workflow.indexOf("\n  review:\n"));
  assert.match(
    publication,
    /with:\n          ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n/u,
    "the publication checkout must not inherit a feature branch or tag from workflow_dispatch",
  );
});

void test("publishes repeat reviews on fresh branches and serializes the actual target branch", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/check-skills.yml", import.meta.url),
    "utf8",
  );
  const script = workflow.match(
    /id: review-branch\n(?:.*\n)*?        run: \|\n((?:          .*\n)+)/u,
  )?.[1];
  assert.ok(script, "workflow must compute its publication branch before the write job");
  const titleTemplate = workflow.match(/--title "([^"\n]+)"/u)?.[1];
  assert.ok(titleTemplate, "workflow must supply the review PR title");
  const root = await mkdtemp(join(tmpdir(), "bruno-table-review-branch-"));
  const branches = [];
  for (const [tag, run, attempt] of [
    ["manual", "100", "1"],
    ["manual", "101", "1"],
    ["manual", "100", "2"],
    ["release/v1.0", "102", "1"],
    ["release-v1-0", "103", "1"],
    ["x".repeat(240), "104", "1"],
  ]) {
    const output = join(root, `${run}-${attempt}`);
    execFileSync("bash", ["-e", "-c", script.replaceAll(/^          /gm, "")], {
      env: {
        ...process.env,
        RELEASE_TAG: tag,
        GITHUB_RUN_ID: run,
        GITHUB_RUN_ATTEMPT: attempt,
        GITHUB_OUTPUT: output,
      },
    });
    const values = Object.fromEntries(
      (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    execFileSync("git", ["check-ref-format", "--branch", values.branch]);
    const title = titleTemplate.replaceAll("${VERSION}", values.version);
    assert.ok(title.length <= 256, `generated PR title exceeds 256 characters: ${title.length}`);
    branches.push(values.branch);
  }
  assert.deepEqual(branches, [
    "skills/review-manual-100-1",
    "skills/review-manual-101-1",
    "skills/review-manual-100-2",
    "skills/review-release-v1-0-102-1",
    "skills/review-release-v1-0-103-1",
    `skills/review-${"x".repeat(100)}-104-1`,
  ]);
  assert.match(workflow, /review_branch: \$\{\{ steps\.review-branch\.outputs\.branch \}\}/u);
  assert.match(
    workflow,
    /group: \$\{\{ needs\.review-state\.outputs\.review_branch \}\}\n      cancel-in-progress: false/u,
  );
  assert.match(workflow, /BRANCH: \$\{\{ needs\.review-state\.outputs\.review_branch \}\}/u);
});

function currentIntentStalenessReport(overrides = {}) {
  return {
    library: "@bruno/table",
    currentVersion: "1.2.3",
    skillVersion: "1.2.3",
    versionDrift: null,
    skills: expectedIntentSkillNames.map((name) => ({ name, needsReview: false, reasons: [] })),
    signals: [],
    ...overrides,
  };
}

void test("rejects an authoritative source change without a matching skill acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "bruno-table-skill-stale-"));
  const packageDir = join(root, "packages/table");
  const skillDir = join(packageDir, "skills/core");
  const referenceDir = join(packageDir, "skills/references");
  await mkdir(skillDir, { recursive: true });
  await mkdir(referenceDir, { recursive: true });
  await writeFile(join(root, "docs.md"), "authoritative v2\n");
  await writeFile(join(referenceDir, "docs.md"), "authoritative v2\n");
  await writeFile(
    join(packageDir, "skills/sync-state.json"),
    JSON.stringify({
      version: 1,
      library_version: "1.2.3",
      skills: {
        core: {
          skill_version: "1.0.0",
          sources_sha: {
            "bmvantunes/shadcn-table:docs.md": "outdated",
          },
        },
      },
    }),
  );
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: core",
      "metadata:",
      "  library_version: '1.2.3'",
      "  skill_version: '1.0.0'",
      "sources:",
      "  - 'bmvantunes/shadcn-table:docs.md'",
      "---",
      "# Core",
      "",
    ].join("\n"),
  );

  const failures = await validateSourceAcknowledgements({ packageDir, repoRoot: root });

  assert.deepEqual(failures, [
    "core: source changed without acknowledgement: bmvantunes/shadcn-table:docs.md",
  ]);
});

void test("clipboard requirements changes need an edit-cells acknowledgement even after row-model acknowledgement", async () => {
  const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "bruno-edit-skill-source-"));
  const packageDir = join(root, "packages/table");
  await mkdir(packageDir, { recursive: true });
  await cp(join(workspaceRoot, "docs"), join(root, "docs"), { recursive: true });
  await cp(join(workspaceRoot, "packages/table/skills"), join(packageDir, "skills"), {
    recursive: true,
  });
  await cp(join(workspaceRoot, "packages/table/README.md"), join(packageDir, "README.md"));
  assert.deepEqual(await validateSourceAcknowledgements({ packageDir, repoRoot: root }), []);

  const source = "bmvantunes/shadcn-table:docs/grid/requirements.md";
  const changed = `${await readFile(join(root, "docs/grid/requirements.md"), "utf8")}\nClipboard contract revision.\n`;
  await writeFile(join(root, "docs/grid/requirements.md"), changed);
  await writeFile(join(packageDir, "skills/references/docs/grid/requirements.md"), changed);
  const syncPath = join(packageDir, "skills/sync-state.json");
  const sync = JSON.parse(await readFile(syncPath, "utf8"));
  const { createHash } = await import("node:crypto");
  sync.skills["choose-row-model"].sources_sha[source] = createHash("sha256")
    .update(changed)
    .digest("hex");
  await writeFile(syncPath, JSON.stringify(sync));

  assert.deepEqual(await validateSourceAcknowledgements({ packageDir, repoRoot: root }), [
    "edit-cells: source changed without acknowledgement: bmvantunes/shadcn-table:docs/grid/requirements.md",
  ]);
});

void test("accepts only exact, version-matched source acknowledgements", async () => {
  const root = await mkdtemp(join(tmpdir(), "bruno-table-skill-current-"));
  const packageDir = join(root, "packages/table");
  const skillDir = join(packageDir, "skills/core");
  const referenceDir = join(packageDir, "skills/references");
  await mkdir(skillDir, { recursive: true });
  await mkdir(referenceDir, { recursive: true });
  await writeFile(join(root, "docs.md"), "authoritative v1\n");
  await writeFile(join(referenceDir, "docs.md"), "authoritative v1\n");
  const { createHash } = await import("node:crypto");
  const sourceHash = createHash("sha256").update("authoritative v1\n").digest("hex");
  await writeFile(
    join(packageDir, "skills/sync-state.json"),
    JSON.stringify({
      version: 1,
      library_version: "1.2.3",
      skills: {
        core: {
          skill_version: "1.0.0",
          sources_sha: {
            "bmvantunes/shadcn-table:docs.md": sourceHash,
          },
        },
      },
    }),
  );
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: core",
      "metadata:",
      "  library_version: '1.2.3'",
      "  skill_version: '1.0.0'",
      "sources:",
      "  - 'bmvantunes/shadcn-table:docs.md'",
      "---",
      "# Core",
      "",
    ].join("\n"),
  );

  assert.deepEqual(await validateSourceAcknowledgements({ packageDir, repoRoot: root }), []);
});

void test("rejects a packaged guidance reference that differs from its authoritative source", async () => {
  const root = await mkdtemp(join(tmpdir(), "bruno-table-skill-reference-"));
  const packageDir = join(root, "packages/table");
  const skillDir = join(packageDir, "skills/core");
  const referenceDir = join(packageDir, "skills/references");
  await mkdir(skillDir, { recursive: true });
  await mkdir(referenceDir, { recursive: true });
  await writeFile(join(root, "docs.md"), "authoritative v1\n");
  await writeFile(join(referenceDir, "docs.md"), "stale packaged copy\n");
  const { createHash } = await import("node:crypto");
  const sourceHash = createHash("sha256").update("authoritative v1\n").digest("hex");
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await writeFile(
    join(packageDir, "skills/sync-state.json"),
    JSON.stringify({
      version: 1,
      library_version: "1.2.3",
      skills: {
        core: {
          skill_version: "1.0.0",
          sources_sha: { "bmvantunes/shadcn-table:docs.md": sourceHash },
        },
      },
    }),
  );
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: core",
      "metadata:",
      "  library_version: '1.2.3'",
      "  skill_version: '1.0.0'",
      "sources:",
      "  - 'bmvantunes/shadcn-table:docs.md'",
      "---",
      "# Core",
      "",
    ].join("\n"),
  );

  assert.deepEqual(await validateSourceAcknowledgements({ packageDir, repoRoot: root }), [
    "core: packaged source differs from authority: bmvantunes/shadcn-table:docs.md",
  ]);
});

void test("rejects divergent source-hash authorities", async () => {
  const root = await mkdtemp(join(tmpdir(), "bruno-table-skill-hash-authority-"));
  const packageDir = join(root, "packages/table");
  const skillDir = join(packageDir, "skills/core");
  const referenceDir = join(packageDir, "skills/references");
  await mkdir(skillDir, { recursive: true });
  await mkdir(referenceDir, { recursive: true });
  await writeFile(join(root, "docs.md"), "authoritative v1\n");
  await writeFile(join(referenceDir, "docs.md"), "authoritative v1\n");
  const { createHash } = await import("node:crypto");
  const sourceHash = createHash("sha256").update("authoritative v1\n").digest("hex");
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await writeFile(
    join(packageDir, "skills/sync-state.json"),
    JSON.stringify({
      version: 1,
      library_version: "1.2.3",
      skills: {
        core: {
          skill_version: "1.0.0",
          sources_sha: { "bmvantunes/shadcn-table:docs.md": "stale" },
          sources_sha256: { "bmvantunes/shadcn-table:docs.md": sourceHash },
        },
      },
    }),
  );
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: core",
      "metadata:",
      "  library_version: '1.2.3'",
      "  skill_version: '1.0.0'",
      "sources:",
      "  - 'bmvantunes/shadcn-table:docs.md'",
      "---",
      "# Core",
      "",
    ].join("\n"),
  );

  assert.deepEqual(await validateSourceAcknowledgements({ packageDir, repoRoot: root }), [
    "core: source changed without acknowledgement: bmvantunes/shadcn-table:docs.md",
    "core: unsupported parallel sources_sha256 authority",
  ]);
});

void test("reports every packaged skill resource and rejects unexpected skill files", () => {
  const files = [
    { path: "package/skills/core/SKILL.md" },
    { path: "package/skills/references/core.md" },
    { path: "package/skills/sync-state.json" },
    { path: "package/dist/index.mjs" },
  ];

  assert.deepEqual(collectPackagedSkillFiles(files), [
    "skills/core/SKILL.md",
    "skills/references/core.md",
    "skills/sync-state.json",
  ]);
});

void test("rejects an accidental addition to the exact published skill resource set", () => {
  assert.throws(
    () =>
      assertExactPackagedSkillFiles([
        "skills/choose-row-model/SKILL.md",
        "skills/define-columns/SKILL.md",
        "skills/edit-cells/SKILL.md",
        "skills/sync-state.json",
        "skills/unreviewed-notes.md",
      ]),
    /unexpected: skills\/unreviewed-notes\.md/,
  );
});

void test("rejects ambiguous or incorrectly rooted Intent discovery", () => {
  const expected = {
    expectedLoadedContent: "authoritative define-columns guidance\n",
    expectedPackageRoot: "/workspace/packages/table",
    expectedUses: [
      "@bruno/table#choose-row-model",
      "@bruno/table#define-columns",
      "@bruno/table#edit-cells",
    ],
    expectedVersion: "1.2.3",
  };
  const listing = {
    conflicts: [
      {
        packageName: "@bruno/table",
        variants: [
          { packageRoot: "/workspace/packages/table", version: "1.2.3" },
          { packageRoot: "/workspace/node_modules/nested/@bruno/table", version: "1.1.0" },
        ],
      },
    ],
    skills: expected.expectedUses.map((use) => ({
      packageName: "@bruno/table",
      packageRoot: expected.expectedPackageRoot,
      packageVersion: expected.expectedVersion,
      use,
    })),
  };
  const loaded = {
    conflict: null,
    package: "@bruno/table",
    packageRoot: expected.expectedPackageRoot,
    skill: "define-columns",
    version: expected.expectedVersion,
    content: expected.expectedLoadedContent,
  };

  assert.throws(
    () => assertExpectedIntentDiscovery({ ...expected, listing, loaded }),
    /ambiguous @bruno\/table discovery/,
  );
  assert.throws(
    () =>
      assertExpectedIntentDiscovery({
        ...expected,
        listing: { ...listing, conflicts: [] },
        loaded: { ...loaded, packageRoot: "/workspace/node_modules/@bruno/table" },
      }),
    /unexpected package root/,
  );
});

void test("rejects empty or unrelated guidance loaded by current Intent", () => {
  const expected = {
    expectedLoadedContent: "authoritative define-columns guidance\n",
    expectedPackageRoot: "/workspace/packages/table",
    expectedUses: ["@bruno/table#define-columns"],
    expectedVersion: "1.2.3",
  };
  const listing = {
    conflicts: [],
    skills: [
      {
        packageName: "@bruno/table",
        packageRoot: expected.expectedPackageRoot,
        packageVersion: expected.expectedVersion,
        use: "@bruno/table#define-columns",
      },
    ],
  };
  const loaded = {
    conflict: null,
    package: "@bruno/table",
    packageRoot: expected.expectedPackageRoot,
    skill: "define-columns",
    version: expected.expectedVersion,
  };

  for (const content of ["", "unrelated edit-cells guidance\n"]) {
    assert.throws(
      () =>
        assertExpectedIntentDiscovery({
          ...expected,
          listing,
          loaded: { ...loaded, content },
        }),
      /loaded guidance differs from the authoritative skill/,
    );
  }
});

void test("fails authoritative validation when Intent reports review-needed state", () => {
  const staleReports = [
    currentIntentStalenessReport({
      skills: expectedIntentSkillNames.map((name) => ({
        name,
        needsReview: name === "define-columns",
        reasons: name === "define-columns" ? ["version drift"] : [],
      })),
      signals: [
        {
          type: "missing-package-coverage",
          subject: "@bruno/extra",
          needsReview: true,
          reasons: ["uncovered workspace package"],
        },
      ],
    }),
  ];

  assert.throws(
    () => assertNoIntentStalenessReports(staleReports),
    /define-columns: version drift.*missing-package-coverage.*uncovered workspace package/s,
  );
  assert.doesNotThrow(() => assertNoIntentStalenessReports([currentIntentStalenessReport()]));
});

void test("rejects uncertain or malformed Intent staleness reports", () => {
  for (const reports of [
    [],
    [{}],
    [{ library: "@bruno/table" }],
    [{ library: "@bruno/table", skills: [{ name: "define-columns" }], signals: [] }],
    [{ library: "@bruno/table", skills: [], signals: [{ type: "unknown" }] }],
  ]) {
    assert.throws(
      () => assertNoIntentStalenessReports(reports),
      /Intent staleness output is uncertain or malformed/,
    );
  }
});

void test("rejects unknown Intent staleness report, skill, and signal keys", () => {
  const validReport = currentIntentStalenessReport({
    signals: [
      {
        type: "package-coverage",
        subject: "@bruno/table",
        needsReview: false,
        reasons: [],
      },
    ],
  });
  const adversarialReports = [
    { ...validReport, unexpectedReportField: "accepted by accident" },
    {
      ...validReport,
      skills: [
        { ...validReport.skills[0], unexpectedSkillField: "accepted by accident" },
        ...validReport.skills.slice(1),
      ],
    },
    {
      ...validReport,
      signals: [{ ...validReport.signals[0], unexpectedSignalField: "accepted by accident" }],
    },
  ].map((report) => JSON.parse(JSON.stringify([report])));

  for (const reports of adversarialReports) {
    assert.throws(
      () => assertNoIntentStalenessReports(reports),
      /Intent staleness output is uncertain or malformed/,
    );
  }
});

void test("rejects missing, duplicate, or unexpected Intent package and skill topology", () => {
  const validReport = currentIntentStalenessReport();
  for (const reports of [
    [currentIntentStalenessReport({ library: "@bruno/other" })],
    [validReport, validReport],
    [currentIntentStalenessReport({ skills: validReport.skills.slice(1) })],
    [
      currentIntentStalenessReport({
        skills: [validReport.skills[0], validReport.skills[0], ...validReport.skills.slice(2)],
      }),
    ],
    [
      currentIntentStalenessReport({
        skills: [
          ...validReport.skills,
          { name: "unexpected-skill", needsReview: false, reasons: [] },
        ],
      }),
    ],
  ]) {
    assert.throws(
      () => assertNoIntentStalenessReports(reports),
      /Intent staleness output is uncertain or malformed/,
    );
  }
});

void test("propagates every Intent staleness producer failure before accepting output", () => {
  const validOutput = JSON.stringify([currentIntentStalenessReport()]);
  const producerFailures = [
    {
      result: {
        error: new Error("spawn denied"),
        signal: null,
        status: null,
        stderr: "",
        stdout: validOutput,
      },
      expected: /Intent stale could not start/,
    },
    {
      result: {
        error: undefined,
        signal: "SIGTERM",
        status: null,
        stderr: "terminated\n",
        stdout: validOutput,
      },
      expected: /Intent stale terminated by signal SIGTERM.*terminated/s,
    },
    {
      result: {
        error: undefined,
        signal: null,
        status: 7,
        stderr: "registry unavailable\n",
        stdout: validOutput,
      },
      expected: /Intent stale exited with status 7.*registry unavailable/s,
    },
    {
      result: { error: undefined, signal: null, status: 0, stderr: "", stdout: "not json" },
      expected: /Intent stale did not produce valid JSON/,
    },
    {
      result: { error: undefined, signal: null, status: 0, stderr: "", stdout: "" },
      expected: /Intent stale did not produce valid JSON/,
    },
  ];

  for (const { result, expected } of producerFailures) {
    assert.throws(() => runIntentStalenessValidation({ run: () => result }), expected);
  }
});

void test("invokes Intent staleness with the exact authoritative producer contract", () => {
  const calls = [];
  const run = (...parameters) => {
    calls.push(parameters);
    return {
      error: undefined,
      signal: null,
      status: 0,
      stderr: "",
      stdout: JSON.stringify([currentIntentStalenessReport()]),
    };
  };

  assert.doesNotThrow(() => runIntentStalenessValidation({ run }));
  assert.deepEqual(calls, [
    [
      "intent",
      ["stale", ".", "--json"],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ],
  ]);
});

void test("runs skill validation when pull requests change every trust-boundary configuration", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/check-skills.yml", import.meta.url),
    "utf8",
  );

  for (const path of [
    ".github/workflows/check-skills.yml",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "packages/*/package.json",
    "packages/table/README.md",
    "packages/table/scripts/agent-skills-contract.mjs",
    "packages/table/scripts/agent-skills-contract.test.mjs",
    "packages/table/scripts/assert-agent-skills-package.mjs",
    "packages/table/scripts/assert-build-output.mjs",
    "packages/table/scripts/assert-intent-discovery.mjs",
    "packages/table/scripts/assert-intent-staleness.mjs",
  ]) {
    assert.ok(workflow.includes(`      - "${path}"`), `workflow must watch ${path}`);
  }
});

void test("checks public source contracts when the API changes without Markdown changes", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/check-skills.yml", import.meta.url),
    "utf8",
  );
  const trigger = workflow.slice(
    workflow.indexOf("  pull_request:"),
    workflow.indexOf("  release:"),
  );
  assert.ok(trigger.includes('"packages/table/src/**"'));
  assert.ok(trigger.includes('"packages/table/tsconfig*.json"'));
  const validation = workflow.slice(
    workflow.indexOf("  validate:"),
    workflow.indexOf("  review-state:"),
  );
  assert.ok(validation.includes("pnpm --filter @bruno/shadcn run build"));
  assert.ok(validation.includes("pnpm --filter @bruno/table run test:types:source"));
});

void test("runs current Intent through the workspace package manager", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/check-skills.yml", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(
    workflow,
    /\b(?:npm\s+install|npx)(?:\s|$)/u,
    "the pnpm-enforced workspace must not invoke current Intent through npm/npx",
  );
  assert.doesNotMatch(
    workflow,
    /^\s*intent\s/u,
    "workflow commands must pin current Intent through pnpm dlx rather than a global binary",
  );
  for (const command of [
    "pnpm dlx @tanstack/intent@latest validate packages/table/skills --check --github-summary",
    "pnpm dlx @tanstack/intent@latest list --json",
    "pnpm dlx @tanstack/intent@latest load @bruno/table#define-columns --json",
    'pnpm dlx @tanstack/intent@latest stale --github-review --package-label "shadcn-table"',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll("/", "\\/")));
  }
});

void test("keeps current Intent validation read-only and passes event data without shell interpolation", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/check-skills.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /^permissions:\n  contents: write\n  pull-requests: write$/m);
  assert.match(
    workflow,
    /review:\n(?:.|\n)*?permissions:\n      contents: write\n      pull-requests: write/u,
  );
  assert.equal(
    [...workflow.matchAll(/uses: actions\/checkout@/g)].length,
    [...workflow.matchAll(/uses: actions\/checkout@([0-9a-f]{40})/g)].length,
    "every checkout must be pinned to an immutable commit",
  );
  assert.equal(
    [...workflow.matchAll(/uses: actions\/setup-node@/g)].length,
    [...workflow.matchAll(/uses: actions\/setup-node@([0-9a-f]{40})/g)].length,
    "every setup-node use must be pinned to an immutable commit",
  );
  assert.equal(
    [...workflow.matchAll(/persist-credentials: false/g)].length,
    [...workflow.matchAll(/uses: actions\/checkout@/g)].length,
    "no checkout may persist a repository credential",
  );
  assert.doesNotMatch(workflow, /VERSION="\$\{\{/u);
  assert.doesNotMatch(workflow, /BASE_BRANCH="\$\{\{/u);
  assert.match(
    workflow,
    /^          RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \|\| 'manual' \}\}$/m,
  );
  assert.match(
    workflow,
    /^          DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}$/m,
  );
});

void test("never executes current Intent inside a write-permission workflow job", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/check-skills.yml", import.meta.url),
    "utf8",
  );
  const jobsStart = workflow.indexOf("\njobs:\n");
  assert.notEqual(jobsStart, -1, "workflow must declare jobs");
  const jobs = workflow.slice(jobsStart + 1);
  const starts = [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)];
  const jobBlocks = starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? jobs.length;
    return jobs.slice(start, end);
  });
  const writeJobs = jobBlocks.filter((job) =>
    /permissions:\n(?: {6}.+\n)* {6}(?:contents|pull-requests): write$/m.test(job),
  );

  assert.ok(writeJobs.length > 0, "workflow must retain a narrowly scoped publication job");
  for (const job of writeJobs) {
    assert.doesNotMatch(
      job,
      /@tanstack\/intent@latest/u,
      "write-permission jobs must not execute registry-current Intent code",
    );
    assert.doesNotMatch(
      job,
      /\b(?:pnpm|npm|npx)\s+(?:dlx|exec|install)\b/u,
      "write-permission jobs must not execute package-manager dependency code",
    );
  }
});

void test("isolates current Intent compatibility from authoritative validation", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/check-skills.yml", import.meta.url),
    "utf8",
  );
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n") + 1);
  const starts = [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)];
  const blocks = new Map(
    starts.map((match, index) => {
      const start = match.index ?? 0;
      const end = starts[index + 1]?.index ?? jobs.length;
      return [match[1], jobs.slice(start, end)];
    }),
  );
  const compatibility = blocks.get("compatibility") ?? "";
  const authoritative = blocks.get("validate") ?? "";
  const reviewState = blocks.get("review-state") ?? "";

  assert.match(compatibility, /@tanstack\/intent@latest/u);
  assert.match(reviewState, /@tanstack\/intent@latest/u);
  assert.doesNotMatch(authoritative, /@tanstack\/intent@latest/u);
  assert.match(authoritative, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.match(authoritative, /pnpm run test:skills/u);
  assert.match(authoritative, /permissions:\n      contents: read/u);

  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(
    packageJson.scripts?.["test:skills"] ?? "",
    /&& node scripts\/assert-intent-staleness\.mjs &&/u,
  );
  assert.doesNotMatch(
    packageJson.scripts?.["test:skills"] ?? "",
    /intent stale \. --json\s*\|/u,
    "Intent stale failures must not be masked by a shell pipeline",
  );
});
