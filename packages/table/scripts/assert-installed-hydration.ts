import { cp, readFile, writeFile } from "node:fs/promises";
import { command } from "../../../scripts/common.ts";
import { isolatedProcessEnvironment } from "../../../config/isolated-process-environment.ts";
import assert from "node:assert/strict";
import { join } from "node:path";

export async function prepareInstalledHydration(consumerRoot: string) {
  await cp(new URL("./fixtures/packed-consumer/", import.meta.url), consumerRoot, {
    recursive: true,
  });
  // Relocate the checked shared compiler implementation into the isolated
  // installed consumer; it must not resolve a parent checkout at runtime.
  for (const name of ["react-compiler.ts", "react-compiler-options.ts"]) {
    await cp(new URL(`../../../config/${name}`, import.meta.url), join(consumerRoot, name));
  }
  const configPath = join(consumerRoot, "consumer.config.ts");
  const config = await readFile(configPath, "utf8");
  const sharedCompiler = "../../../../../config/react-compiler.ts";
  assert.equal(
    config.split(sharedCompiler).length,
    2,
    "Expected exactly one shared compiler import",
  );
  await writeFile(configPath, config.replace(sharedCompiler, "./react-compiler.ts"));
}

export async function assertInstalledHydration(consumerRoot: string, signal?: AbortSignal) {
  await prepareInstalledHydration(consumerRoot);
  const negative = await command(["vp", "build", "--config", "consumer.config.ts"], {
    cwd: consumerRoot,
    timeoutMs: 180000,
    signal,
    check: false,
    env: { ...isolatedProcessEnvironment(consumerRoot), BRUNO_COMPILER_NEGATIVE_CONTROL: "1" },
  });
  assert.notEqual(negative.code, 0, "Disabling the consumer Compiler must fail the build guard");
  assert.match(
    `${negative.stdout}${negative.stderr}`,
    /Installed consumer App did not pass through React Compiler/u,
  );
  process.stdout.write(
    "Compiler-disabled negative control failed at the required consumer transform guard.\n",
  );
  for (const args of [
    ["build", "--config", "consumer.config.ts"],
    ["build", "--config", "consumer.config.ts", "--ssr", "server.tsx", "--outDir", "ssr"],
    ["exec", "node", "ssr/server.js"],
    ["test", "--config", "consumer.config.ts", "--run"],
  ]) {
    const result = await command(["vp", ...args], {
      cwd: consumerRoot,
      timeoutMs: 180000,
      signal,
      check: false,
      env: isolatedProcessEnvironment(consumerRoot),
    });
    if (result.code !== 0) {
      throw new Error(
        `Installed SSR/Compiler/hydration consumer failed in ${consumerRoot}:\n${result.stdout}\n${result.stderr}`,
      );
    }
    process.stdout.write(result.stdout);
  }
}
