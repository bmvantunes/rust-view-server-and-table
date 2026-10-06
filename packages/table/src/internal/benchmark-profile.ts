export type BrunoTableCapableHardwareProfile = Readonly<{
  readonly id: "chromium-capable-hardware-v1";
  readonly minimumLogicalProcessorCount: 8;
  readonly requiredBrowserEngine: "chromium";
  readonly requiredDevicePixelRatio: 1;
  readonly requiredMode: "production";
  readonly requiredViewport: Readonly<{ readonly height: 900; readonly width: 1440 }>;
}>;

export const BRUNO_TABLE_CAPABLE_HARDWARE_PROFILE: BrunoTableCapableHardwareProfile = Object.freeze(
  {
    id: "chromium-capable-hardware-v1",
    minimumLogicalProcessorCount: 8,
    requiredBrowserEngine: "chromium",
    requiredDevicePixelRatio: 1,
    requiredMode: "production",
    requiredViewport: Object.freeze({ height: 900, width: 1440 }),
  },
);

export type BrunoTableCapableHardwareSampleProtocol = Readonly<{
  readonly maximumDroppedFrameCount: 2;
  readonly maximumDroppedFrameThresholdMs: 16.66;
  readonly maximumP99Ms: 8.33;
  readonly measuredSampleCount: 100;
  readonly warmupSampleCount: 12;
}>;

export const BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL: BrunoTableCapableHardwareSampleProtocol =
  Object.freeze({
    maximumDroppedFrameCount: 2,
    maximumDroppedFrameThresholdMs: 16.66,
    maximumP99Ms: 8.33,
    measuredSampleCount: 100,
    warmupSampleCount: 12,
  });

export const BRUNO_TABLE_PRESENTATION_CADENCE_PROFILE =
  "chromium-production-presentation-cadence-v1" as const;

export type BrunoTableBenchmarkProfile =
  | BrunoTableCapableHardwareProfile["id"]
  | typeof BRUNO_TABLE_PRESENTATION_CADENCE_PROFILE;

export type BrunoTablePresentationCadenceSampleProtocol = Readonly<{
  readonly maximumDroppedFrameCount: 2;
  readonly maximumDroppedFrameThresholdMs: 20;
  readonly maximumP99Ms: 20;
  readonly measuredSampleCount: 100;
  readonly warmupSampleCount: 12;
}>;

export const BRUNO_TABLE_PRESENTATION_CADENCE_SAMPLE_PROTOCOL: BrunoTablePresentationCadenceSampleProtocol =
  Object.freeze({
    maximumDroppedFrameCount: 2,
    maximumDroppedFrameThresholdMs: 20,
    maximumP99Ms: 20,
    measuredSampleCount: 100,
    warmupSampleCount: 12,
  });

type BrunoTableBenchmarkEnvironmentInput = Readonly<{
  readonly browserEngine: string;
  readonly devicePixelRatio: number;
  readonly logicalProcessorCount: number;
  readonly mode: string;
  readonly userAgent: string;
  readonly viewport: Readonly<{ readonly height: number; readonly width: number }>;
}>;

export type BrunoTableBenchmarkEnvironment = BrunoTableBenchmarkEnvironmentInput &
  Readonly<{ readonly profile: typeof BRUNO_TABLE_CAPABLE_HARDWARE_PROFILE.id }>;

const admittedBenchmarkEnvironments = new WeakSet<object>();
let installedBenchmarkEnvironment: BrunoTableBenchmarkEnvironment | undefined;

function sameBrunoTableBenchmarkEnvironment(
  left: BrunoTableBenchmarkEnvironment,
  right: BrunoTableBenchmarkEnvironment,
): boolean {
  return (
    left.browserEngine === right.browserEngine &&
    left.devicePixelRatio === right.devicePixelRatio &&
    left.logicalProcessorCount === right.logicalProcessorCount &&
    left.mode === right.mode &&
    left.profile === right.profile &&
    left.userAgent === right.userAgent &&
    left.viewport.height === right.viewport.height &&
    left.viewport.width === right.viewport.width
  );
}

export function validateBrunoTableBenchmarkEnvironment(
  environment: BrunoTableBenchmarkEnvironmentInput,
): BrunoTableBenchmarkEnvironment {
  const profile = BRUNO_TABLE_CAPABLE_HARDWARE_PROFILE;
  if (environment.browserEngine !== profile.requiredBrowserEngine) {
    throw new Error(`${profile.id} requires browser engine ${profile.requiredBrowserEngine}.`);
  }
  if (environment.mode !== profile.requiredMode) {
    throw new Error(`${profile.id} requires mode ${profile.requiredMode}.`);
  }
  if (
    environment.viewport.width !== profile.requiredViewport.width ||
    environment.viewport.height !== profile.requiredViewport.height
  ) {
    throw new Error(
      `${profile.id} requires viewport ${String(profile.requiredViewport.width)}x${String(profile.requiredViewport.height)}.`,
    );
  }
  if (environment.devicePixelRatio !== profile.requiredDevicePixelRatio) {
    throw new Error(
      `${profile.id} requires devicePixelRatio ${String(profile.requiredDevicePixelRatio)}.`,
    );
  }
  if (
    !Number.isSafeInteger(environment.logicalProcessorCount) ||
    environment.logicalProcessorCount < profile.minimumLogicalProcessorCount
  ) {
    throw new Error(
      `${profile.id} requires at least ${String(profile.minimumLogicalProcessorCount)} logical processors.`,
    );
  }
  if (
    environment.userAgent.length === 0 ||
    environment.userAgent.trim() !== environment.userAgent
  ) {
    throw new Error(`${profile.id} requires a normalized non-empty user agent.`);
  }
  if (!/(?:Headless)?Chrome\//u.test(environment.userAgent)) {
    throw new Error(`${profile.id} requires a Chromium user agent.`);
  }

  const validated = Object.freeze({
    browserEngine: environment.browserEngine,
    devicePixelRatio: environment.devicePixelRatio,
    logicalProcessorCount: environment.logicalProcessorCount,
    mode: environment.mode,
    profile: profile.id,
    userAgent: environment.userAgent,
    viewport: Object.freeze({
      height: environment.viewport.height,
      width: environment.viewport.width,
    }),
  });
  admittedBenchmarkEnvironments.add(validated);
  return validated;
}

export function installBrunoTableBenchmarkEnvironment(
  environment: BrunoTableBenchmarkEnvironmentInput,
): BrunoTableBenchmarkEnvironment {
  const validated = validateBrunoTableBenchmarkEnvironment(environment);
  if (installedBenchmarkEnvironment === undefined) {
    installedBenchmarkEnvironment = validated;
    return validated;
  }
  if (!sameBrunoTableBenchmarkEnvironment(installedBenchmarkEnvironment, validated)) {
    throw new Error(
      "BrunoTable benchmark environment is already installed with different evidence.",
    );
  }
  return installedBenchmarkEnvironment;
}

export function getBrunoTableBenchmarkEnvironment(): BrunoTableBenchmarkEnvironment {
  if (installedBenchmarkEnvironment === undefined) {
    throw new Error("BrunoTable benchmark environment has not been installed.");
  }
  return installedBenchmarkEnvironment;
}

export function requireValidatedBrunoTableBenchmarkEnvironment(
  environment: unknown,
): BrunoTableBenchmarkEnvironment {
  const installed = installedBenchmarkEnvironment;
  if (
    installed === undefined ||
    environment !== installed ||
    typeof environment !== "object" ||
    environment === null ||
    !admittedBenchmarkEnvironments.has(environment)
  ) {
    throw new Error("BrunoTable benchmark evidence requires the installed Browser environment.");
  }
  return installed;
}
