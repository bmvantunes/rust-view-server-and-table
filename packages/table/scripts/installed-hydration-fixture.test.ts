import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertInstalledHydration,
  prepareInstalledHydration,
} from "./assert-installed-hydration.ts";

test("installed hydration carries the exact checked compiler into its isolated root", async (t) => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "bruno-installed-fixture-"));
  t.after(() => rm(consumerRoot, { recursive: true, force: true }));
  await prepareInstalledHydration(consumerRoot);
  const config = await readFile(join(consumerRoot, "consumer.config.ts"), "utf8");
  assert.match(config, /from "\.\/react-compiler\.ts"/u);
  assert.doesNotMatch(config, /(?:\.\.\/)+config\/react-compiler/u);
  assert.match(config, /BRUNO_COMPILER_NEGATIVE_CONTROL/u);
  for (const name of ["react-compiler.ts", "react-compiler-options.ts"]) {
    assert.equal(
      await readFile(join(consumerRoot, name), "utf8"),
      await readFile(new URL(`../../../config/${name}`, import.meta.url), "utf8"),
    );
  }
  assert.match(
    await readFile(join(consumerRoot, "hydration.browser.test.tsx"), "utf8"),
    /onRecoverableError/u,
  );
});

test("cancelled hydration cannot satisfy the compiler-disabled negative control", async (t) => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "bruno-cancelled-fixture-"));
  t.after(() => rm(consumerRoot, { recursive: true, force: true }));
  await assert.rejects(
    assertInstalledHydration(consumerRoot, AbortSignal.abort()),
    /Command interrupted before spawn/u,
  );
});
