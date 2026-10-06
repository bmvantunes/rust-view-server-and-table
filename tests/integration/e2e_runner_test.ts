import { main as devMain } from "../../scripts/dev.ts";
import { Kafka } from "../../scripts/kafka.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  nativeCaughtUp,
  validateBuildMode,
  checkCandidate,
  performCleanup,
  finalizeAcceptance,
  type CampaignResult,
} from "../../scripts/e2e.ts";
import type { Expected } from "../../scripts/control.ts";
import { command, settledStage } from "../../scripts/common.ts";
const expected: Expected = {
  client_orders: {
    count: 200000,
    sourceNext: { 0: 100199, 1: 100199 },
    sha256: "",
    producerReceipts: 200000,
  },
  server_orders: {
    count: 200000,
    sourceNext: { 0: 100199, 1: 100199 },
    sha256: "",
    producerReceipts: 200000,
  },
};
function health() {
  return {
    instance: "new",
    ready: true,
    authority_safe: true,
    sources: Object.keys(expected).map((topic) => ({
      topic,
      retention: { active_payload_rows: 200000, safe: true, pending_due: false },
      partitions: [0, 1].map((partition) => ({
        partition,
        assigned: true,
        bootstrap_complete: true,
        durable_next: "100199",
        derived_next: "100199",
        serving_next: "100200",
        fetched_next: "100999",
      })),
    })),
  };
}
test("native readiness requires counts all committed cuts and new restart identity", () => {
  const value = health();
  assert(nativeCaughtUp(value, expected));
  assert(nativeCaughtUp(value, JSON.parse(JSON.stringify(expected))));
  assert(!nativeCaughtUp(value, expected, "new"));
  assert(nativeCaughtUp(value, expected, "old"));
  for (const field of ["durable_next", "derived_next", "serving_next"] as const) {
    const stale = health();
    stale.sources[1].partitions[1][field] = "100198";
    assert(!nativeCaughtUp(stale, expected));
    const nullable = {
      ...stale,
      sources: [
        stale.sources[0],
        {
          ...stale.sources[1],
          partitions: [
            stale.sources[1].partitions[0],
            { ...stale.sources[1].partitions[1], [field]: null },
          ],
        },
      ],
    };
    assert(!nativeCaughtUp(nullable, expected));
  }
  for (const mode of ["count", "ready", "safe", "pending", "missing", "bootstrap"]) {
    const stale = health();
    if (mode === "count") stale.sources[0].retention.active_payload_rows--;
    if (mode === "ready") stale.ready = false;
    if (mode === "safe") stale.sources[1].retention.safe = false;
    if (mode === "pending") stale.sources[1].retention.pending_due = true;
    if (mode === "missing") stale.sources[1].partitions.pop();
    if (mode === "bootstrap") stale.sources[0].partitions[0].bootstrap_complete = false;
    assert(!nativeCaughtUp(stale, expected), mode);
  }
});
test("full mode cannot reuse stale executable", () => {
  assert.throws(() => validateBuildMode(undefined, true), /only permitted/);
  validateBuildMode(100, true);
  validateBuildMode(undefined, false);
});
test("source changes during every build phase reject full acceptance", () => {
  for (const phase of [
    "during native build",
    "before web build",
    "during web build",
    "during browser campaign",
  ])
    assert.throws(
      () => checkCandidate("before", "after", undefined, phase),
      /frozen acceptance invalid/,
    );
  assert(checkCandidate("same", "same", undefined, "after build"));
  assert(!checkCandidate("before", "after", 100, "smoke"));
});
test("all owned cleanups attempted and failures prohibit full acceptance", async () => {
  const attempted: string[] = [];
  const failures = await performCleanup(
    ["child", "control", "producer", "handles", "broker"].map((name) => [
      name,
      () => {
        attempted.push(name);
        if (name === "child" || name === "producer") throw Error(name + " failed");
      },
    ]),
  );
  assert.deepEqual(attempted, ["child", "control", "producer", "handles", "broker"]);
  assert.deepEqual(
    failures.map((row) => row.resource),
    ["child", "producer"],
  );
  const result: CampaignResult = { status: "passed", mode: "full-200000", candidateFrozen: true };
  finalizeAcceptance(result, failures);
  assert.equal(result.status, "failed");
  assert.equal(result.fullCampaignAcceptance, false);
});
test("only clean frozen full success qualifies", () => {
  for (const [mode, frozen, status, accepted] of [
    ["smoke", true, "passed", false],
    ["full-200000", false, "passed", false],
    ["full-200000", true, "failed", false],
    ["full-200000", true, "passed", true],
  ] as const) {
    const result: CampaignResult = { mode, candidateFrozen: frozen, status };
    finalizeAcceptance(result, []);
    assert.equal(result.fullCampaignAcceptance, accepted);
  }
});
test("already aborted commands never spawn", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    command([process.execPath, "-e", "process.exit(91)"], { signal: abort.signal }),
    /before spawn/,
  );
});
test("timed out owned commands finish their cleanup before rejecting", async () => {
  const started = performance.now();
  await assert.rejects(
    command([process.execPath, "-e", "setInterval(()=>{},1000)"], { timeoutMs: 30 }),
    /timed out/,
  );
  assert(performance.now() - started < 5000);
});

test("interrupted broker/producer/catchup stages settle before cleanup and cannot continue spawning", async () => {
  for (const name of ["broker", "producer", "catchup"]) {
    const controller = new AbortController();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const campaign = (async () => {
      try {
        await settledStage(controller.signal, async () => {
          events.push(name + " started");
          await blocked;
          events.push(name + " settled");
        });
        events.push("late spawn");
      } finally {
        events.push("cleanup");
      }
    })();
    const rejected = assert.rejects(campaign);
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [name + " started"]);
    release();
    await rejected;
    assert.deepEqual(events, [name + " started", name + " settled", "cleanup"]);
  }
});

test("development startup abort settles blocked broker before any later stage", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rvs-dev-abort-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const abort = new AbortController();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[][] = [];
  const owner = new Kafka(directory, async (args) => {
    calls.push([...args]);
    await blocked;
    return { code: 0, stdout: "", stderr: "" };
  });
  const running = devMain(["--no-build", "--no-web", "--run", "cancelled"], {
    owner,
    signal: abort.signal,
  });
  const rejected = assert.rejects(running);
  abort.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release();
  await rejected;
  assert.equal(calls.length, 1);
  assert(calls[0].includes("info"));
});
