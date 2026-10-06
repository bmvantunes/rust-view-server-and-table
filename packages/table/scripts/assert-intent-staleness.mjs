import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertNoIntentStalenessReports } from "./agent-skills-contract.mjs";

function processText(value) {
  return typeof value === "string" ? value : (value?.toString("utf8") ?? "");
}

export function runIntentStalenessValidation({ run = spawnSync } = {}) {
  const result = run("intent", ["stale", ".", "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = processText(result.stderr).trim();
  if (result.error !== undefined) {
    throw new Error("Intent stale could not start.", { cause: result.error });
  }
  if (result.signal !== null && result.signal !== undefined) {
    throw new Error(
      `Intent stale terminated by signal ${result.signal}.${stderr === "" ? "" : `\n${stderr}`}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Intent stale exited with status ${String(result.status)}.${stderr === "" ? "" : `\n${stderr}`}`,
    );
  }

  let reports;
  try {
    reports = JSON.parse(processText(result.stdout));
  } catch (error) {
    throw new Error("Intent stale did not produce valid JSON.", { cause: error });
  }
  assertNoIntentStalenessReports(reports);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runIntentStalenessValidation();
}
