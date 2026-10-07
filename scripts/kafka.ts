import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  ROOT,
  command,
  object,
  text,
  integer,
  readJson,
  isMain,
  message,
  type CommandOptions,
  type CommandResult,
} from "./common.ts";
export const DOCKER = ["docker", "--context", "orbstack"];
export type KafkaState = {
  owner: string;
  run: string;
  port: number;
  project: string;
  clusterId: string;
  bootstrapServers: string;
};
type Runner = (args: readonly string[], options?: CommandOptions) => Promise<CommandResult>;
export function validRun(value: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(value))
    throw Error("run must be 1–40 lowercase letters, digits or hyphens");
  return value;
}
export class Kafka {
  readonly directory: string;
  readonly runner: Runner;
  readonly composePath: string;
  constructor(directory = join(ROOT, ".local/kafka"), runner: Runner = command) {
    this.directory = directory;
    this.runner = runner;
    this.composePath = join(ROOT, "infra/kafka/compose.yaml");
  }
  statePath(name: string) {
    return join(this.directory, validRun(name) + ".json");
  }
  readState(name: string): KafkaState {
    const raw = object(readJson(this.statePath(name)));
    const owner = text(object(readJson(join(this.directory, "owner.json"))).owner);
    if (raw.owner !== owner || raw.run !== name)
      throw Error("Run ownership does not match this checkout");
    if (raw.project !== `rvs-${owner.slice(0, 12)}-${name}`)
      throw Error("Unexpected project name in run state");
    return {
      owner,
      run: name,
      project: text(raw.project),
      port: integer(raw.port),
      clusterId: text(raw.clusterId),
      bootstrapServers: text(raw.bootstrapServers),
    };
  }
  initialize(name: string, port: number) {
    validRun(name);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
      throw Error("port must be in 1024..65535");
    mkdirSync(this.directory, { recursive: true });
    const ownerPath = join(this.directory, "owner.json");
    try {
      writeFileSync(ownerPath, JSON.stringify({ owner: randomBytes(16).toString("hex") }), {
        flag: "wx",
      });
    } catch (error) {
      if (object(error).code !== "EEXIST") throw error;
    }
    const owner = text(object(readJson(ownerPath)).owner);
    if (!/^[a-f0-9]{32}$/.test(owner)) throw Error("Invalid checkout ownership token");
    const state: KafkaState = {
      owner,
      run: name,
      port,
      project: `rvs-${owner.slice(0, 12)}-${name}`,
      clusterId: randomBytes(16).toString("base64url"),
      bootstrapServers: `127.0.0.1:${port}`,
    };
    writeFileSync(this.statePath(name), JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
    return state;
  }
  environment(state: KafkaState): NodeJS.ProcessEnv {
    return {
      ...process.env,
      RVS_KAFKA_OWNER: state.owner,
      RVS_KAFKA_RUN: state.run,
      RVS_KAFKA_PORT: String(state.port),
      RVS_KAFKA_CLUSTER_ID: state.clusterId,
    };
  }
  compose(state: KafkaState, args: readonly string[], options: CommandOptions = {}) {
    return this.runner(
      [...DOCKER, "compose", "-p", state.project, "-f", this.composePath, ...args],
      { ...options, env: this.environment(state) },
    );
  }
  async assertOwned(state: KafkaState) {
    for (const [kind, query, labelPath, name] of [
      ["container", ["ps", "-aq"], "Config.Labels", `${state.project}-kafka-1`],
      ["volume", ["volume", "ls", "-q"], "Labels", `${state.project}_data`],
      ["network", ["network", "ls", "-q"], "Labels", `${state.project}_default`],
    ] as const) {
      const found = await this.runner([
        ...DOCKER,
        ...query,
        "--filter",
        `label=com.docker.compose.project=${state.project}`,
      ]);
      const identifiers = new Set(found.stdout.trim().split(/\s+/).filter(Boolean));
      const collision = await this.runner([...DOCKER, kind, "inspect", name], { check: false });
      if (collision.code === 0) identifiers.add(name);
      for (const id of identifiers) {
        const result = await this.runner([
          ...DOCKER,
          kind,
          "inspect",
          "--format",
          `{{json .${labelPath}}}`,
          id,
        ]);
        const labels = object(JSON.parse(result.stdout) || {});
        if (labels["io.rvs.owner"] !== state.owner || labels["io.rvs.run"] !== state.run)
          throw Error(`Refusing foreign ${kind}: ${id}`);
      }
    }
  }
  async containerCheck(state: KafkaState, recreate = false) {
    const tool = (name: string, args: string[], options?: CommandOptions) =>
      this.compose(
        state,
        [
          "exec",
          "-T",
          "kafka",
          `/opt/kafka/bin/${name}.sh`,
          "--bootstrap-server",
          "kafka:9092",
          ...args,
        ],
        options,
      );
    const topic = "infra_probe_" + randomBytes(16).toString("hex"),
      expected = "container-probe-" + randomBytes(16).toString("hex");
    await tool("kafka-broker-api-versions", []);
    await tool("kafka-topics", [
      "--create",
      "--topic",
      topic,
      "--partitions",
      "2",
      "--replication-factor",
      "1",
      "--config",
      "retention.ms=3600000",
    ]);
    try {
      await tool("kafka-console-producer", ["--topic", topic, "--producer-property", "acks=all"], {
        input: expected + "\n",
      });
      if (recreate) {
        await this.compose(state, ["down", "--timeout", "45"]);
        await this.compose(state, ["up", "-d", "--wait", "--wait-timeout", "150"]);
      }
      const result = await tool("kafka-console-consumer", [
        "--topic",
        topic,
        "--from-beginning",
        "--max-messages",
        "1",
        "--timeout-ms",
        "15000",
        "--isolation-level",
        "read_committed",
      ]);
      if (result.stdout.trim() !== expected)
        throw Error("Unexpected container-side consume result");
      return {
        containerMetadataProduceConsume: "passed",
        topic,
        value: expected,
        persistedAcrossRecreate: recreate,
      };
    } finally {
      await tool("kafka-topics", ["--delete", "--topic", topic]);
    }
  }
  async cli(args = process.argv.slice(2)) {
    const { values: v, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        run: { type: "string", default: "dev" },
        port: { type: "string", default: "19092" },
        "confirm-run": { type: "string" },
        topic: { type: "string" },
        partitions: { type: "string", default: "2" },
        "cleanup-policy": { type: "string", default: "delete" },
      },
    });
    const action = positionals[0],
      name = validRun(v.run),
      port = Number(v.port),
      partitions = Number(v.partitions),
      policy = v["cleanup-policy"];
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw Error("port must be in 1024..65535");
    if (action === "topic-create" || action === "topic-delete") {
      if (!v.topic || !/^[A-Za-z0-9_-]{1,249}$/.test(v.topic)) throw Error("Invalid topic");
      if (!Number.isInteger(partitions) || partitions < 2 || partitions > 32)
        throw Error("partitions must be in 2..32");
      if (policy !== "compact" && policy !== "delete") throw Error("Invalid cleanup policy");
    }
    if (action === "preflight") {
      await this.runner([...DOCKER, "info"], { stdio: "inherit" });
      await this.runner([...DOCKER, "compose", "version"], { stdio: "inherit" });
      return;
    }
    if (action === "init") return this.initialize(name, port);
    const state = this.readState(name);
    if (action === "env") return state;
    if (action === "reset" && v["confirm-run"] !== name)
      throw Error("reset requires --confirm-run matching --run");
    await this.assertOwned(state);
    switch (action) {
      case "up":
        await this.compose(state, ["up", "-d", "--wait", "--wait-timeout", "150"]);
        break;
      case "down":
        await this.compose(state, ["down", "--timeout", "45"]);
        break;
      case "restart":
        await this.compose(state, ["restart", "--timeout", "45", "kafka"]);
        await this.compose(state, ["up", "-d", "--wait", "--wait-timeout", "150"]);
        break;
      case "reset":
        await this.compose(state, ["down", "--volumes", "--timeout", "45"]);
        unlinkSync(this.statePath(name));
        break;
      case "topic-create":
      case "topic-delete":
        await this.compose(state, [
          "exec",
          "-T",
          "kafka",
          "/opt/kafka/bin/kafka-topics.sh",
          "--bootstrap-server",
          "kafka:9092",
          "--topic",
          v.topic!,
          ...(action === "topic-delete"
            ? ["--delete"]
            : [
                "--create",
                "--partitions",
                String(partitions),
                "--replication-factor",
                "1",
                "--config",
                `cleanup.policy=${policy}`,
                "--config",
                `retention.ms=${policy === "compact" ? "-1" : "604800000"}`,
              ]),
        ]);
        break;
      case "status":
        return this.compose(state, ["ps", "--all"]);
      case "describe":
        return this.compose(state, [
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
        ]);
      case "container-check":
      case "persistence-check":
        return this.containerCheck(state, action === "persistence-check");
      default:
        throw Error("Unknown Kafka lifecycle command");
    }
  }
}
export const kafka = new Kafka();
if (isMain(import.meta.url))
  kafka
    .cli()
    .then((value) => {
      if (value !== undefined) console.log(JSON.stringify(value));
    })
    .catch((error) => {
      console.error(`Kafka lifecycle failed: ${message(error)}`);
      process.exitCode = 1;
    });
