import {
  BRUNO_TABLE_CAPABLE_HARDWARE_PROFILE,
  BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL,
  BRUNO_TABLE_PRESENTATION_CADENCE_PROFILE,
  BRUNO_TABLE_PRESENTATION_CADENCE_SAMPLE_PROTOCOL,
  type BrunoTableBenchmarkEnvironment,
  type BrunoTableBenchmarkProfile,
  requireValidatedBrunoTableBenchmarkEnvironment,
} from "./benchmark-profile";

export type BrunoTableBenchmarkSummary = Readonly<{
  readonly budget: number;
  readonly sampleCount: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly overBudgetSampleCount: number;
}>;

export type BrunoTableBenchmarkEvidence = Readonly<{
  readonly environment: BrunoTableBenchmarkEnvironment;
  readonly scenario: string;
  readonly profile: BrunoTableBenchmarkProfile;
  readonly summary: BrunoTableBenchmarkSummary;
  readonly droppedFrames: Readonly<{
    readonly comparison: "measured sample > thresholdMs";
    readonly thresholdMs: number;
    readonly count: number;
    readonly maxCount: number;
  }>;
}>;

type BrunoTableBenchmarkBudgetOptions = Readonly<{
  readonly measuredSampleCount: number;
  readonly warmupSampleCount: number;
  readonly budgetMs: number;
}>;

type BrunoTableBenchmarkEvidenceOptions = BrunoTableBenchmarkBudgetOptions &
  Readonly<{
    readonly environment: BrunoTableBenchmarkEnvironment;
    readonly scenario: string;
    readonly profile: BrunoTableBenchmarkProfile;
    readonly droppedFrameThresholdMs: number;
    readonly maxDroppedFrameCount: number;
  }>;

type BrunoTableBenchmarkFramePhase = Readonly<{
  readonly callbackDurationMs: number;
  readonly reactDurationMs: number;
}>;

export type BrunoTableReactCommitWork = Readonly<{
  readonly commitTimeMs: number;
  readonly durationMs: number;
  readonly startTimeMs: number;
}>;

export function captureBrunoTableReactCommitWork(
  timings: Readonly<{
    readonly actualDurationMs: number;
    readonly commitTimeMs: number;
    readonly observedAtMs: number;
    readonly startTimeMs: number;
  }>,
): BrunoTableReactCommitWork {
  if (
    !Number.isFinite(timings.actualDurationMs) ||
    timings.actualDurationMs < 0 ||
    !Number.isFinite(timings.startTimeMs) ||
    timings.startTimeMs < 0 ||
    !Number.isFinite(timings.commitTimeMs) ||
    timings.commitTimeMs < timings.startTimeMs ||
    !Number.isFinite(timings.observedAtMs) ||
    timings.observedAtMs < timings.commitTimeMs
  ) {
    throw new Error(
      "BrunoTable React Profiler work must contain finite non-negative durations and an ordered time span.",
    );
  }
  const durationMs = timings.actualDurationMs + (timings.observedAtMs - timings.commitTimeMs);
  if (!Number.isFinite(durationMs)) {
    throw new Error("BrunoTable React Profiler work must have a finite complete duration.");
  }
  return Object.freeze({
    commitTimeMs: timings.commitTimeMs,
    durationMs,
    startTimeMs: timings.startTimeMs,
  });
}

export function accumulateBrunoTableBenchmarkFrameCallbackWork(
  durationsByTimestamp: Map<number, number>,
  timestampMs: number,
  durationMs: number,
): void {
  if (
    !Number.isFinite(timestampMs) ||
    timestampMs < 0 ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    throw new Error(
      "BrunoTable animation-frame callback work must contain finite non-negative timings.",
    );
  }
  durationsByTimestamp.set(timestampMs, (durationsByTimestamp.get(timestampMs) ?? 0) + durationMs);
}

/**
 * React Profiler reports render CPU separately from the commit phase. Charge their complete sum
 * to the sampled frame nearest its commit instead of
 * inventing a distribution that could dilute one over-budget burst across idle frame boundaries.
 */
export function distributeBrunoTableReactCommitWork(
  frameTimestampsMs: readonly number[],
  commits: readonly BrunoTableReactCommitWork[],
): readonly number[] {
  for (const timestamp of frameTimestampsMs) {
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new Error("BrunoTable benchmark frame timestamps must be finite non-negative numbers.");
    }
  }
  const distributed = Array<number>(frameTimestampsMs.length).fill(0);

  for (const commit of commits) {
    if (
      !Number.isFinite(commit.durationMs) ||
      commit.durationMs < 0 ||
      !Number.isFinite(commit.startTimeMs) ||
      commit.startTimeMs < 0 ||
      !Number.isFinite(commit.commitTimeMs) ||
      commit.commitTimeMs < commit.startTimeMs
    ) {
      throw new Error(
        "BrunoTable React commit work must contain finite non-negative durations and an ordered time span.",
      );
    }
    if (frameTimestampsMs.length === 0) {
      throw new Error("BrunoTable React commit work requires at least one frame timestamp.");
    }

    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [index, timestamp] of frameTimestampsMs.entries()) {
      const distance = Math.abs(timestamp - commit.commitTimeMs);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    distributed[nearestIndex] = (distributed[nearestIndex] ?? 0) + commit.durationMs;
  }

  return distributed;
}

export function combineBrunoTableBenchmarkFrameWork(
  sample: Readonly<{
    readonly admissionDurationMs: number;
    readonly renderedFrame: BrunoTableBenchmarkFramePhase;
    readonly presentationFrame: BrunoTableBenchmarkFramePhase;
  }>,
): number {
  return (
    sample.admissionDurationMs +
    Math.max(sample.renderedFrame.callbackDurationMs, sample.renderedFrame.reactDurationMs) +
    Math.max(sample.presentationFrame.callbackDurationMs, sample.presentationFrame.reactDurationMs)
  );
}

function assertNormalizedIdentity(name: "profile" | "scenario", value: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`BrunoTable benchmark ${name} must be a non-empty normalized identity.`);
  }
}

function assertBrunoTableBenchmarkProfileProtocol(
  options: BrunoTableBenchmarkEvidenceOptions,
  environment: BrunoTableBenchmarkEnvironment,
): void {
  let protocol:
    | typeof BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL
    | typeof BRUNO_TABLE_PRESENTATION_CADENCE_SAMPLE_PROTOCOL;
  if (options.profile === BRUNO_TABLE_CAPABLE_HARDWARE_PROFILE.id) {
    const capableProfile: string = options.profile;
    if (environment.profile !== capableProfile) {
      throw new Error(
        `${capableProfile} requires installed environment profile ${capableProfile}.`,
      );
    }
    protocol = BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL;
  } else if (options.profile === BRUNO_TABLE_PRESENTATION_CADENCE_PROFILE) {
    protocol = BRUNO_TABLE_PRESENTATION_CADENCE_SAMPLE_PROTOCOL;
  } else {
    throw new Error(
      "BrunoTable benchmark profile must be one of the declared benchmark identities.",
    );
  }
  if (options.warmupSampleCount < protocol.warmupSampleCount) {
    throw new Error(
      `${options.profile} requires at least ${String(protocol.warmupSampleCount)} warm-up samples.`,
    );
  }
  if (options.measuredSampleCount < protocol.measuredSampleCount) {
    throw new Error(
      `${options.profile} requires at least ${String(protocol.measuredSampleCount)} measured samples.`,
    );
  }
  if (options.budgetMs > protocol.maximumP99Ms) {
    throw new Error(
      `${options.profile} requires a p99 budget no greater than ${String(protocol.maximumP99Ms)} ms.`,
    );
  }
  if (options.droppedFrameThresholdMs > protocol.maximumDroppedFrameThresholdMs) {
    throw new Error(
      `${options.profile} requires a dropped-frame threshold no greater than ${String(protocol.maximumDroppedFrameThresholdMs)} ms.`,
    );
  }
  if (options.maxDroppedFrameCount > protocol.maximumDroppedFrameCount) {
    throw new Error(
      `${options.profile} requires a dropped-frame allowance no greater than ${String(protocol.maximumDroppedFrameCount)}.`,
    );
  }
}

function requiredBrunoTableBenchmarkSampleCount(options: BrunoTableBenchmarkBudgetOptions): number {
  if (!Number.isSafeInteger(options.warmupSampleCount) || options.warmupSampleCount < 0) {
    throw new Error("BrunoTable benchmark warmupSampleCount must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(options.measuredSampleCount) || options.measuredSampleCount <= 0) {
    throw new Error("BrunoTable benchmark measuredSampleCount must be a positive safe integer.");
  }
  if (!Number.isFinite(options.budgetMs) || options.budgetMs < 0) {
    throw new Error("BrunoTable benchmark budgetMs must be a finite non-negative number.");
  }
  const requiredSampleCount = options.warmupSampleCount + options.measuredSampleCount;
  if (!Number.isSafeInteger(requiredSampleCount)) {
    throw new Error("BrunoTable benchmark total sample count must be a safe integer.");
  }
  return requiredSampleCount;
}

export function summarizeBrunoTableBenchmarkBudget(
  samples: readonly number[],
  options: BrunoTableBenchmarkBudgetOptions,
): BrunoTableBenchmarkSummary | undefined {
  const requiredSampleCount = requiredBrunoTableBenchmarkSampleCount(options);
  if (samples.length < requiredSampleCount) return undefined;

  const measured = samples.slice(
    options.warmupSampleCount,
    options.warmupSampleCount + options.measuredSampleCount,
  );
  for (const sample of measured) {
    if (!Number.isFinite(sample) || sample < 0) {
      throw new Error(
        "Completed BrunoTable benchmark samples must be finite non-negative numbers.",
      );
    }
  }

  const sorted = [...measured].sort((left, right) => left - right);
  const percentile = (percentileValue: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;

  return Object.freeze({
    budget: options.budgetMs,
    sampleCount: measured.length,
    min: sorted[0] ?? 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    overBudgetSampleCount: measured.filter((sample) => sample > options.budgetMs).length,
  });
}

export function assertBrunoTableBenchmarkBudget(
  name: string,
  samples: readonly number[],
  options: BrunoTableBenchmarkBudgetOptions,
): void {
  const summary = summarizeBrunoTableBenchmarkBudget(samples, options);
  if (summary === undefined) return;
  if (summary.p99 > options.budgetMs) {
    throw new Error(`${name} exceeded the frame reference with p99 ${String(summary.p99)} ms.`);
  }
}

export function finalizeBrunoTableBenchmarkEvidence(
  samples: readonly number[],
  options: BrunoTableBenchmarkEvidenceOptions,
): BrunoTableBenchmarkEvidence {
  const requiredSampleCount = requiredBrunoTableBenchmarkSampleCount(options);
  const environment = requireValidatedBrunoTableBenchmarkEnvironment(options.environment);
  assertNormalizedIdentity("scenario", options.scenario);
  assertNormalizedIdentity("profile", options.profile);
  if (!Number.isFinite(options.droppedFrameThresholdMs) || options.droppedFrameThresholdMs < 0) {
    throw new Error(
      "BrunoTable benchmark droppedFrameThresholdMs must be a finite non-negative number.",
    );
  }
  if (!Number.isSafeInteger(options.maxDroppedFrameCount) || options.maxDroppedFrameCount < 0) {
    throw new Error(
      "BrunoTable benchmark maxDroppedFrameCount must be a non-negative safe integer.",
    );
  }
  assertBrunoTableBenchmarkProfileProtocol(options, environment);

  if (samples.length !== requiredSampleCount) {
    throw new Error(
      `${options.scenario} on ${options.profile} requires exactly ${String(requiredSampleCount)} samples; received ${String(samples.length)}.`,
    );
  }

  const summary = summarizeBrunoTableBenchmarkBudget(samples, options);
  if (summary === undefined) {
    throw new Error("Completed BrunoTable benchmark evidence unexpectedly lacked a summary.");
  }
  const measured = samples.slice(options.warmupSampleCount);
  const droppedFrameCount = measured.filter(
    (sample) => sample > options.droppedFrameThresholdMs,
  ).length;

  if (droppedFrameCount > options.maxDroppedFrameCount) {
    throw new Error(
      `${options.scenario} on ${options.profile} recorded ${String(droppedFrameCount)} dropped frames; maximum ${String(options.maxDroppedFrameCount)}.`,
    );
  }
  if (summary.p99 > options.budgetMs) {
    throw new Error(
      `${options.scenario} on ${options.profile} exceeded the frame budget with p99 ${String(summary.p99)} ms; maximum ${String(options.budgetMs)} ms.`,
    );
  }

  return Object.freeze({
    droppedFrames: Object.freeze({
      comparison: "measured sample > thresholdMs" as const,
      count: droppedFrameCount,
      maxCount: options.maxDroppedFrameCount,
      thresholdMs: options.droppedFrameThresholdMs,
    }),
    environment,
    profile: options.profile,
    scenario: options.scenario,
    summary,
  });
}
