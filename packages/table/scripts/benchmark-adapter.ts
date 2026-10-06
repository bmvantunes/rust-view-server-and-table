import { test, type BenchFn, type BenchFnOptions, type BenchRunOptions } from "vite-plus/test";

// Keep the retained workload definitions and budgets while using Vitest 5's
// contextual benchmark API. Each case owns and validates its fresh measurements.
export function bench(name: string, run: BenchFn, options: BenchFnOptions & BenchRunOptions = {}): void {
  test(name, async ({ bench: measure }) => {
    try {
      const result = await measure(name, options, run).run(options);
      if (!Number.isInteger(result.latency.samplesCount) || result.latency.samplesCount < 1 || !Number.isFinite(result.latency.mean)) {
        throw new Error("No finite samples were produced");
      }
    } catch (cause) {
      throw new Error(`Benchmark measurements missing or invalid: ${name}`, { cause });
    }
  });
}
