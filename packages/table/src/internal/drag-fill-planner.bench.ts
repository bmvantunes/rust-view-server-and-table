import { afterAll, describe } from "vite-plus/test";
import { bench } from "../../scripts/benchmark-adapter";

import {
  captureBrunoTableDragFillGesture,
  projectBrunoTableDragFillPreview,
} from "./drag-fill-planner";

const referenceFrameBudgetMs = 8.33;
const logicalIdentities = 100_000;
const projectionsPerFrameBatch = 10_000;
const measuredIterations = 100;
const warmupIterations = 10;
const identities = Object.freeze(
  Array.from({ length: logicalIdentities }, (_unused, index) => `ROW_ID_${String(index)}`),
);
const indexById = new Map(identities.map((identity, index) => [identity, index] as const));
const gesture = (() => {
  const captured = captureBrunoTableDragFillGesture({
    axis: "vertical",
    identities,
    indexById,
    sourceCanonicalTexts: ["alpha", "beta", "gamma"],
    sourceFirstIdentity: identities[50_000]!,
    sourceLastIdentity: identities[50_002]!,
  });
  if (captured === undefined) throw new Error("Expected a valid benchmark Drag Fill gesture.");
  return captured;
})();

describe("BrunoTable Drag Fill planner benchmark (8.33 ms/120 Hz reference)", () => {
  afterAll(() => {
    for (let index = 0; index < warmupIterations; index += 1) {
      projectEndpointBatch();
    }
    const projectionBatchDurationsMs: number[] = [];
    for (let index = 0; index < measuredIterations; index += 1) {
      const startedAt = performance.now();
      projectEndpointBatch();
      projectionBatchDurationsMs.push(performance.now() - startedAt);
    }
    if (projectionBatchDurationsMs.length !== measuredIterations) {
      throw new Error("Drag Fill benchmark did not produce its exact measured sample set.");
    }
    const projectionBatchP99Ms = percentile99(projectionBatchDurationsMs);
    const projectedEndpoints = projectionBatchDurationsMs.length * projectionsPerFrameBatch;
    process.stdout.write(
      `${JSON.stringify({
        benchmark: "BrunoTable Drag Fill O(1) endpoint projection",
        logicalIdentities,
        projectionsPerFrameBatch,
        projectedEndpoints,
        projectionBatchP99Ms,
        referenceFrameBudgetMs,
      })}\n`,
    );
    if (projectionBatchP99Ms > referenceFrameBudgetMs) {
      throw new Error("Drag Fill endpoint projection exceeded the 120 Hz reference frame budget.");
    }
  });

  bench(
    "projects 10,000 endpoints over 100,000 identities without materializing a span",
    () => {
      projectEndpointBatch();
    },
    { iterations: measuredIterations, time: 0, warmupIterations, warmupTime: 0 },
  );
});

function projectEndpointBatch(): void {
  for (let index = 0; index < projectionsPerFrameBatch; index += 1) {
    const targetIdentity = identities[index % 2 === 0 ? 99_999 : 0]!;
    const preview = projectBrunoTableDragFillPreview({ gesture, targetIdentity });
    if (preview === undefined) throw new Error("Expected one compact Drag Fill preview.");
  }
}

function percentile99(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)] ?? 0;
}
