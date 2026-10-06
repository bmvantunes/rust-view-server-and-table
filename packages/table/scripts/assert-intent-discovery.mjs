import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BRUNO_TABLE_PACKAGED_SKILL_FILES,
  assertExpectedIntentDiscovery,
} from "./agent-skills-contract.mjs";

const [listingPath, loadedPath] = process.argv.slice(2);
if (!listingPath || !loadedPath) {
  throw new Error("usage: assert-intent-discovery.mjs <list.json> <load.json>");
}

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
const [listing, loaded, expectedLoadedContent, expectedPackageRoot] = await Promise.all([
  readFile(listingPath, "utf8").then(JSON.parse),
  readFile(loadedPath, "utf8").then(JSON.parse),
  readFile(resolve(packageDir, "skills/define-columns/SKILL.md"), "utf8"),
  realpath(packageDir),
]);
const normalizeRoot = async (root) => {
  try {
    return await realpath(root);
  } catch {
    return root;
  }
};
const normalizedListing = {
  ...listing,
  skills: await Promise.all(
    (listing.skills ?? []).map(async (skill) => ({
      ...skill,
      packageRoot: await normalizeRoot(skill.packageRoot),
    })),
  ),
};
const normalizedLoaded = {
  ...loaded,
  packageRoot: await normalizeRoot(loaded.packageRoot),
};
const expectedUses = BRUNO_TABLE_PACKAGED_SKILL_FILES.filter((path) => path.endsWith("/SKILL.md"))
  .map((path) => path.split("/").at(-2))
  .map((skill) => `@bruno/table#${skill}`);

assertExpectedIntentDiscovery({
  // Intent resolves relative Markdown links against the workspace root during load.
  // Keep the rest of the guidance byte-exact, including each link's label.
  expectedLoadedContent: expectedLoadedContent
    .replaceAll(
      "(../references/docs/grid/public-api-design.md)",
      "(packages/table/skills/references/docs/grid/public-api-design.md)",
    )
    .replaceAll(
      "(../references/packages/table/README.md)",
      "(packages/table/skills/references/packages/table/README.md)",
    ),
  expectedPackageRoot,
  expectedUses,
  expectedVersion: packageJson.version,
  listing: normalizedListing,
  loaded: normalizedLoaded,
});
