import { parseArgs } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync, mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import type { ChildProcess } from "node:child_process";
import {
  ROOT,
  command,
  spawnOwned,
  stopOwned,
  exited,
  JsonLines,
  JsonLineEOF,
  waitExit,
  object,
  list,
  text,
  integer,
  readJson,
  writeJson,
  sleep,
  isMain,
  message,
  settledStage,
} from "./common.ts";
import { Kafka, type KafkaState } from "./kafka.ts";
import { prepare, TOPICS } from "./demo_config.ts";
import { record, tombstone } from "./seed.ts";
import { Producer, serve, type Control, type Expected } from "./control.ts";
import { createTransportProxy } from "./transport-proxy.ts";
export async function fingerprint() {
  const paths = (
    await command(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  ).stdout.split("\0");
  const digest = createHash("sha256");
  for (const path of [...new Set(paths)].filter(Boolean).sort()) {
    const absolute = join(ROOT, path);
    try {
      if (statSync(absolute).isFile())
        digest
          .update(path + "\0")
          .update(readFileSync(absolute))
          .update("\0");
    } catch (error) {
      if (object(error).code !== "ENOENT") throw error;
    }
  }
  return digest.digest("hex");
}
export function nativeCaughtUp(
  value: unknown,
  expected: Expected,
  previousInstance?: string,
): boolean {
  try {
    const snapshot = object(value);
    if (
      previousInstance !== undefined &&
      (typeof snapshot.instance !== "string" ||
        !snapshot.instance ||
        snapshot.instance === previousInstance)
    )
      return false;
    if (snapshot.ready !== true || snapshot.authority_safe !== true) return false;
    const sources = new Map(
      list(snapshot.sources).map((value) => {
        const source = object(value);
        return [text(source.topic), source] as const;
      }),
    );
    for (const [topic, wanted] of Object.entries(expected)) {
      const source = sources.get(topic);
      if (!source) return false;
      const retention = object(source.retention);
      if (
        retention.active_payload_rows !== wanted.count ||
        retention.safe !== true ||
        retention.pending_due
      )
        return false;
      const partitions = new Map(
        list(source.partitions).map((value) => {
          const p = object(value);
          return [String(integer(p.partition)), p] as const;
        }),
      );
      if (partitions.size !== Object.keys(wanted.sourceNext).length) return false;
      for (const [partition, cut] of Object.entries(wanted.sourceNext)) {
        const actual = partitions.get(partition);
        if (!actual || actual.assigned !== true || actual.bootstrap_complete !== true) return false;
        for (const key of ["durable_next", "derived_next", "serving_next"]) {
          const value = actual[key];
          if (typeof value !== "string" || !/^\d+$/.test(value) || BigInt(value) < BigInt(cut))
            return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
export async function waitNativeCaughtUp(
  url: string,
  token: string,
  expected: Expected,
  service: ChildProcess,
  timeoutMs: number,
  logPath: string,
  previousInstance?: string,
  signal?: AbortSignal,
) {
  const started = performance.now(),
    deadline = started + timeoutMs,
    log = openSync(logPath, "w");
  try {
    while (true) {
      signal?.throwIfAborted();
      if (exited(service)) throw Error("Owned native service exited during catchup");
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
            : AbortSignal.timeout(2000),
        });
        if (!response.ok) throw Error(`Health HTTP${response.status}`);
        const snapshot: unknown = await response.json();
        writeSync(
          log,
          JSON.stringify({ seconds: (performance.now() - started) / 1000, health: snapshot }) +
            "\n",
        );
        if (nativeCaughtUp(snapshot, expected, previousInstance))
          return { seconds: (performance.now() - started) / 1000, health: snapshot };
      } catch (error) {
        writeSync(
          log,
          JSON.stringify({ seconds: (performance.now() - started) / 1000, error: message(error) }) +
            "\n",
        );
      }
      signal?.throwIfAborted();
      if (performance.now() >= deadline)
        throw Error(
          `Native sources did not reach all acknowledged cuts and exact row counts within ${timeoutMs / 1000} seconds`,
        );
      await sleep(500);
    }
  } finally {
    closeSync(log);
  }
}
export async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No ephemeral port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
export function validateBuildMode(smoke: number | undefined, noBuild: boolean) {
  if (noBuild && !smoke)
    throw Error("--no-build is only permitted for explicitly labelled development smoke runs");
}
export function checkCandidate(
  initial: string,
  current: string,
  smoke: number | undefined,
  phase: string,
) {
  const same = initial === current;
  if (!same && !smoke) throw Error(`Candidate source changed ${phase}; frozen acceptance invalid`);
  return same;
}
export type CleanupFailure = { resource: string; error: string };
export async function performCleanup(
  actions: Array<readonly [string, () => unknown | Promise<unknown>]>,
) {
  const failures: CleanupFailure[] = [];
  for (const [resource, action] of actions)
    try {
      await action();
    } catch (error) {
      failures.push({ resource, error: message(error) });
    }
  return failures;
}
export type CampaignResult = Record<string, unknown> & {
  status: "running" | "passed" | "failed";
  mode: "smoke" | "full-200000";
  candidateFrozen?: boolean;
  fullCampaignAcceptance?: boolean;
};
export function finalizeAcceptance(result: CampaignResult, failures: CleanupFailure[]) {
  result.cleanupErrors = failures;
  if (failures.length) result.status = "failed";
  result.fullCampaignAcceptance =
    result.status === "passed" &&
    result.mode === "full-200000" &&
    result.candidateFrozen === true &&
    failures.length === 0;
}
export async function main(args = process.argv.slice(2)) {
  const { values: v } = parseArgs({
    args,
    options: {
      smoke: { type: "string" },
      "no-build": { type: "boolean", default: false },
      deadline: { type: "string", default: "1800" },
    },
  });
  const smoke = v.smoke === undefined ? undefined : Number(v.smoke);
  if (smoke !== undefined && smoke !== 100) throw Error("Only explicit --smoke100 is allowed");
  validateBuildMode(smoke, v["no-build"]);
  const deadline = Number(v.deadline);
  if (!Number.isSafeInteger(deadline) || deadline < 1) throw Error("Invalid deadline");
  const rows = smoke ?? 200000,
    name = "e2e-" + randomBytes(8).toString("hex"),
    directory = join(ROOT, ".local/e2e", name);
  mkdirSync(directory, { recursive: true });
  const started = performance.now();
  const result: CampaignResult = {
    run: name,
    mode: smoke ? "smoke" : "full-200000",
    rowsPerTopic: rows,
    status: "running",
    charterAcceptance: false,
    artifacts: ".local/e2e/" + name,
  };
  const children: ChildProcess[] = [],
    handles: number[] = [];
  let producer: Producer | undefined,
    control: Control | undefined,
    state: KafkaState | undefined,
    browserReader: JsonLines | undefined,
    transportProxy: Awaited<ReturnType<typeof createTransportProxy>> | undefined;
  const transportInterruptions: Array<{ closedConnections: number; atMonotonic: number }> = [];
  result.transportInterruptions = transportInterruptions;
  const candidate = await fingerprint();
  result.candidateSourceSha256 = candidate;
  result.candidateFrozen = true;
  const cancellationStops: Promise<void>[] = [];
  const controller = new AbortController(),
    interrupt = () => {
      controller.abort();
      for (const child of children) {
        const stopping = stopOwned(child);
        void stopping.catch(() => {});
        cancellationStops.push(stopping);
      }
    };
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  const alarm = setTimeout(interrupt, deadline * 1000);
  const run = (args: string[], options: Parameters<typeof command>[1] = {}) =>
    settledStage(controller.signal, () =>
      command(args, {
        ...options,
        timeoutMs: Math.max(1, deadline * 1000 - (performance.now() - started)),
        signal: controller.signal,
      }),
    );
  const owner = new Kafka(undefined, (args, options) => run([...args], options));
  const broker = (action: string, ...extra: string[]) =>
    settledStage(controller.signal, () => owner.cli([action, "--run", name, ...extra]));
  const spawn = (args: string[], filename: string, env = process.env, cwd = ROOT) => {
    controller.signal.throwIfAborted();
    const fd = openSync(join(directory, filename), "w");
    handles.push(fd);
    const child = spawnOwned(args, { env, cwd, stdio: ["ignore", fd, fd] });
    children.push(child);
    return child;
  };
  let failure: unknown;
  try {
    const campaign = async () => {
      if (!v["no-build"])
        await run(
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
          { stdio: "inherit" },
        );
      result.candidateFrozen =
        result.candidateFrozen &&
        checkCandidate(candidate, await fingerprint(), smoke, "during native build");
      const ports = [];
      for (let i = 0; i < 5; i++) ports.push(await freePort());
      if (new Set(ports).size !== 5) throw Error("Port allocation collided; rerun");
      await broker("preflight");
      await broker("init", "--port", String(ports[0]));
      state = owner.readState(name);
      await broker("up");
      for (const topic of TOPICS)
        for (const source of [topic, topic + "-state"])
          await broker("topic-create", "--topic", source, "--cleanup-policy", "compact");
      const effective = openSync(join(directory, "effective-kafka-config.log"), "w");
      try {
        writeSync(
          effective,
          (
            await owner.compose(state, [
              "exec",
              "-T",
              "kafka",
              "/opt/kafka/bin/kafka-configs.sh",
              "--bootstrap-server",
              "kafka:9092",
              "--entity-type",
              "brokers",
              "--entity-name",
              "1",
              "--describe",
              "--all",
            ])
          ).stdout,
        );
        for (const topic of TOPICS) {
          const description = (
            await owner.compose(state, [
              "exec",
              "-T",
              "kafka",
              "/opt/kafka/bin/kafka-topics.sh",
              "--bootstrap-server",
              "kafka:9092",
              "--topic",
              topic,
              "--describe",
            ])
          ).stdout;
          writeSync(effective, description);
          if (!/PartitionCount:\s*2\b/.test(description))
            throw Error("Effective source topic partition count is not two");
          writeSync(
            effective,
            (
              await owner.compose(state, [
                "exec",
                "-T",
                "kafka",
                "/opt/kafka/bin/kafka-configs.sh",
                "--bootstrap-server",
                "kafka:9092",
                "--entity-type",
                "topics",
                "--entity-name",
                topic,
                "--describe",
                "--all",
              ])
            ).stdout,
          );
        }
      } finally {
        closeSync(effective);
      }
      const prepared = prepare(name, {
          owner,
          servicePort: ports[1],
          healthPort: ports[2],
          webPort: ports[3],
        }),
        serviceEnv = { ...process.env, V12_SESSION_TOKEN: prepared.token };
      let service = spawn(
        [join(ROOT, "target/release/view_server"), prepared.path],
        "native-0.log",
        serviceEnv,
      );
      result.nativeStartedMonotonic = performance.now() / 1000;
      const standalone = await command(
        [join(ROOT, "target/release/examples/seed_producer"), prepared.path],
        { input: "", check: false, timeoutMs: 10000 },
      );
      if (standalone.code === 0 || !standalone.stderr.includes("running control authority"))
        throw Error("A native demo writer bypassed required journal authority");
      result.standaloneWriterRejected = true;
      producer = await Producer.open(prepared.path, directory, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const concurrent = await command(
        [join(ROOT, "target/release/examples/seed_producer"), prepared.path],
        { input: "", check: false, timeoutMs: 10000 },
      );
      if (concurrent.code === 0 || !concurrent.stderr.includes("live native writer"))
        throw Error("A concurrent native demo writer bypassed config lock");
      result.concurrentWriterRejected = true;
      control = await serve(producer, {
        port: ports[4],
        origin: `http://127.0.0.1:${ports[3]}`,
        token: prepared.token,
        run: name,
      });
      controller.signal.throwIfAborted();
      for (const topic of TOPICS) {
        for (let first = 0; first < rows; first += 1000)
          await producer.publish(
            Array.from({ length: Math.min(1000, rows - first) }, (_, i) =>
              record(topic, first + i),
            ),
          );
        if (producer.rows[topic].size !== rows)
          throw Error("Seed did not acknowledge requested distinct identities");
        console.log(JSON.stringify({ seededDistinct: { [topic]: producer.rows[topic].size } }));
      }
      result.seedCompletedMonotonic = performance.now() / 1000;
      const initial = producer.expected();
      result.initialReceipts = initial;
      const catchup = await waitNativeCaughtUp(
        `http://127.0.0.1:${ports[2]}/health`,
        prepared.token,
        initial,
        service,
        120000,
        join(directory, "initial-native-catchup.ndjson"),
        undefined,
        controller.signal,
      );
      result.nativeInitialCatchupSeconds = catchup.seconds;
      result.nativeInitialCatchupHealth = catchup.health;
      transportProxy = await createTransportProxy(ports[1]);
      controller.signal.throwIfAborted();
      result.transportProxy = { listenPort: transportProxy.port, nativePort: ports[1] };
      const webEnv = {
        ...process.env,
        VITE_RVS_URL: `ws://127.0.0.1:${transportProxy.port}/v15`,
        VITE_RVS_TOKEN: prepared.token,
        VITE_RVS_CONTROL_URL: `http://127.0.0.1:${ports[4]}`,
        VITE_RVS_CONTROL_TOKEN: prepared.token,
        VITE_RVS_RUN: name,
        VITE_RVS_CATALOG: JSON.stringify(prepared.config.catalog),
        VITE_RVS_E2E: "1",
      };
      result.candidateFrozen =
        result.candidateFrozen &&
        checkCandidate(candidate, await fingerprint(), smoke, "before web build");
      const buildLog = openSync(join(directory, "web-build.log"), "w");
      try {
        await run(["vp", "build"], {
          cwd: join(ROOT, "apps/web"),
          env: webEnv,
          stdio: ["ignore", buildLog, buildLog],
        });
      } finally {
        closeSync(buildLog);
      }
      result.candidateFrozen =
        result.candidateFrozen &&
        checkCandidate(candidate, await fingerprint(), smoke, "during web build");
      spawn(
        ["vp", "preview", "--host", "127.0.0.1", "--port", String(ports[3]), "--strictPort"],
        "web.log",
        webEnv,
        join(ROOT, "apps/web"),
      );
      controller.signal.throwIfAborted();
      const browserError = openSync(join(directory, "browser.stderr.log"), "w");
      handles.push(browserError);
      const browser = spawnOwned(
        [process.execPath, join(ROOT, "tests/integration/e2e-browser.ts")],
        {
          env: {
            ...process.env,
            E2E_URL: `http://127.0.0.1:${ports[3]}`,
            E2E_ROWS: String(rows),
            E2E_DIRECTORY: directory,
            E2E_SMOKE: String(Boolean(smoke)),
          },
          stdio: ["pipe", "pipe", browserError],
        },
      );
      children.push(browser);
      browser.stdin?.on("error", () => {});
      browserReader = new JsonLines(browser, "Browser RPC");
      let serial = 0;
      while (!exited(browser)) {
        controller.signal.throwIfAborted();
        let request: Record<string, unknown>;
        try {
          request = object(await browserReader.read(1000));
        } catch (error) {
          if (error instanceof JsonLineEOF) {
            await waitExit(browser, 15000);
            break;
          }
          if (exited(browser)) break;
          if (message(error).includes("receipt deadline")) {
            if (exited(service)) throw Error("Owned native service exited unexpectedly");
            continue;
          }
          throw error;
        }
        serial++;
        const action = request.action;
        let response: unknown;
        if (action === "expected") response = producer.expected();
        else if (action === "update" || action === "delete" || action === "bootstrap-update") {
          const topics = action === "bootstrap-update" ? (["client_orders"] as const) : TOPICS;
          const records = topics.map((topic) =>
            record(topic, integer(request.index ?? 0), integer(request.revision ?? 1000000)),
          );
          response = {
            receipts: await producer.publish(
              action === "delete" ? records.map(tombstone) : records,
            ),
            expected: producer.expected(),
          };
        } else if (action === "interrupt-transport") {
          if (!transportProxy) throw Error("Owned transport proxy is unavailable");
          const closedConnections = transportProxy.interrupt();
          if (closedConnections < 1)
            throw Error("Transport interruption did not close a live connection");
          transportInterruptions.push({ closedConnections, atMonotonic: performance.now() / 1000 });
          response = { closedConnections };
        } else if (action === "restart") {
          await stopOwned(service);
          service = spawn(
            [join(ROOT, "target/release/view_server"), prepared.path],
            `native-${serial}.log`,
            serviceEnv,
          );
          response = { pid: service.pid };
        } else if (action === "native-ready") {
          const previous = text(request.previousInstance);
          if (!previous) throw Error("Previous native instance required");
          response = await waitNativeCaughtUp(
            `http://127.0.0.1:${ports[2]}/health`,
            prepared.token,
            producer.expected(),
            service,
            240000,
            join(directory, "restart-native-catchup.ndjson"),
            previous,
            controller.signal,
          );
          const recovery = object(response);
          result.nativeRestartCatchupSeconds = recovery.seconds;
          result.nativeRestartCatchupHealth = recovery.health;
        } else if (action === "native-memory") {
          const memory = await command(["ps", "-o", "rss=", "-p", String(service.pid)]);
          response = { pid: service.pid, rssKiB: Number(memory.stdout.trim()) };
        } else throw Error(`Unknown browser action: ${String(action)}`);
        if (!browser.stdin?.writable) throw Error("Browser RPC input closed");
        browser.stdin.write(JSON.stringify({ id: request.id, result: response }) + "\n");
      }
      if (browser.exitCode !== 0)
        throw Error(
          "Browser assertions failed; inspect browser.stderr.log and browser-samples.ndjson",
        );
      result.browser = readJson(join(directory, "browser-result.json"));
      result.candidateFrozen =
        result.candidateFrozen &&
        checkCandidate(candidate, await fingerprint(), smoke, "during browser campaign");
      result.finalReceipts = producer.expected();
      result.status = "passed";
    };
    await settledStage(controller.signal, campaign);
  } catch (error) {
    failure = error;
    result.status = "failed";
    result.error = message(error);
  } finally {
    clearTimeout(alarm);
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
    const cleanup: Array<{
      pid: number | undefined;
      exitCode: number | null;
      signalCode?: NodeJS.Signals | null;
      role?: string;
    }> = [];
    const actions: Array<readonly [string, () => unknown | Promise<unknown>]> = children
      .slice()
      .reverse()
      .map((child) => [
        `child-${child.pid}`,
        async () => {
          await stopOwned(child);
          cleanup.push({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode });
          if (!exited(child)) throw Error("Owned child still alive after shutdown");
        },
      ]);
    if (transportProxy) actions.push(["transport-proxy", () => transportProxy!.close()]);
    if (control) actions.push(["control-server", () => control!.close()]);
    if (producer)
      actions.push([
        "persistent-producer",
        async () => {
          await producer!.close();
          const child = producer!.process;
          cleanup.push({
            pid: child?.pid,
            exitCode: child?.exitCode ?? null,
            signalCode: child?.signalCode,
            role: "persistent-producer",
          });
          if (child && !exited(child)) throw Error("Persistent producer remains alive");
        },
      ]);
    if (browserReader) actions.push(["browser-reader", () => browserReader!.close()]);
    handles.forEach((fd, index) => actions.push([`log-handle-${index}`, () => closeSync(fd)]));
    if (state)
      actions.push([
        "owned-broker",
        () =>
          command([process.execPath, join(ROOT, "scripts/kafka.ts"), "down", "--run", name], {
            timeoutMs: 120000,
          }),
      ]);
    cancellationStops.forEach((stopping, index) =>
      actions.push([`interruption-stop-${index}`, () => stopping]),
    );
    const errors = await performCleanup(actions);
    result.ownedChildren = cleanup;
    finalizeAcceptance(result, errors);
    result.seconds = (performance.now() - started) / 1000;
    writeJson(join(directory, "result.json"), result);
    console.log(JSON.stringify(result));
  }
  if (failure) throw failure;
  return result.status === "passed" ? 0 : 1;
}
if (isMain(import.meta.url))
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(message(error));
      process.exitCode = 1;
    });
