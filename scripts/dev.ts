import { parseArgs } from "node:util";
import { existsSync, openSync, closeSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  ROOT,
  OwnedLock,
  spawnOwned,
  stopOwned,
  exited,
  command,
  readJson,
  object,
  writeJson,
  sleep,
  isMain,
  message,
  settledStage,
} from "./common.ts";
import { Kafka, validRun } from "./kafka.ts";
import { prepare, TOPICS } from "./demo_config.ts";
import { record } from "./seed.ts";
import { Producer, serve, type Control } from "./control.ts";
export async function main(
  args = process.argv.slice(2),
  runtime: { owner?: Kafka; signal?: AbortSignal } = {},
) {
  const { values: v } = parseArgs({
    args,
    options: {
      run: { type: "string", default: "dev" },
      "kafka-port": { type: "string", default: "19092" },
      "control-port": { type: "string", default: "3012" },
      rows: { type: "string", default: "200000" },
      "no-seed": { type: "boolean", default: false },
      "no-build": { type: "boolean", default: false },
      "no-web": { type: "boolean", default: false },
    },
  });
  const name = validRun(v.run),
    rows = Number(v.rows);
  if (!Number.isInteger(rows) || rows < 1 || rows > 200000) throw Error("rows must be in1..200000");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  runtime.signal?.addEventListener("abort", interrupt, { once: true });
  if (runtime.signal?.aborted) interrupt();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const children: ChildProcess[] = [],
    handles: number[] = [];
  let lock: OwnedLock | undefined,
    producer: Producer | undefined,
    control: Control | undefined,
    brokerStarted = false;
  const cleanupOwner = runtime.owner ?? new Kafka();
  const owner = new Kafka(cleanupOwner.directory, (args, options) =>
    settledStage(controller.signal, () =>
      cleanupOwner.runner(args, { ...options, signal: controller.signal }),
    ),
  );
  const broker = (action: string, ...extra: string[]) =>
    settledStage(controller.signal, () => owner.cli([action, "--run", name, ...extra]));
  try {
    if (!v["no-build"])
      await command(
        [
          process.execPath,
          join(ROOT, "scripts/rust.ts"),
          "build",
          "--locked",
          "--release",
          "-p",
          "view-server-app",
          "-p",
          "product-source-ingestion",
          "--features",
          "kafka-canonical",
          "--bin",
          "view_server",
          "--example",
          "seed_producer",
        ],
        { timeoutMs: 600000, stdio: "inherit", signal: controller.signal },
      );
    await broker("preflight");
    if (!existsSync(owner.statePath(name))) await broker("init", "--port", v["kafka-port"]);
    const prepared = prepare(name, { owner }),
      directory = dirname(prepared.path);
    lock = await OwnedLock.acquire(join(directory, "dev.lock"));
    controller.signal.throwIfAborted();
    const marker = join(directory, "initial-seed.json");
    if (!v["no-seed"] && existsSync(marker)) {
      const acknowledged = object(object(readJson(marker)).producerAcknowledgedDistinctIdentities);
      if (TOPICS.some((topic) => acknowledged[topic] !== rows))
        throw Error("Existing initial seed size differs; use a fresh run");
    }
    brokerStarted = true;
    await broker("up");
    const existing = new Set(
      (
        await owner.compose(prepared.state, [
          "exec",
          "-T",
          "kafka",
          "/opt/kafka/bin/kafka-topics.sh",
          "--bootstrap-server",
          "kafka:9092",
          "--list",
        ])
      ).stdout.split("\n"),
    );
    for (const topic of TOPICS)
      for (const name of [topic, topic + "-state"])
        if (!existing.has(name))
          await broker("topic-create", "--topic", name, "--cleanup-policy", "compact");
    controller.signal.throwIfAborted();
    const logPath = join(directory, `native-${process.hrtime.bigint()}.log`),
      log = openSync(logPath, "w");
    handles.push(log);
    children.push(
      spawnOwned([join(ROOT, "target/release/view_server"), prepared.path], {
        env: { ...process.env, V12_SESSION_TOKEN: prepared.token },
        stdio: ["ignore", log, log],
      }),
    );
    producer = await Producer.open(prepared.path, directory, { signal: controller.signal });
    controller.signal.throwIfAborted();
    if (existsSync(marker) && statSync(join(directory, "producer-receipts.ndjson")).size === 0)
      throw Error("Historical demo seed has no editable receipt journal; select a fresh run");
    control = await serve(producer, {
      port: Number(v["control-port"]),
      origin: "http://127.0.0.1:3000",
      token: prepared.token,
      run: name,
    });
    controller.signal.throwIfAborted();
    if (!v["no-web"])
      children.push(
        spawnOwned(["vp", "dev", "--host", "127.0.0.1", "--port", "3000", "--strictPort"], {
          cwd: join(ROOT, "apps/web"),
          stdio: "inherit",
          env: {
            ...process.env,
            VITE_RVS_URL: "ws://127.0.0.1:3010/v15",
            VITE_RVS_TOKEN: prepared.token,
            VITE_RVS_CONTROL_URL: `http://127.0.0.1:${control.port}`,
            VITE_RVS_CONTROL_TOKEN: prepared.token,
            VITE_RVS_RUN: name,
            VITE_RVS_CATALOG: JSON.stringify(prepared.config.catalog),
          },
        }),
      );
    if (!v["no-seed"] && !existsSync(marker)) {
      if (TOPICS.some((topic) => producer!.rows[topic].size))
        throw Error("Unfinished initial seed exists; select a fresh run");
      for (const topic of TOPICS)
        for (let first = 0; first < rows; first += 1000) {
          if (controller.signal.aborted) throw Error("Interrupted");
          lock.assertHeld();
          await producer.publish(
            Array.from({ length: Math.min(1000, rows - first) }, (_, i) =>
              record(topic, first + i),
            ),
          );
          console.log(
            JSON.stringify({
              seedProgress: { [topic]: producer.rows[topic].size },
              targetPerTopic: rows,
            }),
          );
        }
      writeJson(marker, {
        producerAcknowledgedDistinctIdentities: Object.fromEntries(
          TOPICS.map((topic) => [topic, producer!.rows[topic].size]),
        ),
        sourceNext: producer.cuts,
        campaignSize: rows === 200000,
        applicationOrConsumerQualification: false,
      });
    }
    console.log(
      JSON.stringify({
        web: v["no-web"] ? null : "http://127.0.0.1:3000",
        serviceLog: logPath,
        run: name,
        note: "Readiness and complete dataset status come from the native service and application.",
      }),
    );
    while (!controller.signal.aborted && children.every((child) => !exited(child))) {
      lock.assertHeld();
      await sleep(250);
    }
    if (!controller.signal.aborted)
      throw Error("A native service/web process stopped; inspect retained logs");
  } finally {
    const errors: unknown[] = [];
    const attempt = async (action: () => unknown | Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const child of children.reverse()) await attempt(() => stopOwned(child));
    if (control) await attempt(() => control!.close());
    if (producer) await attempt(() => producer!.close());
    for (const handle of handles) await attempt(() => closeSync(handle));
    if (brokerStarted) await attempt(() => cleanupOwner.cli(["down", "--run", name]));
    if (lock) await attempt(() => lock!.close());
    runtime.signal?.removeEventListener("abort", interrupt);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (errors.length) throw new AggregateError(errors, "Owned dev cleanup failed");
  }
}
if (isMain(import.meta.url))
  main().catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
