import { describe, expect, it } from "vitest";

import {
  accumulateBrunoTableBenchmarkFrameCallbackWork,
  assertBrunoTableBenchmarkBudget,
  captureBrunoTableReactCommitWork,
  combineBrunoTableBenchmarkFrameWork,
  distributeBrunoTableReactCommitWork,
  finalizeBrunoTableBenchmarkEvidence,
  summarizeBrunoTableBenchmarkBudget,
} from "./benchmark-budget";
import {
  installBrunoTableBenchmarkEnvironment,
  validateBrunoTableBenchmarkEnvironment,
} from "./benchmark-profile";

const benchmarkEnvironment = installBrunoTableBenchmarkEnvironment({
  browserEngine: "chromium",
  devicePixelRatio: 1,
  logicalProcessorCount: 10,
  mode: "production",
  userAgent: "Mozilla/5.0 HeadlessChrome/145.0.0.0 Safari/537.36",
  viewport: { height: 900, width: 1440 },
});

describe("BrunoTable benchmark budget sampling", () => {
  it("charges React render and commit-phase CPU exactly once", () => {
    expect(
      captureBrunoTableReactCommitWork({
        actualDurationMs: 6,
        commitTimeMs: 20,
        observedAtMs: 24,
        startTimeMs: 10,
      }),
    ).toEqual({ commitTimeMs: 20, durationMs: 10, startTimeMs: 10 });
  });

  it("sums gesture and viewport callbacks that share one animation frame", () => {
    const durations = new Map<number, number>();

    accumulateBrunoTableBenchmarkFrameCallbackWork(durations, 10, 3);
    accumulateBrunoTableBenchmarkFrameCallbackWork(durations, 10, 6);

    expect(durations.get(10)).toBe(9);
  });

  it("charges one React commit to its single owning animation frame", () => {
    expect(
      distributeBrunoTableReactCommitWork(
        [10, 20, 30],
        [{ durationMs: 6, commitTimeMs: 11, startTimeMs: 9 }],
      ),
    ).toEqual([6, 0, 0]);
  });

  it("charges yielded concurrent React work without diluting a concentrated burst", () => {
    const distributed = distributeBrunoTableReactCommitWork(
      [10, 20, 30],
      [
        { durationMs: 9, commitTimeMs: 31, startTimeMs: 9 },
        { durationMs: 6, commitTimeMs: 21, startTimeMs: 19 },
      ],
    );

    expect(distributed).toEqual([0, 6, 9]);
    expect(distributed.reduce((total, duration) => total + duration, 0)).toBe(15);
  });

  it("charges commits between sampled frames to the nearest presentation boundary", () => {
    expect(
      distributeBrunoTableReactCommitWork(
        [10, 20, 30],
        [
          { durationMs: 4, commitTimeMs: 18, startTimeMs: 12 },
          { durationMs: 5, commitTimeMs: 40, startTimeMs: 35 },
        ],
      ),
    ).toEqual([0, 4, 5]);
  });

  it("sums non-overlapping frame phases while deduplicating nested React work", () => {
    expect(
      combineBrunoTableBenchmarkFrameWork({
        admissionDurationMs: 5,
        presentationFrame: { callbackDurationMs: 2, reactDurationMs: 6 },
        renderedFrame: { callbackDurationMs: 4, reactDurationMs: 3 },
      }),
    ).toBe(15);
  });

  it("summarizes measured samples without including warmups", () => {
    const samples = [999, 5, 1, 4, 2, 3];

    const summary = summarizeBrunoTableBenchmarkBudget(samples, {
      budgetMs: 3,
      measuredSampleCount: 5,
      warmupSampleCount: 1,
    });

    expect(summary).toEqual({
      budget: 3,
      max: 5,
      min: 1,
      overBudgetSampleCount: 2,
      p50: 3,
      p95: 5,
      p99: 5,
      sampleCount: 5,
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(samples).toEqual([999, 5, 1, 4, 2, 3]);
  });

  it("returns no summary and asserts nothing until collection is complete", () => {
    const options = {
      budgetMs: 8.33,
      measuredSampleCount: 2,
      warmupSampleCount: 1,
    } as const;

    expect(summarizeBrunoTableBenchmarkBudget([100, 100], options)).toBeUndefined();
    expect(() => assertBrunoTableBenchmarkBudget("incomplete", [100, 100], options)).not.toThrow();
  });

  it("rejects benchmark options that could disable or change the declared gate", () => {
    const valid = {
      budgetMs: 8.33,
      measuredSampleCount: 100,
      warmupSampleCount: 2,
    } as const;

    for (const warmupSampleCount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => summarizeBrunoTableBenchmarkBudget([], { ...valid, warmupSampleCount })).toThrow(
        "warmupSampleCount must be a non-negative safe integer",
      );
    }
    for (const measuredSampleCount of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        summarizeBrunoTableBenchmarkBudget([], { ...valid, measuredSampleCount }),
      ).toThrow("measuredSampleCount must be a positive safe integer");
    }
    for (const budgetMs of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => summarizeBrunoTableBenchmarkBudget([], { ...valid, budgetMs })).toThrow(
        "budgetMs must be a finite non-negative number",
      );
    }
    expect(() =>
      summarizeBrunoTableBenchmarkBudget([], {
        ...valid,
        measuredSampleCount: Number.MAX_SAFE_INTEGER,
        warmupSampleCount: 1,
      }),
    ).toThrow("total sample count must be a safe integer");
  });

  it("rejects a completed collection with non-finite measured samples", () => {
    const options = {
      budgetMs: 8.33,
      measuredSampleCount: 2,
      warmupSampleCount: 1,
    } as const;

    expect(() => summarizeBrunoTableBenchmarkBudget([999, 1, Number.NaN], options)).toThrow(
      "Completed BrunoTable benchmark samples must be finite non-negative numbers.",
    );
    expect(summarizeBrunoTableBenchmarkBudget([Number.NaN, 1, 1], options)).toEqual({
      budget: 8.33,
      sampleCount: 2,
      min: 1,
      p50: 1,
      p95: 1,
      p99: 1,
      max: 1,
      overBudgetSampleCount: 0,
    });
    expect(() => summarizeBrunoTableBenchmarkBudget([999, 1, -0.01], options)).toThrow(
      "Completed BrunoTable benchmark samples must be finite non-negative numbers.",
    );
  });

  it("uses nearest-rank percentiles and counts every over-budget sample", () => {
    const samples = Array.from({ length: 100 }, (_unused, index) => index + 1);

    expect(
      summarizeBrunoTableBenchmarkBudget(samples, {
        budgetMs: 8.33,
        measuredSampleCount: 100,
        warmupSampleCount: 0,
      }),
    ).toMatchObject({
      overBudgetSampleCount: 92,
      p50: 50,
      p95: 95,
      p99: 99,
    });
    expect(
      summarizeBrunoTableBenchmarkBudget([8.33, 8.34], {
        budgetMs: 8.33,
        measuredSampleCount: 2,
        warmupSampleCount: 0,
      }),
    ).toMatchObject({ overBudgetSampleCount: 1, p50: 8.33, p95: 8.34, p99: 8.34 });
  });

  it("finalizes an exact immutable scenario and capable-hardware profile artifact", () => {
    const evidence = finalizeBrunoTableBenchmarkEvidence(
      [...Array<number>(12).fill(999), 9, ...Array<number>(99).fill(1)],
      {
        budgetMs: 8.33,
        droppedFrameThresholdMs: 16.66,
        environment: benchmarkEnvironment,
        maxDroppedFrameCount: 0,
        measuredSampleCount: 100,
        profile: "chromium-capable-hardware-v1",
        scenario: "client-scroll-5000x150",
        warmupSampleCount: 12,
      },
    );

    expect(evidence).toEqual({
      droppedFrames: {
        comparison: "measured sample > thresholdMs",
        count: 0,
        maxCount: 0,
        thresholdMs: 16.66,
      },
      environment: benchmarkEnvironment,
      profile: "chromium-capable-hardware-v1",
      scenario: "client-scroll-5000x150",
      summary: {
        budget: 8.33,
        max: 9,
        min: 1,
        overBudgetSampleCount: 1,
        p50: 1,
        p95: 1,
        p99: 1,
        sampleCount: 100,
      },
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.summary)).toBe(true);
    expect(Object.isFrozen(evidence.droppedFrames)).toBe(true);
    expect(evidence.environment).toBe(benchmarkEnvironment);
  });

  it("rejects release evidence below the capable-hardware sampling and p99 contract", () => {
    const valid = {
      budgetMs: 8.33,
      droppedFrameThresholdMs: 16.66,
      environment: benchmarkEnvironment,
      maxDroppedFrameCount: 2,
      measuredSampleCount: 100,
      profile: "chromium-capable-hardware-v1",
      scenario: "client-scroll-5000x150",
      warmupSampleCount: 12,
    } as const;
    const samples = Array<number>(112).fill(1);

    expect(() => finalizeBrunoTableBenchmarkEvidence(samples, valid)).not.toThrow();
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples.slice(1), {
        ...valid,
        warmupSampleCount: 11,
      }),
    ).toThrow("requires at least 12 warm-up samples");
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples.slice(12), {
        ...valid,
        warmupSampleCount: 0,
      }),
    ).toThrow("requires at least 12 warm-up samples");
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples.slice(0, 111), {
        ...valid,
        measuredSampleCount: 99,
      }),
    ).toThrow("requires at least 100 measured samples");
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(Array<number>(114).fill(1), {
        ...valid,
        warmupSampleCount: 13,
        measuredSampleCount: 101,
      }),
    ).not.toThrow();
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples, { ...valid, budgetMs: 8.34 }),
    ).toThrow("requires a p99 budget no greater than 8.33 ms");
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples, {
        ...valid,
        droppedFrameThresholdMs: 16.67,
      }),
    ).toThrow("requires a dropped-frame threshold no greater than 16.66 ms");
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples, {
        ...valid,
        maxDroppedFrameCount: 3,
      }),
    ).toThrow("requires a dropped-frame allowance no greater than 2");
  });

  it("rejects cadence evidence below its official sampling and threshold contract", () => {
    const valid = {
      budgetMs: 20,
      droppedFrameThresholdMs: 20,
      environment: benchmarkEnvironment,
      maxDroppedFrameCount: 2,
      measuredSampleCount: 100,
      profile: "chromium-production-presentation-cadence-v1",
      scenario: "client-scroll-presentation-cadence",
      warmupSampleCount: 12,
    } as const;
    const samples = Array<number>(112).fill(16.67);

    expect(() => finalizeBrunoTableBenchmarkEvidence(samples, valid)).not.toThrow();
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples.slice(1), {
        ...valid,
        warmupSampleCount: 11,
      }),
    ).toThrow("requires at least 12 warm-up samples");
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples.slice(0, 111), {
        ...valid,
        measuredSampleCount: 99,
      }),
    ).toThrow("requires at least 100 measured samples");
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(Array<number>(114).fill(16.67), {
        ...valid,
        warmupSampleCount: 13,
        measuredSampleCount: 101,
      }),
    ).not.toThrow();
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples, { ...valid, budgetMs: 20.01 }),
    ).toThrow("requires a p99 budget no greater than 20 ms");
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples, {
        ...valid,
        droppedFrameThresholdMs: 20.01,
      }),
    ).toThrow("requires a dropped-frame threshold no greater than 20 ms");
  });

  it("rejects both incomplete and over-collected final evidence", () => {
    const options = {
      budgetMs: 8.33,
      droppedFrameThresholdMs: 16.66,
      environment: benchmarkEnvironment,
      maxDroppedFrameCount: 0,
      measuredSampleCount: 100,
      profile: "chromium-capable-hardware-v1",
      scenario: "held-navigation",
      warmupSampleCount: 12,
    } as const;

    expect(() => finalizeBrunoTableBenchmarkEvidence(Array<number>(111).fill(1), options)).toThrow(
      "held-navigation on chromium-capable-hardware-v1 requires exactly 112 samples; received 111.",
    );
    expect(() => finalizeBrunoTableBenchmarkEvidence(Array<number>(113).fill(1), options)).toThrow(
      "held-navigation on chromium-capable-hardware-v1 requires exactly 112 samples; received 113.",
    );
  });

  it("rejects invalid final-evidence identity and dropped-frame policy", () => {
    const valid = {
      budgetMs: 8.33,
      droppedFrameThresholdMs: 16.66,
      environment: benchmarkEnvironment,
      maxDroppedFrameCount: 0,
      measuredSampleCount: 100,
      profile: "chromium-capable-hardware-v1",
      scenario: "client-scroll-5000x150",
      warmupSampleCount: 12,
    } as const;
    const samples = Array<number>(112).fill(1);

    for (const scenario of ["", " client-scroll-5000x150", "client-scroll-5000x150 "]) {
      expect(() => finalizeBrunoTableBenchmarkEvidence(samples, { ...valid, scenario })).toThrow(
        "scenario must be a non-empty normalized identity",
      );
    }
    for (const profile of ["", " chromium", "chromium "]) {
      expect(() =>
        finalizeBrunoTableBenchmarkEvidence(samples, { ...valid, profile } as never),
      ).toThrow("profile must be a non-empty normalized identity");
    }
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples, {
        ...valid,
        profile: "chromium-macos-capable-hardware-v1",
      } as never),
    ).toThrow("profile must be one of the declared benchmark identities");
    for (const droppedFrameThresholdMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        finalizeBrunoTableBenchmarkEvidence(samples, { ...valid, droppedFrameThresholdMs }),
      ).toThrow("droppedFrameThresholdMs must be a finite non-negative number");
    }
    for (const maxDroppedFrameCount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        finalizeBrunoTableBenchmarkEvidence(samples, { ...valid, maxDroppedFrameCount }),
      ).toThrow("maxDroppedFrameCount must be a non-negative safe integer");
    }
  });

  it("accepts only declared benchmark profile identities at the type seam", () => {
    const declared = {
      budgetMs: 8.33,
      droppedFrameThresholdMs: 16.66,
      environment: benchmarkEnvironment,
      maxDroppedFrameCount: 0,
      measuredSampleCount: 100,
      profile: "chromium-capable-hardware-v1",
      scenario: "declared-profile",
      warmupSampleCount: 12,
    } satisfies Parameters<typeof finalizeBrunoTableBenchmarkEvidence>[1];
    void declared;

    const unknown = {
      budgetMs: 8.33,
      droppedFrameThresholdMs: 16.66,
      environment: benchmarkEnvironment,
      maxDroppedFrameCount: 0,
      measuredSampleCount: 100,
      // @ts-expect-error unknown benchmark identities are not evidence profiles
      profile: "chromium-macos-capable-hardware-v1",
      scenario: "unknown-profile",
      warmupSampleCount: 12,
    } satisfies Parameters<typeof finalizeBrunoTableBenchmarkEvidence>[1];
    void unknown;
  });

  it("enforces both the p99 frame budget and declared dropped-frame count", () => {
    const valid = {
      budgetMs: 8.33,
      droppedFrameThresholdMs: 16.66,
      environment: benchmarkEnvironment,
      maxDroppedFrameCount: 0,
      measuredSampleCount: 100,
      profile: "chromium-capable-hardware-v1",
      scenario: "range-drag",
      warmupSampleCount: 12,
    } as const;
    const warmups = Array<number>(12).fill(999);

    expect(() =>
      finalizeBrunoTableBenchmarkEvidence([...warmups, 10, ...Array<number>(99).fill(1)], valid),
    ).not.toThrow();
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence([...warmups, 20, ...Array<number>(99).fill(1)], valid),
    ).toThrow("range-drag on chromium-capable-hardware-v1 recorded 1 dropped frames; maximum 0");
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(
        [...warmups, 10, 10, ...Array<number>(98).fill(1)],
        valid,
      ),
    ).toThrow("range-drag on chromium-capable-hardware-v1 exceeded the frame budget");
  });

  it("rejects missing or non-installed Browser environment provenance", () => {
    const valid = {
      budgetMs: 8.33,
      droppedFrameThresholdMs: 16.66,
      environment: benchmarkEnvironment,
      maxDroppedFrameCount: 0,
      measuredSampleCount: 100,
      profile: "chromium-capable-hardware-v1",
      scenario: "environment-provenance",
      warmupSampleCount: 12,
    } as const;
    const samples = Array<number>(112).fill(1);
    const otherValidatedEnvironment = validateBrunoTableBenchmarkEnvironment({
      ...benchmarkEnvironment,
      userAgent: "Mozilla/5.0 HeadlessChrome/146.0.0.0 Safari/537.36",
    });

    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples, {
        ...valid,
        environment: undefined as never,
      }),
    ).toThrow("requires the installed Browser environment");
    expect(() =>
      finalizeBrunoTableBenchmarkEvidence(samples, {
        ...valid,
        environment: otherValidatedEnvironment,
      }),
    ).toThrow("requires the installed Browser environment");
  });

  it("excludes declared warmups and enforces zero-warmup measured samples", () => {
    expect(() =>
      assertBrunoTableBenchmarkBudget("warmups", [100, 100, ...Array<number>(100).fill(1)], {
        budgetMs: 8.33,
        measuredSampleCount: 100,
        warmupSampleCount: 2,
      }),
    ).not.toThrow();

    expect(() =>
      assertBrunoTableBenchmarkBudget("zero warmups", [10, 10, ...Array<number>(98).fill(1)], {
        budgetMs: 8.33,
        measuredSampleCount: 100,
        warmupSampleCount: 0,
      }),
    ).toThrow("zero warmups exceeded the frame reference with p99 10 ms");
  });
});
