import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const [entryName, source, expected] of [
  [
    "index",
    'export const diagnostic = "BRUNO_TABLE_GESTURE_TIMING_DIAGNOSTIC_V1";',
    /production package contains test-only/u,
  ],
  [
    "effect",
    'export const diagnostic = "BRUNO_TABLE_TEST_LISTENER_DIAGNOSTIC_V1";',
    /production package contains test-only/u,
  ],
  [
    "index",
    "export const unresolved = typeof __BRUNO_TABLE_DEVELOPMENT__;",
    /unresolved build flag/u,
  ],
  [
    "effect",
    'export function rawKeyboard() { window.addEventListener("keydown", () => {}); }',
    /violates the BrunoTable keyboard boundary/u,
  ],
  [
    "effect",
    'export function rawText() { window.addEventListener("beforeinput", () => {}); }',
    /escaped the emitted produced-text installer/u,
  ],
]) {
  await test(`the package validator rejects transitive leaks from ${entryName}: ${source}`, async () => {
    // Only generated output in this isolated task worktree is changed. Restore the
    // exact entry bytes even if the child validator or the assertion fails.
    const entry = new URL(`../dist/${entryName}.mjs`, import.meta.url);
    const original = await readFile(entry, "utf8");
    const directory = await mkdtemp(new URL("../dist/contract-", import.meta.url));
    const relative = directory.slice(fileURLToPath(new URL("../dist/", import.meta.url)).length);
    const bridge = new URL(`../dist/${relative}-bridge.mjs`, import.meta.url);
    const leak = new URL(`../dist/${relative}-leak.mjs`, import.meta.url);
    try {
      await writeFile(
        bridge,
        entryName === "effect"
          ? `export const load = () => import(\`./${relative}-leak.mjs\`);\n`
          : `export * from "./${relative}-leak.mjs";\n`,
      );
      await writeFile(leak, `import "./${relative}-bridge.mjs";\n${source}`);
      await writeFile(entry, `${original}\nimport "./${relative}-bridge.mjs";\n`);
      const result = spawnSync(process.execPath, ["scripts/assert-build-output.mjs"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
      });
      assert.notEqual(
        result.status,
        0,
        "A diagnostic in a transitive runtime chunk must fail validation",
      );
      assert.match(`${result.stdout}${result.stderr}`, expected);
    } finally {
      await writeFile(entry, original);
      await rm(bridge, { force: true });
      await rm(leak, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
}
