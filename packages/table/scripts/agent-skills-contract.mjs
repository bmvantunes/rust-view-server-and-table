import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_PREFIX = "bmvantunes/shadcn-table:";

export const BRUNO_TABLE_PACKAGED_SKILL_FILES = Object.freeze([
  "skills/choose-row-model/SKILL.md",
  "skills/define-columns/SKILL.md",
  "skills/edit-cells/SKILL.md",
  "skills/references/docs/adr/0001-require-explicit-column-identity.md",
  "skills/references/docs/adr/0002-expose-client-and-server-table-variants.md",
  "skills/references/docs/adr/0021-use-repetition-only-drag-fill.md",
  "skills/references/docs/adr/0022-reconcile-void-save-operations-through-live-source.md",
  "skills/references/docs/adr/0032-project-edit-review-rows-through-a-consumer-seam.md",
  "skills/references/docs/grid/editing-and-conflicts.md",
  "skills/references/docs/grid/public-api-design.md",
  "skills/references/docs/grid/requirements.md",
  "skills/references/docs/grid/research/editable-safety-ui-prototype.md",
  "skills/references/docs/grid/research/reui-data-grid-patterns.md",
  "skills/references/docs/grid/research/strict-column-api-prototype.md",
  "skills/references/docs/grid/server-viewport-model.md",
  "skills/references/packages/table/README.md",
  "skills/sync-state.json",
]);

export const BRUNO_TABLE_EXPECTED_INTENT_SKILL_NAMES = Object.freeze(
  BRUNO_TABLE_PACKAGED_SKILL_FILES.flatMap((path) => {
    const match = path.match(/^skills\/([^/]+)\/SKILL\.md$/u);
    return match?.[1] === undefined ? [] : [match[1]];
  }).sort((left, right) => left.localeCompare(right)),
);

function readQuotedScalar(line, field) {
  const match = line.match(new RegExp(`^\\s*${field}:\\s*['"]?([^'"]+)['"]?\\s*$`));
  return match?.[1]?.trim();
}

function parseSkillFrontmatter(text, label) {
  const end = text.indexOf("\n---", 4);
  if (!text.startsWith("---\n") || end === -1) {
    throw new Error(`${label}: missing YAML frontmatter`);
  }
  const lines = text.slice(4, end).split("\n");
  const name = lines.map((line) => readQuotedScalar(line, "name")).find(Boolean);
  const libraryVersion = lines
    .map((line) => readQuotedScalar(line, "library_version"))
    .find(Boolean);
  const skillVersion = lines.map((line) => readQuotedScalar(line, "skill_version")).find(Boolean);
  const sources = [];
  let inSources = false;
  for (const line of lines) {
    if (/^sources:\s*$/.test(line)) {
      inSources = true;
      continue;
    }
    if (inSources && /^\S/.test(line)) inSources = false;
    if (!inSources) continue;
    const source = line.match(/^\s+-\s+['"]?([^'"]+)['"]?\s*$/)?.[1]?.trim();
    if (source) sources.push(source);
  }
  if (!name || !libraryVersion || !skillVersion || sources.length === 0) {
    throw new Error(`${label}: incomplete version or source metadata`);
  }
  return { libraryVersion, name, skillVersion, sources };
}

async function findSkillFiles(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === "SKILL.md") found.push(path);
    }
  }
  await visit(root);
  return found.sort((left, right) => left.localeCompare(right));
}

function safeSourcePath(repoRoot, source, label) {
  if (!source.startsWith(SOURCE_PREFIX)) {
    throw new Error(`${label}: unsupported source authority: ${source}`);
  }
  const path = resolve(repoRoot, source.slice(SOURCE_PREFIX.length));
  const relativePath = relative(resolve(repoRoot), path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label}: source escapes the repository: ${source}`);
  }
  return path;
}

function packagedSourcePath(packageDir, repoRoot, source, label) {
  const sourcePath = safeSourcePath(repoRoot, source, label);
  const repositoryRelativePath = relative(resolve(repoRoot), sourcePath);
  const referencesRoot = resolve(packageDir, "skills/references");
  const path = resolve(referencesRoot, repositoryRelativePath);
  const relativePath = relative(referencesRoot, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label}: packaged source escapes the references directory: ${source}`);
  }
  return path;
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function validateSourceAcknowledgements({ packageDir, repoRoot }) {
  const skillsRoot = join(packageDir, "skills");
  const [packageJson, syncState, skillFiles] = await Promise.all([
    readFile(join(packageDir, "package.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({ version: undefined })),
    readFile(join(skillsRoot, "sync-state.json"), "utf8").then(JSON.parse),
    findSkillFiles(skillsRoot),
  ]);
  const failures = [];
  const seen = new Set();
  if (syncState.version !== 1) failures.push("sync-state.json: unsupported version");
  if (packageJson.version !== undefined && syncState.library_version !== packageJson.version) {
    failures.push("sync-state.json: library version does not match package.json");
  }
  for (const file of skillFiles) {
    const relativeSkill = relative(skillsRoot, dirname(file)).split(sep).join("/");
    const metadata = parseSkillFrontmatter(await readFile(file, "utf8"), relativeSkill);
    seen.add(relativeSkill);
    if (metadata.name !== relativeSkill.split("/").at(-1)) {
      failures.push(`${relativeSkill}: name does not match its directory`);
    }
    const acknowledgement = syncState.skills?.[relativeSkill];
    if (!acknowledgement) {
      failures.push(`${relativeSkill}: missing sync-state acknowledgement`);
      continue;
    }
    if (
      metadata.libraryVersion !== syncState.library_version ||
      metadata.skillVersion !== acknowledgement.skill_version
    ) {
      failures.push(`${relativeSkill}: version metadata does not match sync-state.json`);
    }
    if (Object.hasOwn(acknowledgement, "sources_sha256")) {
      failures.push(`${relativeSkill}: unsupported parallel sources_sha256 authority`);
    }
    const acknowledgedSources = acknowledgement.sources_sha ?? {};
    const actualSourceSet = new Set(metadata.sources);
    for (const acknowledged of Object.keys(acknowledgedSources)) {
      if (!actualSourceSet.has(acknowledged)) {
        failures.push(`${relativeSkill}: obsolete source acknowledgement: ${acknowledged}`);
      }
    }
    for (const source of metadata.sources) {
      const path = safeSourcePath(repoRoot, source, relativeSkill);
      let currentHash;
      try {
        currentHash = await sha256(path);
      } catch {
        failures.push(`${relativeSkill}: authoritative source is missing: ${source}`);
        continue;
      }
      if (acknowledgedSources[source] !== currentHash) {
        failures.push(`${relativeSkill}: source changed without acknowledgement: ${source}`);
      }
      let packagedHash;
      try {
        packagedHash = await sha256(
          packagedSourcePath(packageDir, repoRoot, source, relativeSkill),
        );
      } catch {
        failures.push(`${relativeSkill}: packaged source is missing: ${source}`);
        continue;
      }
      if (packagedHash !== currentHash) {
        failures.push(`${relativeSkill}: packaged source differs from authority: ${source}`);
      }
    }
  }
  for (const skill of Object.keys(syncState.skills ?? {})) {
    if (!seen.has(skill)) failures.push(`${skill}: acknowledgement has no SKILL.md`);
  }
  return failures.sort();
}

export function collectPackagedSkillFiles(files) {
  return files
    .map(({ path }) => path.replace(/^package\//, ""))
    .filter((path) => path.startsWith("skills/"))
    .sort();
}

export function assertExactPackagedSkillFiles(files) {
  const actual = [...files].sort((left, right) => left.localeCompare(right));
  const expected = BRUNO_TABLE_PACKAGED_SKILL_FILES;
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;

  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((path) => !actualSet.has(path));
  const unexpected = actual.filter((path, index) => {
    return !expectedSet.has(path) || actual.indexOf(path) !== index;
  });
  throw new Error(
    [
      "Published BrunoTable Agent Skill resources differ from the reviewed allowlist.",
      `missing: ${missing.join(", ") || "none"}`,
      `unexpected: ${unexpected.join(", ") || "none"}`,
    ].join(" "),
  );
}

export function assertExpectedIntentDiscovery({
  expectedLoadedContent,
  expectedPackageRoot,
  expectedUses,
  expectedVersion,
  listing,
  loaded,
}) {
  if (!Array.isArray(listing?.conflicts) || listing.conflicts.length > 0) {
    throw new Error("ambiguous @bruno/table discovery");
  }
  const discovered = (listing.skills ?? [])
    .filter((skill) => skill.packageName === "@bruno/table")
    .sort((left, right) => left.use.localeCompare(right.use));
  const actualUses = discovered.map((skill) => skill.use);
  const sortedExpectedUses = [...expectedUses].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualUses) !== JSON.stringify(sortedExpectedUses)) {
    throw new Error(`unexpected @bruno/table skills: ${actualUses.join(", ") || "none"}`);
  }
  for (const skill of discovered) {
    if (skill.packageRoot !== expectedPackageRoot) {
      throw new Error(`unexpected package root for ${skill.use}: ${skill.packageRoot}`);
    }
    if (skill.packageVersion !== expectedVersion) {
      throw new Error(`unexpected package version for ${skill.use}: ${skill.packageVersion}`);
    }
  }
  if (loaded?.conflict) throw new Error("ambiguous loaded @bruno/table skill");
  if (loaded?.package !== "@bruno/table" || loaded.skill !== "define-columns") {
    throw new Error("current Intent loaded an unexpected skill");
  }
  if (loaded.packageRoot !== expectedPackageRoot) {
    throw new Error(`unexpected package root for loaded skill: ${loaded.packageRoot}`);
  }
  if (loaded.version !== expectedVersion) {
    throw new Error(`unexpected package version for loaded skill: ${loaded.version}`);
  }
  if (loaded.content !== expectedLoadedContent) {
    throw new Error("current Intent loaded guidance differs from the authoritative skill");
  }
}

export function assertNoIntentStalenessReports(reports) {
  const malformed = (detail) => {
    throw new Error(`Intent staleness output is uncertain or malformed: ${detail}.`);
  };
  const normalizedString = (value) =>
    typeof value === "string" && value.length > 0 && value.trim() === value;
  const validReasons = (value) =>
    Array.isArray(value) && value.every((reason) => normalizedString(reason));
  const hasOnlyOwnKeys = (value, expectedKeys) =>
    Object.keys(value).every((key) => expectedKeys.includes(key));
  const nullableString = (value) => value === null || normalizedString(value);
  const validVersionDrift = (value) =>
    value === null || value === "major" || value === "minor" || value === "patch";
  if (!Array.isArray(reports) || reports.length === 0) {
    malformed("expected at least one package report");
  }
  if (reports.length !== 1 || reports[0]?.library !== "@bruno/table") {
    malformed("expected exactly one @bruno/table package report");
  }
  const reviewItems = [];
  for (const [reportIndex, report] of reports.entries()) {
    if (
      typeof report !== "object" ||
      report === null ||
      !hasOnlyOwnKeys(report, [
        "library",
        "currentVersion",
        "skillVersion",
        "versionDrift",
        "skills",
        "signals",
      ]) ||
      !normalizedString(report.library) ||
      !nullableString(report.currentVersion) ||
      !nullableString(report.skillVersion) ||
      !validVersionDrift(report.versionDrift) ||
      !Array.isArray(report.skills) ||
      !Array.isArray(report.signals)
    ) {
      malformed(`invalid package report at index ${String(reportIndex)}`);
    }
    const library = report.library;
    const reportedSkillNames = [];
    for (const [skillIndex, skill] of report.skills.entries()) {
      if (
        typeof skill !== "object" ||
        skill === null ||
        !hasOnlyOwnKeys(skill, ["name", "needsReview", "reasons"]) ||
        !normalizedString(skill.name) ||
        typeof skill.needsReview !== "boolean" ||
        !validReasons(skill.reasons)
      ) {
        malformed(`invalid skill report at ${library}[${String(skillIndex)}]`);
      }
      reportedSkillNames.push(skill.name);
      if (!skill.needsReview) continue;
      const name = skill.name;
      const reasons = skill.reasons.join("; ") || "review required";
      reviewItems.push(`${library}#${name}: ${reasons}`);
    }
    for (const [signalIndex, signal] of report.signals.entries()) {
      if (
        typeof signal !== "object" ||
        signal === null ||
        !hasOnlyOwnKeys(signal, ["type", "subject", "needsReview", "reasons"]) ||
        !normalizedString(signal.type) ||
        !normalizedString(signal.subject) ||
        typeof signal.needsReview !== "boolean" ||
        !validReasons(signal.reasons)
      ) {
        malformed(`invalid signal report at ${library}[${String(signalIndex)}]`);
      }
      if (!signal.needsReview) continue;
      const type = signal.type;
      const subject = signal.subject;
      const reasons = signal.reasons.join("; ") || "review required";
      reviewItems.push(`${type} for ${subject}: ${reasons}`);
    }
    const sortedSkillNames = reportedSkillNames.toSorted((left, right) =>
      left.localeCompare(right),
    );
    if (
      JSON.stringify(sortedSkillNames) !== JSON.stringify(BRUNO_TABLE_EXPECTED_INTENT_SKILL_NAMES)
    ) {
      malformed(`unexpected skill topology for ${library}`);
    }
  }
  if (reviewItems.length > 0) {
    throw new Error(`Intent staleness requires review:\n${reviewItems.join("\n")}`);
  }
}

async function main() {
  const modulePath = fileURLToPath(import.meta.url);
  const packageDir = resolve(dirname(modulePath), "..");
  const repoRoot = resolve(packageDir, "../..");
  const failures = await validateSourceAcknowledgements({ packageDir, repoRoot });
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
