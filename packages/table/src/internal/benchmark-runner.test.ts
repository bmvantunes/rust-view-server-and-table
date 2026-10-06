import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

test("the benchmark command fails closed when warmup produces no measurements", () => {
  const result = spawnSync(
    "vp",
    [
      "test",
      "bench",
      "--run",
      "--config",
      "scripts/fixtures/runner.config.ts",
      "-t",
      "warmup failure",
    ],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 20_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain("Benchmark measurements missing");
}, 25_000);

test("the benchmark command accepts measurements and ignores filtered-out benchmarks", () => {
  const result = spawnSync(
    "vp",
    [
      "test",
      "bench",
      "--run",
      "--config",
      "scripts/fixtures/runner.config.ts",
      "-t",
      "measured success",
    ],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 20_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 25_000);
