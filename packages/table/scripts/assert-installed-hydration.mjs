import { cp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isolatedProcessEnvironment } from "../../../config/isolated-process-environment.mjs";
import assert from "node:assert/strict";

export async function assertInstalledHydration(consumerRoot) {
  await cp(new URL("./fixtures/packed-consumer/", import.meta.url), consumerRoot, {
    recursive: true,
  });
  const negative = spawnSync("pnpm", ["exec", "vp", "build", "--config", "consumer.config.ts"], {
    cwd: consumerRoot,
    encoding: "utf8",
    env: { ...isolatedProcessEnvironment(consumerRoot), BRUNO_COMPILER_NEGATIVE_CONTROL: "1" },
  });
  assert.notEqual(negative.status, 0, "Disabling the consumer Compiler must fail the build guard");
  assert.match(
    `${negative.stdout}${negative.stderr}`,
    /Installed consumer App did not pass through React Compiler/u,
  );
  process.stdout.write(
    "Compiler-disabled negative control failed at the required consumer transform guard.\n",
  );
  for (const args of [
    ["exec", "vp", "build", "--config", "consumer.config.ts"],
    [
      "exec",
      "vp",
      "build",
      "--config",
      "consumer.config.ts",
      "--ssr",
      "server.tsx",
      "--outDir",
      "ssr",
    ],
    ["exec", "node", "ssr/server.js"],
    ["exec", "vp", "test", "--config", "consumer.config.ts", "--run"],
  ]) {
    const result = spawnSync("pnpm", args, {
      cwd: consumerRoot,
      encoding: "utf8",
      env: isolatedProcessEnvironment(consumerRoot),
    });
    if (result.status !== 0) {
      throw new Error(
        `Installed SSR/Compiler/hydration consumer failed in ${consumerRoot}:\n${result.stdout}\n${result.stderr}`,
      );
    }
    process.stdout.write(result.stdout);
  }
}
