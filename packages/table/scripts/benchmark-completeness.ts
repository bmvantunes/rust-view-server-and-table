import type { Reporter } from "vitest/reporters";
import type { Vitest } from "vitest/node";

// Vitest 4 / Tinybench 2 can swallow a warmup error and leave the benchmark
// running without measurements. Fail closed until the upstream runner fixes it.
// Version-sensitive Vitest 4.1.10 contract: onTestRunEnd, Vitest.state.idMap,
// and BenchmarkResult.sampleCount plus its inherited mean field. Revalidate
// these APIs whenever Vitest is upgraded.
export default class BenchmarkCompletenessReporter implements Reporter {
  private context?: Vitest;

  onInit(context: Vitest): void {
    this.context = context;
  }

  onTestRunEnd: NonNullable<Reporter["onTestRunEnd"]> = (modules) => {
    for (const module of modules) {
      for (const test of module.children.allTests()) {
        if (!test.meta().benchmark || test.result().state === "skipped") continue;
        const task = this.context?.state.idMap.get(test.id);
        const result = task?.result?.benchmark;
        if (
          task?.result?.state !== "pass" ||
          result === undefined ||
          !Number.isInteger(result.sampleCount) ||
          result.sampleCount < 1 ||
          !Number.isFinite(result.mean)
        ) {
          throw new Error(`Benchmark measurements missing or invalid: ${test.fullName}`);
        }
      }
    }
  };
}
